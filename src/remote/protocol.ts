/**
 * The wire contract between this plugin and the `dsh-remote-agent` daemon
 * running on a remote machine.
 *
 * This is the plugin's half of the contract, and the half its own code is
 * typed against. The daemon is a Rust program with its own copy of the same
 * shapes (`agent/src/protocol.rs` and `agent/src/wire.rs`); the two are
 * maintained by hand, so a change here is a change there. What holds them
 * together is behavioural rather than structural: `tests/e2e/protocol.test.ts`
 * calls every method below against the shipped binary and fails when one of
 * them moves.
 *
 * Transport is JSON-RPC 2.0 over a byte stream framed with a `Content-Length`
 * header block. Binary payloads travel base64-encoded; every other field is
 * plain JSON.
 *
 * **Target identity is the canonical absolute path.** Every mutating and
 * reading method addresses a file by the `canonicalPath` a previous call
 * returned, which is realpath-normalized by the daemon. The plugin composes its
 * own opaque key from the node id plus that path, so containment, process
 * paths, and file URLs are derived locally without another round trip.
 *
 * @module dsh-remote-workspace/remote/protocol
 */

/**
 * Protocol revision. A breaking change to any method name, parameter, or
 * result bumps this, and the daemon refuses a mismatched handshake instead of
 * degrading.
 */
export const PROTOCOL_VERSION = 1

/** Prefix every composite target key the plugin mints carries. */
export const TARGET_KEY_PREFIX = 'node:'

/** A byte payload, base64-encoded so it survives a JSON text line unchanged. */
export interface WireBytes {
  readonly data: string
}

/** Whether a target is a regular file, a directory, or something else. */
export type WireFileType = 'file' | 'directory' | 'other'

/** Whether a path entry is a regular file, a directory, a symlink, or something else. */
export type WirePathType = 'file' | 'directory' | 'symlink' | 'other'

/** Metadata about a resolved target. `version` is opaque to the plugin. */
export interface WireStat {
  readonly version: string
  readonly type: WireFileType
  readonly size?: number
}

/** Metadata about a path entry without following a final symlink. */
export interface WireLstat {
  readonly version: string
  readonly type: WirePathType
  readonly size?: number
}

/** A path resolved by the daemon into its canonical absolute form. */
export interface WireTarget {
  /** Realpath-normalized absolute path in the daemon's filesystem. */
  readonly canonicalPath: string
}

/** One direct child of a listed directory. */
export interface WireDirEntry {
  readonly name: string
  readonly type: WireFileType
  readonly target: WireTarget
  readonly version?: string
  readonly size?: number
}

/** Guarded write intent; omitted means unconditional create-or-overwrite. */
export interface WireWriteIntent {
  readonly kind: 'createIfAbsent' | 'replaceIfVersion'
  /** Present iff `kind` is `replaceIfVersion`. */
  readonly version?: string
}

/** Outcome of a whole-file write. */
export interface WireWriteOutcome {
  readonly operation: 'create' | 'update'
  readonly version: string
  readonly before: string | null
  readonly after: string
}

/** A literal-replacement edit request. */
export interface WireEditRequest {
  readonly oldString: string
  readonly newString: string
  readonly replaceAll: boolean
}

/** Outcome of a literal edit. */
export interface WireEditOutcome {
  readonly version: string
  readonly before: string
  readonly after: string
}

/**
 * One decoded text window. The daemon owns cross-chunk UTF-8 decoding and
 * binary rejection, so a caller never sees a split code point or a raw byte.
 */
export interface WireTextChunk {
  readonly text: string
  /** Whole-file offset to resume from on the next read. */
  readonly nextOffset: number
  /** True when the window reached the end of the file. */
  readonly eof: boolean
}

/**
 * Stable filesystem failure codes. These mirror the filesystem seam's typed
 * codes so the plugin can rethrow the same code it would have raised locally.
 */
