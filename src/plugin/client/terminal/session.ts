/**
 * The browser's terminals, and the sockets that carry them.
 *
 * One entry per Sidebar tab, keyed by its Session and tab record id, and it outlives the
 * body that draws it: the right Sidebar renders only its active tab, so
 * switching tabs unmounts the terminal's React tree, and a terminal that died
 * with its component would lose the shell every time somebody looked at a
 * different tab. Instead the xterm instance, its scrollback, its DOM element,
 * and its socket all live here, the body borrows them for as long as it is
 * mounted, and the record's own abort signal — fired when the tab is closed,
 * not when it is hidden — is what finally tears the entry down: it closes the
 * socket, which only detaches the shell, and the id kept here is what
 * reattaches to it. Because the shell restores no tab across a reload, that id
 * is also written to `localStorage` per Session: the chooser lists the shell
 * this page last used first, so coming back to it is one click. Ending a shell
 * is explicit and is the only thing that forgets the id — {@link endTerminal}
 * sends the `close` frame through the socket this page holds, the chooser's
 * close reaches the host route, and a shell that exits or fails to attach has
 * nothing left to come back to.
 *
 * Which shell a tab shows is decided before its first terminal exists: a tab
 * whose person has not chosen yet is shown the chooser, and {@link chooseTerminal}
 * records the answer by tab id so the body can unmount and return without
 * asking again. The choice outlives the body for the same reason the entry
 * does.
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

/** Which shell a terminal tab is bound to, once its person has chosen. */
export type TerminalTarget =
  /** Attach to a shell the host already has, by registry id. */
  | { readonly kind: 'existing'; readonly id: string }
  /** Open a fresh shell, ignoring whichever one this Session last used. */
  | { readonly kind: 'new' }

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
  /** The shell this tab shows; read only where an entry is first created. */
  readonly target: TerminalTarget
}

/** One live browser terminal. */
interface Entry {
  /** The map key: Session and tab, because tab ids are minted per Session. */
  readonly key: string
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
  /**
   * Whether an attach's retained history is still being parsed.
   *
   * The history re-runs the terminal queries the shell emitted earlier; letting
   * the terminal answer them now types the answers into a shell that is not
   * waiting for them, so they are suppressed while the replay parses.
   */
  replaying: boolean
  /** Reconnect attempts since the last live socket, for backoff. */
  reconnectAttempts: number
  /** The pending reconnect, while one is scheduled. */
  reconnectTimer?: ReturnType<typeof setTimeout> | undefined
}

/** The monospace stack a terminal is drawn in. */
const MONO_FONT = "'SF Mono', 'Menlo', 'DejaVu Sans Mono', 'Cascadia Mono', 'Consolas', 'Liberation Mono', monospace"

/** Scrollback lines one terminal keeps in the browser. */
const SCROLLBACK_LINES = 5000

/** First delay before a dropped socket is reconnected; it doubles per attempt. */
const RECONNECT_BASE_MS = 500

/** Ceiling on the reconnect delay, so a long outage is still retried promptly. */
const RECONNECT_MAX_MS = 5000

/** Where this page remembers one terminal per Session, across reloads. */
const MEMORY_KEY = 'dsh-remote-workspace.terminal'

/**
 * The terminal one Session is remembered by, or undefined when there is none.
 *
 * The shell restores no sidebar tab across a reload, so this page's own memory
 * is what names the shell a person was last in. Storage can be unavailable —
 * private mode, a disabled quota — and a missing answer reads exactly like
 * never having remembered one.
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

/**
 * The shell this page last used in one Session.
 *
 * The chooser reads it to put the likely target first; nothing attaches to it
 * on its own, because which shell a tab shows is the person's choice.
 * @param sessionId - the Session whose record is wanted.
 * @returns the remembered registry id, if any.
 */
export function lastTerminal(sessionId: string): string | undefined {
  return remembered(sessionId)
}

/** Forget one Session's terminal, unless a newer one has replaced it. */
function forget(sessionId: string, id: string | undefined): void {
  if (id !== undefined && remembered(sessionId) === id) memorize(sessionId, null)
}

/**
 * The key one Session's terminal tab is stored under.
 *
 * Tab record ids are minted per Session surface, so two Sessions can both name
 * a tab `t1`; the Session is part of the key so one can never read the other's
 * shell.
 */
function tabKey(sessionId: string, tabId: string): string {
  return `${sessionId}\u0000${tabId}`
}

/** Every terminal this page owns, keyed by Session and tab record id. */
const entries = new Map<string, Entry>()

/** Each tab's chosen shell, until that tab closes; the body may unmount and return. */
const targets = new Map<string, TerminalTarget>()

