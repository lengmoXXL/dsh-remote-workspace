/**
 * The host half's decisions away from a real socket: which directory a Session
 * opens in, and what one browser socket makes the terminal seam do — allocate,
 * carry bytes both ways, resize, and release.
 *
 * The seam is faked at its own boundary, so these cases prove the bridge's half
 * of the contract: what it asks for, which frames it answers with, and what it
 * does when the provider refuses a resize.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'
import { WebSocket } from 'ws'
import type { Context } from '@deepseek-ai/cordis'
import type { TtyHandle, TtyOutcome, TtySpawnRequest } from '../../src/tty.ts'
import { attachTerminal } from '../../src/terminal/host/terminal.ts'
import { createTerminalRegistry, type TerminalSettings } from '../../src/terminal/host/registry.ts'
import { resolveWorkspace, TerminalFailure } from '../../src/terminal/host/workspace.ts'

/** A context carrying only what the workspace resolver reads. */
function hostContext(options: {
  live?: { cwd?: string } | undefined
  stored?: { header?: { cwd?: string } } | undefined
}): Context {
  const sessions = {
    get: () => options.live === undefined ? undefined : { header: options.live },
  }
  return {
    sessions,
    get: (name: string) => name === 'sessions'
      ? sessions
      : name === 'sessionPersistence' && options.stored !== undefined
        ? { stat: () => Promise.resolve(options.stored) }
        : undefined,
  } as unknown as Context
}

/** How the bridge starts a shell, for every case below. */
const settings: TerminalSettings = {
  shell: '/bin/sh',
  shellArgs: ['-l'],
  env: { TERM: 'xterm-256color' },
  graceMs: 3000,
}

test('a live Session answers with its own workspace', async () => {
  const ctx = hostContext({ live: { cwd: '/w/live' } })
  assert.equal(await resolveWorkspace(ctx, 'session-1'), '/w/live')
})

test('a Session the host is not running answers from its stored header', async () => {
  const ctx = hostContext({ stored: { header: { cwd: '/w/stored' } } })
  assert.equal(await resolveWorkspace(ctx, 'session-1'), '/w/stored')
})

test('an unknown Session is a typed refusal, not a fallback directory', async () => {
  const ctx = hostContext({})
  await assert.rejects(resolveWorkspace(ctx, 'session-1'), (error: unknown) => {
    assert.ok(error instanceof TerminalFailure)
    assert.match((error as Error).message, /is unknown/)
    return true
  })
})

test('an empty Session identity is refused before anything is read', async () => {
  const ctx = hostContext({ live: { cwd: '/w/live' } })
  await assert.rejects(resolveWorkspace(ctx, '  '), TerminalFailure)
})

/** One terminal the bridge allocated, with the knobs a case drives. */
interface FakeTerminal {
  readonly handle: TtyHandle
  readonly writes: string[]
  readonly resizes: number[][]
  terminations(): number
  exit(outcome: TtyOutcome): void
  emit(chunk: string): void
}

/**
 * A terminal handle a case answers for.
 * @param refuseResize - whether the provider refuses a resize, the way a node
 *   running an agent from before `term.resize` existed does.
 * @returns the handle and the observations a case makes on it.
 */
function fakeTerminal(refuseResize = false): FakeTerminal {
  const output = new PassThrough()
  const writes: string[] = []
  const resizes: number[][] = []
  let terminations = 0
  let resolveOutcome: (outcome: TtyOutcome) => void = () => {}
  const done = new Promise<TtyOutcome>((resolve) => { resolveOutcome = resolve })
  return {
    writes,
    resizes,
    terminations: () => terminations,
    exit: outcome => resolveOutcome(outcome),
    emit: (chunk) => { output.write(Buffer.from(chunk, 'utf8')) },
    handle: {
      pid: 4242,
      output,
      done,
      async write(data) { writes.push(data) },
      async resize(cols, rows) {
        if (refuseResize) throw new Error('the daemon does not answer term.resize')
        resizes.push([cols, rows])
      },
      async terminate() { terminations += 1 },
    },
  }
}

