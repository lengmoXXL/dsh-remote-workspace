/**
 * The routing subprocess runtime the plugin registers as `ctx.subprocess`.
 *
 * A plain object, like the filesystem router: `ctx.provide` is the primitive
 * Cordis' own `Service` constructor calls, so nothing is inherited here.
 *
 * Two facts drive this module.
 *
 * First, `spawn` returns its handle **synchronously** while a remote start
 * needs a round trip. The handle is therefore a local proxy: it exists
 * immediately, queues `terminate` and `waitForExit` until the daemon has
 * answered, and lets `done` reject when the start itself failed.
 *
 * Second, a collected reader is read **synchronously** while the daemon is
 * reached asynchronously. The proxy keeps a local mirror of each stream and
 * fills it at exit, which is when every documented consumer — the bash
 * executor, the spill policy — actually reads. Collected output that this
 * design cannot fetch without an async reader is fetched once, completely,
 * before `done` settles.
 *
 * @module dsh-remote-workspace/plugin/routing/subprocess
 */

import { basename } from 'node:path'
import { Duplex, PassThrough } from 'node:stream'
import type { Writable } from 'node:stream'
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessRuntime,
  SubprocessSpawnSpec,
  SubprocessTerminalActivity,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { asTermId } from '../../remote/protocol.ts'
import type { ProcId, SpPipeFrame } from '../../remote/protocol.ts'
import type { ChannelLookup, NodeChannel } from '../../remote/client.ts'
import type { AnchorRoute } from '../../storage/anchors.ts'
import type { NodeId } from '../../storage/nodes.ts'
import { terminalWire } from './tty.ts'
import { remoteTarget } from './remote.ts'
import type { TtySpawnRequest } from '../../tty.ts'
import { createRemoteTty } from '../../remote/tty.ts'

/**
 * The members this provider implements, narrowed from the seam class so the
 * object literal is checkable without inheriting `Service`.
 */
export type SubprocessRuntimeContract = Pick<
  SubprocessRuntime,
  'resolveExecutable' | 'terminalEnvironment' | 'spawn' | 'spawnTerminal'
>

/**
 * A remote terminal, plus the resize the seam has no verb for.
 *
 * `SubprocessTerminalHandle` stops at allocation, text, foreground groups, and
 * teardown, so a consumer that wants to keep a PTY in step with its window has
 * nowhere to ask. This provider publishes the capability beside the seam — the
 * object is still a `SubprocessTerminalHandle`, and a consumer probes for
 * `resize` — which is what `dsh-terminal` does.
 */
export interface RemoteTerminalHandle extends SubprocessTerminalHandle {
  /**
   * Ask the daemon to adopt a new terminal size. The kernel signals the
   * foreground process group itself when the size actually changes.
   * @param cols - column count.
   * @param rows - row count.
   */
  resize(cols: number, rows: number): Promise<void>
}

/** What the routing subprocess runtime needs from its owner. */
export interface RoutingSubprocessDeps {
  /** The composed factory implementation serving every local cwd. */
  readonly localProc: SubprocessRuntime
  /** Every anchor this plugin currently owns. */
  readonly anchors: () => readonly AnchorRoute[]
  /** Resolves the live channel for a node. */
  readonly channel: ChannelLookup
  /**
   * Absolute path of the node's own PTC program host, which the connection
   * installs there.
   *
   * The harness's PTC provider launches an interpreter in the execution world
   * and hands it a boot payload; on the host that interpreter is Node. A node
   * that has no Node runs this plugin's embedded-V8 build instead, which is why
   * the router has to ask where that build landed before it can rewrite a
   * spawn.
   */
  readonly ptcHost: (nodeId: NodeId) => Promise<string>
  /**
   * Remote binary a packaged ripgrep is rewritten to. The search tools resolve
   * a host-side `rg` and hand that absolute path to this seam, which does not
   * exist on the node.
   */
  readonly remoteRipgrep?: string
}

