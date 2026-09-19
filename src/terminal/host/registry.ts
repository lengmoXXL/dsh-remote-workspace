/**
 * The host's terminals, as a lookup table of the shells a person's tabs have
 * open.
 *
 * A tab owns its shell, but the socket is only a view of it. The socket closing
 * detaches: the terminal stays in the table, its output keeps filling the ring
 * buffer, and the model's tool can still address it for as long as the process
 * lives. An explicit end — the chooser's close route — the process exiting, the
 * owning Session ending, or an optional detach valve releases it; nobody
 * watching is not by itself a reason to end a shell.
 *
 * The table exists for the model. The sidebar terminal never needs to look up
 * its own shell, but the model-facing terminal tool must find one that a
 * person opened — and must not create one. Each terminal therefore carries a
 * registry-unique id (`t1`, `t2`, …) and a human label, and every operation the
 * tool performs passes through {@link TerminalRegistry.requireOwned}, the one
 * place that decides whether the calling Session may touch a terminal at all.
 *
 * Output is retained in a byte ring buffer with absolute offsets, so the tool
 * can read the tail, resume from where it last read, and wait for a match
 * without holding a second PTY or a second stream. The buffer is bounded at
 * {@link BUFFER_BYTES}; the bytes it drops stay accounted for, so an offset
 * never silently changes meaning.
 *
 * @module dsh-remote-workspace/terminal/host/registry
 */

import { Buffer } from 'node:buffer'
import type { TtyHandle, TtyOutcome, TtySpawnRequest } from '../../tty.ts'

/** How this deployment starts a shell. */
export interface TerminalSettings {
  /** The program to run, which is the shell the terminal is named after. */
  readonly shell: string
  /** Arguments after the program. */
  readonly shellArgs: readonly string[]
  /** Environment layered onto the provider's ambient scrub. */
  readonly env: Readonly<Record<string, string>>
  /** TERM-to-KILL grace for the whole terminal session, in milliseconds. */
  readonly graceMs: number
  /**
   * Safety valve: how long a terminal whose last socket went away is kept
   * alive, in milliseconds, before it is released.
   *
   * Unset or `0` — the default — keeps it alive for as long as its process
   * lives, because how long a browser is gone says nothing about whether the
   * shell should end. A positive value releases a detached terminal that long
   * after the last sink left, which is a bound the operator opts into.
   */
  readonly detachGraceMs?: number
}

/** One consumer of a live terminal's output. */
export interface TerminalSink {
  /**
   * Receive one chunk, in order.
   *
   * Returning a promise pauses the PTY until it settles, so a slow socket
   * applies backpressure instead of queueing a flood inside this process.
   * @param chunk - the output bytes.
   */
  output(chunk: Buffer): void | Promise<void>
  /**
   * The top-level process ended.
   * @param outcome - how it ended.
   */
  exit(outcome: TtyOutcome): void
  /**
   * The terminal failed before it could report an exit.
   * @param error - the failure.
   */
  fail(error: unknown): void
}

/** One terminal, as the model-facing list reports it. */
export interface TerminalView {
  /** Registry-unique identity; what the model passes as `terminal`. */
  readonly id: string
  /** Human label, also the tab title. */
  readonly label: string
  /** Working directory on the machine that owns the shell. */
  readonly cwd: string
  /** Machine title, for a reader that wants to know where the shell runs. */
  readonly machine: string
  /** Process id on that machine. */
  readonly pid: number
  /**
   * Lifecycle state; a released terminal is absent from the list entirely.
   *
   * `detached` is a live shell nobody is watching: its last socket went away
   * and it lives on until it is closed, its process exits, or its Session ends.
   * The model can still address it, and saying so is the difference between a
   * terminal that is gone and one that is waiting to be reattached.
   */
  readonly state: 'running' | 'detached' | 'exited'
  /** Current column count. */
  readonly cols: number
  /** Current row count. */
  readonly rows: number
}