/** A browser socket the bridge can send on, and a case can drive. */
interface FakeSocket {
  readonly socket: WebSocket
  readonly sent: readonly (string | Buffer)[]
  readonly frames: readonly unknown[]
  closed(): { readonly code: number; readonly reason: string } | undefined
  send(frame: unknown): void
  close(): void
}

/**
 * A socket that records what the bridge sent and replays what a case sends.
 * @returns the socket and the observations a case makes on it.
 */
function fakeSocket(): FakeSocket {
  const sent: (string | Buffer)[] = []
  const listeners = new Map<string, ((...args: never[]) => void)[]>()
  let closed: { code: number; reason: string } | undefined
  return {
    sent,
    get frames() {
      return sent.filter(entry => typeof entry === 'string')
        .map(entry => JSON.parse(entry as string) as unknown)
    },
    closed: () => closed,
    send: (frame) => {
      for (const handler of listeners.get('message') ?? []) {
        (handler as (data: string, isBinary: boolean) => void)(JSON.stringify(frame), false)
      }
    },
    close: () => {
      for (const handler of listeners.get('close') ?? []) handler()
    },
    socket: {
      readyState: WebSocket.OPEN,
      on(event: string, handler: (...args: never[]) => void) {
        const list = listeners.get(event) ?? []
        list.push(handler)
        listeners.set(event, list)
        return this
      },
      send(data: unknown, callback?: () => void) {
        sent.push(data as string | Buffer)
        callback?.()
      },
      close(code: number, reason: string) {
        closed = { code, reason }
      },
    } as unknown as WebSocket,
  }
}

/** Let the bridge's asynchronous forwarding run. */
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/** A host context whose terminal seam is the given provider. */
function ttyContext(spawn: (request: TtySpawnRequest) => Promise<TtyHandle>, cwd: string): Context {
  const sessions = { get: () => ({ header: { cwd } }) }
  return {
    sessions,
    get: (name: string) => name === 'sessions' ? sessions : undefined,
    tty: { spawn },
  } as unknown as Context
}

/** The registry one socket's terminal is registered in. */
function terminalRegistry(
  spawn: (request: TtySpawnRequest) => Promise<TtyHandle>,
  detachGraceMs?: number,
) {
  return createTerminalRegistry({
    spawn,
    settings: detachGraceMs === undefined ? settings : { ...settings, detachGraceMs },
    machine: () => ({ nodeId: 'local', label: 'Local' }),
    directory: cwd => cwd,
  })
}

/** Serve one open frame and return everything the case observes. */
async function opened(options: {
  readonly refuseResize?: boolean
  readonly cwd?: string
  readonly cols?: number
  readonly rows?: number
} = {}): Promise<{
  terminal: FakeTerminal
  browser: FakeSocket
  requests: TtySpawnRequest[]
  registry: ReturnType<typeof terminalRegistry>
}> {
  const terminal = fakeTerminal(options.refuseResize ?? false)
  const requests: TtySpawnRequest[] = []
  const browser = fakeSocket()
  const spawn = async (request: TtySpawnRequest): Promise<TtyHandle> => {
    requests.push(request)
    return terminal.handle
  }
  const registry = terminalRegistry(spawn)
  attachTerminal(ttyContext(spawn, options.cwd ?? '/w/live'), registry, browser.socket)
  browser.send({ t: 'open', sessionId: 'session-1', cols: options.cols ?? 80, rows: options.rows ?? 24 })
  await settle()
  return { terminal, browser, requests, registry }
}

test('a terminal is allocated through the seam in the Session workspace', async () => {
  const { browser, requests } = await opened({ cols: 120, rows: 40 })
  assert.deepEqual(requests, [{
    argv: ['/bin/sh', '-l'],
    cwd: '/w/live',
    env: { TERM: 'xterm-256color' },
    cols: 120,
    rows: 40,
    graceMs: 3000,
  }])
  assert.deepEqual(browser.frames, [{ t: 'ready', pid: 4242, cwd: '/w/live', id: 't1', label: 'Terminal 1' }])
})

