/**
 * The terminal tool's contract: one tool with an `action`, which parameters
 * each action accepts, what one send writes, how a wait settles, and that the
 * calling Session is the only identity a call can act as.
 *
 * A real registry over a faked seam sits underneath, so these cases pin the
 * tool's dispatch and wording rather than the table the registry test already
 * covers.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { TtyHandle, TtyOutcome } from '../../src/tty.ts'
import { createTerminalRegistry, type TerminalRegistry, type TerminalSettings } from '../../src/terminal/host/registry.ts'
import { registerTerminalTool } from '../../src/tools/terminal.ts'

/** How the registry starts a shell, for every case below. */
const settings: TerminalSettings = {
  shell: '/bin/sh',
  shellArgs: ['-l'],
  env: { TERM: 'xterm-256color' },
  graceMs: 1000,
}

/** One terminal the seam handed back. */
interface FakeTerminal {
  readonly handle: TtyHandle
  readonly writes: string[]
  emit(chunk: string): void
  exit(): void
}

/** A terminal handle a case answers for. */
function fakeTerminal(): FakeTerminal {
  const output = new PassThrough()
  const writes: string[] = []
  let settle: (outcome: TtyOutcome) => void = () => {}
  const done = new Promise<TtyOutcome>((resolve) => { settle = resolve })
  return {
    writes,
    emit: (chunk) => { output.write(Buffer.from(chunk, 'utf8')) },
    exit: () => settle({ exitCode: 0, signal: null }),
    handle: {
      pid: 4242,
      output,
      done,
      async write(data) { writes.push(data) },
      async resize() {},
      async terminate() {},
    },
  }
}

/** The tool as the registry would see it, over a real terminal registry. */
function compose(): {
  readonly tools: ToolDefinition[]
  readonly registry: TerminalRegistry
  readonly terminal: FakeTerminal
  readonly exec: (sessionId: string, signal?: AbortSignal) => ToolRunContext
} {
  const terminal = fakeTerminal()
  const registry = createTerminalRegistry({
    spawn: async () => terminal.handle,
    settings,
    machine: () => ({ nodeId: 'local', label: 'Local' }),
    directory: cwd => cwd,
  })
  const tools: ToolDefinition[] = []
  const ctx = {
    get: (name: string) => name === 'tools'
      ? { register: (definition: ToolDefinition) => { tools.push(definition) } }
      : undefined,
  } as unknown as Context
  registerTerminalTool(ctx, registry)

  const exec = (sessionId: string, signal?: AbortSignal): ToolRunContext => ({
    agent: { id: sessionId },
    signal: signal ?? new AbortController().signal,
  }) as unknown as ToolRunContext

  return { tools, registry, terminal, exec }
}

/** The one terminal tool's definition. */
function soleTool(tools: readonly ToolDefinition[]): ToolDefinition {
  assert.equal(tools.length, 1)
  return tools[0]!
}

/** Cast one canonical tool value for reading in a case. */
function valueOf<T>(value: unknown): T {
  return value as T
}

/** The one text block a definition renders for a value; the model sees only this. */
function renderText(definition: ToolDefinition, args: Record<string, unknown>, value: unknown): string {
  const content = definition.output.render(args as never, value as never)
  assert.equal(content.length, 1)
  assert.equal(content[0]?.type, 'text')
  return (content[0] as { text: string }).text
}

/** Let an action's synchronous setup run before a case drives the seam. */
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

test('the catalog holds exactly one terminal tool, with no per-action siblings', () => {
  const { tools } = compose()
  assert.deepEqual(tools.map(tool => tool.name), ['terminal'])
  assert.equal(tools.some(tool => tool.name.startsWith('terminal_')), false)
  // The action enum is the dispatch surface, so it is part of the pinned
  // catalog rather than only of the implementation.
  const parameters = toolSchema(soleTool(tools))
  assert.deepEqual(parameters['action']?.enum, ['list', 'read', 'send', 'keys', 'wait'])
})

