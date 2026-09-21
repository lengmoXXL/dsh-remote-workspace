/**
 * The terminal primitive end to end: a real PTY allocated by the real daemon
 * and driven through the plugin's routing proxy.
 *
 * A PTY is the one primitive that cannot be reconstructed from pipes, so this
 * is the only case that proves the terminal path works rather than merely
 * compiles. A host that cannot allocate one skips explicitly — the sandbox this
 * repository's checks run in denies `/dev/ptmx`.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startAgent } from './harness.ts'
import type { TestAgent } from './harness.ts'
import type { SubprocessRuntime, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { connectNode } from '../../src/remote/client.ts'
import type { ConnectedNode } from '../../src/remote/client.ts'
import type { AnchorRoute } from '../../src/storage/anchors.ts'
import { createRoutingSubprocessRuntime } from '../../src/plugin/routing/subprocess.ts'

/** The PTC program host this router is told about; no case here runs a PTC program. */
const ptcHost = async () => '/home/dev/.dsh/remote-agent/dsh-ptc-host'
import type { RemoteTerminalHandle } from '../../src/plugin/routing/subprocess.ts'
import { asNodeId } from '../../src/storage/nodes.ts'

const TOKEN = 'terminal-token-0123456789'

let remoteRoot: string
let anchorRoot: string
let server: TestAgent
let node: ConnectedNode
let blocked: string | undefined

