/**
 * The wire contract, asserted against the shipped binary.
 *
 * Every other suite reaches the daemon through a seam — the routing
 * filesystem, the worktree manager, the subprocess proxy — which is what makes
 * them worth having and also what lets a renamed field or a dropped method hide
 * behind the layer that translates it. This suite calls the protocol directly,
 * one case per method, so the contract itself is what fails when it moves.
 *
 * The Rust daemon keeps its own copy of these shapes (`agent/src/protocol.rs`,
 * `agent/src/wire.rs`). That copy is maintained by hand; this file is what
 * makes a hand-maintained copy safe.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { startAgent } from './harness.ts'
import type { TestAgent } from './harness.ts'
import { connectNode } from '../../src/remote/client.ts'
import type { ConnectedNode } from '../../src/remote/client.ts'
import { NodeRequestError } from '../../src/remote/client.ts'
import type { SpPipeFrame, WireMethod, WireParams, WireResult } from '../../src/remote/protocol.ts'
import type { ProcId } from '../../src/remote/protocol.ts'
import { ptyUnavailable } from '../tty.ts'

const run = promisify(execFile)
const TOKEN = 'protocol-token-0123456789'

let root: string
let repo: string
let server: TestAgent
let node: ConnectedNode

/** Skip the terminal cases on a host whose sandbox refuses a PTY. */
const noPty = await ptyUnavailable()

/** Run git in the fixture repository with a fixed identity. */
async function git(args: string[], cwd = repo): Promise<string> {
  const { stdout } = await run('git', [
    '-c', 'user.email=test@example.com',
    '-c', 'user.name=Test',
    '-c', 'commit.gpgsign=false',
    ...args,
  ], { cwd })
  return stdout.trim()
}

/** Round-trip one method and return its result. */
function call<M extends WireMethod>(method: M, params: WireParams<M>): Promise<WireResult<M>> {
  return node.channel.request(method, params)
}

/** The field names of one result, so a rename fails here. */
function fields(value: unknown): readonly string[] {
  return Object.keys(value as Record<string, unknown>).sort()
}

/** Decode one base64 payload from a bytes result. */
function decoded(result: { readonly data: string }): Buffer {
  return Buffer.from(result.data, 'base64')
}

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'drw-proto-')))
  repo = join(root, 'repo')
  await mkdir(repo)
  await run('git', ['init', '-b', 'main'], { cwd: repo })
  await writeFile(join(repo, 'README.md'), 'initial\n', 'utf8')
  await git(['add', '.'])
  await git(['commit', '-m', 'initial'])

  await writeFile(join(root, 'note.txt'), 'first\nsecond\n', 'utf8')
  await writeFile(join(root, 'raw.bin'), Buffer.from([0, 1, 2, 3, 4, 5]))
  await symlink(join(root, 'note.txt'), join(root, 'link.txt'))

  server = await startAgent({ token: TOKEN, root })
  const port = Number(server.boundAddress.slice(server.boundAddress.lastIndexOf(':') + 1))
  node = await connectNode({ host: '127.0.0.1', port, token: TOKEN, timeoutMs: 5_000 })
})

after(async () => {
  node?.close()
  await server?.close()
  await rm(root, { recursive: true, force: true })
})

test('the handshake describes the daemon and what it can do', () => {
  assert.deepEqual(fields(node.info), ['agentVersion', 'arch', 'capability', 'homedir', 'node', 'platform', 'protocol'])
  assert.equal(node.info.protocol, 2)
  assert.deepEqual(fields(node.info.capability), ['pty', 'ripgrep', 'spill'])
  assert.equal(typeof node.info.agentVersion, 'string')
  assert.equal(typeof node.info.arch, 'string')
  assert.equal(typeof node.info.platform, 'string')
  assert.equal(typeof node.info.homedir, 'string')
  assert.equal(typeof node.info.capability.pty, 'boolean')
})

