/**
 * The two ways this plugin drives `ssh` against a machine.
 *
 * The command runner is the seam every install step rides, so its cases are
 * about the contract the installer depends on: a non-zero exit is a result and
 * not an exception, the command and destination reach the argument vector, and
 * a process that cannot start or outlives its deadline is the only thing that
 * rejects.
 *
 * The forward is the only thing standing between a stored record and a
 * reachable daemon, so its cases are about the two ways it can lie: reporting
 * success while forwarding nothing, and failing without saying which option the
 * operator must change.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import type { SshProcess, TunnelProcess } from '../../src/remote/ssh.ts'
import {
  allocateLocalPort,
  openTunnel,
  runSsh,
  sshArgs,
  sshFailure,
  tunnelArgs,
  tunnelFailure,
} from '../../src/remote/ssh.ts'

/** A process stub whose exit this test controls. */
function stubProcess(exit: number, stdout = '', stderr = ''): SshProcess {
  return {
    exited: Promise.resolve(exit),
    readStdout: () => stdout,
    readStderr: () => stderr,
    send: () => {},
    kill: () => {},
  }
}

test('the shared ssh options keep the command non-interactive', () => {
  assert.deepEqual(sshArgs({ target: 'me@build-01' }), [
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
  ])
})

test('a destination and command reach the argument vector, and stdin closes', async () => {
  let seen: readonly string[] = []
  let sent: Buffer | string | undefined
  const result = await runSsh(
    { target: 'me@build-01', sshPort: 2222, identityFile: '~/.ssh/id_ed25519' },
    'uname -s',
    { input: 'payload' },
    {
      start: (args) => {
        seen = args
        return {
          exited: Promise.resolve(0),
          readStdout: () => 'Linux\n',
          readStderr: () => '',
          send: (input) => { sent = input },
          kill: () => {},
        }
      },
    },
  )

  assert.equal(seen.at(-1), 'uname -s')
  assert.equal(seen.at(-2), 'me@build-01')
  assert.equal(seen[seen.indexOf('-p') + 1], '2222')
  assert.equal(seen[seen.indexOf('-i') + 1], '~/.ssh/id_ed25519')
  assert.equal(sent, 'payload')
  assert.deepEqual(result, { code: 0, stdout: 'Linux\n', stderr: '' })
})

test('a non-zero exit resolves with its code and both streams', async () => {
  const result = await runSsh(
    { target: 'me@build-01' },
    'exit 3',
    {},
    { start: () => stubProcess(3, 'some output', 'some diagnostic') },
  )

  assert.deepEqual(result, { code: 3, stdout: 'some output', stderr: 'some diagnostic' })
})

test('a process that cannot start rejects naming the destination', async () => {
  await assert.rejects(
    () => runSsh(
      { target: 'me@build-01' },
      'true',
      {},
      {
        start: () => ({
          exited: Promise.reject(new Error('spawn ssh ENOENT')),
          readStdout: () => '',
          readStderr: () => '',
          send: () => {},
          kill: () => {},
        }),
      },
    ),
    /could not start ssh for "me@build-01": spawn ssh ENOENT/,
  )
})

test('a run that outlives its deadline rejects and kills the process', async () => {
  let killed = false
  await assert.rejects(
    () => runSsh(
      { target: 'me@build-01' },
      'sleep 60',
      { timeoutMs: 20 },
      {
        start: () => ({
          exited: new Promise<number>(() => {}),
          readStdout: () => '',
          readStderr: () => 'still connecting',
          send: () => {},
          kill: () => { killed = true },
        }),
      },
    ),
    /did not finish within 20ms/,
  )
  assert.equal(killed, true)
})

test('the shared diagnostic names the remedy and keeps the original text', () => {
  assert.match(sshFailure('h', 'Host key verification failed.', 'fallback'), /run `ssh h` once/)
  assert.match(sshFailure('h', 'Permission denied (publickey).', 'fallback'), /ssh-agent/)
  assert.match(sshFailure('h', 'nobody has seen this', 'could not do the thing'), /could not do the thing: nobody has seen this/)
})

const SSH = { target: 'build-01' }

test('the forward is a silent, fail-fast, keepalive tunnel to the daemon loopback', () => {
  const args = tunnelArgs({ ssh: SSH, remotePort: 7801 }, 54321)

  assert.deepEqual(args, [
    '-N',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-L', '127.0.0.1:54321:127.0.0.1:7801',
    'build-01',
  ])
})

