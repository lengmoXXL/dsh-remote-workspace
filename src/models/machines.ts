/**
 * Connection lifecycle for configured nodes.
 *
 * One connection per node, owned here: the routers ask for a channel and get
 * either a live one or `undefined`, which is what makes "the machine is
 * offline" a typed failure at the call site instead of a hang.
 *
 * A dropped transport fails in-flight work and is never presented as
 * resumable. Reconnecting establishes a new connection with no carry-over;
 * remote identity alone cannot reconstruct pending calls, output cursors, or
 * process state.
 *
 * @module dsh-remote-workspace/models/machines
 */

import { posix } from 'node:path'
import type { ConnectOptions, ConnectedNode, NodeChannel } from '../remote/client.ts'
import { NodeRequestError, connectNode } from '../remote/client.ts'
import type { NodeInfo } from '../remote/protocol.ts'
import type { NodeId, NodeRecord } from '../storage/nodes.ts'
import { DEFAULT_FORWARD_TIMEOUT_MS, openTunnel } from '../remote/ssh.ts'
import type { AgentEndpoint, AgentProgress, EnsureAgentOptions, EnsurePtcHostOptions } from '../remote/agent/install.ts'
import { AGENT_VERSION, ensureAgent, ensurePtcHost } from '../remote/agent/install.ts'

/** Where one node's connection stands. */
export type NodeState = 'idle' | 'connecting' | 'ready' | 'failed' | 'disconnected'

/** One node's connection state, as a surface may render it. */
export interface NodeStatus {
  readonly nodeId: NodeId
  readonly state: NodeState
  /** Present once the handshake succeeded. */
  readonly info?: NodeInfo
  /**
   * The local port carrying this node's traffic, once a forward is up. Absent
   * for a direct address, which needs no forward.
   */
  readonly localPort?: number
  /**
   * What the attempt is doing while it is not yet ready — installing or
   * updating the agent is slow enough that a surface should say so. Absent
   * once the node is ready or the attempt has ended.
   */
  readonly progress?: AgentProgress
  /** The failure message after a failed attempt or a dropped transport. */
  readonly error?: string
  /**
   * This machine's own PTC program host, while it is being installed or after
   * an install failed. Absent once the machine has it.
   *
   * The install runs in the background long after the connection is up, so a
   * failure has no call of its own to reject: it would otherwise be invisible
   * until the first `run_code` aimed at this machine, and then only as a hang.
   */
  readonly worker?: WorkerStatus
}

/** The state of one machine's PTC program host, as a surface may render it. */
export interface WorkerStatus {
  /** Whether the host is being installed, or the install failed. */
  readonly state: 'installing' | 'failed'
  /** Why the install failed. Present only in the `failed` state. */
  readonly error?: string
}

/**
 * The address a daemon is reachable at from this host, plus whatever carries
 * the traffic there.
 */
export interface ResolvedTransport {
  /** Host the daemon is reachable at, from this host. */
  readonly host: string
  /** TCP port the daemon is reachable at, from this host. */
  readonly port: number
  /**
   * Resolves when the transport stops carrying traffic, for a transport that
   * can fail on its own. A caller uses it to publish the loss; a direct
   * address never resolves and is closed only by its owner.
   */
  readonly exited?: Promise<void>
  /** Release whatever this transport holds. Idempotent. */
  close(): void
}

