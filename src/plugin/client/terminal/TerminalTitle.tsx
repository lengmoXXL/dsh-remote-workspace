/**
 * The terminal tab's chip title.
 *
 * A type with a live title registers one, which is how two terminal tabs stay
 * distinguishable: the host assigns each shell an id and a label when it opens,
 * and the chip shows the label rather than the type's static name. The body
 * owns the entry the label lives on, and switching tabs unmounts that body
 * while the entry stays, so this reads the shared store directly and before the
 * first `ready` frame falls back to the type's own name.
 *
 * @module dsh-remote-workspace/plugin/client/terminal/TerminalTitle
 */

import { useSyncExternalStore, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TerminalNamespace } from './locales.ts'
import { subscribeTerminalLabels, terminalLabel } from './session.ts'

/** The title seat's composed props: the tab seat and the terminal dictionary. */
export type TerminalTitleProps =
  & PropsRuntime<'sidebar.right.pane.tab.title'>
  & PropsLocale<TerminalNamespace>

/** Draw the terminal tab's title. */
export function TerminalTitle({ useTabInfo, sessionId, t }: TerminalTitleProps): ReactNode {
  const { tab } = useTabInfo()
  return useSyncExternalStore(subscribeTerminalLabels, () => terminalLabel(sessionId, tab.id)) ?? t('type.label')
}
