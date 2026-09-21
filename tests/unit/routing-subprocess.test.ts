/**
 * The remote spawn proxy is the one piece of this plugin where a contract the
 * seam states synchronously meets a transport that answers asynchronously. Its
 * cases pin the three consequences: the handle exists before the daemon has
 * answered, the collected mirror is complete by the time `done` settles, and a
 * disposition this design cannot carry is refused instead of silently degraded.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { SpPipeFrame } from '../../src/remote/protocol.ts'
import type { NodeChannel } from '../../src/remote/client.ts'
import { NodeRequestError } from '../../src/remote/client.ts'
import type { AnchorRoute } from '../../src/storage/anchors.ts'
import { createRoutingSubprocessRuntime } from '../../src/plugin/routing/subprocess.ts'
import { asNodeId } from '../../src/storage/nodes.ts'
import type { ProcId } from '../../src/remote/protocol.ts'

const anchors: AnchorRoute[] = [
  { nodeId: asNodeId('n1'), anchorPath: '/local/anchors/n1/app/login', remoteRoot: '/srv/app/login' },
]

/** A spawn spec for one world. */
function spec(cwd: string, overrides: Partial<SubprocessSpawnSpec['stdio']> = {}): SubprocessSpawnSpec {
  return {
    argv: ['echo', 'hi'],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 4096 },
      stderr: { maxBytes: 4096 },
      ...overrides,
    },
    graceMs: 1000,
  }
}

/** A daemon stub answering from a script of output chunks. */
function fakeDaemon(options: {
  stdout?: readonly string[]
  stderr?: readonly string[]
  exitCode?: number | null
  spawnError?: NodeRequestError
  onCall?: (method: string, params: unknown) => void
  missingOnNode?: (path: string) => boolean
}) {
  const calls: { method: string; params: unknown }[] = []
  const chunks = { stdout: options.stdout ?? [], stderr: options.stderr ?? [] }

  let pipeHandler: ((frame: SpPipeFrame) => void) | undefined
  const channel: NodeChannel = {
    onPipeFrame(handler) {
      pipeHandler = handler
      return () => { pipeHandler = undefined }
    },
    request(method, params) {
      calls.push({ method, params })
      options.onCall?.(method, params)
      const record = params as { stream?: 'stdout' | 'stderr'; fromByte?: number; path?: string }
      switch (method) {
        case 'fs.stat':
          return Promise.resolve(
            options.missingOnNode?.(record.path ?? '') === true
              ? null
              : { version: 'v1', type: 'file' },
          ) as never
        case 'sp.spawn':
          if (options.spawnError !== undefined) return Promise.reject(options.spawnError) as never
          return Promise.resolve({ procId: 'p1' }) as never
        case 'sp.waitForExit':
          return Promise.resolve({}) as never
        case 'sp.outcome':
          return Promise.resolve({ exitCode: options.exitCode ?? 0, signal: null }) as never
        case 'sp.readOutput': {
          const stream = record.stream ?? 'stdout'
          const list = chunks[stream]
          // Byte length of the UTF-8 text the stub models.
          const sizes = list.map(entry => Buffer.byteLength(entry, 'utf8'))
          const total = sizes.reduce((sum, size) => sum + size, 0)
          const fromByte = record.fromByte ?? 0
          let offset = 0
          let text = ''
          for (const [index, entry] of list.entries()) {
            const end = offset + sizes[index]!
            if (end > fromByte) text += entry
            offset = end
          }
          return Promise.resolve({
            data: Buffer.from(text, 'utf8').toString('base64'),
            nextOffset: total,
            lossy: false,
          }) as never
        }
        default:
          return Promise.resolve({}) as never
      }
    },
  }
  return { channel, calls, emit: (frame: SpPipeFrame) => pipeHandler?.(frame) }
}

