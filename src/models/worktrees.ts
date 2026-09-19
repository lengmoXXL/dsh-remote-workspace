/**
 * The remote worktree lifecycle: create, list, open, close, remove.
 *
 * It also owns the one workspace that is not a worktree: a repository directory
 * opened as itself. A machine's directory can be worked in before it is a git
 * repository, so opening it maps the directory onto its own anchor, and cutting
 * worktrees from it becomes possible later without re-registering anything —
 * whether it is a repository is a live fact, asked of the machine each time the
 * section reads it.
 *
 * The same lifecycle runs for the local machine, and it is the same to every
 * caller: the same rows, the same drafts, the same results. What differs is
 * where the truth lives. A machine reached over SSH needs an anchor — a local
 * directory standing in for a path this host cannot reach — and that anchor is
 * the record. This host needs nothing of the kind: its checkouts are real
 * directories here, so git itself is the record and an id names a path rather
 * than a handle. That is why a local worktree has no entry to create and none
 * to drop, and why forgetting a repository is still refused while git lists
 * checkouts under it: those rows would be stranded in the panel.
 *
 * Every operation is two-sided on purpose: git runs on the node, and the local
 * anchor is created or dropped around it. The order matters in both
 * directions — an anchor is only recorded after the checkout exists, and the
 * checkout is only removed before its anchor, so a failure never leaves a
 * local path routing into nothing. Within teardown the workspace entry goes
 * first, because dropping the anchor takes the directory that resolves it.
 *
 * Creating one also records the repository it was cut from. That is not
 * bookkeeping for its own sake: the surfaces group worktrees by repository, so
 * a worktree whose repository has no record is a worktree nobody can see or
 * remove from the settings section.
 *
 * The branch is out of scope. Creating a worktree creates the branch it needs,
 * that is unavoidable; deleting one leaves the branch behind unless the caller
 * explicitly asks for it, because deleting branches belongs to whatever plugin
 * owns branches. A branch that could not be deleted is reported rather than
 * swallowed: the worktree is gone either way, and the operator needs to know
 * the branch outlived it.
 *
 * @module dsh-remote-workspace/models/worktrees
 */

import { posix } from 'node:path'
import type { WireWorktree } from '../remote/protocol.ts'
import type { AnchorId, AnchorRecord, AnchorStore, DirectoryAnchor, WorktreeAnchor } from '../storage/anchors.ts'
import { asAnchorId } from '../storage/anchors.ts'
import type { ChannelLookup } from '../remote/client.ts'
import { NodeRequestError } from '../remote/client.ts'
import { asNodeId, type NodeId } from '../storage/nodes.ts'
import type { RepoRecord, RepoRef, RepoStore } from '../storage/repos.ts'
import {
  addWorktree,
  deleteBranch,
  isRepository,
  listWorktrees,
  removeWorktree,
} from '../local/git.ts'
import { localPathType, resolveLocalPath } from '../local/fs.ts'

/** Prefix every managed branch carries. */
const BRANCH_PREFIX = 'worktree/'

/** What a caller supplies to cut a new worktree. */
export interface WorktreeDraft {
  /** The node whose repository is cut. */
  readonly nodeId: NodeId
  /** Absolute POSIX path of the repository on that node. */
  readonly repoPath: string
  /** Worktree name; the branch becomes `worktree/<name>`. */
  readonly name: string
  /**
   * Absolute POSIX path the checkout is created at, when the caller names one.
   * The configured root's `<repository>/<name>` is the default.
   */
  readonly path?: string
  /** Revision to branch from; the repository's HEAD when omitted. */
  readonly baseRef?: string
}

/** What a removal did. */
export interface WorktreeRemoval {
  /** The worktree anchor that was removed. */
  readonly anchor: WorktreeAnchor
  /** Whether the branch was deleted as well. */
  readonly branchDeleted: boolean
  /** Why the branch outlived the checkout, when it did. */
  readonly branchError?: string
}

/** One anchor with what this host can say about it without asking the node. */
export interface WorktreeStatus {
  /** The local anchor. */
  readonly anchor: AnchorRecord
  /** Whether the anchor is registered as a workspace, so a session can open on it. */
  readonly open: boolean
  /**
   * Whether this plugin cut the checkout itself.
   *
   * Both kinds can be removed — the operator's own checkout included, which is
   * what the confirmation says before it deletes one — so the flag only picks
   * that confirmation's wording.
   */
  readonly managed: boolean
  /**
   * Whether this plugin holds a record for the row.
   *
   * A checkout read straight from a machine's git has none until it is opened,
   * so there is nothing to release and only an open or a remove to offer.
   */
  readonly held: boolean
  /** Why the worktree cannot be used right now, when it cannot. */
  readonly error?: string
}

/** One checkout the machine's git already knows about. */
export interface ExistingWorktree {
  /** Absolute POSIX path of the checkout on that machine. */
  readonly path: string
  /** Name the checkout is shown under: its last path segment. */
  readonly name: string
  /** Branch the checkout sits on; empty when it is detached. */
  readonly branch: string
  /** Whether this plugin already holds it in the panel. */
  readonly registered: boolean
}

