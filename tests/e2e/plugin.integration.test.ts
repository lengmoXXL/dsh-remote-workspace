/**
 * The integration smoke this design's central bet stands on: every seam is a
 * plain object registered with `ctx.provide`, each factory implementation is
 * composed in its own isolated scope, and the resulting services behave exactly
 * as the shipped ones did.
 *
 * Nothing here mocks the runtime: it boots a real Cordis root, mounts the
 * published sandbox-policy plugin and the published factory providers, seeds
 * one anchor on disk, and then mounts the plugin under test. If
 * `ctx.provide` + `ctx.isolate` + `ctx.inject` did not compose, this is where
 * it would fail.
 *
 * This tree is hand-built, so it does not satisfy the package policy's
 * real-composition requirement on its own;
 * `tests/loader-composition.test.ts` is the guard that boots the published
 * entry through a real Loader.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SandboxLocalPlugin from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyPlugin from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as remoteWorktree from '../../src/index.ts'
import { asAnchorId } from '../../src/storage/anchors.ts'
import { asNodeId } from '../../src/storage/nodes.ts'

/** The remote root the seeded anchor claims. It must not overlap the local fixture. */
const REMOTE_ROOT = '/srv/checkouts/remote-app/login'

let dir: string
let anchorPath: string
let ctx: Context

before(async () => {
  // Resolved, because the anchor store hands out canonical paths and this test
  // routes by the path it seeded.
  dir = await realpath(await mkdtemp(join(tmpdir(), 'drw-plugin-')))
  await writeFile(join(dir, 'hello.txt'), 'hi there\n', 'utf8')

  // Seed one anchor before mounting, so the store discovers it at load time.
  anchorPath = join(dir, 'state', 'anchors', 'n1', 'app', 'login')
  await mkdir(anchorPath, { recursive: true })
  await writeFile(join(anchorPath, '.dsh-remote-worktree.json'), JSON.stringify({
    version: 1,
    anchor: {
      anchorId: asAnchorId('a1'),
      nodeId: asNodeId('n1'),
      name: 'login',
      anchorPath,
      remoteRoot: REMOTE_ROOT,
      repoPath: '/srv/remote-app',
      branch: 'worktree/login',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  }), 'utf8')

  ctx = new Context()
  // The policy service waits for the projection registry, so it must be
  // mounted first; without it `sandboxPolicy` never becomes available and the
  // plugin under test would wait forever instead of failing.
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyPlugin, { mode: 'danger-full-access', workspaceRoot: dir })
  // The local shell delegate is the sandboxed executor, so the deployment's
  // sandbox provider must be present exactly as it is in the shipped profile.
  await ctx.plugin(SandboxLocalPlugin)
  await ctx.plugin(remoteWorktree, { dataDir: join(dir, 'state') })
})

after(async () => {
  await ctx.fiber.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('a local path is served by the composed filesystem delegate', async () => {
  const target = await ctx.fs.resolve('hello.txt', { cwd: dir })
  assert.equal(target.displayPath, join(dir, 'hello.txt'))
  assert.equal(await ctx.fs.readText(target), 'hi there\n')
})

test('the anchored path routes to its node instead of the local filesystem', async () => {
  // With no node connected the resolution must fail as a remote operation; a
  // local fallback would be the silent mis-route this design exists to prevent.
  await assert.rejects(
    () => ctx.fs.resolve(join(anchorPath, 'README.md')),
    /is not connected/,
  )
})

test('a guarded write still round-trips through the delegate', async () => {
  const target = await ctx.fs.resolve('written.txt', { cwd: dir })
  const created = await ctx.fs.writeText(target, 'first\n', { kind: 'createIfAbsent' })
  assert.equal(created.operation, 'create')
  assert.equal(await readFile(join(dir, 'written.txt'), 'utf8'), 'first\n')

  const replaced = await ctx.fs.writeText(
    target,
    'second\n',
    { kind: 'replaceIfVersion', version: created.version },
  )
  assert.equal(replaced.before, 'first\n')
  assert.equal(replaced.after, 'second\n')
})

test('the composed delegate still refuses a conflicted create', async () => {
  const target = await ctx.fs.resolve('hello.txt', { cwd: dir })
  await assert.rejects(
    () => ctx.fs.writeText(target, 'x', { kind: 'createIfAbsent' }),
    (error: unknown) => (error as { code?: string }).code === 'FS_NOT_OBSERVED',
  )
})

test('a local command runs through the composed sandboxed executor', async () => {
  const spec = ctx.shell.resolve({ command: 'echo local-ok', workdir: dir })
  const result = await (await ctx.shell.execute(spec)).result()

  assert.equal(result.exitCode, 0)
  assert.match(result.stdout.text, /local-ok/)
})

test('a command in the anchored worktree routes to the node and fails offline', async () => {
  const spec = ctx.shell.resolve({ command: 'echo remote-ok', workdir: anchorPath })

  await assert.rejects(
    async () => { await (await ctx.shell.execute(spec)).result() },
    /not connected/,
  )
})

test('a remote spawn is refused before any process starts when the node is offline', () => {
  assert.throws(
    () => ctx.subprocess.spawn({
      argv: ['echo', 'hi'],
      cwd: anchorPath,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
      graceMs: 1000,
    }),
    /not connected/,
  )
})
