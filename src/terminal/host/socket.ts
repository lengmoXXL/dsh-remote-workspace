/**
 * The host's WebSocket route.
 *
 * A terminal is a live byte stream in both directions, which no request/response
 * route carries, so this plugin registers an upgrade route on the deployment's
 * Web server. Two properties come with that:
 *
 * - the route is registered through `ctx.get('webServer')` rather than an
 *   injected dependency, because a profile that serves no browser (headless,
 *   SDK) has no HTTP server and this plugin must still load there;
 * - the upgrade passes the same browser-trust fence as every `/api` request
 *   before the socket changes hands. WebSocket handshakes carry cookies and are
 *   not covered by the browser's same-origin policy, so without that fence any
 *   page in the browser could open a shell on this host.
 *
 * Unloading the plugin terminates every live socket; each socket's close
 * handler then detaches its registry entry, and the registry's own disposal
 * releases every terminal that would otherwise outlive the plugin.
 *
 * @module dsh-remote-workspace/terminal/host/socket
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { WebSocket, WebSocketServer } from 'ws'
import { attachTerminal } from './terminal.ts'
import type { TerminalRegistry } from './registry.ts'

/**
 * Refuse an upgrade without giving the socket to the WebSocket server.
 * @param socket - the socket still owned by this handler.
 * @param status - the HTTP status to answer with.
 */
function rejectUpgrade(socket: Duplex, status: 401 | 403): void {
  const reason = status === 401 ? 'Unauthorized' : 'Forbidden'
  socket.end(`HTTP/1.1 ${String(status)} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
}

/**
 * Register the terminal socket for this plugin's lifetime.
 *
 * A missing Web server is not a failure: it means nobody can open a terminal,
 * not that the plugin is misconfigured.
 *
 * @param ctx - the host context.
 * @param path - the absolute pathname the socket is served at.
 * @param registry - the terminals a person's tabs have open.
 */
export function registerTerminalSocket(ctx: Context, path: string, registry: TerminalRegistry): void {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return

  const server = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  const live = new Set<WebSocket>()

  ctx.effect(() => {
    const unregister = webServer.registerUpgrade({
      path,
      handler: (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
        const rejection = ctx.get('connection')?.requestRejection(request)
        if (rejection !== undefined) {
          rejectUpgrade(socket, rejection)
          return
        }
        server.handleUpgrade(request, socket, head, (accepted) => {
          live.add(accepted)
          accepted.on('close', () => live.delete(accepted))
          attachTerminal(ctx, registry, accepted)
        })
      },
    })
    return () => {
      unregister()
      for (const socket of live) socket.terminate()
      live.clear()
    }
  }, `dsh-terminal: ${path} socket`)
}
