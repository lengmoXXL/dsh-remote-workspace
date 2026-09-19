/**
 * The local provider's cases are the three facts a terminal on screen depends
 * on: the program's bytes come back, the window size can be changed while the
 * shell inside it keeps running, and the terminal goes away when it is told to.
 *
 * Every case drives a real PTY — this package owns one, so a fake would only
 * prove that the fake works — with short-lived programs so the suite stays
 * quick, and every case releases its terminal so no shell outlives the run.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalTtyRuntime } from '../../src/local/tty.ts'
import { ptyUnavailable, watcher } from '../tty.ts'

/** Skip every case on a host whose sandbox refuses a PTY. */
const noPty = await ptyUnavailable()

/** The provider every case asks for a terminal. */
function provider(): LocalTtyRuntime {
  return new LocalTtyRuntime(new Context())
}

test('a program runs on a pty and its output comes back', { skip: noPty }, async () => {
  const handle = await provider().spawn({
    argv: ['/bin/echo', 'hello from the pty'],
    cwd: '/tmp',
    cols: 80,
    rows: 24,
  })
  const output = watcher(handle)
  await output.until('hello from the pty')
  assert.deepEqual(await handle.done, { exitCode: 0, signal: null })
})

test('a resize reaches the pty while its shell is running', { skip: noPty }, async () => {
  // An interactive shell ignores SIGTERM, so releasing it here runs the whole
  // ladder; the short grace keeps that from being the slowest case in the file.
  const handle = await provider().spawn({ argv: ['/bin/sh'], cwd: '/tmp', cols: 80, rows: 24, graceMs: 300 })
  const output = watcher(handle)
  try {
    handle.write('stty size\n')
    await output.until('24 80')
    await handle.resize(120, 40)
    handle.write('stty size\n')
    await output.until('40 120')
  } finally {
    await handle.terminate()
  }
})

test('the caller environment is layered onto this process', { skip: noPty }, async () => {
  const handle = await provider().spawn({
    argv: ['/bin/sh', '-c', 'echo "value=$DRW_TTY_TEST inherited=${PATH:+set}"'],
    cwd: '/tmp',
    env: { DRW_TTY_TEST: 'layered' },
    cols: 80,
    rows: 24,
  })
  await watcher(handle).until('value=layered inherited=set')
  await handle.done
})

test('terminate ends a long-running program, and a later call is a no-op', { skip: noPty }, async () => {
  const handle = await provider().spawn({
    argv: ['/bin/sleep', '30'],
    cwd: '/tmp',
    cols: 80,
    rows: 24,
    graceMs: 500,
  })
  await handle.terminate()
  const outcome = await handle.done
  assert.notEqual(outcome.signal, null, 'the program ended by signal rather than on its own')
  await handle.terminate()
  assert.deepEqual(await handle.done, outcome, 'a later release leaves the settled outcome alone')
})

test('a program that cannot start is reported through the outcome', { skip: noPty }, async () => {
  // node-pty reports a failed exec as an exiting child rather than a spawn
  // failure, so the seam's outcome is where the caller learns of it.
  const handle = await provider().spawn({
    argv: ['/nonexistent/drw-tty'],
    cwd: '/tmp',
    cols: 80,
    rows: 24,
  })
  const outcome = await handle.done
  assert.ok(
    outcome.exitCode !== null && outcome.exitCode !== 0,
    `expected a failing exit code, got ${JSON.stringify(outcome)}`,
  )
})
