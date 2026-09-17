/**
 * The lifecycle is where a remote checkout and a local anchor have to stay in
 * step, so its cases are about ordering and partial failure: an anchor is never
 * recorded for a checkout that failed, never kept for one that is gone, and a
 * branch that outlives its checkout is reported rather than hidden.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { afterEach, beforeEach, test } from 'node:test'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createAnchorStore } from '../../src/storage/anchors.ts'
import type { AnchorStore } from '../../src/storage/anchors.ts'
import { createRepoStore } from '../../src/storage/repos.ts'
import type { RepoStore } from '../../src/storage/repos.ts'
import type { NodeChannel } from '../../src/remote/client.ts'
import { NodeRequestError } from '../../src/remote/client.ts'
import { createWorktreeManager } from '../../src/models/worktrees.ts'
import type { WorktreeManager, WorktreeStatus } from '../../src/models/worktrees.ts'
import { asNodeId, LOCAL_NODE_ID } from '../../src/storage/nodes.ts'
import { repositoryAt } from '../git.ts'
import { asAnchorId } from '../../src/storage/anchors.ts'
import type { WorktreeAnchor } from '../../src/storage/anchors.ts'

const run = promisify(execFile)

let root: string
let anchors: AnchorStore
let repos: RepoStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drw-worktree-'))
  anchors = createAnchorStore({ root })
  await anchors.load()
  repos = createRepoStore({ file: join(root, 'repos.json') })
  await repos.load()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/**
 * A channel recording every call and answering from a script.
 *
 * An answer is the value to resolve with, an `Error` to reject with, or a
 * function of the call's parameters.
 */
function stubChannel(answers: Record<string, unknown> = {}) {
  const calls: { method: string; params: unknown }[] = []
  const channel: NodeChannel = {
    onPipeFrame: () => () => {},
    request(method, params) {
      calls.push({ method, params })
      const answer = answers[method]
      if (answer instanceof Error) return Promise.reject(answer)
      if (typeof answer === 'function') {
        return Promise.resolve((answer as (params: unknown) => unknown)(params)) as never
      }
      if (answer === undefined) return Promise.reject(new Error(`no answer for ${method}`)) as never
      return Promise.resolve(answer) as never
    },
  }
  return { channel, calls }
}

/** A manager over one stub channel, plus the calls it recorded. */
function managerWith(answers: Record<string, unknown>, nodeId = 'n1'): { manager: WorktreeManager; calls: { method: string; params: unknown }[] } {
  // `create` also resolves the repository path, so every script answers that
  // unless a case overrides it.
  const { channel, calls } = stubChannel({
    'fs.resolve': (params: { path: string }) => ({ canonicalPath: params.path }),
    ...answers,
  })
  return {
    manager: createWorktreeManager({
      anchors,
      repos,
      channel: id => (id === nodeId ? channel : undefined),
      isLocalNode: () => false,
      worktreeRoot: () => CHECKOUT_ROOT,
    }),
    calls,
  }
}

/**
 * A manager over one stub channel and a workspace registry that records what
 * it was asked to register.
 * @param answers - the channel's scripted answers.
 * @returns the manager and the registry's journal.
 */
function managerWithWorkspace(answers: Record<string, unknown>): {
  manager: WorktreeManager
  opened: string[]
  closed: string[]
  calls: { method: string; params: unknown }[]
} {
  const { channel, calls } = stubChannel({
    'fs.resolve': (params: { path: string }) => ({ canonicalPath: params.path }),
    ...answers,
  })
  const opened: string[] = []
  const closed: string[] = []
  const live = new Set<string>()
  return {
    opened,
    closed,
    calls,
    manager: createWorktreeManager({
      anchors,
      repos,
      channel: id => (id === 'n1' ? channel : undefined),
      isLocalNode: () => false,
      worktreeRoot: () => CHECKOUT_ROOT,
      workspace: {
        register: anchor => { opened.push(anchor.anchorPath); live.add(anchor.anchorPath); return Promise.resolve() },
        unregister: anchor => { closed.push(anchor.anchorPath); live.delete(anchor.anchorPath); return Promise.resolve() },
        registered: anchor => Promise.resolve(live.has(anchor.anchorPath)),
      },
    }),
  }
}

