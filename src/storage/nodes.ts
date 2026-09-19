/**
 * The durable record of the remote machines a user has configured.
 *
 * Records carry the node's shared secret; every projection that leaves this
 * module drops it, and {@link toNodeView} is the only supported way to produce
 * one.
 *
 * @module dsh-remote-workspace/storage/nodes
 */

import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { randomUUID } from 'node:crypto'
import type { DocumentSpec } from './document.ts'
import { readDocument, writeDocument } from './document.ts'

/**
 * Document revision. Revision 1 stored `host`/`port` on the record; revision 2
 * stores a transport that says how the host reaches the daemon.
 */
const DOCUMENT_VERSION = 2

/**
 * The title a node gets when its caller named none.
 * @param transport - how the host reaches the daemon.
 * @returns the SSH destination, the direct address, or the local machine's name.
 */
function defaultNodeTitle(transport: NodeTransport): string {
  if (transport.kind === 'local') return LOCAL_TITLE
  return transport.kind === 'ssh' ? transport.target : `${transport.host}:${String(transport.port)}`
}

/**
 * How the host reaches one machine's daemon.
 *
 * `ssh` is the only transport a caller may create: the host picks a free local
 * port and forwards it to the daemon's loopback port over an SSH connection,
 * which is what the deployment documentation tells operators to set up by
 * hand. `local` is this host itself, which needs no daemon and no connection;
 * `direct` exists so a document written before the SSH transport keeps loading
 * — nothing creates one, and it names an address the operator reached some
 * other way.
 */
export type NodeTransport =
  | {
    readonly kind: 'ssh'
    /** `ssh` destination: `user@host`, or a `~/.ssh/config` alias. */
    readonly target: string
    /** SSH port; omitted defers to the operator's `ssh` configuration. */
    readonly sshPort?: number
    /** Identity file; omitted defers to the operator's `ssh` configuration. */
    readonly identityFile?: string
  }
  | {
    /** This host: the machine the harness itself runs on. */
    readonly kind: 'local'
  }
  | {
    readonly kind: 'direct'
    /** Host the daemon is reachable at. */
    readonly host: string
    /** TCP port the daemon is reachable at. */
    readonly port: number
  }

/**
 * One configured remote machine.
 *
 * Branded so a repository or anchor id cannot be passed where a machine is
 * expected: all three are generated strings that render identically in a log
 * or a URL, and the brand is the only thing that tells them apart. It lives in
 * the type system alone.
 */
export type NodeId = Branded<'NodeId'>

/**
 * Admit a string as a machine id.
 *
 * Called where a string first becomes an id: a tool argument, a route segment,
 * or one this plugin derives from the coordinates it names. Every later hop
 * carries the type.
 * @param value - the string the parser produced.
 * @returns the same string, branded.
 */
export function asNodeId(value: string): NodeId {
  return brandString<NodeId>(value)
}

/**
 * The id, title, and instant the built-in local machine always carries.
 *
 * It is deliberately not a document entry: nothing configures it, so nothing
 * can leave it unreachable or removed, and a deployment that has never added a
 * machine still has this one to work in. The instant is the epoch because the
 * machine has been there since before the plugin was.
 */
export const LOCAL_NODE_ID = brandString<NodeId>('local')

/** Title the local machine carries, in the record and in every view. */
const LOCAL_TITLE = 'Local'

/**
 * The machine that is this host itself.
 *
 * Every surface treats it like any other machine — the same repository rows,
 * the same worktree lifecycle, the same dialogs — with two differences that
 * follow from where it is: there is no daemon to install and no connection to
 * make, and its paths are the paths this process already has.
 * @returns the local machine's record, for a caller that needs one.
 */
function localNode(): NodeRecord {
  return {
    nodeId: LOCAL_NODE_ID,
    title: LOCAL_TITLE,
    transport: { kind: 'local' },
    token: '',
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
  }
}

/** One configured remote machine. */
export interface NodeRecord {
  /** Stable generated id; never the target, so renaming a machine is free. */
  readonly nodeId: NodeId
  /** Display title. Defaults to the `ssh` destination. */
  readonly title: string
  /** How the host reaches this machine's daemon. */
  readonly transport: NodeTransport
  /**
   * The daemon's shared secret. Kept out of every view this module returns to
   * callers that render to a browser or a model.
   */
  readonly token: string
  /** ISO-8601 creation instant. */
  readonly createdAt: string
  /** ISO-8601 instant of the last accepted mutation. */
  readonly updatedAt: string
}

