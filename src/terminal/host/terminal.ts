/**
 * One browser socket, one terminal in the shared registry.
 *
 * The bridge owns the socket's half of the correspondence: it resolves the
 * Session's workspace, asks the registry to register the shell a person just
 * opened, and forwards keystrokes, resizes, and output. The registry owns the
 * terminal itself, because the model-facing terminal tool drives the same
 * shell; this module never allocates or releases one directly.
 *
 * A tab owns its shell, but the socket is only a view of it. A socket that
 * closes without a `close` frame detaches: the registry keeps the PTY and its
 * retained output, so a reload or a dropped connection can `attach` back and
 * see the same shell for as long as it lives. The `close` frame is what a tab
 * teardown sends, and it ends the terminal at once. A shell whose process exits
 * still closes its socket and is released, and a Session ending releases its
 * terminals through the registry's own hook.
 *
 * Output is paced one chunk at a time through the sink the registry calls: a
 * command that floods the terminal pauses the PTY's output stream until the
 * socket has taken the chunk, instead of queueing the whole flood inside this
 * process.
 *
 * @module dsh-remote-workspace/terminal/host/terminal
 */

import { Buffer } from 'node:buffer'
import type { Context } from '@deepseek-ai/cordis'
import { WebSocket, type RawData } from 'ws'
import type { AttachFrame, ClientFrame, HostFrame, OpenFrame } from '../shared/wire.ts'
import type { TerminalRegistry, TerminalSink } from './registry.ts'
import { resolveWorkspace } from './workspace.ts'

/** Largest dimension a browser may ask a PTY for. */
const MAX_DIMENSION = 1000

/** Keystrokes held while a shell is still being allocated, before they are dropped. */
const MAX_PENDING_INPUT = 256

/**
 * Clamp a browser-measured dimension into something a PTY accepts.
 * @param value - the measured value.
 * @param fallback - the value to use when the measurement is not a number.
 * @returns a whole number of rows or columns in range.
 */
function dimension(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(MAX_DIMENSION, Math.max(1, Math.floor(value)))
}

/**
 * Decode one WebSocket text message.
 * @param data - the message as the server delivered it.
 * @returns its UTF-8 text.
 */
