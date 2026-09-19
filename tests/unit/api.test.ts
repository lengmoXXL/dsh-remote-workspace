/**
 * The management API is a wire boundary: everything it accepts is untrusted and
 * everything it returns can reach a browser. These cases pin the three rules
 * that matter — a bad body is a client error, a node's secret never leaves the
 * host, and an operation that needs a connection says so instead of failing
 * obscurely.
 */

import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { NodeChannel } from '../../src/remote/client.ts'
import { NodeRequestError } from '../../src/remote/client.ts'
import { createAnchorStore } from '../../src/storage/anchors.ts'
import type { AnchorRecord } from '../../src/storage/anchors.ts'
import { createNodeConnections } from '../../src/models/machines.ts'
import { createNodeRegistry } from '../../src/storage/nodes.ts'
import { createRepoStore } from '../../src/storage/repos.ts'
import { createWorktreeManager } from '../../src/models/worktrees.ts'
import type { NodeInfo, WireMethods } from '../../src/remote/protocol.ts'
import type { NodeRecord, NodeRegistry } from '../../src/storage/nodes.ts'
import { LOCAL_NODE_ID } from '../../src/storage/nodes.ts'
import { repositoryAt } from '../git.ts'
import type { ApiRequest } from '../../src/plugin/api.ts'
import { handleNodeApi } from '../../src/plugin/api.ts'
import { asNodeId } from '../../src/storage/nodes.ts'
import type { NodeId } from '../../src/storage/nodes.ts'
import { asRepoId } from '../../src/storage/repos.ts'
import { createTerminalRegistry } from '../../src/terminal/host/registry.ts'
import type { TtyHandle, TtyOutcome } from '../../src/tty.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drw-api-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A registry, repository store, connection manager, and terminal table sharing one temp directory. */
async function setup(connect?: Parameters<typeof createNodeConnections>[0]) {
  const registry = createNodeRegistry({ file: join(dir, 'nodes.json') })
  await registry.load()
  const repos = createRepoStore({ file: join(dir, 'repos.json') })
  await repos.load()
  const connections = createNodeConnections({
    ...connect ?? {},
    // No test may install an agent over `ssh`: the recorded destination is a
    // placeholder, and the opener is stubbed to a fixed loopback port.
    openTransport: record => Promise.resolve(
      record.transport.kind === 'direct'
        ? { host: record.transport.host, port: record.transport.port, close: () => {} }
        : { host: '127.0.0.1', port: 1, close: () => {} },
    ),
  })
  const anchors = createAnchorStore({ root: join(dir, 'anchors') })
  await anchors.load()
  // Workspace registration is a seam: the deployment normally supplies it, and
  // a set is enough to tell "opened as a workspace" from "merely recorded".
  const registered = new Set<string>()
  const workspace = {
    register: (anchor: AnchorRecord) => { registered.add(anchor.anchorId); return Promise.resolve() },
    unregister: (anchor: AnchorRecord) => { registered.delete(anchor.anchorId); return Promise.resolve() },
    registered: (anchor: AnchorRecord) => Promise.resolve(registered.has(anchor.anchorId)),
  }
  // A stubbed machine takes a fixed POSIX root; the local cases run real git,
  // so their checkouts stay inside this suite's temp directory.
  const worktreeRoot = (nodeId: NodeId): string => (registry.get(nodeId)?.transport.kind === 'local'
    ? join(dir, 'checkouts')
    : '/srv/checkouts')
  const worktrees = createWorktreeManager({
    anchors,
    repos,
    channel: nodeId => connections.channel(nodeId),
    // This suite drives machines; the local machine's own cases live beside it.
    isLocalNode: nodeId => registry.get(nodeId)?.transport.kind === 'local',
    worktreeRoot,
    workspace,
  })
  // The terminal table is the real one over a fake seam, so a case can open a
  // shell and watch the route end it.
  let terminations = 0
  const terminals = createTerminalRegistry({
    spawn: () => Promise.resolve(fakeTerminal(() => { terminations += 1 })),
    settings: { shell: '/bin/sh', shellArgs: [], env: {}, graceMs: 1000 },
    machine: () => ({ nodeId: LOCAL_NODE_ID, label: 'Local' }),
    directory: cwd => cwd,
  })
  return {
    registry,
    repos,
    worktreeRoot,
    connections,
    anchors,
    worktrees,
    registered,
    terminals,
    terminations: () => terminations,
    deps: { registry, repos, connections, worktrees, worktreeRoot, terminals },
  }
}

/**
 * A terminal seam handle the routes can end.
 * @param onTerminate - called when the handle is terminated.
 * @returns the handle the registry pumps.
 */
function fakeTerminal(onTerminate: () => void): TtyHandle {
  return {
    pid: 4242,
    output: new PassThrough(),
    // Nothing here exits on its own: these cases are about closing one.
    done: new Promise<TtyOutcome>(() => {}),
    async write() {},
    async resize() {},
    async terminate() { onTerminate() },
  }
}

/**
 * The machines a registry holds a record for.
 *
 * The local machine is built in rather than stored, so it is present in every
 * list and absent from this one.
 * @param registry - the registry to read.
 * @returns the stored records.
 */