/** What a browser or another plugin may see: a record without its secret. */
export interface NodeView {
  readonly nodeId: NodeId
  readonly title: string
  readonly transport: NodeTransport
  /** Whether a secret is configured; the value itself never travels. */
  readonly hasToken: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

/** Fields a caller supplies when creating or updating a node. */
export interface NodeDraft {
  readonly nodeId?: NodeId
  readonly title?: string
  readonly transport: NodeTransport
  readonly token: string
}

/** What the registry needs from its owner. */
export interface NodeRegistryDeps {
  /** Absolute path of the JSON document. */
  readonly file: string
  /** Injectable clock, so tests do not depend on wall time. */
  readonly now?: () => Date
}

/** The node registry. */
export interface NodeRegistry {
  /**
   * Read the document into memory. Missing is not an error: a fresh install has
   * no nodes. A malformed or future-versioned document fails loud rather than
   * being treated as empty, because silently starting empty would strand every
   * workspace anchored to a node.
   * @returns the loaded records, in document order.
   */
  load(): Promise<readonly NodeRecord[]>
  /** Every configured node, in stable document order. */
  list(): readonly NodeRecord[]
  /**
   * One node by id.
   * @param nodeId - the generated record id.
   * @returns the record, or undefined when no node carries that id.
   */
  get(nodeId: NodeId): NodeRecord | undefined
  /**
   * Create or update one node and persist the result.
   * @param draft - the caller's fields; omitted `nodeId` generates one.
   * @returns the stored record.
   */
  upsert(draft: NodeDraft): Promise<NodeRecord>
  /**
   * Remove one node and persist the result.
   * @param nodeId - the record to remove.
   * @returns true when a record was removed.
   */
  remove(nodeId: NodeId): Promise<boolean>
}

/** Whether an unknown parsed value is a transport this build understands. */
function isTransport(value: unknown): value is NodeTransport {
  if (typeof value !== 'object' || value === null) return false
  const transport = value as Record<string, unknown>
  if (transport['kind'] === 'local') return true
  if (transport['kind'] === 'ssh') {
    return typeof transport['target'] === 'string'
      && (transport['sshPort'] === undefined || typeof transport['sshPort'] === 'number')
      && (transport['identityFile'] === undefined || typeof transport['identityFile'] === 'string')
  }
  if (transport['kind'] === 'direct') {
    return typeof transport['host'] === 'string' && typeof transport['port'] === 'number'
  }
  return false
}

/** Whether an unknown parsed value is a record this module wrote. */
function isNodeRecord(value: unknown): value is NodeRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record['nodeId'] === 'string'
    && typeof record['title'] === 'string'
    && isTransport(record['transport'])
    && typeof record['token'] === 'string'
    && typeof record['createdAt'] === 'string'
    && typeof record['updatedAt'] === 'string'
}

/**
 * Read one revision-1 record as the revision-2 record.
 *
 * Revision 1 recorded a reachable address and nothing else, which is what the
 * `direct` transport still means. The record therefore carries over with no
 * field lost and no id change, so every repository and worktree already
 * anchored to this node keeps resolving.
 * @param value - the parsed revision-1 entry.
 * @param index - the entry's position, for the diagnostic.
 * @returns the equivalent revision-2 record.
 * @throws when the entry is not one this build can read.
 */
function migrateV1(value: unknown, index: number): NodeRecord {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const fields = ['nodeId', 'title', 'host', 'token', 'createdAt', 'updatedAt'] as const
  for (const field of fields) {
    if (typeof record[field] !== 'string') {
      throw new Error(`node entry ${String(index)} from revision 1 carries no usable "${field}"`)
    }
  }
  if (typeof record['port'] !== 'number') {
    throw new Error(`node entry ${String(index)} from revision 1 carries no usable "port"`)
  }
  const port = record['port'] as number
  const host = record['host'] as string
  return {
    nodeId: brandString<NodeId>(record['nodeId'] as string),
    title: record['title'] as string,
    transport: { kind: 'direct', host, port },
    token: record['token'] as string,
    createdAt: record['createdAt'] as string,
    updatedAt: record['updatedAt'] as string,
  }
}

/**
 * Project a record for a caller that may render it.
 * @param record - the stored record.
 * @returns the record without its secret, plus the presence flag a form needs.
 */
export function toNodeView(record: NodeRecord): NodeView {
  return {
    nodeId: record.nodeId,
    title: record.title,
    transport: record.transport,
    hasToken: record.token.length > 0,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/**
 * Build a node registry over one document.
 * @param deps - the document path and an optional clock.
 * @returns the registry; call {@link NodeRegistry.load} before serving reads.
 */
export function createNodeRegistry(deps: NodeRegistryDeps): NodeRegistry {
  const now = deps.now ?? (() => new Date())
  let nodes: NodeRecord[] = []
  let loaded = false

  const requireLoaded = (): void => {
    if (!loaded) throw new Error('node registry used before load()')
  }

  const document: DocumentSpec<NodeRecord> = {
    file: deps.file,
    version: DOCUMENT_VERSION,
    key: 'nodes',
    label: 'node',
    isRecord: isNodeRecord,
    migrate: migrateV1,
  }

  return {
    async load() {
      nodes = [...await readDocument(document)]
      loaded = true
      return nodes
    },

    list() {
      requireLoaded()
      // The local machine leads every list: it is the one machine a deployment
      // always has, and the one a person reaches for first.
      return [localNode(), ...nodes]
    },

    get(nodeId) {
      requireLoaded()
      if (nodeId === LOCAL_NODE_ID) return localNode()
      return nodes.find(node => node.nodeId === nodeId)
    },

    async upsert(draft) {
      requireLoaded()
      if (draft.nodeId === LOCAL_NODE_ID) {
        throw new Error('the local machine is built in and cannot be configured')
      }
      const stamp = now().toISOString()
      const existing = draft.nodeId === undefined
        ? undefined
        : nodes.find(node => node.nodeId === draft.nodeId)
      const record: NodeRecord = {
        nodeId: existing?.nodeId ?? draft.nodeId ?? brandString<NodeId>(randomUUID()),
        title: draft.title?.trim() || defaultNodeTitle(draft.transport),
        transport: draft.transport,
        token: draft.token,
        createdAt: existing?.createdAt ?? stamp,
        updatedAt: stamp,
      }
      const next = existing === undefined
        ? [...nodes, record]
        : nodes.map(node => (node.nodeId === record.nodeId ? record : node))
      await writeDocument(document, next)
      nodes = next
      return record
    },

    async remove(nodeId) {
      requireLoaded()
      // Not an error: the local machine is simply not a document entry, so
      // nothing was removed. Refusing it here keeps a caller from believing a
      // machine went away when the next read brings it back.
      if (nodeId === LOCAL_NODE_ID) return false
      const next = nodes.filter(node => node.nodeId !== nodeId)
      if (next.length === nodes.length) return false
      await writeDocument(document, next)
      nodes = next
      return true
    },
  }
}
