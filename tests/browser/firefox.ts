/**
 * A minimal WebDriver BiDi client for the Firefox installed on this machine.
 *
 * Firefox 129 and later expose the WebDriver BiDi protocol directly when they
 * are started with `--remote-debugging-port`; the driver needs no geckodriver,
 * no Playwright build, and no npm dependency. The protocol's `script.evaluate`
 * is enough to drive this plugin's section — every interaction is a DOM
 * operation expressed in page JavaScript — and `browsingContext.captureScreenshot`
 * supplies the visual evidence.
 *
 * @module dsh-remote-workspace/tests/browser/firefox
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The Firefox binary this machine installs by default. */
const DEFAULT_FIREFOX = '/Applications/Firefox.app/Contents/MacOS/firefox'

/** One page's worth of control over the browser. */
export interface FirefoxPage {
  /**
   * Load a URL and wait for the document to settle.
   * @param url - the absolute URL to open.
   */
  navigate(url: string): Promise<void>
  /**
   * Run one expression in the page and return its value.
   * @param expression - JavaScript evaluated as an expression.
   * @returns the expression's value, with `undefined` for void results.
   */
  evaluate<T = unknown>(expression: string): Promise<T>
  /**
   * Type text into the focused element as real key events.
   * @param text - the characters to type.
   */
  type(text: string): Promise<void>
  /**
   * Press one named key as a real key event.
   * @param key - a WebDriver key name such as `Enter` or `Tab`.
   */
  press(key: string): Promise<void>
  /**
   * Save a PNG of the current viewport.
   * @param path - absolute file to write.
   */
  screenshot(path: string): Promise<void>
  /** End the session, quit the browser, and remove its profile. */
  close(): Promise<void>
}

/** Start Firefox and open one page. */
export interface LaunchOptions {
  /** Show the window instead of running headless. Defaults to headless. */
  readonly headed?: boolean
}

/**
 * Launch Firefox, negotiate one BiDi session, and open a tab.
 * @param options - window visibility.
 * @returns the page handle.
 * @throws when the browser never announces its BiDi endpoint.
 */
export async function launchFirefox(options: LaunchOptions = {}): Promise<FirefoxPage> {
  const binary = process.env['RWT_FIREFOX_BIN'] ?? DEFAULT_FIREFOX
  const profile = await mkdtemp(join(tmpdir(), 'rwt-firefox-'))
  // The shell picks its locale from the browser's language list, so a run that
  // wants the other language's screenshots sets it here rather than in the
  // deployment.
  const languages = process.env['RWT_ACCEPT_LANGUAGES']
  if (languages !== undefined) {
    await writeFile(
      join(profile, 'user.js'),
      `user_pref("intl.accept_languages", ${JSON.stringify(languages)});\n`,
    )
  }
  const port = await freePort()
  const browser = spawn(binary, [
    ...(options.headed === true ? [] : ['--headless']),
    '--no-remote',
    '--new-instance',
    `--remote-debugging-port=${port}`,
    '--profile',
    profile,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  const collect = (chunk: Buffer): void => { output += chunk.toString('utf8') }
  browser.stdout?.on('data', collect)
  browser.stderr?.on('data', collect)

  try {
    const socket = await waitForEndpoint(browser, () => output)
    const connection = await connect(socket)
    await connection.send('session.new', { capabilities: {} })
    const created = await connection.send<{ context: string }>('browsingContext.create', { type: 'tab' })
    return page(connection, created.context, browser, profile)
  } catch (error) {
    browser.kill('SIGKILL')
    await rm(profile, { recursive: true, force: true })
    throw error
  }
}

/** One connected BiDi session with request correlation. */
interface Connection {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  close(): void
}

/** Wait until Firefox prints the BiDi WebSocket URL it is listening on. */
async function waitForEndpoint(browser: ChildProcess, output: () => string): Promise<string> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const match = /ws:\/\/[^\s]+/.exec(output())
    if (match !== null) return `${match[0]}/session`
    if (browser.exitCode !== null) throw new Error(`firefox exited with ${String(browser.exitCode)}`)
    await delay(250)
  }
  throw new Error(`firefox never announced a BiDi endpoint; output: ${output().slice(0, 400)}`)
}

