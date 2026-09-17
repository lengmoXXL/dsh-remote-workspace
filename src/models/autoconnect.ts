/**
 * Bring every configured machine up, and keep trying the ones that are down.
 *
 * Nothing connects on an operation's behalf: a machine is reachable because it
 * was connected, not because a file read happened to need it. Without the
 * startup pass a deployment would sit with every machine idle until a person
 * opened the section and clicked Connect — and a restored session would find
 * its workspace unreachable.
 *
 * One machine gets a few attempts in a row, because a failure right after
 * startup is often a machine still booting or an agent still starting. A
 * follow-up pass then revisits the ones still failed, because a first attempt
 * can also meet a link that is not up yet — a laptop that just woke, a VPN
 * still dialling — and that clears on its own. Only `failed` is revisited: a
 * machine a person disconnected stays down.
 *
 * The passes run in the background and never reject. Activation must not wait
 * for SSH, and a machine that cannot be reached is a state the section renders,
 * not a failure of the plugin.
 *
 * @module dsh-remote-workspace/models/autoconnect
 */

import type { NodeId } from '../storage/nodes.ts'
import type { NodeConnections } from './machines.ts'
import type { NodeRecord } from '../storage/nodes.ts'

/** How many times one machine is attempted before the startup pass gives up on it. */
const ATTEMPTS = 3

/** Gap between those attempts, in milliseconds. */
const RETRY_GAP_MS = 2_000

/** What one pass needs. */
export interface AutoconnectDeps {
  /** Every configured machine, read once per pass. */
  readonly records: () => readonly NodeRecord[]
  /** The connection manager that owns the attempts. */
  readonly connections: Pick<NodeConnections, 'connect'>
  /**
   * One machine's current state, so a follow-up pass revisits only the failures
   * a person did not ask to end. Omitted treats every machine as retryable.
   */
  readonly status?: (nodeId: NodeId) => { readonly state: string }
  /** Attempts per machine per pass; defaults to {@link ATTEMPTS}. */
  readonly attempts?: number
  /** Gap between those attempts; defaults to {@link RETRY_GAP_MS}. */
  readonly gapMs?: number
  /**
   * Gap between follow-up passes over the machines still failed. Omitted runs
   * the startup pass once and leaves the failures for a person.
   */
  readonly refreshMs?: number
  /** Sleeps between attempts; injectable so tests do not wait. */
  readonly delay?: (ms: number) => Promise<void>
}

/**
 * Start the connection passes over every configured machine.
 * @param deps - the machines, the connection manager, and the retry knobs.
 * @returns a function that stops the passes; an attempt already in flight is
 *   left to finish or fail on its own, and no further attempt starts.
 */
export function autoconnect(deps: AutoconnectDeps): () => void {
  const attempts = deps.attempts ?? ATTEMPTS
  const gapMs = deps.gapMs ?? RETRY_GAP_MS
  const delay = deps.delay ?? ((ms: number): Promise<void> =>
    new Promise(resolve => { setTimeout(resolve, ms) }))
  let stopped = false

  /** Attempt one machine until it connects, the attempts run out, or this stops. */
  const pass = async (record: NodeRecord): Promise<void> => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (stopped) return
      if (attempt > 0) await delay(gapMs)
      if (stopped) return
      try {
        await deps.connections.connect(record)
        return
      } catch {
        // The attempt recorded its own failure on the machine's status; the
        // only thing left to try is the next attempt.
      }
    }
  }

  /** One machine's part of a pass; the local host has nothing to reach. */
  const consider = (record: NodeRecord, retryOnlyFailed: boolean): void => {
    if (record.transport.kind === 'local') return
    // A follow-up pass exists for a transient link failure, not for a machine a
    // person disconnected; `failed` is the only state it revisits.
    if (retryOnlyFailed && deps.status !== undefined && deps.status(record.nodeId).state !== 'failed') return
    void pass(record)
  }

  for (const record of deps.records()) consider(record, false)

  const timer = deps.refreshMs === undefined
    ? undefined
    : setInterval(() => {
        if (stopped) return
        for (const record of deps.records()) consider(record, true)
      }, deps.refreshMs)
  // A pending retry must never be what keeps the process alive.
  timer?.unref()

  return () => {
    stopped = true
    if (timer !== undefined) clearInterval(timer)
  }
}