const draft = { nodeId: asNodeId('n1'), repoPath: '/srv/app', name: 'login' }

/** The root managed checkouts are cut under in these cases. */
const CHECKOUT_ROOT = '/srv/checkouts'

test('create cuts the checkout and records an anchor at the reported path', async () => {
  const { manager, calls } = managerWith({
    'git.worktreeAdd': { path: '/srv/checkouts/app/login', branch: 'worktree/login', head: 'abc', main: false },
  })

  const anchor = await manager.create(draft)

  assert.deepEqual(calls, [
    { method: 'fs.resolve', params: { path: '/srv/app' } },
    {
      method: 'git.worktreeAdd',
      params: {
        repoPath: '/srv/app',
        worktreePath: '/srv/checkouts/app/login',
        branch: 'worktree/login',
      },
    },
  ])
  assert.equal(anchor.remoteRoot, '/srv/checkouts/app/login')
  assert.equal(anchor.branch, 'worktree/login')
  assert.equal(anchors.list().length, 1)
})

test('an explicit base revision travels to git', async () => {
  const { manager, calls } = managerWith({
    'git.worktreeAdd': { path: '/srv/checkouts/app/login', branch: 'worktree/login', head: 'abc', main: false },
  })
  await manager.create({ ...draft, baseRef: 'origin/main' })
  const add = calls.find(call => call.method === 'git.worktreeAdd')
  assert.equal((add?.params as { baseRef?: string }).baseRef, 'origin/main')
})

test('create cuts under the canonical repository path the daemon reports', async () => {
  const { manager, calls } = managerWith({
    'fs.resolve': { canonicalPath: '/srv/app' },
    'git.worktreeAdd': { path: '/srv/checkouts/app/login', branch: 'worktree/login', head: 'abc', main: false },
  })

  const anchor = await manager.create({ ...draft, repoPath: '/srv/app/' })

  const add = calls.find(call => call.method === 'git.worktreeAdd')
  assert.deepEqual(add?.params, {
    repoPath: '/srv/app',
    worktreePath: '/srv/checkouts/app/login',
    branch: 'worktree/login',
  })
  assert.equal(anchor.repoPath, '/srv/app', 'the anchor carries the same spelling the guards look up')
})

test('create records the repository the worktree came from', async () => {
  const { manager } = managerWith({
    'git.worktreeAdd': { path: '/srv/checkouts/app/login', branch: 'worktree/login', head: 'abc', main: false },
  })
  await manager.create(draft)

  assert.deepEqual(repos.list().map(repo => repo.repoPath), ['/srv/app'])
})

test('create keeps the name a person gave an already-registered repository', async () => {
  await repos.upsert({ nodeId: asNodeId('n1'), repoPath: '/srv/app', name: 'the app' })
  const { manager } = managerWith({
    'git.worktreeAdd': { path: '/srv/checkouts/app/login', branch: 'worktree/login', head: 'abc', main: false },
  })
  await manager.create(draft)

  assert.equal(repos.list().length, 1)
  assert.equal(repos.list()[0]?.name, 'the app')
})

test('the path the daemon reported wins over the computed one', async () => {
  const { manager } = managerWith({
    'git.worktreeAdd': { path: '/elsewhere/login', branch: 'worktree/login', head: 'abc', main: false },
  })
  const anchor = await manager.create(draft)
  assert.equal(anchor.remoteRoot, '/elsewhere/login')
})

test('a refused add records no anchor', async () => {
  const { manager } = managerWith({
    'git.worktreeAdd': new NodeRequestError({ code: 'GIT_WORKTREE_EXISTS', message: 'already there' }),
  })

  await assert.rejects(() => manager.create(draft), /already there/)
  assert.deepEqual(anchors.list(), [])
})

