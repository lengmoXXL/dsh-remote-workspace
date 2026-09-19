/**
 * Reaching one machine over `ssh`: the one-shot commands that install and start
 * its daemon, and the port forward that then carries daemon traffic.
 *
 * Both jobs share the same two decisions, so both live here: the options that
 * keep `ssh` from ever prompting, and the translation of what it wrote on
 * failure into a remedy. A change to either reaches every caller.
 *
 * The two jobs report differently because their processes differ. A command
 * runs to completion and hands back its exit status and both streams, so
 * {@link runSsh} resolves for any normal exit, non-zero included — a command
 * that reports "no" is a result the caller inspects, not an exception — and
 * rejects only when `ssh` could not be started or the caller's deadline passed.
 * A forward is a long-lived process that either starts accepting connections or
 * does not, so {@link openTunnel} resolves once the local port is live and
 * never reports an exit status.
 *
 * The daemon binds the machine's own loopback, so the host reaches it the way a
 * person would by hand: a local port, a `ssh -L` forward, and a connection
 * through it. That port is chosen per connection from whatever the host has
 * free, because a fixed one would collide with whatever else the operator runs
 * and is not part of a machine's identity. The host never accepts a host key on
 * the operator's behalf: an unknown key fails the forward with a diagnostic
 * naming the command that would accept it, because this forward grants shell
 * access as the remote user.
 *
 * @module dsh-remote-workspace/remote/ssh
 */

import { spawn } from 'node:child_process'
import { connect, createServer } from 'node:net'

/** How to reach a machine's SSH server. */
export interface SshTarget {
  /** `ssh` destination: `user@host`, or a `~/.ssh/config` alias. */
  readonly target: string
  /** SSH port; omitted defers to the operator's `ssh` configuration. */
  readonly sshPort?: number
  /** Identity file; omitted defers to the operator's `ssh` configuration. */
  readonly identityFile?: string
}

/** What one remote command produced. */
export interface SshCommandResult {
  /** Exit status; `0` means the command succeeded. */
  readonly code: number
  /** Everything the command wrote to stdout, UTF-8 decoded. */
  readonly stdout: string
  /** Everything `ssh` and the command wrote to stderr, UTF-8 decoded. */
  readonly stderr: string
}

/** Knobs one command run reads. */
export interface SshRunOptions {
  /** Bytes to write to the remote command's stdin; the stream then closes. */
  readonly input?: Buffer | string
  /** Bound on the whole run, in milliseconds; omitted waits indefinitely. */
  readonly timeoutMs?: number
}

/** The slice of a spawned `ssh` process one command run drives. */
export interface SshProcess {
  /** Resolves with the exit code, or rejects when `ssh` could not start. */
  readonly exited: Promise<number>
  /** Everything written to stdout; complete once `exited` settles. */
  readStdout(): string
  /** Everything written to stderr; complete once `exited` settles. */
  readStderr(): string
  /** Write the input to stdin and close it; no input just closes it. */
  send(input: Buffer | string | undefined): void
  /** Terminate the process. */
  kill(): void
}

/** Starts one `ssh` process; injectable so tests need no binary. */
export type StartSsh = (args: readonly string[]) => SshProcess

/** Overrides {@link runSsh} accepts for its process handling. */
export interface SshRunDeps {
  /** Starts `ssh`; defaults to the real process. */
  readonly start?: StartSsh
}

/**
 * Build the `ssh` options that make a run non-interactive against this target.
 *
 * The SSH port and identity file default to the operator's own configuration,
 * so a `~/.ssh/config` alias reaches the machine exactly as `ssh` itself would.
 * @param target - the machine to reach.
 * @returns the arguments, excluding the subcommand and the destination.
 */
export function sshArgs(target: SshTarget): readonly string[] {
  return [
    // No terminal is attached, so an authentication or host-key prompt would
    // hang until a caller's deadline expired. Fail immediately instead, and
    // let the diagnostic name what the operator must do.
    '-o', 'BatchMode=yes',
    // Without this a forward that cannot bind leaves an ssh process running
    // that forwards nothing, which reads as a healthy connection.
    '-o', 'ExitOnForwardFailure=yes',
    // A forward has to die when the link does: the connection manager watches
    // this process to publish the loss, and a half-open link would otherwise
    // leave it running for hours, forwarding nothing.
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    ...target.sshPort === undefined ? [] : ['-p', String(target.sshPort)],
    ...target.identityFile === undefined ? [] : ['-i', target.identityFile],
  ]
}

