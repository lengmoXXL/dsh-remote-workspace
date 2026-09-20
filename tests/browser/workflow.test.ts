/**
 * The management loop, driven through Firefox against a live deployment.
 *
 * The test boots a disposable DSH instance that loads this plugin, opens the
 * shell in the Firefox installed on this machine, and walks the path an
 * operator walks: add a machine, connect it, register a repository on it, cut a
 * worktree, remove it again, and open a terminal tab.
 *
 * No model is involved anywhere: the deployment carries no credentials, and
 * every surface reached here — the settings section, the management routes, the
 * daemon, and the terminal tab — answers without an LLM call. Every step is
 * asserted twice where it matters — once from the page and once from the state
 * it was supposed to change (the management API, the anchor directory on disk,
 * the git repository on the machine) — so a UI that renders without acting
 * fails the test.
 *
 * Screenshots land in the instance's artifact directory and their paths are
 * printed when the run ends.
 *
 * Run: npm run test:browser
 *
 * Environment: `RWT_HEADED=1` shows the browser window instead of running
 * headless, `RWT_KEEP=1` retains the scratch deployment after stopping it,
 * `RWT_LEAVE=1` leaves the deployment running and prints its URL so an operator
 * can open the very instance the test booted, `RWT_DSH_CHECKOUT` points at a
 * different harness checkout, and `RWT_FIREFOX_BIN` at a different browser
 * binary.
 *
 * @module dsh-remote-workspace/tests/browser/workflow
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { en, zh } from '../../src/plugin/client/locales.ts'
import { en as terminalEn, zh as terminalZh } from '../../src/plugin/client/terminal/locales.ts'
import {
  clickByText,
  clickInDialog,
  dialogHasMatch,
  fillDialogInput,
  fillDialogInputByPlaceholder,
  waitFor,
  waitForEnabled,
  waitForForm,
  waitForFormGone,
  waitForText,
} from './dom.ts'
import { launchFirefox, type FirefoxPage } from './firefox.ts'
import { startInstance, type E2eInstance } from './instance.ts'
import { SOCKET_PATH } from '../../src/terminal/shared/wire.ts'
import { ptyUnavailable } from '../tty.ts'

const run = promisify(execFile)

/** A locale key both dictionaries carry. */
type Key = keyof typeof en

/** Escape a literal string for a regular expression. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A pattern matching the label of one control in either language. */
function anyOf(...keys: Key[]): RegExp {
  return new RegExp(keys.flatMap(key => [zh[key], en[key]]).map(escape).join('|'), 'i')
}

/** A pattern matching the whole label, so `remove` cannot match `remove machine`. */
function exact(...keys: Key[]): RegExp {
  return new RegExp(`^(?:${keys.flatMap(key => [zh[key], en[key]]).map(escape).join('|')})$`, 'i')
}

/** The accessible name one row's own control carries, which is the row-scoped action. */
function controlFor(name: string, key: Key): RegExp {
  const prefix = [zh[key], en[key]].map(escape).join('|')
  return new RegExp(`^(?:${prefix}): ${escape(name)}$`, 'i')
}

/** The shell's own Plugins navigation label, which this plugin's dictionaries do not own. */
const PLUGINS_NAV = /^(?:插件|Plugins)$/

/**
 * A pattern matching one label of the terminal card in either language.
 * @param key - the card's dictionary key.
 * @param whole - whether the label is the whole accessible name; the card's own
 * name shares its header label with the description under it.
 */
function cardLabel(key: keyof typeof terminalEn, whole = true): RegExp {
  const labels = `${terminalZh[key]}|${terminalEn[key]}`
  return new RegExp(whole ? `^(?:${labels})$` : `(?:${labels})`)
}

/** An expression that holds when any of these labels is on screen. */
function present(...keys: Key[]): string {
  const needles = keys.flatMap(key => [zh[key], en[key]]).map(text => JSON.stringify(text)).join(',')
  return `[${needles}].some(text => document.body.innerText.includes(text))`
}

/**
 * Open one object's actions menu.
 * @param page - the page to act on.
 * @param name - the object whose row carries the menu.
 */
async function openMenu(page: FirefoxPage, name: string): Promise<void> {
  await waitForEnabled(page, controlFor(name, 'actions'), `the actions menu of ${name}`)
  await clickByText(page, controlFor(name, 'actions'))
  await waitFor(page, `document.querySelector('[role="menu"]') !== null`, 'the menu to open')
}

/** Close whichever menu is open, the way an outside pointer would. */
async function closeMenu(page: FirefoxPage): Promise<void> {
  await page.evaluate(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
  await waitFor(page, `document.querySelector('[role="menu"]') === null`, 'the menu to close')
}

/**
 * Run one action from the menu of the object whose row carries this name.
 * @param page - the page to act on.
 * @param name - the object whose row carries the menu.
 * @param key - the action's locale key.
 */
async function chooseAction(page: FirefoxPage, name: string, key: Key): Promise<void> {
  await openMenu(page, name)
  await waitForEnabled(page, exact(key), `the ${key} action`)
  await clickByText(page, exact(key))
}

/**
 * An expression that holds when every one of these labels has a control.
 *
 * A row's controls are read by their words, their hover text, or their name for
 * assistive technology, because an icon-only control carries no visible label.
 */
function controlsFor(...keys: Key[]): string {
  return keys.map(key => {
    const pair = [zh[key], en[key]].map(text => JSON.stringify(text)).join(',')
    return `[${pair}].some(label => [...document.querySelectorAll('button')]`
      + `.some(button => (button.textContent ?? '').trim() === label || button.title === label`
      + ` || button.getAttribute('aria-label') === label))`
  }).join(' && ')
}

/**
 * Click one row's own control, once it is there to be clicked.
 *
 * A control is refused while its row is not actionable — a directory that is
 * not a repository yet — or disabled while a mutation is in flight, so the
 * click waits for the state rather than assuming it.
 * @param page - the page to act on.
 * @param name - the row the control belongs to.
 * @param key - the action's locale key.
 */
async function clickRowControl(page: FirefoxPage, name: string, key: Key): Promise<void> {
  await waitForEnabled(page, controlFor(name, key), `the ${key} control of ${name}`)
  await clickByText(page, controlFor(name, key))
}

/**
 * Wait until one row's menu offers every named action.
 *
 * Reading a menu across separate page calls races its own close, so each
 * attempt opens it, reads its items at once, and closes it again.
 * @param page - the page to act on.
 * @param name - the object whose row carries the menu.
 * @param keys - the locale keys the menu must offer.
 */
async function waitForRowActions(page: FirefoxPage, name: string, keys: readonly Key[]): Promise<void> {
  const wanted = keys.map(key => [zh[key], en[key]] as const)
  const expression = '[...(document.querySelector(\'[role="menu"]\')?.querySelectorAll(\'button\') ?? [])]'
    + '.map(b => (b.textContent ?? \'\').trim())'
  const deadline = Date.now() + 20_000
  for (;;) {
    await openMenu(page, name)
    const items = await page.evaluate<readonly string[]>(expression)
    await closeMenu(page)
    if (wanted.every(pair => pair.some(text => items.includes(text)))) return
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + keys.join(', ') + ' on ' + name)
    await new Promise<void>(resolve => { setTimeout(resolve, 200) })
  }
}

/** The open form's controls and path field, which the picker is driven with. */
const FORM_PARTS = `
  const dialogs = [...document.querySelectorAll('[role="dialog"][aria-label]')]
  const dialog = dialogs[dialogs.length - 1]
  const field = dialog === undefined ? undefined : [...dialog.querySelectorAll('input')]
    .find(input => (input.getAttribute('placeholder') ?? '') === ${JSON.stringify(en.placeholderRepoPath)})
  const controls = dialog === undefined
    ? []
    : [...dialog.querySelectorAll('button')].map(button => (button.textContent ?? '').trim())
`

