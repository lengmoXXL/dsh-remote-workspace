/**
 * The terminal's display preferences as a Host settings namespace.
 *
 * Registering the namespace is what lets the browser half bind a scope to it
 * and what makes the plugin's card appear in the Plugins settings page: the
 * page dispatches cards by namespace, and a namespace nobody registered is a
 * card nobody sees. Every field carries its default, so a document that has
 * never held one still describes a working terminal.
 *
 * @module dsh-remote-workspace/terminal/host/display
 */

import z from '@deepseek-ai/schemastery'
import {
  TERMINAL_DISPLAY_BOUNDS,
  TERMINAL_DISPLAY_DEFAULTS,
  type TerminalDisplaySettings,
} from '../shared/display.ts'

const { fontSize, lineHeight, scrollback } = TERMINAL_DISPLAY_BOUNDS

/** Durable display schema; also the wire envelope the browser scope validates against. */
export const TerminalDisplaySchema: z<TerminalDisplaySettings> = z.object({
  fontFamily: z.string().default(TERMINAL_DISPLAY_DEFAULTS.fontFamily),
  fontSize: z.number().step(fontSize.step).min(fontSize.min).max(fontSize.max)
    .default(TERMINAL_DISPLAY_DEFAULTS.fontSize),
  lineHeight: z.number().step(lineHeight.step).min(lineHeight.min).max(lineHeight.max)
    .default(TERMINAL_DISPLAY_DEFAULTS.lineHeight),
  cursorBlink: z.boolean().default(TERMINAL_DISPLAY_DEFAULTS.cursorBlink),
  scrollback: z.number().step(scrollback.step).min(scrollback.min).max(scrollback.max)
    .default(TERMINAL_DISPLAY_DEFAULTS.scrollback),
})
