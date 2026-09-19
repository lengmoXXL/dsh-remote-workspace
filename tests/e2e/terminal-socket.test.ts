/**
 * The terminal registry and the model-facing tool end to end: a real PTY the
 * real daemon allocated, driven the way the sidebar's socket and the model's
 * tool drive it.
 *
 * The socket is stood in for by a sink, because what a socket does with the
 * output is the browser's half; the fact this case exists for is that one
 * registry entry carries both consumers. The tool sends a command, waits for
 * its answer, reads the same bytes back, and the sink attached to the same id
 * sees them too.
 *
 * A host that cannot allocate a PTY skips explicitly, exactly as the terminal
 * primitive's own suite does.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { TtyRuntime } from '../../src/tty.ts'
import { startAgent } from './harness.ts'
import type { TestAgent } from './harness.ts'
import { connectNode } from '../../src/remote/client.ts'
import type { ConnectedNode } from '../../src/remote/client.ts'
import { createRoutingTty } from '../../src/plugin/routing/tty.ts'
import { createTerminalRegistry, type TerminalRegistry, type TerminalSettings } from '../../src/terminal/host/registry.ts'
import { asNodeId } from '../../src/storage/nodes.ts'
import type { AnchorRoute } from '../../src/storage/anchors.ts'
import { registerTerminalTool } from '../../src/tools/terminal.ts'

const TOKEN = 'terminal-socket-token-0123456789'
const SESSION = 'session-1'

let remoteRoot: string
let anchorRoot: string
let server: TestAgent
let node: ConnectedNode
let blocked: string | undefined

/** Allocate one throwaway terminal to learn whether this host allows a PTY. */
async function probePty(): Promise<string | undefined> {
  try {
    const probe = await node.channel.request('term.spawn', {
      argv: ['/bin/sh', '-c', 'true'],
      cwd: remoteRoot,
      rows: 24,
      cols: 80,
      graceMs: 500,
    })
    await node.channel.request('term.terminate', { termId: probe.termId })
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

before(async () => {
  remoteRoot = await realpath(await mkdtemp(join(tmpdir(), 'drw-socket-remote-')))
  anchorRoot = await realpath(await mkdtemp(join(tmpdir(), 'drw-socket-anchor-')))

  server = await startAgent({ token: TOKEN, root: remoteRoot })
  const port = Number(server.boundAddress.slice(server.boundAddress.lastIndexOf(':') + 1))
  node = await connectNode({ host: '127.0.0.1', port, token: TOKEN, timeoutMs: 5_000 })
  blocked = await probePty()
})

after(async () => {
  node?.close()
  await server?.close()
  await rm(remoteRoot, { recursive: true, force: true })
  await rm(anchorRoot, { recursive: true, force: true })
})

/** The registry over the routing provider, plus the tool registered over it. */
function compose(): { registry: TerminalRegistry; tools: ToolDefinition[] } {
  const anchors: AnchorRoute[] = [{ nodeId: asNodeId('n1'), anchorPath: anchorRoot, remoteRoot }]
  const tty = createRoutingTty({
    localTty: new Proxy({}, {
      get: () => () => {
        throw new Error('the local terminal delegate was reached')
      },
    }) as unknown as TtyRuntime,
    anchors: () => anchors,
    channel: id => (id === 'n1' ? node.channel : undefined),
  })
  const settings: TerminalSettings = {
    shell: '/bin/sh',
    shellArgs: ['-i'],
    env: { TERM: 'xterm-256color' },
    graceMs: 1000,
  }
  const registry = createTerminalRegistry({
    spawn: request => tty.spawn(request),
    settings,
    machine: () => ({ nodeId: 'n1', label: 'n1' }),
    directory: cwd => cwd,
  })
  const tools: ToolDefinition[] = []
  const ctx = {
    get: (name: string) => name === 'tools'
      ? { register: (definition: ToolDefinition) => { tools.push(definition) } }
      : undefined,
  } as unknown as Context
  registerTerminalTool(ctx, registry)
  return { registry, tools }
}

/** The tool run context one Session's call carries. */
function exec(signal: AbortSignal): ToolRunContext {
  return { agent: { id: SESSION }, signal } as unknown as ToolRunContext
}

/** Report the PTY skip for a case that needs a real terminal. */
function skipWithoutPty(t: { skip: (reason: string) => void }): boolean {
  if (blocked === undefined) return false
  t.skip(`this host cannot allocate a PTY: ${blocked}`)
  return true
}

test('a terminal opened for a Session is driven by the tool and seen by its socket', async (t) => {
  if (skipWithoutPty(t)) return
  const { registry, tools } = compose()
  const tool = tools[0]!

  const entry = await registry.open(SESSION, anchorRoot, { cols: 80, rows: 24 })
  // What a browser socket does on its `open` frame: attach a sink and then let
  // the registry forward output to it.
  const seen: string[] = []
  registry.attach(entry.id, {
    output(chunk) { seen.push(chunk.toString('utf8')) },
    exit() {},
    fail() {},
  })

  const controller = new AbortController()
  const sent = await tool.execute(
    { action: 'send', text: 'echo drw-$((6*7))' },
    exec(controller.signal),
  ) as { readonly wrote: { readonly bytes: number } }
  assert.ok(sent.wrote.bytes > 0)

  const outcome = await tool.execute(
    { action: 'wait', match: 'drw-42', timeoutMs: 15_000 },
    exec(controller.signal),
  ) as { readonly matched: boolean; readonly reason: string; readonly text: string }
  assert.equal(outcome.matched, true)
  assert.equal(outcome.reason, 'match')
  assert.match(outcome.text, /drw-42/)

  const read = await tool.execute({ action: 'read' }, exec(controller.signal)) as
    { readonly text: string; readonly offset: number }
  assert.match(read.text, /drw-42/)
  assert.ok(read.offset > 0)

  // The sink is the socket's half of the same terminal: the bytes the tool read
  // are the bytes the person saw.
  assert.match(seen.join(''), /drw-42/)

  await registry.kill(entry.id)
  assert.deepEqual(registry.listFor(SESSION), [])
})

test('the tool cannot address a terminal once an explicit end released it', async (t) => {
  if (skipWithoutPty(t)) return
  const { registry, tools } = compose()
  const tool = tools[0]!

  const entry = await registry.open(SESSION, anchorRoot, { cols: 80, rows: 24 })
  await registry.kill(entry.id)

  // This is the chooser's close: the shell ends and the model loses the handle,
  // rather than reaching a shell nothing is showing.
  await assert.rejects(
    tool.execute({ action: 'read', terminal: entry.id }, exec(new AbortController().signal)),
    /no terminal .* is open in this session/,
  )
  const listed = await tool.execute({ action: 'list' }, exec(new AbortController().signal)) as
    { readonly terminals: readonly unknown[] }
  assert.deepEqual(listed.terminals, [])
})
