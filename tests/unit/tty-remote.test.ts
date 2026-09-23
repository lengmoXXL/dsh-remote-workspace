/**
 * The remote provider's cases are the ones an asynchronous wire creates: output
 * that arrives after the handle exists, a resize that has to reach the daemon
 * that owns the PTY, a release that keeps the bytes teardown produced, and a
 * transport that drops instead of answering.
 *
 * A scripted wire is the daemon here: what this package owns is the proxy, and
 * the wire's shape is the one contract it cannot prove by itself.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRemoteTty } from '../../src/remote/tty.ts'
import type { TtyWire, TtyWireOutcome, TtyWireSpawnRequest, TtyWireRead } from '../../src/remote/tty.ts'
import { watcher } from '../tty.ts'

/** One call the provider made, as the scripted wire recorded it. */
type Call =
  | { readonly kind: 'spawn'; readonly request: TtyWireSpawnRequest }
  | { readonly kind: 'read'; readonly termId: string; readonly fromByte: number; readonly waitMs: number | undefined }
  | { readonly kind: 'write'; readonly termId: string; readonly data: string }
  | { readonly kind: 'resize'; readonly termId: string; readonly cols: number; readonly rows: number }
  | { readonly kind: 'terminate'; readonly termId: string }
  | { readonly kind: 'outcome'; readonly termId: string }

/** Base64 for one piece of terminal output, the encoding the wire uses. */
function encoded(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

/**
 * A daemon that answers what it was told to answer.
 * @param options - what each read and each outcome call returns, in order.
 *   Reads are consumed; once the script runs out, a read of the terminal holds
 *   until the terminal is released, the way a daemon that honours the read's
 *   wait budget answers a quiet terminal. Outcomes are consumed by the
 *   teardown's own question and default to "still running".
 * @returns the wire and the calls it recorded.
 */
function scriptedWire(options: {
  readonly reads?: readonly (TtyWireRead | Error)[]
  readonly outcomes?: readonly (TtyWireOutcome | null | Error)[]
} = {}): { wire: TtyWire; calls: Call[] } {
  const calls: Call[] = []
  const waiting: (() => void)[] = []
  let reads = 0
  let outcomes = 0
  let released = false
  return {
    calls,
    wire: {
      async spawn(request): Promise<{ termId: string; pid: number }> {
        calls.push({ kind: 'spawn', request })
        return { termId: 'term-1', pid: 4242 }
      },
      async read(termId, fromByte, waitMs): Promise<TtyWireRead> {
        calls.push({ kind: 'read', termId, fromByte, waitMs })
        const answer = options.reads?.[reads++]
        if (answer !== undefined) {
          if (answer instanceof Error) throw answer
          return answer
        }
        // Nothing left to answer with: hold the read until the terminal is
        // released, because a read that returned at once would spin the loop
        // that the wire's wait budget exists to keep quiet.
        if (!released) await new Promise<void>(resolve => { waiting.push(resolve) })
        return { data: '', nextOffset: fromByte, lossy: false }
      },
      async write(termId, data): Promise<void> {
        calls.push({ kind: 'write', termId, data })
      },
      async resize(termId, cols, rows): Promise<void> {
        calls.push({ kind: 'resize', termId, cols, rows })
      },
      async terminate(termId): Promise<void> {
        calls.push({ kind: 'terminate', termId })
        released = true
        for (const resolve of waiting.splice(0)) resolve()
      },
      async outcome(termId): Promise<TtyWireOutcome | null> {
        calls.push({ kind: 'outcome', termId })
        const answer = options.outcomes?.[outcomes++] ?? null
        if (answer instanceof Error) throw answer
        return answer
      },
    },
  }
}

/** A request that asks for a shell, so each case only states what it varies. */
const request = {
  argv: ['/bin/sh', '-l'] as const,
  cwd: '/srv/checkout',
  cols: 80,
  rows: 24,
}

/** One read answer that carries the terminal's exit facts. */
function ended(exitCode: number, nextOffset: number): TtyWireRead {
  return { data: '', nextOffset, lossy: false, outcome: { exitCode, signal: null } }
}

/**
 * Wait for a promise while keeping the event loop awake.
 *
 * The provider follows the daemon with no timer of its own, and on Node 22 and
 * 24 the test runner cancels a case whose promise is still pending when the loop
 * drains, which is how this file failed on CI before the wait held a timer of
 * its own.
 * @param promise - what is being waited on.
 * @param timeoutMs - how long to wait before failing.
 * @returns what the promise resolved to.
 */
async function settled<T>(promise: Promise<T>, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const answer = await Promise.race([
      promise.then(value => ({ value })),
      new Promise<undefined>(resolve => { setTimeout(() => resolve(undefined), 10) }),
    ])
    if (answer !== undefined) return answer.value
    if (Date.now() > deadline) throw new Error('the terminal never settled')
  }
}

