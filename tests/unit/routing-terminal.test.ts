/**
 * The remote terminal proxy turns a polled retained window into the live
 * `Readable` the seam promises. Its cases are about that translation: output
 * arrives, teardown drains what is left, and the handle settles instead of
 * hanging when the connection is gone.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SubprocessRuntime, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { RemoteTerminalHandle } from '../../src/plugin/routing/subprocess.ts'
import type { NodeChannel } from '../../src/remote/client.ts'
import type { AnchorRoute } from '../../src/storage/anchors.ts'
import { createRoutingSubprocessRuntime } from '../../src/plugin/routing/subprocess.ts'

/** The PTC program host this router is told about; no case here runs a PTC program. */
const ptcHost = async () => '/home/dev/.dsh/remote-agent/dsh-ptc-host'
import { asNodeId } from '../../src/storage/nodes.ts'

const anchors: AnchorRoute[] = [
  { nodeId: asNodeId('n1'), anchorPath: '/local/anchors/n1/app/login', remoteRoot: '/srv/app/login' },
]

const spec = (cwd: string): SubprocessTerminalSpawnSpec => ({
  argv: ['bash', '-i'],
  cwd,
  rows: 24,
  cols: 80,
  terminalType: 'xterm-256color',
  graceMs: 1000,
})

/** Wait long enough for at least one poll interval to elapse. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 120))

/** A daemon stub for the terminal methods. */
function fakeTerminalDaemon(options: {
  chunks?: readonly string[]
  exitAfterReads?: number
  exitCode?: number | null
  foreground?: { processGroupId: number; inputWaiting: boolean } | null
}) {
  const calls: { method: string; params: unknown }[] = []
  const chunks = options.chunks ?? []
  const waiting: (() => void)[] = []
  let offset = 0
  let reads = 0
  let terminated = false

  /** Whether the terminal has exited, by the script's own count or by release. */
  const ended = (): boolean =>
    terminated || reads >= (options.exitAfterReads ?? Number.POSITIVE_INFINITY)

  const channel: NodeChannel = {
    onPipeFrame: () => () => {},
    async request(method, params) {
      calls.push({ method, params })
      switch (method) {
        case 'term.spawn':
          return { termId: 't1', pid: 4242 } as never
        case 'term.read': {
          reads += 1
          const request = params as { fromByte: number }
          const from = request.fromByte
          let text = ''
          let cursor = 0
          for (const chunk of chunks) {
            const end = cursor + Buffer.byteLength(chunk, 'utf8')
            if (end > from) text += chunk
            cursor = end
          }
          offset = cursor
          // A read with nothing to answer holds until the terminal is released,
          // which is what the daemon's wait budget does; one that returned at
          // once would spin the proxy's loop.
          if (!ended() && text === '') {
            await new Promise<void>(resolve => { waiting.push(resolve) })
          }
          return {
            data: Buffer.from(text, 'utf8').toString('base64'),
            nextOffset: offset,
            lossy: false,
            ...ended() ? { outcome: { exitCode: options.exitCode ?? 0, signal: null } } : {},
          } as never
        }
        case 'term.outcome':
          return (ended() ? { exitCode: options.exitCode ?? 0, signal: null } : null) as never
        case 'term.inspectForeground':
          return (options.foreground ?? null) as never
        case 'term.signalForeground':
          return { processGroupId: 777 } as never
        case 'term.terminate':
          terminated = true
          for (const resolve of waiting.splice(0)) resolve()
          return {} as never
        default:
          return {} as never
      }
    },
  }
  return { channel, calls, isTerminated: () => terminated }
}

/** A local delegate that must never be reached for a remote cwd. */
const unusedLocal = {
  resolveExecutable: () => Promise.reject(new Error('unused')),
  spawn: () => {
    throw new Error('unused')
  },
  spawnTerminal: () => Promise.reject(new Error('local spawnTerminal was reached')),
} as unknown as SubprocessRuntime

function runtime(channel: NodeChannel) {
  return createRoutingSubprocessRuntime({
    ptcHost,
    localProc: unusedLocal,
    anchors: () => anchors,
    channel: id => (id === 'n1' ? channel : undefined),
  })
}