function textOf(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/**
 * Report a failure the way the browser's status line reads it.
 * @param error - the thrown value.
 * @returns its message, or its string form when it is not an Error.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Serve one terminal over one accepted socket.
 * @param ctx - the host context the workspace resolver reads.
 * @param registry - the terminals a person's tabs have open.
 * @param socket - the accepted browser socket.
 */
export function attachTerminal(ctx: Context, registry: TerminalRegistry, socket: WebSocket): void {
  let entryId: string | undefined
  let opening = false
  let closed = false
  /** The size the browser last asked for; the spawn uses it even if it changed mid-allocation. */
  let requested = { cols: 80, rows: 24 }
  /** The size the PTY actually has, so an unchanged resize is not forwarded. */
  let applied: { cols: number; rows: number } | undefined
  const typed: string[] = []

  const post = (frame: HostFrame): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame))
  }

  /**
   * The registry's view of this socket.
   *
   * Output is handed to the socket one chunk at a time and the returned promise
   * is what lets the registry pause the PTY, so a socket that cannot keep up
   * slows the shell rather than this process.
   */
  const sink: TerminalSink = {
    output(chunk): Promise<void> | void {
      if (socket.readyState !== WebSocket.OPEN) return
      return new Promise<void>((resolve) => {
        socket.send(chunk, () => { resolve() })
      })
    },
    exit(outcome): void {
      post({ t: 'exit', code: outcome.exitCode, signal: outcome.signal })
      socket.close(1000, 'terminal exited')
    },
    fail(error): void {
      post({ t: 'error', message: describe(error) })
      socket.close(1011, 'terminal failed')
    },
  }

  /** This socket went away without a `close` frame: keep the shell it was viewing. */
  const stop = (): void => {
    if (closed) return
    closed = true
    const current = entryId
    entryId = undefined
    if (current !== undefined) registry.detach(current, sink)
  }

  /** The tab closed: end its shell now instead of leaving it detached. */
  const endNow = (): void => {
    if (closed) return
    closed = true
    const current = entryId
    entryId = undefined
    if (current !== undefined) void registry.kill(current)
    socket.close(1000, 'closed')
  }

  /** Register the shell for one Session's workspace and start streaming it. */
  const open = async (frame: OpenFrame): Promise<void> => {
    if (closed) return
    if (entryId !== undefined || opening) {
      post({ t: 'error', message: 'this connection already owns a terminal' })
      return
    }
    requested = { cols: dimension(frame.cols, 80), rows: dimension(frame.rows, 24) }
    opening = true
    try {
      const cwd = await resolveWorkspace(ctx, frame.sessionId)
      const entry = await registry.open(frame.sessionId, cwd, requested)
      // The socket may have gone while the shell was being allocated; a
      // registered terminal owns its own lifetime and must be released here.
      if (closed) {
        void registry.kill(entry.id)
        return
      }
      entryId = entry.id
      applied = { ...requested }
      registry.attach(entry.id, sink)
      post({ t: 'ready', pid: entry.handle.pid, cwd, id: entry.id, label: entry.label })
      for (const data of typed.splice(0)) {
        void registry.write(entry.id, data).catch(() => undefined)
      }
    } catch (error: unknown) {
      post({ t: 'error', message: describe(error) })
    } finally {
      opening = false
    }
  }

  /** Adopt a browser-measured size, now or as the size the shell will start at. */
  const applySize = async (cols: number, rows: number): Promise<void> => {
    const next = {
      cols: dimension(cols, requested.cols),
      rows: dimension(rows, requested.rows),
    }
    requested = next
    const current = entryId
    if (current === undefined) return
    if (applied !== undefined && applied.cols === next.cols && applied.rows === next.rows) return
    applied = next
    const live = await registry.resize(current, next.cols, next.rows)
    post({ t: 'size', cols: next.cols, rows: next.rows, live })
  }

  /** Reattach this socket to a terminal it already knows by id. */
  const reattach = (frame: AttachFrame): void => {
    if (closed) return
    if (entryId !== undefined || opening) {
      post({ t: 'error', message: 'this connection already owns a terminal' })
      return
    }
    let entry
    try {
      // The registry replays the retained output to this sink before anything
      // new can arrive, so a remounted terminal shows its history in order.
      entry = registry.attach(frame.id, sink)
    } catch (error: unknown) {
      // A terminal that is gone is the browser's cue to open a fresh one.
      post({ t: 'error', message: describe(error) })
      return
    }
    entryId = entry.id
    // The PTY's own geometry is what was applied; the frame's is what the
    // browser measures now, and any difference is a real resize.
    applied = { cols: entry.cols, rows: entry.rows }
    post({ t: 'ready', pid: entry.handle.pid, cwd: entry.cwd, id: entry.id, label: entry.label })
    for (const data of typed.splice(0)) {
      void registry.write(entry.id, data).catch(() => undefined)
    }
    void applySize(frame.cols, frame.rows)
  }

  socket.on('close', stop)
  socket.on('error', stop)
  socket.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) return
    let frame: ClientFrame
    try {
      frame = JSON.parse(textOf(data)) as ClientFrame
    } catch {
      return
    }
    switch (frame.t) {
      case 'open':
        void open(frame)
        return
      case 'attach':
        reattach(frame)
        return
      case 'close':
        endNow()
        return
      case 'input': {
        const current = entryId
        if (current === undefined) {
          if (typed.length < MAX_PENDING_INPUT) typed.push(frame.data)
          return
        }
        void registry.write(current, frame.data).catch(() => undefined)
        return
      }
      case 'resize':
        void applySize(frame.cols, frame.rows)
        return
      default:
        return
    }
  })
}
