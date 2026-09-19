/**
 * The durable record of the git repositories a user has registered on their
 * machines.
 *
 * A repository is the middle layer of the management tree: a machine holds
 * repositories, and a repository holds the worktrees cut from it. The record
 * stores only what a user chose — which machine, which path, what to call it —
 * because branch and cleanliness are live facts read from the daemon on every
 * listing and would be stale the moment they were written down.
 *
 * @module dsh-remote-workspace/storage/repos
 */

import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { NodeId } from './nodes.ts'
import type { DocumentSpec } from './document.ts'
import { readDocument, writeDocument } from './document.ts'

/** Document revision; a field change bumps it and refuses the old form. */
const DOCUMENT_VERSION = 1

/**
 * One registered repository.
 *
 * Branded so a machine or anchor id cannot be passed where a repository is
 * expected: all three are generated strings that render identically in a log
 * or a URL, and the brand is the only thing that tells them apart. It lives in
 * the type system alone.
 */
export type RepoId = Branded<'RepoId'>

/**
 * Admit a string as a repository id.
 *
 * Called where a string first becomes an id: a field a request carried. Every
 * later hop carries the type.
 * @param value - the string that request named.
 * @returns the same string, branded.
 */
export function asRepoId(value: string): RepoId {
  return brandString<RepoId>(value)
}

/** One registered repository. */
export interface RepoRecord {
  /** Stable generated id; never the path, so moving a checkout is free. */
  readonly repoId: RepoId
  /** The machine holding the checkout. */
  readonly nodeId: NodeId
  /** Absolute POSIX path of the repository on that machine. */
  readonly repoPath: string
  /** Display name. Defaults to the path's last segment. */
  readonly name: string
  /** ISO-8601 creation instant. */
  readonly createdAt: string
}

/** A caller's registration request. */
export interface RepoDraft {
  /** Existing id to update in place; omitted registers a new repository. */
  readonly repoId?: RepoId
  /** The machine holding the checkout. */
  readonly nodeId: NodeId
  /** Absolute POSIX path of the repository on that machine. */
  readonly repoPath: string
  /** Display name; omitted derives one from the path. */
  readonly name?: string
}

/** Where one repository lives, as callers address it. */
export type RepoRef = Pick<RepoRecord, 'nodeId' | 'repoPath'>

/** The repository store. */
export interface RepoStore {
  /**
   * Read the document into memory.
   * @returns the loaded records, in document order.
   * @throws when the JSON is malformed, the version is unsupported, or a
   *   record is not one this build wrote.
   */
  load(): Promise<readonly RepoRecord[]>
  /** Every registered repository, in stable document order. */
  list(): readonly RepoRecord[]
  /**
   * One repository by id.
   * @param repoId - the generated record id.
   * @returns the record, or undefined when no repository carries that id.
   */
  get(repoId: RepoId): RepoRecord | undefined
  /**
   * The record already covering one machine path.
   * @param ref - the machine and absolute path.
   * @returns the record, or undefined when that path is not registered.
   */
  find(ref: RepoRef): RepoRecord | undefined
  /**
   * Register or update one repository and persist the result.
   * @param draft - the caller's fields; omitted `repoId` generates one.
   * @returns the stored record.
   */
  upsert(draft: RepoDraft): Promise<RepoRecord>
  /**
   * Drop one repository and persist the result.
   * @param repoId - the record to drop.
   * @returns true when a record was removed.
   */
  remove(repoId: RepoId): Promise<boolean>
  /**
   * Drop every repository of one machine, for machine removal.
   * @param nodeId - the machine whose registrations go away.
   * @returns the number of records removed.
   */
  removeByNode(nodeId: NodeId): Promise<number>
}

export interface RepoStoreDeps {
  /** Absolute path of the JSON document. */
  readonly file: string
  /** Injectable clock, so tests do not depend on wall time. */
  readonly now?: () => Date
}

/** Whether an unknown parsed value is a record this module wrote. */
function isRepoRecord(value: unknown): value is RepoRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<Record<keyof RepoRecord, unknown>>
  return typeof record.repoId === 'string'
    && typeof record.nodeId === 'string'
    && typeof record.repoPath === 'string'
    && typeof record.name === 'string'
    && typeof record.createdAt === 'string'
}

/**
 * The name to show for a path no caller named.
 * @param repoPath - absolute POSIX path of the checkout.
 * @returns the last path segment.
 */
export function defaultRepoName(repoPath: string): string {
  return posix.basename(repoPath)
}

/**
 * Build a repository store over one document.
 * @param deps - the document path and an optional clock.
 * @returns the store; call {@link RepoStore.load} before serving reads.
 */
export function createRepoStore(deps: RepoStoreDeps): RepoStore {
  const now = deps.now ?? (() => new Date())
  let repos: RepoRecord[] = []
  let loaded = false

  const requireLoaded = (): void => {
    if (!loaded) throw new Error('repository store read before load()')
  }

  const document: DocumentSpec<RepoRecord> = {
    file: deps.file,
    version: DOCUMENT_VERSION,
    key: 'repos',
    label: 'repository',
    isRecord: isRepoRecord,
  }

  return {
    async load() {
      repos = [...await readDocument(document)]
      loaded = true
      return repos
    },

    list() {
      requireLoaded()
      return repos
    },

    get(repoId) {
      requireLoaded()
      return repos.find(repo => repo.repoId === repoId)
    },

    find(ref) {
      requireLoaded()
      return repos.find(repo => repo.nodeId === ref.nodeId && repo.repoPath === ref.repoPath)
    },

    async upsert(draft) {
      requireLoaded()
      const existing = draft.repoId === undefined ? undefined : repos.find(repo => repo.repoId === draft.repoId)
      // A re-registration of the same path keeps the name the user chose; a
      // record moved to another path re-derives it, because a name taken from
      // the old path would misdescribe the new one.
      const kept = existing !== undefined && existing.repoPath === draft.repoPath
      const record: RepoRecord = {
        repoId: existing?.repoId ?? draft.repoId ?? brandString<RepoId>(randomUUID()),
        nodeId: draft.nodeId,
        repoPath: draft.repoPath,
        name: draft.name?.trim() || (kept ? existing.name : '') || defaultRepoName(draft.repoPath),
        createdAt: existing?.createdAt ?? now().toISOString(),
      }
      const next = existing === undefined
        ? [...repos, record]
        : repos.map(repo => (repo.repoId === record.repoId ? record : repo))
      await writeDocument(document, next)
      repos = next
      return record
    },

    async remove(repoId) {
      requireLoaded()
      const next = repos.filter(repo => repo.repoId !== repoId)
      if (next.length === repos.length) return false
      await writeDocument(document, next)
      repos = next
      return true
    },

    async removeByNode(nodeId) {
      requireLoaded()
      const next = repos.filter(repo => repo.nodeId !== nodeId)
      const removed = repos.length - next.length
      if (removed === 0) return 0
      await writeDocument(document, next)
      repos = next
      return removed
    },
  }
}
