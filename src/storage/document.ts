/**
 * The durable JSON document the node and repository stores share.
 *
 * A document is one file holding a versioned array of records, replaced
 * atomically under a cross-process lock, so two harness processes never
 * interleave a read-render-commit cycle. A caller owns its record shape, the
 * guard that recognizes one, and what the records mean; this module owns the
 * revision gate, the write lock, the atomic publication, and the diagnostics
 * that name a document this build cannot read.
 *
 * @module dsh-remote-workspace/storage/document
 */

import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Owner-only permissions: these documents name paths and carry secrets. */
const FILE_MODE = 0o600

/** How one document is laid out, recognized, and named in diagnostics. */
export interface DocumentSpec<T> {
  /** Absolute path of the JSON document. */
  readonly file: string
  /**
   * Revision this build writes. Revision 1 is read through
   * {@link DocumentSpec.migrate} when the caller supplies one.
   */
  readonly version: number
  /** Property holding the record array. */
  readonly key: string
  /** Names one record in diagnostics, e.g. `node`. */
  readonly label: string
  /** Whether a parsed entry is a record this build wrote. */
  readonly isRecord: (value: unknown) => value is T
  /**
   * Reads one entry of revision 1, for a document whose shape changed after its
   * first release. Supplied only while revision 1 must keep loading.
   */
  readonly migrate?: (value: unknown, index: number) => T
}

/**
 * Read a document, refusing anything this build did not write.
 * @param spec - layout, revision, and the record guard.
 * @returns the stored records in document order, or none when the file is absent.
 * @throws when the JSON is malformed, the revision is unsupported, or an entry
 *   is not a record this build wrote.
 */
export async function readDocument<T>(spec: DocumentSpec<T>): Promise<readonly T[]> {
  let text: string
  try {
    text = await readFile(spec.file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`${spec.file} is not valid JSON`, { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${spec.file} is not a ${spec.label} document`)
  }
  const document = parsed as Record<string, unknown>
  const entries = document[spec.key]
  if (!Array.isArray(entries)) throw new Error(`${spec.file} carries no ${spec.key} list`)
  if (document['version'] === 1 && spec.migrate !== undefined) return entries.map(spec.migrate)
  if (document['version'] !== spec.version) {
    throw new Error(
      `${spec.file} has document version ${String(document['version'])}; this build reads ${String(spec.version)}`,
    )
  }
  if (!entries.every(spec.isRecord)) {
    throw new Error(`${spec.file} carries a ${spec.label} entry this build does not understand`)
  }
  return entries
}

/**
 * Replace a document with one complete serialization.
 *
 * The candidate is serialized before the lock is taken and the caller's
 * in-memory list is replaced only after the write returns, so a failed commit
 * leaves it untouched instead of committing an unreported mutation whose caller
 * already saw an error.
 * @param spec - layout and revision.
 * @param records - the complete record list to publish.
 */
export async function writeDocument<T>(
  spec: DocumentSpec<T>,
  records: readonly T[],
): Promise<void> {
  const content = `${JSON.stringify({ version: spec.version, [spec.key]: records }, null, 2)}\n`
  // The lock is a `wx` create beside the document and never creates its
  // directory, so the first write into a fresh harness home must seed it.
  await mkdir(dirname(spec.file), { recursive: true, mode: 0o700 })
  await withFileLock(spec.file, async () => {
    await writeFileAtomic(spec.file, content, { mode: FILE_MODE })
  })
}