test('a configured SSH port and identity file reach the command line', () => {
  const args = tunnelArgs(
    { ssh: { target: 'me@build-01', sshPort: 2222, identityFile: '~/.ssh/id_ed25519' }, remotePort: 9 },
    1000,
  )

  assert.equal(args.at(-1), 'me@build-01')
  assert.equal(args[args.indexOf('-p') + 1], '2222')
  assert.equal(args[args.indexOf('-i') + 1], '~/.ssh/id_ed25519')
  assert.equal(args[args.indexOf('-L') + 1], '127.0.0.1:1000:127.0.0.1:9')
})

test('an omitted SSH port or identity file is left to the operator’s configuration', () => {
  const args = tunnelArgs({ ssh: SSH, remotePort: 7801 }, 1)
  assert.equal(args.includes('-p'), false)
  assert.equal(args.includes('-i'), false)
})

test('each known ssh failure names the remedy, and keeps the original text', () => {
  assert.match(tunnelFailure('h', 'Host key verification failed.'), /run `ssh h` once/)
  assert.match(tunnelFailure('h', 'open failed: administratively prohibited'), /AllowTcpForwarding yes/)
  assert.match(tunnelFailure('h', 'Permission denied (publickey).'), /ssh-agent/)
  assert.match(tunnelFailure('h', 'Could not resolve hostname h'), /cannot be resolved/)
  assert.match(tunnelFailure('h', 'connect to host h port 22: Connection refused'), /unreachable/)
})

test('an unrecognised failure keeps the text rather than paraphrasing it', () => {
  const message = tunnelFailure('h', 'something nobody has seen before')
  assert.match(message, /could not open an SSH forward to "h"/)
  assert.match(message, /something nobody has seen before/)
})

test('an empty diagnostic still names the target', () => {
  assert.equal(tunnelFailure('h', '   '), 'could not open an SSH forward to "h"')
})

/** A listener the injected allocator can hand out, standing in for the forward. */
function listeningPort(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ port, close: () => { server.close() } })
    })
  })
}

/** A process stub that never exits on its own. */
function liveProcess(): TunnelProcess & { killed: boolean } {
  const process = {
    killed: false,
    exited: new Promise<void>(() => {}),
    diagnostics: () => '',
    kill() { process.killed = true },
  }
  return process
}

test('the host offers a usable free port', async () => {
  const port = await allocateLocalPort()
  assert.equal(Number.isInteger(port), true)
  assert.equal(port > 0 && port < 65536, true)
  // The probe must release what it bound, so the port can be handed out again.
  const rebind = createServer()
  await new Promise<void>((resolve, reject) => {
    rebind.once('error', reject)
    rebind.listen(port, '127.0.0.1', () => { resolve() })
  })
  await new Promise<void>((resolve) => { rebind.close(() => { resolve() }) })
})

test('a forward that never accepts connections is refused, not reported ready', async () => {
  const process = liveProcess()
  await assert.rejects(
    () => openTunnel(
      { ssh: SSH, remotePort: 7801 },
      { allocatePort: () => Promise.resolve(1), start: () => process, readyTimeoutMs: 30, readyPollMs: 5 },
    ),
    /did not start accepting connections/,
  )
  assert.equal(process.killed, true)
})

test('a forward whose ssh exits is refused with what ssh wrote', async () => {
  const process: TunnelProcess = {
    exited: Promise.resolve(),
    diagnostics: () => 'open failed: administratively prohibited: open failed',
    kill: () => {},
  }
  await assert.rejects(
    () => openTunnel(
      { ssh: { target: 'locked-down' }, remotePort: 7801 },
      { allocatePort: () => Promise.resolve(1), start: () => process, readyTimeoutMs: 200, readyPollMs: 5 },
    ),
    /AllowTcpForwarding yes/,
  )
})

test('a forward that accepts connections resolves with its local port and closes on demand', async () => {
  const listener = await listeningPort()
  const process = liveProcess()
  const tunnel = await openTunnel(
    { ssh: SSH, remotePort: 7801 },
    {
      allocatePort: () => Promise.resolve(listener.port),
      start: () => process,
      readyTimeoutMs: 500,
      readyPollMs: 5,
    },
  )

  assert.equal(tunnel.localPort, listener.port)
  tunnel.close()
  tunnel.close()
  assert.equal(process.killed, true)
  listener.close()
})

test('the forward hands back the ports it was told to use', async () => {
  const listener = await listeningPort()
  let seen: readonly string[] = []
  const tunnel = await openTunnel(
    { ssh: { target: 'me@h', sshPort: 22 }, remotePort: 47801 },
    {
      allocatePort: () => Promise.resolve(listener.port),
      start: (args) => { seen = args; return liveProcess() },
      readyTimeoutMs: 500,
      readyPollMs: 5,
    },
  )

  assert.equal(seen.includes('127.0.0.1:' + String(listener.port) + ':127.0.0.1:47801'), true)
  tunnel.close()
  listener.close()
})