/** What the manager needs from its owner. */
export interface NodeConnectionsDeps {
  /** Establishes a connection; injectable so tests need no socket. */
  readonly connect?: (options: ConnectOptions) => Promise<ConnectedNode>
  /**
   * Turn a stored record into an address this host can dial. Defaults to the
   * SSH forward for an `ssh` record and the recorded address for a `direct`
   * one; injectable so tests need neither a network nor an `ssh` binary.
   */
  readonly openTransport?: (
    record: NodeRecord,
    report: (progress: AgentProgress) => void,
  ) => Promise<ResolvedTransport>
  /**
   * Deadline for the daemon handshake once a transport is up. Defaults to
   * {@link DEFAULT_HANDSHAKE_TIMEOUT_MS}; without one an unreachable daemon
   * leaves the attempt pending forever.
   */
  readonly daemonHandshakeTimeoutMs?: number
  /**
   * Budget for an SSH forward to start accepting connections. Defaults to
   * {@link DEFAULT_FORWARD_TIMEOUT_MS}.
   */
  readonly sshForwardTimeoutMs?: number
  /** Attempts after a connection drops; defaults to {@link RECOVERY_ATTEMPTS}. */
  readonly recoveryAttempts?: number
  /** Gap before the first recovery attempt, in milliseconds. */
  readonly recoveryGapMs?: number
  /**
   * Host directory the agent binaries are cached under. Required to reach an
   * `ssh` record with the default opener; tests that inject `openTransport`
   * never need it.
   */
  readonly cacheDir?: string
  /**
   * Agent build to ensure on every machine. Defaults to {@link AGENT_VERSION}.
   */
  readonly agentVersion?: string
  /**
   * Ensures the agent on a machine and reports the port it serves on. Defaults
   * to the SSH installer; injectable so tests need no `ssh` binary or network.
   */
  readonly ensureAgent?: (options: EnsureAgentOptions) => Promise<AgentEndpoint>
  /**
   * Installs the machine's native PTC program host. Defaults to the SSH
   * installer; injectable so tests need no `ssh` binary or network.
   */
  readonly ensurePtcHost?: (options: EnsurePtcHostOptions) => Promise<void>
}

/** How many times a dropped connection is re-established before it is left failed. */
const RECOVERY_ATTEMPTS = 3

/** Gap before the first recovery attempt, growing by that much for each later one. */
const RECOVERY_GAP_MS = 2_000

/**
 * How long a handshake may take. Generous enough for a slow forward over a
 * long link, short enough that a daemon which is simply not running is
 * reported rather than waited on. The plugin exposes this as
 * `Config.daemonHandshakeTimeoutMs`; it is the fallback for a caller that
 * composes the manager directly.
 */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000

/**
 * Explain a failed connect attempt in the terms the operator can act on.
 *
 * A `ssh -L` forward binds its local port whether or not the agent listens
 * behind it on the machine, so a handshake that times out through a forward
 * means the agent is absent or wedged far more often than it means the network
 * failed — and the agent's own log is where the reason will be.
 * @param record - the machine that was being reached.
 * @param error - the failure the connector raised.
 * @returns the error to record and rethrow.
 */
function describeFailure(record: NodeRecord, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  // Both deadlines the connector enforces mean the same thing here: the
  // socket opened, so something accepted it, but the agent never spoke.
  if (record.transport.kind === 'ssh' && /timed out connecting to|handshake with .* timed out/.test(message)) {
    return new Error(
      `the SSH forward to "${record.transport.target}" is up, but nothing answered; check ~/.dsh/remote-agent/agent.log on the machine`,
      { cause: error },
    )
  }
  return error instanceof Error ? error : new Error(message)
}

/** Everything the default transport opener needs from the manager's deps. */
interface OpenTransportDeps {
  /** Budget for an SSH forward to become ready. */
  readonly forwardTimeoutMs: number
  /** Agent build to ensure on a machine. */
  readonly agentVersion: string
  /** Agent binary cache directory; omitted refuses an `ssh` record. */
  readonly cacheDir: string | undefined
  /** Installs and starts the agent on a machine. */
  readonly ensureAgent: (options: EnsureAgentOptions) => Promise<AgentEndpoint>
}

/**
 * Build the default transport opener.
 *
 * An `ssh` record is reached in two steps — ensure the agent is running, then
 * forward the port it published — because the port is kernel-assigned and
 * known only from the machine. A `direct` address is dialled as recorded. The
 * local machine is refused here rather than dialled: it has no transport, and
 * connecting it means nothing.
 * @param deps - forward budget and the agent-ensuring seams.
 * @returns an opener for the transports that have somewhere to connect to.
 */
function defaultOpenTransport(
  deps: OpenTransportDeps,
): (record: NodeRecord, report: (progress: AgentProgress) => void) => Promise<ResolvedTransport> {
  return async (record, report) => {
    if (record.transport.kind === 'local') {
      throw new Error('the local machine needs no connection')
    }
    if (record.transport.kind === 'direct') {
      return {
        host: record.transport.host,
        port: record.transport.port,
        close: () => {},
      }
    }
    if (deps.cacheDir === undefined) {
      throw new Error('reaching a machine over SSH needs the plugin data directory to cache the agent')
    }
    const endpoint = await deps.ensureAgent({
      ssh: record.transport,
      token: record.token,
      version: deps.agentVersion,
      cacheDir: deps.cacheDir,
      onProgress: report,
    })
    const tunnel = await openTunnel(
      { ssh: record.transport, remotePort: endpoint.port },
      { readyTimeoutMs: deps.forwardTimeoutMs },
    )
    return {
      host: '127.0.0.1',
      port: tunnel.localPort,
      exited: tunnel.exited,
      close: () => { tunnel.close() },
    }
  }
}

