/**
 * The local terminal provider: a PTY on this host.
 *
 * This is the shape a deployment gets when nothing routes a working directory
 * elsewhere. A routing provider composes it for the directories it does not own,
 * which is why the work lives in a class: the same code serves a standalone
 * deployment and one that answers for local paths inside a router.
 *
 * node-pty is the substrate because the seam needs `resize`, and the PTY is what
 * holds the window size: writing to a master descriptor cannot change it. The
 * size a terminal was born with is therefore not the size it keeps, which is the
 * whole point of this package.
 *
 * @module dsh-remote-workspace/local/tty
 */

import { constants } from 'node:os'
import { PassThrough } from 'node:stream'
import * as nodePty from 'node-pty'
import { DEFAULT_TTY_GRACE_MS, TtyRuntime } from '../tty.ts'
import type { TtyHandle, TtyOutcome, TtySpawnRequest } from '../tty.ts'

/** What a PTY calls itself when the caller names no terminal type. */
const TERM = 'xterm-256color'

/** How long a killed terminal is given to report its exit before the wait ends. */
const KILL_SETTLE_MS = 2000

/**
 * The environment a shell starts in.
 *
 * This process's own environment, so a terminal sees the same PATH and tooling
 * an agent on this host would, with the terminal type and the caller's entries
 * layered over it. Variables Node leaves undefined are dropped rather than sent
 * as the string "undefined".
 * @param overrides - entries the caller supplied.
 * @returns the environment to spawn with.
 */
function spawnEnv(overrides: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  return { ...env, TERM, ...overrides }
}

/**
 * The name of a signal node-pty reported as a number.
 * @param code - the number from the exit event; zero means no signal.
 * @returns the signal name, or null when the process exited on its own.
 */
function signalName(code: number): NodeJS.Signals | null {
  if (code === 0) return null
  for (const [name, value] of Object.entries(constants.signals)) {
    if (value === code) return name as NodeJS.Signals
  }
  return null
}

/** Wait for one promise, or for its budget to run out. */
async function within(ms: number, promise: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const expiry = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) })
  await Promise.race([promise, expiry])
  if (timer !== undefined) clearTimeout(timer)
}

/** One terminal this host owns. */
class LocalTtyHandle implements TtyHandle {
  readonly pid: number
  readonly output = new PassThrough()
  readonly done: Promise<TtyOutcome>
  private readonly terminal: nodePty.IPty
  private readonly graceMs: number
  private exited = false
  private stopping: Promise<void> | undefined
  private readonly exit: Promise<void>

  /**
   * @param terminal - the allocated node-pty process.
   * @param graceMs - milliseconds between the terminate signal and the kill.
   */
  constructor(terminal: nodePty.IPty, graceMs: number) {
    this.terminal = terminal
    this.pid = terminal.pid
    this.graceMs = graceMs
    let settleExit: () => void = () => {}
    this.exit = new Promise<void>((resolve) => { settleExit = resolve })
    let settleDone: (outcome: TtyOutcome) => void = () => {}
    this.done = new Promise<TtyOutcome>((resolve) => { settleDone = resolve })
    terminal.onData(data => { this.output.write(Buffer.from(data, 'utf8')) })
    terminal.onExit(({ exitCode, signal }) => {
      this.exited = true
      this.output.end()
      settleExit()
      settleDone({ exitCode, signal: signalName(signal ?? 0) })
    })
  }

  async write(data: string): Promise<void> {
    this.terminal.write(data)
  }

  async resize(cols: number, rows: number): Promise<void> {
    this.terminal.resize(cols, rows)
  }

  async terminate(): Promise<void> {
    this.stopping ??= this.stop()
    await this.stopping
  }

  /**
   * Signal the process, kill it if it outlives the grace period, and wait for
   * the exit it reports. A terminal that never reports one ends the wait rather
   * than hanging the caller on a process the kernel has already killed.
   */
  private async stop(): Promise<void> {
    if (this.exited) return
    this.terminal.kill('SIGTERM')
    await within(this.graceMs, this.exit)
    if (this.exited) return
    this.terminal.kill('SIGKILL')
    await within(KILL_SETTLE_MS, this.exit)
  }
}

/**
 * A terminal provider that owns PTYs on this host.
 *
 * It takes no config: every choice a terminal needs — what to run, where, how
 * large, how long to wait before killing — arrives on the request, so nothing
 * about a deployment has to be settled before a terminal is asked for.
 */
export class LocalTtyRuntime extends TtyRuntime {
  async spawn(request: TtySpawnRequest): Promise<TtyHandle> {
    const terminal = nodePty.spawn(request.argv[0], request.argv.slice(1), {
      name: TERM,
      cols: request.cols,
      rows: request.rows,
      cwd: request.cwd,
      env: spawnEnv(request.env),
    })
    return new LocalTtyHandle(terminal, request.graceMs ?? DEFAULT_TTY_GRACE_MS)
  }
}
