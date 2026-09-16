/**
 * The browser's terminals, and the sockets that carry them.
 *
 * One entry per Sidebar tab, keyed by the tab record's id, and it outlives the
 * body that draws it: the right Sidebar renders only its active tab, so
 * switching tabs unmounts the terminal's React tree, and a terminal that died
 * with its component would lose the shell every time somebody looked at a
 * different tab. Instead the xterm instance, its scrollback, its DOM element,
 * and its socket all live here, the body borrows them for as long as it is
 * mounted, and the record's own abort signal — fired when the tab is closed,
 * not when it is hidden — is what finally tears the entry down. Closing the tab
 * sends the host an explicit `close`, which ends the shell; a socket that drops
 * on its own only detaches the shell, and the id kept here is what reattaches
 * to it. Because the shell restores no tab across a reload, that id is also
 * written to `localStorage` per Session, so a terminal tab the person opens
 * again comes back to the shell it had.
 *
 * @module dsh-remote-workspace/plugin/client/terminal/session
 */

import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
// Inlined by the build, which has no stylesheet channel to emit it into.
import '@xterm/xterm/css/xterm.css'
import type { ClientFrame, HostFrame } from '../../../terminal/shared/wire.ts'
import { SOCKET_PATH } from '../../../terminal/shared/wire.ts'
import css from './TerminalSurface.module.css'

/** What the status line reports about one terminal. */
export type TerminalState =
  /** Allocated on the host, but the shell has not answered yet. */
  | { readonly kind: 'opening' }
  /** A live shell. */
  | { readonly kind: 'live'; readonly cwd: string; readonly fixedSize: boolean }
  /** The shell exited. */
  | { readonly kind: 'ended'; readonly code: number | null; readonly signal: string | null }
  /** The socket went away without the shell reporting an exit. */
  | { readonly kind: 'closed' }
  /** The host refused to allocate a shell. */
  | { readonly kind: 'failed'; readonly message: string }

/** Everything one mount of a terminal body supplies. */
export interface TerminalMount {
  /** The Sidebar tab record's id, which is the terminal's identity. */
  readonly tabId: string
  /** The Session whose workspace the shell starts in. */
  readonly sessionId: string
  /** The element the terminal is drawn into while the body is mounted. */
  readonly host: HTMLElement
  /** Aborted when the tab record disappears, and only then. */
  readonly signal: AbortSignal
  /** Receives every state change, including the ones that happen while hidden. */
  readonly onState: (state: TerminalState) => void
}

/** One live browser terminal. */
interface Entry {
  readonly tabId: string
  readonly sessionId: string
  readonly signal: AbortSignal
  readonly element: HTMLDivElement
  readonly term: Terminal
  readonly fit: FitAddon
  /** Replaced when a dropped socket is reconnected; the terminal itself stays. */
  socket: WebSocket
  readonly observer: ResizeObserver
  /**
   * The registry id and label the host assigned, once it has.
   *
   * The id is what the model addresses this shell by; the label is the tab
   * title, so two terminal tabs on screen are told apart the same way the model
   * tells them apart in a call.
   */
  id?: string | undefined
  label?: string | undefined
  /** The element the body is currently drawing into; the entry moves between them. */
  host: HTMLElement
  /** Replaced on every mount, so a remounted body receives the live state. */
  onState: (state: TerminalState) => void
  state: TerminalState
  /** The size last asked of the PTY, which is what an open frame carries. */
  size: { cols: number; rows: number }
  /** Set once a resize was refused, so the layout's staleness is explained rather than guessed at. */
  fixedSize: boolean
  /** Which frame this socket's first answer belongs to, so an attach failure falls back to open. */
  pending: 'open' | 'attach'
}

/** The monospace stack a terminal is drawn in. */
const MONO_FONT = "'SF Mono', 'Menlo', 'DejaVu Sans Mono', 'Cascadia Mono', 'Consolas', 'Liberation Mono', monospace"

/** Scrollback lines one terminal keeps in the browser. */
const SCROLLBACK_LINES = 5000

/** Where this page remembers one terminal per Session, across reloads. */
const MEMORY_KEY = 'dsh-remote-workspace.terminal'

/**
 * The terminal one Session is remembered by, or undefined when there is none.
 *
 * The shell restores no sidebar tab across a reload, so this page's own memory
 * is what lets a person reopen a terminal tab and land in the shell they had.
 * Storage can be unavailable — private mode, a disabled quota — and a missing
 * answer reads exactly like never having remembered one.
 * @param sessionId - the Session whose terminal is wanted.
 * @returns the remembered registry id, if any.
 */
function remembered(sessionId: string): string | undefined {
  try {
    const known = JSON.parse(localStorage.getItem(MEMORY_KEY) ?? '{}') as Record<string, string>
    return known[sessionId]
  } catch {
    return undefined
  }
}

