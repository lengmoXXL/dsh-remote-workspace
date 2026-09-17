/**
 * The node client's writer is what keeps a socket that dies under a write from
 * taking the host down: `vscode-jsonrpc` orphans that failure as an unhandled
 * rejection, which the host reports as a fatal load failure.
 */

import assert from 'node:assert/strict'
import { Socket } from 'node:net'
import { test } from 'node:test'
import { createMessageConnection, StreamMessageReader } from 'vscode-jsonrpc/node.js'
import { SocketWriter } from '../../src/remote/client.ts'

/** A socket that is already gone, so every write to it fails. */
function deadSocket(): Socket {
  const socket = new Socket()
  socket.destroy()
  return socket
}

test('a write to a dead socket tears the connection down instead of rejecting', async () => {
  let failures = 0
  const writer = new SocketWriter(deadSocket(), () => { failures += 1 })

  await writer.write({ jsonrpc: '2.0' })

  assert.equal(failures, 1, 'the connection is told, so it can reject its pending call')
})

test('a request on a dead socket fails without an orphaned rejection', async () => {
  const socket = deadSocket()
  let disposeConnection: () => void = () => {}
  const writer = new SocketWriter(socket, () => { disposeConnection() })
  const connection = createMessageConnection(new StreamMessageReader(socket), writer)
  disposeConnection = () => { connection.dispose() }
  connection.listen()

  const rejections: unknown[] = []
  const onRejection = (reason: unknown): void => { rejections.push(reason) }
  process.on('unhandledRejection', onRejection)
  try {
    await assert.rejects(connection.sendRequest('x', {}), /Pending response rejected/)
    await new Promise(resolve => setImmediate(resolve))
  } finally {
    process.off('unhandledRejection', onRejection)
    connection.dispose()
  }

  assert.deepEqual(rejections, [], 'the host never sees the orphaned write failure')
})