/** Bodies waiting for a tab's choice to land. */
const targetListeners = new Set<() => void>()

/** Title seats watching for a label the host has not sent yet. */
const labelListeners = new Set<() => void>()

/**
 * Record which shell one terminal tab shows.
 *
 * Called by the chooser before the tab's first terminal exists; the body then
 * mounts that shell. The choice is kept by tab id, so unmounting the body —
 * switching Sidebar tabs, collapsing the column — does not ask again.
 * @param sessionId - the Session the tab belongs to.
 * @param tabId - the Sidebar tab record's id.
 * @param target - the shell to attach to, or a fresh one.
 */
export function chooseTerminal(sessionId: string, tabId: string, target: TerminalTarget): void {
  targets.set(tabKey(sessionId, tabId), target)
  for (const listener of targetListeners) listener()
}

/**
 * One tab's chosen shell.
 * @param sessionId - the Session the tab belongs to.
 * @param tabId - the Sidebar tab record's id.
 * @returns the choice, or undefined while the tab is still unchosen.
 */
export function terminalTarget(sessionId: string, tabId: string): TerminalTarget | undefined {
  return targets.get(tabKey(sessionId, tabId))
}

/**
 * Subscribe to terminal choices.
 * @param listener - called after any tab's choice lands.
 * @returns the unsubscribe function.
 */
export function subscribeTerminalTargets(listener: () => void): () => void {
  targetListeners.add(listener)
  return () => { targetListeners.delete(listener) }
}

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
 * @param sessionId - the Session the tab belongs to.
 * @param tabId - the Sidebar tab record's id.
 * @returns the label, or null before the host has answered with one.
 */
export function terminalLabel(sessionId: string, tabId: string): string | null {
  return entries.get(tabKey(sessionId, tabId))?.label ?? null
}

/**
 * The tab currently showing one terminal, if any.
 *
 * Derived from the entries rather than kept as a second map, so it cannot
 * drift: an entry knows its shell's id from the moment it is created, and a
 * closed tab or an ended shell takes its entry with it.
 * @param sessionId - the Session to look in.
 * @param id - the terminal's registry id.
 * @returns the tab id drawing that shell, or undefined while no tab in this Session does.
 */
export function terminalTab(sessionId: string, id: string): string | undefined {
  for (const entry of entries.values()) {
    if (entry.sessionId === sessionId && entry.id === id) return entry.tabId
  }
  return undefined
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
    key: tabKey(mount.sessionId, mount.tabId),
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
    // The chooser's answer decides the first frame: an existing id attaches to
    // a shell the host kept, and a fresh one opens without consulting the last
    // terminal this Session used.
    id: mount.target.kind === 'existing' ? mount.target.id : undefined,
    state: { kind: 'opening' },
    size: { cols: term.cols, rows: term.rows },
    fixedSize: false,
    pending: 'open',
    replaying: false,
    reconnectAttempts: 0,
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

  // The record disappearing tears the drawing down, not the shell: hiding the
  // tab, switching Session, or collapsing the column all unmount the body
  // without aborting this signal, and closing the tab aborts it — the socket
  // closes, the host detaches, and the shell keeps running.
  mount.signal.addEventListener('abort', () => {
    dispose(tabKey(mount.sessionId, mount.tabId))
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
      entry.replaying = false
      send(entry, { t: 'open', sessionId: entry.sessionId, cols, rows })
    } else {
      entry.pending = 'attach'
      entry.replaying = true
      send(entry, { t: 'attach', sessionId: entry.sessionId, id: entry.id, cols, rows })
    }
  })
  socket.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.data instanceof ArrayBuffer) {
      const chunk = new Uint8Array(event.data)
      if (!entry.replaying) {
        entry.term.write(chunk)
        return
      }
      // The host replays the retained history before it answers `ready`, so the
      // first binary frame of an attach is that history. Suppress the terminal's
      // own replies for as long as it parses, so they cannot reach the PTY.
      entry.replaying = false
      entry.term.options.disableStdin = true
      entry.term.write(chunk, () => { entry.term.options.disableStdin = false })
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
        // No history arrived, so there is nothing left to suppress.
        entry.replaying = false
        entry.reconnectAttempts = 0
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
          entry.replaying = false
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
    // An ended or failed shell has nothing to come back to; a dropped socket
    // does, because the host keeps the terminal while its process lives.
    if (entry.state.kind === 'ended' || entry.state.kind === 'failed') return
    emit(entry, { kind: 'closed' })
    scheduleReconnect(entry)
  })
}

