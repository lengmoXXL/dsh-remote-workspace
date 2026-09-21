/**
 * The PTC program host, end to end: a program spawn aimed at a routed
 * workspace reaches the real daemon, which starts this release's embedded-V8
 * worker on the inherited control descriptor, and the harness's own process
 * protocol runs over it.
 *
 * This is the joint no other suite covers. The router's rewrite, the worker's
 * protocol and the install path each have their own cases; here the daemon's
 * own control socketpair, the worker's framing on it, and a binding call that
 * crosses both are exercised together, which is what a `run_code` against a
 * remote workspace actually does.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { connectNode } from '../../src/remote/client.ts'
import type { ConnectedNode } from '../../src/remote/client.ts'
import type { AnchorRoute } from '../../src/storage/anchors.ts'
import { asNodeId } from '../../src/storage/nodes.ts'
import { createRoutingSubprocessRuntime } from '../../src/plugin/routing/subprocess.ts'
import { ptcHostBinaryPath } from '../ptc-host-binary.ts'
import { startAgent } from './harness.ts'
import type { TestAgent } from './harness.ts'

const TOKEN = 'ptc-token-0123456789'
const MAX_FRAME = 8 * 1024 * 1024

/**
 * The argv the harness's PTC provider spawns: interpreter, heap ceiling, its
 * own bootstrap, and the frame limit. The bootstrap is rewritten before the
 * daemon sees it, so the path itself never has to exist.
 */
const PTC_ARGV = [
  process.execPath,
  '--max-old-space-size=64',
  '/opt/deepseek-harness/node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/process.js',
  String(MAX_FRAME),
]

/** One length-framed protocol message. */
function frame(message: Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

/** The frames this suite reads out of the harness PTC protocol. */
interface WireFrame {
  type: string
  text?: string
  args?: readonly unknown[]
  global?: string
  name?: string
  id?: number
  value?: unknown
  error?: unknown
}

/** The frames arriving on one control stream, in order. */
function incoming(stream: Duplex): { next(): Promise<WireFrame> } {
  const queued: WireFrame[] = []
  const waiting: ((message: WireFrame) => void)[] = []
  let buffer = Buffer.alloc(0)
  stream.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.length < 4) break
      const length = buffer.readUInt32BE(0)
      if (buffer.length < 4 + length) break
      const message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8')) as WireFrame
      buffer = buffer.subarray(4 + length)
      const parked = waiting.shift()
      if (parked === undefined) queued.push(message)
      else parked(message)
    }
  })
  return {
    next(): Promise<WireFrame> {
      const ready = queued.shift()
      if (ready !== undefined) return Promise.resolve(ready)
      return new Promise(resolve => waiting.push(resolve))
    },
  }
}

let remoteRoot: string
let anchorRoot: string
let server: TestAgent
let node: ConnectedNode
let runtime: ReturnType<typeof createRoutingSubprocessRuntime>

before(async () => {
  remoteRoot = await realpath(await mkdtemp(join(tmpdir(), 'drw-ptc-remote-')))
  anchorRoot = await realpath(await mkdtemp(join(tmpdir(), 'drw-ptc-anchor-')))

  server = await startAgent({ token: TOKEN, root: remoteRoot })
  const port = Number(server.boundAddress.slice(server.boundAddress.lastIndexOf(':') + 1))
  node = await connectNode({ host: '127.0.0.1', port, token: TOKEN, timeoutMs: 5_000 })

  const anchors: AnchorRoute[] = [{ nodeId: asNodeId('n1'), anchorPath: anchorRoot, remoteRoot }]
  runtime = createRoutingSubprocessRuntime({
    ptcHost: async () => ptcHostBinaryPath(),
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

test('a PTC program runs on the node and reaches a binding over the control channel', async () => {
  const handle: SubprocessHandle = runtime.spawn({
    argv: [...PTC_ARGV],
    cwd: remoteRoot,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 1 << 20 },
      stderr: { maxBytes: 1 << 20 },
      control: 'pipe',
    },
    graceMs: 4_000,
  })
  const control = handle.control
  assert.notEqual(control, undefined, 'the requested control channel is missing')
  const frames = incoming(control!)

  const ready = await frames.next()
  assert.equal(ready.type, 'ready')

  control!.write(frame({
    type: 'boot',
    data: {
      code: 'const sum = await tools.add({a: 1, b: 2}); console.log("sum", sum); return sum',
      namespaces: [{ global: 'tools', names: ['add'] }],
      maxOutputBytes: 1 << 20,
    },
  }))

  const logs: string[] = []
  let done: WireFrame | undefined
  for (;;) {
    const message = await frames.next()
    if (message.type === 'log') {
      logs.push(String(message.text))
      continue
    }
    if (message.type === 'call') {
      // The flat wire form: the object marker, then its values in key order.
      const args = message.args as readonly unknown[]
      assert.equal(message.global, 'tools')
      assert.equal(message.name, 'add')
      assert.equal((args[0] as Record<string, unknown>)['kind'], 'object')
      const sum = Number(args[1]) + Number(args[2])
      control!.write(frame({ type: 'reply', id: message.id, ok: true, value: [sum] }))
      continue
    }
    assert.equal(message.type, 'done')
    done = message
    break
  }

  assert.deepEqual(logs, ['sum 3'])
  assert.deepEqual(done?.value, [3])
  assert.equal(done?.error, undefined)

  await handle.done
})