/** Record one Session's terminal, or forget it when `id` is null. */
function memorize(sessionId: string, id: string | null): void {
  try {
    const known = JSON.parse(localStorage.getItem(MEMORY_KEY) ?? '{}') as Record<string, string>
    if (id === null) delete known[sessionId]
    else known[sessionId] = id
    localStorage.setItem(MEMORY_KEY, JSON.stringify(known))
  } catch {
    // Storage is unavailable; the terminal keeps working, it just cannot be
    // found again after a reload.
  }
}

/** Forget one Session's terminal, unless a newer one has replaced it. */
function forget(sessionId: string, id: string | undefined): void {
  if (id !== undefined && remembered(sessionId) === id) memorize(sessionId, null)
}

/** Every terminal this page owns, keyed by tab record id. */
const entries = new Map<string, Entry>()

/** Title seats watching for a label the host has not sent yet. */
const labelListeners = new Set<() => void>()

/** Whether the theme observer is already installed. */
let watchingTheme = false

/**
 * Subscribe to host-assigned terminal labels.
 *
 * The tab's title is drawn outside the body that owns the entry, so it needs
 * its own notification rather than the body's state callback.
 * @param listener - called after any label changes.
 * @returns the unsubscribe function.
 */
export function subscribeTerminalLabels(listener: () => void): () => void {
  labelListeners.add(listener)
  return () => { labelListeners.delete(listener) }
}

/**
 * The host-assigned label of one tab's terminal.
 * @param tabId - the Sidebar tab record's id.
 * @returns the label, or null before the host has answered with one.
 */
export function terminalLabel(tabId: string): string | null {
  return entries.get(tabId)?.label ?? null
}

/** Tell every title seat that a label changed. */
function emitLabels(): void {
  for (const listener of labelListeners) listener()
}

/**
 * Read the panel's surface colors so the terminal is drawn in the app's theme.
 * @returns an xterm theme derived from the shell's own tokens.
 */
function palette(): ITheme {
  const styles = getComputedStyle(document.body)
  const dark = document.body.hasAttribute('data-ds-dark-theme')
  const ink = dark ? '#e8e8ea' : '#232326'
  const read = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback
  return {
    background: read('--dsw-alias-bg-base', dark ? '#1b1b1c' : '#ffffff'),
    foreground: read('--dsw-alias-label-primary', ink),
    cursor: read('--dsw-alias-label-primary', ink),
    cursorAccent: read('--dsw-alias-bg-base', dark ? '#1b1b1c' : '#ffffff'),
    selectionBackground: read('--dsw-alias-interactive-bg-active', dark ? '#3c3c41' : '#d5d5db'),
  }
}

/** Redraw every terminal after the shell switches theme. */
function watchTheme(): void {
  if (watchingTheme) return
  watchingTheme = true
  new MutationObserver(() => {
    const theme = palette()
    for (const entry of entries.values()) entry.term.options.theme = theme
  }).observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
}

/** Publish a state to the mounted body, if any. */
function emit(entry: Entry, state: TerminalState): void {
  entry.state = state
  entry.onState(state)
}

/** Send one control frame, unless the socket is gone. */
function send(entry: Entry, frame: ClientFrame): void {
  if (entry.socket.readyState === WebSocket.OPEN) entry.socket.send(JSON.stringify(frame))
}

