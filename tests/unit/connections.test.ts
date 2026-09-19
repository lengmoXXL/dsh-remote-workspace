/**
 * Connection management decides whether a remote call can happen at all, so its
 * cases are about the states a router branches on: not connected, connecting,
 * ready, and failed. The manager is exercised through an injected connector, so
 * none of this needs a socket.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConnectedNode } from '../../src/remote/client.ts'
import type { NodeInfo } from '../../src/remote/protocol.ts'
import { createNodeConnections } from '../../src/models/machines.ts'
import type { NodeRecord } from '../../src/storage/nodes.ts'
import { asNodeId } from '../../src/storage/nodes.ts'

const info: NodeInfo = {
  protocol: 1,
  agentVersion: '0.0.1',
  platform: 'linux',
  arch: 'x64',
  node: 'v22.19.0',
  homedir: '/home/dev',
  capability: { pty: false, spill: false, ripgrep: null },
}

const record: NodeRecord = {
  nodeId: asNodeId('n1'),
  title: 'build-01',
  transport: { kind: 'direct', host: 'build-01', port: 7801 },
  token: 'secret',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

/** A connected-node stub whose close() is observable. */
function stubNode(): ConnectedNode & { closed: boolean } {
  const node = {
    closed: false,
    info,
    channel: {
      request: () => Promise.reject(new Error('not used')),
      onPipeFrame: () => () => {},
    },
    close() {
      node.closed = true
    },
  }
  return node
}

test('a node that was never connected reports idle and offers no channel', () => {
  const connections = createNodeConnections()
  assert.deepEqual(connections.status(asNodeId('n1')), { nodeId: asNodeId('n1'), state: 'idle' })
  assert.equal(connections.channel(asNodeId('n1')), undefined)
})

test('a successful handshake publishes the channel and the daemon facts', async () => {
  const node = stubNode()
  const connections = createNodeConnections({ connect: () => Promise.resolve(node) })

  assert.deepEqual(await connections.connect(record), info)
  // The published channel wraps the connection so a lost transport can be
  // noticed, so it is no longer the node's own object; that it is there, and
  // that calls reach the node through it, is what this case is about. The
  // recovery cases cover the reaching.
  assert.notEqual(connections.channel(asNodeId('n1')), undefined)
  assert.deepEqual(connections.status(asNodeId('n1')), { nodeId: asNodeId('n1'), state: 'ready', info })
})

test('concurrent connects share one handshake', async () => {
  let calls = 0
  const connections = createNodeConnections({
    connect: async () => {
      calls += 1
      await new Promise(resolve => setImmediate(resolve))
      return stubNode()
    },
  })

  await Promise.all([connections.connect(record), connections.connect(record)])
  assert.equal(calls, 1)
})

test('an already-ready node returns its info without reconnecting', async () => {
  let calls = 0
  const connections = createNodeConnections({
    connect: () => {
      calls += 1
      return Promise.resolve(stubNode())
    },
  })

  await connections.connect(record)
  await connections.connect(record)
  assert.equal(calls, 1)
})

test('a failed handshake records the failure and offers no channel', async () => {
  const connections = createNodeConnections({
    connect: () => Promise.reject(new Error('connection refused')),
  })

  await assert.rejects(() => connections.connect(record), /connection refused/)
  assert.deepEqual(connections.status(asNodeId('n1')), {
    nodeId: asNodeId('n1'),
    state: 'failed',
    error: 'connection refused',
  })
  assert.equal(connections.channel(asNodeId('n1')), undefined)
})

test('a retry after a failure is allowed and replaces the state', async () => {
  let attempt = 0
  const node = stubNode()
  const connections = createNodeConnections({
    connect: () => {
      attempt += 1
      return attempt === 1 ? Promise.reject(new Error('nope')) : Promise.resolve(node)
    },
  })

  await assert.rejects(() => connections.connect(record))
  await connections.connect(record)
  assert.equal(connections.status(asNodeId('n1')).state, 'ready')
  assert.equal(connections.status(asNodeId('n1')).error, undefined)
})