/** The connection manager. */
export interface NodeConnections {
  /**
   * The live channel for one node.
   * @param nodeId - the record id.
   * @returns the channel, or undefined when the node is not connected.
   */
  channel(nodeId: NodeId): NodeChannel | undefined
  /**
   * One node's connection state.
   * @param nodeId - the record id.
   * @returns the status; `idle` for a node that was never connected.
   */
  status(nodeId: NodeId): NodeStatus
  /** Every node this manager has seen a state for, in insertion order. */
  list(): readonly NodeStatus[]
  /**
   * Connect one node, or return the handshake already in flight or completed.
   * @param record - the node to connect.
   * @returns what the daemon reported about itself.
   * @throws the connection or handshake failure; the node's status records it.
   */
  connect(record: NodeRecord): Promise<NodeInfo>
  /**
   * The machine's own PTC program host, installed there if this is the first
   * program for it.
   * @param nodeId - the record id.
   * @returns the absolute path of the worker inside the machine.
   * @throws when the node is not connected or the install fails.
   */
  ptcHost(nodeId: NodeId): Promise<string>
  /**
   * Close one node's connection. Idempotent.
   * @param nodeId - the record id.
   */
  disconnect(nodeId: NodeId): void
  /** Close every connection. Idempotent. */
  dispose(): void
}

/** One entry in the manager's table. Fields are explicitly nullable, not optional. */
interface Entry {
  state: NodeState
  info: NodeInfo | undefined
  error: string | undefined
  live: ConnectedNode | undefined
  pending: Promise<NodeInfo> | undefined
  transport: ResolvedTransport | undefined
  localPort: number | undefined
  progress: AgentProgress | undefined
  /** Identity of the recovery in flight for this entry, when one is. */
  recovery: symbol | undefined
  /** The channel handed out for this connection, wrapped to notice its loss. */
  published: NodeChannel | undefined
  /** The machine this entry is connected to, while it is. */
  record: NodeRecord | undefined
  /** The install of this machine's PTC program host, once one has begun. */
  ptcHost: Promise<string> | undefined
  /** What that install is doing, for a surface that reports it. */
  worker: WorkerStatus | undefined
}

/** Where a machine's native PTC program host sits, relative to its home directory. */
const PTC_HOST_SEGMENT = ['.dsh', 'remote-agent', 'dsh-ptc-host'] as const

/**
 * Build the connection manager.
 * @param deps - an optional connection implementation, defaulting to the TCP client.
 * @returns the manager.
 */