test('a remote terminal reports the daemon pid and streams output', async () => {
  const { channel } = fakeTerminalDaemon({ chunks: ['$ ', 'echo hi\n'] })
  const handle = await runtime(channel).spawnTerminal(spec('/srv/app/login'))

  assert.equal(handle.pid, 4242)
  const seen: string[] = []
  handle.output.on('data', (chunk: Buffer | string) => seen.push(chunk.toString()))
  await settle()

  assert.equal(seen.join(''), '$ echo hi\n')
  await handle.terminate()
})

test('write reaches the terminal untouched', async () => {
  const { channel, calls } = fakeTerminalDaemon({})
  const handle = await runtime(channel).spawnTerminal(spec('/srv/app/login'))
  await handle.write('ls\n')

  const write = calls.find(call => call.method === 'term.write')
  assert.deepEqual(write?.params, { termId: 't1', data: 'ls\n' })
  await handle.terminate()
})

test('resize reaches the daemon as the terminal method', async () => {
  const { channel, calls } = fakeTerminalDaemon({})
  const handle = await runtime(channel).spawnTerminal(spec('/srv/app/login'))
  // The capability the seam has no verb for, published beside it.
  await (handle as RemoteTerminalHandle).resize(120, 40)

  const resize = calls.find(call => call.method === 'term.resize')
  assert.deepEqual(resize?.params, { termId: 't1', cols: 120, rows: 40 })
  await handle.terminate()
})

test('a terminal with no foreground group reports undefined, not a zero id', async () => {
  const { channel } = fakeTerminalDaemon({ foreground: null })
  const handle = await runtime(channel).spawnTerminal(spec('/srv/app/login'))

  assert.equal(await handle.inspectForeground(), undefined)
  await handle.terminate()
})

test('foreground facts and signals come back from the daemon', async () => {
  const { channel } = fakeTerminalDaemon({ foreground: { processGroupId: 501, inputWaiting: true } })
  const handle = await runtime(channel).spawnTerminal(spec('/srv/app/login'))

  assert.deepEqual(await handle.inspectForeground(), { processGroupId: 501, inputWaiting: true })
  assert.equal(await handle.signalForeground('SIGINT'), 777)
  await handle.terminate()
})

test('the handle settles once the terminal exits on its own', async () => {
  const { channel } = fakeTerminalDaemon({ chunks: ['bye\n'], exitAfterReads: 1, exitCode: 3 })
  const handle = await runtime(channel).spawnTerminal(spec('/srv/app/login'))

  assert.deepEqual(await handle.done, { exitCode: 3, signal: null })
})

test('terminate ends the output and settles the handle', async () => {
  const { channel, isTerminated } = fakeTerminalDaemon({ chunks: ['partial'] })
  const handle = await runtime(channel).spawnTerminal(spec('/srv/app/login'))
  await settle()
  await handle.terminate()

  assert.equal(isTerminated(), true)
  assert.deepEqual(await handle.done, { exitCode: 0, signal: null })
})

test('a disconnected node is refused before any terminal is allocated', async () => {
  const offline = createRoutingSubprocessRuntime({
    ptcHost,
    localProc: unusedLocal,
    anchors: () => anchors,
    channel: () => undefined,
  })
  await assert.rejects(() => offline.spawnTerminal(spec('/srv/app/login')), /is not connected/)
})

test('a local terminal is delegated untouched', async () => {
  const { channel } = fakeTerminalDaemon({})
  let delegated: SubprocessTerminalSpawnSpec | undefined
  const local = {
    resolveExecutable: () => Promise.reject(new Error('unused')),
    spawn: () => {
      throw new Error('unused')
    },
    spawnTerminal: (terminalSpec: SubprocessTerminalSpawnSpec) => {
      delegated = terminalSpec
      return Promise.reject(new Error('delegated'))
    },
  } as unknown as SubprocessRuntime
  const routing = createRoutingSubprocessRuntime({
    ptcHost,
    localProc: local,
    anchors: () => anchors,
    channel: () => channel,
  })

  // Outside every anchor: the anchor path itself would classify as remote,
  // which is the whole point of the routing table.
  await assert.rejects(() => routing.spawnTerminal(spec('/tmp/elsewhere')), /delegated/)
  assert.equal(delegated?.cwd, '/tmp/elsewhere')
})
