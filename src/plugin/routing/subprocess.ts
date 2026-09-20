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

import { PassThrough } from 'node:stream'
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
  'resolveExecutable' | 'spawn' | 'spawnTerminal'
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
 * @param channel - the live node channel.
 * @param remoteCwd - the canonical remote working directory.
 * @param spec - the caller's fully specified spawn request.
 * @returns the handle, valid before the daemon has answered.
 */
function createRemoteHandle(
  channel: NodeChannel,
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
  let procId: ProcId | undefined
  let offPipe: (() => void) | undefined

  const deliverPipeFrame = (frame: SpPipeFrame): void => {
    if (frame.procId !== procId) return
    const target = frame.stream === 'stdout' ? stdoutPipe : stderrPipe
    target?.write(Buffer.from(frame.data, 'base64'))
  }

  if (stdoutPipe !== undefined || stderrPipe !== undefined) {
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
        argv: [...spec.argv],
        cwd: remoteCwd,
        stdin: spec.stdio.stdin === 'pipe'
          ? 'pipe'
          : spec.stdio.stdin === 'ignore'
            ? 'ignore'
            : { data: spec.stdio.stdin.data },
        stdout: collectSpec(spec.stdio.stdout),
        stderr: collectSpec(spec.stdio.stderr),
        graceMs: spec.graceMs,
        ...spec.env === undefined ? {} : { env: definedEnv(spec.env) },
      })
      id = started.procId
      procId = id
      // Flush whatever arrived while the id was in flight; order is preserved
      // because the daemon pushes in order on one connection.
      for (const frame of bufferedFrames.splice(0)) deliverPipeFrame(frame)
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
    // This provider carries no separate control channel.
    control: undefined,
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

    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      const remote = remoteTarget(spec.cwd, deps.anchors(), deps.channel)
      if (remote === undefined) return deps.localProc.spawn(spec)
      return createRemoteHandle(
        remote.channel,
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
