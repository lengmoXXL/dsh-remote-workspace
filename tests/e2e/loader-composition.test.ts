/**
 * Real-composition guard.
 *
 * This plugin exists to replace three seams, so the fact worth guarding is a
 * composition fact: a Loader booting it from a `cordis.yml` must end up with
 * routing `ctx.fs`, `ctx.subprocess`, and `ctx.shell`, and the shipped base
 * must not refuse the result. A hand-built `ctx.plugin(...)` tree cannot show
 * that, because the refusal comes from how *other* rows read what this plugin
 * published — which is exactly how the plugin first failed to load in a real
 * profile.
 *
 * Two rows are stood in for:
 *
 * - `sandboxPolicy`. The shipped provider injects `sessionProjections` and so
 *   drags the session stack into a test about seam composition. The two facts
 *   the consumed implementations read from it — `defaultMode` and `resolve()` —
 *   are reproduced exactly.
 * - `webServer`. Only so the management route can be driven without a socket;
 *   the plugin reaches it through `ctx.get`, as it does in production.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as sandbox from '@deepseek-ai/dsh-sandbox'
import * as fsSandbox from '@deepseek-ai/dsh-fs-sandbox'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import * as plugin from '../../src/index.ts'
import { resolveWorkspace } from '../../src/terminal/host/workspace.ts'

/** One request the plugin's route handler answers. */
interface CapturedRequest {
  readonly method: string
  readonly url: string
}

/** One response the plugin's route handler wrote. */
interface CapturedResponse {
  status: number
  payload: string
}

/** A registered route, as the plugin registers it. */
interface CapturedRoute {
  readonly kind: string
  readonly path: string
  readonly handler: (request: unknown, response: unknown) => Promise<void>
}

/** What one composition booted. */
interface Composition {
  readonly ctx: Context
  readonly dataDir: string
  /** The tool definitions the mounted plugin registered. */
  readonly tools: readonly ToolDefinition[]
  /** Drive the management route the plugin registered, without a socket. */
  readonly request: (method: string, url: string, body?: unknown) => Promise<CapturedResponse>
}

let running: Context | undefined
let root: string | undefined

after(async () => {
  await running?.fiber.dispose()
  running = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** The two facts the sandboxed implementations read off the policy service. */
function policyProvider(mode: 'workspace-write'): object {
  return {
    name: 'test-sandbox-policy',
    apply(ctx: Context): void {
      ctx.provide('sandboxPolicy', {
        defaultMode: mode,
        resolve: () => ({ mode, workspaceRoot: root ?? process.cwd() }),
      } as never)
    },
  }
}

/** The session store the terminal's workspace lookup reads. */
function sessionsProvider(): object {
  return {
    name: 'test-sessions',
    apply(ctx: Context): void {
      ctx.provide('sessions', { get: () => ({ header: { cwd: root } }) } as never)
    },
  }
}

/** Captures the management route so a test can drive it without a socket. */
function webServerProvider(routes: CapturedRoute[]): object {
  return {
    name: 'test-web-server',
    apply(ctx: Context): void {
      ctx.provide('webServer', {
        register(route: CapturedRoute) {
          routes.push(route)
          return () => {}
        },
        // The terminal socket rides the same server through an upgrade route.
        registerUpgrade() {
          return () => {}
        },
      } as never)
    },
  }
}

/** Captures registered tools so a test can see the mounted catalog. */
function toolsProvider(definitions: ToolDefinition[]): object {
  return {
    name: 'test-tools',
    apply(ctx: Context): void {
      ctx.provide('tools', {
        register(definition: ToolDefinition) {
          definitions.push(definition)
          return () => {}
        },
      } as never)
    },
  }
}

/**
 * Boot the plugin from a test-only `cordis.yml` through the real Loader.
 * @param extraRows - patch rows to compose ahead of the plugin row.
 * @returns the live composition and a driver for its management route.
 */
async function compose(extraRows: readonly string[] = []): Promise<Composition> {
  root = await mkdtemp(join(tmpdir(), 'drw-composition-'))
  const dataDir = join(root, 'remote-worktrees')
  const routes: CapturedRoute[] = []
  const tools: ToolDefinition[] = []

  const configPath = join(root, 'cordis.yml')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(configPath, [
    '- id: sandbox-policy',
    '  name: test-sandbox-policy',
    // The real confinement provider, not a stand-in: it has no dependencies of
    // its own, and it is what the sandboxed bash executor waits for.
    '- id: sandbox',
    '  name: "@deepseek-ai/dsh-sandbox"',
    '- id: web-server',
    '  name: test-web-server',
    // The terminal half resolves a Session's workspace here.
    '- id: sessions',
    '  name: test-sessions',
    // The model-facing terminal tool registers here.
    '- id: tools',
    '  name: test-tools',
    ...extraRows,
    '- id: dsh-remote-workspace',
    '  name: "@lengmoxxl/dsh-remote-workspace"',
    '  config:',
    `    dataDir: ${JSON.stringify(dataDir)}`,
    '',
  ].join('\n'))

  const ctx = new Context()
  running = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins['include'] = Include
  const modules = new Map<string, unknown>([
    ['test-sandbox-policy', policyProvider('workspace-write')],
    ['@deepseek-ai/dsh-sandbox', sandbox],
    ['@deepseek-ai/dsh-fs-sandbox', fsSandbox],
    ['test-web-server', webServerProvider(routes)],
    ['test-sessions', sessionsProvider()],
    ['test-tools', toolsProvider(tools)],
    ['@lengmoxxl/dsh-remote-workspace', plugin],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const found = modules.get(specifier)
      if (found === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return found
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()

  // The plugin publishes its seams from isolated scopes, so it settles before
  // they are live. Every real consumer waits the same way; so does this.
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(
      () => { reject(new Error('the plugin never published its seams')) },
      5_000,
    )
    ctx.inject(['fs', 'subprocess', 'shell'], () => {
      clearTimeout(deadline)
      resolve()
      return undefined
    })
  })

  const route = routes.find(candidate => candidate.kind === 'prefix')
  assert.notEqual(route, undefined, 'the plugin registered no management route')

  const request = async (
    method: string,
    url: string,
    body?: unknown,
  ): Promise<CapturedResponse> => {
    const response: CapturedResponse = { status: 0, payload: '' }
    const incoming: CapturedRequest & AsyncIterable<Buffer> = {
      method,
      url,
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body))
      },
    }
    await route!.handler(incoming, {
      writeHead(status: number) { response.status = status },
      end(payload: string) { response.payload = payload },
    })
    return response
  }

  return { ctx, dataDir, tools, request }
}

