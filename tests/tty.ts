/**
 * Whether this host can allocate a pseudo-terminal.
 *
 * A restricted sandbox can refuse `posix_openpt`, and a terminal case needs a
 * real PTY to mean anything. Probing once lets a suite report itself as skipped
 * rather than failing on the environment; an unrestricted host still runs every
 * case.
 */

import { Context } from '@deepseek-ai/cordis'
import { LocalTtyRuntime } from '../src/local/tty.ts'

/**
 * Probe for a usable PTY.
 * @returns the reason to skip with, or undefined when a PTY works.
 */
export async function ptyUnavailable(): Promise<string | undefined> {
  try {
    const handle = await new LocalTtyRuntime(new Context()).spawn({
      argv: ['/bin/sh', '-c', 'exit 0'],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    })
    await handle.done
    return undefined
  } catch (error) {
    return `no pseudo-terminal on this host: ${error instanceof Error ? error.message : String(error)}`
  }
}