function configured(registry: NodeRegistry): readonly NodeRecord[] {
  return registry.list().filter(node => node.nodeId !== LOCAL_NODE_ID)
}

/** A request with a JSON body. */
function request(method: string, path: string, body?: unknown, query = ''): ApiRequest {
  return { method, path, query: new URLSearchParams(query), body }
}

/** What a daemon reports about itself in its handshake. */
const DAEMON_INFO: NodeInfo = {
  protocol: 1,
  agentVersion: '0.0.1',
  platform: 'linux',
  arch: 'x64',
  node: 'v22.19.0',
  homedir: '/home/dev',
  capability: { pty: false, spill: false, ripgrep: null },
}

test('an install with no machines still has the local one, already ready', async () => {
  const { deps } = await setup()
  const response = await handleNodeApi(request('GET', '/nodes'), deps)
  const body = response.body as { nodes: readonly { nodeId: string; title: string }[]; statuses: readonly { nodeId: string; state: string }[] }

  assert.equal(response.status, 200)
  assert.deepEqual(body.nodes.map(node => node.nodeId), [LOCAL_NODE_ID])
  assert.equal(body.nodes[0]?.title, 'Local')
  // Ready by definition: this is the machine the harness runs on, so there is
  // no connection to make and none to fail.
  assert.deepEqual(body.statuses, [{ nodeId: LOCAL_NODE_ID, state: 'ready' }])
})

test('creating a node answers with a view that carries no secret', async () => {
  const { deps } = await setup()
  const response = await handleNodeApi(
    request('POST', '/nodes', { ssh: { target: 'build-01' }, token: 'hunter2' }),
    deps,
  )

  assert.equal(response.status, 201)
  assert.equal(JSON.stringify(response.body).includes('hunter2'), false)
  const node = (response.body as { node: { title: string; hasToken: boolean } }).node
  assert.equal(node.title, 'build-01')
  assert.equal(node.hasToken, true)
})

test('a node list never carries a secret either', async () => {
  const { deps } = await setup()
  await handleNodeApi(request('POST', '/nodes', { ssh: { target: 'a' }, token: 'hunter2' }), deps)
  const response = await handleNodeApi(request('GET', '/nodes'), deps)
  assert.equal(JSON.stringify(response.body).includes('hunter2'), false)
})

test('a missing host is a client error, not a created node', async () => {
  const { deps, registry } = await setup()
  const response = await handleNodeApi(request('POST', '/nodes', { token: 't' }), deps)
  assert.equal(response.status, 400)
  assert.deepEqual(configured(registry), [])
})

test('a node cannot be created without a token', async () => {
  const { deps, registry } = await setup()
  const response = await handleNodeApi(request('POST', '/nodes', { ssh: { target: 'a' } }), deps)
  assert.equal(response.status, 400)
  assert.deepEqual(configured(registry), [])
})

test('reading one node joins its live status', async () => {
  const { deps } = await setup()
  const created = await handleNodeApi(request('POST', '/nodes', { ssh: { target: 'a' }, token: 't' }), deps)
  const nodeId = asNodeId((created.body as { node: { nodeId: string } }).node.nodeId)

  const response = await handleNodeApi(request('GET', `/nodes/${nodeId}`), deps)
  assert.equal(response.status, 200)
  assert.deepEqual((response.body as { status: { state: string } }).status, {
    nodeId,
    state: 'idle',
  })
})

test('an unknown node is a 404 on every verb that names one', async () => {
  const { deps } = await setup()
  for (const [method, path] of [['GET', '/nodes/nope'], ['DELETE', '/nodes/nope'], ['POST', '/nodes/nope/connect']] as const) {
    const response = await handleNodeApi(request(method, path), deps)
    assert.equal(response.status, 404, `${method} ${path}`)
  }
})

test('patching keeps the fields the caller omitted', async () => {
  const { deps, registry } = await setup()
  const created = await handleNodeApi(
    request('POST', '/nodes', { ssh: { target: 'a' }, token: 't', title: 'First' }),
    deps,
  )
  const nodeId = asNodeId((created.body as { node: { nodeId: string } }).node.nodeId)

  await handleNodeApi(request('PATCH', `/nodes/${nodeId}`, { title: 'Second' }), deps)
  const record = registry.get(nodeId)
  assert.equal(record?.title, 'Second')
  assert.equal(record?.transport.kind === 'ssh' ? record.transport.target : '', 'a')
  assert.equal(record?.token, 't')
})

test('deleting a node disconnects it and drops the record', async () => {
  const { deps, registry } = await setup()
  const created = await handleNodeApi(request('POST', '/nodes', { ssh: { target: 'a' }, token: 't' }), deps)
  const nodeId = asNodeId((created.body as { node: { nodeId: string } }).node.nodeId)

  const response = await handleNodeApi(request('DELETE', `/nodes/${nodeId}`), deps)
  assert.deepEqual(response, { status: 200, body: { deleted: true } })
  assert.deepEqual(configured(registry), [])
})

