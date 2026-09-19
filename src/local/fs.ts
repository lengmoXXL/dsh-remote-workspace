/**
 * This host's own filesystem, for the management plane.
 *
 * The panel's operations run where the plugin runs, so the local machine's
 * answers come from `node:fs` rather than from the routed `ctx.fs` seam: that
 * seam belongs to a session's execution world, and the panel has to keep
 * working from a deployment whose sessions are confined somewhere else — or
 * whose execution world is another machine entirely.
 *
 * @module dsh-remote-workspace/local/fs
 */

import { readdir, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

/** What one directory entry's type can be, in the vocabulary the wire uses. */
export type LocalPathType = 'file' | 'directory' | 'symlink' | 'other'

/** One entry of a local directory listing, as the panel reads one. */
export interface LocalDirEntry {
  /** Entry name, without its directory. */
  readonly name: string
  /** What the entry is. */
  readonly type: LocalPathType
  /** Absolute path of the entry. */
  readonly path: string
}

/**
 * Resolve a path the way a machine resolves one.
 *
 * Existence is not part of the answer: a path that is not there still has a
 * canonical spelling, and keeping the two questions apart is what lets the
 * caller answer "does not exist" with the status that belongs to it rather
 * than with a resolver failure.
 * @param path - the caller's path, absolute or relative to the harness' cwd.
 * @returns the canonical absolute path.
 */
export async function resolveLocalPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

/**
 * Read one path's type.
 *
 * A symlink reports what it resolves to, because every caller is asking what a
 * workspace would run in. The listing below answers the other question.
 * @param path - the absolute path to probe.
 * @returns the type, or undefined when nothing is there.
 */
export async function localPathType(path: string): Promise<LocalPathType | undefined> {
  try {
    const info = await stat(path)
    if (info.isDirectory()) return 'directory'
    if (info.isFile()) return 'file'
    return 'other'
  } catch {
    return undefined
  }
}

/**
 * List one directory's entries.
 *
 * Sizes are not read: nothing in the panel shows them, and one `stat` per entry
 * would buy a column no surface renders.
 * @param path - the absolute directory to read.
 * @returns its entries in the order the filesystem reports them.
 * @throws the filesystem failure when the directory cannot be read.
 */
export async function listLocalDir(path: string): Promise<readonly LocalDirEntry[]> {
  const entries = await readdir(path, { withFileTypes: true })
  return entries.map(entry => ({
    name: entry.name,
    type: entry.isDirectory()
      ? 'directory'
      : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
    path: resolve(path, entry.name),
  }))
}