export type WireFsErrorCode =
  | 'FS_NOT_FOUND'
  | 'FS_NOT_DIRECTORY'
  | 'FS_NOT_TEXT'
  | 'FS_NOT_REGULAR_FILE'
  | 'FS_TOO_LARGE'
  | 'FS_PERMISSION_DENIED'
  | 'FS_SANDBOX_DENIED'
  | 'FS_IO_ERROR'
  | 'FS_STALE_VERSION'
  | 'FS_NOT_OBSERVED'
  | 'FS_AMBIGUOUS_EDIT'
  | 'FS_EDIT_NOT_FOUND'
  | 'FS_ABORTED'

/**
 * Stable worktree failure codes. A caller distinguishes "the checkout is
 * already there" from "the branch name is taken" from "git itself refused",
 * because each needs a different next move.
 */
export type WireGitErrorCode =
  | 'GIT_NOT_A_REPOSITORY'
  | 'GIT_WORKTREE_EXISTS'
  | 'GIT_BRANCH_EXISTS'
  | 'GIT_REF_NOT_FOUND'
  | 'GIT_DIRTY'
  | 'GIT_COMMAND_FAILED'

/** Every code a daemon failure may carry. */
export type WireFailureCode = WireFsErrorCode | WireGitErrorCode | WireSubprocessErrorCode

/** The JSON-RPC `error.data` payload every daemon failure carries. */
export interface WireErrorData {
  readonly code: WireFailureCode
  /** Human-readable detail; the plugin logs it but does not parse it. */
  readonly message: string
}

/**
 * Whether a failure code belongs to the filesystem family.
 * @param code - the code a daemon reported.
 * @returns true when the code is one this module declares for filesystem failures.
 */
export function isFsErrorCode(code: WireFailureCode): code is WireFsErrorCode {
  return code.startsWith('FS_')
}

/**
 * Stable subprocess failure codes. `SP_UNSUPPORTED_STDIO` is the honest answer
 * for a disposition this protocol revision cannot carry, so a caller learns
 * what is missing instead of watching a stream that never produces bytes.
 */
export type WireSubprocessErrorCode =
  | 'SP_NOT_FOUND'
  | 'SP_NOT_EXECUTABLE'
  | 'SP_SPAWN_FAILED'
  | 'SP_UNSUPPORTED_STDIO'
  | 'SP_NO_SUCH_PROCESS'
  | 'SP_NO_SUCH_TERMINAL'
  | 'SP_TERMINAL_FAILED'

/** Signals the terminal primitive may deliver to a foreground group. */
export type WireTerminalSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGTSTP' | 'SIGHUP'

/** A fully specified terminal allocation. */
export interface WireTerminalSpawnSpec {
  /** Executable and arguments; never shell-interpreted by the daemon. */
  readonly argv: readonly string[]
  /** Absolute working directory in the daemon's filesystem. */
  readonly cwd: string
  /** Explicit environment entries layered over the daemon's own scrubbed base. */
  readonly env?: Readonly<Record<string, string>>
  /** Initial terminal row count. */
  readonly rows: number
  /** Initial terminal column count. */
  readonly cols: number
  /** TERM-to-KILL cleanup grace for the complete terminal session. */
  readonly graceMs: number
}

/** Current foreground process-group facts for one terminal. */
export interface WireTerminalForeground {
  /** Foreground process-group id published by the terminal driver. */
  readonly processGroupId: number
  /** Whether the daemon can currently prove that group is waiting on input. */
  readonly inputWaiting: boolean
}

/** One stdin disposition, mirroring the subprocess seam. */
export type WireStdinMode = 'ignore' | 'pipe' | { readonly data: string }

/** Bounded in-memory collection for one output stream. */
export interface WireCollect {
  /** In-memory cap in bytes; overflow keeps the tail. */
  readonly maxBytes: number
}

/**
 * One stdout/stderr disposition. `'pipe'` is a live push stream, carried by
 * {@link SP_PIPE_NOTIFICATION} rather than by the retained window; a consumer
 * that needs raw bytes as they arrive (a language server's protocol decoder)
 * asks for it, and one that wants a bounded tail asks for {@link WireCollect}.
 */
export type WireOutputMode = 'inherit' | 'pipe' | WireCollect