/** Best-effort workspace registration, so every caller behaves the same way. */
export interface WorkspaceHooks {
  /**
   * Record the anchor as a workspace.
   * @param anchor - the anchor just created.
   */
  register(anchor: AnchorRecord): Promise<void>
  /**
   * Drop the anchor's workspace registration.
   * @param anchor - the anchor just removed.
   */
  unregister(anchor: AnchorRecord): Promise<void>
  /**
   * Whether the anchor currently holds a workspace registration.
   * @param anchor - the anchor to ask about.
   */
  registered(anchor: AnchorRecord): Promise<boolean>
}

/** What the manager needs from its owner. */
export interface WorktreeManagerDeps {
  /** The anchor store that owns local identity. */
  readonly anchors: AnchorStore
  /**
   * The repository records. Cutting a worktree records the repository it came
   * from, because every surface groups worktrees by repository and a worktree
   * whose repository is missing is one nobody can see.
   */
  readonly repos: RepoStore
  /** Resolves the live channel for a node. */
  readonly channel: ChannelLookup
  /**
   * Whether one node id names this host rather than another machine.
   *
   * A local node reaches its own filesystem, so it takes the branch that reads
   * paths and runs git here instead of the branch that talks to a daemon. The
   * answer comes from the registry rather than from the channel lookup, because
   * "not connected" and "this host" are different states and only one of them
   * is a failure.
   */
  readonly isLocalNode: (nodeId: NodeId) => boolean
  /**
   * The directory managed checkouts live under on one machine.
   *
   * Resolved per node because a machine's home is its own: the default root is
   * that machine user's `~/.dsh/worktrees`, and a configured absolute path is
   * used verbatim. A checkout is placed at `<root>/<repository>/<name>`, never
   * inside the repository, so a worktree never makes its repository dirty.
   */
  readonly worktreeRoot: (nodeId: NodeId) => string
  /**
   * Workspace registration, when the deployment composes a registry. A failure
   * here never fails the git operation: the checkout and its anchor are durable
   * on their own, and the workspace entry is a convenience for opening it.
   */
  readonly workspace?: WorkspaceHooks
}

/** The worktree lifecycle. */
export interface WorktreeManager {
  /**
   * Cut a worktree on the node and record its anchor.
   * @param draft - node, repository, name, and optional base revision.
   * @returns the created worktree anchor.
   * @throws the daemon's typed failure when git refuses; no anchor is recorded.
   */
  create(draft: WorktreeDraft): Promise<WorktreeAnchor>
  /** Every managed worktree with its node's live state, in anchor order. */
  list(): Promise<readonly WorktreeStatus[]>
  /**
   * Every checkout the machine's git knows about for one repository.
   *
   * This is how a checkout cut by hand, or before this plugin existed, becomes
   * visible: git is the record on the machine, and the plugin only holds what
   * it was asked to hold. The repository's own checkout is left out.
   * @param ref - the machine and repository path.
   * @returns the checkouts in git's order, each marked when already held.
   */
  existing(ref: RepoRef): Promise<readonly ExistingWorktree[]>
  /**
   * Take an existing checkout under management, without touching git.
   *
   * The path must be one the machine's own git lists for that repository, so
   * nothing is adopted on a caller's word alone; the checkout itself stays
   * exactly where it is, and this host records an anchor and opens it as a
   * workspace. Adopting one this host already holds just opens it again.
   * @param ref - the machine and repository path.
   * @param path - absolute POSIX path of the checkout on that machine.
   * @returns the anchor that now holds it, registered as a workspace.
   * @throws when git does not list that path under that repository.
   */
  adopt(ref: RepoRef, path: string): Promise<WorktreeAnchor>
  /**
   * Stop managing one checkout, leaving it on the machine untouched.
   *
   * This is the counterpart of {@link adopt} and the reason it exists: a
   * checkout nobody asked this plugin to cut must never be deleted through it.
   * @param anchorId - the anchor handle.
   * @returns the anchor that was released.
   * @throws when no such anchor exists.
   */
  release(anchorId: AnchorId): Promise<AnchorRecord>
  /**
   * The worktrees cut under one repository.
   *
   * Answers the delete guard. For a machine it reads local records alone, so
   * the answer is the same whether or not the node is reachable; for this host
   * it asks git, because that is where a local checkout is recorded.
   * @param ref - the machine and repository path.
   * @returns the worktrees under that repository, in listing order.
   */
  anchorsIn(ref: RepoRef): Promise<readonly AnchorRecord[]>
  /**
   * Remove one worktree: the checkout on the node, then its anchor.
   * @param anchorId - the anchor handle.
   * @param options - `force` discards uncommitted changes; `deleteBranch`
   *   also deletes the branch.
   * @returns what was removed, and whether the branch followed.
   * @throws the daemon's typed failure when git refuses; the anchor stays.
   */
  remove(anchorId: AnchorId, options: { force: boolean; deleteBranch: boolean }): Promise<WorktreeRemoval>
  /**
   * Register the anchor as a workspace again, so it can be opened.
   *
   * Unlike creation, this is an explicit ask: a registry that is missing or
   * refuses fails the call rather than being swallowed.
   * @param anchorId - the anchor handle.
   * @returns the anchor that is now open.
   * @throws when no such anchor exists, or the workspace registry refuses.
   */
  open(anchorId: AnchorId): Promise<AnchorRecord>
  /**
   * Drop the anchor's workspace registration, leaving the machine untouched.
   * @param anchorId - the anchor handle.
   * @returns the anchor that is now closed.
   * @throws when no such anchor exists.
   */
  close(anchorId: AnchorId): Promise<AnchorRecord>
  /**
   * Open a repository directory as a workspace in its own right.
   *
   * Git is not consulted: a directory that is not a repository yet can still be
   * worked in, and the anchors of the worktrees cut from it later sit beside
   * this one. Idempotent — opening an open directory registers it again instead
   * of creating a second anchor.
   * @param ref - the machine and the directory's path on it.
   * @returns the directory anchor that is now open.
   * @throws when the machine is unreachable or no workspace registry is composed.
   */
  openDirectory(ref: RepoRef): Promise<DirectoryAnchor>
  /**
   * Close a repository directory's workspace and drop its anchor.
   *
   * Nothing on the machine is touched: the anchor is this host's bookkeeping,
   * so closing the workspace is what removes it.
   * @param ref - the machine and the directory's path on it.
   * @returns the anchor that was dropped, or undefined when none was open.
   */
  closeDirectory(ref: RepoRef): Promise<DirectoryAnchor | undefined>
}