test('an offline node fails with a typed error and records nothing', async () => {
  const { manager } = managerWith({}, 'other')
  await assert.rejects(() => manager.create(draft), /is not connected/)
  assert.deepEqual(anchors.list(), [])
})

test('list answers from held records even when the machine\'s git is quiet', async () => {
  const { manager } = managerWith({
    'git.worktreeAdd': { path: '/srv/checkouts/app/login', branch: 'worktree/login', head: 'abc', main: false },
  })
  await manager.create(draft)

  const statuses = await manager.list()
  assert.equal(statuses.length, 1)
  const listed = statuses[0]?.anchor
  assert.ok(listed?.kind === 'worktree', 'the anchor is a worktree')
  assert.equal(listed.branch, 'worktree/login')
  assert.equal(statuses[0]?.open, false, 'no registry is composed here, so nothing is open')
  assert.equal(statuses[0]?.error, undefined)
})

test('list reports an offline node per anchor instead of failing the whole listing', async () => {
  const { manager: online } = managerWith({
    'git.worktreeAdd': { path: '/srv/checkouts/app/login', branch: 'worktree/login', head: 'abc', main: false },
  })
  await online.create(draft)

  const offline = createWorktreeManager({
    anchors,
    repos,
    channel: () => undefined,
    isLocalNode: () => false,
    worktreeRoot: () => CHECKOUT_ROOT,
  })
  const statuses = await offline.list()
  assert.match(String(statuses[0]?.error), /is not connected/)
})

test('remove drops the checkout first and the anchor second', async () => {
  const { manager, calls } = managerWith({
    'git.worktreeAdd': { path: '/srv/checkouts/app/login', branch: 'worktree/login', head: 'abc', main: false },
    'git.worktreeRemove': {},
  })
  const anchor = await manager.create(draft)
  const removal = await manager.remove(anchor.anchorId, { force: true, deleteBranch: false })

  assert.deepEqual(calls.map(call => call.method), ['fs.resolve', 'git.worktreeAdd', 'git.worktreeRemove'])
  assert.equal(removal.branchDeleted, false)
  assert.deepEqual(anchors.list(), [])
})

test('removing with deleteBranch also deletes the branch', async () => {
  const { manager, calls } = managerWith({
    'git.worktreeAdd': { path: '/srv/checkouts/app/login', branch: 'worktree/login', head: 'abc', main: false },
    'git.worktreeRemove': {},
    'git.branchDelete': {},
  })
  const anchor = await manager.create(draft)
  const removal = await manager.remove(anchor.anchorId, { force: false, deleteBranch: true })

  assert.equal(removal.branchDeleted, true)
  assert.deepEqual(calls.at(-1), {
    method: 'git.branchDelete',
    params: { repoPath: '/srv/app', branch: 'worktree/login', force: false },
  })
})

test('a branch that outlives its checkout is reported, not hidden', async () => {
  const { manager } = managerWith({
    'git.worktreeAdd': { path: '/srv/checkouts/app/login', branch: 'worktree/login', head: 'abc', main: false },
    'git.worktreeRemove': {},
    'git.branchDelete': new NodeRequestError({ code: 'GIT_DIRTY', message: 'branch is not fully merged' }),
  })
  const anchor = await manager.create(draft)
  const removal = await manager.remove(anchor.anchorId, { force: false, deleteBranch: true })

  assert.equal(removal.branchDeleted, false)
  assert.match(String(removal.branchError), /not fully merged/)
  assert.deepEqual(anchors.list(), [])
})