/** One stream's local mirror of the daemon's retained window. */
class CollectedMirror implements SubprocessOutputReader {
  private readonly chunks: Buffer[] = []
  /** Whole-stream offset of the first retained byte. */
  private start = 0
  /** Whole-stream offset one past the last retained byte. */
  private end = 0
  /** True when an earlier read reported that bytes had already been dropped. */
  private dropped = false
  private readonly maxBytes: number

  /**
   * @param maxBytes - the in-memory cap the caller asked the daemon for.
   */
  constructor(maxBytes: number) {
    this.maxBytes = maxBytes
  }

  /**
   * Replace the mirror with the window's tail.
   *
   * An answer to an offset that has slid out of the daemon's window carries the
   * retained tail rather than the bytes from that offset, so appending it would
   * splice two ranges into one stream. The tail becomes the whole content, and
   * the loss is reported.
   * @param bytes - the tail the daemon retained.
   * @param nextOffset - whole-stream offset one past `bytes`.
   */
  reset(bytes: Buffer, nextOffset: number): void {
    this.chunks.length = 0
    if (bytes.length > 0) this.chunks.push(bytes)
    this.start = nextOffset - bytes.length
    this.end = nextOffset
    this.dropped = true
  }

  /** Append one fetched window and trim the head to the cap. */
  push(bytes: Buffer): void {
    if (bytes.length === 0) return
    this.chunks.push(bytes)
    this.end += bytes.length
    let retained = this.end - this.start
    while (retained > this.maxBytes && this.chunks.length > 0) {
      const head = this.chunks[0]!
      const overflow = retained - this.maxBytes
      if (head.length <= overflow) {
        this.chunks.shift()
        this.start += head.length
      } else {
        this.chunks[0] = head.subarray(overflow)
        this.start += overflow
      }
      this.dropped = true
      retained = this.end - this.start
    }
  }

  /** The whole-stream offset a caller should resume from. */
  get nextOffset(): number {
    return this.end
  }

  /**
   * Read everything captured since `fromByte`.
   * @param fromByte - whole-stream byte offset to resume from.
   * @returns the delta text, the next offset, and whether the offset was lost.
   */
  readFrom(fromByte: number): SubprocessOutputRead {
    if (fromByte < this.start) {
      return {
        text: Buffer.concat(this.chunks).toString('utf8'),
        nextOffset: this.end,
        lossy: true,
      }
    }
    if (fromByte >= this.end) {
      return { text: '', nextOffset: this.end, lossy: this.dropped }
    }
    const slice = Buffer.concat(this.chunks).subarray(fromByte - this.start)
    return { text: slice.toString('utf8'), nextOffset: this.end, lossy: this.dropped }
  }
}

/**
 * Absorb a teardown request whose failure cannot matter.
 *
 * Every call runs after the decision to release a process, against a transport
 * that may already be gone; the daemon reaps the process either way, so a
 * rejection carries nothing the caller could act on.
 * @param request - the teardown request already issued.
 * @returns a promise that settles when the request does, whatever its outcome.
 */
function settled(request: Promise<unknown>): Promise<void> {
  return request.then(() => {}, () => {})
}

/**
 * Build the proxy handle for one remote spawn.
 * @param deps - the routers' owners, for the node's own PTC program host.
 * @param channel - the live node channel.
 * @param nodeId - the machine serving this spawn.
 * @param remoteCwd - the canonical remote working directory.
 * @param spec - the caller's fully specified spawn request.
 * @returns the handle, valid before the daemon has answered.
 */