test('connecting reports the daemon facts', async () => {
  const { deps } = await setup({
    connect: () => Promise.resolve({ info: DAEMON_INFO, channel: { request: () => Promise.reject(new Error('unused')), onPipeFrame: () => () => {} }, close: () => {} }),
  })
  const created = await handleNodeApi(request('POST', '/nodes', { ssh: { target: 'a' }, token: 't' }), deps)
  const nodeId = asNodeId((created.body as { node: { nodeId: string } }).node.nodeId)

  const response = await handleNodeApi(request('POST', `/nodes/${nodeId}/connect`), deps)
  assert.equal(response.status, 200)
  assert.equal((response.body as { status: { state: string } }).status.state, 'ready')
})

test('a failed connection is reported, not swallowed', async () => {
  const { deps } = await setup({ connect: () => Promise.reject(new Error('connection refused')) })
  const created = await handleNodeApi(request('POST', '/nodes', { ssh: { target: 'a' }, token: 't' }), deps)
  const nodeId = asNodeId((created.body as { node: { nodeId: string } }).node.nodeId)

  const response = await handleNodeApi(request('POST', `/nodes/${nodeId}/connect`), deps)
  assert.equal(response.status, 502)
  assert.match(String((response.body as { error: string }).error), /connection refused/)
})

test('browsing directories without a connection is a conflict, not a crash', async () => {
  const { deps } = await setup()
  const created = await handleNodeApi(request('POST', '/nodes', { ssh: { target: 'a' }, token: 't' }), deps)
  const nodeId = asNodeId((created.body as { node: { nodeId: string } }).node.nodeId)

  const response = await handleNodeApi(request('GET', `/nodes/${nodeId}/dirs`, undefined, 'path=/srv'), deps)
  assert.equal(response.status, 409)
})

test('browsing directories lists resolved children', async () => {
  const channel: NodeChannel = {
    onPipeFrame: () => () => {},
    request: (method) => {
      if (method === 'fs.resolve') return Promise.resolve({ canonicalPath: '/srv/app' }) as never
      if (method === 'fs.listDir') {
        return Promise.resolve([
          { name: 'src', type: 'directory', target: { canonicalPath: '/srv/app/src' } },
          { name: 'readme.md', type: 'file', target: { canonicalPath: '/srv/app/readme.md' }, size: 12 },
        ]) as never
      }
      return Promise.reject(new Error(`unexpected ${method}`)) as never
    },
  }
  const { deps } = await setup({
    connect: () => Promise.resolve({
      info: DAEMON_INFO,
      channel,
      close: () => {},
    }),
  })
  const created = await handleNodeApi(request('POST', '/nodes', { ssh: { target: 'a' }, token: 't' }), deps)
  const nodeId = asNodeId((created.body as { node: { nodeId: string } }).node.nodeId)
  await handleNodeApi(request('POST', `/nodes/${nodeId}/connect`), deps)

  const response = await handleNodeApi(request('GET', `/nodes/${nodeId}/dirs`, undefined, 'path=/srv'), deps)
  assert.deepEqual(response, {
    status: 200,
    body: {
      path: '/srv/app',
      entries: [
        { name: 'src', type: 'directory', path: '/srv/app/src' },
        { name: 'readme.md', type: 'file', path: '/srv/app/readme.md', size: 12 },
      ],
    },
  })
})

test('browsing with no path starts at the home the daemon reported', async () => {
  const asked: string[] = []
  const channel: NodeChannel = {
    onPipeFrame: () => () => {},
    request: (method, params) => {
      if (method === 'fs.resolve') {
        asked.push((params as unknown as { path: string }).path)
        return Promise.resolve({ canonicalPath: DAEMON_INFO.homedir }) as never
      }
      if (method === 'fs.listDir') return Promise.resolve([]) as never
      return Promise.reject(new Error(`unexpected ${method}`)) as never
    },
  }
  const { deps } = await setup({
    connect: () => Promise.resolve({ info: DAEMON_INFO, channel, close: () => {} }),
  })
  const created = await handleNodeApi(request('POST', '/nodes', { ssh: { target: 'a' }, token: 't' }), deps)
  const nodeId = asNodeId((created.body as { node: { nodeId: string } }).node.nodeId)
  await handleNodeApi(request('POST', `/nodes/${nodeId}/connect`), deps)

  // The daemon expands no `~`, so the spelling never travels: the home it named
  // is what the browse starts from.
  const response = await handleNodeApi(request('GET', `/nodes/${nodeId}/dirs`, undefined, 'path='), deps)
  assert.equal(response.status, 200)
  assert.deepEqual(asked, ['/home/dev'])
})

test('an unknown endpoint is a 404 and a wrong verb is a 405', async () => {
  const { deps } = await setup()
  assert.equal((await handleNodeApi(request('GET', '/nope'), deps)).status, 404)
  assert.equal((await handleNodeApi(request('PUT', '/nodes'), deps)).status, 405)
})

test('an empty anchor store lists no worktrees', async () => {
  const { deps } = await setup()
  assert.deepEqual(await handleNodeApi(request('GET', '/worktrees'), deps), {
    status: 200,
    body: { worktrees: [] },
  })
})

test('creating a worktree requires its three coordinates', async () => {
  const { deps, anchors } = await setup()
  for (const body of [{ repoPath: '/srv/app', name: 'x' }, { nodeId: asNodeId('n1'), name: 'x' }, { nodeId: asNodeId('n1'), repoPath: '/srv/app' }]) {
    const response = await handleNodeApi(request('POST', '/worktrees', body), deps)
    assert.equal(response.status, 400, JSON.stringify(body))
  }
  assert.deepEqual(anchors.list(), [])
})