/** The path a managed checkout is created at, on whichever machine owns it. */
function managedWorktreePath(root: string, repoPath: string, name: string): string {
  return posix.join(root, posix.basename(repoPath), name)
}

/** The branch a managed checkout is created on. */
function branchFor(name: string): string {
  return `${BRANCH_PREFIX}${name}`
}

/**
 * Whether this plugin cut one checkout itself.
 *
 * Managed checkouts sit under the configured worktree root; anything else was
 * found on the machine, and must only ever be released. A local root reached
 * through a symlink (`/var` on macOS is one) spells one directory two ways, and
 * git reports the resolved one, so the root is resolved before comparing.
 * @param deps - the manager's dependencies.
 * @param anchor - the anchor to judge.
 * @returns true when this plugin is the one that cut it.
 */
async function isManaged(deps: WorktreeManagerDeps, anchor: AnchorRecord): Promise<boolean> {
  if (anchor.kind !== 'worktree') return false
  // A record says which it is, wherever the checkout landed.
  if (anchor.origin !== undefined) return anchor.origin === 'created'
  // A local checkout has no record beyond git, so the root is the only clue,
  // and it is resolved because `/var` and `/private/var` are one directory.
  const root = deps.worktreeRoot(anchor.nodeId).replace(/\/+$/, '')
  const prefix = deps.isLocalNode(anchor.nodeId) ? await resolveLocalPath(root) : root
  return anchor.remoteRoot.startsWith(`${prefix}/`)
}

/**
 * Register an anchor as a workspace, best effort.
 * @param deps - the manager's dependencies.
 * @param anchor - the anchor to register as a workspace.
 */
async function registerWorkspace(deps: WorktreeManagerDeps, anchor: AnchorRecord): Promise<void> {
  try {
    await deps.workspace?.register(anchor)
  } catch {
    // The checkout and its anchor are durable on disk; a workspace entry is a
    // convenience, so a registry failure must not undo the work.
  }
}

/**
 * Drop an anchor's workspace registration.
 * @param deps - the manager's dependencies.
 * @param anchor - the anchor that was removed.
 */
async function unregisterWorkspace(deps: WorktreeManagerDeps, anchor: AnchorRecord): Promise<void> {
  try {
    await deps.workspace?.unregister(anchor)
  } catch {
    // A stale registration is harmless; the workspace path no longer resolves.
  }
}

/**
 * Prefix that marks an id as naming a path on this host.
 *
 * A machine's ids come from the anchor store and are generated once. This host
 * has no such store, so its ids are derived from what they name and stay opaque
 * to every caller: nothing outside this module reads more than this prefix.
 */
const LOCAL_ID_PREFIX = 'local:'

/** The id one local path is addressed by. */
function localAnchorId(kind: 'worktree' | 'directory', path: string, repoPath: string): AnchorId {
  return asAnchorId(kind === 'directory'
    ? `${LOCAL_ID_PREFIX}directory:${encodePart(path)}`
    : `${LOCAL_ID_PREFIX}worktree:${encodePart(path)}:${encodePart(repoPath)}`)
}

/** Prefix that marks an id as naming a checkout git reports on a machine. */
const REMOTE_ID_PREFIX = 'remote:'

/** One URL-safe encoding of a value, for composing a derived id. */
const encodePart = (value: string): string => Buffer.from(value, 'utf8').toString('base64url')

/** The inverse of {@link encodePart}. */
const decodePart = (value: string): string => Buffer.from(value, 'base64url').toString('utf8')

/** The id one machine's git-reported checkout is addressed by before it is held. */
function remoteAnchorId(nodeId: NodeId, repoPath: string, path: string): AnchorId {
  return asAnchorId(`${REMOTE_ID_PREFIX}${encodePart(nodeId)}:${encodePart(repoPath)}:${encodePart(path)}`)
}

/** The coordinates a git-reported id carries, or undefined for any other id. */
function parseRemoteAnchorId(value: string): { nodeId: NodeId; repoPath: string; path: string } | undefined {
  if (!value.startsWith(REMOTE_ID_PREFIX)) return undefined
  const [node, repo, path] = value.slice(REMOTE_ID_PREFIX.length).split(':')
  if (node === undefined || repo === undefined || path === undefined) return undefined
  return { nodeId: asNodeId(decodePart(node)), repoPath: decodePart(repo), path: decodePart(path) }
}

/**
 * The record a git-reported checkout is shown as before this plugin holds it.
 *
 * The id is derived from the checkout's coordinates rather than minted, so the
 * same git worktree lists under the same id on every read; `anchorPath` is a
 * placeholder until an open adopts it and mints the real local directory.
 */