test('fs.resolve answers with the canonical path', async () => {
  const target = await call('fs.resolve', { path: join(root, 'link.txt') })
  assert.deepEqual(fields(target), ['canonicalPath'])
  assert.equal(target.canonicalPath, join(root, 'note.txt'))
})

test('fs.stat reports a file and answers null for an absent one', async () => {
  const present = await call('fs.stat', { path: join(root, 'note.txt') })
  assert.deepEqual(fields(present), ['size', 'type', 'version'])
  assert.equal(present?.type, 'file')
  assert.equal(present?.size, 13)

  assert.equal(await call('fs.stat', { path: join(root, 'gone.txt') }), null)
})

test('fs.lstat reports the entry itself, not what it points at', async () => {
  const entry = await call('fs.lstat', { path: join(root, 'link.txt') })
  assert.deepEqual(fields(entry), ['size', 'type', 'version'])
  assert.equal(entry?.type, 'symlink')
})

test('fs.listDir lists children with resolved targets', async () => {
  const entries = await call('fs.listDir', { path: root })
  assert.equal(Array.isArray(entries), true)
  const note = entries.find(entry => entry.name === 'note.txt')
  assert.ok(note !== undefined)
  assert.deepEqual(fields(note), ['name', 'size', 'target', 'type', 'version'])
  assert.equal(note.type, 'file')
  assert.deepEqual(fields(note.target), ['canonicalPath'])
})

test('fs.readTextChunk pages text and reports the end', async () => {
  const chunk = await call('fs.readTextChunk', { path: join(root, 'note.txt'), offset: 0, length: 4096 })
  assert.deepEqual(fields(chunk), ['eof', 'nextOffset', 'text'])
  assert.equal(chunk.text, 'first\nsecond\n')
  assert.equal(chunk.nextOffset, 13)
  assert.equal(chunk.eof, true)
})

test('fs.readBytes and fs.readByteRange answer base64 windows', async () => {
  const whole = await call('fs.readBytes', { path: join(root, 'raw.bin'), maxBytes: 64 })
  assert.deepEqual(fields(whole), ['data'])
  assert.deepEqual(decoded(whole), Buffer.from([0, 1, 2, 3, 4, 5]))

  const window = await call('fs.readByteRange', { path: join(root, 'raw.bin'), offset: 2, length: 3 })
  assert.deepEqual(fields(window), ['data'])
  assert.deepEqual(decoded(window), Buffer.from([2, 3, 4]))
})

test('fs.writeText creates and guards, and fs.editText replaces literally', async () => {
  const path = join(root, 'written.txt')
  const created = await call('fs.writeText', {
    path,
    content: 'alpha\n',
    expected: { kind: 'createIfAbsent' },
  })
  assert.deepEqual(fields(created), ['after', 'before', 'operation', 'version'])
  assert.equal(created.operation, 'create')
  assert.equal(created.before, null)

  const edited = await call('fs.editText', {
    path,
    edit: { oldString: 'alpha', newString: 'beta', replaceAll: false },
    expected: { version: created.version },
  })
  assert.deepEqual(fields(edited), ['after', 'before', 'version'])
  assert.equal(edited.before, 'alpha\n')
  assert.equal(edited.after, 'beta\n')
})

test('git.repoState reports the branch and whether the tree is clean', async () => {
  const state = await call('git.repoState', { repoPath: repo })
  assert.deepEqual(fields(state), ['branch', 'clean'])
  assert.equal(state.branch, 'main')
  assert.equal(state.clean, true)
})