test('an unknown Session is answered with an error frame rather than a terminal', async () => {
  const terminal = fakeTerminal()
  const requests: TtySpawnRequest[] = []
  const browser = fakeSocket()
  const spawn = async (request: TtySpawnRequest): Promise<TtyHandle> => {
    requests.push(request)
    return terminal.handle
  }
  attachTerminal(
    {
      sessions: { get: () => undefined },
      get: (name: string) => name === 'sessions' ? { get: () => undefined } : undefined,
    } as unknown as Context,
    terminalRegistry(spawn),
    browser.socket,
  )
  browser.send({ t: 'open', sessionId: 'session-1', cols: 80, rows: 24 })
  await settle()
  assert.equal(requests.length, 0, 'nothing is allocated for a Session nobody knows')
  // The browser reads the refusal's words, so the frame carries the reason
  // rather than the typed code the host branches on.
  const frames = browser.frames as { readonly t: string; readonly message?: string }[]
  assert.equal(frames.length, 1)
  assert.equal(frames[0]?.t, 'error')
  assert.match(frames[0]?.message ?? '', /session-1/)
})

test('keystrokes reach the terminal and its output reaches the browser', async () => {
  const { terminal, browser } = await opened()
  browser.send({ t: 'input', data: 'ls\r' })
  await settle()
  assert.deepEqual(terminal.writes, ['ls\r'])
  terminal.emit('total 0\n')
  await settle()
  assert.ok(browser.sent.some(entry => Buffer.isBuffer(entry) && entry.toString('utf8') === 'total 0\n'))
})

test('a resize the provider accepts is reported live', async () => {
  const { terminal, browser } = await opened()
  browser.send({ t: 'resize', cols: 100, rows: 30 })
  await settle()
  assert.deepEqual(terminal.resizes, [[100, 30]])
  assert.deepEqual(browser.frames.at(-1), { t: 'size', cols: 100, rows: 30, live: true })
})

test('a resize the provider refuses is reported stale instead of failing the terminal', async () => {
  const { terminal, browser } = await opened({ refuseResize: true })
  browser.send({ t: 'resize', cols: 100, rows: 30 })
  await settle()
  assert.deepEqual(terminal.resizes, [])
  assert.deepEqual(browser.frames.at(-1), { t: 'size', cols: 100, rows: 30, live: false })
})

test('a browser that goes away detaches the terminal instead of ending it', async () => {
  const { terminal, browser, registry } = await opened()
  assert.deepEqual(registry.listFor('session-1').map(view => view.id), ['t1'])
  browser.close()
  await settle()

  assert.equal(terminal.terminations(), 0)
  // The tab may come back, so the shell stays addressable; `detached` says
  // nobody is watching it.
  assert.deepEqual(registry.listFor('session-1').map(view => view.state), ['detached'])
  assert.equal(registry.requireOwned('session-1').id, 't1')
})

test('a detached terminal outlives the socket, and the process exiting releases it', async () => {
  const { terminal, browser, registry } = await opened()
  browser.close()
  await settle()
  // No valve is configured, so a socket leaving is the only thing that
  // happened: the shell is still there, addressable.
  assert.equal(terminal.terminations(), 0)
  assert.deepEqual(registry.listFor('session-1').map(view => view.state), ['detached'])

  // The process exits while nobody watches: that is what ends the entry.
  terminal.exit({ exitCode: 0, signal: null })
  await settle()

  assert.equal(terminal.terminations(), 1)
  assert.deepEqual(registry.listFor('session-1'), [])
})

