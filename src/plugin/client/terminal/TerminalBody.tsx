/**
 * The terminal tab's body.
 *
 * It owns no state a reader would recognise: the terminal, its scrollback, and
 * its socket belong to {@link mountTerminal}, which keeps them alive across the
 * mounts and unmounts this component goes through every time the strip changes
 * tab. What is left here is the frame — the measured screen and the status line
 * — plus the two things only a live body can do: measure, and offer a restart
 * once the shell is gone.
 *
 * A tab with no chosen shell yet draws the chooser instead: the entry opened
 * this page, and a shell exists only once somebody says which one. The choice
 * lives in {@link chooseTerminal}'s store rather than in this component, so
 * hiding the tab and coming back does not ask again.
 *
 * @module dsh-remote-workspace/plugin/client/terminal/TerminalBody
 */

import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { TerminalPanelFace } from './index.ts'
import type { TerminalKey, TerminalNamespace } from './locales.ts'
import {
  chooseTerminal,
  mountTerminal,
  restartTerminal,
  subscribeTerminalTargets,
  terminalState,
  terminalTarget,
  type TerminalState,
} from './session.ts'
import { TerminalPicker } from './TerminalPicker.tsx'
import css from './TerminalBody.module.css'

/** The status line's text for one state. */
function statusText(state: TerminalState, t: Translate<TerminalKey>): string {
  switch (state.kind) {
    case 'opening':
      return t('status.opening')
    case 'live':
      return state.cwd
    case 'ended':
      return state.code === null
        ? t('status.signalled', { signal: state.signal ?? '' })
        : t('status.exited', { code: state.code })
    case 'closed':
      return t('status.disconnected')
    case 'failed':
      return t('status.failed', { message: state.message })
  }
}

/**
 * The terminal tab's composed props: the tab seat, the Session identity, its
 * dictionary, and the panel routes the chooser reads through.
 */
export type TerminalBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<TerminalNamespace>
  & InjectFace<TerminalPanelFace>

/** Draw the terminal. */
export function TerminalBody({ useTabInfo, sessionId, list, close, t }: TerminalBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const target = useSyncExternalStore(subscribeTerminalTargets, () => terminalTarget(tab.id))
  const screen = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<TerminalState>(() => terminalState(tab.id))

  useLayoutEffect(() => {
    const host = screen.current
    if (host === null || target === undefined) return
    return mountTerminal({ tabId: tab.id, sessionId, host, signal: tab.signal, onState: setState, target })
  }, [tab.id, tab.signal, sessionId, target])

  if (target === undefined) {
    return (
      <TerminalPicker
        sessionId={sessionId}
        list={list}
        close={close}
        onChoose={choice => { chooseTerminal(tab.id, choice) }}
        onCancel={() => { tab.actions.close() }}
        t={t}
      />
    )
  }

  const gone = state.kind === 'ended' || state.kind === 'failed' || state.kind === 'closed'
  return (
    <div className={css.pane}>
      <div className={css.screen} ref={screen} />
      <div className={css.bar}>
        <span className={css.path} title={state.kind === 'live' ? state.cwd : undefined}>
          {statusText(state, t)}
        </span>
        {state.kind === 'live' && state.fixedSize
          ? <span className={css.note}>{t('note.fixedSize')}</span>
          : null}
        {gone
          ? (
            <Button
              className={css.action}
              size="sm"
              variant="ghost"
              onClick={() => {
                restartTerminal(tab.id)
              }}
            >
              {t('action.restart')}
            </Button>
          )
          : null}
      </div>
    </div>
  )
}
