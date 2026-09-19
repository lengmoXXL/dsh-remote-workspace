/**
 * The terminal tab's body.
 *
 * It owns no state a reader would recognise: the terminal, its scrollback, and
 * its socket belong to {@link mountTerminal}, which keeps them alive across the
 * mounts and unmounts this component goes through every time the strip changes
 * tab. What is left here is the frame — the measured screen and the status line
 * — plus the two things only a live body can do: measure, and offer a restart
 * once the shell is gone, or an explicit end through the socket it holds.
 *
 * @module dsh-remote-workspace/plugin/client/terminal/TerminalBody
 */

import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  Button,
  IconCloseOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { TerminalPanelFace } from './index.ts'
import type { TerminalKey, TerminalNamespace } from './locales.ts'
import {
  chooseTerminal,
  endTerminal,
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
export function TerminalBody(
  { useTabInfo, sessionId, list, close, openAnother, showTab, t }: TerminalBodyProps,
): ReactNode {
  const { tab } = useTabInfo()
  const target = useSyncExternalStore(subscribeTerminalTargets, () => terminalTarget(sessionId, tab.id))
  const screen = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<TerminalState>(() => terminalState(sessionId, tab.id))

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
        onChoose={choice => { chooseTerminal(sessionId, tab.id, choice) }}
        onShow={showTab}
        onCancel={() => { tab.actions.close() }}
        t={t}
      />
    )
  }

  const gone = state.kind === 'ended' || state.kind === 'failed' || state.kind === 'closed'
  // A shell still on the host can be ended; one that exited or never opened
  // has nothing left to end and offers a restart instead.
  const endable = state.kind === 'opening' || state.kind === 'live' || state.kind === 'closed'
  const end = (): void => {
    const stranded = endTerminal(sessionId, tab.id)
    // A socket that had already dropped could not carry the frame, and the
    // shell is still addressable, so the chooser's own route ends it.
    if (stranded !== undefined) void close(stranded).catch(() => undefined)
  }
  return (
    <div className={css.pane} data-terminal-session={sessionId}>
      <div className={css.bar}>
        <span className={css.path} title={state.kind === 'live' ? state.cwd : undefined}>
          {statusText(state, t)}
        </span>
        {endable
          ? (
            <Button
              className={css.action}
              size="sm"
              variant="ghost"
              icon={<IconCloseOutline16 />}
              data-terminal-end
              aria-label={t('action.end')}
              title={t('action.end')}
              onClick={end}
            />
          )
          : null}
        {state.kind === 'live' && state.fixedSize
          ? <span className={css.note}>{t('note.fixedSize')}</span>
          : null}
        {gone
          ? (
            <Button
              className={css.action}
              size="sm"
              variant="ghost"
              icon={<IconRefreshOutline16 />}
              aria-label={t('action.restart')}
              title={t('action.restart')}
              onClick={() => {
                restartTerminal(sessionId, tab.id)
              }}
            />
          )
          : null}
        <Button
          className={css.action}
          size="sm"
          variant="ghost"
          icon={<IconPlusOutline16 />}
          data-terminal-newtab
          aria-label={t('action.newTab')}
          title={t('action.newTab')}
          onClick={openAnother}
        />
      </div>
      <div className={css.screen} ref={screen} />
    </div>
  )
}