/** One registered terminal, with the state its owner and the tool read. */
export interface TerminalEntry {
  readonly id: string
  readonly label: string
  readonly sessionId: string
  readonly machine: string
  readonly cwd: string
  readonly handle: TtyHandle
  /** Retained output, oldest first; `buffer.length === bytes - dropped`. */
  buffer: Buffer
  /** Absolute byte offset just past the newest byte ever produced. */
  bytes: number
  /** Bytes dropped from the front of the stream to keep `buffer` bounded. */
  dropped: number
  state: 'running' | 'detached' | 'exited'
  cols: number
  rows: number
  /** Consumers currently receiving output; the tab's socket is the usual one. */
  readonly attaches: Set<TerminalSink>
  /** Waiters to wake when output arrives or the process exits. */
  readonly waiters: Set<() => void>
  /** Pending release of a terminal whose last socket detached; absent while attached. */
  detachTimer?: NodeJS.Timeout | undefined
}

/** One bounded page of retained output. */
export interface TerminalRead {
  readonly id: string
  /** Absolute byte offset just past the returned text; the next read resumes there. */
  readonly offset: number
  readonly text: string
  /** Whether output before the returned text was dropped or cut by the line cap. */
  readonly truncated: boolean
}

/** What one wait is asked for. */
export interface TerminalWaitRequest {
  /**
   * Absolute byte offset to start searching from; omitted starts at the
   * beginning of the retained tail a default read returns, so output that
   * already arrived can match.
   */
  readonly offset?: number
  /** Plain substring to wait for. Exactly one of `match` and `regex` is required. */
  readonly match?: string
  /** Regular expression source to wait for. */
  readonly regex?: string
  /** Budget in milliseconds; defaults to {@link DEFAULT_WAIT_MS}. */
  readonly timeoutMs?: number
}

/** How one wait ended. */
export interface TerminalWait {
  readonly id: string
  /** Absolute byte offset just past the returned text. */
  readonly offset: number
  /** Everything searched, from the wait's start offset through the newest byte. */
  readonly text: string
  readonly matched: boolean
  readonly reason: 'match' | 'exit' | 'timeout'
}

/**
 * The terminal table the socket, the management API, and the model's tool share.
 */
export interface TerminalRegistry {
  /**
   * Register a terminal a person just opened, spawning it through the seam.
   * @param sessionId - the Session whose tab owns it.
   * @param cwd - the workspace directory, which also decides the machine.
   * @param size - the browser-measured geometry.
   * @returns the registered entry.
   */
  open(
    sessionId: string,
    cwd: string,
    size: { readonly cols: number; readonly rows: number },
  ): Promise<TerminalEntry>
  /**
   * Deliver a terminal's output to one consumer, replaying what it missed.
   *
   * The retained output is handed to the sink before any later chunk, so a
   * reattached socket shows history in order. Attaching also cancels a pending
   * detach valve: the terminal is watched again.
   * @param id - the terminal.
   * @param sink - where output, exit, and failure go.
   * @returns the entry, for the frame the socket answers with.
   * @throws TerminalRegistryError when the terminal is unknown or already exited.
   */
  attach(id: string, sink: TerminalSink): TerminalEntry
  /**
   * Stop delivering a terminal's output to one consumer, without ending it.
   *
   * The last sink leaving marks the terminal `detached` without ending it; an
   * already-exited terminal is released at once instead, and a configured
   * detach valve schedules that release for later.
   * @param id - the terminal.
   * @param sink - the consumer to remove.
   */
  detach(id: string, sink: TerminalSink): void
  /**
   * Adopt a browser-measured size.
   * @param id - the terminal.
   * @param cols - column count.
   * @param rows - row count.
   * @returns whether the provider accepted it; a refusal leaves the old size.
   */
  resize(id: string, cols: number, rows: number): Promise<boolean>
  /**
   * Every terminal one Session has open, in registration order.
   * @param sessionId - the Session identity.
   * @returns fresh views.
   */
  listFor(sessionId: string): TerminalView[]
  /**
   * Resolve the terminal one Session is addressing.
   *
   * The only authorization point in this module: nothing else decides whether a
   * Session may touch a terminal. A named terminal that is unknown, owned by
   * another Session, or already exited is refused without saying which, because
   * distinguishing them would report on another Session's terminal. A detached
   * terminal is still addressable — a dropped connection is not an exit.
   * @param sessionId - the calling Session.
   * @param id - the requested terminal, or undefined when the Session has exactly one.
   * @returns the entry.
   * @throws TerminalRegistryError with a reason the model can act on.
   */
  requireOwned(sessionId: string, id?: string | undefined): TerminalEntry
  /**
   * Deliver literal text.
   * @param id - the terminal.
   * @param text - the text, written verbatim.
   * @returns how many bytes were written.
   */
  write(id: string, text: string): Promise<number>
  /**
   * Deliver logical keystrokes, validating every name before writing anything.
   * @param id - the terminal.
   * @param names - logical key names, each in {@link KEY_NAMES}.
   * @returns the byte count and the key count actually written.
   * @throws TerminalRegistryError naming the first unknown key, having written nothing.
   */
  keys(id: string, names: readonly string[]): Promise<{ bytes: number; keys: number }>
  /**
   * Read retained output.
   * @param id - the terminal.
   * @param offset - absolute byte offset to read from; omitted reads the tail.
   * @param lines - tail line count; defaults to {@link DEFAULT_READ_LINES}.
   * @returns the page and the offset that resumes after it.
   */
  read(id: string, offset?: number | undefined, lines?: number | undefined): TerminalRead
  /**
   * Wait for output to match, for the process to exit, or for the budget.
   * @param id - the terminal.
   * @param request - the matcher, the start offset, and the budget.
   * @param signal - caller cancellation; aborting rejects without a result.
   * @returns the wait's outcome, never an exit or a timeout as a throw.
   */
  wait(id: string, request: TerminalWaitRequest, signal?: AbortSignal): Promise<TerminalWait>
  /**
   * End one terminal and remove it.
   * @param id - the terminal.
   * @returns whether a terminal with that id was open.
   */
  kill(id: string): Promise<boolean>
  /**
   * End every terminal one Session owns; the per-session disposal hook.
   * @param sessionId - the Session that ended.
   */
  releaseSession(sessionId: string): Promise<void>
  /** End every terminal; the plugin's own teardown. */
  disposeAll(): Promise<void>
}

