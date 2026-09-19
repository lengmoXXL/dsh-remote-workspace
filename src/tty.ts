/**
 * The terminal seam: one PTY, on whichever machine owns a workspace.
 *
 * A consumer allocates a terminal through `ctx.tty` and gets a handle. Two
 * shapes of provider satisfy this seam: one that owns a PTY on this host, and
 * one that proxies a PTY a node daemon holds. The consumer names a working
 * directory and never asks which — the provider composed for that directory
 * answers, exactly as `ctx.fs` and `ctx.subprocess` do.
 *
 * `resize` is why this seam exists beside `ctx.subprocess`. A terminal is a view
 * a person changes the shape of while the shell inside it keeps running, and
 * the subprocess seam has no verb for that: its terminal handle stops at
 * allocation, text, foreground groups, and teardown.
 *
 * The seam carries no foreground verbs yet. The consumer is a terminal on
 * screen, whose Ctrl-C travels as input bytes the line discipline turns into a
 * signal; the model-facing PTY tools keep using the seams that already carry
 * them. A verb earns its place here with a caller.
 *
 * @module dsh-remote-workspace/tty
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Readable } from 'node:stream'

/** How one terminal's top-level process ended. */
export interface TtyOutcome {
  /** Exit code, or null when a signal ended it. */
  readonly exitCode: number | null
  /** Signal that ended it, or null for a normal exit. */
  readonly signal: NodeJS.Signals | null
}

/**
 * Grace a provider gives a terminal between the terminate signal and the kill
 * that follows it, when the caller names none.
 */
export const DEFAULT_TTY_GRACE_MS = 3000

/** What one terminal is asked for. */
export interface TtySpawnRequest {
  /** Program and arguments, resolved on the machine that runs them. */
  readonly argv: readonly [string, ...string[]]
  /** Working directory on the machine that owns it. */
  readonly cwd: string
  /** Variables layered onto the provider's own environment. */
  readonly env?: Readonly<Record<string, string>>
  /** Initial window size, in columns. */
  readonly cols: number
  /** Initial window size, in rows. */
  readonly rows: number
  /**
   * Milliseconds between the terminate signal and the kill that follows it;
   * {@link DEFAULT_TTY_GRACE_MS} when omitted.
   */
  readonly graceMs?: number
}

/** One live terminal. */
export interface TtyHandle {
  /** Process id on the machine that owns the terminal. */
  readonly pid: number
  /** Output bytes in delivery order; ends when the terminal does. */
  readonly output: Readable
  /** Resolves when the top-level process exits. */
  readonly done: Promise<TtyOutcome>
  /**
   * Deliver input bytes.
   * @param data - UTF-8 text, sent without newline conversion.
   */
  write(data: string): Promise<void>
  /** Adopt a new window size. */
  resize(cols: number, rows: number): Promise<void>
  /**
   * Release the terminal, escalating to a kill after the grace period.
   * Idempotent: a second call joins the first.
   */
  terminate(): Promise<void>
}

/**
 * Service provider for terminals.
 *
 * Extending this class is what publishes the provider as `ctx.tty`; a routing
 * provider that is not a subclass is registered with `ctx.provide` instead, the
 * way the other routing seams in this workspace are.
 */
export abstract class TtyRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tty')
  }

  /**
   * Allocate one terminal and start the program in it.
   * @param request - what to run, where, how large, and how to end it.
   * @returns the live handle, valid until the program exits.
   */
  abstract spawn(request: TtySpawnRequest): Promise<TtyHandle>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Terminal provider composed for this deployment. */
    tty: TtyRuntime
  }
}
