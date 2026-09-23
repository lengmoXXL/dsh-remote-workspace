/**
 * The remote terminal provider: a PTY a node daemon owns.
 *
 * A terminal on another machine is followed rather than streamed: the wire
 * answers one request at a time, and the daemon retains a bounded window of
 * output. This provider reads that window into a local `PassThrough`, which a
 * consumer reads exactly as it would read a local PTY. Each read waits at the
 * daemon until there is something to answer with, so a quiet terminal costs one
 * request every twenty seconds rather than one per poll interval, and a busy one
 * costs one round trip per batch.
 *
 * What it drives is a port, not the harness wire directly: {@link TtyWire} is
 * the six terminal methods this provider needs, and the plugin that owns the
 * protocol adapts its channel to it. The shapes a port declares and the shapes
 * that adapter passes are checked against each other in one place, so a wire
 * that drifts fails to compile rather than failing at a terminal.
 *
 * @module dsh-remote-workspace/remote/tty
 */

import { once } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import { PassThrough } from 'node:stream'
import { DEFAULT_TTY_GRACE_MS } from '../tty.ts'
import type { TtyHandle, TtyOutcome, TtySpawnRequest } from '../tty.ts'

/**
 * How long one read waits at the daemon for output before asking again.
 *
 * Long enough that a quiet terminal is silent on the wire, short enough that a
 * connection which stopped answering is noticed while a person is still
 * looking at the terminal.
 */
const READ_WAIT_MS = 20_000

/**
 * How long to pause after a read that answered nothing and did not wait.
 *
 * A daemon that knows `waitMs` returns an empty read only after waiting for
 * one, so this pause is invisible beside that wait. One that does not — an
 * agent older than this plugin — answers at once, and this pace is the poll
 * interval this loop replaced: the two requests an answer costs therefore cost
 * no more than the old poll's two did.
 */
const IDLE_PACE_MS = 40

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

/** One read of a terminal's output window. */
export interface TtyWireRead {
  /** Raw bytes from the requested offset, base64. */
  readonly data: string
  /** Whole-stream byte offset to resume from. */
  readonly nextOffset: number
  /**
   * True when the requested offset had already slid out of the daemon's window,
   * so `data` is the retained tail rather than the continuation asked for.
   */
  readonly lossy: boolean
  /** Exit facts, present once the terminal's process has ended. */
  readonly outcome?: TtyWireOutcome | null
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
 * proxy settle a terminal whose transport is gone instead of waiting forever.
 */
export interface TtyWire {
  /** Allocate one terminal and start the program in it. */
  spawn(request: TtyWireSpawnRequest): Promise<TtyWireStarted>
  /**
   * Read retained output from one whole-stream byte offset, waiting up to
   * `waitMs` for output that has not arrived yet.
   */
  read(termId: string, fromByte: number, waitMs?: number): Promise<TtyWireRead>
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
  // A read returns a raw byte window, so it can end in the middle of a
  // character; the decoder holds the partial sequence until the next read
  // completes it.
  const decoder = new StringDecoder('utf8')
  let offset = 0
  let finished = false

  let settleDone: (outcome: TtyOutcome) => void = () => {}
  const done = new Promise<TtyOutcome>((resolve) => { settleDone = resolve })

  /** Publish the outcome once and stop reading. */
  const finish = (outcome: TtyOutcome): void => {
    if (finished) return
    finished = true
    output.end(decoder.end())
    settleDone(outcome)
  }

  /** Write to the local stream, waiting for a consumer that has fallen behind. */
  const publish = async (text: string): Promise<void> => {
    // A teardown can settle the handle while a read that was already in flight
    // is still resuming, and writing to an ended stream would crash the loop.
    if (finished || text.length === 0) return
    if (!output.write(text)) await once(output, 'drain')
  }

  /**
   * Read what the daemon has written since the last offset.
   * @returns the exit facts once the terminal has ended, otherwise undefined.
   */
  const pull = async (): Promise<TtyWireOutcome | null | undefined> => {
    const read = await wire.read(started.termId, offset, READ_WAIT_MS)
    const bytes = read.data.length === 0 ? Buffer.alloc(0) : Buffer.from(read.data, 'base64')
    if (read.lossy) {
      // The offset asked for had slid out of the daemon's window, so these bytes
      // are the retained tail: the bytes before it are gone and cannot be
      // fetched. Saying so is the difference between a gap and a splice.
      const lost = read.nextOffset - bytes.length - offset
      await publish('\r\n[output lost: ' + String(lost) + ' bytes]\r\n')
    }
    offset = read.nextOffset
    if (bytes.length > 0) {
      await publish(decoder.write(bytes))
      return read.outcome
    }
    if (read.outcome != null) return read.outcome
    // An empty answer means "nothing yet". A daemon that knows \`waitMs\` returns
    // one only after waiting, and its read already carries the exit facts; one
    // older than this plugin answers at once and cannot, so its facts are asked
    // for directly rather than waiting for a read that will never say them.
    const facts = await wire.outcome(started.termId)
    if (facts !== null) return facts
    await new Promise(resolve => setTimeout(resolve, IDLE_PACE_MS))
    return undefined
  }

  const follow = async (): Promise<void> => {
    for (;;) {
      let ended: TtyWireOutcome | null | undefined
      try {
        ended = await pull()
      } catch {
        // A dropped transport ends the terminal: the handle settles rather than
        // hanging on output that can no longer arrive.
        finish({ exitCode: null, signal: null })
        return
      }
      if (finished) return
      if (ended != null) {
        finish({
          exitCode: ended?.exitCode ?? null,
          signal: (ended?.signal ?? null) as NodeJS.Signals | null,
        })
        return
      }
    }
  }
  void follow()

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
        // One last pull, so output produced during teardown is not lost, then
        // the facts the daemon kept. A terminal the daemon no longer knows reads
        // as "no outcome": the exit facts are absent, which is exactly what a
        // released terminal has.
        const last = await pull().catch(() => undefined)
        const outcome = last === undefined
          ? await wire.outcome(started.termId).catch(() => null)
          : last
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