test('the worktree methods add, list, and remove a checkout', async () => {
  const worktreePath = join(root, 'wt-conformance')
  const added = await call('git.worktreeAdd', {
    repoPath: repo,
    worktreePath,
    branch: 'worktree/conformance',
  })
  assert.deepEqual(fields(added), ['branch', 'head', 'main', 'path'])
  assert.equal(added.path, worktreePath)
  assert.equal(added.branch, 'worktree/conformance')
  assert.equal(added.main, false)
  assert.equal(added.head.length, 40)

  const listed = await call('git.worktreeList', { repoPath: repo })
  assert.equal(Array.isArray(listed), true)
  assert.deepEqual(fields(listed[0]), ['branch', 'head', 'main', 'path'])
  assert.equal(listed[0]?.main, true)
  assert.ok(listed.some(entry => entry.path === worktreePath))

  assert.deepEqual(await call('git.worktreeRemove', { repoPath: repo, worktreePath, force: true }), {})
})

test('git.mergeBranch merges a branch and git.branchDelete removes it', async () => {
  await git(['checkout', '-b', 'conformance-merge'])
  await writeFile(join(repo, 'merged.txt'), 'merged\n', 'utf8')
  await git(['add', '.'])
  await git(['commit', '-m', 'work for the merge'])
  await git(['checkout', 'main'])

  const merged = await call('git.mergeBranch', { repoPath: repo, branch: 'conformance-merge' })
  assert.deepEqual(fields(merged), ['alreadyMerged', 'head'])
  assert.equal(merged.alreadyMerged, false)

  assert.deepEqual(await call('git.branchDelete', { repoPath: repo, branch: 'conformance-merge', force: false }), {})
})

test('sp.resolveExecutable answers with an absolute path', async () => {
  const resolved = await call('sp.resolveExecutable', { command: 'sh' })
  assert.deepEqual(fields(resolved), ['path'])
  assert.equal(resolved.path.startsWith('/'), true)
})

test('sp.spawn collects both streams and reports the exit facts', async () => {
  const spawned = await call('sp.spawn', {
    argv: ['/bin/sh', '-c', 'printf out; printf err 1>&2; exit 3'],
    cwd: root,
    stdin: 'ignore',
    stdout: { maxBytes: 4096 },
    stderr: { maxBytes: 4096 },
    graceMs: 2_000,
  })
  assert.deepEqual(fields(spawned), ['procId'])

  assert.deepEqual(await call('sp.waitForExit', { procId: spawned.procId }), {})

  const stdout = await call('sp.readOutput', { procId: spawned.procId, stream: 'stdout', fromByte: 0 })
  assert.deepEqual(fields(stdout), ['data', 'lossy', 'nextOffset'])
  assert.equal(decoded(stdout).toString('utf8'), 'out')

  const stderr = await call('sp.readOutput', { procId: spawned.procId, stream: 'stderr', fromByte: 0 })
  assert.equal(decoded(stderr).toString('utf8'), 'err')

  const outcome = await call('sp.outcome', { procId: spawned.procId })
  assert.deepEqual(fields(outcome), ['exitCode', 'signal'])
  assert.equal(outcome?.exitCode, 3)
  assert.equal(outcome?.signal, null)
})

test('sp.writeStdin and sp.closeStdin feed a piped child', async () => {
  const spawned = await call('sp.spawn', {
    argv: ['/bin/cat'],
    cwd: root,
    stdin: 'pipe',
    stdout: { maxBytes: 4096 },
    stderr: { maxBytes: 4096 },
    graceMs: 2_000,
  })
  assert.deepEqual(await call('sp.writeStdin', { procId: spawned.procId, data: 'fed\n' }), {})
  assert.deepEqual(await call('sp.closeStdin', { procId: spawned.procId }), {})
  await call('sp.waitForExit', { procId: spawned.procId })

  const stdout = await call('sp.readOutput', { procId: spawned.procId, stream: 'stdout', fromByte: 0 })
  assert.equal(decoded(stdout).toString('utf8'), 'fed\n')
})

