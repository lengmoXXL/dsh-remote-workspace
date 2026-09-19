/**
 * The terminal's display preferences and where they are kept.
 *
 * Font, size, line height, cursor blink, and scrollback change how a shell is
 * drawn, never how it runs, so they are this page's preference rather than a
 * host fact. They are kept beside the Session memory and published through one
 * subscription, so a change reaches every open terminal at once.
 *
 * @module dsh-remote-workspace/plugin/client/terminal/settings
 */

/** One monospace family a terminal may be drawn in. */
export interface TerminalFont {
  /** The family list the terminal is created with. */
  readonly stack: string
  /** The name a settings row offers; a font's name is not translated. */
  readonly name: string
}

/** The family a terminal is drawn in until someone chooses another. */
export const DEFAULT_TERMINAL_FONT: TerminalFont = {
  name: 'SF Mono',
  stack: "'SF Mono', Menlo, 'DejaVu Sans Mono', 'Cascadia Mono', Consolas, 'Liberation Mono', monospace",
}

/** The families a person may choose between, the default first. */
export const TERMINAL_FONTS: readonly TerminalFont[] = [
  DEFAULT_TERMINAL_FONT,
  { name: 'JetBrains Mono', stack: "'JetBrains Mono', 'SF Mono', Menlo, monospace" },
  { name: 'Fira Code', stack: "'Fira Code', 'SF Mono', Menlo, monospace" },
  { name: 'Menlo', stack: "Menlo, 'DejaVu Sans Mono', monospace" },
  { name: 'Cascadia Mono', stack: "'Cascadia Mono', Consolas, monospace" },
  { name: 'Consolas', stack: "Consolas, 'Liberation Mono', monospace" },
]

/** What one terminal is drawn with. */
export interface TerminalDisplaySettings {
  /** The family a terminal is drawn in, one of {@link TERMINAL_FONTS}. */
  readonly font: TerminalFont
  /** Cell height in pixels. */
  readonly fontSize: number
  /** Line box as a multiple of the font size. */
  readonly lineHeight: number
  /** Whether the cursor blinks while the shell waits. */
  readonly cursorBlink: boolean
  /** Lines kept in the browser, above what the host retains. */
  readonly scrollback: number
}

/** The settings a terminal starts with. */
export const TERMINAL_DEFAULTS: TerminalDisplaySettings = {
  font: DEFAULT_TERMINAL_FONT,
  fontSize: 12,
  lineHeight: 1.2,
  cursorBlink: true,
  scrollback: 50_000,
}

/** The bounds one numeric row steps between, and how far one step moves. */
export const TERMINAL_STEPS = {
  fontSize: { min: 11, max: 16, step: 1 },
  lineHeight: { min: 1, max: 1.6, step: 0.1 },
  scrollback: { min: 1_000, max: 100_000, step: 1_000 },
} as const

/** Where this page keeps the terminal's display preferences. */
const SETTINGS_KEY = 'dsh-remote-workspace.terminal.display'

let cached: TerminalDisplaySettings | undefined
const listeners = new Set<() => void>()

/**
 * One stored number, held inside its bounds.
 * @param value - what storage held, of unknown shape.
 * @param bounds - the smallest and largest value the row allows.
 * @param fallback - what to use when storage held no number.
 * @returns the value to draw with.
 */
function clampNumber(value: unknown, bounds: { min: number; max: number }, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(bounds.max, Math.max(bounds.min, value))
}

/** Read the stored preferences, or the defaults when nothing usable is stored. */
function read(): TerminalDisplaySettings {
  let stored: Partial<TerminalDisplaySettings> = {}
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw !== null) stored = JSON.parse(raw) as Partial<TerminalDisplaySettings>
  } catch {
    // Storage can be unavailable, or hold a value another build wrote; the
    // defaults are a working terminal either way.
  }
  const known = TERMINAL_FONTS.find(font => font.name === stored.font?.name)
  return {
    font: known ?? DEFAULT_TERMINAL_FONT,
    fontSize: clampNumber(stored.fontSize, TERMINAL_STEPS.fontSize, TERMINAL_DEFAULTS.fontSize),
    lineHeight: clampNumber(stored.lineHeight, TERMINAL_STEPS.lineHeight, TERMINAL_DEFAULTS.lineHeight),
    cursorBlink: typeof stored.cursorBlink === 'boolean' ? stored.cursorBlink : TERMINAL_DEFAULTS.cursorBlink,
    scrollback: clampNumber(stored.scrollback, TERMINAL_STEPS.scrollback, TERMINAL_DEFAULTS.scrollback),
  }
}

/** The preferences in force right now. */
export function terminalDisplaySettings(): TerminalDisplaySettings {
  cached ??= read()
  return cached
}

/**
 * Record one change and tell every open terminal about it.
 * @param patch - the preferences the caller changed.
 */
export function writeTerminalDisplaySettings(patch: Partial<TerminalDisplaySettings>): void {
  cached = { ...terminalDisplaySettings(), ...patch }
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(cached))
  } catch {
    // The change still applies to this page; it just will not survive a reload.
  }
  for (const listener of listeners) listener()
}

/**
 * Watch for changes, for a reader that draws with the preferences.
 * @param listener - called after every write.
 * @returns the unsubscribe function.
 */
export function subscribeTerminalDisplaySettings(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