/**
 * An expression that holds when the open form's directory picker lists one
 * directory and not another, which is what a narrowed suggestion list is.
 */
function pickerShows(offered: string, absent: string): string {
  return `
    (() => {
      ${FORM_PARTS}
      return controls.includes(${JSON.stringify(offered)}) && !controls.includes(${JSON.stringify(absent)})
    })()
  `
}

/** An expression that holds when the open form's path field reads exactly one path. */
function pathFieldIs(path: string): string {
  return `
    (() => {
      ${FORM_PARTS}
      return field !== undefined && field.value === ${JSON.stringify(path)}
    })()
  `
}

/**
 * Dismiss the shell's own onboarding and beta notice until none is open.
 *
 * Clicking through them is safe: they carry no plugin state, and while one is
 * open the shell traps focus, which would keep keyboard input out of the
 * composer.
 * @param page - the page to clear.
 */
async function clearShellDialogs(page: FirefoxPage): Promise<void> {
  // The settings panel is itself a dialog, so what marks an overlay is the skip
  // control inside it, not the dialog role.
  for (let attempt = 0; attempt < 15; attempt++) {
    if (!await dialogHasMatch(page, SKIP_SHELL_DIALOG)) return
    await clickByText(page, SKIP_SHELL_DIALOG)
    await delay(300)
  }
  if (await dialogHasMatch(page, SKIP_SHELL_DIALOG)) {
    throw new Error('the shell dialogs did not close')
  }
}

/** Wait for a bounded interval. */
async function delay(ms: number): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(resolve, ms) })
}

/** Poll a path's existence until the predicate holds. */
async function waitForPath(path: string, expected: 'present' | 'absent', timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const exists = await stat(path).then(() => true, () => false)
    if (exists === (expected === 'present')) return
    if (Date.now() > deadline) throw new Error(`${path} was never ${expected}`)
    await delay(200)
  }
}

/** Poll the Host's settings document until it says one thing. */
async function waitForSettings(instance: E2eInstance, pattern: RegExp): Promise<void> {
  const path = join(instance.home, 'settings.yaml')
  const deadline = Date.now() + 20_000
  for (;;) {
    const text = await readFile(path, 'utf8').catch(() => '')
    if (pattern.test(text)) return
    if (Date.now() > deadline) throw new Error(`${path} never matched ${String(pattern)}: ${text}`)
    await delay(200)
  }
}

/** Read the management API. */
async function api<T>(instance: E2eInstance, path: string): Promise<T> {
  const response = await fetch(`${instance.apiBase}${path}`)
  assert.equal(response.ok, true, `${path} answered ${String(response.status)}`)
  return await response.json() as T
}

/** Poll the reported connection state of one machine. */
async function waitForState(instance: E2eInstance, state: string): Promise<void> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const listing = await api<{ statuses: readonly { nodeId: string; state: string }[] }>(instance, '/nodes')
    if (listing.statuses.some(entry => entry.nodeId === instance.nodeId && entry.state === state)) return
    if (Date.now() > deadline) {
      throw new Error(`machine never reported ${state}: ${JSON.stringify(listing.statuses)}`)
    }
    await delay(250)
  }
}

/** List the worktrees git knows in a repository. */
async function gitWorktrees(repoPath: string): Promise<string> {
  const { stdout } = await run('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'])
  return stdout
}

/** List the branches git knows in a repository, by name. */
async function gitBranches(repoPath: string, pattern: string): Promise<string> {
  const { stdout } = await run('git', ['-C', repoPath, 'branch', '--list', '--format=%(refname:short)', pattern])
  return stdout.trim()
}

/**
 * Wait for a branch to disappear.
 *
 * The anchor is dropped before the optional branch delete runs, so a removal
 * that also takes the branch reports its end earlier than git does.
 */
async function waitForBranchGone(repoPath: string, branch: string): Promise<void> {
  const deadline = Date.now() + 20_000
  for (;;) {
    if (await gitBranches(repoPath, branch) === '') return
    if (Date.now() > deadline) throw new Error(`branch ${branch} was never deleted`)
    await delay(200)
  }
}

/**
 * Run git in a fixture, retrying while another process holds the index lock.
 *
 * A directory that was opened as a workspace is read by the shell as well —
 * describing a workspace asks git about it — and a reader refreshes the index,
 * which takes the lock this fixture's own write needs. Losing that race is the
 * environment's timing, not the plugin's behaviour, so the fixture waits it out.
 * @param cwd - the fixture directory to run in.
 * @param args - the git arguments.
 * @throws the git failure when it is not the lock, or the lock never clears.
 */
async function gitLocked(cwd: string, args: readonly string[]): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await run('git', [...args], { cwd })
      return
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? '')
      if (attempt >= 10 || !stderr.includes('index.lock')) throw error
      await delay(200)
    }
  }
}

/** The shell's own onboarding and notice buttons, which trap focus while open. */
const SKIP_SHELL_DIALOG = /^(?:稍后配置|Configure later|继续|Continue)$/i

/** The chip title the host assigns a terminal, which carries its registry id. */
const TERMINAL_TITLE = /^Terminal \d+$/

/** Page-side reader for the right Sidebar's tab chip titles. */
const CHIP_TITLES = `[...document.querySelectorAll('[data-dockkit-tab-title]')].map(el => (el.textContent ?? '').trim())`

/** Page-side reader for the active strip chip's title. */
const ACTIVE_CHIP_TITLE = `(() => {
  const chip = [...document.querySelectorAll('[data-dockkit-tab]')]
    .find(el => el.getAttribute('aria-selected') === 'true')
  return (chip?.querySelector('[data-dockkit-tab-title]')?.textContent ?? '').trim()
})()`

/** Page-side reader for the plugin client's per-Session terminal memory. */
const TERMINAL_MEMORY = `JSON.parse(localStorage.getItem('dsh-remote-workspace.terminal') ?? '{}')`

/** Page-side reader for the terminal chooser's rows, in the order it shows them. */
const PICKER_ROWS = `[...document.querySelectorAll('[data-terminal-choice]')]`
  + `.map(el => el.getAttribute('data-terminal-choice'))`

/** Page-side reader for one chooser row's reported lifecycle state. */
function pickerState(id: string): string {
  return `document.querySelector('[data-terminal-choice="${id}"]')`
    + `?.getAttribute('data-terminal-state') ?? null`
}

/** An expression that holds while one chooser row carries its already-open badge. */
function pickerOpened(id: string): string {
  return `document.querySelector('[data-terminal-choice="${id}"] [data-terminal-opened]') !== null`
}

/**
 * Open one Workspace as a Session, which is the only place a terminal can live.
 *
 * The right Sidebar is Session-scoped: the shell renders neither its strip nor
 * the control that reveals it until a Conversation is selected, so with no
 * Session open there is no column to put a terminal in. Everything above only
 * manages worktrees and never opened one, so this clicks the workspace row's
 * own new-session control — the affordance an operator uses — and waits for the
 * Session's right Sidebar to mount.
 * @param page - the page to act on.
 * @param workspace - the Workspace's own label, exactly as its row shows it.
 */
async function openWorkspaceSession(page: FirefoxPage, workspace: string): Promise<void> {
  const control = `[...document.querySelectorAll('button[aria-label]')].find(button => {\n`
    + `  const label = button.getAttribute('aria-label') ?? ''\n`
    + `  return /新建会话|new session/i.test(label) && label.includes(${JSON.stringify(workspace)})\n`
    + `})`
  await waitFor(page, `${control} !== undefined`, "the workspace's new-session control")
  // Opening a Session can raise the shell's own key notice, which is modal and
  // would sit between the pointer and everything below it.
  await clearShellDialogs(page)
  await page.evaluate(`${control}.click()`)
  // The panel element is present whenever the Session's right Sidebar is
  // mounted, expanded or collapsed, so it is what tells "no Session" apart from
  // "Session with the column closed".
  await waitFor(page, `document.querySelector('[data-sidebar-right-panel]') !== null`, 'the Session right Sidebar')
}