test('an attach frame reattaches to a detached terminal and replays its output', async () => {
  const terminal = fakeTerminal()
  const registry = terminalRegistry(async () => terminal.handle)
  const ctx = ttyContext(async () => terminal.handle, '/w/live')
  const first = fakeSocket()
  attachTerminal(ctx, registry, first.socket)
  first.send({ t: 'open', sessionId: 'session-1', cols: 80, rows: 24 })
  await settle()
  terminal.emit('history\n')
  await settle()

  // What a page reload looks like from the host: the socket closes, and a new
  // socket comes back with the id it remembers.
  first.close()
  await settle()
  const second = fakeSocket()
  attachTerminal(ctx, registry, second.socket)
  second.send({ t: 'attach', sessionId: 'session-1', id: 't1', cols: 90, rows: 30 })
  await settle()

  assert.deepEqual(second.frames, [
    { t: 'ready', pid: 4242, cwd: '/w/live', id: 't1', label: 'Terminal 1' },
    { t: 'size', cols: 90, rows: 30, live: true },
  ])
  // The retained bytes reach the new socket, in order, before the frames.
  assert.equal(
    second.sent[0] instanceof Buffer && (second.sent[0] as Buffer).toString('utf8') === 'history\n',
    true,
  )
  assert.deepEqual(terminal.resizes, [[90, 30]])
  assert.deepEqual(registry.listFor('session-1').map(view => view.state), ['running'])
})

test('an attach frame for a terminal that is gone answers with a readable error', async () => {
  const terminal = fakeTerminal()
  const registry = terminalRegistry(async () => terminal.handle)
  const browser = fakeSocket()
  attachTerminal(ttyContext(async () => terminal.handle, '/w/live'), registry, browser.socket)

  browser.send({ t: 'attach', sessionId: 'session-1', id: 't9', cols: 80, rows: 24 })
  await settle()

  const frames = browser.frames as { readonly t: string; readonly message?: string }[]
  assert.deepEqual(frames.map(frame => frame.t), ['error'])
  assert.match(frames[0]?.message ?? '', /no terminal "t9" is open in this session/)
})

test('an attach frame cannot reach a terminal another Session owns', async () => {
  const terminal = fakeTerminal()
  const registry = terminalRegistry(async () => terminal.handle)
  const ctx = ttyContext(async () => terminal.handle, '/w/live')
  const first = fakeSocket()
  attachTerminal(ctx, registry, first.socket)
  first.send({ t: 'open', sessionId: 'session-1', cols: 80, rows: 24 })
  await settle()

  // The id is known, but it belongs to another Session: the attach is refused
  // instead of replaying the shell, so nothing crosses the boundary.
  const second = fakeSocket()
  attachTerminal(ctx, registry, second.socket)
  second.send({ t: 'attach', sessionId: 'session-2', id: 't1', cols: 80, rows: 24 })
  await settle()

  const frames = second.frames as { readonly t: string; readonly message?: string }[]
  assert.deepEqual(frames.map(frame => frame.t), ['error'])
  assert.match(frames[0]?.message ?? '', /no terminal "t1" is open in this session/)
  assert.equal(terminal.terminations(), 0, 'the refused attach did not touch the shell')
  assert.deepEqual(registry.listFor('session-2'), [])
  assert.equal(registry.requireOwned('session-1', 't1').id, 't1')
})

test('a detached terminal is released when its configured valve expires', async () => {
  const terminal = fakeTerminal()
  const registry = terminalRegistry(async () => terminal.handle, 25)
  const browser = fakeSocket()
  attachTerminal(ttyContext(async () => terminal.handle, '/w/live'), registry, browser.socket)
  browser.send({ t: 'open', sessionId: 'session-1', cols: 80, rows: 24 })
  await settle()

  browser.close()
  await settle()
  assert.equal(terminal.terminations(), 0)

  await new Promise(resolve => { setTimeout(resolve, 80) })
  assert.equal(terminal.terminations(), 1)
  assert.deepEqual(registry.listFor('session-1'), [])
})

test('a terminal that exits says so and closes the socket', async () => {
  const { terminal, browser, registry } = await opened()
  terminal.exit({ exitCode: 0, signal: null })
  await settle()
  assert.deepEqual(browser.frames.at(-1), { t: 'exit', code: 0, signal: null })
  assert.equal(browser.closed()?.code, 1000)

  // The socket close this produces is what detaches an already-exited entry,
  // and the registry releases it at once rather than keeping a corpse.
  browser.close()
  await settle()
  assert.equal(terminal.terminations(), 1)
  assert.deepEqual(registry.listFor('session-1'), [])
})
