/**
 * The remote terminal provider: a PTY a node daemon owns.
 *
 * A terminal on another machine cannot be streamed: the wire answers one
 * request at a time, and the daemon retains a bounded window of output rather
 * than pushing it. This provider therefore polls that window into a local
 * `PassThrough`, so a consumer reads the same `Readable` it would read from a
 * local PTY, one poll interval behind.
 *
 * What it drives is a port, not the harness wire directly: {@link TtyWire} is
 * the six terminal methods this provider needs, and the plugin that owns the
 * protocol adapts its channel to it. The shapes a port declares and the shapes
 * that adapter passes are checked against each other in one place, so a wire
 * that drifts fails to compile rather than failing at a terminal.
 *
 * @module dsh-remote-workspace/remote/tty
 */

import { StringDecoder } from 'node:string_decoder'
import { PassThrough } from 'node:stream'
import { DEFAULT_TTY_GRACE_MS } from '../tty.ts'
import type { TtyHandle, TtyOutcome, TtySpawnRequest } from '../tty.ts'

/**
 * How often the proxy asks the daemon for new output.
 *
 * The wire serves retained windows rather than pushing, so this is the
 * interactive latency floor: small enough that a prompt appears promptly, large
 * enough that an idle terminal does not flood the connection.
 */
const POLL_MS = 40

/** One terminal allocation, as the daemon's wire carries it. */
export interface TtyWireSpawnRequest {
  /** Executable and arguments; the daemon never shell-interprets them. */
  readonly argv: readonly string[]
  /** Absolute working directory in the daemon's filesystem. */
  readonly cwd: string
  /** Initial terminal row count. */
  readonly rows: number
  /** Initial terminal column count. */
  readonly cols: number
  /** TERM-to-KILL cleanup grace for the terminal session; the daemon requires it. */
  readonly graceMs: number
  /** Explicit environment entries layered over the daemon's own base. */
  readonly env?: Readonly<Record<string, string>>
}

/** What the daemon answered for one allocation. */
export interface TtyWireStarted {
  /** The session the daemon minted. */
  readonly termId: string
  /** Process id on the daemon's machine. */
  readonly pid: number
}

/** One read of a terminal's retained output window. */
export interface TtyWireRead {
  /** Raw bytes from the requested offset, base64. */
  readonly data: string
  /** Whole-stream byte offset to resume from. */
  readonly nextOffset: number
}

/** Exit facts of one closed terminal. */
export interface TtyWireOutcome {
  /** Exit code; null when a signal ended it. */
  readonly exitCode: number | null
  /** Terminating signal name; null on a normal exit. */
  readonly signal: string | null
}

/**
 * The terminal methods of one node's wire.
 *
 * Every method rejects when the node cannot be reached, which is what lets the
 * proxy settle a terminal whose transport is gone instead of polling forever.
 */
export interface TtyWire {
  /** Allocate one terminal and start the program in it. */
  spawn(request: TtyWireSpawnRequest): Promise<TtyWireStarted>
  /** Read retained output from one whole-stream byte offset. */
  read(termId: string, fromByte: number): Promise<TtyWireRead>
  /** Deliver input bytes. */
  write(termId: string, data: string): Promise<void>
  /** Adopt a new window size. */
  resize(termId: string, cols: number, rows: number): Promise<void>
  /** Release the terminal, escalating to a kill after its grace period. */
  terminate(termId: string): Promise<void>
  /** The exit facts, or null while the terminal is still running or unknown. */
  outcome(termId: string): Promise<TtyWireOutcome | null>
}

/**
 * Allocate one terminal on a node and proxy its live output.
 *
 * The handle settles once, with the facts it has: a terminal that exited, one
 * that was released, and one whose transport dropped all end the same way, and
 * a consumer that wanted the difference reads it from what came back rather
 * than waiting for output that can no longer arrive.
 * @param wire - the node's terminal methods.
 * @param request - what to run, where, how large, and how long to wait.
 * @param verbs - extra daemon verbs to hang on the same handle, for a seam that
 *   has more than this port names e.g. the subprocess seam's foreground verbs.
 * @returns the live handle, carrying whatever `verbs` added.
 * @throws when the allocation itself fails, so a caller learns before it holds a handle.
 */