/** The raw per-property schema a definition carries for the model. */
function toolSchema(definition: ToolDefinition): Record<string, { enum?: readonly string[] }> {
  const parameters = (definition as unknown as {
    parameters: { properties: Record<string, { enum?: readonly string[] }> }
  }).parameters
  return parameters.properties
}

test('list reports the calling Session’s terminals and needs no terminal argument', async () => {
  const { tools, registry, exec } = compose()
  await registry.open('s1', '/w/a', { cols: 80, rows: 24 })

  const value = valueOf<{ terminals: readonly { id: string }[] }>(
    await soleTool(tools).execute({ action: 'list' }, exec('s1')),
  )
  assert.deepEqual(value.terminals.map(terminal => terminal.id), ['t1'])
})

test('list answers an empty list rather than failing when nothing is open', async () => {
  const { tools, exec } = compose()
  const value = valueOf<{ terminals: readonly unknown[] }>(
    await soleTool(tools).execute({ action: 'list' }, exec('s1')),
  )
  assert.deepEqual(value.terminals, [])
})

test('list reports a detached terminal instead of hiding it', async () => {
  const { tools, registry, exec } = compose()
  await registry.open('s1', '/w/a', { cols: 80, rows: 24 })
  // What the socket closing does: the terminal stays, nobody is watching.
  const sink = { output() {}, exit() {}, fail() {} }
  registry.attach('t1', sink)
  registry.detach('t1', sink)

  const args = { action: 'list' }
  const value = valueOf<{ terminals: readonly { id: string; state: string }[] }>(
    await soleTool(tools).execute(args, exec('s1')),
  )
  assert.deepEqual(value.terminals.map(terminal => [terminal.id, terminal.state]), [['t1', 'detached']])
  assert.equal(renderText(soleTool(tools), args, value), 't1 (Terminal 1) detached · /w/a · Local')
})

test('a Session sees only its own terminals, whatever id it passes', async () => {
  const { tools, registry, exec } = compose()
  await registry.open('s2', '/w/b', { cols: 80, rows: 24 })

  await assert.rejects(
    soleTool(tools).execute({ action: 'read', terminal: 't1' }, exec('s1')),
    /no terminal "t1" is open in this session/,
  )
  await assert.rejects(
    soleTool(tools).execute({ action: 'read' }, exec('s1')),
    /this session has no open terminal/,
  )
})

test('each action refuses a parameter that belongs to another action', async () => {
  const { tools, registry, exec } = compose()
  await registry.open('s1', '/w/a', { cols: 80, rows: 24 })
  const tool = soleTool(tools)

  await assert.rejects(
    tool.execute({ action: 'read', terminal: 't1', text: 'x' }, exec('s1')),
    /"text" is valid only with action send, not "read"/,
  )
  await assert.rejects(
    tool.execute({ action: 'send', terminal: 't1', text: 'x', lines: 3 }, exec('s1')),
    /"lines" is valid only with action read, not "send"/,
  )
  await assert.rejects(
    tool.execute({ action: 'list', terminal: 't1' }, exec('s1')),
    /"terminal" is valid only with action read or send or keys or wait, not "list"/,
  )
  await assert.rejects(
    tool.execute({ action: 'wait', terminal: 't1', keys: ['enter'], match: 'x' }, exec('s1')),
    /"keys" is valid only with action keys, not "wait"/,
  )
})

test('each action names its own missing parameter', async () => {
  const { tools, registry, exec } = compose()
  await registry.open('s1', '/w/a', { cols: 80, rows: 24 })
  const tool = soleTool(tools)

  await assert.rejects(
    tool.execute({ action: 'send', terminal: 't1' }, exec('s1')),
    /send requires "text"/,
  )
  await assert.rejects(
    tool.execute({ action: 'keys', terminal: 't1' }, exec('s1')),
    /keys requires a non-empty "keys" array/,
  )
  await assert.rejects(
    tool.execute({ action: 'wait', terminal: 't1' }, exec('s1')),
    /wait requires exactly one of "match" and "regex"/,
  )
  await assert.rejects(
    tool.execute({ action: 'wait', terminal: 't1', match: 'a', regex: 'b' }, exec('s1')),
    /wait accepts only one of "match" and "regex"/,
  )
})