test('removing an unknown worktree is reported by the lifecycle', async () => {
  const { deps } = await setup()
  const response = await handleNodeApi(request('DELETE', '/worktrees/nope'), deps)
  assert.equal(response.status, 502)
  assert.match(String((response.body as { error: string }).error), /no anchor/)
})

test('removing a worktree keeps its branch unless the query asks for it', async () => {
  const { deps, anchorId, calls } = await cutWorktree({ 'git.worktreeRemove': () => ({}) })
  calls.length = 0

  const response = await handleNodeApi(request('DELETE', `/worktrees/${anchorId}`), deps)

  assert.equal(response.status, 200)
  assert.equal((response.body as { removal: { branchDeleted: boolean } }).removal.branchDeleted, false)
  assert.equal(calls.includes('git.branchDelete'), false, 'the default never asks for the branch')
})

test('removing a worktree with deleteBranch=true takes the branch too', async () => {
  const { deps, anchorId } = await cutWorktree({
    'git.worktreeRemove': () => ({}),
    'git.branchDelete': () => ({}),
  })

  const response = await handleNodeApi(
    request('DELETE', `/worktrees/${anchorId}`, undefined, 'deleteBranch=true'), deps,
  )

  assert.equal(response.status, 200)
  assert.equal((response.body as { removal: { branchDeleted: boolean } }).removal.branchDeleted, true)
})

test('opening and closing a worktree touch no checkout', async () => {
  const { deps, anchorId, calls, registered } = await cutWorktree()
  calls.length = 0

  const opened = await handleNodeApi(request('POST', `/worktrees/${anchorId}/open`), deps)
  assert.equal(registered.has(String(anchorId)), true)
  const closed = await handleNodeApi(request('POST', `/worktrees/${anchorId}/close`), deps)

  assert.equal(opened.status, 200)
  assert.equal(closed.status, 200)
  assert.equal(registered.has(String(anchorId)), false)
  assert.deepEqual(calls, [], 'neither action reaches the machine')
})

test('a worktree action answers only to POST, and an unknown action deletes nothing', async () => {
  const { deps, anchorId } = await cutWorktree()
  assert.equal((await handleNodeApi(request('GET', `/worktrees/${anchorId}/open`), deps)).status, 405)
  assert.equal((await handleNodeApi(request('DELETE', `/worktrees/${anchorId}/bogus`), deps)).status, 404)
  const list = await handleNodeApi(request('GET', '/worktrees'), deps)
  assert.equal((list.body as { worktrees: readonly unknown[] }).worktrees.length, 1, 'the checkout survived')
})

/**
 * Cut one worktree through the API over a recording fake daemon.
 * @param overrides - daemon methods this case needs an answer for.
 * @returns the connected context plus the anchor id and every method asked for.
 */
async function cutWorktree(overrides: Readonly<Record<string, (params: never) => unknown>> = {}) {
  const calls: string[] = []
  const inner = daemon(overrides)
  const channel: NodeChannel = {
    ...inner,
    request: ((method: keyof WireMethods, params: never) => {
      calls.push(method)
      return inner.request(method, params)
    }) as NodeChannel['request'],
  }
  const context = await connected(channel)
  const created = await handleNodeApi(
    request('POST', '/worktrees', { nodeId: context.nodeId, repoPath: '/srv/app', name: 'x' }),
    context.deps,
  )
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const anchorId = (created.body as { worktree: { anchorId: string } }).worktree.anchorId
  return { ...context, anchorId, calls }
}

/** A fake daemon whose repository probe succeeds unless overridden. */
function daemon(overrides: Readonly<Record<string, (params: never) => unknown>> = {}): NodeChannel {
  return {
    onPipeFrame: () => () => {},
    request: ((method: string, params: { path: string; repoPath: string; worktreePath: string }) => {
      const override = overrides[method]
      if (override !== undefined) return Promise.resolve(override(params as never)) as never
      if (method === 'fs.resolve') return Promise.resolve({ canonicalPath: params.path }) as never
      if (method === 'fs.stat') return Promise.resolve({ version: '1', type: 'directory' }) as never
      if (method === 'git.repoState') return Promise.resolve({ branch: 'main', clean: true }) as never
      // The daemon reports where the checkout actually landed.
      if (method === 'git.worktreeAdd') return Promise.resolve({ path: params.worktreePath, branch: 'worktree/x' }) as never
      return Promise.reject(new Error(`unexpected ${method}`)) as never
    }) as NodeChannel['request'],
  }
}

/** A registry holding one node already connected to a fake daemon. */
async function connected(channel: NodeChannel) {
  const context = await setup({
    connect: () => Promise.resolve({
      info: DAEMON_INFO,
      channel,
      close: () => {},
    }),
  })
  const created = await handleNodeApi(request('POST', '/nodes', { ssh: { target: 'a' }, token: 't' }), context.deps)
  const nodeId = asNodeId((created.body as { node: { nodeId: string } }).node.nodeId)
  await handleNodeApi(request('POST', `/nodes/${nodeId}/connect`), context.deps)
  return { ...context, nodeId }
}