/**
 * Turn what `ssh` wrote into a reason an operator can act on.
 *
 * The raw text stays in the message: this maps only the failures with a known
 * remedy, and everything else is more useful verbatim than paraphrased.
 * @param target - the destination the run named.
 * @param stderr - everything the process wrote to stderr.
 * @param fallback - what to say when nothing matches, without the raw text.
 * @returns the message to raise.
 */
export function sshFailure(target: string, stderr: string, fallback: string): string {
  const text = stderr.trim()
  const suffix = text === '' ? '' : `: ${text}`
  if (/host key verification failed/i.test(text)) {
    return `the SSH host key for "${target}" is not known yet; run \`ssh ${target}\` once to verify and accept it${suffix}`
  }
  if (/administratively prohibited/i.test(text)) {
    return `"${target}" refuses TCP forwarding; its sshd needs AllowTcpForwarding yes${suffix}`
  }
  if (/permission denied|no supported authentication/i.test(text)) {
    return `"${target}" rejected the key or agent; check the SSH key and ssh-agent${suffix}`
  }
  if (/could not resolve hostname/i.test(text)) {
    return `"${target}" cannot be resolved; check the SSH destination${suffix}`
  }
  if (/connection refused|connection timed out|no route to host/i.test(text)) {
    return `"${target}" is unreachable over SSH${suffix}`
  }
  return `${fallback}${suffix}`
}

/** Start the real `ssh` process for one command run. */
function startSshCommand(args: readonly string[]): SshProcess {
  const child = spawn('ssh', [...args], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { stdout += chunk })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  // A command that never reads stdin closes the pipe early; that is normal and
  // must not surface as an unhandled stream error.
  child.stdin.on('error', () => {})
  return {
    exited: new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => { resolve(code ?? 0) })
    }),
    readStdout: () => stdout,
    readStderr: () => stderr,
    send: (input) => { child.stdin.end(input) },
    kill: () => { child.kill('SIGTERM') },
  }
}

/**
 * Run one command on a machine over SSH.
 *
 * Resolves with the exit status, stdout, and stderr for any exit the process
 * reached on its own, a non-zero one included. Rejects only when `ssh` could
 * not be started or `options.timeoutMs` elapsed; in the first case the
 * diagnostic says so, and in the second it carries whatever stderr arrived.
 * @param ssh - the machine to reach.
 * @param command - the command string the remote shell runs.
 * @param options - optional stdin bytes and a deadline.
 * @param deps - an optional process starter, for tests.
 * @returns the exit status and both streams.
 * @throws when `ssh` cannot start or the deadline passes.
 */