/** What the registry needs to create a terminal. */
export interface TerminalRegistryOptions {
  /** The `ctx.tty` seam's allocation verb, read when a terminal opens. */
  readonly spawn: (request: TtySpawnRequest) => Promise<TtyHandle>
  /** How to start a shell. */
  readonly settings: TerminalSettings
  /**
   * Which machine owns a working directory.
   * @param cwd - the workspace directory.
   * @returns the node id and the title to show a reader.
   */
  readonly machine: (cwd: string) => { readonly label: string }
  /**
   * The directory a shell asked for one path actually runs in.
   *
   * A workspace routed to a machine is named here by its local anchor path,
   * while the shell runs at the checkout on that machine. The row and the
   * status line name where the shell is, not where its workspace is registered.
   * @param cwd - the workspace directory the shell was asked for.
   * @returns the directory the shell lands in.
   */
  readonly directory: (cwd: string) => string
}

/** A terminal request the registry refused. */
export class TerminalRegistryError extends Error {
  override readonly name = 'TerminalRegistryError'
}

/** Bytes one terminal retains before the oldest are dropped. */
const BUFFER_BYTES = 256 * 1024

/** Tail line count a read keeps when the caller names none. */
export const DEFAULT_READ_LINES = 200

/** Largest tail a read may ask for. */
export const MAX_READ_LINES = 2000

/** Wait budget when the caller names none. */
export const DEFAULT_WAIT_MS = 30_000

/** Longest wait budget a caller may ask for. */
export const MAX_WAIT_MS = 300_000

/**
 * Logical key names a caller may send, in the order the refusal lists them.
 *
 * The values are the byte sequences a terminal emulator would send, so a caller
 * names an intent (`ctrl+c`) rather than spelling an escape.
 */
export const KEYS: Readonly<Record<string, string>> = {
  enter: '\r',
  esc: '\x1b',
  escape: '\x1b',
  tab: '\t',
  backspace: '\x7f',
  delete: '\x1b[3~',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  space: ' ',
  ...Object.fromEntries(
    Array.from({ length: 26 }, (_, index) => [
      `ctrl+${String.fromCharCode(97 + index)}`,
      String.fromCharCode(index + 1),
    ]),
  ),
}

/** Every logical key name, for a refusal that tells the caller what is valid. */
export const KEY_NAMES: readonly string[] = Object.keys(KEYS)

/**
 * Build the terminal registry.
 * @param options - what the registry needs to create a terminal.
 * @returns the registry the socket and the tool share.
 */