test('send writes the text and its carriage return in one ordered write', async () => {
  const { tools, registry, terminal, exec } = compose()
  await registry.open('s1', '/w/a', { cols: 80, rows: 24 })
  const tool = soleTool(tools)

  const sent = valueOf<{ id: string; wrote: { bytes: number; keys: number } }>(
    await tool.execute({ action: 'send', terminal: 't1', text: 'echo hi' }, exec('s1')),
  )
  assert.deepEqual(terminal.writes, ['echo hi\r'])
  assert.deepEqual(sent, { id: 't1', wrote: { bytes: 8, keys: 0 } })

  await tool.execute({ action: 'send', terminal: 't1', text: 'echo hi', enter: false }, exec('s1'))
  assert.deepEqual(terminal.writes, ['echo hi\r', 'echo hi'])
})

test('keys sends named keys and reports how many', async () => {
  const { tools, registry, terminal, exec } = compose()
  await registry.open('s1', '/w/a', { cols: 80, rows: 24 })

  const sent = valueOf<{ wrote: { bytes: number; keys: number } }>(
    await soleTool(tools).execute({ action: 'keys', terminal: 't1', keys: ['ctrl+c'] }, exec('s1')),
  )
  assert.deepEqual(terminal.writes, ['\x03'])
  assert.deepEqual(sent.wrote, { bytes: 1, keys: 1 })
})

test('read returns the tail, the offset that resumes it, and the offset in its render', async () => {
  const { tools, registry, terminal, exec } = compose()
  await registry.open('s1', '/w/a', { cols: 80, rows: 24 })
  terminal.emit('one\ntwo\nthree')
  await settle()

  const args = { action: 'read', terminal: 't1', lines: 2 }
  const read = valueOf<{ id: string; offset: number; text: string; truncated: boolean }>(
    await soleTool(tools).execute(args, exec('s1')),
  )
  assert.equal(read.text, 'two\nthree')
  assert.equal(read.offset, 13)
  // The model sees only the render, so the resume offset is in it.
  assert.equal(renderText(soleTool(tools), args, read), '[t1 truncated offset 13]\ntwo\nthree')
})

test('wait returns on a match, on exit, and on its budget', async () => {
  const { tools, registry, terminal, exec } = compose()
  await registry.open('s1', '/w/a', { cols: 80, rows: 24 })
  const tool = soleTool(tools)

  const matched = tool.execute({ action: 'wait', terminal: 't1', match: 'ready' }, exec('s1'))
  await settle()
  terminal.emit('server ready\n')
  assert.deepEqual(valueOf<{ matched: boolean; reason: string }>(await matched), {
    id: 't1',
    offset: 13,
    text: 'server ready\n',
    matched: true,
    reason: 'match',
  })

  const pattern = tool.execute({ action: 'wait', terminal: 't1', regex: 're\\d+' }, exec('s1'))
  await settle()
  terminal.emit('re42')
  assert.equal(valueOf<{ reason: string }>(await pattern).reason, 'match')

  const exited = tool.execute({ action: 'wait', terminal: 't1', match: 'never' }, exec('s1'))
  await settle()
  terminal.emit('bye')
  terminal.exit()
  const outcome = valueOf<{ matched: boolean; reason: string; text: string }>(await exited)
  assert.equal(outcome.matched, false)
  assert.equal(outcome.reason, 'exit')
  // An offset-less wait reports the retained window it searched, so the earlier
  // output is part of the text rather than invisible.
  assert.equal(outcome.text, 'server ready\nre42bye')
})