export async function runSsh(
  ssh: SshTarget,
  command: string,
  options: SshRunOptions = {},
  deps: SshRunDeps = {},
): Promise<SshCommandResult> {
  const start = deps.start ?? startSshCommand
  const child = start([...sshArgs(ssh), ssh.target, command])
  child.send(options.input)

  const timeoutMs = options.timeoutMs
  let timer: NodeJS.Timeout | undefined
  let timedOut = false
  const deadline = timeoutMs === undefined
    ? undefined
    : new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        reject(new Error('timeout'))
      }, timeoutMs)
    })

  try {
    const code = await (deadline === undefined ? child.exited : Promise.race([child.exited, deadline]))
    return { code, stdout: child.readStdout(), stderr: child.readStderr() }
  } catch (error) {
    child.kill()
    if (timedOut) {
      throw new Error(
        `the SSH command on "${ssh.target}" did not finish within ${String(timeoutMs)}ms`,
        { cause: error },
      )
    }
    throw new Error(
      `could not start ssh for "${ssh.target}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** One forward to open. */
export interface TunnelSpec {
  /** The machine to reach. */
  readonly ssh: SshTarget
  /** Port the daemon listens on, on the machine's own loopback. */
  readonly remotePort: number
}

/** A live forward. */
export interface Tunnel {
  /** The local port that reaches the machine's daemon. */
  readonly localPort: number
  /** Resolves when the `ssh` process exits, for any reason. */
  readonly exited: Promise<void>
  /** Stop forwarding and reap the process. Idempotent. */
  close(): void
}

/** Knobs a caller may override; tests use them to avoid real processes. */
export interface TunnelDeps {
  /** Binds a free local port. */
  readonly allocatePort?: () => Promise<number>
  /** Starts the forward. */
  readonly start?: (args: readonly string[]) => TunnelProcess
  /** How long the forward may take to accept a connection. */
  readonly readyTimeoutMs?: number
  /** How long to wait between readiness probes. */
  readonly readyPollMs?: number
}

/** The slice of a spawned process this module drives. */
export interface TunnelProcess {
  /** Resolves once the process has exited. */
  readonly exited: Promise<void>
  /** Everything the process wrote to stderr so far. */
  readonly diagnostics: () => string
  /** Terminate the process. */
  kill(): void
}

/**
 * Default budget for a forward to start accepting connections. The plugin
 * exposes this as `Config.sshForwardTimeoutMs`; it is the fallback for a caller
 * that composes the tunnel directly.
 */
export const DEFAULT_FORWARD_TIMEOUT_MS = 15_000

/** Default gap between readiness probes. */
const READY_POLL_MS = 120

/**
 * Resolve a free TCP port on the host.
 *
 * The port is released before it is returned, so a caller racing for it can
 * lose; a forward that loses reports a bind failure rather than silently
 * forwarding nothing.
 * @returns the port number the host had free.
 */
export function allocateLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close()
        reject(new Error('could not determine a free local port'))
        return
      }
      const { port } = address
      probe.close(() => resolve(port))
    })
  })
}

/**
 * Build the `ssh` argument vector for one forward.
 * @param spec - the machine and the daemon port to reach.
 * @param localPort - the host port to forward.
 * @returns the arguments, excluding the executable.
 */
export function tunnelArgs(spec: TunnelSpec, localPort: number): readonly string[] {
  return [
    '-N',
    ...sshArgs(spec.ssh),
    '-L', `127.0.0.1:${String(localPort)}:127.0.0.1:${String(spec.remotePort)}`,
    spec.ssh.target,
  ]
}

/**
 * Turn what `ssh` wrote into a reason an operator can act on.
 * @param target - the destination the forward named.
 * @param stderr - everything the process wrote to stderr.
 * @returns the message to raise.
 */
export function tunnelFailure(target: string, stderr: string): string {
  return sshFailure(target, stderr, `could not open an SSH forward to "${target}"`)
}

/** Start the real `ssh` process for one forward. */
function startSshForward(args: readonly string[]): TunnelProcess {
  const child = spawn('ssh', [...args], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  return {
    exited: new Promise<void>((resolve) => {
      child.once('error', () => { resolve() })
      child.once('exit', () => { resolve() })
    }),
    diagnostics: () => stderr,
    kill: () => { child.kill('SIGTERM') },
  }
}

/** Probe one TCP port on the host's loopback. */
function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const settle = (open: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(open)
    }
    socket.once('connect', () => { settle(true) })
    socket.once('error', () => { settle(false) })
  })
}

/** Wait until a port accepts a connection, the process dies, or time runs out. */
async function waitForForward(
  target: string,
  port: number,
  process: TunnelProcess,
  timeoutMs: number,
  pollMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let exited = false
  void process.exited.then(() => { exited = true })
  for (;;) {
    if (await probePort(port)) return
    if (exited) throw new Error(tunnelFailure(target, process.diagnostics()))
    if (Date.now() >= deadline) {
      throw new Error(
        `the SSH forward to "${target}" did not start accepting connections within ${String(timeoutMs)}ms`,
      )
    }
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
}

/**
 * Open a forward from a free host port to one machine's daemon.
 *
 * Resolves once the forward accepts connections, so a caller that receives a
 * tunnel can connect through it immediately. Rejects — after killing the
 * process — when `ssh` refuses, exits, or never becomes ready.
 * @param spec - the machine and the daemon port to reach.
 * @param deps - overrides for tests.
 * @returns the live forward.
 * @throws when the forward could not be established.
 */
export async function openTunnel(spec: TunnelSpec, deps: TunnelDeps = {}): Promise<Tunnel> {
  const allocatePort = deps.allocatePort ?? allocateLocalPort
  const start = deps.start ?? startSshForward
  const localPort = await allocatePort()
  const process = start(tunnelArgs(spec, localPort))
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    process.kill()
  }
  try {
    await waitForForward(
      spec.ssh.target,
      localPort,
      process,
      deps.readyTimeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS,
      deps.readyPollMs ?? READY_POLL_MS,
    )
  } catch (error) {
    close()
    // A forward that died says why; a forward that never bound says what it
    // wrote, which is the only clue to which option the operator must change.
    const stderr = process.diagnostics()
    if (stderr !== '' && error instanceof Error) {
      throw new Error(tunnelFailure(spec.ssh.target, stderr), { cause: error })
    }
    throw error
  }
  return { localPort, exited: process.exited, close }
}
