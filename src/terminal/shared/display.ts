/**
 * The terminal's display preferences, named once for both halves.
 *
 * The preferences are the plugin's own settings: they live in the Host's
 * user-settings document, under the namespace below, and the browser half draws
 * them as this plugin's card in the Plugins settings page. Nothing here depends
 * on either half's runtime, so the Host can build its schema from the same
 * bounds the browser steps between.
 *
 * @module dsh-remote-workspace/terminal/shared/display
 */

/** Settings namespace the terminal's display preferences are stored under. */
export const TERMINAL_DISPLAY_NAMESPACE = 'dsh-remote-workspace'

/** What one terminal is drawn with. */
export interface TerminalDisplaySettings {
  /** The family a terminal is drawn in, by name; one of `monospaceFonts`. */
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
 * The preferences in force before one is chosen.
 *
 * The family is the generic one, which every machine has, until the list this
 * machine offers is read.
 */
export const TERMINAL_DISPLAY_DEFAULTS: TerminalDisplaySettings = {
  fontFamily: 'monospace',
  fontSize: 12,
  // One line box per cell. The renderer draws the font's own box-drawing
  // glyphs, which fill the line box and nothing more, so a taller cell parts
  // every vertical run — a tree's guides, a window's frame — into dashes.
  lineHeight: 1,
  cursorBlink: true,
  scrollback: 50_000,
}

/** The bounds one numeric row steps between, and how far one step moves. */
export const TERMINAL_DISPLAY_BOUNDS = {
  fontSize: { min: 11, max: 16, step: 1 },
  lineHeight: { min: 1, max: 1.6, step: 0.1 },
  scrollback: { min: 1_000, max: 100_000, step: 1 },
} as const
