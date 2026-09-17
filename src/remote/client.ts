/**
 * The node channel: what the rest of the plugin may ask one node, and the TCP
 * client that answers it.
 *
 * {@link NodeChannel} is the narrow view every consumer holds — round-trip one
 * protocol method, watch the pushed frames of a piped stream — so the file
 * layer, the process layer, and the worktree lifecycle never see a socket,
 * a handshake, or `vscode-jsonrpc`. {@link NodeRequestError} is the other half
 * of that view: a daemon failure with the code the call sites branch on.
 *
 * The client below is the only implementation: `vscode-jsonrpc` owns framing,
 * request correlation, and cancellation on top of the socket, so it only
 * establishes the connection, performs the handshake, and translates a daemon
 * failure into that error. What supplies the socket — an SSH forward today, the
 * recorded address for a `direct` record — is the caller's business, which is
 * what lets one client serve both.
 *
 * @module dsh-remote-workspace/remote/client
 */

import { Socket } from 'node:net'
// The `.js` suffix is required: this package ships no `exports` map, so an
// extensionless subpath is not resolvable from ESM even though the file is.
import { ResponseError, StreamMessageReader, StreamMessageWriter, createMessageConnection } from 'vscode-jsonrpc/node.js'
import type { NodeInfo, SpPipeFrame, WireErrorData, WireMethod, WireParams, WireResult } from './protocol.ts'
import { PROTOCOL_VERSION, SP_PIPE_NOTIFICATION } from './protocol.ts'
import type { NodeId } from '../storage/nodes.ts'

/** One live connection to a node's daemon. */
export interface NodeChannel {
  /**
   * Round-trip one protocol method.
   * @param method - the wire method name.
   * @param params - that method's parameters.
   * @returns the method result.
   * @throws NodeRequestError when the daemon answers with a typed wire failure,
   *   and a transport error when the connection drops.
   */
  request<M extends WireMethod>(method: M, params: WireParams<M>): Promise<WireResult<M>>
  /**
   * Observe the raw chunks the daemon pushes for `'pipe'` streams.
   *
   * A raw piped stream is pushed, not retained, so a consumer that misses a
   * frame has lost those bytes; a caller registers before it spawns the process
   * it cares about. One handler is active at a time, matching the connection's
   * own single notification slot.
   * @param handler - invoked per pushed chunk.
   * @returns a disposer that removes the handler.
   */
  onPipeFrame(handler: (frame: SpPipeFrame) => void): () => void
}

/** A typed failure the daemon reported, carrying the seam's own error code. */
export class NodeRequestError extends Error {
  /** The daemon's structured payload, verbatim. */
  readonly data: WireErrorData

  /**
   * @param data - the daemon's structured error payload.
   */
  constructor(data: WireErrorData) {
    super(`${data.message} (${data.code})`)
    this.name = 'NodeRequestError'
    this.data = data
  }
}

/** Resolves the live channel for one node, or undefined when it is not connected. */
export type ChannelLookup = (nodeId: NodeId) => NodeChannel | undefined

/** How to reach one daemon. */
export interface ConnectOptions {
  /** Host or IP the daemon listens on. */
  readonly host: string
  /** TCP port the daemon listens on. */
  readonly port: number
  /** Shared secret from the daemon's token file. */
  readonly token: string
  /** Bound on connection establishment and the handshake, in milliseconds. */
  readonly timeoutMs?: number
}

/** A live, handshaken connection. */
export interface ConnectedNode {
  /** The channel the routers call. */
  readonly channel: NodeChannel
  /** What the daemon reported about itself. */
  readonly info: NodeInfo
  /** Close the connection and release the socket. Idempotent. */
  close(): void
}

/** Whether an unknown value is the daemon's structured failure payload. */
function isWireErrorData(value: unknown): value is WireErrorData {
  return typeof value === 'object' && value !== null
    && typeof (value as { code?: unknown }).code === 'string'
    && typeof (value as { message?: unknown }).message === 'string'
}

/**
 * Translate a `vscode-jsonrpc` rejection into the plugin's typed failure.
 * @param error - whatever the connection raised.
 * @returns the error to reject with.
 */