test('an empty repository store lists no repositories', async () => {
  const { deps } = await setup()
  assert.deepEqual(await handleNodeApi(request('GET', '/repos'), deps), {
    status: 200,
    body: { repos: [] },
  })
})

test('registering a repository requires its machine and path', async () => {
  const { deps } = await setup()
  for (const body of [{ repoPath: '/srv/app' }, { nodeId: asNodeId('n1') }]) {
    assert.equal((await handleNodeApi(request('POST', '/repos', body), deps)).status, 400)
  }
})

test('registering a repository on an unknown machine is a 404', async () => {
  const { deps } = await setup()
  const response = await handleNodeApi(request('POST', '/repos', { nodeId: asNodeId('nope'), repoPath: '/srv/app' }), deps)
  assert.equal(response.status, 404)
})

test('registering a repository without a connection is a conflict', async () => {
  const { deps } = await setup()
  const created = await handleNodeApi(request('POST', '/nodes', { ssh: { target: 'a' }, token: 't' }), deps)
  const nodeId = asNodeId((created.body as { node: { nodeId: string } }).node.nodeId)
  const response = await handleNodeApi(request('POST', '/repos', { nodeId, repoPath: '/srv/app' }), deps)
  assert.equal(response.status, 409)
})

test('a registered path is canonicalized and named from the machine', async () => {
  const { deps, repos, nodeId } = await connected(daemon())
  const response = await handleNodeApi(
    request('POST', '/repos', { nodeId, repoPath: '/srv/app' }),
    deps,
  )
  assert.equal(response.status, 201)
  assert.equal(repos.list()[0]?.repoPath, '/srv/app')
  assert.equal(repos.list()[0]?.name, 'app')
  assert.equal((response.body as { repo: { git: boolean } }).repo.git, true)
})

test('re-registering the same path answers 200 and keeps one record', async () => {
  const channel = daemon()
  const { deps, repos, nodeId } = await connected(channel)
  const first = await handleNodeApi(request('POST', '/repos', { nodeId, repoPath: '/srv/app' }), deps)
  const second = await handleNodeApi(request('POST', '/repos', { nodeId, repoPath: '/srv/app' }), deps)

  assert.equal(first.status, 201)
  assert.equal(second.status, 200)
  assert.equal(repos.list().length, 1)
})

test('a directory that is not a git repository registers as a plain one', async () => {
  const channel = daemon({
    'git.repoState': () => {
      throw new NodeRequestError({ code: 'GIT_NOT_A_REPOSITORY', message: 'not a git repository' })
    },
  })
  const { deps, repos, nodeId } = await connected(channel)
  const response = await handleNodeApi(request('POST', '/repos', { nodeId, repoPath: '/srv/plain' }), deps)

  assert.equal(response.status, 201)
  assert.equal((response.body as { repo: { git: boolean } }).repo.git, false)
  assert.deepEqual(repos.list().map(repo => repo.repoPath), ['/srv/plain'])
})

test('a file is not something to register', async () => {
  const channel = daemon({
    'fs.stat': () => ({ version: '1', type: 'file' }),
  })
  const { deps, repos, nodeId } = await connected(channel)
  const response = await handleNodeApi(request('POST', '/repos', { nodeId, repoPath: '/srv/README' }), deps)

  assert.equal(response.status, 400)
  assert.match(String((response.body as { error: string }).error), /not a directory/)
  assert.deepEqual(repos.list(), [])
})

test('opening a directory maps it onto itself as a workspace', async () => {
  const { deps, repos, anchors, registered, nodeId } = await connected(daemon())
  const repo = await repos.upsert({ nodeId, repoPath: '/srv/plain' })

  const response = await handleNodeApi(request('POST', `/repos/${repo.repoId}/open`), deps)
  const anchor = (response.body as { anchor: { kind: string; remoteRoot: string; anchorPath: string } }).anchor

  assert.equal(response.status, 200)
  assert.equal(anchor.kind, 'directory')
  assert.equal(anchor.remoteRoot, '/srv/plain', 'the directory is its own remote root')
  assert.deepEqual(anchors.list().map(entry => entry.kind), ['directory'])
  assert.equal(registered.has(String(anchors.list()[0]?.anchorId)), true, 'and it is open')

  await handleNodeApi(request('POST', `/repos/${repo.repoId}/open`), deps)
  assert.equal(anchors.list().length, 1)
})

test('closing a directory drops its anchor and its registration', async () => {
  const { deps, repos, anchors, registered, nodeId } = await connected(daemon())
  const repo = await repos.upsert({ nodeId, repoPath: '/srv/plain' })
  await handleNodeApi(request('POST', `/repos/${repo.repoId}/open`), deps)
  const anchorId = String(anchors.list()[0]?.anchorId)

  const response = await handleNodeApi(request('POST', `/repos/${repo.repoId}/close`), deps)

  assert.equal(response.status, 200)
  assert.equal((response.body as { closed: boolean }).closed, true)
  assert.deepEqual(anchors.list(), [])
  assert.equal(registered.has(anchorId), false)
})

