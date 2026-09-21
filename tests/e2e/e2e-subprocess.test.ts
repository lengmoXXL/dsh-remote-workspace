/**
 * The subprocess half, end to end: a real command executes through the real
 * daemon and its bytes come back through the routing runtime.
 *
 * The local delegate throws if it is ever reached, so nothing here can pass by
 * quietly running on this machine instead of the node.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startAgent } from './harness.ts'
import type { TestAgent } from './harness.ts'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { connectNode } from '../../src/remote/client.ts'
import type { ConnectedNode } from '../../src/remote/client.ts'
import type { AnchorRoute } from '../../src/storage/anchors.ts'
import { createRoutingSubprocessRuntime } from '../../src/plugin/routing/subprocess.ts'

/** The PTC program host this router is told about; no case here runs a PTC program. */
const ptcHost = async () => '/home/dev/.dsh/remote-agent/dsh-ptc-host'
import { asNodeId } from '../../src/storage/nodes.ts'

const TOKEN = 'subprocess-token-0123456789'

let remoteRoot: string
let anchorRoot: string
let server: TestAgent
let node: ConnectedNode
let runtime: ReturnType<typeof createRoutingSubprocessRuntime>

/** A local delegate that fails loudly if the remote branch ever reaches it. */
const localDelegate = new Proxy({}, {
  get(_target, property) {
    return () => {
      throw new Error(`the local subprocess delegate was reached for "${String(property)}"`)
    }
  },
}) as unknown as SubprocessRuntime

/** Spawn one command in the remote worktree and wait for it. */
async function run(
  command: string,
  overrides: Partial<Parameters<SubprocessRuntime['spawn']>[0]['stdio']> = {},
): Promise<SubprocessHandle> {
  const handle = runtime.spawn({
    argv: ['bash', '-c', command],
    cwd: remoteRoot,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 1 << 20 },
      stderr: { maxBytes: 1 << 20 },
      ...overrides,
    },
    graceMs: 2000,
  })
  await handle.done
  return handle
}

before(async () => {
  remoteRoot = await realpath(await mkdtemp(join(tmpdir(), 'drw-sp-remote-')))
  anchorRoot = await realpath(await mkdtemp(join(tmpdir(), 'drw-sp-anchor-')))
  await writeFile(join(remoteRoot, 'marker.txt'), 'written on the node\n', 'utf8')

  server = await startAgent({ token: TOKEN, root: remoteRoot })
  const port = Number(server.boundAddress.slice(server.boundAddress.lastIndexOf(':') + 1))
  node = await connectNode({ host: '127.0.0.1', port, token: TOKEN, timeoutMs: 5_000 })

  const anchors: AnchorRoute[] = [{ nodeId: asNodeId('n1'), anchorPath: anchorRoot, remoteRoot }]
  runtime = createRoutingSubprocessRuntime({
    ptcHost,
    localProc: localDelegate,
    anchors: () => anchors,
    channel: id => (id === 'n1' ? node.channel : undefined),
  })
})

after(async () => {
  node?.close()
  await server?.close()
  await rm(remoteRoot, { recursive: true, force: true })
  await rm(anchorRoot, { recursive: true, force: true })
})

test('a command runs in the remote working directory', async () => {
  const handle = await run('pwd')
  assert.equal(handle.collected.stdout?.readFrom(0).text.trim(), remoteRoot)
})

test('the command sees files that live on the node', async () => {
  const handle = await run('cat marker.txt')
  assert.equal(handle.collected.stdout?.readFrom(0).text, 'written on the node\n')
})

test('the exit code comes back unchanged', async () => {
  const ok = await run('exit 0')
  assert.deepEqual(await ok.done, { exitCode: 0, signal: null })

  const bad = await run('exit 7')
  assert.equal((await bad.done).exitCode, 7)
})

test('stderr is captured separately from stdout', async () => {
  const handle = await run('echo to-stdout; echo to-stderr >&2')
  assert.equal(handle.collected.stdout?.readFrom(0).text, 'to-stdout\n')
  assert.equal(handle.collected.stderr?.readFrom(0).text, 'to-stderr\n')
})

test('batch stdin reaches the command', async () => {
  const handle = runtime.spawn({
    argv: ['bash', '-c', 'cat'],
    cwd: remoteRoot,
    stdio: {
      stdin: { data: 'piped payload\n' },
      stdout: { maxBytes: 1 << 20 },
      stderr: { maxBytes: 1 << 20 },
    },
    graceMs: 2000,
  })
  await handle.done
  assert.equal(handle.collected.stdout?.readFrom(0).text, 'piped payload\n')
})

test('an explicit environment entry reaches the child', async () => {
  const handle = runtime.spawn({
    argv: ['bash', '-c', 'echo "$DRW_PROBE"'],
    cwd: remoteRoot,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 20 } },
    graceMs: 2000,
    env: { DRW_PROBE: 'from-the-caller' },
  })
  await handle.done
  assert.equal(handle.collected.stdout?.readFrom(0).text, 'from-the-caller\n')
})

test('a credential-shaped ambient name is not forwarded implicitly', async () => {
  process.env['DRW_FAKE_TOKEN'] = 'must-not-leak'
  try {
    const handle = await run('echo "[${DRW_FAKE_TOKEN:-absent}]"')
    assert.equal(handle.collected.stdout?.readFrom(0).text, '[absent]\n')
  } finally {
    delete process.env['DRW_FAKE_TOKEN']
  }
})

test('a long command can be terminated and still settles', async () => {
  const handle = runtime.spawn({
    argv: ['bash', '-c', 'sleep 30'],
    cwd: remoteRoot,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
    graceMs: 500,
  })

  handle.terminate()
  const outcome = await handle.done
  // Killed by the ladder, so there is no ordinary exit code.
  assert.equal(outcome.exitCode === null || outcome.exitCode !== 0, true)
})

test('a second client read from zero returns the same bytes', async () => {
  const handle = await run('printf "alpha\\nbeta\\n"')
  const first = handle.collected.stdout!.readFrom(0)
  const second = handle.collected.stdout!.readFrom(0)
  assert.deepEqual(second, first)
  assert.equal(first.text, 'alpha\nbeta\n')
})