/**
 * Reload the shell, as a person does, and clear whatever notice it raises on a
 * fresh page.
 * @param page - the page to act on.
 * @param instance - the deployment whose URL is reloaded.
 */
async function reload(page: FirefoxPage, instance: E2eInstance): Promise<void> {
  await page.navigate(instance.pageUrl)
  await waitFor(page, 'document.readyState === "complete"', 'the document after the reload')
  await waitFor(page, 'document.body.innerText.length > 40', 'the shell after the reload')
  // The shell decides on its own notices a beat after the first paint, so the
  // first clear can beat them. Waiting for the workspace list it must render
  // anyway is what makes the second clear land after them.
  await clearShellDialogs(page)
  await waitFor(
    page,
    `document.body.innerText.includes('here · local-repo · Local')`,
    'the workspace list after the reload',
  )
  await clearShellDialogs(page)
}

/**
 * Open the terminal chooser from the strip's add control.
 *
 * The Terminal entry no longer opens a shell by itself: it opens the page, and
 * the page asks which shell to show. A pane already holding the guide shows the
 * entry without the add control, so both paths are taken.
 * @param page - the page to act on.
 */
async function openTerminalChooser(page: FirefoxPage): Promise<void> {
  // A shell notice left over from opening the Session is modal, so it goes
  // before anything here is clicked.
  await clearShellDialogs(page)
  // The seat belongs to a Session that is on screen: wait for it rather than
  // checking once, because it mounts a beat after the Session opens.
  await waitFor(
    page,
    `document.querySelector('[data-sidebar-right-panel]') !== null`
      + ` || document.querySelector('[data-dockkit-add-tab]') !== null`
      + ` || document.querySelector('[data-sidebar-right-guide-entry="terminal"]') !== null`,
    'the right Sidebar seat',
  )
  // A collapsed panel hides its whole strip behind the conversation header's
  // expand button.
  if (await page.evaluate<boolean>(`document.querySelector('[data-sidebar-right-expand]') !== null`)) {
    await page.evaluate(`document.querySelector('[data-sidebar-right-expand]').click()`)
  }
  await waitFor(
    page,
    `document.querySelector('[data-dockkit-add-tab]') !== null`
      + ` || document.querySelector('[data-sidebar-right-guide-entry="terminal"]') !== null`,
    'the right Sidebar strip',
  )
  if (await page.evaluate<boolean>(`document.querySelector('[data-sidebar-right-guide-entry="terminal"]') === null`)) {
    await page.evaluate(`document.querySelector('[data-dockkit-add-tab]').click()`)
  }
  await waitFor(
    page,
    `document.querySelector('[data-sidebar-right-guide-entry="terminal"]') !== null`,
    'the terminal entry in the guide',
  )
  await page.evaluate(`document.querySelector('[data-sidebar-right-guide-entry="terminal"]').click()`)
  await waitFor(page, `document.querySelector('[data-terminal-picker]') !== null`, 'the terminal chooser')
}

/**
 * Wait for the host to register the chosen shell and report its chip title.
 * @param page - the page to act on.
 * @returns the chip title, which carries the terminal's registry id.
 */
async function waitForTerminalChip(page: FirefoxPage): Promise<string> {
  // The chip only carries a number once the host has registered the shell and
  // answered the socket, so this waits for a live terminal, not just a tab.
  const titlePattern = JSON.stringify(TERMINAL_TITLE.source)
  await waitFor(page, `${CHIP_TITLES}.some(title => new RegExp(${titlePattern}).test(title))`, 'a terminal chip')
  return await page.evaluate<string>(`
    (() => {
      const pattern = new RegExp(${titlePattern})
      const title = ${CHIP_TITLES}.find(candidate => pattern.test(candidate))
      return title ?? ''
    })()`)
}

/**
 * Wait for the active tab's chip to name the shell the host assigned it.
 * @param page - the page to act on.
 * @returns the chip title, which carries the terminal's registry id.
 */
async function waitForActiveTerminalChip(page: FirefoxPage): Promise<string> {
  const titlePattern = JSON.stringify(TERMINAL_TITLE.source)
  await waitFor(page, `new RegExp(${titlePattern}).test(${ACTIVE_CHIP_TITLE})`, 'the active terminal chip')
  return await page.evaluate<string>(ACTIVE_CHIP_TITLE)
}

/**
 * Open one terminal through the chooser.
 *
 * @param page - the page to act on.
 * @param choose - the existing terminal to attach to, or a fresh shell.
 * @returns the host-assigned chip title, which names the terminal's id.
 */
async function openTerminal(page: FirefoxPage, choose: { readonly id: string } | 'new'): Promise<string> {
  await openTerminalChooser(page)
  // The chooser is a dialog of its own, so a shell notice that arrived after it
  // is what a clear here finds; the chooser's buttons carry no skip label and
  // are left alone.
  await clearShellDialogs(page)
  if (choose === 'new') {
    await page.evaluate(`document.querySelector('[data-terminal-new]').click()`)
  } else {
    const row = `document.querySelector('[data-terminal-choice="${choose.id}"]')`
    await waitFor(page, `${row} !== null`, `the ${choose.id} row in the chooser`)
    await page.evaluate(`${row}.click()`)
  }
  return await waitForTerminalChip(page)
}

/**
 * Press the panel's Manage terminals control, which adds a shell-less tab
 * beside the one in view and leaves it on its own chooser.
 * @param page - the page to act on.
 */
async function openAnotherTerminal(page: FirefoxPage): Promise<void> {
  await clearShellDialogs(page)
  await waitFor(page, `document.querySelector('[data-terminal-manage]') !== null`, 'the Manage terminals control')
  await page.evaluate(`document.querySelector('[data-terminal-manage]').click()`)
  await waitFor(page, `document.querySelector('[data-terminal-picker]') !== null`, 'the new tab chooser')
}

/**
 * Close one right-Sidebar tab through its own close control.
 * @param page - the page to act on.
 * @param title - the exact chip title to close.
 */
async function closeTabByTitle(page: FirefoxPage, title: string): Promise<void> {
  const closed = await page.evaluate<boolean>(`
    (() => {
      const chip = [...document.querySelectorAll('[data-dockkit-tab]')].find(el =>
        (el.querySelector('[data-dockkit-tab-title]')?.textContent ?? '').trim() === ${JSON.stringify(title)})
      if (chip === null || chip === undefined) return false
      const id = chip.getAttribute('data-dockkit-tab')
      const control = document.querySelector('[data-dockkit-tab-close="' + CSS.escape(id) + '"]')
      if (control === null) return false
      control.click()
      return true
    })()`)
  assert.equal(closed, true, `no close control for the ${title} chip`)
  await waitFor(
    page,
    `!${CHIP_TITLES}.some(candidate => candidate === ${JSON.stringify(title)})`,
    'the terminal chip to close',
  )
}

/**
 * Focus one right-Sidebar tab through its own chip.
 * @param page - the page to act on.
 * @param title - the exact chip title to focus.
 */
async function clickTabByTitle(page: FirefoxPage, title: string): Promise<void> {
  const clicked = await page.evaluate<boolean>(`
    (() => {
      const chip = [...document.querySelectorAll('[data-dockkit-tab]')].find(el =>
        (el.querySelector('[data-dockkit-tab-title]')?.textContent ?? '').trim() === ${JSON.stringify(title)})
      if (chip === null || chip === undefined) return false
      chip.click()
      return true
    })()`)
  assert.equal(clicked, true, `no chip for the ${title} tab`)
}

