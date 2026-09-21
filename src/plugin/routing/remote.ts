/**
 * The machine one working directory belongs to, when it is not this host.
 *
 * The terminal and the subprocess router dispatch on the same answer, so they
 * resolve it through here: a cwd claimed by exactly one node yields that node's
 * live channel, a path two nodes claim is refused, and a machine that is not
 * connected says so. A cwd no anchor claims belongs to this host, and the
 * callers serve it themselves.
 *
 * @module dsh-remote-workspace/plugin/routing/remote
 */

import type { AnchorRoute } from '../../storage/anchors.ts'
import type { ChannelLookup, NodeChannel } from '../../remote/client.ts'
import type { NodeId } from '../../storage/nodes.ts'
import { ambiguousPathMessage, classifyPath } from '../../models/routing.ts'

/** A reachable machine and the path this host asked it about. */
export interface RemoteTarget {
  /** The live channel to the machine. */
  readonly channel: NodeChannel
  /** The absolute path on that machine the caller's cwd maps to. */
  readonly remotePath: string
  /** The machine itself, for facts the channel does not carry. */
  readonly nodeId: NodeId
}

/**
 * Resolve one working directory to the machine that owns it.
 * @param cwd - the working directory the caller asked for.
 * @param anchors - every anchor this plugin currently owns.
 * @param channel - resolves the live channel for a node.
 * @returns the machine and its path, or undefined when this host owns the cwd.
 * @throws when more than one node claims the path, or the node is not connected.
 */
export function remoteTarget(
  cwd: string,
  anchors: readonly AnchorRoute[],
  channel: ChannelLookup,
): RemoteTarget | undefined {
  const route = classifyPath(cwd, undefined, anchors)
  if (route.kind === 'local') return undefined
  if (route.kind === 'ambiguous') throw new Error(ambiguousPathMessage(route))
  const live = channel(route.nodeId)
  if (live === undefined) throw new Error(`remote node "${route.nodeId}" is not connected`)
  return { channel: live, remotePath: route.remotePath, nodeId: route.nodeId }
}
