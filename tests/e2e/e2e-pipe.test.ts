/**
 * A raw piped stream, end to end.
 *
 * The point of `'pipe'` over `'collect'` is liveness: a language server's
 * protocol decoder must see a request's bytes before the process exits. This
 * suite proves that directly — it waits for the first chunk while the child is
 * *still running* — rather than asserting that the bytes eventually arrive,
 * which collected output already guaranteed.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startAgent } from './harness.ts'
import type { TestAgent } from './harness.ts'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { connectNode } from '../../src/remote/client.ts'
import type { ConnectedNode } from '../../src/remote/client.ts'
import type { AnchorRoute } from '../../src/storage/anchors.ts'
import { createRoutingSubprocessRuntime } from '../../src/plugin/routing/subprocess.ts'

/** The PTC program host this router is told about; no case here runs a PTC program. */
const ptcHost = async () => '/home/dev/.dsh/remote-agent/dsh-ptc-host'
import { asNodeId } from '../../src/storage/nodes.ts'

const TOKEN = 'pipe-token-0123456789'

let remoteRoot: string
let anchorRoot: string
let server: TestAgent
let node: ConnectedNode
let runtime: ReturnType<typeof createRoutingSubprocessRuntime>

before(async () => {
  remoteRoot = await realpath(await mkdtemp(join(tmpdir(), 'drw-pipe-remote-')))
  anchorRoot = await realpath(await mkdtemp(join(tmpdir(), 'drw-pipe-anchor-')))

  server = await startAgent({ token: TOKEN, root: remoteRoot })
  const port = Number(server.boundAddress.slice(server.boundAddress.lastIndexOf(':') + 1))
  node = await connectNode({ host: '127.0.0.1', port, token: TOKEN, timeoutMs: 5_000 })

  const anchors: AnchorRoute[] = [{ nodeId: asNodeId('n1'), anchorPath: anchorRoot, remoteRoot }]
  runtime = createRoutingSubprocessRuntime({
    ptcHost,
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

/** Collect a stream into one string, resolving when `done` settles. */
function collect(stream: NodeJS.ReadableStream): { text: () => string } {
  const parts: string[] = []
  stream.on('data', (chunk: Buffer | string) => parts.push(chunk.toString()))
  return { text: () => parts.join('') }
}

test('a piped stdout delivers bytes while the child is still running', async () => {
  const handle = runtime.spawn({
    argv: ['bash', '-c', 'printf first; sleep 1.2; printf second'],
    cwd: anchorRoot,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 4096 } },
    graceMs: 2000,
  })
  assert.notEqual(handle.stdout, undefined)
  const out = collect(handle.stdout!)
  let exited = false
  void handle.done.then(() => { exited = true })

  // The first bytes must arrive well before the child's 1.2s sleep ends.
  const deadline = Date.now() + 900
  while (!out.text().includes('first') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }

  assert.match(out.text(), /first/, 'the first chunk did not arrive while the child ran')
  assert.equal(exited, false, 'the child had already exited, so this was not a live stream')

  await handle.done
  assert.match(out.text(), /first.*second/s)
})

test('both streams can be piped at once without crossing', async () => {
  const handle = runtime.spawn({
    argv: ['bash', '-c', 'printf out-a; printf err-a >&2; printf out-b; printf err-b >&2'],
    cwd: anchorRoot,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 2000,
  })
  const out = collect(handle.stdout!)
  const err = collect(handle.stderr!)
  await handle.done

  assert.equal(out.text(), 'out-aout-b')
  assert.equal(err.text(), 'err-aerr-b')
})

test('a piped stream carries arbitrary bytes without decoding them', async () => {
  // 0xff 0xfe are not valid UTF-8; a decoder anywhere on the path would alter them.
  const handle = runtime.spawn({
    argv: ['bash', '-c', 'printf "\\xff\\xfeAB"'],
    cwd: anchorRoot,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 4096 } },
    graceMs: 2000,
  })
  const chunks: Buffer[] = []
  handle.stdout!.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk as Buffer)))
  await handle.done

  assert.deepEqual([...Buffer.concat(chunks)], [0xff, 0xfe, 0x41, 0x42])
})

test('batch stdin still reaches a child whose stdout is piped', async () => {
  const handle = runtime.spawn({
    argv: ['bash', '-c', 'cat'],
    cwd: anchorRoot,
    stdio: { stdin: { data: 'piped in\n' }, stdout: 'pipe', stderr: { maxBytes: 4096 } },
    graceMs: 2000,
  })
  const out = collect(handle.stdout!)
  await handle.done

  assert.equal(out.text(), 'piped in\n')
})

test('a piped stream is not also readable as collected output', async () => {
  const handle = runtime.spawn({
    argv: ['bash', '-c', 'printf ignored'],
    cwd: anchorRoot,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 4096 } },
    graceMs: 2000,
  })

  assert.equal(handle.collected.stdout, undefined)
  await handle.done
})