/** Page-side reader for the mounted terminal's visible screen text. */
const TERMINAL_TEXT = `(() => {
  const rows = document.querySelector('.xterm-rows')
  return rows === null ? '' : rows.innerText
})()`

/**
 * Type literal text into the mounted terminal, as a person would.
 *
 * The terminal focuses its hidden helper textarea when it mounts; focusing it
 * again makes the keystrokes land there rather than on whatever the shell
 * focused last.
 * @param page - the page to act on.
 * @param text - the characters to type, no newlines.
 */
async function typeInTerminal(page: FirefoxPage, text: string): Promise<void> {
  await page.evaluate(`(() => {
    const field = document.querySelector('.xterm-helper-textarea')
    if (field !== null) field.focus()
    return field !== null
  })()`)
  await page.type(text)
}

/**
 * Attach to one terminal by id the way the plugin's client does, then read the
 * marker back through the shell.
 *
 * The page's own WebSocket takes the exact host path a reopened tab takes:
 * attach replays the retained output and the same shell answers. A case that
 * expects the attach to fail reads the error instead, which is how a closed
 * tab's terminal is proven gone.
 * @param page - the page to act on.
 * @param id - the registry id to attach to.
 * @returns the ready frame, everything the socket received, and any error.
 */
async function attachAndRead(page: FirefoxPage, id: string): Promise<{
  readonly ready: { readonly id: string; readonly label: string; readonly cwd: string } | null
  readonly output: string
  readonly error: string | null
}> {
  return await page.evaluate(`
    new Promise((resolve) => {
      const socket = new WebSocket('ws://' + location.host + ${JSON.stringify(SOCKET_PATH)})
      socket.binaryType = 'arraybuffer'
      const decoder = new TextDecoder()
      let output = ''
      let ready = null
      let asked = false
      const finish = (error) => {
        clearTimeout(timer)
        try { socket.close() } catch {}
        resolve({ ready, output, error: error ?? null })
      }
      const timer = setTimeout(() => finish('timed out waiting for the marker'), 30000)
      // The Session is read from the mounted tab, the way the plugin's own
      // client knows it: an attach outside the owning Session is refused.
      const session = document.querySelector('[data-terminal-session]')?.getAttribute('data-terminal-session') ?? ''
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ t: 'attach', sessionId: session, id: ${JSON.stringify(id)}, cols: 80, rows: 24 }))
      })
      socket.addEventListener('message', (event) => {
        if (event.data instanceof ArrayBuffer) {
          output += decoder.decode(new Uint8Array(event.data))
          if (asked && output.includes('probe=42')) finish(null)
          return
        }
        let frame
        try { frame = JSON.parse(String(event.data)) } catch { return }
        if (frame.t === 'ready') {
          ready = frame
          asked = true
          socket.send(JSON.stringify({ t: 'input', data: 'echo probe=$DRW_PROBE\\r' }))
          return
        }
        if (frame.t === 'error') finish(frame.message)
      })
      socket.addEventListener('close', () => finish('the socket closed before the marker arrived'))
    })
  `)
}