test('removal unregisters the workspace while the anchor directory is still there', async () => {
  // The registry resolves an entry by path, so unregistering after the anchor
  // directory is gone would leave a dead entry in the sidebar and in the
  // store — the exact state a person cannot clear from the section.
  const { channel } = stubChannel({
    'fs.resolve': (params: { path: string }) => ({ canonicalPath: params.path }),
    'git.worktreeAdd': { path: '/srv/checkouts/app/login', branch: 'worktree/login', head: 'abc', main: false },
    'git.worktreeRemove': {},
  })
  const seen: boolean[] = []
  const manager = createWorktreeManager({
    anchors,
    repos,
    channel: id => (id === 'n1' ? channel : undefined),
    isLocalNode: () => false,
    worktreeRoot: () => CHECKOUT_ROOT,
    workspace: {
      register: () => Promise.resolve(),
      unregister: anchor => { seen.push(existsSync(anchor.anchorPath)); return Promise.resolve() },
      registered: () => Promise.resolve(false),
    },
  })
  const anchor = await manager.create(draft)

  await manager.remove(anchor.anchorId, { force: false, deleteBranch: false })

  assert.deepEqual(seen, [true], 'the entry was resolved before its directory went away')
  assert.equal(existsSync(anchor.anchorPath), false, 'and the anchor is gone afterwards')
})

test('closing and opening a worktree move only its workspace registration', async () => {
  const { manager, opened, closed } = managerWithWorkspace({
    'git.worktreeAdd': { path: '/srv/checkouts/app/login', branch: 'worktree/login', head: 'abc', main: false },
  })
  const anchor = await manager.create(draft)
  // Creation registers the workspace, so the checkout starts open.
  assert.deepEqual(opened, [anchor.anchorPath])
  assert.equal((await manager.list())[0]?.open, true)

  await manager.close(anchor.anchorId)
  assert.deepEqual(closed, [anchor.anchorPath])
  assert.equal((await manager.list())[0]?.open, false)
  // Closing says nothing about the machine: the checkout is still there.
  assert.equal(anchors.list().length, 1)

  await manager.open(anchor.anchorId)
  assert.equal((await manager.list())[0]?.open, true)
})

test('opening a directory maps it onto itself and registers it', async () => {
  const { manager, opened, closed } = managerWithWorkspace({})

  const anchor = await manager.openDirectory({ nodeId: asNodeId('n1'), repoPath: '/srv/plain' })

  assert.equal(anchor.kind, 'directory')
  assert.equal(anchor.remoteRoot, '/srv/plain', 'the directory is its own remote root')
  assert.equal('branch' in anchor, false, 'a directory is on no branch')
  assert.deepEqual(opened, [anchor.anchorPath])
  // Opening again registers the same anchor instead of cutting a second one.
  await manager.openDirectory({ nodeId: asNodeId('n1'), repoPath: '/srv/plain' })
  assert.equal(anchors.list().length, 1)
  assert.deepEqual(closed, [])
})

test('closing a directory drops its anchor and leaves the machine alone', async () => {
  const { manager, calls } = managerWithWorkspace({})
  const anchor = await manager.openDirectory({ nodeId: asNodeId('n1'), repoPath: '/srv/plain' })

  const closed = await manager.closeDirectory({ nodeId: asNodeId('n1'), repoPath: '/srv/plain' })

  assert.equal(closed?.anchorId, anchor.anchorId)
  assert.deepEqual(anchors.list(), [])
  assert.equal(existsSync(anchor.anchorPath), false)
  assert.deepEqual(calls.filter(call => call.method.startsWith('git.')), [], 'git is never asked')
  assert.equal(await manager.closeDirectory({ nodeId: asNodeId('n1'), repoPath: '/srv/plain' }), undefined)
})

test('a directory workspace is not a worktree and is refused as one', async () => {
  const { manager } = managerWithWorkspace({})
  const anchor = await manager.openDirectory({ nodeId: asNodeId('n1'), repoPath: '/srv/plain' })

  await assert.rejects(
    () => manager.remove(anchor.anchorId, { force: true, deleteBranch: false }),
    /close it instead/,
  )
  assert.equal(anchors.list().length, 1, 'the directory is still there')
})

test('opening a directory without a workspace registry says so', async () => {
  const { manager } = managerWith({})
  await assert.rejects(
    () => manager.openDirectory({ nodeId: asNodeId('n1'), repoPath: '/srv/plain' }),
    /no workspace registry/,
  )
  assert.deepEqual(anchors.list(), [], 'and nothing is written')
})