/** Open the WebSocket and correlate command replies with their ids. */
async function connect(url: string): Promise<Connection> {
  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => { resolve() }
    socket.onerror = () => { reject(new Error(`cannot open ${url}`)) }
  })
  let nextId = 0
  const pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>()
  socket.onmessage = (event: MessageEvent) => {
    const message = JSON.parse(String(event.data)) as
      { id?: number; type?: string; result?: unknown; message?: string }
    if (message.id === undefined) return
    const waiting = pending.get(message.id)
    if (waiting === undefined) return
    pending.delete(message.id)
    if (message.type === 'error') waiting.reject(new Error(message.message ?? 'BiDi error'))
    else waiting.resolve(message.result as never)
  }
  return {
    async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      const id = ++nextId
      const reply = new Promise<never>((resolve, reject) => { pending.set(id, { resolve, reject }) })
      socket.send(JSON.stringify({ id, method, params }))
      return await reply as T
    },
    close: () => { socket.close() },
  }
}

/** Bind the page operations onto one browsing context. */
function page(
  connection: Connection,
  context: string,
  browser: ChildProcess,
  profile: string,
): FirefoxPage {
  return {
    async navigate(url) {
      await connection.send('browsingContext.navigate', { context, url, wait: 'complete' })
    },

    async evaluate<T>(expression: string): Promise<T> {
      const reply = await connection.send<{ result: RemoteValue }>('script.evaluate', {
        expression,
        target: { context },
        awaitPromise: true,
        resultOwnership: 'none',
      })
      return unwrap(reply.result) as T
    },

    async type(text) {
      if (text === '') return
      const actions: KeyAction[] = []
      for (const character of text) {
        actions.push({ type: 'keyDown', value: character }, { type: 'keyUp', value: character })
      }
      await keys(connection, context, actions)
    },

    async press(key) {
      const value = NAMED_KEYS[key] ?? key
      await keys(connection, context, [
        { type: 'keyDown', value },
        { type: 'keyUp', value },
      ])
    },

    async screenshot(path) {
      const reply = await connection.send<{ data: string }>('browsingContext.captureScreenshot', { context })
      await writeFile(path, Buffer.from(reply.data, 'base64'))
    },

    async close() {
      try {
        await connection.send('session.end')
      } catch {
        // The session may already be gone if the page crashed the browser.
      }
      connection.close()
      browser.kill('SIGTERM')
      await delay(300)
      if (browser.exitCode === null) browser.kill('SIGKILL')
      await rm(profile, { recursive: true, force: true })
    },
  }
}

/** One WebDriver key action as BiDi carries it. */
interface KeyAction {
  readonly type: 'keyDown' | 'keyUp'
  readonly value: string
}

/** The WebDriver key value for the named keys this suite presses. */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  Enter: '\uE007',
  Tab: '\uE004',
}

/**
 * Dispatch key actions to the focused element through BiDi.
 * @param connection - the session.
 * @param context - the browsing context whose focused element receives them.
 * @param actions - the key down/up pairs, in order.
 */
async function keys(connection: Connection, context: string, actions: readonly KeyAction[]): Promise<void> {
  await connection.send('input.performActions', {
    context,
    actions: [{ type: 'key', id: 'keyboard', actions }],
  })
}

/** One value as WebDriver BiDi serializes it. */
interface RemoteValue {
  readonly type: string
  readonly value?: unknown
}

/**
 * Convert a BiDi remote value into the plain JavaScript value it stands for.
 *
 * Primitives already arrive as their own value; arrays and objects nest
 * further remote values, which no caller of {@link FirefoxPage.evaluate} wants
 * to know about.
 * @param node - the serialized value.
 * @returns the equivalent plain value.
 */
function unwrap(node: RemoteValue | undefined): unknown {
  if (node === undefined) return undefined
  switch (node.type) {
    case 'undefined':
      return undefined
    case 'null':
      return null
    case 'array':
    case 'set':
      return (node.value as RemoteValue[] | undefined ?? []).map(unwrap)
    case 'object':
    case 'map':
      return Object.fromEntries(
        (node.value as [string, RemoteValue][] | undefined ?? []).map(([key, entry]) => [key, unwrap(entry)]),
      )
    default:
      return node.value
  }
}

/** Reserve a port by binding it and releasing it again. */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:net')
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('no port was bound'))
        return
      }
      const { port } = address
      server.close(() => { resolve(port) })
    })
  })
}

/** Wait for a bounded interval. */
async function delay(ms: number): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(resolve, ms) })
}