test('a remote worktree is created and removed through the browser', { timeout: 300_000 }, async (t) => {
  // Nothing is created until the guard is in place: a deployment that is built
  // outside `try` would survive a thrown test and keep two processes alive.
  let deployment: E2eInstance | undefined
  let browser: FirefoxPage | undefined
  let failure: unknown
  try {
    const instance = await startInstance()
    const page = await launchFirefox({ headed: process.env['RWT_HEADED'] === '1' })
    deployment = instance
    browser = page
    const shot = async (name: string): Promise<void> => {
      // The shell can raise its own onboarding late enough to land on top of a
      // picture, so every capture starts by clearing it. Only the shell's own
      // buttons match, so this plugin's open forms are left alone.
      await clearShellDialogs(page)
      await page.screenshot(join(instance.artifacts, `${name}.png`))
    }

    // The shell, then this plugin's section.
    await page.navigate(instance.pageUrl)
    await waitFor(page, 'document.readyState === "complete"', 'the document')
    await waitFor(page, 'document.body.innerText.length > 40', 'the shell to render')
    // A fresh DSH home opens on the shell's own onboarding — the model setup
    // dialog, then the beta notice. They trap focus while open and can render a
    // beat after the shell does, so clear them before anything that needs focus.
    await clearShellDialogs(page);
    await clickByText(page, /设置|Settings/i)
    await clearShellDialogs(page)
    await clickByText(page, anyOf('title'))
    await waitFor(page, controlsFor('addMachine', 'refresh'), 'the section toolbar')
    await waitForText(page, 'e2e daemon', 'the seeded machine row')
    await shot('01-section')

    // The terminal's display preferences are this plugin's own settings, so the
    // Plugins settings section draws them as the tab this plugin contributes. A
    // row writes into the Host's settings document — which is what the next page
    // load reads back — so the check follows the value there rather than
    // trusting the label that moved on screen.
    await clickByText(page, PLUGINS_NAV)
    await waitForText(page, terminalZh['settings.title'], 'the terminal card')
    await clickByText(page, cardLabel('settings.title', false))
    await waitForText(page, terminalZh['settings.fontSize'], 'the card rows')
    await shot('01b-terminal-card')
    await clickByText(page, cardLabel('settings.increase'))
    await waitForText(page, '13 px', 'the font size to step')
    await waitForSettings(instance, /dsh-remote-workspace:\n\s+fontSize: 13/)

    // Back to this plugin's own section: the workflow below is managed there.
    await clickByText(page, anyOf('title'))
    await waitFor(page, controlsFor('addMachine', 'refresh'), 'the section toolbar')

    // Add a machine through the form; the host stores it under its own id.
    // The form asks for the SSH destination, two optional SSH fields, the
    // token, and an optional title — there is no port, because the agent
    // publishes the one it bound.
    await clickByText(page, exact('addMachine'))
    await waitForForm(page, exact('addMachine'), 'the add-machine form')
    await fillDialogInput(page, 0, 'e2e@127.0.0.1')
    await fillDialogInput(page, 3, 'unused-token')
    await waitForEnabled(page, exact('create'), 'the form to accept a submission')
    await clickInDialog(page, exact('create'))
    await waitForFormGone(page, exact('addMachine'), 'the add-machine form to close')
    await waitForText(page, 'e2e@127.0.0.1', 'the machine row the form created')
    const afterAdd = await api<{ nodes: readonly { title: string }[] }>(instance, '/nodes')
    assert.ok(
      afterAdd.nodes.some(node => node.title === 'e2e@127.0.0.1'),
      'the machine reached the registry',
    )
    await shot('02-machine-added')

    // The seeded machine connects itself: the plugin brings every configured
    // machine up once it loads, so the section shows a live one with no click.
    // Opening the row is still what reveals the repository controls.
    await waitForState(instance, 'ready')
    await clickByText(page, /e2e daemon/)
    await waitFor(page, present('status.ready'), 'the machine to report itself connected')
    await waitForEnabled(page, controlFor('e2e daemon', 'actions'), 'the machine actions menu to settle')
    await shot('03-connected')

    // Register the fixture repository. The path field drives the picker while
    // it is typed: a half-typed name narrows the list to what answers it, and a
    // clicked row descends into itself and lands in the field.
    //
    // A collapsed machine renders no controls, so this machine's repository
    // form is the only one on the page: the built-in local machine, which is
    // listed first, is still folded.
    await clickRowControl(page, 'e2e daemon', 'addRepository')
    await waitForForm(page, exact('addRepository'), 'the add-repository form')
    await shot('04-repository-form')
    await fillDialogInputByPlaceholder(
      page, new RegExp(escape(en.placeholderRepoPath)), `${dirname(instance.repoPath)}/demo`,
    )
    await waitFor(page, pickerShows('demo-repo', 'plain-dir'), 'the list to narrow to the typed prefix')
    await shot('04b-picker-narrowed')
    await clickInDialog(page, /^demo-repo$/)
    await waitFor(page, pathFieldIs(instance.repoPath), 'the clicked directory to reach the path field')
    await waitForEnabled(page, exact('create'), 'the form to accept the repository')
    await clickInDialog(page, exact('create'))
    await waitForFormGone(page, exact('addRepository'), 'the add-repository form to close')
    await waitForText(page, 'demo-repo', 'the repository row')
    const repos = await api<{ repos: readonly { repo: { repoPath: string; name: string } }[] }>(
      instance, '/repos',
    )
    assert.ok(
      repos.repos.some(report => report.repo.repoPath === instance.repoPath),
      'the repository reached the store',
    )
    await shot('05-repository-registered')

    // Cut a worktree and check the machine actually holds it.
    await clickRowControl(page, 'demo-repo', 'newWorktree')
    await waitForForm(page, exact('newWorktree'), 'the new-worktree form')
    // The path field is filled from the start: the name finishes it, so an
    // empty name already shows the directory the checkout goes into.
    const checkoutRoot = join(instance.userHome, '.dsh', 'worktrees', 'demo-repo')
    await waitFor(
      page,
      `[...document.querySelectorAll('[role="dialog"][aria-label] input')]`
      + `.some(input => input.value === ${JSON.stringify(`${checkoutRoot}/`)})`,
      'the checkout directory to be filled in before the name',
    )
    await fillDialogInputByPlaceholder(page, new RegExp(escape(en.placeholderWorktreeName)), 'verify')
    await waitFor(
      page,
      `[...document.querySelectorAll('[role="dialog"][aria-label] input')]`
      + `.some(input => input.value === ${JSON.stringify(join(checkoutRoot, 'verify'))})`,
      'the name to finish the default path',
    )
    await waitForEnabled(page, exact('create'), 'the form to accept the worktree')
    await clickInDialog(page, exact('create'))
    await waitForFormGone(page, exact('newWorktree'), 'the new-worktree form to close')
    await waitForText(page, 'verify', 'the worktree row')
    // Cutting a worktree opens its workspace, so the row offers closing it and
    // the menu deletes the checkout.
    await waitForEnabled(page, controlFor('verify', 'closeWorktree'), 'the row to offer closing its workspace')
    await waitForRowActions(page, 'verify', ['removeWorktree'])
    const anchor = join(
      instance.home, 'remote-worktrees', 'anchors', instance.nodeId, 'demo-repo', 'verify',
    )
    const metadata = join(anchor, '.dsh-remote-worktree.json')
    await waitForPath(metadata, 'present')
    const record = JSON.parse(await readFile(metadata, 'utf8')) as
      { anchor: { branch: string; remoteRoot: string; repoPath: string } }
    assert.equal(record.anchor.branch, 'worktree/verify')
    assert.equal(record.anchor.repoPath, instance.repoPath)
    assert.ok(
      (await gitWorktrees(instance.repoPath)).includes('worktree/verify'),
      'git on the machine lists the new checkout',
    )
    assert.ok(
      (await readFile(join(instance.userHome, '.dsh', 'worktrees', 'demo-repo', 'verify', 'README.md'), 'utf8'))
        .includes('fixture'),
      'the checkout carries the repository content',
    )
    await shot('06-worktree-created')

    // Remove it again, through the confirmation the operator sees. The branch
    // option stays off, so the checkout goes and the branch stays put.
    await chooseAction(page, 'verify', 'removeWorktree')
    await waitForForm(page, anyOf('removeWorktreeTitle'), 'the confirmation')
    await clickInDialog(page, exact('remove'))
    await waitForPath(metadata, 'absent')
    assert.ok(!(await gitWorktrees(instance.repoPath)).includes('worktree/verify'), 'the checkout is gone')
    assert.equal(
      await gitBranches(instance.repoPath, 'worktree/verify'),
      'worktree/verify',
      'the branch outlives the checkout by default',
    )
    // Git still lists other checkouts the fixture made, and those are rows
    // now; only the records this plugin holds have to be gone.
    assert.equal(
      (await api<{ worktrees: readonly { held: boolean }[] }>(instance, '/worktrees')).worktrees
        .filter(row => row.held).length,
      0,
      'the anchor store is empty again',
    )
    // The workspace entry goes with the anchor, so the sidebar cannot keep a
    // dead row pointing at a checkout that is no longer on the machine.
    await waitFor(page, `!document.body.innerText.includes('verify')`, 'the sidebar to drop the workspace')
    await shot('07-worktree-removed')

    // The same control, with the option switched on, takes the branch too. This
    // one is placed by hand: the field arrives holding the default the host
    // would use, and the caller may replace it.
    await clickRowControl(page, 'demo-repo', 'newWorktree')
    await waitForForm(page, exact('newWorktree'), 'the second new-worktree form')
    await fillDialogInputByPlaceholder(page, new RegExp(escape(en.placeholderWorktreeName)), 'scratch')
    const defaultCheckout = join(instance.userHome, '.dsh', 'worktrees', 'demo-repo', 'scratch')
    await waitFor(
      page,
      `[...document.querySelectorAll('[role="dialog"][aria-label] input')]`
      + `.some(input => input.value === ${JSON.stringify(defaultCheckout)})`,
      'the default checkout path to be filled in',
    )
    const customCheckout = join(instance.userHome, 'custom-scratch')
    await fillDialogInput(page, 1, customCheckout)
    await waitForEnabled(page, exact('create'), 'the form to accept the second worktree')
    await clickInDialog(page, exact('create'))
    await waitForFormGone(page, exact('newWorktree'), 'the second new-worktree form to close')
    const scratch = join(
      instance.home, 'remote-worktrees', 'anchors', instance.nodeId, 'demo-repo', 'scratch',
    )
    await waitForPath(join(scratch, '.dsh-remote-worktree.json'), 'present')
    assert.match(
      await readFile(join(customCheckout, 'README.md'), 'utf8'),
      /fixture/,
      'the checkout landed where the caller placed it',
    )

    await chooseAction(page, 'scratch', 'removeWorktree')
    await waitForForm(page, anyOf('removeWorktreeTitle'), 'the second confirmation')
    await clickInDialog(page, anyOf('removeWorktreeBranch'))
    await clickInDialog(page, exact('remove'))
    await waitForPath(join(scratch, '.dsh-remote-worktree.json'), 'absent')
    // A checkout the plugin placed itself is removable wherever it stands,
    // which is what separates it from one adopted from the machine.
    await waitForPath(customCheckout, 'absent')
    await waitForBranchGone(instance.repoPath, 'worktree/scratch')
    await waitFor(page, `!document.body.innerText.includes('scratch')`, 'the sidebar to drop the second workspace')

    // A checkout the plugin never cut is a row already, read straight from the
    // machine's git; opening it adopts it and registers it as a workspace.
    await clickRowControl(page, 'hand-cut', 'openWorktree')
    await waitFor(page, `document.body.innerText.includes('hand-cut · demo-repo')`, 'the adopted workspace')
    // A checkout the plugin found is the operator's to remove as well.
    await waitForEnabled(page, controlFor('hand-cut', 'closeWorktree'), 'the row to offer closing its workspace')
    await waitForRowActions(page, 'hand-cut', ['removeWorktree'])
    await shot('07b-adopted-worktree')

    await chooseAction(page, 'hand-cut', 'removeWorktree')
    await waitForForm(page, anyOf('removeWorktreeTitle'), 'the remove confirmation')
    await clickInDialog(page, exact('remove'))
    await waitFor(page, `!document.body.innerText.includes('hand-cut')`, 'the deleted row to go')
    await waitForPath(join(instance.root, 'remote-root', 'hand-cut'), 'absent')

    // A directory nobody initialized registers, opens as a workspace of its
    // own, and refuses worktrees until someone makes it a repository.
    await clickRowControl(page, 'e2e daemon', 'addRepository')
    await waitForForm(page, exact('addRepository'), 'the add-repository form for the plain directory')
    await fillDialogInputByPlaceholder(page, new RegExp(escape(en.placeholderRepoPath)), instance.plainDir)
    await waitForEnabled(page, exact('create'), 'the form to accept the plain directory')
    await clickInDialog(page, exact('create'))
    await waitForFormGone(page, exact('addRepository'), 'the add-repository form to close')
    await waitForText(page, 'plain-dir', 'the plain directory row')
    // Only the repository registered first can be cut from: the plain
    // directory's control is refused rather than hidden.
    assert.equal(
      await page.evaluate<boolean>(`
        (() => {
          const needles = ${JSON.stringify([zh.newWorktree, en.newWorktree])}
          const control = [...document.querySelectorAll('button')].find(button =>
            needles.some(needle => (button.getAttribute('aria-label') ?? '').startsWith(needle + ': plain-dir')))
          return control !== undefined && control.disabled
        })()`),
      true,
      'the plain directory refuses a worktree',
    )
    await shot('08-plain-directory')

    // Opening it as a workspace asks the machine for the path and nothing else.
    await clickRowControl(page, 'plain-dir', 'openWorktree')
    const plainAnchor = join(
      instance.home, 'remote-worktrees', 'anchors', instance.nodeId, 'plain-dir', '.self',
    )
    await waitForPath(join(plainAnchor, '.dsh-remote-worktree.json'), 'present')
    const opened = await api<{ worktrees: readonly { anchor: { kind: string; remoteRoot: string } }[] }>(
      instance, '/worktrees',
    )
    assert.ok(
      opened.worktrees.some(entry =>
        entry.anchor.kind === 'directory' && entry.anchor.remoteRoot === instance.plainDir),
      'the directory is open as a workspace on itself',
    )

    // Initializing it on the machine is all it takes: the next read offers
    // worktrees again, and the record is the one that was already there.
    await run('git', ['-c', 'init.defaultBranch=main', 'init'], { cwd: instance.plainDir })
    await gitLocked(instance.plainDir, [
      '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'add', '.',
    ])
    await gitLocked(instance.plainDir, [
      '-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false',
      'commit', '-m', 'initial',
    ])
    await clickByText(page, exact('refresh'))
    await shot('09-directory-initialized')

    await clickRowControl(page, 'plain-dir', 'newWorktree')
    await waitForForm(page, exact('newWorktree'), 'the initialized directory form')
    await fillDialogInputByPlaceholder(page, new RegExp(escape(en.placeholderWorktreeName)), 'plain')
    await waitForEnabled(page, exact('create'), 'the form to accept the worktree')
    await clickInDialog(page, exact('create'))
    await waitForFormGone(page, exact('newWorktree'), 'the initialized directory form to close')
    assert.ok(
      (await readFile(join(instance.userHome, '.dsh', 'worktrees', 'plain-dir', 'plain', 'notes.md'), 'utf8'))
        .includes('plain'),
      'the directory that was not a repository now holds a checkout',
    )

    // This host is a machine like any other, and it needs nothing installed to
    // be one: the same form registers a repository here, and the same controls
    // cut a worktree from it. What differs is only that the checkout is a real
    // directory rather than a stand-in this plugin routes through.
    // The local machine's title is the row to click, and it leads the section:
    // once open, its controls are the first of their kind on the page.
    await clickByText(page, /^Local/)
    await clickRowControl(page, 'Local', 'addRepository')
    await waitForForm(page, exact('addRepository'), 'the add-repository form for this host')
    await fillDialogInputByPlaceholder(page, new RegExp(escape(en.placeholderRepoPath)), instance.localRepo)
    await waitForEnabled(page, exact('create'), "the form to accept this host's repository")
    await clickInDialog(page, exact('create'))
    await waitForFormGone(page, exact('addRepository'), 'the add-repository form to close')
    await waitForText(page, 'local-repo', 'the local repository row')
    const localRepos = await api<{ repos: readonly { repo: { nodeId: string; repoPath: string } }[] }>(
      instance, '/repos',
    )
    assert.ok(
      localRepos.repos.some(report => report.repo.nodeId === 'local' && report.repo.repoPath === instance.localRepo),
      'the local repository reached the store',
    )

    await clickRowControl(page, 'local-repo', 'newWorktree')
    await waitForForm(page, exact('newWorktree'), 'the local new-worktree form')
    await fillDialogInputByPlaceholder(page, new RegExp(escape(en.placeholderWorktreeName)), 'here')
    await waitForEnabled(page, exact('create'), 'the form to accept the local worktree')
    await clickInDialog(page, exact('create'))
    await waitForFormGone(page, exact('newWorktree'), 'the local new-worktree form to close')

    const localCheckout = join(instance.userHome, '.dsh', 'worktrees', 'local-repo', 'here')
    await waitForPath(join(localCheckout, 'README.md'), 'present')
    assert.match(
      await readFile(join(localCheckout, 'README.md'), 'utf8'),
      /fixture/,
      'the local checkout carries the repository content',
    )
    const localWorktrees = await api<{
      worktrees: readonly { anchor: { nodeId: string; kind: string; anchorPath: string; branch: string } }[]
    }>(instance, '/worktrees')
    const localEntry = localWorktrees.worktrees.find(entry =>
      entry.anchor.nodeId === 'local' && entry.anchor.kind === 'worktree')
    assert.equal(
      localEntry?.anchor.anchorPath,
      localCheckout,
      'the checkout is its own workspace path, with no anchor standing in for it',
    )
    assert.equal(localEntry?.anchor.branch, 'worktree/here')
    // The workspace a session would open is labelled for this machine too.
    await waitFor(page, `document.body.innerText.includes('here · local-repo · Local')`, 'the local workspace label')
    await shot('10-local-worktree')

    // The terminal section drives a real PTY on the deployment host. A sandbox
    // that refuses posix_openpt would fail it on the environment rather than the
    // code, so it reports as skipped and the run still covers everything above.
    const noPty = await ptyUnavailable()
    if (noPty !== undefined) {
      t.diagnostic(`terminal section skipped: ${noPty}`)
      return
    }

    // A terminal tab belongs to a Session's right Sidebar, and only worktree
    // management has run so far: the workspace just cut is opened as a Session
    // here, the way an operator would, so the terminal has one to belong to.
    await openWorkspaceSession(page, 'here · local-repo · Local')

    // Closing a tab no longer ends its shell: teardown only closes the socket,
    // so the host detaches the terminal and the chooser lists it as detached.
    // Choosing it comes back to the same shell, marker and earlier output
    // included.
    const firstTerminal = await openTerminal(page, 'new')
    await shot('11-terminal-open')
    const firstId = `t${firstTerminal.replace(/\D+/g, '')}`
    await typeInTerminal(page, 'export DRW_TAB_PROBE=7')
    await page.press('Enter')
    await typeInTerminal(page, 'echo tabprobe=$DRW_TAB_PROBE')
    await page.press('Enter')
    await waitFor(page, `${TERMINAL_TEXT}.includes('tabprobe=7')`, 'the marker before the tab closes')
    await closeTabByTitle(page, firstTerminal)

    // The tab is gone, the shell is not: the chooser offers it detached.
    await openTerminalChooser(page)
    await clearShellDialogs(page)
    await waitFor(
      page,
      `document.querySelector('[data-terminal-choice="${firstId}"]') !== null`,
      'the shell the closed tab left detached',
    )
    await waitFor(
      page,
      `(${pickerState(firstId)}) === 'detached'`,
      'the host to report the closed tab shell detached',
    )
    await shot('12-tab-closed-detached')

    // Choosing it returns to the same shell: same chip title, the earlier
    // output replayed, and the marker it exported still set.
    await page.evaluate(`document.querySelector('[data-terminal-choice="${firstId}"]').click()`)
    const restoredFirst = await waitForTerminalChip(page)
    assert.equal(restoredFirst, firstTerminal, 'the chosen terminal is the shell the closed tab left behind')
    await waitFor(page, `${TERMINAL_TEXT}.includes('tabprobe=7')`, 'the earlier output to be replayed')
    await typeInTerminal(page, 'echo aftertab=$DRW_TAB_PROBE')
    await page.press('Enter')
    await waitFor(page, `${TERMINAL_TEXT}.includes('aftertab=7')`, 'the marker in the shell a closed tab left')
    await shot('12b-reattached-after-tab-close')

    // Ending a shell is explicit, and its control lives where the shells are
    // listed: the panel offers no end button, so the manage control opens the
    // chooser in a tab of its own and the row's close ends the shell through the
    // host route — the row leaves the list rather than showing up detached.
    await clearShellDialogs(page)
    await openAnotherTerminal(page)
    await waitFor(
      page,
      `document.querySelector('[data-terminal-choice="${firstId}"]') !== null`,
      'the shell to end in the chooser',
    )
    await page.evaluate(`document.querySelector('[data-terminal-close="${firstId}"]').click()`)
    await waitFor(
      page,
      `document.querySelector('[data-terminal-choice="${firstId}"]') === null`,
      'the ended terminal to leave the chooser',
    )
    const endedProbe = await attachAndRead(page, firstId)
    assert.equal(endedProbe.ready, null, 'ending the terminal left a shell to reattach to')
    assert.match(String(endedProbe.error), /is open in this session|exited/)
    await shot('12c-terminal-ended')

    // The tab that held that shell is still open on it, and this run works one
    // tab at a time; the chooser this one stands on is where the next shell is
    // opened, and its chip is the active one.
    await closeTabByTitle(page, firstTerminal)
    await page.evaluate(`document.querySelector('[data-terminal-new]').click()`)
    const secondTerminal = await waitForActiveTerminalChip(page)
    assert.notEqual(secondTerminal, firstTerminal, 'a reopened terminal is a new terminal')
    await shot('12-terminal-reopened')

    // The acceptance case: set a marker in the live terminal, reload the page
    // (which drops the socket with no `close`), then open a terminal the way a
    // person does. The shell restores no sidebar tab, so without the chooser
    // this shell would be alive on the host and unreachable by anyone but the
    // model's terminal tool.
    const terminalId = `t${secondTerminal.replace(/\D+/g, '')}`
    await typeInTerminal(page, 'export DRW_PROBE=42')
    await page.press('Enter')
    await typeInTerminal(page, 'echo probe=$DRW_PROBE')
    await page.press('Enter')
    await waitFor(page, `${TERMINAL_TEXT}.includes('probe=42')`, 'the marker in the terminal')
    const memoryBefore = await page.evaluate<Record<string, string>>(TERMINAL_MEMORY)
    assert.deepEqual(
      Object.values(memoryBefore),
      [terminalId],
      'the session remembered the live terminal before the reload',
    )
    await shot('13-terminal-marker')

    await reload(page, instance)
    await shot('14-after-reload')
    console.log(
      `reload: terminal before=${JSON.stringify(secondTerminal)} (${terminalId}); `
      + `remembered=${JSON.stringify(memoryBefore)}; `
      + `tab chips after=${JSON.stringify(await page.evaluate<readonly string[]>(CHIP_TITLES))}`,
    )

    // Reopen the Session the person had — the workspace's own new-session
    // control reuses the blank Session this run started — and then open the
    // chooser from the strip's add control. The shell the reload detached is
    // what it offers, and it says so.
    await openWorkspaceSession(page, 'here · local-repo · Local')
    await openTerminalChooser(page)
    await waitFor(
      page,
      `document.querySelector('[data-terminal-choice="${terminalId}"]') !== null`,
      'the detached shell in the chooser',
    )
    assert.deepEqual(
      await page.evaluate<readonly (string | null)[]>(PICKER_ROWS),
      [terminalId],
      'the chooser lists the shell the reload left behind',
    )
    assert.equal(
      await page.evaluate<string>(pickerState(terminalId)),
      'detached',
      'the shell outlived its tab and the host reports it detached',
    )
    await shot('14b-terminal-chooser')

    // Choosing it attaches: the same chip title, the same shell, the earlier
    // output replayed.
    await clearShellDialogs(page)
    await page.evaluate(`document.querySelector('[data-terminal-choice="${terminalId}"]').click()`)
    const restored = await waitForTerminalChip(page)
    await shot('14c-reattached-terminal')

    assert.equal(restored, secondTerminal, 'the chosen terminal is the same shell')
    assert.deepEqual(
      await page.evaluate<Record<string, string>>(TERMINAL_MEMORY),
      memoryBefore,
      'the same Session still remembers the same terminal id',
    )
    // The replayed scrollback is the earlier output; a fresh command proves the
    // shell behind it is the same live process.
    await waitFor(page, `${TERMINAL_TEXT}.includes('export DRW_PROBE=42')`, 'the earlier output to be replayed')
    await typeInTerminal(page, 'echo again=$DRW_PROBE')
    await page.press('Enter')
    await waitFor(page, `${TERMINAL_TEXT}.includes('again=42')`, 'the marker in the reattached shell')
    await shot('14d-reattached-live')

    // A second reload leaves the chooser the same choice, and the New terminal
    // entry must open a different shell rather than the detached one.
    await reload(page, instance)
    await openWorkspaceSession(page, 'here · local-repo · Local')
    const fresh = await openTerminal(page, 'new')
    assert.notEqual(fresh, secondTerminal, 'the New terminal choice opened a different shell')
    await shot('15-new-terminal')
    // The shell the chooser still listed was left alone: choosing New neither
    // reused it nor ended it.
    const left = await attachAndRead(page, terminalId)
    assert.equal(left.ready?.id, terminalId, 'the detached terminal outlived the New terminal choice')

    // The panel's own Manage terminals control is what adds a second tab: the
    // strip's add control cannot, because a page kind is focused where it is
    // already open rather than opened twice in one pane. The new tab starts
    // shell-less, so its chooser still offers the shell behind the first tab.
    await typeInTerminal(page, 'export DRW_FIRST=5')
    await page.press('Enter')
    // Quoted: an unquoted `[...]` is a zsh glob, and its "no matches found"
    // error would carry the marker whether or not the variable is set.
    await typeInTerminal(page, 'echo "first=[$DRW_FIRST]"')
    await page.press('Enter')
    await waitFor(page, `${TERMINAL_TEXT}.includes('first=[5]')`, 'the marker in the terminal already open')
    const freshId = `t${fresh.replace(/\D+/g, '')}`
    assert.deepEqual(
      await page.evaluate<readonly string[]>(CHIP_TITLES),
      [fresh],
      'one terminal tab before the Manage terminals control',
    )

    await openAnotherTerminal(page)
    const chips = await page.evaluate<readonly string[]>(CHIP_TITLES)
    assert.equal(chips.length, 2, 'the Manage terminals control added a second tab')
    assert.ok(chips.includes(fresh), 'the first terminal tab is still there')
    await clearShellDialogs(page)
    await waitFor(
      page,
      `document.querySelector('[data-terminal-choice="${freshId}"]') !== null`,
      'the first shell in the new tab chooser',
    )
    assert.equal(
      await page.evaluate<string>(pickerState(freshId)),
      'running',
      'the first tab shell is still running beside the new tab',
    )
    await shot('16-second-tab-chooser')

    // Picking a fresh shell makes the sibling live; it is a different shell
    // with a different label and its own id.
    await clearShellDialogs(page)
    await page.evaluate(`document.querySelector('[data-terminal-new]').click()`)
    const sibling = await waitForActiveTerminalChip(page)
    const siblingId = `t${sibling.replace(/\D+/g, '')}`
    assert.notEqual(sibling, fresh, 'the second tab names its own shell')
    assert.notEqual(siblingId, freshId, 'the second tab owns a distinct shell')
    await shot('16-second-terminal')

    // The two shells share nothing: neither has the marker exported in the
    // other, and the first still answers with its own.
    await typeInTerminal(page, 'echo "first=[$DRW_FIRST]"')
    await page.press('Enter')
    await waitFor(page, `${TERMINAL_TEXT}.includes('first=[]')`, 'the sibling to lack the first shell marker')
    await typeInTerminal(page, 'export DRW_SECOND=6')
    await page.press('Enter')
    await typeInTerminal(page, 'echo "second=[$DRW_SECOND]"')
    await page.press('Enter')
    await waitFor(page, `${TERMINAL_TEXT}.includes('second=[6]')`, 'the marker in the sibling shell')
    await shot('16b-second-terminal-live')

    await clickTabByTitle(page, fresh)
    await waitFor(page, `${TERMINAL_TEXT}.includes('first=[5]')`, 'the first terminal to be shown again')
    await typeInTerminal(page, 'echo "second=[$DRW_SECOND]"')
    await page.press('Enter')
    await waitFor(page, `${TERMINAL_TEXT}.includes('second=[]')`, 'the first shell to lack the sibling marker')
    await shot('16c-terminals-independent')

    // A shell another tab already draws is marked in the chooser, and picking
    // it brings that tab forward instead of attaching a second view. A shell no
    // tab holds still attaches into the tab that is asking.
    //
    // The unheld shell is made here rather than borrowed: closing a tab
    // detaches its shell, and that shell then belongs to no tab.
    await openAnotherTerminal(page)
    await clearShellDialogs(page)
    await page.evaluate(`document.querySelector('[data-terminal-new]').click()`)
    const looseTitle = await waitForActiveTerminalChip(page)
    const looseId = `t${looseTitle.replace(/\D+/g, '')}`
    await typeInTerminal(page, 'export DRW_LOOSE=8')
    await page.press('Enter')
    await typeInTerminal(page, 'echo "loose=[$DRW_LOOSE]"')
    await page.press('Enter')
    await waitFor(page, `${TERMINAL_TEXT}.includes('loose=[8]')`, 'the marker in the shell about to be released')
    await closeTabByTitle(page, looseTitle)
    assert.equal(
      (await page.evaluate<readonly string[]>(CHIP_TITLES)).length,
      2,
      'the tab that released its shell left the two terminals',
    )

    await openAnotherTerminal(page)
    assert.equal(
      (await page.evaluate<readonly string[]>(CHIP_TITLES)).length,
      3,
      'the shell-less tab joined the two terminals',
    )
    await waitFor(
      page,
      `document.querySelector('[data-terminal-choice="${looseId}"]') !== null`,
      'the released shell in the picker',
    )
    assert.equal(await page.evaluate<boolean>(pickerOpened(freshId)), true, 'the first terminal is marked open')
    assert.equal(await page.evaluate<boolean>(pickerOpened(siblingId)), true, 'the sibling terminal is marked open')
    assert.equal(await page.evaluate<boolean>(pickerOpened(looseId)), false, 'the released terminal is in no tab')
    await shot('17-open-in-another-tab')

    // Nothing holds this shell, so it attaches here, in the tab that was empty.
    await page.evaluate(`document.querySelector('[data-terminal-choice="${looseId}"]').click()`)
    await waitForActiveTerminalChip(page)
    await typeInTerminal(page, 'echo "again=[$DRW_LOOSE]"')
    await page.press('Enter')
    await waitFor(page, `${TERMINAL_TEXT}.includes('again=[8]')`, 'the released shell attached into the empty tab')
    assert.equal(
      (await page.evaluate<readonly string[]>(CHIP_TITLES)).length,
      3,
      'attaching a shell no tab held added no tab',
    )
    await shot('17b-released-attached-here')

    // Now every shell has a tab. Picking one of them must bring its tab
    // forward — no new tab, and the other tab keeps its own shell.
    await openAnotherTerminal(page)
    await waitFor(
      page,
      `document.querySelector('[data-terminal-choice="${freshId}"]') !== null`,
      'the first terminal in the second picker',
    )
    assert.equal(await page.evaluate<boolean>(pickerOpened(freshId)), true, 'the first terminal is marked open')
    assert.equal(await page.evaluate<boolean>(pickerOpened(siblingId)), true, 'the sibling terminal is marked open')
    assert.equal(await page.evaluate<boolean>(pickerOpened(looseId)), true, 'the reattached shell is marked open')
    const tabsBefore = (await page.evaluate<readonly string[]>(CHIP_TITLES)).length
    assert.equal(tabsBefore, 4, 'the second shell-less tab joined')
    await shot('17c-all-open')

    await page.evaluate(`document.querySelector('[data-terminal-choice="${freshId}"]').click()`)
    await waitFor(page, `${ACTIVE_CHIP_TITLE} === ${JSON.stringify(fresh)}`, 'the first terminal tab to come forward')
    assert.equal(
      (await page.evaluate<readonly string[]>(CHIP_TITLES)).length,
      tabsBefore,
      'focusing an open shell added no tab',
    )
    await clickTabByTitle(page, sibling)
    await waitFor(page, `${TERMINAL_TEXT}.includes('second=[6]')`, 'the sibling tab to still show its own shell')
    await shot('17d-focused-open-tab')

    // End every shell the Session still lists. A detached zsh writes its
    // history as it exits, and a run that leaves four of them racing the
    // scratch directory's removal fails teardown instead of an assertion.
    await openAnotherTerminal(page)
    await waitFor(page, `document.querySelector('[data-terminal-close]') !== null`, 'the shells to end')
    const leftovers = await page.evaluate<readonly string[]>(
      `[...document.querySelectorAll('[data-terminal-close]')].map(el => el.getAttribute('data-terminal-close'))`,
    )
    for (const id of leftovers) {
      const control = `document.querySelector('[data-terminal-close="${id}"]')`
      await waitFor(page, `${control} !== null && ${control}.disabled !== true`, `the ${id} end control`)
      await page.evaluate(`${control}.click()`)
      await waitFor(page, `${control} === null`, `the ${id} terminal to end`)
    }
  } catch (error) {
    failure = error
    if (browser !== undefined && deployment !== undefined) {
      await browser.screenshot(join(deployment.artifacts, 'failure.png')).catch(() => {})
      console.error('--- section text ---')
      console.error((await browser.evaluate<string>('document.body.innerText').catch(() => '(unreadable)')).slice(0, 1200))
      console.error('--- instance logs (tail) ---')
      console.error(deployment.logs().slice(-4000))
    }
    throw error
  } finally {
    await browser?.close()
    if (deployment !== undefined) {
      // Keep the pictures after the scratch directory is gone, and keep the
      // whole scratch directory when the run failed, so its logs survive.
      const gallery = join(process.cwd(), '.artifacts', 'browser')
      await mkdir(gallery, { recursive: true })
      await cp(deployment.artifacts, gallery, { recursive: true })
      const leaving = process.env['RWT_LEAVE'] === '1'
      await deployment.stop({ keep: failure !== undefined, leave: leaving })
      console.log(`screenshots: ${gallery}`)
      if (failure !== undefined) console.log(`scratch kept at ${deployment.root}`)
      if (leaving) {
        console.log(`left running: ${deployment.pageUrl}`)
        console.log(`daemon port: ${String(deployment.daemonPort)} | home: ${deployment.home}`)
        console.log(`stop it with: ${deployment.pids.map(pid => `kill -TERM -${String(pid)}`).join(' && ')}`)
      }
    }
  }
})
