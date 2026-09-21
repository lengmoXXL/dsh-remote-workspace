/**
 * Where the compiled PTC program host lives.
 *
 * The worker is a Rust binary this repository builds beside its crate, so a
 * suite that needs to run a real program builds it first
 * (`cargo build --release --manifest-path ptc-host/Cargo.toml`) or points
 * `DSH_PTC_HOST_BIN` at a binary it already has.
 *
 * @module tests/ptc-host-binary
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** The repository root, one level above this file's directory. */
const repoRoot = join(here, '..')

/** Candidates in the order they win: an explicit override, then a release or debug build. */
function candidates(): readonly string[] {
  const override = process.env['DSH_PTC_HOST_BIN']
  return [
    ...override === undefined || override === '' ? [] : [override],
    join(repoRoot, 'ptc-host', 'target', 'release', 'dsh-ptc-host'),
    join(repoRoot, 'ptc-host', 'target', 'debug', 'dsh-ptc-host'),
  ]
}

/**
 * Resolve the compiled PTC program host.
 * @returns its absolute path.
 * @throws when no build is present.
 */
export function ptcHostBinaryPath(): string {
  const found = candidates().find(path => existsSync(path))
  if (found === undefined) {
    throw new Error(
      'the PTC program host is not built; run '
      + '`cargo build --release --manifest-path ptc-host/Cargo.toml` or set DSH_PTC_HOST_BIN',
    )
  }
  return found
}