/** A fully specified spawn request; this seam applies no defaults. */
export interface WireSpawnSpec {
  /** Executable and arguments; never shell-interpreted by the daemon. */
  readonly argv: readonly string[]
  /** Absolute working directory in the daemon's filesystem. */
  readonly cwd: string
  /** stdin disposition. */
  readonly stdin: WireStdinMode
  /** stdout disposition. */
  readonly stdout: WireOutputMode
  /** stderr disposition. */
  readonly stderr: WireOutputMode
  /** Grace the daemon's termination ladder may spend before killing. */
  readonly graceMs: number
  /** Explicit environment entries layered over the daemon's own scrubbed base. */
  readonly env?: Readonly<Record<string, string>>
}

/**
 * One incremental read of a collected stream.
 *
 * The payload is raw bytes, not decoded text, because a collected reader is
 * addressed by whole-stream **byte** offset: only bytes let a client mirror the
 * daemon's window and answer an offset query exactly.
 */
export interface WireOutputRead {
  /** Raw bytes from the requested offset, base64; the retained tail when lossy. */
  readonly data: string
  /** Whole-stream byte offset to resume from. */
  readonly nextOffset: number
  /** True when the requested offset slid out of the in-memory window. */
  readonly lossy: boolean
}

/** Exit facts of one closed process. */
export interface WireOutcome {
  /** Exit code; null when the process died from a signal. */
  readonly exitCode: number | null
  /** Terminating signal name; null on a normal exit. */
  readonly signal: string | null
}

/**
 * The notification a daemon pushes for every chunk of a `'pipe'` stream.
 *
 * A raw piped stream is not a retained window: the consumer needs every byte in
 * order, so the daemon pushes instead of waiting to be polled. `seq` is
 * monotonic per stream so a client can tell that bytes were lost rather than
 * silently splicing a gap.
 */
export const SP_PIPE_NOTIFICATION = 'sp.pipe'

/**
 * Compile-time brand for the ids this contract carries.
 *
 * Declared here rather than imported from `@deepseek-ai/dsh-brand` to keep the
 * wire contract self-contained: the daemon is a Rust program whose hand-written
 * copy of these shapes (`agent/src/protocol.rs`) shares no module with this
 * package. The mechanism is the same one that package uses — a `unique symbol`
 * keyed intersection that only the owning domain can mint.
 */
declare const WIRE_BRAND: unique symbol

/** A spawned process, as the daemon names it. */
export type ProcId = string & { readonly [WIRE_BRAND]: 'ProcId' }

/** One terminal session, as the daemon names it. */
export type TermId = string & { readonly [WIRE_BRAND]: 'TermId' }

/**
 * Admit a string as a terminal session id.
 * @param value - a string the daemon minted, or one the wire delivered.
 * @returns the same string, branded.
 */
export function asTermId(value: string): TermId {
  return value as TermId
}

/** One pushed chunk of a raw piped stream. */
export interface SpPipeFrame {
  /** The process the chunk belongs to. */
  readonly procId: ProcId
  /** Which of the two streams produced it. */
  readonly stream: 'stdout' | 'stderr'
  /** Monotonic per-stream sequence number, starting at 0. */
  readonly seq: number
  /** Raw bytes, base64. */
  readonly data: string
}

/** What the daemon reports it can do. */
export interface NodeCapability {
  /** Whether `spawnTerminal` is served by this build. */
  readonly pty: boolean
  /** Whether collected-output spill files are served by this build. */
  readonly spill: boolean
  /** Remote binary the packaged ripgrep is rewritten to, or null when absent. */
  readonly ripgrep: string | null
}

/** The daemon's identity, capabilities, and environment. */
export interface NodeInfo {
  readonly protocol: number
  readonly agentVersion: string
  readonly platform: string
  readonly arch: string
  readonly node: string
  readonly homedir: string
  readonly capability: NodeCapability
}

/** First client request on every connection. */
export interface HelloRequest {
  readonly protocol: number
  readonly token: string
}

/** One git worktree as the node reports it. */
export interface WireWorktree {
  /** Absolute path of the checkout on the node. */
  readonly path: string
  /** Short branch name, or null when the entry is detached or bare. */
  readonly branch: string | null
  /** Committed revision the checkout points at. */
  readonly head: string
  /** Whether the entry is the repository's main worktree. */
  readonly main: boolean
}