/** A local delegate that must never be reached for a remote cwd. */
const unusedLocal = {
  resolveExecutable: () => Promise.reject(new Error('local resolveExecutable was reached')),
  spawn: () => {
    throw new Error('local spawn was reached')
  },
  spawnTerminal: () => Promise.reject(new Error('local spawnTerminal was reached')),
} as unknown as SubprocessRuntime

function runtime(channel: NodeChannel) {
  return createRoutingSubprocessRuntime({
    localProc: unusedLocal,
    anchors: () => anchors,
    channel: id => (id === 'n1' ? channel : undefined),
  })
}

test('a remote spawn returns a handle before the daemon has answered', async () => {
  const { channel, calls } = fakeDaemon({ stdout: ['hello\n'] })
  const handle = runtime(channel).spawn(spec('/srv/app/login'))

  // The handle exists synchronously; the spawn request is already in flight.
  assert.equal(typeof handle.terminate, 'function')
  assert.deepEqual(await handle.done, { exitCode: 0, signal: null })
  assert.equal(calls[0]?.method, 'sp.spawn')
})

test('the collected mirror is complete by the time done settles', async () => {
  const { channel } = fakeDaemon({ stdout: ['hello ', 'world\n'], stderr: ['warn\n'] })
  const handle = runtime(channel).spawn(spec('/srv/app/login'))
  await handle.done

  assert.deepEqual(handle.collected.stdout?.readFrom(0), {
    text: 'hello world\n',
    nextOffset: 12,
    lossy: false,
  })
  assert.equal(handle.collected.stderr?.readFrom(0).text, 'warn\n')
})

test('resuming from the reported offset returns only the delta', async () => {
  const { channel } = fakeDaemon({ stdout: ['one\n', 'two\n'] })
  const handle = runtime(channel).spawn(spec('/srv/app/login'))
  await handle.done

  const first = handle.collected.stdout!.readFrom(0)
  const rest = handle.collected.stdout!.readFrom(first.nextOffset)
  assert.equal(rest.text, '')
  assert.equal(rest.nextOffset, first.nextOffset)
})

test('a piped stream is delivered from the daemon frames, in order', async () => {
  const { channel, emit } = fakeDaemon({})
  const handle = runtime(channel).spawn(spec('/srv/app/login', { stdout: 'pipe' }))

  const seen: string[] = []
  handle.stdout!.on('data', (chunk: Buffer | string) => seen.push(chunk.toString()))
  emit({ procId: 'p1' as ProcId, stream: 'stdout', seq: 0, data: Buffer.from('hello ').toString('base64') })
  emit({ procId: 'p1' as ProcId, stream: 'stdout', seq: 1, data: Buffer.from('world').toString('base64') })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(seen.join(''), 'hello world')
  await handle.done
})

test('a frame that arrives before the spawn answer is not lost', async () => {
  const { channel, emit } = fakeDaemon({})
  const handle = runtime(channel).spawn(spec('/srv/app/login', { stdout: 'pipe' }))

  const seen: string[] = []
  handle.stdout!.on('data', (chunk: Buffer | string) => seen.push(chunk.toString()))
  // Pushed before `sp.spawn` has resolved: the race the buffer exists for.
  emit({ procId: 'p1' as ProcId, stream: 'stdout', seq: 0, data: Buffer.from('early').toString('base64') })
  await handle.done
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(seen.join(''), 'early')
})

test('a frame for another process is ignored', async () => {
  const { channel, emit } = fakeDaemon({})
  const handle = runtime(channel).spawn(spec('/srv/app/login', { stdout: 'pipe' }))

  const seen: string[] = []
  handle.stdout!.on('data', (chunk: Buffer | string) => seen.push(chunk.toString()))
  // Emitted while the handler is live: the process-id guard is what keeps it out.
  emit({ procId: 'someone-else' as ProcId, stream: 'stdout', seq: 0, data: Buffer.from('nope').toString('base64') })
  await handle.done
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(seen.join(''), '')
})