test('what the daemon retains is published in order, and the exit settles the handle', async () => {
  const { wire, calls } = scriptedWire({
    reads: [
      { data: encoded('hello '), nextOffset: 6, lossy: false },
      { data: encoded('world'), nextOffset: 11, lossy: false },
      ended(0, 11),
    ],
  })
  const handle = await createRemoteTty(wire, { ...request, graceMs: 300 })
  const output = watcher(handle)
  await output.until('hello world')
  assert.equal(output.seen(), 'hello world', 'the chunks arrive in the order the daemon wrote them')
  assert.deepEqual(await settled(handle.done), { exitCode: 0, signal: null })

  // The spawn carried what the caller asked for, under the resolved directory.
  assert.deepEqual(calls[0], {
    kind: 'spawn',
    request: { argv: ['/bin/sh', '-l'], cwd: '/srv/checkout', rows: 24, cols: 80, graceMs: 300 },
  })
  // Offsets advance monotonically, and each read asks the daemon to wait.
  const reads = calls.flatMap(call => call.kind === 'read' ? [call] : [])
  assert.deepEqual(reads.slice(0, 2).map(call => call.fromByte), [0, 6])
  assert.equal(reads.every(call => (call.waitMs ?? 0) > 0), true, 'every read waits at the daemon')

  // The exit settled the handle, so no further read was issued.
  const recorded = calls.length
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(calls.length, recorded)
})

test('output the daemon dropped is reported rather than spliced in', async () => {
  const { wire } = scriptedWire({
    reads: [
      { data: encoded('early'), nextOffset: 5, lossy: false },
      // The offset asked for (5) slid out of the window, which held bytes
      // 91..100: the four bytes here are the tail, not a continuation.
      { data: encoded('TAIL'), nextOffset: 100, lossy: true },
      ended(0, 100),
    ],
  })
  const handle = await createRemoteTty(wire, request)
  const output = watcher(handle)
  await output.until('TAIL')

  assert.match(output.seen(), /output lost: 91 bytes/)
  assert.match(output.seen(), /early/)
  assert.deepEqual(await settled(handle.done), { exitCode: 0, signal: null })
})

test('a resize and a write reach the daemon with the terminal it minted', async () => {
  const { wire, calls } = scriptedWire()
  const handle = await createRemoteTty(wire, request)
  try {
    await handle.resize(120, 40)
    await handle.write('ls\n')
    assert.deepEqual(calls.filter(call => call.kind === 'resize'), [
      { kind: 'resize', termId: 'term-1', cols: 120, rows: 40 },
    ])
    assert.deepEqual(calls.filter(call => call.kind === 'write'), [
      { kind: 'write', termId: 'term-1', data: 'ls\n' },
    ])
  } finally {
    await handle.terminate()
  }
})

test('releasing a terminal keeps the bytes teardown produced', async () => {
  const { wire, calls } = scriptedWire({
    reads: [{ data: encoded('goodbye\n'), nextOffset: 8, lossy: false }],
  })
  const handle = await createRemoteTty(wire, request)
  const output = watcher(handle)
  await handle.terminate()
  assert.equal(output.seen(), 'goodbye\n')
  // A terminal the daemon no longer knows reads as no outcome, so the handle
  // settles with the facts it has rather than waiting for exit facts.
  assert.deepEqual(await settled(handle.done), { exitCode: null, signal: null })
  assert.equal(calls.filter(call => call.kind === 'terminate').length, 1)
})

test('a dropped transport settles the terminal instead of reading forever', async () => {
  const { wire } = scriptedWire({ reads: [new Error('socket hang up')] })
  const handle = await createRemoteTty(wire, request)
  assert.deepEqual(await settled(handle.done), { exitCode: null, signal: null })
})

test('a terminal that cannot be allocated fails the caller', async () => {
  const wire: TtyWire = {
    ...scriptedWire().wire,
    spawn: () => Promise.reject(new Error('node "n1" is not connected')),
  }
  await assert.rejects(() => createRemoteTty(wire, request), /not connected/)
})