test('opening without a workspace registry says so instead of failing silently', async () => {
  const { manager } = managerWith({
    'git.worktreeAdd': { path: '/srv/checkouts/app/login', branch: 'worktree/login', head: 'abc', main: false },
  })
  const anchor = await manager.create(draft)
  await assert.rejects(() => manager.open(anchor.anchorId), /no workspace registry/)
})

test('an unknown anchor is refused before any remote call', async () => {
  const { manager, calls } = managerWith({})
  await assert.rejects(() => manager.open(asAnchorId('nope')), /no worktree/)
  await assert.rejects(() => manager.close(asAnchorId('nope')), /no worktree/)
  await assert.rejects(() => manager.release(asAnchorId('nope')), /no worktree/)
  assert.deepEqual(calls, [])
})

test('a checkout git already lists can be adopted without touching git', async () => {
  const { manager, calls, opened } = managerWithWorkspace({
    'git.worktreeList': [{ path: '/srv/elsewhere/login', branch: 'worktree/login', head: 'abc', main: false }],
  })
  const ref = { nodeId: asNodeId('n1'), repoPath: '/srv/app' }
  const anchor = await manager.adopt(ref, '/srv/elsewhere/login')

  assert.equal(anchor.kind, 'worktree')
  assert.equal(anchor.remoteRoot, '/srv/elsewhere/login')
  assert.equal(anchor.branch, 'worktree/login')
  assert.equal(anchor.name, 'login')
  assert.deepEqual(opened, [anchor.anchorPath], 'adopting opens it as a workspace')
  // Every call was a read: adoption records what is there, it never writes.
  assert.deepEqual(calls.map(call => call.method), ['fs.resolve', 'git.worktreeList'])
  const rows = worktreesOf(await manager.list())
  assert.equal(rows[0]?.managed, false, 'an adopted checkout is not the plugin\'s to remove')
})

test('adopting a path git does not list is refused', async () => {
  const { manager } = managerWith({ 'git.worktreeList': [] })
  await assert.rejects(
    () => manager.adopt({ nodeId: asNodeId('n1'), repoPath: '/srv/app' }, '/srv/elsewhere/login'),
    /is not a worktree of/,
  )
})

test('adopting one this host already holds only opens it again', async () => {
  const { manager } = managerWithWorkspace({
    'git.worktreeList': [{ path: '/srv/elsewhere/login', branch: 'worktree/login', head: 'abc', main: false }],
  })
  const ref = { nodeId: asNodeId('n1'), repoPath: '/srv/app' }
  const first = await manager.adopt(ref, '/srv/elsewhere/login')
  const again = await manager.adopt(ref, '/srv/elsewhere/login')

  assert.equal(again.anchorId, first.anchorId)
  assert.equal(anchors.list().length, 1, 'no second record for one checkout')
})

test('a managed checkout is flagged, and releasing it leaves the machine alone', async () => {
  const { manager, calls, closed } = managerWithWorkspace({
    'git.worktreeAdd': { path: '/srv/checkouts/app/login', branch: 'worktree/login', head: 'abc', main: false },
  })
  const anchor = await manager.create(draft)
  assert.equal(worktreesOf(await manager.list())[0]?.managed, true)

  calls.length = 0
  await manager.release(anchor.anchorId)

  assert.deepEqual(calls, [], 'releasing asks the machine nothing')
  assert.deepEqual(anchors.list(), [], 'the record is gone')
  assert.deepEqual(closed, [anchor.anchorPath], 'and its workspace went with it')
})

test('existing lists what git has, in order, minus the repository itself', async () => {
  const { manager } = managerWith({
    'git.worktreeList': [
      { path: '/srv/app', branch: 'main', head: 'abc', main: true },
      { path: '/srv/elsewhere/login', branch: 'worktree/login', head: 'abc', main: false },
      { path: '/srv/elsewhere/detached', branch: null, head: 'abc', main: false },
    ],
  })
  const listed = await manager.existing({ nodeId: asNodeId('n1'), repoPath: '/srv/app' })

  assert.deepEqual(listed, [
    { path: '/srv/elsewhere/login', name: 'login', branch: 'worktree/login', registered: false },
    { path: '/srv/elsewhere/detached', name: 'detached', branch: '', registered: false },
  ])
})

