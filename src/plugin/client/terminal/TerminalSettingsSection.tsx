/**
 * The terminal's settings section.
 *
 * One page of display preferences: the font, its size and line height, whether
 * the cursor blinks, and how many lines the browser keeps. Every row writes
 * through the same preferences the terminal draws with, so a change reaches the
 * shells already open and the ones opened later alike.
 *
 * @module dsh-remote-workspace/plugin/client/terminal/TerminalSettingsSection
 */

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button, IconChevronDownOutline14, Menu, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { TerminalNamespace } from './locales.ts'
import {
  TERMINAL_STEPS,
  monospaceFonts,
  subscribeTerminalDisplaySettings,
  terminalDisplaySettings,
  writeTerminalDisplaySettings,
} from './settings.ts'
import css from './TerminalSettingsSection.module.css'

/** One numeric preference, as the section draws and steps it. */
interface StepRow {
  /** Which preference the row steps. */
  readonly key: 'fontSize' | 'lineHeight' | 'scrollback'
  /** The row's label. */
  readonly label: 'settings.fontSize' | 'settings.lineHeight' | 'settings.scrollback'
  /** How the value reads. */
  readonly show: (value: number) => string
}

/** The numeric rows, in the order they are drawn. */
const STEPS: readonly StepRow[] = [
  { key: 'fontSize', label: 'settings.fontSize', show: value => `${value} px` },
  { key: 'lineHeight', label: 'settings.lineHeight', show: value => value.toFixed(1) },
  { key: 'scrollback', label: 'settings.scrollback', show: String },
]

/** Draw the terminal's display preferences. */
export function TerminalSettingsSection({ t }: PropsLocale<TerminalNamespace>): ReactNode {
  const settings = useSyncExternalStore(subscribeTerminalDisplaySettings, terminalDisplaySettings)
  const [fontOpen, setFontOpen] = useState(false)
  const [fonts, setFonts] = useState<readonly string[] | undefined>(undefined)

  /** Read this machine's fonts; the ask is answered while the page is open. */
  const readFonts = (): void => {
    void monospaceFonts().then(setFonts)
  }
  useEffect(readFonts, [])

  /** Move one preference by a step, held inside the bounds its row documents. */
  const bump = (key: StepRow['key'], direction: number): void => {
    const bounds = TERMINAL_STEPS[key]
    const moved = settings[key] + direction * bounds.step
    const next = key === 'lineHeight' ? Math.round(moved * 10) / 10 : moved
    const held = Math.min(bounds.max, Math.max(bounds.min, next))
    writeTerminalDisplaySettings(
      key === 'fontSize'
        ? { fontSize: held }
        : key === 'lineHeight' ? { lineHeight: held } : { scrollback: held },
    )
  }

  return (
    <div className={css.section}>
      <h3 className={css.title}>{t('settings.label')}</h3>
      <div className={css.rows}>
        <div className={css.row}>
          <span className={css.label}>{t('settings.font')}</span>
          <Menu
            open={fontOpen}
            compact
            selectedId={settings.fontFamily}
            items={(fonts ?? [settings.fontFamily]).map(family => ({ id: family, label: family }))}
            onSelect={(family) => {
              setFontOpen(false)
              writeTerminalDisplaySettings({ fontFamily: family })
            }}
            onClose={() => { setFontOpen(false) }}
            anchor={(
              <Button
                size="sm"
                aria-label={t('settings.font')}
                title={t('settings.font')}
                onClick={() => {
                  setFontOpen(current => !current)
                  // The list is behind a permission, and the ask needs a gesture.
                  readFonts()
                }}
              >
                {settings.fontFamily}
                <IconChevronDownOutline14 />
              </Button>
            )}
          />
        </div>
        {STEPS.map(step => (
          <div className={css.row} key={step.key}>
            <span className={css.label}>{t(step.label)}</span>
            <span className={css.step}>
              <Button
                size="sm"
                aria-label={t('settings.decrease')}
                title={t('settings.decrease')}
                onClick={() => { bump(step.key, -1) }}
              >
                −
              </Button>
              <span className={css.value}>{step.show(settings[step.key])}</span>
              <Button
                size="sm"
                aria-label={t('settings.increase')}
                title={t('settings.increase')}
                onClick={() => { bump(step.key, 1) }}
              >
                +
              </Button>
            </span>
          </div>
        ))}
        <div className={css.row}>
          <span className={css.label}>{t('settings.cursorBlink')}</span>
          <Switch
            checked={settings.cursorBlink}
            onChange={(next) => { writeTerminalDisplaySettings({ cursorBlink: next }) }}
            label={t('settings.cursorBlink')}
          />
        </div>
      </div>
    </div>
  )
}
