/**
 * Page actions expressed in DOM terms, shared by the browser workflow test.
 *
 * Every action compiles to one `script.evaluate` on the page, so the driver
 * needs no input protocol: clicking calls the element's own `click()`, and
 * filling an input goes through the native value setter plus a bubbling
 * `input` event, which is what a React controlled field listens for.
 *
 * Dialog-scoped actions exist because the shell keeps its own chrome on screen
 * behind a modal: a bare "fill the first input" would type into the session
 * search box instead of the open form. `role="dialog"` is the primitives'
 * modal contract, and the most recently appended one is the open form.
 *
 * @module dsh-remote-workspace/tests/browser/dom
 */

import type { FirefoxPage } from './firefox.ts'

/** How long an action waits for its condition before failing. */
const DEFAULT_TIMEOUT_MS = 20_000

/** Poll interval for conditions that settle asynchronously. */
const POLL_MS = 200

/** Elements treated as clickable targets when matching by label. */
const CLICKABLE = 'button, a, [role="button"], [role="tab"], [role="menuitem"], summary'

/**
 * Page-side helpers shared by the expressions below.
 *
 * `shown` asks the browser's own visibility model rather than a rectangle test,
 * because a portaled dialog's own container can report a zero-size box.
 */
const HELPERS = `
  const patternOf = source => new RegExp(source.source, source.flags)
  const shown = el => el.checkVisibility === undefined
    ? el.getBoundingClientRect().width > 0
    : el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  const labelOf = el => (el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.textContent ?? '').trim()
  const activeDialog = () => {
    const forms = [...document.querySelectorAll('[role="dialog"][aria-label]')].filter(shown)
    return forms[forms.length - 1]
  }
`

/**
 * Click the first clickable element whose label matches.
 * @param page - the page to act on.
 * @param pattern - matched against the element's text, aria-label, and title.
 * @param nth - which match to click, from zero. Defaults to the first.
 * @returns the matched label, for diagnostics.
 * @throws when nothing matches.
 */
export async function clickByText(page: FirefoxPage, pattern: RegExp, nth = 0): Promise<string> {
  const matched = await page.evaluate<string | null>(`
    (() => {
      ${HELPERS}
      const pattern = patternOf(${JSON.stringify({ source: pattern.source, flags: pattern.flags })})
      const hits = [...document.querySelectorAll(${JSON.stringify(CLICKABLE)})]
        .filter(el => pattern.test(labelOf(el)) && shown(el) && el.disabled !== true)
      const target = hits[${String(nth)}]
      if (target === undefined) return null
      target.click()
      return labelOf(target)
    })()
  `)
  if (matched === null) throw new Error(`no clickable element matched ${String(pattern)}`)
  return matched
}

/**
 * Click the first matching control inside the open dialog.
 * @param page - the page to act on.
 * @param pattern - matched against the control's text, aria-label, and title.
 * @param nth - which match to click, from zero. Defaults to the first.
 * @returns the matched label, for diagnostics.
 * @throws when no dialog is open or nothing inside it matches.
 */
export async function clickInDialog(page: FirefoxPage, pattern: RegExp, nth = 0): Promise<string> {
  const matched = await page.evaluate<string | null>(`
    (() => {
      ${HELPERS}
      const pattern = patternOf(${JSON.stringify({ source: pattern.source, flags: pattern.flags })})
      const dialog = activeDialog()
      if (dialog === undefined) return null
      const hits = [...dialog.querySelectorAll(${JSON.stringify(CLICKABLE)})]
        .filter(el => pattern.test(labelOf(el)) && shown(el) && el.disabled !== true)
      const target = hits[${String(nth)}]
      if (target === undefined) return null
      target.click()
      return labelOf(target)
    })()
  `)
  if (matched === null) throw new Error(`no control in the open dialog matched ${String(pattern)}`)
  return matched
}

/**
 * Whether any open dialog offers a clickable control matching the pattern.
 *
 * The predicate is the one {@link clickInDialog} clicks by, so a caller can
 * wait on it without racing a control that is present but hidden or disabled.
 * @param page - the page to act on.
 * @param pattern - matched against the control's text, aria-label, and title.
 */
export async function dialogHasMatch(page: FirefoxPage, pattern: RegExp): Promise<boolean> {
  return await page.evaluate<boolean>(`
    (() => {
      ${HELPERS}
      const pattern = patternOf(${JSON.stringify({ source: pattern.source, flags: pattern.flags })})
      return [...document.querySelectorAll('[role="dialog"]')].some(dialog =>
        [...dialog.querySelectorAll(${JSON.stringify(CLICKABLE)})]
          .some(el => pattern.test(labelOf(el)) && shown(el) && el.disabled !== true))
    })()
  `)
}