/** The socket URL for this page's origin. */
function socketUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${location.host}${SOCKET_PATH}`
}

/** Build a fresh terminal and connect its socket. */
function create(mount: TerminalMount): Entry {
  watchTheme()
  const element = document.createElement('div')
  // The local is declared beside this file; the CSS Modules indexer cannot prove it.
  element.className = css.surface!

  const term = new Terminal({
    cursorBlink: true,
    fontFamily: MONO_FONT,
    fontSize: 12,
    lineHeight: 1.2,
    scrollback: SCROLLBACK_LINES,
    macOptionIsMeta: true,
    theme: palette(),
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(element)

  const observer = new ResizeObserver(() => {
    fit.fit()
  })

  const entry: Entry = {
    tabId: mount.tabId,
    sessionId: mount.sessionId,
    signal: mount.signal,
    element,
    term,
    fit,
    socket: new WebSocket(socketUrl()),
    observer,
    host: mount.host,
    onState: mount.onState,
    // A terminal this Session already had is what a reopened tab comes back to;
    // the socket decides from the id whether to attach or to open.
    id: remembered(mount.sessionId),
    state: { kind: 'opening' },
    size: { cols: term.cols, rows: term.rows },
    fixedSize: false,
    pending: 'open',
  }

  // A size the browser measures before the socket is up is what the open frame
  // asks for; a later one is a real resize. `send` drops the frames that have
  // nowhere to go, so both paths run through the same handler.
  term.onResize(({ cols, rows }) => {
    entry.size = { cols, rows }
    send(entry, { t: 'resize', cols, rows })
  })
  term.onData((data) => {
    send(entry, { t: 'input', data })
  })
  wire(entry)

  // The record disappearing is the only thing that ends a terminal: hiding the
  // tab, switching Session, or collapsing the column all unmount the body
  // without aborting this signal.
  mount.signal.addEventListener('abort', () => {
    dispose(mount.tabId)
  }, { once: true })

  return entry
}

/**
 * Bind a socket to its entry.
 *
 * A new socket for an entry that already has an id attaches to that terminal —
 * a shell the host kept because a dropped socket is not an exit — and one
 * without an id opens a fresh terminal. An attach that fails because the entry
 * is gone falls back to opening, on the same socket.
 * @param entry - the terminal the socket belongs to.
 */
function wire(entry: Entry): void {
  const socket = entry.socket
  socket.binaryType = 'arraybuffer'

  socket.addEventListener('open', () => {
    const { cols, rows } = entry.size
    if (entry.id === undefined) {
      entry.pending = 'open'
      send(entry, { t: 'open', sessionId: entry.sessionId, cols, rows })
    } else {
      entry.pending = 'attach'
      send(entry, { t: 'attach', id: entry.id, cols, rows })
    }
  })
  socket.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.data instanceof ArrayBuffer) {
      entry.term.write(new Uint8Array(event.data))
      return
    }
    let frame: HostFrame
    try {
      frame = JSON.parse(String(event.data)) as HostFrame
    } catch {
      return
    }
    switch (frame.t) {
      case 'ready':
        entry.id = frame.id
        entry.label = frame.label
        memorize(entry.sessionId, frame.id)
        emitLabels()
        emit(entry, { kind: 'live', cwd: frame.cwd, fixedSize: entry.fixedSize })
        return
      case 'size':
        entry.fixedSize = !frame.live
        if (entry.state.kind === 'live') emit(entry, { ...entry.state, fixedSize: entry.fixedSize })
        return
      case 'exit':
        forget(entry.sessionId, entry.id)
        emit(entry, { kind: 'ended', code: frame.code, signal: frame.signal })
        return
      case 'error':
        if (entry.pending === 'attach') {
          // The host no longer has this terminal, so the id is meaningless:
          // drop it and open a fresh shell on the same socket.
          forget(entry.sessionId, entry.id)
          entry.id = undefined
          entry.label = undefined
          emitLabels()
          entry.pending = 'open'
          send(entry, { t: 'open', sessionId: entry.sessionId, cols: entry.size.cols, rows: entry.size.rows })
          return
        }
        emit(entry, { kind: 'failed', message: frame.message })
        return
      default:
        return
    }
  })
  socket.addEventListener('close', () => {
    if (entry.state.kind === 'opening' || entry.state.kind === 'live') emit(entry, { kind: 'closed' })
  })
}

/** Release one terminal: its shell, its socket, and its scrollback. */
function dispose(tabId: string): void {
  const entry = entries.get(tabId)
  if (entry === undefined) return
  entries.delete(tabId)
  forget(entry.sessionId, entry.id)
  emitLabels()
  entry.observer.disconnect()
  // A tab that closes ends its shell; the host reads this frame as a teardown
  // rather than the disconnect a dropped socket looks like.
  send(entry, { t: 'close' })
  entry.socket.close(1000, 'closed')
  entry.term.dispose()
  entry.element.remove()
}

/**
 * The state of one terminal, for a body that is about to mount.
 * @param tabId - the Sidebar tab record's id.
 * @returns the live state, or the opening state for a tab with no terminal yet.
 */
export function terminalState(tabId: string): TerminalState {
  return entries.get(tabId)?.state ?? { kind: 'opening' }
}

/**
 * Draw one tab's terminal, creating it on first mount.
 * @param mount - the tab, its Session, its element, and its lifetime.
 * @returns the detach function: the terminal survives it, the drawing does not.
 */
export function mountTerminal(mount: TerminalMount): () => void {
  const existing = entries.get(mount.tabId)
  const entry = existing ?? create(mount)
  if (existing === undefined) entries.set(mount.tabId, entry)
  entry.onState = mount.onState
  entry.host = mount.host
  mount.host.appendChild(entry.element)
  entry.observer.observe(mount.host)
  entry.fit.fit()
  entry.term.focus()
  return () => {
    entry.observer.disconnect()
    entry.element.remove()
  }
}

/**
 * Restart one terminal: reattach to it if it is still on the host, or replace
 * it with a fresh one.
 *
 * A socket that dropped is not a dead shell — the host keeps the terminal while
 * its process lives — so restarting reconnects to the id this entry already
 * knows and keeps its scrollback. A shell that exited has no id left to reach,
 * and a failed allocation has none yet, so those start over.
 * @param tabId - the Sidebar tab record's id.
 */
export function restartTerminal(tabId: string): void {
  const entry = entries.get(tabId)
  if (entry === undefined) return
  if (entry.state.kind === 'closed' && entry.id !== undefined) {
    entry.socket = new WebSocket(socketUrl())
    wire(entry)
    emit(entry, { kind: 'opening' })
    entry.fit.fit()
    entry.term.focus()
    return
  }
  const mount: TerminalMount = {
    tabId: entry.tabId,
    sessionId: entry.sessionId,
    host: entry.host,
    signal: entry.signal,
    onState: entry.onState,
  }
  dispose(tabId)
  const replacement = create(mount)
  entries.set(tabId, replacement)
  replacement.fit.fit()
  replacement.term.focus()
}