test('disconnect closes the transport and clears the channel', async () => {
  const node = stubNode()
  const connections = createNodeConnections({ connect: () => Promise.resolve(node) })

  await connections.connect(record)
  connections.disconnect(asNodeId('n1'))

  assert.equal(node.closed, true)
  assert.equal(connections.channel(asNodeId('n1')), undefined)
  assert.equal(connections.status(asNodeId('n1')).state, 'disconnected')
  connections.disconnect(asNodeId('n1'))
})

test('dispose closes every connection', async () => {
  const first = stubNode()
  const second = stubNode()
  const connections = createNodeConnections({
    connect: options => Promise.resolve(options.port === 7801 ? first : second),
  })

  await connections.connect(record)
  await connections.connect({ ...record, nodeId: asNodeId('n2'), transport: { kind: 'direct', host: 'build-01', port: 7802 } })
  connections.dispose()

  assert.equal(first.closed, true)
  assert.equal(second.closed, true)
  assert.deepEqual(connections.list(), [])
})

/** A stored machine reached over SSH, and the forward that carries it. */
function sshRecord(): NodeRecord {
  return {
    ...record,
    transport: { kind: 'ssh', target: 'me@build-01' },
  }
}

test('an ssh record is dialled through the forward it opens', async () => {
  const seen: { host: string; port: number }[] = []
  const connections = createNodeConnections({
    openTransport: () => Promise.resolve({ host: '127.0.0.1', port: 52096, close: () => {} }),
    connect: (options) => {
      seen.push({ host: options.host, port: options.port })
      return Promise.resolve(stubNode())
    },
  })

  await connections.connect(sshRecord())

  assert.deepEqual(seen, [{ host: '127.0.0.1', port: 52096 }])
  assert.equal(connections.status(asNodeId('n1')).localPort, 52096)
})

test('an install in flight is published on the status and cleared once ready', async () => {
  let phaseDuringOpen: string | undefined
  let sourceDuringHandshake: string | undefined
  const connections = createNodeConnections({
    openTransport: (_record, report) => {
      report({ phase: 'fetching', version: '0.0.1', asset: 'dsh-remote-agent-linux-x86_64', source: 'network' })
      phaseDuringOpen = connections.status(asNodeId('n1')).progress?.phase
      return Promise.resolve({ host: '127.0.0.1', port: 1, close: () => {} })
    },
    connect: () => {
      sourceDuringHandshake = connections.status(asNodeId('n1')).progress?.source
      return Promise.resolve(stubNode())
    },
  })

  await connections.connect(sshRecord())

  assert.equal(phaseDuringOpen, 'fetching')
  assert.equal(sourceDuringHandshake, 'network')
  assert.equal(connections.status(asNodeId('n1')).progress, undefined)
})

test('a failed install settles the machine and leaves it retryable', async () => {
  let attempts = 0
  const connections = createNodeConnections({
    openTransport: (_record, report) => {
      attempts += 1
      report({ phase: 'uploading', version: '0.0.1' })
      // A download or upload that fails is an opener failure, not a handshake
      // one, and it must not strand the machine in `connecting`.
      if (attempts === 1) return Promise.reject(new Error('scp died'))
      return Promise.resolve({ host: '127.0.0.1', port: 1, close: () => {} })
    },
    connect: () => Promise.resolve(stubNode()),
  })

  await assert.rejects(() => connections.connect(sshRecord()), /scp died/)
  const failed = connections.status(asNodeId('n1'))
  assert.equal(failed.state, 'failed')
  assert.equal(failed.error, 'scp died')
  assert.equal(failed.progress, undefined)

  // The next attempt runs the opener again instead of replaying the rejection.
  await connections.connect(sshRecord())
  assert.equal(connections.status(asNodeId('n1')).state, 'ready')
  assert.equal(attempts, 2)
})