test('a failed start rejects done and reports no output', async () => {
  const { channel } = fakeDaemon({
    spawnError: new NodeRequestError({ code: 'SP_NOT_FOUND', message: 'no such binary' }),
  })
  const handle = runtime(channel).spawn(spec('/srv/app/login'))
  await assert.rejects(() => handle.done, /no such binary/)
  assert.equal(handle.collected.stdout?.readFrom(0).text, '', 'a start that failed collected nothing')
})

test('batch stdin is written and closed before the wait', async () => {
  const { channel, calls } = fakeDaemon({ stdout: ['ok\n'] })
  const handle = runtime(channel).spawn(spec('/srv/app/login', { stdin: { data: 'payload' } }))
  await handle.done

  const methods = calls.map(call => call.method)
  assert.deepEqual(methods.slice(0, 3), ['sp.spawn', 'sp.writeStdin', 'sp.closeStdin'])
  assert.equal((calls[1]?.params as { data: string }).data, 'payload')
})

test('terminate before the daemon answers still terminates', async () => {
  const seen: string[] = []
  const { channel } = fakeDaemon({ stdout: [], onCall: method => seen.push(method) })
  const handle = runtime(channel).spawn(spec('/srv/app/login'))
  handle.terminate()
  await handle.done

  assert.equal(seen.filter(method => method === 'sp.terminate').length, 1)
})

test('an offline node is refused before any process is created', () => {
  const offline = createRoutingSubprocessRuntime({
    localProc: unusedLocal,
    anchors: () => anchors,
    channel: () => undefined,
  })
  assert.throws(() => offline.spawn(spec('/srv/app/login')), /is not connected/)
})

test('an ambiguous remote cwd is refused, never guessed', () => {
  const twoNodes: AnchorRoute[] = [...anchors, { ...anchors[0]!, nodeId: asNodeId('n2') }]
  const { channel } = fakeDaemon({})
  const routing = createRoutingSubprocessRuntime({
    localProc: unusedLocal,
    anchors: () => twoNodes,
    channel: () => channel,
  })
  assert.throws(() => routing.spawn(spec('/srv/app/login')), /more than one node/)
})

test('a host-resolved ripgrep path is rewritten for the node', async () => {
  const { channel, calls } = fakeDaemon({ stdout: [] })
  const routing = createRoutingSubprocessRuntime({
    localProc: unusedLocal,
    anchors: () => anchors,
    channel: () => channel,
  })
  const handle = routing.spawn({
    ...spec('/srv/app/login'),
    argv: ['/Users/dev/.dsh/bin/rg', '--json', 'needle'],
  })
  await handle.done

  assert.deepEqual((calls[0]?.params as { argv: readonly string[] }).argv, ['rg', '--json', 'needle'])
})

test('a non-ripgrep absolute path is passed through for the node to judge', async () => {
  const { channel, calls } = fakeDaemon({ stdout: [] })
  const routing = createRoutingSubprocessRuntime({
    localProc: unusedLocal,
    anchors: () => anchors,
    channel: () => channel,
  })
  const handle = routing.spawn({ ...spec('/srv/app/login'), argv: ['/usr/bin/env', 'node'] })
  await handle.done

  assert.deepEqual((calls[0]?.params as { argv: readonly string[] }).argv, ['/usr/bin/env', 'node'])
})

test('a host-only executable collapses to the node-resolved bare name', async () => {
  const { channel, calls } = fakeDaemon({
    stdout: [],
    missingOnNode: path => path === '/opt/host-only/node',
  })
  const routing = createRoutingSubprocessRuntime({
    localProc: unusedLocal,
    anchors: () => anchors,
    channel: () => channel,
  })
  const handle = routing.spawn({ ...spec('/srv/app/login'), argv: ['/opt/host-only/node', '--version'] })
  await handle.done

  const spawn = calls.find(call => call.method === 'sp.spawn')?.params as { argv: readonly string[] }
  assert.deepEqual(spawn.argv, ['node', '--version'])
})