test('forgetting a repository closes the directory it was opened as', async () => {
  const { deps, repos, anchors, nodeId } = await connected(daemon())
  const repo = await repos.upsert({ nodeId, repoPath: '/srv/plain' })
  await handleNodeApi(request('POST', `/repos/${repo.repoId}/open`), deps)

  const response = await handleNodeApi(request('DELETE', `/repos/${repo.repoId}`), deps)

  assert.equal(response.status, 200, 'an open directory is not work that would be stranded')
  assert.deepEqual(anchors.list(), [])
  assert.deepEqual(repos.list(), [])
})

test('an offline machine still lists its repositories and says why state is missing', async () => {
  const { deps, repos } = await setup()
  const created = await handleNodeApi(request('POST', '/nodes', { ssh: { target: 'a' }, token: 't' }), deps)
  const nodeId = asNodeId((created.body as { node: { nodeId: string } }).node.nodeId)
  await repos.upsert({ nodeId, repoPath: '/srv/app' })

  const response = await handleNodeApi(request('GET', '/repos'), deps)
  const report = (response.body as { repos: readonly { repo: { name: string }; error?: string }[] }).repos[0]
  assert.equal(response.status, 200)
  assert.equal(report?.repo.name, 'app')
  assert.match(String(report?.error), /not connected/)
})

test('removing an unknown repository is a 404', async () => {
  const { deps } = await setup()
  assert.equal((await handleNodeApi(request('DELETE', '/repos/nope'), deps)).status, 404)
})

test('forgetting a repository is refused while worktrees still belong to it', async () => {
  const { deps, repos, anchors, nodeId } = await connected(daemon())
  const repo = await repos.upsert({ nodeId, repoPath: '/srv/app' })
  await anchors.create({
    nodeId,
    kind: 'worktree',
    name: 'x',
    repoPath: '/srv/app',
    remoteRoot: '/srv/checkouts/app/x',
    branch: 'worktree/x',
  })

  const response = await handleNodeApi(request('DELETE', `/repos/${repo.repoId}`), deps)
  assert.equal(response.status, 409)
  assert.match(String((response.body as { error: string }).error), /1 worktree/)
  assert.equal(repos.list().length, 1)
})

test('forgetting a free repository drops exactly that record', async () => {
  const { deps, repos, nodeId } = await connected(daemon())
  const repo = await repos.upsert({ nodeId, repoPath: '/srv/app' })

  const response = await handleNodeApi(request('DELETE', `/repos/${repo.repoId}`), deps)
  assert.deepEqual(response, { status: 200, body: { deleted: true } })
  assert.deepEqual(repos.list(), [])
})

test('creating a worktree from a repository id resolves its machine and path', async () => {
  const { deps, repos, anchors, nodeId } = await connected(daemon())
  const repo = await repos.upsert({ nodeId, repoPath: '/srv/app' })

  const response = await handleNodeApi(request('POST', '/worktrees', { repoId: repo.repoId, name: 'x' }), deps)
  assert.equal(response.status, 201)
  assert.equal(anchors.list()[0]?.repoPath, '/srv/app')
  assert.equal(anchors.list()[0]?.nodeId, nodeId)
})

test('creating a worktree from an unknown repository id is a 404', async () => {
  const { deps, anchors } = await connected(daemon())
  const response = await handleNodeApi(request('POST', '/worktrees', { repoId: asRepoId('nope'), name: 'x' }), deps)
  assert.equal(response.status, 404)
  assert.deepEqual(anchors.list(), [])
})

test('a worktree cut by path still registers its repository', async () => {
  const { deps, repos, nodeId } = await connected(daemon())
  const response = await handleNodeApi(
    request('POST', '/worktrees', { nodeId, repoPath: '/srv/app', name: 'x' }),
    deps,
  )

  assert.equal(response.status, 201)
  assert.deepEqual(repos.list().map(repo => repo.repoPath), ['/srv/app'])
})

test('removing a machine drops its repository registrations', async () => {
  const { deps, repos, nodeId } = await connected(daemon())
  await repos.upsert({ nodeId, repoPath: '/srv/app' })

  await handleNodeApi(request('DELETE', `/nodes/${nodeId}`), deps)
  assert.deepEqual(repos.list(), [])
})

test('the local machine cannot be removed or reconfigured', async () => {
  const { deps, registry } = await setup()

  assert.equal((await handleNodeApi(request('DELETE', `/nodes/${LOCAL_NODE_ID}`), deps)).status, 400)
  assert.equal(
    (await handleNodeApi(request('PATCH', `/nodes/${LOCAL_NODE_ID}`, { title: 'Mine' }), deps)).status,
    400,
  )
  assert.equal(registry.get(LOCAL_NODE_ID)?.title, 'Local', 'and it is unchanged')
})

test('connecting the local machine answers its readiness without a connection', async () => {
  const { deps } = await setup()
  const response = await handleNodeApi(request('POST', `/nodes/${LOCAL_NODE_ID}/connect`), deps)

  assert.deepEqual(response, { status: 200, body: { status: { nodeId: LOCAL_NODE_ID, state: 'ready' } } })
})