/**
 * Reconnect one entry's dropped socket, if it still belongs to this page.
 *
 * The shell outlives the socket, so the entry reattaches to the id it holds and
 * keeps its scrollback. Attempts back off so an unreachable host does not become
 * a busy loop.
 * @param entry - the terminal whose socket dropped.
 */
function scheduleReconnect(entry: Entry): void {
  if (entries.get(entry.key) !== entry || entry.reconnectTimer !== undefined) return
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** entry.reconnectAttempts, RECONNECT_MAX_MS)
  entry.reconnectTimer = setTimeout(() => {
    entry.reconnectTimer = undefined
    if (entries.get(entry.key) !== entry) return
    entry.reconnectAttempts += 1
    entry.socket = new WebSocket(socketUrl())
    wire(entry)
    emit(entry, { kind: 'opening' })
  }, delay)
}

/**
 * Let this page's terminal go: its socket and its scrollback, not its shell.
 *
 * The socket close is what detaches: the host keeps the PTY and its retained
 * output, so the id is still remembered for a reattach. Ending the shell is
 * explicit — {@link endTerminal} — or the process doing it on its own.
 * @param key - the Session-and-tab key to drop.
 */
function dispose(key: string): void {
  const entry = entries.get(key)
  // The tab is gone whether or not a shell ever existed for it; a choice made
  // for it must not outlive it.
  targets.delete(key)
  if (entry === undefined) return
  entries.delete(key)
  emitLabels()
  if (entry.reconnectTimer !== undefined) clearTimeout(entry.reconnectTimer)
  entry.observer.disconnect()
  // No `close` frame: closing the socket only detaches, and the host keeps the
  // shell for as long as its process lives.
  entry.socket.close(1000, 'detached')
  entry.term.dispose()
  entry.element.remove()
}

/**
 * End one tab's terminal now, through the socket this page already holds.
 *
 * The `close` frame is what ends a shell at once, rather than leaving it
 * detached the way a dropped socket does. The tab stays open: clearing its
 * choice sends the body back to the chooser, where another shell can be picked.
 * A socket that has already dropped cannot carry the frame, so the registry id
 * comes back for the caller to end through the host's route.
 * @param sessionId - the Session the tab belongs to.
 * @param tabId - the Sidebar tab record's id.
 * @returns the registry id a caller must end over the host route, when the socket could not carry the frame.
 */
export function endTerminal(sessionId: string, tabId: string): string | undefined {
  const entry = entries.get(tabKey(sessionId, tabId))
  let stranded: string | undefined
  if (entry?.id !== undefined) {
    forget(entry.sessionId, entry.id)
    if (entry.socket.readyState === WebSocket.OPEN) send(entry, { t: 'close' })
    else stranded = entry.id
  }
  dispose(tabKey(sessionId, tabId))
  // The choice is gone, so every body on this tab draws the chooser again.
  for (const listener of targetListeners) listener()
  return stranded
}

/**
 * The state of one terminal, for a body that is about to mount.
 * @param sessionId - the Session the tab belongs to.
 * @param tabId - the Sidebar tab record's id.
 * @returns the live state, or the opening state for a tab with no terminal yet.
 */
export function terminalState(sessionId: string, tabId: string): TerminalState {
  return entries.get(tabKey(sessionId, tabId))?.state ?? { kind: 'opening' }
}

/**
 * Draw one tab's terminal, creating it on first mount.
 * @param mount - the tab, its Session, its element, and its lifetime.
 * @returns the detach function: the terminal survives it, the drawing does not.
 */
export function mountTerminal(mount: TerminalMount): () => void {
  const key = tabKey(mount.sessionId, mount.tabId)
  const existing = entries.get(key)
  const entry = existing ?? create(mount)
  if (existing === undefined) entries.set(key, entry)
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
 * @param sessionId - the Session the tab belongs to.
 * @param tabId - the Sidebar tab record's id.
 */
export function restartTerminal(sessionId: string, tabId: string): void {
  const entry = entries.get(tabKey(sessionId, tabId))
  if (entry === undefined) return
  if (entry.reconnectTimer !== undefined) {
    clearTimeout(entry.reconnectTimer)
    entry.reconnectTimer = undefined
  }
  if (entry.state.kind === 'closed' && entry.id !== undefined) {
    entry.reconnectAttempts = 0
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
    // The shell this tab had is gone, whatever it was: a restart opens a fresh
    // one rather than attaching to an id the host may already have released.
    target: { kind: 'new' },
  }
  dispose(tabKey(sessionId, tabId))
  const replacement = create(mount)
  entries.set(tabKey(sessionId, tabId), replacement)
  replacement.fit.fit()
  replacement.term.focus()
}