test('send then an offset-less wait matches output that already arrived, and renders its text and offset', async () => {
  const { tools, registry, terminal, exec } = compose()
  await registry.open('s1', '/w/a', { cols: 80, rows: 24 })
  const tool = soleTool(tools)

  await tool.execute({ action: 'send', terminal: 't1', text: 'echo hello world' }, exec('s1'))
  // The output lands before the wait starts: the failure was that a wait from
  // "now" could never see it.
  terminal.emit('echo hello world\r\nhello world\r\n')
  await settle()

  const args = { action: 'wait', terminal: 't1', match: 'hello world' }
  const value = valueOf<{ offset: number; text: string; matched: boolean; reason: string }>(
    await tool.execute(args, exec('s1')),
  )
  assert.equal(value.matched, true)
  assert.equal(value.reason, 'match')
  assert.equal(
    renderText(tool, args, value),
    `[t1 match offset ${String(value.offset)}]\necho hello world\r\nhello world\r\n`,
  )
})

test('a timed-out wait renders the window it searched and the offset that resumes it', async () => {
  const { tools, registry, terminal, exec } = compose()
  await registry.open('s1', '/w/a', { cols: 80, rows: 24 })
  terminal.emit('$ echo hi\nhi\n')
  await settle()

  const tool = soleTool(tools)
  const args = { action: 'wait', terminal: 't1', match: 'never', timeoutMs: 20 }
  const value = valueOf<{ offset: number; text: string; matched: boolean; reason: string }>(
    await tool.execute(args, exec('s1')),
  )
  assert.equal(value.reason, 'timeout')
  assert.equal(renderText(tool, args, value), '[t1 timeout offset 13]\n$ echo hi\nhi\n')
})

test('a wait that runs out of budget reports a timeout instead of failing', async () => {
  const { tools, registry, exec } = compose()
  await registry.open('s1', '/w/a', { cols: 80, rows: 24 })

  const outcome = valueOf<{ reason: string; matched: boolean }>(
    await soleTool(tools).execute({ action: 'wait', terminal: 't1', match: 'never', timeoutMs: 20 }, exec('s1')),
  )
  assert.equal(outcome.reason, 'timeout')
  assert.equal(outcome.matched, false)
})

test('a cancelled wait rejects through the run context’s signal', async () => {
  const { tools, registry, exec } = compose()
  await registry.open('s1', '/w/a', { cols: 80, rows: 24 })
  const controller = new AbortController()
  const waiting = soleTool(tools).execute(
    { action: 'wait', terminal: 't1', match: 'never' },
    exec('s1', controller.signal),
  )
  await settle()
  controller.abort(new Error('the caller went away'))

  await assert.rejects(waiting, /the caller went away/)
})

test('a call with no Agent Session is refused rather than guessing one', async () => {
  const { tools, registry } = compose()
  await registry.open('s1', '/w/a', { cols: 80, rows: 24 })

  await assert.rejects(
    soleTool(tools).execute({ action: 'list' }, { signal: new AbortController().signal } as unknown as ToolRunContext),
    /requires an Agent Session/,
  )
})

test('every returned value satisfies the declared canonical schema and renders', async () => {
  const { tools, registry, terminal, exec } = compose()
  await registry.open('s1', '/w/a', { cols: 80, rows: 24 })
  const tool = soleTool(tools)

  /** The canonical contract the registry enforces, and the content it renders. */
  const check = (value: unknown, args: Record<string, unknown>): void => {
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), [])
    const content = tool.output.render(args as never, value as never)
    assert.equal(content.length > 0, true)
    assert.equal(content[0]?.type, 'text')
  }

  check(await tool.execute({ action: 'list' }, exec('s1')), { action: 'list' })
  terminal.emit('hello\n')
  await settle()
  check(await tool.execute({ action: 'read', terminal: 't1' }, exec('s1')), { action: 'read' })
  check(
    await tool.execute({ action: 'send', terminal: 't1', text: 'echo' }, exec('s1')),
    { action: 'send' },
  )
  check(
    await tool.execute({ action: 'keys', terminal: 't1', keys: ['enter'] }, exec('s1')),
    { action: 'keys' },
  )
  // An offset of zero scans what is already buffered, so this settles as a
  // match instead of waiting out the default budget.
  check(
    await tool.execute({ action: 'wait', terminal: 't1', match: 'hello', offset: 0 }, exec('s1')),
    { action: 'wait' },
  )
})