export function createTerminalRegistry(options: TerminalRegistryOptions): TerminalRegistry {
  const entries = new Map<string, TerminalEntry>()
  /** Monotonic id source; never reused, so a restart never inherits an id. */
  let nextOrdinal = 0
  const detachGraceMs = options.settings.detachGraceMs ?? 0

  /** Append output, dropping the oldest bytes once the cap is reached. */
  const append = (entry: TerminalEntry, chunk: Buffer): void => {
    entry.bytes += chunk.length
    if (chunk.length >= BUFFER_BYTES) {
      entry.buffer = Buffer.from(chunk.subarray(chunk.length - BUFFER_BYTES))
      entry.dropped = entry.bytes - entry.buffer.length
      return
    }
    const grown = entry.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([entry.buffer, chunk])
    const overflow = grown.length - BUFFER_BYTES
    entry.buffer = overflow > 0 ? Buffer.from(grown.subarray(overflow)) : grown
    entry.dropped = entry.bytes - entry.buffer.length
  }

  /** The retained text from one absolute offset, and whether earlier bytes are gone. */
  const textFrom = (entry: TerminalEntry, from: number): { text: string; truncated: boolean } => {
    const start = Math.max(from, entry.dropped)
    return {
      text: entry.buffer.subarray(start - entry.dropped).toString('utf8'),
      truncated: from < entry.dropped,
    }
  }

  /** Keep only the last `lines` lines of one string. */
  const tailLines = (text: string, lines: number): { text: string; cut: boolean } => {
    const parts = text.split('\n')
    if (parts.length <= lines) return { text, cut: false }
    return { text: parts.slice(parts.length - lines).join('\n'), cut: true }
  }

  /**
   * The absolute offset that begins the tail a default read returns.
   *
   * An offset-less wait searches from here rather than from the current end, so
   * output that arrived before the wait can still match.
   */
  const retainedStart = (entry: TerminalEntry): number => {
    const seen = textFrom(entry, entry.dropped)
    const tail = tailLines(seen.text, DEFAULT_READ_LINES)
    return Math.max(entry.dropped, entry.bytes - Buffer.byteLength(tail.text, 'utf8'))
  }

  /** Wake every waiter, which re-checks the terminal's new state. */
  const notify = (entry: TerminalEntry): void => {
    for (const waiter of [...entry.waiters]) waiter()
  }

  /** Stream a spawned terminal into its buffer, its sinks, and its waiters. */
  const pump = (entry: TerminalEntry): void => {
    entry.handle.output.on('data', (chunk: Buffer) => {
      append(entry, chunk)
      notify(entry)
      const sinks = [...entry.attaches]
      if (sinks.length === 0) return
      // One chunk in flight per sink: a slow socket must not let the PTY queue
      // an unbounded flood inside this process. The buffer still holds the
      // chunk, so pausing loses nothing.
      entry.handle.output.pause()
      const resume = (): void => {
        if (entry.state === 'running') entry.handle.output.resume()
      }
      void Promise.all(sinks.map(sink => Promise.resolve().then(() => sink.output(chunk))))
        .then(resume, resume)
    })
    entry.handle.done.then(
      (outcome) => {
        settle(entry, sink => { sink.exit(outcome) })
      },
      (error: unknown) => {
        settle(entry, sink => { sink.fail(error) })
      },
    )
  }

  /**
   * Mark a terminal exited, report it, and release it if nobody is watching.
   *
   * A detached shell whose process exits has no browser to come back to and no
   * valve to wait on, so the entry goes with the process.
   */
  const settle = (entry: TerminalEntry, report: (sink: TerminalSink) => void): void => {
    entry.state = 'exited'
    for (const sink of entry.attaches) report(sink)
    notify(entry)
    if (entry.attaches.size === 0) void registry.kill(entry.id)
  }

  /** The entry, or a failure — for internal callers that already hold a live id. */
  const entryOf = (id: string): TerminalEntry => {
    const entry = entries.get(id)
    if (entry === undefined) throw new TerminalRegistryError(`terminal "${id}" is not open`)
    return entry
  }

  const registry: TerminalRegistry = {
    async open(sessionId, cwd, size): Promise<TerminalEntry> {
      const handle = await options.spawn({
        argv: [options.settings.shell, ...options.settings.shellArgs],
        cwd,
        env: { ...options.settings.env },
        cols: size.cols,
        rows: size.rows,
        graceMs: options.settings.graceMs,
      })
      const ordinal = nextOrdinal + 1
      nextOrdinal = ordinal
      const where = options.machine(cwd)
      const entry: TerminalEntry = {
        id: `t${String(ordinal)}`,
        label: `Terminal ${String(ordinal)}`,
        sessionId,
        machine: where.label,
        cwd: options.directory(cwd),
        handle,
        buffer: Buffer.alloc(0),
        bytes: 0,
        dropped: 0,
        state: 'running',
        cols: size.cols,
        rows: size.rows,
        attaches: new Set(),
        waiters: new Set(),
      }
      entries.set(entry.id, entry)
      pump(entry)
      return entry
    },

    attach(id, sink): TerminalEntry {
      const entry = entryOf(id)
      if (entry.state === 'exited') {
        throw new TerminalRegistryError(`terminal "${id}" has already exited`)
      }
      // A reattach ends any pending valve: the shell is watched again.
      if (entry.detachTimer !== undefined) {
        clearTimeout(entry.detachTimer)
        entry.detachTimer = undefined
      }
      if (entry.state === 'detached') entry.state = 'running'
      entry.attaches.add(sink)
      // Replay before the pump can deliver anything new: the sink is already in
      // `attaches`, but data events run after this call returns, so the retained
      // bytes reach the socket first.
      if (entry.buffer.length > 0) void sink.output(entry.buffer)
      return entry
    },

    detach(id, sink): void {
      const entry = entries.get(id)
      if (entry === undefined) return
      entry.attaches.delete(sink)
      if (entry.attaches.size > 0) return
      if (entry.state === 'exited') {
        // Nothing is left to reattach to; release it rather than leaving a
        // corpse in the table until the Session ends.
        void registry.kill(id)
        return
      }
      entry.state = 'detached'
      if (entry.detachTimer !== undefined || detachGraceMs <= 0) return
      entry.detachTimer = setTimeout(() => {
        entry.detachTimer = undefined
        void registry.kill(id)
      }, detachGraceMs)
      // A pending release must not hold the host process open.
      entry.detachTimer.unref()
    },

    async resize(id, cols, rows): Promise<boolean> {
      const entry = entryOf(id)
      entry.cols = cols
      entry.rows = rows
      // A refusal is not a failure: the browser is told the size is stale.
      return await entry.handle.resize(cols, rows).then(() => true, () => false)
    },

    listFor(sessionId): TerminalView[] {
      return [...entries.values()]
        .filter(entry => entry.sessionId === sessionId)
        .map(entry => ({
          id: entry.id,
          label: entry.label,
          cwd: entry.cwd,
          machine: entry.machine,
          pid: entry.handle.pid,
          state: entry.state,
          cols: entry.cols,
          rows: entry.rows,
        }))
    },

    requireOwned(sessionId, id): TerminalEntry {
      const mine = [...entries.values()].filter(entry => entry.sessionId === sessionId)
      if (id !== undefined) {
        const entry = mine.find(candidate => candidate.id === id)
        // A terminal another Session owns and one that does not exist are the
        // same refusal: telling them apart would report on someone else's tab.
        if (entry === undefined) {
          throw new TerminalRegistryError(
            `no terminal "${id}" is open in this session`
            + (mine.length === 0 ? '; this session has no open terminal' : `; open terminals: ${describe(mine)}`),
          )
        }
        if (entry.state === 'exited') {
          throw new TerminalRegistryError(`terminal "${id}" has already exited`)
        }
        return entry
      }
      const live = mine.filter(entry => entry.state !== 'exited')
      if (live.length === 0) {
        throw new TerminalRegistryError(mine.length === 0
          ? 'this session has no open terminal; open one in the sidebar first'
          : `every terminal in this session has exited: ${describe(mine)}`)
      }
      if (live.length > 1) {
        throw new TerminalRegistryError(
          `this session has ${String(live.length)} open terminals; `
          + `pass "terminal" with one of: ${describe(live)}`,
        )
      }
      return live[0]!
    },

    async write(id, text): Promise<number> {
      const entry = entryOf(id)
      if (entry.state === 'exited') {
        throw new TerminalRegistryError(`terminal "${id}" has already exited`)
      }
      await entry.handle.write(text)
      return Buffer.byteLength(text, 'utf8')
    },

    async keys(id, names): Promise<{ bytes: number; keys: number }> {
      const entry = entryOf(id)
      if (entry.state === 'exited') {
        throw new TerminalRegistryError(`terminal "${id}" has already exited`)
      }
      // Every name is resolved before any byte is written, so an unknown key
      // fails the whole call rather than delivering half a chord.
      const bytes = names.map((name) => {
        const sequence = KEYS[name]
        if (sequence === undefined) {
          throw new TerminalRegistryError(
            `unknown key "${name}"; known keys are ${KEY_NAMES.join(', ')}`,
          )
        }
        return sequence
      }).join('')
      await entry.handle.write(bytes)
      return { bytes: Buffer.byteLength(bytes, 'utf8'), keys: names.length }
    },

    read(id, offset, lines): TerminalRead {
      const entry = entryOf(id)
      const cap = Math.min(Math.max(Math.trunc(lines ?? DEFAULT_READ_LINES), 1), MAX_READ_LINES)
      const from = offset ?? entry.dropped
      const seen = textFrom(entry, from)
      const tail = tailLines(seen.text, cap)
      return {
        id: entry.id,
        offset: entry.bytes,
        text: tail.text,
        truncated: seen.truncated || tail.cut,
      }
    },

    async wait(id, request, signal): Promise<TerminalWait> {
      const entry = entryOf(id)
      const budget = Math.min(Math.max(Math.trunc(request.timeoutMs ?? DEFAULT_WAIT_MS), 1), MAX_WAIT_MS)
      const start = request.offset ?? retainedStart(entry)
      const test = matcher(request)
      return new Promise<TerminalWait>((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined
        const settle = (): void => {
          if (timer !== undefined) clearTimeout(timer)
          entry.waiters.delete(check)
          signal?.removeEventListener('abort', abort)
        }
        const finish = (matched: boolean, reason: TerminalWait['reason']): void => {
          settle()
          const seen = textFrom(entry, start)
          resolve({ id: entry.id, offset: entry.bytes, text: seen.text, matched, reason })
        }
        function abort(): void {
          settle()
          reject(signal?.reason instanceof Error
            ? signal.reason
            : new TerminalRegistryError('the wait was cancelled'))
        }
        function check(): void {
          if (signal?.aborted === true) {
            abort()
            return
          }
          const seen = textFrom(entry, start)
          if (test(seen.text)) {
            finish(true, 'match')
            return
          }
          if (entry.state === 'exited') finish(false, 'exit')
        }
        signal?.addEventListener('abort', abort, { once: true })
        entry.waiters.add(check)
        // The match may already be in the buffer, so the first check is
        // synchronous; only then does waiting on new output begin.
        check()
        if (entry.waiters.has(check)) {
          timer = setTimeout(() => { finish(false, 'timeout') }, budget)
        }
      })
    },

    async kill(id): Promise<boolean> {
      const entry = entries.get(id)
      if (entry === undefined) return false
      if (entry.detachTimer !== undefined) {
        clearTimeout(entry.detachTimer)
        entry.detachTimer = undefined
      }
      entries.delete(id)
      entry.attaches.clear()
      entry.state = 'exited'
      notify(entry)
      await entry.handle.terminate().catch(() => undefined)
      return true
    },

    async releaseSession(sessionId): Promise<void> {
      await Promise.all([...entries.values()]
        .filter(entry => entry.sessionId === sessionId)
        .map(entry => registry.kill(entry.id)))
    },

    async disposeAll(): Promise<void> {
      await Promise.all([...entries.keys()].map(id => registry.kill(id)))
    },
  }

  return registry
}

/** Compile a wait's matcher once, refusing a bad pattern and a missing one. */
function matcher(request: TerminalWaitRequest): (text: string) => boolean {
  const hasMatch = request.match !== undefined
  const hasRegex = request.regex !== undefined
  if (hasMatch === hasRegex) {
    throw new TerminalRegistryError(
      hasMatch ? 'pass either "match" or "regex", not both' : 'wait requires "match" or "regex"',
    )
  }
  if (hasMatch) {
    const needle = request.match!
    return text => text.includes(needle)
  }
  let expression: RegExp
  try {
    expression = new RegExp(request.regex!)
  } catch (error) {
    throw new TerminalRegistryError(
      `"regex" is not a valid pattern: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return text => expression.test(text)
}

/** The candidate list one refusal shows: id and human label. */
function describe(entries: readonly TerminalEntry[]): string {
  return entries.map(entry => `${entry.id} (${entry.label})`).join(', ')
}