function createRemoteHandle(
  deps: RoutingSubprocessDeps,
  channel: NodeChannel,
  nodeId: NodeId,
  remoteCwd: string,
  spec: SubprocessSpawnSpec,
): SubprocessHandle {
  const stdoutMirror = typeof spec.stdio.stdout === 'object'
    ? new CollectedMirror(spec.stdio.stdout.maxBytes)
    : undefined
  const stderrMirror = typeof spec.stdio.stderr === 'object'
    ? new CollectedMirror(spec.stdio.stderr.maxBytes)
    : undefined

  // A piped stream is pushed, not retained, so its `Readable` is fed straight
  // from the daemon's frames. Registration happens before `sp.spawn` so no
  // chunk can arrive before there is a handler to receive it, and frames that
  // race the spawn answer are held until the id they belong to is known.
  const stdoutPipe = spec.stdio.stdout === 'pipe' ? new PassThrough() : undefined
  const stderrPipe = spec.stdio.stderr === 'pipe' ? new PassThrough() : undefined
  const bufferedFrames: SpPipeFrame[] = []
  const pendingControl: string[] = []
  let procId: ProcId | undefined
  let offPipe: (() => void) | undefined

  // The control channel is one bidirectional byte stream: frames the daemon
  // pushes feed its readable side, and writes become `sp.writeControl` calls.
  // It exists before `sp.spawn` so a caller that writes immediately has a
  // stream to write to; bytes that race the process id are held until it lands.
  const control = spec.stdio.control === 'pipe'
    ? new Duplex({
        read() {},
        write(chunk: Buffer, _encoding, callback) {
          const data = Buffer.from(chunk).toString('base64')
          const id = procId
          if (id === undefined) {
            pendingControl.push(data)
            callback()
            return
          }
          channel.request('sp.writeControl', { procId: id, data }).then(
            () => { callback() },
            (error: unknown) => { callback(error instanceof Error ? error : new Error(String(error))) },
          )
        },
      })
    : undefined

  const deliverPipeFrame = (frame: SpPipeFrame): void => {
    if (frame.procId !== procId) return
    const bytes = Buffer.from(frame.data, 'base64')
    if (frame.stream === 'control') {
      control?.push(bytes)
      return
    }
    const target = frame.stream === 'stdout' ? stdoutPipe : stderrPipe
    target?.write(bytes)
  }

  if (stdoutPipe !== undefined || stderrPipe !== undefined || control !== undefined) {
    offPipe = channel.onPipeFrame((frame) => {
      if (procId === undefined) {
        bufferedFrames.push(frame)
        return
      }
      deliverPipeFrame(frame)
    })
  }

  /** Stop pushing and end every piped stream, exactly once. */
  const closePipes = (): void => {
    offPipe?.()
    offPipe = undefined
    stdoutPipe?.end()
    stderrPipe?.end()
    control?.push(null)
  }

  let startFailure: unknown
  let terminated = false

  let resolveDone: (outcome: SubprocessOutcome) => void = () => {}
  let rejectDone: (error: unknown) => void = () => {}
  const done = new Promise<SubprocessOutcome>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })

  const stdinStream: Writable | undefined = spec.stdio.stdin === 'pipe'
    ? new PassThrough()
    : undefined

  /** Fetch every remaining byte of one stream until the daemon stops advancing. */
  const drain = async (id: ProcId, stream: 'stdout' | 'stderr', mirror: CollectedMirror): Promise<void> => {
    for (;;) {
      const read = await channel.request('sp.readOutput', {
        procId: id,
        stream,
        fromByte: mirror.nextOffset,
      })
      const bytes = Buffer.from(read.data, 'base64')
      if (read.lossy) {
        mirror.reset(bytes, read.nextOffset)
      } else {
        if (bytes.length === 0) return
        mirror.push(bytes)
      }
      if (read.nextOffset <= mirror.nextOffset) return
    }
  }

  const run = async (): Promise<void> => {
    let id: ProcId
    try {
      const started = await channel.request('sp.spawn', {
        argv: await translateRemoteArgv(deps, nodeId, channel, spec.argv),
        cwd: remoteCwd,
        stdin: spec.stdio.stdin === 'pipe'
          ? 'pipe'
          : spec.stdio.stdin === 'ignore'
            ? 'ignore'
            : { data: spec.stdio.stdin.data },
        stdout: collectSpec(spec.stdio.stdout),
        stderr: collectSpec(spec.stdio.stderr),
        ...spec.stdio.control === 'pipe' ? { control: 'pipe' as const } : {},
        graceMs: spec.graceMs,
        ...spec.env === undefined ? {} : { env: definedEnv(spec.env) },
      })
      id = started.procId
      procId = id
      // Flush whatever arrived while the id was in flight; order is preserved
      // because the daemon pushes in order on one connection.
      for (const frame of bufferedFrames.splice(0)) deliverPipeFrame(frame)
      for (const data of pendingControl.splice(0)) {
        void settled(channel.request('sp.writeControl', { procId: id, data }))
      }
    } catch (error) {
      startFailure = error
      closePipes()
      rejectDone(error)
      return
    }

    if (terminated) await settled(channel.request('sp.terminate', { procId: id }))
    if (typeof spec.stdio.stdin === 'object') {
      await settled(channel.request('sp.writeStdin', { procId: id, data: spec.stdio.stdin.data }))
      await settled(channel.request('sp.closeStdin', { procId: id }))
    }
    if (stdinStream !== undefined) {
      stdinStream.on('data', (chunk: Buffer) => {
        void settled(channel.request('sp.writeStdin', { procId: id, data: chunk.toString('utf8') }))
      })
      stdinStream.on('end', () => {
        void settled(channel.request('sp.closeStdin', { procId: id }))
      })
    }

    try {
      await channel.request('sp.waitForExit', { procId: id })
      if (stdoutMirror !== undefined) await drain(id, 'stdout', stdoutMirror)
      if (stderrMirror !== undefined) await drain(id, 'stderr', stderrMirror)
      const outcome = await channel.request('sp.outcome', { procId: id })
      closePipes()
      resolveDone({
        exitCode: outcome?.exitCode ?? null,
        signal: (outcome?.signal ?? null) as NodeJS.Signals | null,
      })
    } catch (error) {
      closePipes()
      rejectDone(error)
    }
  }

  void run()

  const collected: SubprocessCollectedOutputs = {
    ...stdoutMirror === undefined ? {} : { stdout: stdoutMirror },
    ...stderrMirror === undefined ? {} : { stderr: stderrMirror },
  }

  return {
    stdin: stdinStream,
    stdout: stdoutPipe,
    stderr: stderrPipe,
    control,
    collected,
    done,
    terminate() {
      terminated = true
      if (procId === undefined) return
      void settled(channel.request('sp.terminate', { procId }))
    },
    async waitForExit(signal?: AbortSignal): Promise<boolean> {
      if (startFailure !== undefined) return false
      // The daemon's own wait is the observable fact; the local `done` settles
      // only after the final drain, which is strictly later.
      await done
      return signal?.aborted !== true
    },
  }
}