test('list reads a machine\'s git for checkouts nobody adopted', async () => {
  const { manager } = managerWith({
    'git.worktreeList': [
      { path: '/srv/app', branch: 'main', head: 'abc', main: true },
      { path: '/srv/elsewhere/login', branch: 'worktree/login', head: 'abc', main: false },
    ],
  })
  await repos.upsert({ nodeId: asNodeId('n1'), repoPath: '/srv/app' })

  const rows = worktreesOf(await manager.list())
  assert.equal(rows.length, 1, 'the checkout git reports is a row')
  assert.equal(rows[0]?.held, false, 'no record is held for it yet')
  assert.equal(rows[0]?.open, false)
  assert.equal(rows[0]?.anchor.name, 'login')
  assert.equal(rows[0]?.anchor.branch, 'worktree/login')
})

test('opening a git-reported checkout adopts it and registers it', async () => {
  const { manager, opened } = managerWithWorkspace({
    'git.worktreeList': [
      { path: '/srv/app', branch: 'main', head: 'abc', main: true },
      { path: '/srv/elsewhere/login', branch: 'worktree/login', head: 'abc', main: false },
    ],
  })
  await repos.upsert({ nodeId: asNodeId('n1'), repoPath: '/srv/app' })
  const row = (await manager.list()).find(status => status.anchor.kind === 'worktree' && !status.held)
  assert.ok(row !== undefined)

  const anchor = await manager.open(row.anchor.anchorId)
  assert.ok(anchor.kind === 'worktree')
  assert.equal(anchor.branch, 'worktree/login')
  assert.equal(anchors.list().length, 1, 'opening records the adopted checkout')
  assert.equal(opened.length, 1, 'and registers it as a workspace')
})

test('a git-reported checkout is removed straight from git, with no record', async () => {
  const { manager, calls } = managerWith({
    'git.worktreeList': [
      { path: '/srv/app', branch: 'main', head: 'abc', main: true },
      { path: '/srv/elsewhere/login', branch: 'worktree/login', head: 'abc', main: false },
    ],
    'git.worktreeRemove': {},
  })
  await repos.upsert({ nodeId: asNodeId('n1'), repoPath: '/srv/app' })
  const row = (await manager.list()).find(status => status.anchor.kind === 'worktree' && !status.held)
  assert.ok(row !== undefined)

  const removal = await manager.remove(row.anchor.anchorId, { force: true, deleteBranch: false })
  assert.equal(removal.branchDeleted, false)
  assert.equal(anchors.list().length, 0)
  assert.ok(calls.some(call => call.method === 'git.worktreeRemove'))
})

test('a repository whose git cannot be read does not blank the rest of the listing', async () => {
  const { manager } = managerWith({
    'git.worktreeAdd': { path: '/srv/checkouts/app/login', branch: 'worktree/login', head: 'abc', main: false },
    'git.worktreeList': new NodeRequestError({ code: 'GIT_COMMAND_FAILED', message: 'git exploded' }),
  })
  await manager.create(draft)

  const statuses = await manager.list()
  assert.equal(statuses.length, 1, 'the held anchor still lists')
  assert.equal(statuses[0]?.error, undefined)
})

test('a caller may place the checkout itself', async () => {
  const { manager, calls } = managerWith({
    'git.worktreeAdd': { path: '/srv/mine/login', branch: 'worktree/login', head: 'abc', main: false },
  })
  const anchor = await manager.create({ ...draft, path: '/srv/mine/login' })

  const add = calls.find(call => call.method === 'git.worktreeAdd')
  assert.equal((add?.params as { worktreePath: string }).worktreePath, '/srv/mine/login')
  assert.equal(anchor.remoteRoot, '/srv/mine/login')
  // The name still names the branch, wherever the checkout landed.
  assert.equal(anchor.branch, 'worktree/login')
})

