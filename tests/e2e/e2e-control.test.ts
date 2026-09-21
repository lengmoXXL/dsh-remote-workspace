/**
 * The control-channel half, end to end: a child started on the real daemon
 * receives an inherited control descriptor and exchanges bytes with the host
 * over it.
 *
 * The child opens fd 7 as a bidirectional socket exactly the way
 * `@deepseek-ai/dsh-subprocess/control` does, and echoes what it reads, so the
 * test proves both directions rather than only that a handle exists.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startAgent } from './harness.ts'
import type { TestAgent } from './harness.ts'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { connectNode } from '../../src/remote/client.ts'
import type { ConnectedNode } from '../../src/remote/client.ts'
import type { AnchorRoute } from '../../src/storage/anchors.ts'
import { createRoutingSubprocessRuntime } from '../../src/plugin/routing/subprocess.ts'
import { asNodeId } from '../../src/storage/nodes.ts'

const TOKEN = 'control-token-0123456789'

/** A child that adopts fd 7 and echoes every control byte back. */
const CHILD = [
  "const net = require('node:net')",
  'const control = new net.Socket({ fd: 7, readable: true, writable: true, allowHalfOpen: true })',
  "control.on('data', chunk => control.write('echo:' + chunk.toString()))",
  "control.write('ready')",
  'setInterval(() => {}, 1000)',
].join(';')

let remoteRoot: string
let anchorRoot: string
let server: TestAgent
let node: ConnectedNode
let runtime: ReturnType<typeof createRoutingSubprocessRuntime>

/** Poll until a condition holds, or fail after the budget. */
async function until(predicate: () => boolean, label: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/** Spawn the echoing child, optionally asking for the control channel. */
function spawnChild(control: boolean): SubprocessHandle {
  return runtime.spawn({
    argv: [process.execPath, '-e', CHILD],
    cwd: remoteRoot,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 1 << 20 },
      stderr: { maxBytes: 1 << 20 },
      ...control ? { control: 'pipe' as const } : {},
    },
    graceMs: 2000,
  })
}

before(async () => {
  remoteRoot = await realpath(await mkdtemp(join(tmpdir(), 'drw-control-remote-')))
  anchorRoot = await realpath(await mkdtemp(join(tmpdir(), 'drw-control-anchor-')))

  server = await startAgent({ token: TOKEN, root: remoteRoot })
  const port = Number(server.boundAddress.slice(server.boundAddress.lastIndexOf(':') + 1))
  node = await connectNode({ host: '127.0.0.1', port, token: TOKEN, timeoutMs: 5_000 })

  const anchors: AnchorRoute[] = [{ nodeId: asNodeId('n1'), anchorPath: anchorRoot, remoteRoot }]
  runtime = createRoutingSubprocessRuntime({
    localProc: new Proxy({}, {
      get: () => () => {
        throw new Error('the local subprocess delegate was reached')
      },
    }) as unknown as SubprocessRuntime,
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

test('a remote child exposes a control channel and round-trips bytes', async () => {
  const handle = spawnChild(true)
  assert.notEqual(handle.control, undefined, 'the requested control channel is missing')

  const received: string[] = []
  handle.control!.on('data', (chunk: Buffer) => received.push(chunk.toString()))
  await until(() => received.join('').includes('ready'), 'the child to greet')

  handle.control!.write('ping')
  await until(() => received.join('').includes('echo:ping'), 'the child to echo')

  handle.terminate()
  await handle.done
})

test('a spawn without the request exposes no control channel', async () => {
  const handle = spawnChild(false)
  assert.equal(handle.control, undefined)
  handle.terminate()
  await handle.done
})

test('control bytes never appear on stdout', async () => {
  const handle = spawnChild(true)
  const control: string[] = []
  handle.control!.on('data', (chunk: Buffer) => control.push(chunk.toString()))

  await until(() => control.join('').includes('ready'), 'the child to greet')
  handle.terminate()
  await handle.done

  assert.equal(handle.collected.stdout?.readFrom(0).text, '', 'control bytes leaked onto stdout')
})