test('a direct record is dialled at its recorded address and reports no forward', async () => {
  const seen: { host: string; port: number }[] = []
  const connections = createNodeConnections({
    connect: (options) => {
      seen.push({ host: options.host, port: options.port })
      return Promise.resolve(stubNode())
    },
  })

  await connections.connect(record)

  assert.deepEqual(seen, [{ host: 'build-01', port: 7801 }])
  assert.equal(connections.status(asNodeId('n1')).localPort, undefined)
})

test('either deadline through a forward blames the absent daemon', async () => {
  // The socket deadline and the handshake deadline are different failures, and
  // both mean the same thing once a forward is carrying the traffic.
  for (const message of [
    'timed out connecting to 127.0.0.1:1',
    'handshake with 127.0.0.1:1 timed out',
  ]) {
    let closed = false
    const connections = createNodeConnections({
      openTransport: () => Promise.resolve({ host: '127.0.0.1', port: 1, close: () => { closed = true } }),
      connect: () => Promise.reject(new Error(message)),
    })

    await assert.rejects(
      () => connections.connect(sshRecord()),
      /forward to "me@build-01" is up, but nothing answered; check ~\/\.dsh\/remote-agent\/agent\.log/,
      message,
    )
    // The forward exists only to carry the connection that just failed.
    assert.equal(closed, true, message)
    assert.equal(connections.status(asNodeId('n1')).state, 'failed', message)
  }
})

test('a handshake failure on a direct address keeps the connector’s own words', async () => {
  const connections = createNodeConnections({
    connect: () => Promise.reject(new Error('timed out connecting to build-01:7801')),
  })

  await assert.rejects(() => connections.connect(record), /timed out connecting to build-01:7801/)
})

test('a forward that dies after connecting publishes the loss', async () => {
  let die: () => void = () => {}
  const exited = new Promise<void>((resolve) => { die = resolve })
  const connections = createNodeConnections({
    openTransport: () => Promise.resolve({ host: '127.0.0.1', port: 1, exited, close: () => {} }),
    connect: () => Promise.resolve(stubNode()),
  })

  await connections.connect(sshRecord())
  assert.equal(connections.status(asNodeId('n1')).state, 'ready')

  die()
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(connections.status(asNodeId('n1')).state, 'failed')
  assert.match(String(connections.status(asNodeId('n1')).error), /forward to "build-01" closed/)
})

test('disconnecting closes the forward it opened', async () => {
  let closed = false
  const connections = createNodeConnections({
    openTransport: () => Promise.resolve({ host: '127.0.0.1', port: 1, close: () => { closed = true } }),
    connect: () => Promise.resolve(stubNode()),
  })

  await connections.connect(sshRecord())
  connections.disconnect(asNodeId('n1'))

  assert.equal(closed, true)
  assert.equal(connections.status(asNodeId('n1')).localPort, undefined)
})

test('disposing closes every forward', async () => {
  let closed = 0
  const connections = createNodeConnections({
    openTransport: () => Promise.resolve({ host: '127.0.0.1', port: 1, close: () => { closed += 1 } }),
    connect: () => Promise.resolve(stubNode()),
  })

  await connections.connect(sshRecord())
  connections.dispose()

  assert.equal(closed, 1)
})

test('the default opener ensures the agent from the record before forwarding', async () => {
  let asked: { token: string; version: string; cacheDir: string } | undefined
  const connections = createNodeConnections({
    cacheDir: '/tmp/agents',
    agentVersion: '9.9.9',
    ensureAgent: (options) => {
      asked = { token: options.token, version: options.version, cacheDir: options.cacheDir }
      return Promise.reject(new Error('agent install refused'))
    },
  })

  await assert.rejects(() => connections.connect(sshRecord()), /agent install refused/)
  assert.deepEqual(asked, { token: 'secret', version: '9.9.9', cacheDir: '/tmp/agents' })
})

test('an ssh record without a cache directory is refused before any process starts', async () => {
  const connections = createNodeConnections({
    ensureAgent: () => Promise.reject(new Error('must not be reached')),
  })

  await assert.rejects(
    () => connections.connect(sshRecord()),
    /needs the plugin data directory to cache the agent/,
  )
})