test('browsing this host lists its directories without a daemon', async () => {
  const { deps } = await setup()
  await mkdir(join(dir, 'projects'), { recursive: true })
  await writeFile(join(dir, 'notes.txt'), 'x', 'utf8')

  const response = await handleNodeApi(
    request('GET', `/nodes/${LOCAL_NODE_ID}/dirs`, undefined, `path=${encodeURIComponent(dir)}`),
    deps,
  )
  const body = response.body as { path: string; entries: readonly { name: string; type: string; path: string }[] }

  assert.equal(response.status, 200)
  assert.equal(body.path, await realpath(dir))
  const entries = body.entries.map(entry => [entry.name, entry.type])
  assert.ok(entries.some(entry => entry[0] === 'notes.txt' && entry[1] === 'file'), String(entries))
  assert.ok(entries.some(entry => entry[0] === 'projects' && entry[1] === 'directory'), String(entries))
  assert.equal(
    body.entries.find(entry => entry.name === 'projects')?.path,
    join(await realpath(dir), 'projects'),
  )
})

test('a request without a path browses this host from its home directory', async () => {
  const { deps } = await setup()
  const response = await handleNodeApi(request('GET', `/nodes/${LOCAL_NODE_ID}/dirs`, undefined, 'path='), deps)
  assert.deepEqual((response.body as { path: string }).path, await realpath(homedir()))
})

test('a local repository reports its git state, and a plain directory does not', async () => {
  const { deps } = await setup()
  const repo = await repositoryAt(join(dir, 'repo'))
  const plain = join(dir, 'plain')
  await mkdir(plain, { recursive: true })

  const registered = await handleNodeApi(
    request('POST', '/repos', { nodeId: LOCAL_NODE_ID, repoPath: repo }),
    deps,
  )
  assert.equal(registered.status, 201)
  assert.equal((registered.body as { repo: { git: boolean } }).repo.git, true)

  const directory = await handleNodeApi(
    request('POST', '/repos', { nodeId: LOCAL_NODE_ID, repoPath: plain }),
    deps,
  )
  assert.equal(directory.status, 201)
  assert.equal((directory.body as { repo: { git: boolean } }).repo.git, false)

  const missing = await handleNodeApi(
    request('POST', '/repos', { nodeId: LOCAL_NODE_ID, repoPath: join(dir, 'nope') }),
    deps,
  )
  assert.equal(missing.status, 400)
  assert.match(String((missing.body as { error: string }).error), /does not exist on that machine/)
})

test('a local worktree is cut, listed, and removed through the routes', async () => {
  const { deps, repos } = await setup()
  const repo = await repositoryAt(join(dir, 'route-repo'))

  const created = await handleNodeApi(
    request('POST', '/worktrees', { nodeId: LOCAL_NODE_ID, repoPath: repo, name: 'login' }),
    deps,
  )
  assert.equal(created.status, 201)
  const anchor = (created.body as { worktree: { anchorId: string; anchorPath: string } }).worktree
  // Git records the checkout under its resolved spelling, and this suite's
  // scratch directory is reached through a symlink (`/var` on macOS is one).
  assert.equal(anchor.anchorPath, join(await realpath(dir), 'checkouts', 'route-repo', 'login'))
  assert.deepEqual(repos.list().map(record => record.repoPath), [repo])

  const listed = await handleNodeApi(request('GET', '/worktrees'), deps)
  const body = listed.body as { worktrees: readonly { anchor: { anchorId: string; kind: string } }[] }
  // The repository's own directory is a row too: opening it is how a session
  // works in the repository itself.
  assert.deepEqual(body.worktrees.map(entry => entry.anchor.kind), ['directory', 'worktree'])
  assert.ok(body.worktrees.some(entry => entry.anchor.anchorId === anchor.anchorId))

  // Forgetting the repository while its checkout exists is refused, as it is
  // for a machine: the checkout would be stranded with no row to remove it.
  const repoId = repos.list()[0]!.repoId
  assert.equal((await handleNodeApi(request('DELETE', `/repos/${repoId}`), deps)).status, 409)

  const removed = await handleNodeApi(
    request('DELETE', `/worktrees/${anchor.anchorId}`, undefined, 'force=true&deleteBranch=false'),
    deps,
  )
  assert.equal(removed.status, 200)
  assert.equal(existsSync(anchor.anchorPath), false)
})

test('a local directory opens as a workspace and closes again', async () => {
  const { deps, registered } = await setup()
  const repo = await repositoryAt(join(dir, 'open-repo'))
  const registeredRepo = await handleNodeApi(
    request('POST', '/repos', { nodeId: LOCAL_NODE_ID, repoPath: repo }),
    deps,
  )
  const repoId = (registeredRepo.body as { repo: { repo: { repoId: string } } }).repo.repo.repoId

  const opened = await handleNodeApi(request('POST', `/repos/${repoId}/open`), deps)
  assert.equal(opened.status, 200)
  assert.equal((opened.body as { anchor: { anchorPath: string } }).anchor.anchorPath, repo)

  const closed = await handleNodeApi(request('POST', `/repos/${repoId}/close`), deps)
  assert.equal(closed.status, 200)
  assert.equal((closed.body as { closed: boolean }).closed, true)
  assert.equal(registered.size, 0)
})

