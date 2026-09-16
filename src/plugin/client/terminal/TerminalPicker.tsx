/**
 * The terminal tab's chooser: which shell this tab should show.
 *
 * The Sidebar's add control opens the Terminal entry, and the entry opens this
 * page; picking a shell is what creates a tab's first terminal. It exists
 * because a shell outlives its tab: a reload drops the tab, not the process, so
 * without a list the shell stays alive on the host and addressable by the
 * model's terminal tool while a person has no way to find it.
 *
 * A guide entry cannot express one row per live terminal — a guide entry
 * carries only static copy and opens its type by kind, with no payload a body
 * could read — so the plugin asks here instead, where it also knows the
 * Session whose terminals these are.
 *
 * The list is the host's, read through the plugin's own management route, so
 * what it offers is exactly what the model's terminal tool would address. A row
 * the page last used leads, because that is the shell a reload most likely left
 * behind; closing a row ends that shell, which is how a terminal no tab holds
 * is finally let go.
 *
 * @module dsh-remote-workspace/plugin/client/terminal/TerminalPicker
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button, IconCloseOutline16, IconWarningOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { TerminalKey } from './locales.ts'
import { lastTerminal, type TerminalTarget } from './session.ts'
import css from './TerminalPicker.module.css'

/** One terminal the host reports, as the agent's terminal tool lists it. */
export interface TerminalSummary {
  readonly id: string
  readonly label: string
  readonly cwd: string
  readonly machine: string
  readonly pid: number
  readonly state: 'running' | 'detached' | 'exited'
  readonly cols: number
  readonly rows: number
}

/** How one lifecycle state reads. */
function stateKey(state: TerminalSummary['state']): TerminalKey {
  if (state === 'running') return 'state.running'
  if (state === 'detached') return 'state.detached'
  return 'state.exited'
}

/** The message a failure carries, or a readable fallback. */
function reasonOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

/** What the chooser is driven with. */
export interface TerminalPickerProps {
  /** The Session whose terminals are offered. */
  readonly sessionId: string
  /** Read this Session's terminals from the host. */
  readonly list: (sessionId: string) => Promise<readonly TerminalSummary[]>
  /** End one terminal, wherever its tab went. */
  readonly close: (id: string) => Promise<void>
  /** Take the chosen shell; the body mounts it next. */
  readonly onChoose: (target: TerminalTarget) => void
  /** Leave without a terminal; the empty tab goes with it. */
  readonly onCancel: () => void
  readonly t: Translate<TerminalKey>
}

/** Ask which shell this terminal tab should show. */
export function TerminalPicker({ sessionId, list, close, onChoose, onCancel, t }: TerminalPickerProps): ReactNode {
  const [terminals, setTerminals] = useState<readonly TerminalSummary[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [closing, setClosing] = useState<string | undefined>(undefined)
  /** The shell this page last used, read once: it only orders the list. */
  const [last] = useState(() => lastTerminal(sessionId))

  const load = useCallback(async () => {
    try {
      setTerminals(await list(sessionId))
      setError(undefined)
    } catch (failure) {
      setError(reasonOf(failure))
    }
  }, [list, sessionId])

  useEffect(() => {
    void load()
  }, [load])

  const remove = async (id: string): Promise<void> => {
    setClosing(id)
    try {
      await close(id)
      // Re-read rather than dropping the row locally: the host is what says
      // whether the shell is really gone.
      await load()
    } catch (failure) {
      setError(reasonOf(failure))
    } finally {
      setClosing(undefined)
    }
  }

  // The likely target leads; the rest keep the host's order.
  const offered = [...(terminals ?? [])].sort((a, b) => (a.id === last ? -1 : b.id === last ? 1 : 0))

  return (
    <Modal
      open
      onClose={onCancel}
      title={t('picker.title')}
      description={t('picker.description')}
      closeLabel={t('close')}
      footer={(
        <>
          <Button onClick={onCancel}>{t('cancel')}</Button>
          <Button variant="primary" data-terminal-new onClick={() => onChoose({ kind: 'new' })}>
            {t('picker.new')}
          </Button>
        </>
      )}
    >
      <div className={css.picker} data-terminal-picker>
        {error === undefined ? null : (
          <div className={css.alert} role="alert">
            <IconWarningOutline16 />
            <span>{error}</span>
          </div>
        )}
        {terminals === undefined ? (
          <div className={css.empty}>{t('loading')}</div>
        ) : offered.length === 0 ? (
          <div className={css.empty}>{t('picker.empty')}</div>
        ) : (
          <div className={css.list}>
            {offered.map(entry => (
              <div className={css.row} key={entry.id}>
                <button
                  type="button"
                  className={css.entry}
                  data-terminal-choice={entry.id}
                  data-terminal-state={entry.state}
                  onClick={() => onChoose({ kind: 'existing', id: entry.id })}
                >
                  <span className={css.label}>{entry.label}</span>
                  <span className={css.meta}>
                    <span>{t(stateKey(entry.state))}</span>
                    <span> · {entry.machine} · </span>
                    <span className={css.path} title={entry.cwd}>{entry.cwd}</span>
                  </span>
                </button>
                <Button
                  size="sm"
                  variant="ghost"
                  data-terminal-close={entry.id}
                  aria-label={t('picker.close', { label: entry.label })}
                  title={t('picker.close', { label: entry.label })}
                  disabled={closing !== undefined}
                  onClick={() => void remove(entry.id)}
                >
                  <IconCloseOutline16 />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
