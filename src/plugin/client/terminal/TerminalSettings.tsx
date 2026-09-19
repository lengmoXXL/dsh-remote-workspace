/**
 * The terminal's display settings, as the plugin's settings page draws them.
 *
 * The font, its size and line height, whether the cursor blinks, and how many
 * lines the browser keeps. Every row writes through the same preferences the
 * terminal draws with, so a change reaches the shells already open and the ones
 * opened later alike.
 *
 * @module dsh-remote-workspace/plugin/client/terminal/TerminalSettings
 */

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button, IconChevronDownOutline14, Input, Menu, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { T } from '../Section.tsx'
import {
  TERMINAL_STEPS,
  monospaceFonts,
  subscribeTerminalDisplaySettings,
  terminalDisplaySettings,
  writeTerminalDisplaySettings,
} from './settings.ts'
import css from './TerminalSettings.module.css'

/** One preference the section steps, as it draws the row. */
interface StepRow {
  /** Which preference the row steps. */
  readonly key: 'fontSize' | 'lineHeight'
  /** The row's label. */
  readonly label: 'terminalFontSize' | 'terminalLineHeight'
  /** How the value reads. */
  readonly show: (value: number) => string
}

/** The stepped rows, in the order they are drawn. */
const STEPS: readonly StepRow[] = [
  { key: 'fontSize', label: 'terminalFontSize', show: value => `${value} px` },
  { key: 'lineHeight', label: 'terminalLineHeight', show: value => value.toFixed(1) },
]

/**
 * Draw the terminal's display preferences.
 * @param t - the settings section's translate.
 * @returns the block, ready to sit under the machine tree.
 */
export function TerminalSettings({ t }: { t: T }): ReactNode {
  // The stored preferences answer the server snapshot as well as the live one.
  const settings = useSyncExternalStore(
    subscribeTerminalDisplaySettings,
    terminalDisplaySettings,
    terminalDisplaySettings,
  )
  const [fontOpen, setFontOpen] = useState(false)
  const [fonts, setFonts] = useState<readonly string[] | undefined>(undefined)
  // The typed rows are held as text while they are edited: a person typing
  // "50000" passes through four numbers that are out of bounds.
  const [scrollback, setScrollback] = useState<string | undefined>(undefined)

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

  /** Keep one typed scrollback, held inside the bounds its row documents. */
  const commitScrollback = (): void => {
    const typed = (scrollback ?? '').trim()
    setScrollback(undefined)
    if (typed === '' || !Number.isFinite(Number(typed))) return
    const { min, max } = TERMINAL_STEPS.scrollback
    writeTerminalDisplaySettings({ scrollback: Math.min(max, Math.max(min, Math.round(Number(typed)))) })
  }

  return (
    <div className={css.settings}>
      <h3 className={css.title}>{t('terminal')}</h3>
      <div className={css.rows}>
        <div className={css.row}>
          <span className={css.label}>{t('terminalFont')}</span>
          <Menu
            open={fontOpen}
            compact
            // Fixed to the viewport and capped there: a list this long must
            // scroll itself rather than stretch the settings page.
            portal
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
                aria-label={t('terminalFont')}
                title={t('terminalFont')}
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
                aria-label={t('decrease')}
                title={t('decrease')}
                onClick={() => { bump(step.key, -1) }}
              >
                −
              </Button>
              <span className={css.value}>{step.show(settings[step.key])}</span>
              <Button
                size="sm"
                aria-label={t('increase')}
                title={t('increase')}
                onClick={() => { bump(step.key, 1) }}
              >
                +
              </Button>
            </span>
          </div>
        ))}
        <div className={css.row}>
          <span className={css.label}>{t('terminalScrollback')}</span>
          <Input
            className={css.number!}
            inputMode="numeric"
            aria-label={t('terminalScrollback')}
            value={scrollback ?? String(settings.scrollback)}
            onChange={(event) => { setScrollback(event.target.value) }}
            onBlur={commitScrollback}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
          />
        </div>
        <div className={css.row}>
          <span className={css.label}>{t('terminalCursorBlink')}</span>
          <Switch
            checked={settings.cursorBlink}
            onChange={(next) => { writeTerminalDisplaySettings({ cursorBlink: next }) }}
            label={t('terminalCursorBlink')}
          />
        </div>
      </div>
    </div>
  )
}