test('a repository reports the checkouts git already has', async () => {
  const { deps, repos, nodeId } = await connected(daemon({
    'git.worktreeList': () => [
      { path: '/srv/app', branch: 'main', head: 'abc', main: true },
      { path: '/srv/elsewhere/login', branch: 'worktree/login', head: 'abc', main: false },
      { path: '/srv/elsewhere/detached', branch: null, head: 'abc', main: false },
    ],
  }))
  const repo = await repos.upsert({ nodeId, repoPath: '/srv/app' })

  const response = await handleNodeApi(request('GET', `/repos/${repo.repoId}/worktrees`), deps)

  assert.equal(response.status, 200)
  assert.deepEqual((response.body as { worktrees: readonly unknown[] }).worktrees, [
    { path: '/srv/elsewhere/login', name: 'login', branch: 'worktree/login', registered: false },
    { path: '/srv/elsewhere/detached', name: 'detached', branch: '', registered: false },
  ])
})

test('an existing checkout is adopted and released through the routes', async () => {
  const { deps, repos, anchors, nodeId } = await connected(daemon({
    'git.worktreeList': () => [
      { path: '/srv/app', branch: 'main', head: 'abc', main: true },
      { path: '/srv/elsewhere/login', branch: 'worktree/login', head: 'abc', main: false },
    ],
  }))
  const repo = await repos.upsert({ nodeId, repoPath: '/srv/app' })

  const adopted = await handleNodeApi(
    request('POST', `/repos/${repo.repoId}/worktrees`, { path: '/srv/elsewhere/login' }),
    deps,
  )
  assert.equal(adopted.status, 201)
  const anchor = (adopted.body as { worktree: { anchorId: string; remoteRoot: string; branch: string } }).worktree
  assert.equal(anchor.remoteRoot, '/srv/elsewhere/login')
  assert.equal(anchor.branch, 'worktree/login')

  const listed = await handleNodeApi(request('GET', '/worktrees'), deps)
  const rows = (listed.body as { worktrees: readonly { anchor: { anchorId: string }; managed: boolean }[] }).worktrees
  assert.equal(rows.find(row => row.anchor.anchorId === anchor.anchorId)?.managed, false)

  const released = await handleNodeApi(request('POST', `/worktrees/${anchor.anchorId}/release`), deps)
  assert.equal(released.status, 200)
  assert.deepEqual(anchors.list(), [], 'the record is gone, and git was never asked to change anything')
})

test('a worktree may be placed by the caller, with an absolute path', async () => {
  const { deps, repos, nodeId } = await connected(daemon())
  const repo = await repos.upsert({ nodeId, repoPath: '/srv/app' })

  const placed = await handleNodeApi(
    request('POST', '/worktrees', { repoId: repo.repoId, name: 'login', path: '/srv/mine/login' }),
    deps,
  )
  assert.equal(placed.status, 201)
  assert.equal(
    (placed.body as { worktree: { remoteRoot: string; branch: string } }).worktree.remoteRoot,
    '/srv/mine/login',
  )

  const relative = await handleNodeApi(
    request('POST', '/worktrees', { repoId: repo.repoId, name: 'other', path: 'mine/other' }),
    deps,
  )
  assert.equal(relative.status, 400)

  // The panel needs the machine's root to show a default, so the report carries
  // it whenever the machine's home is already known.
  const reported = await handleNodeApi(request('GET', `/repos/${repo.repoId}`), deps)
  assert.equal((reported.body as { repo: { worktreeRoot?: string } }).repo.worktreeRoot, '/srv/checkouts')
})

test('the terminal list answers one session with the shells the agent tool addresses', async () => {
  const { deps, terminals } = await setup()
  await terminals.open('s1', '/w/live', { cols: 80, rows: 24 })
  await terminals.open('s2', '/w/other', { cols: 120, rows: 40 })

  const response = await handleNodeApi(request('GET', '/terminals', undefined, 'sessionId=s1'), deps)

  assert.equal(response.status, 200)
  const listed = (response.body as { terminals: readonly Record<string, unknown>[] }).terminals
  assert.deepEqual(listed.map(entry => entry['id']), ['t1'], 'only this session\'s terminals')
  assert.equal(listed[0]?.['label'], 'Terminal 1')
  assert.equal(listed[0]?.['state'], 'running')
  assert.equal(listed[0]?.['machine'], 'Local')
  assert.equal(listed[0]?.['cwd'], '/w/live')
  assert.equal(listed[0]?.['pid'], 4242)
})

test('listing terminals without a session is a client error', async () => {
  const { deps } = await setup()
  assert.equal((await handleNodeApi(request('GET', '/terminals'), deps)).status, 400)
  assert.equal((await handleNodeApi(request('GET', '/terminals', undefined, 'sessionId='), deps)).status, 400)
})

test('closing a terminal ends it, and an unknown id is a 404', async () => {
  const { deps, terminals, terminations } = await setup()
  await terminals.open('s1', '/w/live', { cols: 80, rows: 24 })

  const unknown = await handleNodeApi(request('POST', '/terminals/t9/close'), deps)
  assert.equal(unknown.status, 404)
  assert.equal(terminations(), 0, 'the refusal ended nothing')

  const closed = await handleNodeApi(request('POST', '/terminals/t1/close'), deps)
  assert.deepEqual(closed, { status: 200, body: { closed: true } })
  assert.equal(terminations(), 1)
  assert.deepEqual(terminals.listFor('s1'), [], 'the ended terminal left the table')
  // A close is a write, so a read of the same path is the wrong verb.
  assert.equal((await handleNodeApi(request('GET', '/terminals/t1/close'), deps)).status, 405)
})