/** Project a seam output disposition onto the wire form. */
function collectSpec(mode: SubprocessSpawnSpec['stdio']['stdout']): 'inherit' | 'pipe' | { maxBytes: number } {
  if (mode === 'pipe') return 'pipe'
  return typeof mode === 'object' ? { maxBytes: mode.maxBytes } : 'inherit'
}

/** Drop undefined entries from a spawn environment. */
function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/** Directories whose executables every POSIX node already has. */
const SYSTEM_EXECUTABLE_PREFIXES = ['/bin/', '/sbin/', '/usr/bin/', '/usr/sbin/', '/usr/local/bin/', '/usr/local/sbin/']

/**
 * Host sandbox runners. The sandbox seam confines by prefixing one of these and
 * a `--` separator, and each exists only on the host that chose it.
 */
const HOST_SANDBOX_RUNNERS = ['sandbox-exec', 'bwrap', 'landlock-run']

/**
 * Drop a host sandbox wrapper from one remote spawn's argv.
 *
 * `confine` wraps a command as `[runner, …profile, '--', …command]`. That
 * runner is a same-world tool: a remote node has neither it nor any reason to
 * run it, because there the machine is the boundary. Sending it unwrapped runs
 * the command the wrapper was protecting instead of the wrapper itself.
 * @param argv - the caller's argv, possibly wrapped by this host's sandbox.
 * @returns the command argv with any recognized host-sandbox prefix removed.
 */