/** Allocate one throwaway terminal to learn whether this host allows a PTY. */
async function probePty(): Promise<string | undefined> {
  try {
    const probe = await node.channel.request('term.spawn', {
      argv: ['/bin/sh', '-c', 'true'],
      cwd: remoteRoot,
      rows: 24,
      cols: 80,
      graceMs: 500,
    })
    await node.channel.request('term.terminate', { termId: probe.termId })
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

before(async () => {
  remoteRoot = await realpath(await mkdtemp(join(tmpdir(), 'drw-term-remote-')))
  anchorRoot = await realpath(await mkdtemp(join(tmpdir(), 'drw-term-anchor-')))

  server = await startAgent({ token: TOKEN, root: remoteRoot })
  const port = Number(server.boundAddress.slice(server.boundAddress.lastIndexOf(':') + 1))
  node = await connectNode({ host: '127.0.0.1', port, token: TOKEN, timeoutMs: 5_000 })
  blocked = await probePty()
})

after(async () => {
  node?.close()
  await server?.close()
  await rm(remoteRoot, { recursive: true, force: true })
  await rm(anchorRoot, { recursive: true, force: true })
})

/** The routing terminal runtime over this node. */
function runtime(): ReturnType<typeof createRoutingSubprocessRuntime> {
  const anchors: AnchorRoute[] = [{ nodeId: asNodeId('n1'), anchorPath: anchorRoot, remoteRoot }]
  return createRoutingSubprocessRuntime({
    ptcHost,
    localProc: new Proxy({}, {
      get: () => () => {
        throw new Error('the local subprocess delegate was reached')
      },
    }) as unknown as SubprocessRuntime,
    anchors: () => anchors,
    channel: id => (id === 'n1' ? node.channel : undefined),
  })
}

/** Collect terminal output until `predicate` holds, or give up. */
async function until(
  handle: SubprocessTerminalHandle,
  text: string,
  predicate: (seen: string) => boolean,
  label: string,
): Promise<string> {
  const collected: string[] = []
  handle.output.on('data', (chunk: Buffer | string) => collected.push(chunk.toString()))
  const deadline = Date.now() + 10_000
  for (;;) {
    await handle.write(text)
    const seen = collected.join('')
    if (predicate(seen)) return seen
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}; saw ${JSON.stringify(seen)}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** Report the PTY skip for a case that needs a real terminal. */
function skipWithoutPty(t: { skip: (reason: string) => void }): boolean {
  if (blocked === undefined) return false
  t.skip(`this host cannot allocate a PTY: ${blocked}`)
  return true
}

test('a terminal is allocated on the node with a real pid', async (t) => {
  if (skipWithoutPty(t)) return
  const handle = await runtime().spawnTerminal({
    argv: ['/bin/sh', '-i'],
    cwd: anchorRoot,
    rows: 24,
    cols: 80,
    terminalType: 'xterm-256color',
    graceMs: 1000,
  })

  assert.equal(typeof handle.pid, 'number')
  assert.ok(handle.pid > 0)
  await handle.terminate()
  await handle.done
})

test('input written to the terminal reaches the shell and its reply comes back', async (t) => {
  if (skipWithoutPty(t)) return
  const handle = await runtime().spawnTerminal({
    argv: ['/bin/sh', '-i'],
    cwd: anchorRoot,
    rows: 24,
    cols: 80,
    terminalType: 'xterm-256color',
    graceMs: 1000,
  })

  const seen = await until(handle, 'echo drw-terminal-probe\n', output => output.includes('drw-terminal-probe'), 'the shell reply')
  assert.match(seen, /drw-terminal-probe/)

  await handle.terminate()
  await handle.done
})

test('the terminal runs in the remote working directory', async (t) => {
  if (skipWithoutPty(t)) return
  const handle = await runtime().spawnTerminal({
    argv: ['/bin/sh', '-i'],
    cwd: anchorRoot,
    rows: 24,
    cols: 80,
    terminalType: 'xterm-256color',
    graceMs: 1000,
  })

  const marker = remoteRoot.slice(remoteRoot.lastIndexOf('/') + 1)
  const seen = await until(handle, 'pwd\n', output => output.includes(marker), 'the working directory')
  assert.match(seen, new RegExp(marker))

  await handle.terminate()
  await handle.done
})

test('a resize reaches the node and changes the pty window size', async (t) => {
  if (skipWithoutPty(t)) return
  const handle = await runtime().spawnTerminal({
    argv: ['/bin/sh', '-i'],
    cwd: anchorRoot,
    rows: 24,
    cols: 80,
    terminalType: 'xterm-256color',
    graceMs: 1000,
  })

  await (handle as RemoteTerminalHandle).resize(120, 40)
  // `stty size` reads the terminal's own window size, so the answer is the
  // node's kernel's, not this proxy's bookkeeping.
  const seen = await until(handle, 'stty size\n', output => /\b40 120\b/u.test(output), 'the resized window size')
  assert.match(seen, /\b40 120\b/u)

  await handle.terminate()
  await handle.done
})

test('foreground inspection answers a group or an honest nothing', async (t) => {
  if (skipWithoutPty(t)) return
  const handle = await runtime().spawnTerminal({
    argv: ['/bin/sh', '-i'],
    cwd: anchorRoot,
    rows: 24,
    cols: 80,
    terminalType: 'xterm-256color',
    graceMs: 1000,
  })
  await until(handle, 'sleep 5\n', () => false, 'sleep to start').catch(() => {})

  const foreground = await handle.inspectForeground()
  // macOS cannot prove a foreground group for a shell it did not spawn a job
  // in; `undefined` is the honest answer there and must not be a zero id.
  if (foreground !== undefined) assert.ok(foreground.processGroupId > 0)

  await handle.terminate()
  await handle.done
})

test('terminate ends the session and settles the handle', async (t) => {
  if (skipWithoutPty(t)) return
  const handle = await runtime().spawnTerminal({
    argv: ['/bin/sh', '-i'],
    cwd: anchorRoot,
    rows: 24,
    cols: 80,
    terminalType: 'xterm-256color',
    graceMs: 500,
  })
  await handle.terminate()
  const outcome = await handle.done

  assert.equal(outcome === undefined, false)
  // A killed session reports a signal or a non-zero code, never a clean zero.
  assert.equal(outcome.exitCode === 0, false)
})