export async function createRemoteTty(wire: TtyWire, request: TtySpawnRequest): Promise<TtyHandle>
export async function createRemoteTty<Extra extends object>(
  wire: TtyWire,
  request: TtySpawnRequest,
  verbs: (termId: string) => Extra,
): Promise<TtyHandle & Extra>
export async function createRemoteTty(
  wire: TtyWire,
  request: TtySpawnRequest,
  verbs?: (termId: string) => object,
): Promise<TtyHandle> {
  const started = await wire.spawn({
    argv: [...request.argv],
    cwd: request.cwd,
    rows: request.rows,
    cols: request.cols,
    graceMs: request.graceMs ?? DEFAULT_TTY_GRACE_MS,
    ...request.env === undefined ? {} : { env: request.env },
  })

  const output = new PassThrough()
  // A poll reads a raw byte window, so it can end in the middle of a character;
  // the decoder holds the partial sequence until the next poll completes it.
  const decoder = new StringDecoder('utf8')
  let offset = 0
  let finished = false
  let pumping = false
  let timer: NodeJS.Timeout | undefined

  let settleDone: (outcome: TtyOutcome) => void = () => {}
  const done = new Promise<TtyOutcome>((resolve) => { settleDone = resolve })

  /** Publish the outcome once and stop polling. */
  const finish = (outcome: TtyOutcome): void => {
    if (finished) return
    finished = true
    if (timer !== undefined) clearInterval(timer)
    output.end(decoder.end())
    settleDone(outcome)
  }

  /** Pull whatever the daemon has written since the last offset. */
  const pull = async (): Promise<void> => {
    const read = await wire.read(started.termId, offset)
    offset = read.nextOffset
    if (read.data.length > 0) output.write(decoder.write(Buffer.from(read.data, 'base64')))
  }

  /** One poll: pull what the daemon retains, then ask whether it exited. */
  const tick = async (): Promise<void> => {
    if (pumping || finished) return
    pumping = true
    try {
      await pull()
      const outcome = await wire.outcome(started.termId)
      if (outcome !== null) {
        finish({ exitCode: outcome.exitCode, signal: outcome.signal as NodeJS.Signals | null })
      }
    } catch {
      // A dropped transport ends the terminal: the handle settles rather than
      // hanging on output that can no longer arrive.
      finish({ exitCode: null, signal: null })
    } finally {
      pumping = false
    }
  }

  timer = setInterval(() => void tick(), POLL_MS)
  // A terminal must not hold the host open by itself; the caller releases it.
  timer.unref()
  void tick()

  /** The teardown in flight, so a second `terminate` joins the first. */
  let stopping: Promise<void> | undefined

  const handle: TtyHandle = {
    pid: started.pid,
    output,
    done,
    async write(data: string): Promise<void> {
      await wire.write(started.termId, data)
    },
    async resize(cols: number, rows: number): Promise<void> {
      await wire.resize(started.termId, cols, rows)
    },
    async terminate(): Promise<void> {
      stopping ??= (async () => {
        if (finished) return
        await wire.terminate(started.termId)
        // One last pull, so output produced during teardown is not lost.
        await pull().catch(() => undefined)
        // A terminal the daemon no longer knows reads as "no outcome": the exit
        // facts are absent, which is exactly what a released terminal has.
        const outcome = await wire.outcome(started.termId).catch(() => null)
        finish({
          exitCode: outcome?.exitCode ?? null,
          signal: (outcome?.signal ?? null) as NodeJS.Signals | null,
        })
      })()
      await stopping
    },
  }
  return verbs === undefined ? handle : { ...handle, ...verbs(started.termId) }
}