function stripHostSandbox(argv: readonly string[]): readonly string[] {
  const head = argv[0]
  if (head === undefined || !HOST_SANDBOX_RUNNERS.includes(basename(head))) return argv
  const separator = argv.indexOf('--')
  return separator >= 0 && separator + 1 < argv.length ? argv.slice(separator + 1) : argv
}

/**
 * The PTC provider's bootstrap: the file it spawns, and the package directory
 * its path runs through.
 *
 * The provider hands the seam the interpreter, an optional heap ceiling, its
 * own bootstrap script, and the frame limit in that order, so an argv of this
 * shape is a PTC program and nothing else is.
 */
const PTC_BOOTSTRAP = 'process.js'
const PTC_PACKAGE_SEGMENT = '/dsh-ptc-runtime-node/'

/**
 * The index of the PTC bootstrap in one argv, when that is what this is.
 * @param argv - the caller's argv, already unwrapped from any host sandbox.
 * @returns the bootstrap's index, or undefined for every other spawn.
 */
function ptcBootstrapIndex(argv: readonly string[]): number | undefined {
  if (argv.length < 3) return undefined
  const limit = argv[argv.length - 1]
  const bootstrap = argv[argv.length - 2]
  if (limit === undefined || bootstrap === undefined) return undefined
  if (!/^[1-9][0-9]*$/.test(limit)) return undefined
  if (!bootstrap.includes(PTC_PACKAGE_SEGMENT)) return undefined
  if (bootstrap.slice(bootstrap.lastIndexOf('/') + 1) !== PTC_BOOTSTRAP) return undefined
  return argv.length - 2
}

/**
 * Rewrite one remote child's argv so every path names something the node has.
 *
 * A PTC program is the spawn that needs more than a rename. Its provider
 * launches an interpreter in the execution world and expects the harness
 * protocol on the control channel, so the node runs its own embedded-V8 host
 * in place of the host's Node interpreter and the harness's bootstrap script.
 * Every other spawn keeps its command and only has a host-resolved executable
 * swapped for the node's own resolution, because a binary built for this
 * machine would not run on that one anyway.
 * @param deps - the seam's owner, for the node's PTC program host.
 * @param nodeId - the machine serving this spawn.
 * @param channel - the live node channel.
 * @param argv - the caller's argv, wrapped by this host's sandbox when the
 *   session is confined.
 * @returns the argv to send.
 */
async function translateRemoteArgv(
  deps: RoutingSubprocessDeps,
  nodeId: NodeId,
  channel: NodeChannel,
  argv: readonly string[],
): Promise<string[]> {
  const translated = [...stripHostSandbox(argv)]
  const bootstrap = ptcBootstrapIndex(translated)
  if (bootstrap !== undefined) {
    // The interpreter and the harness bootstrap after it are host files; what
    // survives is the heap ceiling the provider configured on the interpreter
    // and the frame limit the worker reads off its own argv.
    return [await deps.ptcHost(nodeId), ...translated.slice(1, bootstrap), translated[bootstrap + 1]!]
  }
  const head = translated[0]
  if (
    head !== undefined
    && head.startsWith('/')
    && !SYSTEM_EXECUTABLE_PREFIXES.some(prefix => head.startsWith(prefix))
    && await missingOnNode(channel, head)
  ) {
    translated[0] = basename(head)
  }
  return translated
}

/** Whether the node has no readable entry at one absolute path. */
async function missingOnNode(channel: NodeChannel, path: string): Promise<boolean> {
  try {
    return await channel.request('fs.stat', { path }) === null
  } catch {
    // A path the daemon refuses to describe is not one to rewrite blindly.
    return false
  }
}

