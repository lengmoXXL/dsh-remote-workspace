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

/** One family the browser reports from this machine's font list. */
interface LocalFontData {
  readonly family: string
}

/** The font list a browser exposes; only some of them expose one. */
interface LocalFontWindow {
  queryLocalFonts?: () => Promise<readonly LocalFontData[]>
}

/** The family every browser has, and the one a terminal falls back to. */
const GENERIC_FAMILY = 'monospace'

/**
 * Whether one family is monospace.
 *
 * The machine names its fonts but does not describe them, so the family is
 * measured: every character of a monospace family takes the same advance.
 * @param context - the canvas to measure with.
 * @param family - the family to measure.
 * @returns whether the family is monospace.
 */
function isMonospace(context: CanvasRenderingContext2D, family: string): boolean {
  const width = (glyphs: string, stack: string): number => {
    context.font = `72px ${stack}`
    return context.measureText(glyphs).width
  }
  // A family that cannot draw the probe measures as whatever it falls back to,
  // which makes every such family look monospaced: only families that draw the
  // probe themselves are judged.
  const draws = ['monospace', 'serif'].some(generic =>
    width('miW', `"${family}", ${generic}`) !== width('miW', generic))
  if (!draws) return false
  return width('iiiiiiiiii', `"${family}", monospace`)
    === width('WWWWWWWWWW', `"${family}", monospace`)
}

/**
 * Every monospace family this machine has, or undefined when it will not say.
 *
 * The list sits behind a permission, which is asked for from a gesture: a
 * refusal is reported rather than remembered, so the next open asks again.
 * @returns the family names, or undefined when the browser has none to give.
 */
async function readFamilies(): Promise<readonly string[] | undefined> {
  const query = (window as LocalFontWindow).queryLocalFonts
  const context = document.createElement('canvas').getContext('2d')
  if (query === undefined || context === null) return undefined
  try {
    const fonts = await query.call(window)
    return [...new Set(fonts.map(font => font.family))]
      .filter(family => isMonospace(context, family))
      .sort((left, right) => left.localeCompare(right))
  } catch {
    return undefined
  }
}

let reading: Promise<readonly string[] | undefined> | undefined

/** The monospace families this machine has, the generic one last. */
export async function monospaceFonts(): Promise<readonly string[]> {
  const families = await (reading ??= readFamilies())
  if (families === undefined) {
    reading = undefined
    return [GENERIC_FAMILY]
  }
  return [...families, GENERIC_FAMILY]
}

/**
 * The CSS family list one chosen family is drawn with.
 * @param family - a family this machine offers.
 * @returns the list a terminal is created with.
 */
export function fontStack(family: string): string {
  return family === GENERIC_FAMILY ? family : `"${family}", monospace`
}

/** What one terminal is drawn with. */
export interface TerminalDisplaySettings {
  /** The family a terminal is drawn in, by name; one of {@link monospaceFonts}. */
  readonly fontFamily: string
  /** Cell height in pixels. */
  readonly fontSize: number
  /** Line box as a multiple of the font size. */
  readonly lineHeight: number
  /** Whether the cursor blinks while the shell waits. */
  readonly cursorBlink: boolean
  /** Lines kept in the browser, above what the host retains. */
  readonly scrollback: number
}

/**
 * The settings a terminal starts with.
 *
 * The family is separate: nothing chosen yet means the generic one, which every
 * machine has, until the list this machine offers is read.
 */
const DEFAULTS = {
  fontSize: 12,
  lineHeight: 1.2,
  cursorBlink: true,
  scrollback: 50_000,
}

/** The bounds one numeric row steps between, and how far one step moves. */
export const TERMINAL_STEPS = {
  fontSize: { min: 11, max: 16, step: 1 },
  lineHeight: { min: 1, max: 1.6, step: 0.1 },
  scrollback: { min: 1_000, max: 100_000 },
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
  const family = stored.fontFamily
  return {
    fontFamily: typeof family === 'string' && family !== '' ? family : GENERIC_FAMILY,
    fontSize: clampNumber(stored.fontSize, TERMINAL_STEPS.fontSize, DEFAULTS.fontSize),
    lineHeight: clampNumber(stored.lineHeight, TERMINAL_STEPS.lineHeight, DEFAULTS.lineHeight),
    cursorBlink: typeof stored.cursorBlink === 'boolean' ? stored.cursorBlink : DEFAULTS.cursorBlink,
    scrollback: clampNumber(stored.scrollback, TERMINAL_STEPS.scrollback, DEFAULTS.scrollback),
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