/**
 * Fill one input inside the open dialog, by position among its inputs.
 * @param page - the page to act on.
 * @param index - zero-based position among the dialog's visible inputs.
 * @param value - the text to set.
 * @throws when no dialog is open or it has no input there.
 */
export async function fillDialogInput(page: FirefoxPage, index: number, value: string): Promise<void> {
  const filled = await page.evaluate<string | null>(`
    (() => {
      ${HELPERS}
      const dialog = activeDialog()
      if (dialog === undefined) return null
      const inputs = [...dialog.querySelectorAll('input')].filter(shown)
      const el = inputs[${String(index)}]
      if (el === undefined) return null
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return el.value
    })()
  `)
  if (filled === null) throw new Error(`the open dialog has no visible input at index ${String(index)}`)
}

/**
 * Fill the dialog input whose placeholder matches.
 * @param page - the page to act on.
 * @param pattern - matched against the placeholder attribute.
 * @param value - the text to set.
 * @throws when no dialog is open or nothing inside it matches.
 */
export async function fillDialogInputByPlaceholder(
  page: FirefoxPage,
  pattern: RegExp,
  value: string,
): Promise<void> {
  const filled = await page.evaluate<string | null>(`
    (() => {
      ${HELPERS}
      const pattern = patternOf(${JSON.stringify({ source: pattern.source, flags: pattern.flags })})
      const dialog = activeDialog()
      if (dialog === undefined) return null
      const el = [...dialog.querySelectorAll('input')]
        .find(input => pattern.test(input.getAttribute('placeholder') ?? '') && shown(input))
      if (el === undefined) return null
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return el.value
    })()
  `)
  if (filled === null) throw new Error(`no dialog input placeholder matched ${String(pattern)}`)
}

/**
 * Wait until an expression evaluates truthy.
 * @param page - the page to poll.
 * @param expression - boolean-valued page expression.
 * @param label - what the caller is waiting for, used in the failure.
 * @param timeoutMs - how long to keep polling.
 * @throws when the condition never holds.
 */
export async function waitFor(
  page: FirefoxPage,
  expression: string,
  label: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await page.evaluate<boolean>(expression) === true) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise<void>(resolve => { setTimeout(resolve, POLL_MS) })
  }
}

/**
 * Wait until the page's visible text contains a string.
 * @param page - the page to poll.
 * @param needle - the text to look for.
 * @param label - what the caller is waiting for, used in the failure.
 * @throws when the text never appears.
 */
export async function waitForText(page: FirefoxPage, needle: string, label: string): Promise<void> {
  await waitFor(page, `document.body.innerText.includes(${JSON.stringify(needle)})`, label)
}

/**
 * Wait until a form dialog is open, identified by its title.
 * @param page - the page to poll.
 * @param pattern - matched against the form's accessible name.
 * @param label - what the caller is waiting for, used in the failure.
 * @throws when no such form opens.
 */
export async function waitForForm(page: FirefoxPage, pattern: RegExp, label: string): Promise<void> {
  await waitFor(page, `
    (() => {
      ${HELPERS}
      const pattern = patternOf(${JSON.stringify({ source: pattern.source, flags: pattern.flags })})
      const form = activeDialog()
      return form !== undefined && pattern.test(form.getAttribute('aria-label') ?? '')
    })()
  `, label)
}

/**
 * Wait until no form dialog with a matching title is open.
 * @param page - the page to poll.
 * @param pattern - matched against the form's accessible name.
 * @param label - what the caller is waiting for, used in the failure.
 * @throws when such a form stays open.
 */
export async function waitForFormGone(page: FirefoxPage, pattern: RegExp, label: string): Promise<void> {
  await waitFor(page, `
    (() => {
      ${HELPERS}
      const pattern = patternOf(${JSON.stringify({ source: pattern.source, flags: pattern.flags })})
      const forms = [...document.querySelectorAll('[role="dialog"][aria-label]')].filter(shown)
      return !forms.some(form => pattern.test(form.getAttribute('aria-label') ?? ''))
    })()
  `, label)
}

/**
 * Wait until some matching control is enabled, so a click cannot land on a
 * control the section disabled while a mutation was in flight.
 * @param page - the page to poll.
 * @param pattern - matched against the control's text, aria-label, and title.
 * @param label - what the caller is waiting for, used in the failure.
 * @throws when nothing matching ever becomes enabled.
 */
export async function waitForEnabled(page: FirefoxPage, pattern: RegExp, label: string): Promise<void> {
  await waitFor(page, `
    (() => {
      ${HELPERS}
      const pattern = patternOf(${JSON.stringify({ source: pattern.source, flags: pattern.flags })})
      return [...document.querySelectorAll(${JSON.stringify(CLICKABLE)})]
        .some(el => pattern.test(labelOf(el)) && shown(el) && el.disabled !== true)
    })()
  `, label)
}
