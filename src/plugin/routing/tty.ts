/**
 * The routing terminal provider the plugin registers as `ctx.tty`.
 *
 * A working directory decides the machine: one that belongs to a node is served
 * by that node's daemon over the wire, and every other directory by the local
 * provider this plugin composes in an isolated scope. A consumer asks for a
 * terminal in a directory and never asks which machine owns it, exactly as the
 * file, shell, and subprocess routers answer.
 *
 * With no anchor configured every directory is local, so the router is a
 * pass-through to the composed provider.
 *
 * @module dsh-remote-workspace/plugin/routing/tty
 */

import type { TtyHandle, TtyRuntime, TtySpawnRequest } from '../../tty.ts'
import { createRemoteTty } from '../../remote/tty.ts'
import type { TtyWire } from '../../remote/tty.ts'
import type { ChannelLookup, NodeChannel } from '../../remote/client.ts'
import { asTermId } from '../../remote/protocol.ts'
import type { AnchorRoute } from '../../storage/anchors.ts'
import { ambiguousPathMessage, classifyPath } from '../../models/routing.ts'

/**
 * The members this provider implements, narrowed from the seam class so the
 * object literal is checkable without inheriting `Service`.
 */
export type TtyRuntimeContract = Pick<TtyRuntime, 'spawn'>

/** What the routing terminal provider needs from its owner. */
export interface RoutingTtyDeps {
  /** The composed provider serving every local directory. */
  readonly localTty: TtyRuntime
  /** Every anchor this plugin currently owns. */
  readonly anchors: () => readonly AnchorRoute[]
  /** Resolves the live channel for a node; undefined means "not connected". */
  readonly channel: ChannelLookup
}

/**
 * Adapt one node channel to the terminal port.
 *
 * Both seams that allocate a terminal on a node drive the same daemon methods,
 * so they drive them through this one adapter — and this is the one place the
 * daemon's opaque session id becomes the branded id the wire contract carries.
 * @param channel - the live node channel.
 * @returns the port `createRemoteTty` drives.
 */
export function terminalWire(channel: NodeChannel): TtyWire {
  return {
    spawn: request => channel.request('term.spawn', request),
    read: (termId, fromByte) => channel.request('term.read', { termId: asTermId(termId), fromByte }),
    // The daemon answers these with an empty object; the port promises nothing
    // back, so the answer is awaited and dropped.
    write: async (termId, data) => {
      await channel.request('term.write', { termId: asTermId(termId), data })
    },
    resize: async (termId, cols, rows) => {
      await channel.request('term.resize', { termId: asTermId(termId), cols, rows })
    },
    terminate: async (termId) => { await channel.request('term.terminate', { termId: asTermId(termId) }) },
    outcome: termId => channel.request('term.outcome', { termId: asTermId(termId) }),
  }
}

/**
 * Build the routing terminal runtime.
 * @param deps - the composed local provider, the live anchors, and channel lookup.
 * @returns an object satisfying the terminal seam, ready for `ctx.provide`.
 */
export function createRoutingTty(deps: RoutingTtyDeps): TtyRuntimeContract {
  return {
    async spawn(request: TtySpawnRequest): Promise<TtyHandle> {
      const route = classifyPath(request.cwd, undefined, deps.anchors())
      if (route.kind === 'local') return await deps.localTty.spawn(request)
      if (route.kind === 'ambiguous') {
        throw new Error(
          ambiguousPathMessage(route),
        )
      }
      const channel = deps.channel(route.nodeId)
      if (channel === undefined) throw new Error(`remote node "${route.nodeId}" is not connected`)
      return await createRemoteTty(terminalWire(channel), { ...request, cwd: route.remotePath })
    },
  }
}