function remotePlaceholder(
  nodeId: NodeId,
  repoPath: string,
  path: string,
  branch: string,
  createdAt: string,
): WorktreeAnchor {
  return {
    anchorId: remoteAnchorId(nodeId, repoPath, path),
    nodeId,
    kind: 'worktree',
    name: posix.basename(path) || path,
    repoPath,
    anchorPath: path,
    remoteRoot: path,
    branch,
    origin: 'adopted',
    createdAt,
  }
}

/** The row a local repository itself is opened through. */
function localDirectoryAnchor(record: RepoRecord): DirectoryAnchor {
  const name = posix.basename(record.repoPath) || record.repoPath
  return {
    anchorId: localAnchorId('directory', record.repoPath, record.repoPath),
    nodeId: record.nodeId,
    kind: 'directory',
    name,
    repoPath: record.repoPath,
    // A local directory maps onto itself: the checkout and the workspace path
    // are the same path, which is what makes routing unnecessary here.
    anchorPath: record.repoPath,
    remoteRoot: record.repoPath,
    createdAt: record.createdAt,
  }
}

/**
 * One row's live state, degrading a read failure to the row's own error.
 *
 * A workspace registry that refuses one anchor, or a machine that cannot answer
 * about it, must not blank every other row: the failure belongs to the row.
 * @param deps - the manager's dependencies.
 * @param anchor - the row to describe.
 * @param offlineError - the reason to report when the node is not connected.
 * @returns the status, carrying `error` when the state could not be read.
 */