test('a checkout the plugin placed is its own to remove, root or not', async () => {
  const { manager } = managerWith({
    'git.worktreeAdd': { path: '/srv/mine/login', branch: 'worktree/login', head: 'abc', main: false },
  })
  const anchor = await manager.create({ ...draft, path: '/srv/mine/login' })

  const row = worktreesOf(await manager.list()).find(status => status.anchor.anchorId === anchor.anchorId)
  assert.equal(row?.managed, true, 'the record says the plugin cut it')
})

/** The worktree rows of a listing, narrowed so their branch is readable. */
function worktreesOf(statuses: readonly WorktreeStatus[]): (WorktreeStatus & { anchor: WorktreeAnchor })[] {
  return statuses.filter(
    (status): status is WorktreeStatus & { anchor: WorktreeAnchor } => status.anchor.kind === 'worktree',
  )
}

/** A real repository below this suite's temporary root. */
async function localRepository(name: string): Promise<string> {
  return await repositoryAt(join(root, name))
}

/**
 * A manager over this host, with a workspace registry that journals what it was
 * asked to register.
 *
 * There is no channel to stub here: the local machine's git and filesystem are
 * the code under test, so these cases run the binary on a real fixture.
 * @returns the manager and the two journals.
 */
function localManager(): {
  manager: WorktreeManager
  opened: string[]
  closed: string[]
} {
  const opened: string[] = []
  const closed: string[] = []
  const live = new Set<string>()
  const manager = createWorktreeManager({
    anchors,
    repos,
    channel: () => undefined,
    isLocalNode: () => true,
    worktreeRoot: () => join(root, 'checkouts'),
    workspace: {
      register: anchor => { opened.push(anchor.anchorPath); live.add(anchor.anchorPath); return Promise.resolve() },
      unregister: anchor => { closed.push(anchor.anchorPath); live.delete(anchor.anchorPath); return Promise.resolve() },
      registered: anchor => Promise.resolve(live.has(anchor.anchorPath)),
    },
  })
  return { manager, opened, closed }
}

test('a local worktree is cut here and listed by its own checkout path', async () => {
  const repo = await localRepository('local-repo')
  const { manager, opened } = localManager()
  const anchor = await manager.create({ nodeId: LOCAL_NODE_ID, repoPath: repo, name: 'login' })

  // Git records the checkout under its resolved spelling, and this suite's
  // scratch root is reached through a symlink (`/var` on macOS is one).
  const checkout = join(await realpath(root), 'checkouts', 'local-repo', 'login')
  // No anchor stands in for the checkout: the workspace path *is* the checkout,
  // which is what makes a local session an ordinary local session.
  assert.equal(anchor.anchorPath, checkout)
  assert.equal(anchor.remoteRoot, checkout)
  assert.equal(anchor.branch, 'worktree/login')
  assert.deepEqual(opened, [checkout])
  assert.equal(existsSync(join(checkout, 'README.md')), true)

  const statuses = await manager.list()
  const [worktree] = worktreesOf(statuses)
  assert.equal(worktree?.anchor.anchorId, anchor.anchorId)
  assert.equal(worktree?.open, true)
  assert.equal(statuses.find(status => status.anchor.kind === 'directory')?.anchor.anchorPath, repo)
})

test('a local checkout is remembered by git rather than by the plugin', async () => {
  const repo = await localRepository('survivor')
  const created = await localManager().manager.create({
    nodeId: LOCAL_NODE_ID, repoPath: repo, name: 'login',
  })

  // A manager that has never seen the first one — a restart, or another
  // deployment over the same host — still finds the checkout, because git is
  // where a local worktree is recorded.
  const [later] = worktreesOf(await localManager().manager.list())
  assert.equal(later?.anchor.anchorId, created.anchorId)
  assert.equal(later?.anchor.branch, 'worktree/login')
})