/** What the repository looked like when an operation ran. */
export interface WireRepoState {
  /** Checked-out branch, or null when HEAD is detached. */
  readonly branch: string | null
  /** Whether the index and working tree carry no changes. */
  readonly clean: boolean
}

/** Result of merging one branch into the repository's current branch. */
export interface WireMergeOutcome {
  /** The revision the merge produced. */
  readonly head: string
  /** Whether the merge was already contained and produced no new commit. */
  readonly alreadyMerged: boolean
}

/** Method names, parameters, and results in one map both sides compile against. */
export interface WireMethods {
  'node.hello': { params: HelloRequest; result: NodeInfo }
  'fs.resolve': { params: { path: string }; result: WireTarget }
  'fs.stat': { params: { path: string }; result: WireStat | null }
  'fs.lstat': { params: { path: string }; result: WireLstat | null }
  'fs.listDir': { params: { path: string }; result: readonly WireDirEntry[] }
  'fs.readTextChunk': {
    params: { path: string; offset: number; length: number }
    result: WireTextChunk
  }
  'fs.readBytes': { params: { path: string; maxBytes: number }; result: WireBytes }
  'fs.readByteRange': {
    params: { path: string; offset: number; length: number }
    result: WireBytes
  }
  'fs.writeText': {
    params: { path: string; content: string; expected?: WireWriteIntent }
    result: WireWriteOutcome
  }
  'fs.editText': {
    params: { path: string; edit: WireEditRequest; expected?: { version: string } }
    result: WireEditOutcome
  }
  'git.worktreeAdd': {
    params: { repoPath: string; worktreePath: string; branch: string; baseRef?: string }
    result: WireWorktree
  }
  'git.worktreeList': { params: { repoPath: string }; result: readonly WireWorktree[] }
  'git.worktreeRemove': {
    params: { repoPath: string; worktreePath: string; force: boolean }
    result: Record<string, never>
  }
  'git.branchDelete': {
    params: { repoPath: string; branch: string; force: boolean }
    result: Record<string, never>
  }
  'git.repoState': { params: { repoPath: string }; result: WireRepoState }
  'git.mergeBranch': { params: { repoPath: string; branch: string }; result: WireMergeOutcome }
  'sp.resolveExecutable': {
    params: { command: string; env?: Readonly<Record<string, string>> }
    result: { path: string }
  }
  'sp.spawn': { params: WireSpawnSpec; result: { procId: ProcId } }
  'sp.readOutput': {
    params: { procId: ProcId; stream: 'stdout' | 'stderr'; fromByte: number }
    result: WireOutputRead
  }
  'sp.writeStdin': { params: { procId: ProcId; data: string }; result: Record<string, never> }
  'sp.closeStdin': { params: { procId: ProcId }; result: Record<string, never> }
  'sp.terminate': { params: { procId: ProcId }; result: Record<string, never> }
  'sp.waitForExit': { params: { procId: ProcId }; result: { empty: boolean } }
  'sp.outcome': { params: { procId: ProcId }; result: WireOutcome | null }
  'term.spawn': { params: WireTerminalSpawnSpec; result: { termId: TermId; pid: number } }
  'term.read': {
    params: { termId: TermId; fromByte: number }
    result: WireOutputRead
  }
  'term.write': { params: { termId: TermId; data: string }; result: Record<string, never> }
  'term.resize': {
    params: { termId: TermId; cols: number; rows: number }
    result: Record<string, never>
  }
  'term.inspectForeground': {
    params: { termId: TermId }
    result: WireTerminalForeground | null
  }
  'term.signalForeground': {
    params: { termId: TermId; signal: WireTerminalSignal }
    result: { processGroupId: number }
  }
  'term.terminate': { params: { termId: TermId }; result: Record<string, never> }
  'term.outcome': { params: { termId: TermId }; result: WireOutcome | null }
}

/** Every method this protocol revision defines. */
export type WireMethod = keyof WireMethods

/** Parameters of one method. */
export type WireParams<M extends WireMethod> = WireMethods[M]['params']

/** Result of one method. */
export type WireResult<M extends WireMethod> = WireMethods[M]['result']
