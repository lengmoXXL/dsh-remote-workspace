/**
 * The worktrees the panel reads straight from git.
 *
 * A checkout a machine's git already knows is a row whether or not this plugin
 * ever cut it. These cases drive the three things that follow from that: opening
 * the row adopts the checkout, releasing it leaves the checkout for git to list
 * again, and removing the row takes the checkout away.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { startAgent } from './harness.ts'
import type { TestAgent } from './harness.ts'
import { createAnchorStore } from '../../src/storage/anchors.ts'
import type { AnchorRecord, AnchorStore } from '../../src/storage/anchors.ts'
import { createRepoStore } from '../../src/storage/repos.ts'
import type { RepoStore } from '../../src/storage/repos.ts'
import { connectNode } from '../../src/remote/client.ts'
import type { ConnectedNode } from '../../src/remote/client.ts'
import { createWorktreeManager } from '../../src/models/worktrees.ts'
import type { WorktreeManager, WorktreeStatus } from '../../src/models/worktrees.ts'
import { asNodeId } from '../../src/storage/nodes.ts'

const run = promisify(execFile)
const TOKEN = 'worktree-discovery-token-0123456789'

let repoPath: string
let dataDir: string
let handCut: string
let server: TestAgent
let node: ConnectedNode
let anchors: AnchorStore
let repos: RepoStore
let worktrees: WorktreeManager
let registered: string[]

/** Run git in the fixture repository with a fixed identity. */
async function git(args: string[], cwd = repoPath): Promise<string> {
  const { stdout } = await run('git', [
    '-c', 'user.email=test@example.com',
    '-c', 'user.name=Test',
    '-c', 'commit.gpgsign=false',
    ...args,
  ], { cwd })
  return stdout.trim()
}

/** The one row whose checkout is the given path. */
function rowAt(rows: readonly WorktreeStatus[], path: string): WorktreeStatus | undefined {
  return rows.find(row => row.anchor.remoteRoot === path)
}

before(async () => {
  repoPath = await realpath(await mkdtemp(join(tmpdir(), 'drw-wtd-repo-')))
  dataDir = await realpath(await mkdtemp(join(tmpdir(), 'drw-wtd-data-')))
  await run('git', ['init', '-b', 'main'], { cwd: repoPath })
  await writeFile(join(repoPath, 'README.md'), 'initial\n', 'utf8')
  await git(['add', '.'])
  await git(['commit', '-m', 'initial'])

  // A checkout outside the plugin's root, cut by hand: exactly the case that
  // should appear without anyone registering it.
  handCut = join(dataDir, 'hand-cut')
  await git(['worktree', 'add', '-b', 'worktree/hand', handCut])

  server = await startAgent({ token: TOKEN, root: repoPath })
  const port = Number(server.boundAddress.slice(server.boundAddress.lastIndexOf(':') + 1))
  node = await connectNode({ host: '127.0.0.1', port, token: TOKEN, timeoutMs: 5_000 })

  anchors = createAnchorStore({ root: join(dataDir, 'anchors') })
  await anchors.load()
  repos = createRepoStore({ file: join(dataDir, 'repos.json') })
  await repos.load()
  await repos.upsert({ nodeId: asNodeId('n1'), repoPath })

  registered = []
  worktrees = createWorktreeManager({
    anchors,
    repos,
    channel: nodeId => (nodeId === 'n1' ? node.channel : undefined),
    isLocalNode: () => false,
    worktreeRoot: () => join(dataDir, 'checkouts'),
    workspace: {
      register: (anchor: AnchorRecord) => { registered.push(anchor.remoteRoot); return Promise.resolve() },
      unregister: (anchor: AnchorRecord) => {
        registered = registered.filter(path => path !== anchor.remoteRoot)
        return Promise.resolve()
      },
      registered: (anchor: AnchorRecord) => Promise.resolve(registered.includes(anchor.remoteRoot)),
    },
  })
})

after(async () => {
  node?.close()
  await server?.close()
  await rm(repoPath, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
})

test('a checkout git reports is a row before anyone adopts it', async () => {
  const row = rowAt(await worktrees.list(), handCut)
  assert.ok(row !== undefined, 'the hand-cut checkout is listed')
  assert.equal(row.anchor.kind, 'worktree')
  assert.equal(row.anchor.branch, 'worktree/hand')
  assert.equal(row.held, false, 'nothing holds this checkout yet')
  assert.equal(row.managed, false, 'git reported it; this plugin did not cut it')
  assert.ok(row.anchor.anchorId.startsWith('remote:'), 'the row is addressed by its machine path')
})

test('opening the row adopts the checkout and registers it', async () => {
  const row = rowAt(await worktrees.list(), handCut)
  assert.ok(row !== undefined)
  const opened = await worktrees.open(row.anchor.anchorId)

  assert.equal(opened.remoteRoot, handCut)
  assert.deepEqual(registered, [handCut], 'the workspace registry saw the checkout')

  const rows = await worktrees.list()
  const held = rowAt(rows, handCut)
  assert.ok(held !== undefined)
  assert.equal(held.held, true, 'the adopted checkout is held')
  assert.equal(held.open, true, 'its workspace is registered')
  assert.equal(
    rows.filter(candidate => candidate.anchor.remoteRoot === handCut).length,
    1,
    'git does not list it twice',
  )
  assert.equal(anchors.list().length, 1, 'adoption wrote one record')
})

test('releasing drops the record but leaves the checkout for git to list', async () => {
  const row = rowAt(await worktrees.list(), handCut)
  assert.ok(row !== undefined && row.held)
  await worktrees.release(row.anchor.anchorId)

  assert.deepEqual(anchors.list(), [], 'the record is gone')
  assert.deepEqual(registered, [], 'the workspace was unregistered')
  assert.equal(existsSync(handCut), true, 'the checkout stays where it is')

  const released = rowAt(await worktrees.list(), handCut)
  assert.ok(released !== undefined, 'git still lists the checkout')
  assert.equal(released.held, false)
  assert.equal(released.managed, false)
})

test('removing the discovered row takes the checkout away', async () => {
  const row = rowAt(await worktrees.list(), handCut)
  assert.ok(row !== undefined)
  const removal = await worktrees.remove(row.anchor.anchorId, { force: false, deleteBranch: false })

  assert.equal(removal.branchDeleted, false)
  assert.equal(existsSync(handCut), false, 'the checkout is gone')
  assert.equal(rowAt(await worktrees.list(), handCut), undefined, 'git no longer lists it')
})