function toChannelError(error: unknown): unknown {
  if (error instanceof ResponseError && isWireErrorData(error.data)) {
    return new NodeRequestError(error.data)
  }
  return error
}

/**
 * Settle `work` or fail once the deadline passes.
 *
 * The handshake needs its own bound: a daemon that closes the socket without
 * answering leaves the request pending forever, and "the machine answered
 * nothing" must be a failure rather than a hang.
 * @param work - the operation to bound.
 * @param timeoutMs - the deadline, or undefined to wait indefinitely.
 * @param onTimeout - builds the failure to reject with.
 * @returns the operation's result.
 */
async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number | undefined,
  onTimeout: () => Error,
): Promise<T> {
  if (timeoutMs === undefined) return work
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * A writer that hands a failed write to the connection instead of rejecting.
 *
 * `vscode-jsonrpc` reports a failed write by rejecting the request from inside
 * an `async` Promise executor, and nothing awaits that rejection. The host
 * process sees the orphan and reports a fatal load failure, which is what a
 * write to a socket destroyed underneath it — a teardown racing an in-flight
 * call, or a link that just dropped — produces. The failure is not dropped:
 * the connection is disposed, which rejects the request through the
 * pending-response path its caller already handles.
 */
export class SocketWriter extends StreamMessageWriter {
  /** Disposes the connection this writer serves; set once that connection exists. */
  private readonly onWriteFailure: () => void

  /**
   * @param socket - the socket the connection is written to.
   * @param onWriteFailure - tears down the owning connection.
   */
  constructor(socket: Socket, onWriteFailure: () => void) {
    super(socket)
    this.onWriteFailure = onWriteFailure
  }

  override async write(message: Parameters<StreamMessageWriter['write']>[0]): Promise<void> {
    try {
      await super.write(message)
    } catch {
      this.onWriteFailure()
    }
  }
}

/**
 * Connect to a daemon and complete the handshake.
 * @param options - address, token, and optional timeout.
 * @returns the live connection, already past `node.hello`.
 * @throws when the socket fails, the handshake times out, or the daemon
 *   refuses the protocol revision or the token.
 */
export async function connectNode(options: ConnectOptions): Promise<ConnectedNode> {
  const socket = new Socket()
  socket.setNoDelay(true)

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.once('connect', () => resolve())
      socket.connect({ host: options.host, port: options.port })
    }),
    options.timeoutMs,
    () => {
      socket.destroy()
      return new Error(`timed out connecting to ${options.host}:${String(options.port)}`)
    },
  )

  let disposeConnection: () => void = () => {}
  const writer = new SocketWriter(socket, () => { disposeConnection() })
  const connection = createMessageConnection(new StreamMessageReader(socket), writer)
  disposeConnection = () => { connection.dispose() }
  connection.listen()

  const channel: NodeChannel = {
    async request<M extends WireMethod>(method: M, params: WireParams<M>): Promise<WireResult<M>> {
      try {
        return await connection.sendRequest<WireResult<M>>(method, params)
      } catch (error) {
        throw toChannelError(error)
      }
    },
    onPipeFrame(handler) {
      // `vscode-jsonrpc` keeps one notification handler per method, which is
      // exactly the lifetime this seam wants: the caller owns registration and
      // disposes it when its process is gone.
      connection.onNotification(SP_PIPE_NOTIFICATION, (frame: SpPipeFrame) => {
        handler(frame)
      })
      return () => {
        connection.onNotification(SP_PIPE_NOTIFICATION, () => {})
      }
    },
  }

  let info: NodeInfo
  try {
    info = await withTimeout(
      channel.request('node.hello', { protocol: PROTOCOL_VERSION, token: options.token }),
      options.timeoutMs,
      () => new Error(`handshake with ${options.host}:${String(options.port)} timed out`),
    )
  } catch (error) {
    connection.dispose()
    socket.destroy()
    throw toChannelError(error)
  }

  let closed = false
  return {
    channel,
    info,
    close() {
      if (closed) return
      closed = true
      connection.dispose()
      socket.destroy()
    },
  }
}