async function rowStatus(
  deps: WorktreeManagerDeps,
  anchor: AnchorRecord,
  offlineError?: string,
): Promise<WorktreeStatus> {
  try {
    const open = await deps.workspace?.registered(anchor) ?? false
    const managed = await isManaged(deps, anchor)
    return { anchor, open, managed, held: true, ...offlineError === undefined ? {} : { error: offlineError } }
  } catch (error) {
    return { anchor, open: false, managed: false, held: true, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Every checkout and repository directory this host manages.
 *
 * A machine's rows come from its anchors. This host has none, so they come from
 * git, which is where a local checkout actually lives — including one cut by
 * hand, outside the panel, which is then just as visible and openable as the
 * ones the panel made. The repository's own worktree is the row that opens the
 * repository directory itself.
 * @param deps - the manager's dependencies.
 * @returns the rows, the local repository records in their stored order.
 */
async function localStatuses(deps: WorktreeManagerDeps): Promise<readonly WorktreeStatus[]> {
  const statuses: WorktreeStatus[] = []
  for (const repo of deps.repos.list()) {
    if (!deps.isLocalNode(repo.nodeId)) continue
    const directory = localDirectoryAnchor(repo)
    statuses.push(await rowStatus(deps, directory))
    // A directory that is not a repository yet is a legitimate record: it can be
    // opened as a workspace and initialized later, so git is asked every time.
    if (!await isRepository(repo.repoPath).catch(() => false)) continue
    const checkouts = await listWorktrees(repo.repoPath).catch(() => [])
    for (const checkout of checkouts.slice(1)) {
      // A checkout whose directory is gone is git's own leftover rather than a
      // row: nothing can be opened or removed through it. An unreadable one is
      // skipped the same way, so one bad checkout cannot blank the others.
      if (await localPathType(checkout.path).catch(() => undefined) !== 'directory') continue
      const anchor: WorktreeAnchor = {
        anchorId: localAnchorId('worktree', checkout.path, repo.repoPath),
        nodeId: repo.nodeId,
        kind: 'worktree',
        name: posix.basename(checkout.path) || checkout.path,
        repoPath: repo.repoPath,
        anchorPath: checkout.path,
        remoteRoot: checkout.path,
        // A detached checkout has no branch to name, and an empty one is what
        // every surface already renders as silence.
        branch: checkout.branch ?? '',
        createdAt: repo.createdAt,
      }
      statuses.push(await rowStatus(deps, anchor))
    }
  }
  return statuses
}

/** Register a repository nobody has registered yet, keeping a known name. */
async function registerRepoIfUnknown(
  deps: WorktreeManagerDeps,
  nodeId: NodeId,
  repoPath: string,
): Promise<void> {
  if (deps.repos.find({ nodeId, repoPath }) === undefined) {
    await deps.repos.upsert({ nodeId, repoPath })
  }
}

/** Narrow a record to a worktree, refusing the repository directory. */
function requireWorktree(anchor: AnchorRecord): WorktreeAnchor {
  if (anchor.kind !== 'worktree') {
    throw new Error(`"${anchor.name}" is the repository directory, not a worktree; close it instead`)
  }
  return anchor
}

/** The directory anchor one machine path is held under, if this host holds one. */
function directoryAnchorOf(deps: WorktreeManagerDeps, ref: RepoRef): DirectoryAnchor | undefined {
  return deps.anchors.list().find(
    (anchor): anchor is DirectoryAnchor =>
      anchor.kind === 'directory' && anchor.nodeId === ref.nodeId && anchor.repoPath === ref.repoPath,
  )
}

/** One local row by the id a caller holds, or undefined when none carries it. */
async function localEntry(
  deps: WorktreeManagerDeps,
  anchorId: AnchorId,
): Promise<AnchorRecord | undefined> {
  const statuses = await localStatuses(deps)
  return statuses.find(status => status.anchor.anchorId === anchorId)?.anchor
}

/**
 * Cut a worktree on this host and register its checkout.
 * @param deps - the manager's dependencies.
 * @param draft - node, repository, name, and optional base revision.
 * @returns the created checkout's record.
 */
async function createLocalWorktree(deps: WorktreeManagerDeps, draft: WorktreeDraft): Promise<WorktreeAnchor> {
  // One spelling of the repository, settled before anything is written: it is
  // what the checkout, the record, and the panel's tree carry, so a later
  // lookup by path finds the same directory the caller meant.
  const repoPath = await resolveLocalPath(draft.repoPath)
  if (!await isRepository(repoPath)) {
    throw new Error(`"${repoPath}" is not a git repository on this machine`)
  }
  const branch = branchFor(draft.name)
  const plannedPath = draft.path ?? managedWorktreePath(deps.worktreeRoot(draft.nodeId), repoPath, draft.name)
  await addWorktree({
    repoPath,
    worktreePath: plannedPath,
    branch,
    ...draft.baseRef === undefined ? {} : { baseRef: draft.baseRef },
  })
  // Git records the checkout under its resolved spelling, and the listing that
  // later finds this anchor is built from what git reports. A root reached
  // through a symlink (`/var` on macOS is one) would otherwise leave the record
  // and the listing naming one directory two ways.
  const worktreePath = await resolveLocalPath(plannedPath)

  const anchor: WorktreeAnchor = {
    anchorId: localAnchorId('worktree', worktreePath, repoPath),
    nodeId: draft.nodeId,
    kind: 'worktree',
    name: draft.name,
    repoPath,
    anchorPath: worktreePath,
    remoteRoot: worktreePath,
    branch,
    createdAt: new Date().toISOString(),
  }
  await registerRepoIfUnknown(deps, draft.nodeId, repoPath)
  await registerWorkspace(deps, anchor)
  return anchor
}

/**
 * Remove one checkout on this host, leaving its branch.
 * @param deps - the manager's dependencies.
 * @param anchor - the checkout's record.
 * @param options - `force` discards uncommitted changes; `deleteBranch` also
 *   deletes the branch.
 * @returns what was removed, and whether the branch followed.
 */
async function removeLocalWorktree(
  deps: WorktreeManagerDeps,
  anchor: WorktreeAnchor,
  options: { force: boolean; deleteBranch: boolean },
): Promise<WorktreeRemoval> {
  await removeWorktree({
    repoPath: anchor.repoPath,
    worktreePath: anchor.anchorPath,
    force: options.force,
  })
  // The workspace entry resolves by path, so it goes before the path stops
  // existing under its feet.
  await unregisterWorkspace(deps, anchor)
  return await dropBranchOrReport(anchor, options, () =>
    deleteBranch({ repoPath: anchor.repoPath, branch: anchor.branch, force: options.force }))
}

/**
 * Open a freshly registered anchor, leaving nothing behind when that is refused.
 *
 * An anchor with nothing open behind it is a row nobody asked for, and a path
 * that routes into a directory nobody asked to open.
 * @param deps - the manager's dependencies.
 * @param anchor - the anchor that was just created.
 * @param open - how this kind of anchor is opened.
 * @throws whatever `open` threw, after the anchor is removed.
 */
async function openOrDrop(
  deps: WorktreeManagerDeps,
  anchor: AnchorRecord,
  open: () => Promise<unknown>,
): Promise<void> {
  try {
    await open()
  } catch (error) {
    await deps.anchors.remove(anchor.anchorId)
    throw error
  }
}

/**
 * Delete a removed checkout's branch, reporting a refusal instead of failing.
 *
 * The checkout is already gone, so a branch that would not go is reported
 * rather than thrown: the caller shows why it outlived its worktree.
 * @param anchor - the worktree whose branch is in question.
 * @param options - whether to delete the branch, and how hard.
 * @param remove - the deletion itself, local or over the wire.
 * @returns the removal, with the branch's fate.
 */
async function dropBranchOrReport(
  anchor: WorktreeAnchor,
  options: { force: boolean; deleteBranch: boolean },
  remove: () => Promise<unknown>,
): Promise<WorktreeRemoval> {
  if (!options.deleteBranch) return { anchor, branchDeleted: false }
  try {
    await remove()
    return { anchor, branchDeleted: true }
  } catch (error) {
    return {
      anchor,
      branchDeleted: false,
      branchError: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Register one path as a workspace, so a session can be opened on it.
 * @param deps - the manager's dependencies.
 * @param anchor - the worktree or directory to open.
 * @returns the anchor that is now open.
 * @throws when the deployment composes no workspace registry, or it refuses.
 */
async function openAsWorkspace<T extends AnchorRecord>(
  deps: WorktreeManagerDeps,
  anchor: T,
): Promise<T> {
  const workspace = deps.workspace
  if (workspace === undefined) {
    throw new Error('this deployment composes no workspace registry, so a worktree cannot be opened')
  }
  await workspace.register(anchor)
  return anchor
}

/**
 * Build the worktree manager.
 * @param deps - the anchor store, the repository records, and the node lookups.
 * @returns the lifecycle handle.
 */
export function createWorktreeManager(deps: WorktreeManagerDeps): WorktreeManager {
  /** The live channel for an anchor's node, or the typed offline failure. */
  const channelFor = (nodeId: NodeId) => {
    const channel = deps.channel(nodeId)
    if (channel === undefined) {
      throw new NodeRequestError({
        code: 'GIT_COMMAND_FAILED',
        message: `remote node "${nodeId}" is not connected`,
      })
    }
    return channel
  }

  /** The machine's own checkouts for one repository, minus its main one. */
  const listExisting = async (ref: RepoRef): Promise<readonly ExistingWorktree[]> => {
    if (deps.isLocalNode(ref.nodeId)) {
      const checkouts = await listWorktrees(ref.repoPath).catch(() => [])
      // Every local checkout is a row already: the panel reads them from git.
      return checkouts.slice(1).map(checkout => ({
        path: checkout.path,
        name: posix.basename(checkout.path) || checkout.path,
        branch: checkout.branch ?? '',
        registered: true,
      }))
    }
    const channel = channelFor(ref.nodeId)
    const { canonicalPath } = await channel.request('fs.resolve', { path: ref.repoPath })
    const listed = await channel.request('git.worktreeList', { repoPath: canonicalPath })
    const held = deps.anchors.list()
    return listed
      .filter(entry => !entry.main)
      .map(entry => ({
        path: entry.path,
        name: posix.basename(entry.path) || entry.path,
        branch: entry.branch ?? '',
        registered: held.some(anchor => anchor.nodeId === ref.nodeId && anchor.remoteRoot === entry.path),
      }))
  }

  /** The held anchor for one git-reported checkout, if this plugin already holds it. */
  const heldRemote = (discovered: { nodeId: NodeId; repoPath: string; path: string }): WorktreeAnchor | undefined =>
    deps.anchors.list().find(
      (anchor): anchor is WorktreeAnchor =>
        anchor.kind === 'worktree'
        && anchor.nodeId === discovered.nodeId
        && anchor.repoPath === discovered.repoPath
        && anchor.remoteRoot === discovered.path,
    )

  /** Open a remote checkout git already lists, adopting it when it is new. */
  const adoptRemote = async (ref: RepoRef, path: string): Promise<WorktreeAnchor> => {
    const listed = await listExisting(ref)
    const entry = listed.find(candidate => candidate.path === path)
    if (entry === undefined) {
      throw new Error(`"${path}" is not a worktree of "${ref.repoPath}" on that machine`)
    }
    const held = heldRemote({ nodeId: ref.nodeId, repoPath: ref.repoPath, path })
    if (held !== undefined) return await openAsWorkspace(deps, held)

    const anchor = await deps.anchors.create({
      kind: 'worktree',
      nodeId: ref.nodeId,
      name: posix.basename(path) || path,
      repoPath: ref.repoPath,
      remoteRoot: path,
      branch: entry.branch,
      origin: 'adopted',
    })
    await openOrDrop(deps, anchor, () => openAsWorkspace(deps, anchor))
    return { ...anchor, kind: 'worktree', branch: entry.branch }
  }

  /** Remove one held remote checkout, dropping its record with the checkout. */
  const removeRemote = async (
    anchor: WorktreeAnchor,
    options: { force: boolean; deleteBranch: boolean },
  ): Promise<WorktreeRemoval> => {
    const channel = channelFor(anchor.nodeId)
    await channel.request('git.worktreeRemove', {
      repoPath: anchor.repoPath,
      worktreePath: anchor.remoteRoot,
      force: options.force,
    })
    // The checkout is gone, so the local handle must go with it — but the
    // workspace registry resolves an entry by path, which stops resolving the
    // moment the anchor directory is removed, so that goes first.
    await unregisterWorkspace(deps, anchor)
    await deps.anchors.remove(anchor.anchorId)
    return await dropBranchOrReport(anchor, options, () =>
      channel.request('git.branchDelete', {
        repoPath: anchor.repoPath,
        branch: anchor.branch,
        force: options.force,
      }))
  }

  /** Remove a checkout git reports but this plugin never adopted. */
  const removeDiscovered = async (
    discovered: { nodeId: NodeId; repoPath: string; path: string },
    options: { force: boolean; deleteBranch: boolean },
  ): Promise<WorktreeRemoval> => {
    const ref = { nodeId: discovered.nodeId, repoPath: discovered.repoPath }
    const entry = (await listExisting(ref)).find(candidate => candidate.path === discovered.path)
    if (entry === undefined) {
      throw new Error(`"${discovered.path}" is not a worktree of "${discovered.repoPath}" on that machine`)
    }
    const channel = channelFor(discovered.nodeId)
    await channel.request('git.worktreeRemove', {
      repoPath: discovered.repoPath,
      worktreePath: discovered.path,
      force: options.force,
    })
    const anchor = remotePlaceholder(
      discovered.nodeId,
      discovered.repoPath,
      discovered.path,
      entry.branch,
      new Date().toISOString(),
    )
    // A detached checkout has no branch to delete, and git is asked for one
    // only when there is one.
    if (!options.deleteBranch || entry.branch === '') return { anchor, branchDeleted: false }
    return await dropBranchOrReport(anchor, options, () =>
      channel.request('git.branchDelete', {
        repoPath: discovered.repoPath,
        branch: entry.branch,
        force: options.force,
      }))
  }

  /**
   * Rows for every checkout git reports on a machine that this plugin does not
   * hold yet, so the panel reads worktrees from git rather than from records a
   * person had to create by hand. A repository whose git cannot be read is
   * skipped, because one broken repository must not blank the others.
   */
  const discoveredRemote = async (held: ReadonlySet<string>): Promise<readonly WorktreeStatus[]> => {
    const statuses: WorktreeStatus[] = []
    for (const repo of deps.repos.list()) {
      if (deps.isLocalNode(repo.nodeId) || deps.channel(repo.nodeId) === undefined) continue
      try {
        for (const checkout of await listExisting(repo)) {
          if (held.has(`${repo.nodeId}\u0000${checkout.path}`)) continue
          statuses.push({
            anchor: remotePlaceholder(repo.nodeId, repo.repoPath, checkout.path, checkout.branch, repo.createdAt),
            open: false,
            held: false,
            managed: false,
          })
        }
      } catch {
        // This repository's git is quiet; the held anchors still show.
      }
    }
    return statuses
  }

  /** The anchor a caller's id names, wherever it is recorded. */
  const entryById = async (anchorId: AnchorId): Promise<AnchorRecord | undefined> =>
    anchorId.startsWith(LOCAL_ID_PREFIX) ? await localEntry(deps, anchorId) : deps.anchors.get(anchorId)

  return {
    async create(draft) {
      if (deps.isLocalNode(draft.nodeId)) return await createLocalWorktree(deps, draft)
      const channel = channelFor(draft.nodeId)
      // One spelling of the repository, settled before anything is written: it
      // is what the worktree path, the anchor, and the repository record carry,
      // so a later lookup by path — the removal guard, the section's tree —
      // finds the same directory the caller meant.
      const { canonicalPath: repoPath } = await channel.request('fs.resolve', { path: draft.repoPath })
      const branch = branchFor(draft.name)
      const worktreePath = draft.path ?? managedWorktreePath(deps.worktreeRoot(draft.nodeId), repoPath, draft.name)
      const worktree: WireWorktree = await channel.request('git.worktreeAdd', {
        repoPath,
        worktreePath,
        branch,
        ...draft.baseRef === undefined ? {} : { baseRef: draft.baseRef },
      })

      // The daemon reports where the checkout actually landed and which branch
      // it settled on, which are the facts every later call must use.
      const checkedOut = worktree.branch ?? branch
      const anchor = await deps.anchors.create({
        kind: 'worktree',
        nodeId: draft.nodeId,
        name: draft.name,
        repoPath,
        remoteRoot: worktree.path,
        branch: checkedOut,
        origin: 'created',
      })
      await registerRepoIfUnknown(deps, draft.nodeId, repoPath)
      await registerWorkspace(deps, anchor)
      return { ...anchor, kind: 'worktree', branch: checkedOut }
    },

    async list() {
      // The local machine leads the list, as it leads the machine list: its
      // rows are read here rather than asked of anything.
      const statuses: WorktreeStatus[] = [...await localStatuses(deps)]
      const held = new Set<string>()
      for (const anchor of deps.anchors.list()) {
        // Listing is a local read. The branch a checkout sits on and whether it
        // is dirty belong to the machine's own git, so the only thing worth
        // reporting here is whether the worktree can be reached at all. One
        // anchor that cannot be read becomes its own error, never the list's.
        const offline = deps.channel(anchor.nodeId) === undefined
          ? `node "${anchor.nodeId}" is not connected`
          : undefined
        statuses.push(await rowStatus(deps, anchor, offline))
        if (anchor.kind === 'worktree') held.add(`${anchor.nodeId}\u0000${anchor.remoteRoot}`)
      }
      // A machine's git is the second source: a checkout nobody adopted yet
      // shows as a row too, so the panel never waits on records made by hand.
      statuses.push(...await discoveredRemote(held))
      return statuses
    },

    existing: listExisting,

    async adopt(ref, path) {
      if (deps.isLocalNode(ref.nodeId)) {
        const listed = await listExisting(ref)
        if (!listed.some(candidate => candidate.path === path)) {
          throw new Error(`"${path}" is not a worktree of "${ref.repoPath}" on that machine`)
        }
        // A local checkout is already a row here; adopting it only opens it.
        const local = (await localStatuses(deps)).find(status =>
          status.anchor.nodeId === ref.nodeId && status.anchor.anchorPath === path)?.anchor
        if (local === undefined || local.kind !== 'worktree') {
          throw new Error(`no local checkout "${path}"`)
        }
        return await openAsWorkspace(deps, local)
      }
      return await adoptRemote(ref, path)
    },

    async anchorsIn(ref) {
      if (deps.isLocalNode(ref.nodeId)) {
        return (await localStatuses(deps))
          .filter(status => status.anchor.repoPath === ref.repoPath)
          .map(status => status.anchor)
      }
      return deps.anchors.list()
        .filter(anchor => anchor.nodeId === ref.nodeId && anchor.repoPath === ref.repoPath)
    },

    async remove(anchorId, options) {
      if (anchorId.startsWith(LOCAL_ID_PREFIX)) {
        const anchor = await localEntry(deps, anchorId)
        if (anchor === undefined) throw new Error(`no worktree "${anchorId}" on this machine`)
        return await removeLocalWorktree(deps, requireWorktree(anchor), options)
      }
      const discovered = parseRemoteAnchorId(anchorId)
      if (discovered !== undefined) {
        const held = heldRemote(discovered)
        return held === undefined ? await removeDiscovered(discovered, options) : await removeRemote(held, options)
      }
      const anchor = deps.anchors.get(anchorId)
      if (anchor === undefined) throw new Error(`no anchor "${anchorId}"`)
      return await removeRemote(requireWorktree(anchor), options)
    },

    async open(anchorId) {
      const discovered = parseRemoteAnchorId(anchorId)
      if (discovered !== undefined) {
        return await adoptRemote({ nodeId: discovered.nodeId, repoPath: discovered.repoPath }, discovered.path)
      }
      const anchor = await entryById(anchorId)
      if (anchor === undefined) throw new Error(`no worktree "${anchorId}" on this machine`)
      return await openAsWorkspace(deps, anchor)
    },

    async close(anchorId) {
      const discovered = parseRemoteAnchorId(anchorId)
      if (discovered !== undefined) {
        const held = heldRemote(discovered)
        if (held === undefined) throw new Error(`no worktree "${anchorId}" on this machine`)
        await deps.workspace?.unregister(held)
        return held
      }
      const anchor = await entryById(anchorId)
      if (anchor === undefined) throw new Error(`no worktree "${anchorId}" on this machine`)
      await deps.workspace?.unregister(anchor)
      return anchor
    },

    async release(anchorId) {
      const discovered = parseRemoteAnchorId(anchorId)
      if (discovered !== undefined) {
        const held = heldRemote(discovered)
        if (held === undefined) throw new Error(`no worktree "${anchorId}" on this machine`)
        await deps.workspace?.unregister(held)
        await deps.anchors.remove(held.anchorId)
        return held
      }
      const anchor = await entryById(anchorId)
      if (anchor === undefined) throw new Error(`no worktree "${anchorId}" on this machine`)
      // Only this host's bookkeeping goes: a local checkout has no record beyond
      // its registration, and a machine's checkout is not ours to delete.
      await deps.workspace?.unregister(anchor)
      if (!anchorId.startsWith(LOCAL_ID_PREFIX)) await deps.anchors.remove(anchorId)
      return anchor
    },

    async openDirectory(ref) {
      const workspace = deps.workspace
      if (workspace === undefined) {
        throw new Error('this deployment composes no workspace registry, so a directory cannot be opened')
      }
      if (deps.isLocalNode(ref.nodeId)) {
        const record = deps.repos.find(ref)
        if (record === undefined) throw new Error(`no repository record for "${ref.repoPath}"`)
        return await openAsWorkspace(deps, localDirectoryAnchor(record))
      }
      const existing = directoryAnchorOf(deps, ref)
      if (existing !== undefined) {
        await workspace.register(existing)
        return existing
      }

      const channel = channelFor(ref.nodeId)
      const { canonicalPath: repoPath } = await channel.request('fs.resolve', { path: ref.repoPath })
      const anchor = await deps.anchors.create({
        kind: 'directory',
        nodeId: ref.nodeId,
        name: posix.basename(repoPath) || repoPath,
        repoPath,
        // A directory anchor maps the directory onto itself: there is no
        // checkout to distinguish, so the two spellings are one path.
        remoteRoot: repoPath,
      })
      await openOrDrop(deps, anchor, () => workspace.register(anchor))
      return { ...anchor, kind: 'directory' }
    },

    async closeDirectory(ref) {
      if (deps.isLocalNode(ref.nodeId)) {
        const record = deps.repos.find(ref)
        if (record === undefined) return undefined
        const anchor = localDirectoryAnchor(record)
        // Closing is the registration going away; a local directory has no
        // record of its own to drop, so an unregistered one is already closed.
        const open = await deps.workspace?.registered(anchor) ?? false
        if (!open) return undefined
        await unregisterWorkspace(deps, anchor)
        return anchor
      }
      const anchor = directoryAnchorOf(deps, ref)
      if (anchor === undefined) return undefined
      // The registration resolves by path, which stops resolving once the
      // anchor directory is gone, so it goes first.
      await unregisterWorkspace(deps, anchor)
      await deps.anchors.remove(anchor.anchorId)
      return anchor
    },
  }
}

/** What a workspace label is composed from. */
export interface WorkspaceLabelParts {
  /** The machine's display title, falling back to its host. */
  readonly machine: string
  /** Absolute POSIX path of the repository on that machine. */
  readonly repoPath: string
  /** The repository's display name, when a record supplies one. */
  readonly repoName?: string | undefined
  /** The checkout's name; absent when the workspace is the directory itself. */
  readonly name?: string | undefined
}

/** Separator between the three parts. */
const SEPARATOR = ' · '

/**
 * Build the display title a remote directory gets as a local workspace.
 *
 * A workspace title is read by a person scanning a sidebar, so it names the
 * things that distinguish one from another — which checkout, which repository,
 * and which machine — and never the opaque ids this plugin routes by. The
 * checkout leads because it is what the person chose and what they are looking
 * for; the machine trails because it is the context they already know. A
 * directory opened as itself has no checkout to name, so its title begins at
 * the repository. An unnamed repository falls back to its last path segment,
 * which is what a user would have called it; a path with no segment at all
 * falls back to the whole path so the label is never blank.
 * @param parts - the machine, repository, and checkout names.
 * @returns the composed title.
 */
export function workspaceLabel(parts: WorkspaceLabelParts): string {
  const base = posix.basename(parts.repoPath)
  const repo = parts.repoName?.trim()
    || (base === '' || base === '/' ? parts.repoPath : base)
  const segments = parts.name === undefined ? [repo, parts.machine] : [parts.name, repo, parts.machine]
  return segments.join(SEPARATOR)
}