test('sp.terminate ends a running process', async () => {
  const spawned = await call('sp.spawn', {
    argv: ['/bin/sleep', '30'],
    cwd: root,
    stdin: 'ignore',
    stdout: { maxBytes: 64 },
    stderr: { maxBytes: 64 },
    graceMs: 2_000,
  })
  assert.deepEqual(await call('sp.terminate', { procId: spawned.procId }), {})
  await call('sp.waitForExit', { procId: spawned.procId })

  const outcome = await call('sp.outcome', { procId: spawned.procId })
  assert.equal(outcome?.exitCode, null)
  assert.equal(outcome?.signal, 'SIGTERM')
})

test("sp.pipe pushes a frame for every chunk of a 'pipe' stream", async () => {
  const frames: SpPipeFrame[] = []
  const dispose = node.channel.onPipeFrame(frame => { frames.push(frame) })
  try {
    const spawned = await call('sp.spawn', {
      argv: ['/bin/sh', '-c', 'printf piped'],
      cwd: root,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: { maxBytes: 64 },
      graceMs: 2_000,
    })
    await call('sp.waitForExit', { procId: spawned.procId })

    const frame = frames.find(entry => entry.procId === spawned.procId)
    assert.ok(frame !== undefined, 'a piped stream is pushed, not retained')
    assert.deepEqual(Object.keys(frame).sort(), ['data', 'procId', 'seq', 'stream'])
    assert.equal(frame.stream, 'stdout')
    assert.equal(frame.seq, 0)
    assert.equal(Buffer.from(frame.data, 'base64').toString('utf8'), 'piped')
  } finally {
    dispose()
  }
})

test('a daemon failure carries the protocol error data', async () => {
  await assert.rejects(
    () => call('sp.outcome', { procId: 'no-such-process' as ProcId }),
    (error: unknown) => {
      assert.ok(error instanceof NodeRequestError)
      assert.deepEqual(fields(error.data), ['code', 'message'])
      assert.equal(error.data.code, 'SP_NO_SUCH_PROCESS')
      return true
    },
  )
})

test('term.spawn, term.write, and term.read move text through a pty', { skip: noPty }, async () => {
  const spawned = await call('term.spawn', {
    argv: ['/bin/sh'],
    cwd: root,
    rows: 24,
    cols: 80,
    graceMs: 3_000,
  })
  assert.deepEqual(fields(spawned), ['pid', 'termId'])
  assert.equal(typeof spawned.pid, 'number')

  assert.deepEqual(await call('term.write', { termId: spawned.termId, data: 'printf term-check\n' }), {})

  let text = ''
  for (let attempt = 0; attempt < 50 && !text.includes('term-check\n'); attempt++) {
    const read = await call('term.read', { termId: spawned.termId, fromByte: 0 })
    assert.deepEqual(fields(read), ['data', 'lossy', 'nextOffset'])
    text = Buffer.from(read.data, 'base64').toString('utf8')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.match(text, /term-check/)

  assert.deepEqual(await call('term.terminate', { termId: spawned.termId }), {})
  const outcome = await call('term.outcome', { termId: spawned.termId })
  assert.deepEqual(fields(outcome), ['exitCode', 'signal'])
})

test('term.inspectForeground and term.signalForeground address the foreground group', { skip: noPty }, async () => {
  const spawned = await call('term.spawn', {
    argv: ['/bin/sh'],
    cwd: root,
    rows: 24,
    cols: 80,
    graceMs: 3_000,
  })
  try {
    const foreground = await call('term.inspectForeground', { termId: spawned.termId })
    // A platform that cannot report one answers null; one that can reports both
    // fields, and the shell itself is its own foreground group.
    if (foreground !== null) {
      assert.deepEqual(fields(foreground), ['inputWaiting', 'processGroupId'])
      assert.equal(typeof foreground.processGroupId, 'number')
      assert.equal(typeof foreground.inputWaiting, 'boolean')
    }

    const signalled = await call('term.signalForeground', { termId: spawned.termId, signal: 'SIGINT' })
    assert.deepEqual(fields(signalled), ['processGroupId'])
    assert.equal(typeof signalled.processGroupId, 'number')
  } finally {
    await call('term.terminate', { termId: spawned.termId })
  }
})
