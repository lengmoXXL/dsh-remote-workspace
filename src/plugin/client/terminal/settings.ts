/**
 * The terminal's display preferences in the browser, and where they come from.
 *
 * Font, size, line height, cursor blink, and scrollback change how a shell is
 * drawn, never how it runs. They are the plugin's own settings, so the durable
 * copy lives in the Host's user-settings document under
 * {@link TERMINAL_DISPLAY_NAMESPACE}; this module is the one place the browser
 * reads them. A scope is bound when the settings service is composed, and every
 * accepted section is published here, so the settings card and the shells never
 * disagree — including a shell drawn before the first section arrived, which
 * the subscription redraws. A page that never binds a scope still gets a
 * working terminal: it draws with the schema's defaults and keeps a change for
 * as long as the page lives.
 *
 * @module dsh-remote-workspace/plugin/client/terminal/settings
 */

import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { TERMINAL_DISPLAY_DEFAULTS, type TerminalDisplaySettings } from '../../../terminal/shared/display.ts'

/** One family the browser reports from this machine's font list. */
interface LocalFontData {
  readonly family: string
}

/** The font list a browser exposes; only some of them expose one. */
interface LocalFontWindow {
  queryLocalFonts?: () => Promise<readonly LocalFontData[]>
}

/** The family every browser has, and the one a terminal falls back to. */
const GENERIC_FAMILY = TERMINAL_DISPLAY_DEFAULTS.fontFamily

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

/** The durable scope, once the settings service is composed. */
let scope: SettingsScope<TerminalDisplaySettings> | undefined

/** The preferences in force right now. */
let cached: TerminalDisplaySettings = { ...TERMINAL_DISPLAY_DEFAULTS }

const listeners = new Set<() => void>()

/**
 * Whether two snapshots describe the same terminal.
 * @param left - one snapshot.
 * @param right - the other.
 * @returns whether every preference agrees.
 */
function same(left: TerminalDisplaySettings, right: TerminalDisplaySettings): boolean {
  return left.fontFamily === right.fontFamily
    && left.fontSize === right.fontSize
    && left.lineHeight === right.lineHeight
    && left.cursorBlink === right.cursorBlink
    && left.scrollback === right.scrollback
}

/**
 * Adopt whatever the settings document currently answers.
 *
 * A section that says what is already drawn is dropped, so the snapshot a
 * reader holds keeps its identity until a preference really moves.
 */
function adopt(): void {
  const section = scope?.getSnapshot().value
  if (section === undefined || same(section, cached)) return
  cached = section
  for (const listener of listeners) listener()
}

/**
 * Bind the durable preferences, and follow them for as long as the caller lives.
 * @param bound - the scope over this plugin's settings namespace.
 * @returns the disposer that unbinds it.
 */
export function bindTerminalDisplaySettings(bound: SettingsScope<TerminalDisplaySettings>): () => void {
  scope = bound
  const stop = bound.subscribe(adopt)
  adopt()
  return () => {
    stop()
    if (scope === bound) scope = undefined
  }
}

/** The preferences in force right now. */
export function terminalDisplaySettings(): TerminalDisplaySettings {
  return cached
}

/**
 * Record one change and tell every open terminal about it.
 * @param patch - the preferences the caller changed.
 */
export function writeTerminalDisplaySettings(patch: Partial<TerminalDisplaySettings>): void {
  const next = { ...cached, ...patch }
  if (same(next, cached)) return
  cached = next
  for (const listener of listeners) listener()
  for (const [field, value] of Object.entries(patch)) void scope?.set(field, value)
}

/**
 * Watch for changes, for a reader that draws with the preferences.
 * @param listener - called after every change.
 * @returns the unsubscribe function.
 */
export function subscribeTerminalDisplaySettings(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
