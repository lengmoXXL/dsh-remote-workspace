/**
 * The terminal's display preferences, as the Plugins page draws them.
 *
 * The page is keyed by this bundle's package name, which is what makes it
 * appear at all: the Plugins page shows one bundle's configuration on that
 * bundle's own page. It holds the font, its size and line height, whether the
 * cursor blinks, and how many lines the browser keeps. Every row writes through
 * the same preferences the terminal draws with, so a change reaches the shells
 * already open and the ones opened later alike.
 *
 * @module dsh-remote-workspace/plugin/client/terminal/TerminalSettings
 */

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  Button,
  IconChevronDownOutline14,
  Input,
  Menu,
  Switch,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: declares the `plugins.bundle.config` slot this page fills.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { TERMINAL_DISPLAY_BOUNDS } from '../../../terminal/shared/display.ts'
import { NS } from './locales.ts'
import {
  monospaceFonts,
  subscribeTerminalDisplaySettings,
  terminalDisplaySettings,
  writeTerminalDisplaySettings,
} from './settings.ts'
import css from './TerminalSettings.module.css'

/** One preference the card steps, as it draws the row. */
interface StepRow {
  /** Which preference the row steps. */
  readonly key: 'fontSize' | 'lineHeight'
  /** The row's label. */
  readonly label: 'settings.fontSize' | 'settings.lineHeight'
  /** How the value reads. */
  readonly show: (value: number) => string
}

/** The stepped rows, in the order they are drawn. */
const STEPS: readonly StepRow[] = [
  { key: 'fontSize', label: 'settings.fontSize', show: value => `${value} px` },
  { key: 'lineHeight', label: 'settings.lineHeight', show: value => value.toFixed(1) },
]

/** Props the renderer binds for this page. */
export type TerminalSettingsProps =
  PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<typeof NS>

/**
 * Draw the terminal's display preferences.
 * @param props - the card's translate.
 * @returns the card, closed until it is opened.
 */
export function TerminalSettings(props: TerminalSettingsProps): ReactNode {
  const { t } = props
  // The preferences as they stand: the scope publishes them, this component
  // only reads the snapshot.
  const settings = useSyncExternalStore(
    subscribeTerminalDisplaySettings,
    terminalDisplaySettings,
    terminalDisplaySettings,
  )
  const [open, setOpen] = useState(false)
  const [fontOpen, setFontOpen] = useState(false)
  const [fonts, setFonts] = useState<readonly string[] | undefined>(undefined)
  // The typed row is held as text while it is edited: a person typing "50000"
  // passes through four numbers that are out of bounds.
  const [scrollback, setScrollback] = useState<string | undefined>(undefined)

  /** Read this machine's fonts; the ask is answered while the card is open. */
  const readFonts = (): void => {
    void monospaceFonts().then(setFonts)
  }
  useEffect(readFonts, [])

  /** Move one preference by a step, held inside the bounds its row documents. */
  const bump = (key: StepRow['key'], direction: number): void => {
    const bounds = TERMINAL_DISPLAY_BOUNDS[key]
    const moved = settings[key] + direction * bounds.step
    const next = key === 'lineHeight' ? Math.round(moved * 10) / 10 : moved
    const held = Math.min(bounds.max, Math.max(bounds.min, next))
    writeTerminalDisplaySettings(key === 'fontSize' ? { fontSize: held } : { lineHeight: held })
  }

  /** Keep one typed scrollback, held inside the bounds its row documents. */
  const commitScrollback = (): void => {
    const typed = (scrollback ?? '').trim()
    setScrollback(undefined)
    if (typed === '' || !Number.isFinite(Number(typed))) return
    const { min, max } = TERMINAL_DISPLAY_BOUNDS.scrollback
    writeTerminalDisplaySettings({ scrollback: Math.min(max, Math.max(min, Math.round(Number(typed)))) })
  }

  return (
    <li className={open ? `${css.card} ${css.cardOpen}` : css.card}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        onClick={() => { setOpen(current => !current) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{t('settings.title')}</span>
          <span className={css.description}>{t('settings.description')}</span>
        </span>
        <IconChevronDownOutline14 className={open ? `${css.chevron} ${css.chevronOpen}` : css.chevron} />
      </button>
      {open
        ? (
          <div className={css.body}>
            <div className={css.row}>
              <span className={css.label}>{t('settings.font')}</span>
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
              <span className={css.label}>{t('settings.scrollback')}</span>
              <Input
                className={css.number!}
                inputMode="numeric"
                aria-label={t('settings.scrollback')}
                value={scrollback ?? String(settings.scrollback)}
                onChange={(event) => { setScrollback(event.target.value) }}
                onBlur={commitScrollback}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                }}
              />
            </div>
            <div className={css.row}>
              <span className={css.label}>{t('settings.cursorBlink')}</span>
              <Switch
                checked={settings.cursorBlink}
                onChange={(next) => { writeTerminalDisplaySettings({ cursorBlink: next }) }}
                label={t('settings.cursorBlink')}
              />
            </div>
          </div>
        )
        : null}
    </li>
  )
}
