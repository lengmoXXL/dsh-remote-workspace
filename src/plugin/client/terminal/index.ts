/**
 * The terminal surface of this plugin's client half.
 *
 * It contributes one right-Sidebar tab type, registered exactly the way the
 * Files panel registers its own: a page type with a guide capsule, so the
 * column's add control lists a Terminal button beside the others, and a body
 * under the same id that draws it. There is no address to claim — a terminal is
 * per Session, not per file — so the type carries no patterns and opens by
 * kind.
 *
 * The guide capsule cannot express one row per live terminal: a guide entry
 * carries static copy and opens its type by kind, with no payload a body could
 * read, and the entries are registered once rather than per shell. The body
 * therefore asks through its own chooser, which reads the host's terminal table
 * over this plugin's management route: the same table the agent's terminal tool
 * addresses, so a shell a reload or a closed tab detached is still offered — and
 * can be closed — instead of living on invisibly.
 *
 * Every Harness import here is `import type`: the browser bundle shares the
 * shell's React and its `@deepseek-ai/*` modules through the loader's `require`,
 * and a value import from anything but the primitives package would need a
 * module the loader does not hand it.
 *
 * @module dsh-remote-workspace/plugin/client/terminal
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Session standard seat (sessionId) the tab bodies receive.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: pulls the tab registry merge (ctx.sidebarRightTabs) and its seats.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { request } from '../api.ts'
import { en, NS, zh, type TerminalKey } from './locales.ts'
import { TerminalBody } from './TerminalBody.tsx'
import { type TerminalSummary } from './TerminalPicker.tsx'
import { TerminalTitle } from './TerminalTitle.tsx'
import { TerminalGlyph } from './glyphs.tsx'

/** The tab type this plugin contributes to the right Sidebar. */
const TERMINAL_KIND = 'terminal'

/** That type's implementation identity, and the key its body registers under. */
const TERMINAL_ID = 'dsh-terminal'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Terminal tab, guide, and status copy. */
    'dsh-terminal': TerminalKey
  }
}

/**
 * What the terminal body reads from the plugin's management routes: the shells
 * this Session already has, and the way to end one no tab holds.
 */
export interface TerminalPanelFace {
  /** One Session's terminals, as the agent's terminal tool lists them. */
  list(sessionId: string): Promise<readonly TerminalSummary[]>
  /** End one terminal, wherever its tab went. */
  close(id: string): Promise<void>
}

/**
 * The terminal type's static face, including the guide entry the add control
 * lists.
 * @param t - the namespace-bound translate, read fresh on every label call.
 * @returns the definition to register.
 */
function terminalDefinition(t: Translate<TerminalKey>): SidebarRightTabDefinition {
  return {
    id: TERMINAL_ID,
    kind: TERMINAL_KIND,
    priority: 'builtin',
    title: () => t('type.label'),
    guide: [{
      order: 30,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
      icon: TerminalGlyph,
    }],
  }
}

/**
 * Build the panel face over the host routes.
 * @param t - the namespace-bound translate every request failure is read through.
 * @returns the face the terminal body drives.
 */
function panelFace(t: Translate<TerminalKey>): TerminalPanelFace {
  const failure = (status: number): string => t('requestFailed', { status })
  return {
    async list(sessionId) {
      const query = new URLSearchParams({ sessionId })
      const body = await request<{ terminals: readonly TerminalSummary[] }>(
        failure, `/terminals?${query.toString()}`,
      )
      return body.terminals
    },
    async close(id) {
      await request(failure, `/terminals/${encodeURIComponent(id)}/close`, { method: 'POST' })
    },
  }
}

/**
 * Contribute the terminal tab type and the body behind it to the right Sidebar.
 * @param ctx - the client context.
 */
export function mountTerminal(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-terminal: dictionaries')
  // Bound, not called: every label is read through it at draw time, so a
  // language change needs no re-registration.
  const t = ctx.locale.bind(NS)

  ctx.effect(() => ctx.sidebarRightTabs.register(terminalDefinition(t)), 'dsh-terminal: type')
  // Stage two of the type: the body registers under the definition's id. The
  // panel face is injected rather than imported by the body, exactly as the
  // settings section receives its own.
  const face = panelFace(t)
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: TERMINAL_ID, locale: NS, inject: () => face },
    TerminalBody,
  )), 'dsh-terminal: body')
  // The title is a second seat under the same id: a shell's chip names the id
  // the model addresses it by, so two terminal tabs stay distinguishable.
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: TERMINAL_ID, locale: NS },
    TerminalTitle,
  )), 'dsh-terminal: title')
}