test('a checkout cut by hand is listed like one the panel made', async () => {
  const repo = await localRepository('handmade')
  const elsewhere = join(root, 'handmade-elsewhere')
  await run('git', ['-C', repo, 'worktree', 'add', '-b', 'handmade', elsewhere])
  await repos.upsert({ nodeId: LOCAL_NODE_ID, repoPath: repo })

  const [worktree] = worktreesOf(await localManager().manager.list())
  assert.equal(worktree?.anchor.anchorPath, await realpath(elsewhere))
  assert.equal(worktree?.anchor.branch, 'handmade')
})

test('a plain local directory is a row that refuses a worktree', async () => {
  const plain = await realpath(root)
  await repos.upsert({ nodeId: LOCAL_NODE_ID, repoPath: plain })
  const { manager } = localManager()

  const statuses = await manager.list()
  assert.deepEqual(statuses.map(status => status.anchor.kind), ['directory'])
  await assert.rejects(
    () => manager.create({ nodeId: LOCAL_NODE_ID, repoPath: plain, name: 'x' }),
    /is not a git repository on this machine/,
  )
})

test('removing a local worktree drops the checkout and keeps the branch', async () => {
  const repo = await localRepository('removal')
  const { manager, closed } = localManager()
  const anchor = await manager.create({ nodeId: LOCAL_NODE_ID, repoPath: repo, name: 'login' })

  const removal = await manager.remove(anchor.anchorId, { force: false, deleteBranch: false })

  assert.equal(removal.branchDeleted, false)
  assert.equal(existsSync(anchor.anchorPath), false)
  assert.deepEqual(closed, [anchor.anchorPath])
  assert.deepEqual(worktreesOf(await manager.list()), [])
  const branches = await run('git', ['-C', repo, 'branch', '--list', 'worktree/login'])
  assert.match(branches.stdout, /worktree\/login/)
})

test('closing and opening a local worktree moves only its registration', async () => {
  const repo = await localRepository('registration')
  const { manager, opened, closed } = localManager()
  const anchor = await manager.create({ nodeId: LOCAL_NODE_ID, repoPath: repo, name: 'login' })

  await manager.close(anchor.anchorId)
  assert.deepEqual(closed, [anchor.anchorPath])
  assert.equal(existsSync(anchor.anchorPath), true, 'closing removes nothing from disk')

  await manager.open(anchor.anchorId)
  assert.deepEqual(opened, [anchor.anchorPath, anchor.anchorPath])
})

test('the local repository directory opens and closes as itself', async () => {
  const repo = await localRepository('directory')
  const record = await repos.upsert({ nodeId: LOCAL_NODE_ID, repoPath: repo })
  const { manager, opened, closed } = localManager()
  const ref = { nodeId: LOCAL_NODE_ID, repoPath: repo }

  const anchor = await manager.openDirectory(ref)
  assert.equal(anchor.anchorPath, repo, 'a directory maps onto itself here too')
  assert.deepEqual(opened, [repo])
  // Opening again is idempotent: there is no second record to create.
  assert.equal((await manager.openDirectory(ref)).anchorId, anchor.anchorId)

  assert.equal((await manager.closeDirectory(ref))?.anchorId, anchor.anchorId)
  assert.deepEqual(closed, [repo])
  assert.equal(await manager.closeDirectory(ref), undefined, 'an unregistered directory is already closed')
  assert.equal(record.nodeId, LOCAL_NODE_ID)
})

test('the local machine refuses to remove its repository directory as a worktree', async () => {
  const repo = await localRepository('refusal')
  await repos.upsert({ nodeId: LOCAL_NODE_ID, repoPath: repo })
  const { manager } = localManager()
  const directory = (await manager.list()).find(status => status.anchor.kind === 'directory')

  await assert.rejects(
    () => manager.remove(directory!.anchor.anchorId, { force: true, deleteBranch: false }),
    /is the repository directory, not a worktree/,
  )
  assert.equal(existsSync(repo), true)
})