export function createNodeConnections(deps: NodeConnectionsDeps = {}): NodeConnections {
  const connect = deps.connect ?? connectNode
  const cacheDir = deps.cacheDir
  const agentVersion = deps.agentVersion ?? AGENT_VERSION
  const installPtcHost = deps.ensurePtcHost ?? ensurePtcHost
  const openTransport = deps.openTransport ?? defaultOpenTransport({
    forwardTimeoutMs: deps.sshForwardTimeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS,
    agentVersion,
    cacheDir,
    ensureAgent: deps.ensureAgent ?? ensureAgent,
  })
  const handshakeTimeoutMs = deps.daemonHandshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
  const recoveryAttempts = deps.recoveryAttempts ?? RECOVERY_ATTEMPTS
  const recoveryGapMs = deps.recoveryGapMs ?? RECOVERY_GAP_MS
  const entries = new Map<NodeId, Entry>()
  /**
   * Transports whose loss has already been published.
   *
   * A transport that answers `exited` again — a reused object, or one that was
   * already gone when it was handed over — must not start a second recovery:
   * the failure is the same event, and retrying it would reconnect forever.
   */
  const lost = new WeakSet<ResolvedTransport>()

  const entryFor = (nodeId: NodeId): Entry => {
    const existing = entries.get(nodeId)
    if (existing !== undefined) return existing
    const created: Entry = {
      state: 'idle',
      info: undefined,
      error: undefined,
      live: undefined,
      pending: undefined,
      transport: undefined,
      localPort: undefined,
      progress: undefined,
      recovery: undefined,
      published: undefined,
      record: undefined,
      ptcHost: undefined,
      worker: undefined,
    }
    entries.set(nodeId, created)
    return created
  }

  /** Drop everything a connection holds, leaving the entry itself in place. */
  const clear = (entry: Entry): void => {
    entry.published = undefined
    entry.record = undefined
    entry.ptcHost = undefined
    entry.worker = undefined
    entry.live?.close()
    entry.live = undefined
    entry.pending = undefined
    entry.info = undefined
    // The forward exists only to carry this connection, so a connection that
    // ended must not leave an `ssh` process running behind it.
    entry.transport?.close()
    entry.transport = undefined
    entry.localPort = undefined
    entry.progress = undefined
  }

  /** Publish a terminal state and drop everything the failure invalidates. */
  const fail = (entry: Entry, error: unknown): void => {
    clear(entry)
    entry.state = 'failed'
    entry.error = error instanceof Error ? error.message : String(error)
  }

  /** One entry as the status a caller reads. */
  const statusOf = (nodeId: NodeId, entry: Entry): NodeStatus => ({
    nodeId,
    state: entry.state,
    ...entry.info === undefined ? {} : { info: entry.info },
    ...entry.localPort === undefined ? {} : { localPort: entry.localPort },
    ...entry.progress === undefined ? {} : { progress: entry.progress },
    ...entry.error === undefined ? {} : { error: entry.error },
    ...entry.worker === undefined ? {} : { worker: entry.worker },
  })

  /**
   * The machine's own PTC program host, installing it over SSH on first need.
   *
   * A reachable machine is not the same as a machine ready to run a program in,
   * and the program arrives long after the connection does, so the install is
   * warmed in the background and every later caller — the warm-up's own
   * rejection aside — is handed the one promise it produced. A direct address
   * is one this plugin never installed anything on, so its host is expected to
   * be there already and the spawn reports it missing if it is not.
   * @param entry - the connected entry.
   * @param record - the machine it is connected to.
   * @returns the absolute path of the worker inside the machine.
   */
  const ptcHostFor = (entry: Entry, record: NodeRecord): Promise<string> => {
    if (entry.ptcHost !== undefined) return entry.ptcHost
    const home = entry.info?.homedir
    if (home === undefined) {
      return Promise.reject(new Error(`"${record.title}" has not reported its home directory`))
    }
    const path = posix.join(home, ...PTC_HOST_SEGMENT)
    if (record.transport.kind !== 'ssh') return Promise.resolve(path)
    if (cacheDir === undefined) {
      return Promise.reject(new Error('installing a PTC program host needs the plugin data directory'))
    }
    entry.worker = { state: 'installing' }
    const attempt = installPtcHost({ ssh: record.transport, version: agentVersion, cacheDir })
      .then(() => path)
    entry.ptcHost = attempt
    void attempt.then(
      () => {
        if (entry.ptcHost === attempt) entry.worker = undefined
      },
      (error: unknown) => {
        // A failed install must not become this machine's answer for good: the
        // next program is allowed to try again. What it must become is visible,
        // which is the whole reason the state is on the entry at all.
        if (entry.ptcHost !== attempt) return
        entry.ptcHost = undefined
        entry.worker = {
          state: 'failed',
          error: error instanceof Error ? error.message : String(error),
        }
      },
    )
    return attempt
  }

  /**
   * Bring a dropped connection back without waiting to be asked.
   *
   * A drop is the one failure worth retrying unattended: the machine answered a
   * moment ago, so the reason is usually the link or a restarted daemon rather
   * than a configuration only a person could change. The attempts are bounded,
   * and whatever the last one reported stays on the entry.
   * @param entry - the entry whose connection dropped.
   * @param record - the machine to reach again.
   */
  const recover = (entry: Entry, record: NodeRecord): void => {
    const mine = Symbol('recovery')
    entry.recovery = mine
    void (async () => {
      for (let attempt = 1; attempt <= recoveryAttempts; attempt += 1) {
        await new Promise(resolve => {
          // Unref'd: a pending retry must never be what keeps a process alive.
          setTimeout(resolve, recoveryGapMs * attempt).unref()
        })
        // A disconnect, a disposal, or a newer drop has taken this over.
        if (entry.recovery !== mine) return
        try {
          await connectRecord(record)
          return
        } catch {
          // The attempt published its own failure; the next one may still work.
        }
      }
    })()
  }

  /**
   * The channel one connection hands out.
   *
   * The transport can die without the SSH process that carries it noticing: a
   * node whose daemon is killed leaves the forward open, so nothing arrives to
   * say the connection is gone until a call fails on it. A refusal the daemon
   * itself answered is a typed error and stays the caller's business; anything
   * else on the wire is a lost connection, which is published and recovered
   * from exactly like a forward that closed.
   * @param entry - the entry this connection belongs to.
   * @param record - the machine, for the retry.
   * @param live - the connection being published.
   * @returns the channel the routers call.
   */
  const publish = (entry: Entry, record: NodeRecord, live: ConnectedNode): NodeChannel => ({
    async request(method, params) {
      try {
        return await live.channel.request(method, params)
      } catch (error) {
        // Its loss was published already: a stale channel is not a new drop.
        if (entry.live === live && !(error instanceof NodeRequestError)) {
          fail(entry, error instanceof Error ? error : new Error(String(error)))
          recover(entry, record)
        }
        throw error
      }
    },
    onPipeFrame: handler => live.channel.onPipeFrame(handler),
  })

  /** Connect one node, or return the attempt already in flight. */
  const connectRecord = async (record: NodeRecord): Promise<NodeInfo> => {
    const entry = entryFor(record.nodeId)
    if (entry.state === 'ready' && entry.info !== undefined) return entry.info
    if (entry.pending !== undefined) return entry.pending

    entry.state = 'connecting'
    entry.error = undefined
    entry.progress = undefined
    const attempt = (async (): Promise<NodeInfo> => {
      try {
        // The forward comes first: without it there is no address to dial, and
        // its own failure is more specific than a refused connection would be.
        // Installing or updating the agent happens inside it, so its steps are
        // published as they start.
        const opened = await openTransport(record, (progress) => { entry.progress = progress })
        entry.transport = opened
        const live = await connect({
          host: opened.host,
          port: opened.port,
          token: record.token,
          timeoutMs: handshakeTimeoutMs,
        })
        entry.live = live
        entry.published = publish(entry, record, live)
        entry.info = live.info
        entry.localPort = record.transport.kind === 'ssh' ? opened.port : undefined
        entry.pending = undefined
        entry.progress = undefined
        entry.record = record
        entry.state = 'ready'
        // Fetched now, while nobody is waiting on it: a machine that never runs
        // a program pays only the connection, and one that does finds the
        // worker already there.
        if (record.transport.kind === 'ssh') void ptcHostFor(entry, record).catch(() => {})
        // A forward can die while the socket it carried stays open long
        // enough to look healthy. Publish the loss rather than leaving a
        // `ready` node whose every call hangs, and start bringing it back.
        void opened.exited?.then(() => {
          if (lost.has(opened) || entry.transport !== opened) return
          lost.add(opened)
          fail(entry, new Error(`the SSH forward to "${record.title}" closed`))
          recover(entry, record)
        })
        return live.info
      } catch (error) {
        // Every failure settles the entry, including one from the opener: an
        // install that could not fetch or upload the agent must leave a
        // failed machine that can be retried, not one stuck in `connecting`
        // whose next attempt re-throws this same rejection.
        const reported = describeFailure(record, error)
        fail(entry, reported)
        throw reported
      }
    })()
    entry.pending = attempt
    return attempt
  }

  return {
    channel(nodeId) {
      return entries.get(nodeId)?.published
    },

    status(nodeId) {
      const entry = entries.get(nodeId)
      return entry === undefined ? { nodeId, state: 'idle' } : statusOf(nodeId, entry)
    },

    list() {
      return [...entries].map(([nodeId, entry]) => statusOf(nodeId, entry))
    },

    connect: connectRecord,

    async ptcHost(nodeId) {
      const entry = entries.get(nodeId)
      if (entry === undefined || entry.state !== 'ready' || entry.record === undefined) {
        throw new Error(`remote node "${nodeId}" is not connected`)
      }
      return await ptcHostFor(entry, entry.record)
    },

    disconnect(nodeId) {
      const entry = entries.get(nodeId)
      if (entry === undefined) return
      // A person asking for the connection to end also ends any retry of it.
      entry.recovery = undefined
      clear(entry)
      entry.error = undefined
      entry.state = 'disconnected'
    },

    dispose() {
      for (const entry of entries.values()) {
        entry.recovery = undefined
        clear(entry)
      }
      entries.clear()
    },
  }
}