/**
 * Rewrite a host-only executable path into something the node can run.
 *
 * The search tools resolve a packaged `rg` on the host and hand this seam that
 * absolute path; the node has its own binary under a bare name. Any other
 * absolute path is passed through, and the daemon reports it missing.
 * @param argv - the caller's argv.
 * @param remoteRipgrep - the configured remote binary name.
 * @returns the argv to send.
 */
function rewriteExecutable(argv: readonly string[], remoteRipgrep: string): readonly string[] {
  const head = argv[0]
  if (head === undefined || !head.startsWith('/')) return argv
  const base = head.slice(head.lastIndexOf('/') + 1)
  if (base !== 'rg') return argv
  return [remoteRipgrep, ...argv.slice(1)]
}

/**
 * Build the routing subprocess runtime.
 * @param deps - the composed local delegate, the live anchors, and channel lookup.
 * @returns an object satisfying the subprocess seam, ready for `ctx.provide`.
 */
export function createRoutingSubprocessRuntime(
  deps: RoutingSubprocessDeps,
): SubprocessRuntimeContract {
  const remoteRipgrep = deps.remoteRipgrep ?? 'rg'

  return {
    // Executable lookup carries no working directory, so it cannot be routed:
    // a remote spawn resolves its own executable on the node instead.
    resolveExecutable(command, env, signal) {
      return deps.localProc.resolveExecutable(command, env, signal)
    },

    // Shell-selection facts carry no working directory either, so this answers
    // for this host. A Session whose node disagrees about the login shell — a
    // Mac host against a Linux node — must name that shell in the terminal
    // controller's own `shell` profile, whose path is captured at spawn and
    // resolved on the node.
    terminalEnvironment(signal) {
      return deps.localProc.terminalEnvironment(signal)
    },

    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      const remote = remoteTarget(spec.cwd, deps.anchors(), deps.channel)
      if (remote === undefined) return deps.localProc.spawn(spec)
      return createRemoteHandle(
        deps,
        remote.channel,
        remote.nodeId,
        remote.remotePath,
        { ...spec, argv: rewriteExecutable(spec.argv, remoteRipgrep) },
      )
    },

    async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
      const remote = remoteTarget(spec.cwd, deps.anchors(), deps.channel)
      if (remote === undefined) return deps.localProc.spawnTerminal(spec)
      const request: TtySpawnRequest = {
        // A terminal always has a program to run; the subprocess request is the
        // same non-empty argv without the type that says so.
        argv: [...spec.argv] as [string, ...string[]],
        cwd: remote.remotePath,
        cols: spec.cols,
        rows: spec.rows,
        graceMs: spec.graceMs,
        ...spec.env === undefined ? {} : { env: spec.env },
      }
      // Activity survives between observations, so the revision advances only
      // when a fresh look contradicts the last one.
      let observed: SubprocessTerminalActivity = { state: 'unknown', revision: 0 }
      return await createRemoteTty(terminalWire(remote.channel), request, termId => ({
        async inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
          return await remote.channel.request('term.inspectForeground', { termId: asTermId(termId) }) ?? undefined
        },
        async inspectActivity(): Promise<SubprocessTerminalActivity> {
          const foreground = await remote.channel.request('term.inspectForeground', { termId: asTermId(termId) }) ?? undefined
          // A foreground group sleeping on the terminal is the prompt evidence
          // this machine can see; no group at all is not an idle terminal.
          const state = foreground === undefined ? 'unknown' : foreground.inputWaiting ? 'idle' : 'busy'
          if (state !== observed.state) observed = { state, revision: observed.revision + 1 }
          return observed
        },
        async signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
          const result = await remote.channel.request('term.signalForeground', {
            termId: asTermId(termId),
            signal,
          })
          return result.processGroupId
        },
      }))
    },
  }
}
