/**
 * Git on this host, for the local machine's management operations.
 *
 * These are the same five answers the daemon gives over the wire —
 * `git.repoState`, `git.worktreeList`, `git.worktreeAdd`, `git.worktreeRemove`,
 * `git.branchDelete` — asked of the git binary in this process instead of over
 * a connection. That is the whole difference between a local machine and a
 * remote one: the same lifecycle, run where the checkout is.
 *
 * `GIT_OPTIONAL_LOCKS=0` is set on every command because the panel polls: a
 * `git status` that refreshes the index takes the lock a session's own `git`
 * command may be holding, and the answer it wanted never needed the lock.
 *
 * @module dsh-remote-workspace/local/git
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Everything one git invocation is allowed to buffer. */
const MAX_BUFFER = 8 << 20

/** Why a git command failed. */
type LocalGitCode = 'GIT_NOT_A_REPOSITORY' | 'GIT_COMMAND_FAILED'

/** A git failure, carrying the same discriminant the daemon's errors carry. */
class LocalGitError extends Error {
  /** Which kind of failure this is. */
  readonly code: LocalGitCode

  /**
   * @param code - the failure's kind.
   * @param message - what git said.
   */
  constructor(code: LocalGitCode, message: string) {
    super(message)
    this.name = 'LocalGitError'
    this.code = code
  }
}

/** One checkout git knows about, as `git worktree list` reports it. */
export interface LocalWorktree {
  /** Absolute path of the checkout. */
  readonly path: string
  /** Short branch name, or null when the entry is detached or bare. */
  readonly branch: string | null
  /** Whether this is the repository's main worktree. */
  readonly main: boolean
}

/** How git spells a directory it does not consider a repository. */
const NOT_A_REPOSITORY = /not a git repository/i

/**
 * Run one git command in a repository.
 * @param repoPath - the directory git runs in.
 * @param args - the arguments after `-C <repoPath>`.
 * @returns git's standard output.
 * @throws LocalGitError, distinguishing "not a repository" from every other failure.
 */
async function git(repoPath: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', repoPath, ...args], {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      maxBuffer: MAX_BUFFER,
    })
    return stdout
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim()
    const message = stderr === '' ? String(error instanceof Error ? error.message : error) : stderr
    throw new LocalGitError(
      NOT_A_REPOSITORY.test(message) ? 'GIT_NOT_A_REPOSITORY' : 'GIT_COMMAND_FAILED',
      message,
    )
  }
}

/**
 * Whether git owns a directory.
 * @param repoPath - the directory to ask about.
 * @returns true when the directory is inside a work tree.
 * @throws LocalGitError when git could not be asked at all.
 */
export async function isRepository(repoPath: string): Promise<boolean> {
  try {
    const inside = await git(repoPath, ['rev-parse', '--is-inside-work-tree'])
    return inside.trim() === 'true'
  } catch (error) {
    if (error instanceof LocalGitError && error.code === 'GIT_NOT_A_REPOSITORY') return false
    throw error
  }
}

/**
 * Every checkout git knows for a repository.
 * @param repoPath - the repository to ask.
 * @returns the entries in git's own order, the main worktree first.
 * @throws LocalGitError when the directory is not a repository.
 */
export async function listWorktrees(repoPath: string): Promise<readonly LocalWorktree[]> {
  const porcelain = await git(repoPath, ['worktree', 'list', '--porcelain'])
  const found: LocalWorktree[] = []
  for (const block of porcelain.split('\n\n')) {
    const lines = block.split('\n').filter(line => line !== '')
    const path = lines.find(line => line.startsWith('worktree '))?.slice('worktree '.length)
    if (path === undefined) continue
    const ref = lines.find(line => line.startsWith('branch '))?.slice('branch '.length)
    found.push({
      path,
      // A detached entry has no `branch` line; a bare one has no work tree.
      branch: ref === undefined ? null : ref.replace(/^refs\/heads\//, ''),
      main: found.length === 0,
    })
  }
  return found
}

/**
 * Cut a worktree and its branch.
 * @param options - the repository, the checkout path, and the branch to create.
 * @throws LocalGitError when git refuses.
 */
export async function addWorktree(options: {
  readonly repoPath: string
  readonly worktreePath: string
  readonly branch: string
  readonly baseRef?: string
}): Promise<void> {
  await git(options.repoPath, [
    'worktree', 'add', '-b', options.branch, options.worktreePath,
    ...options.baseRef === undefined ? [] : [options.baseRef],
  ])
}

/**
 * Remove one checkout, leaving its branch.
 * @param options - the repository, the checkout, and whether to discard changes.
 * @throws LocalGitError when git refuses.
 */
export async function removeWorktree(options: {
  readonly repoPath: string
  readonly worktreePath: string
  readonly force: boolean
}): Promise<void> {
  await git(options.repoPath, [
    'worktree', 'remove', ...options.force ? ['--force'] : [], options.worktreePath,
  ])
}

/**
 * Delete one branch.
 * @param options - the repository, the branch, and whether an unmerged branch goes too.
 * @throws LocalGitError when git refuses.
 */
export async function deleteBranch(options: {
  readonly repoPath: string
  readonly branch: string
  readonly force: boolean
}): Promise<void> {
  await git(options.repoPath, ['branch', options.force ? '-D' : '-d', options.branch])
}