test('a host package asset is staged onto the node and its path rewritten', async () => {
  const asset = join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh-subprocess', 'package.json')
  const content = await readFile(asset, 'utf8')
  const { channel, calls } = fakeDaemon({ stdout: [], missingOnNode: path => path === asset })
  const routing = createRoutingSubprocessRuntime({
    localProc: unusedLocal,
    anchors: () => anchors,
    channel: () => channel,
  })
  const handle = routing.spawn({ ...spec('/srv/app/login'), argv: ['/usr/bin/node', asset] })
  await handle.done

  const spawn = calls.find(call => call.method === 'sp.spawn')?.params as { argv: readonly string[] }
  const staged = spawn.argv[1]!
  assert.equal(spawn.argv[0], '/usr/bin/node', 'a system executable is left for the node to judge')
  assert.match(staged, /^\/tmp\/dsh-remote-assets\/[0-9a-f]{16}-package\.json$/)

  const write = calls.find(call => call.method === 'fs.writeText')?.params as { path: string; content: string }
  assert.equal(write.path, staged)
  assert.equal(write.content, content)
})

test('a host sandbox wrapper is removed before the command reaches the node', async () => {
  const { channel, calls } = fakeDaemon({ stdout: [] })
  const routing = createRoutingSubprocessRuntime({
    localProc: unusedLocal,
    anchors: () => anchors,
    channel: () => channel,
  })
  const handle = routing.spawn({
    ...spec('/srv/app/login'),
    argv: ['sandbox-exec', '-p', '(version 1)', '--', 'echo', 'hi', '--', 'tail'],
  })
  await handle.done

  const spawn = calls.find(call => call.method === 'sp.spawn')?.params as { argv: readonly string[] }
  assert.deepEqual(spawn.argv, ['echo', 'hi', '--', 'tail'])
})

test('an ordinary command containing a -- separator is left alone', async () => {
  const { channel, calls } = fakeDaemon({ stdout: [] })
  const routing = createRoutingSubprocessRuntime({
    localProc: unusedLocal,
    anchors: () => anchors,
    channel: () => channel,
  })
  const handle = routing.spawn({ ...spec('/srv/app/login'), argv: ['git', 'commit', '--', 'file'] })
  await handle.done

  const spawn = calls.find(call => call.method === 'sp.spawn')?.params as { argv: readonly string[] }
  assert.deepEqual(spawn.argv, ['git', 'commit', '--', 'file'])
})

test('a host asset the node already has is left alone', async () => {
  const asset = join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh-subprocess', 'package.json')
  const { channel, calls } = fakeDaemon({ stdout: [] })
  const routing = createRoutingSubprocessRuntime({
    localProc: unusedLocal,
    anchors: () => anchors,
    channel: () => channel,
  })
  const handle = routing.spawn({ ...spec('/srv/app/login'), argv: ['/usr/bin/node', asset] })
  await handle.done

  const spawn = calls.find(call => call.method === 'sp.spawn')?.params as { argv: readonly string[] }
  assert.equal(spawn.argv[1], asset)
  assert.equal(calls.some(call => call.method === 'fs.writeText'), false)
})

test('the local branch is delegated untouched', () => {
  const { channel } = fakeDaemon({})
  let delegated: SubprocessSpawnSpec | undefined
  const local = {
    resolveExecutable: () => Promise.reject(new Error('unused')),
    spawn: (spawnSpec: SubprocessSpawnSpec): SubprocessHandle => {
      delegated = spawnSpec
      return {} as SubprocessHandle
    },
    spawnTerminal: () => Promise.reject(new Error('unused')),
  } as unknown as SubprocessRuntime
  const routing = createRoutingSubprocessRuntime({
    localProc: local,
    anchors: () => anchors,
    channel: () => channel,
  })

  routing.spawn(spec('/local/anchors/n1/app/login/../elsewhere'))
  assert.equal(delegated?.cwd, '/local/anchors/n1/app/login/../elsewhere')
})