test('the plugin boots from cordis.yml and publishes routing seams', async () => {
  const { ctx } = await compose()

  // A refusal from the shipped base would have rejected `loader.await()`, so
  // reaching here already means the seams composed. These pin which seams.
  assert.notEqual(ctx.get('fs'), undefined)
  assert.notEqual(ctx.get('subprocess'), undefined)
  assert.notEqual(ctx.get('shell'), undefined)
})

test('the mounted shell reports a sandbox mode', async () => {
  const { ctx } = await compose()
  const shell = ctx.get('shell') as { sandboxMode?: string } | undefined

  // `permission-presets` refuses to compose over an executor that reports no
  // sandbox mode, so a routing executor that dropped it would make the plugin
  // unloadable in a real profile. This is that exact fact.
  assert.equal(shell?.sandboxMode, 'workspace-write')
})

test('the mounted filesystem delegates its sandbox mode', async () => {
  const { ctx } = await compose()
  const fs = ctx.get('fs') as { sandboxMode?: string } | undefined

  assert.equal(fs?.sandboxMode, 'workspace-write')
})

test('a machine added through the management route lands in the configured data directory', async () => {
  const { dataDir, request } = await compose()

  const created = await request('POST', '/dsh-remote-workspace/nodes', {
    ssh: { target: 'user@build-01' },
    remotePort: 7801,
    token: 'secret-token',
  })
  assert.equal(created.status, 201)
  const createdId = (JSON.parse(created.payload) as { node: { nodeId: string } }).node.nodeId

  const written = JSON.parse(await readFile(join(dataDir, 'nodes.json'), 'utf8')) as {
    version: number
    nodes: readonly { title: string; transport: { target: string } }[]
  }
  assert.equal(written.version, 2)
  assert.equal(written.nodes.length, 1)
  assert.equal(written.nodes[0]?.transport.target, 'user@build-01')

  const listed = await request('GET', '/dsh-remote-workspace/nodes')
  assert.equal(listed.status, 200)
  // The stored machine, plus the local machine every deployment has and no
  // document holds.
  assert.deepEqual(
    (JSON.parse(listed.payload) as { nodes: readonly { nodeId: string }[] }).nodes.map(node => node.nodeId),
    ['local', createdId],
  )
  // The secret never leaves the host, whatever surface asked.
  assert.equal(listed.payload.includes('secret-token'), false)
})

test('a deployment that left a stock seam row on is told which patch to write', async () => {
  // The seams are host-plane services, and the profile frees them before this
  // plugin publishes. Skipping that edit does not fail the boot — the registry
  // keeps an `inject` callback's rejection, and `dsh web` prints no logger
  // record — so stderr is what tells an operator what to do, and it has to name
  // the edit.
  const written: string[] = []
  const stderr = process.stderr.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    const { ctx } = await compose([
      '- id: fs-sandbox',
      '  name: "@deepseek-ai/dsh-fs-sandbox"',
    ])
    assert.match(written.join(''), /Disable subprocess, fs-sandbox, bash-sandbox, pwsh-sandbox/)
    assert.match(written.join(''), /cordis\.patch\.yml/)
    // The stock provider kept the seam, so the router is inert rather than half
    // published: the fact the message exists to explain.
    const fs = ctx.get('fs') as { constructor?: { name?: string } } | undefined
    assert.equal(fs?.constructor?.name, 'SandboxedFileSystem')
  } finally {
    process.stderr.write = stderr
  }
})

test('the terminal half reads the session store through the composition', async () => {
  const { ctx } = await compose()

  // The plugin reads `sessions` dynamically rather than declaring it as an
  // activation dependency, so this is the read a real terminal makes. A
  // property access behind `inject` would throw
  // `cannot get property "sessions" without inject` here instead, which is
  // exactly how the terminal broke after the halves were merged.
  assert.equal(await resolveWorkspace(ctx, 'session-1'), root)
})

test('the mounted plugin registers the terminal tool after composition', async () => {
  const { tools } = await compose()

  // A preset realm could still hide the tool from a model later; what a Loader
  // boot proves is that composition itself reaches the host plane's tool
  // registry, with exactly the one name the contract names.
  assert.deepEqual(tools.map(tool => tool.name), ['terminal'])
  assert.equal(tools.some(tool => tool.name.startsWith('terminal_')), false)
})

