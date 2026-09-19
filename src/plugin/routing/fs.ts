/**
 * The routing filesystem the plugin registers as `ctx.fs`.
 *
 * It is a plain object, not a subclass: `ctx.provide('fs', …)` is the primitive
 * Cordis' own `Service` constructor calls, so no implementation class — not
 * even the abstract seam class — is inherited here. `FileSystem` supplies the
 * contract type only, and `FileSystemContract` narrows it to the members this
 * provider must implement.
 *
 * The local branch delegates to the factory `SandboxedFileSystem` instance the
 * caller composed in an isolated scope, so sandbox fencing, atomic publication,
 * version guards, and cross-chunk decoding keep their shipped behavior. The
 * remote branch forwards to the node's daemon and maps its answers back onto
 * the same seam vocabulary.
 *
 * @module dsh-remote-workspace/plugin/routing/fs
 */

import type { FileSystem, FsDirEntry, FsEditOutcome, FsEditRequest, FsInfo, FsPathInfo, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { TARGET_KEY_PREFIX, isFsErrorCode } from '../../remote/protocol.ts'
import type { ChannelLookup, NodeChannel } from '../../remote/client.ts'
import { NodeRequestError } from '../../remote/client.ts'
import { asNodeId } from '../../storage/nodes.ts'
import type { NodeId } from '../../storage/nodes.ts'
import type { AnchorRoute } from '../../storage/anchors.ts'
import { ambiguousPathMessage, classifyPath, isWithin } from '../../models/routing.ts'

/** Bytes per remote text pull. Bounds one round trip without capping file size. */
const TEXT_CHUNK_BYTES = 1 << 20

/** Remote paths `workspace-write` always permits, matching the local provider's temp allowance. */
const REMOTE_TEMP_ROOT = '/tmp'

/**
 * The members this provider implements, narrowed from the seam class so the
 * object literal is checked against the real contract without inheriting the
 * `Service` members that make the class nominally typed.
 */
export type FileSystemContract = Pick<
  FileSystem,
  | 'resolve'
  | 'processPath'
  | 'processPathFromHostPath'
  | 'fileUrl'
  | 'contains'
  | 'stat'
  | 'lstat'
  | 'readText'
  | 'streamText'
  | 'readBytes'
  | 'readByteRange'
  | 'listDir'
  | 'writeText'
  | 'editText'
  | 'sandboxMode'
>

/** What the routing filesystem needs from its owner. */
export interface RoutingFileSystemDeps {
  /** The composed factory implementation serving every local path. */
  readonly localFs: FileSystem
  /** Every anchor this plugin currently owns. */
  readonly anchors: () => readonly AnchorRoute[]
  /** Resolves the live channel for a node; undefined means "not connected". */
  readonly channel: ChannelLookup
}

/** A target key the plugin minted, decomposed back into its two facts. */
type ParsedKey =
  | { readonly kind: 'local' }
  | { readonly kind: 'remote'; readonly nodeId: NodeId; readonly remotePath: string }

/** Compose the opaque key the harness passes back to this provider. */
function composeKey(nodeId: NodeId, remotePath: string): FsTargetKey {
  return FsTargetKey(`${TARGET_KEY_PREFIX}${nodeId}:${remotePath}`)
}

/**
 * Decompose this provider's own key. The seam forbids a *consumer* from
 * parsing a key; the provider that mints one owns its format.
 * @param key - a key this provider previously returned.
 * @returns the local verdict, or the node and remote path for a remote target.
 */
function parseKey(key: FsTargetKey): ParsedKey {
  const raw = key as string
  if (!raw.startsWith(TARGET_KEY_PREFIX)) return { kind: 'local' }
  const rest = raw.slice(TARGET_KEY_PREFIX.length)
  const separator = rest.indexOf(':')
  if (separator <= 0 || !rest.slice(separator + 1).startsWith('/')) return { kind: 'local' }
  // The key is a synthetic path this plugin both writes and parses, so its
  // node half becomes an id again here.
  return { kind: 'remote', nodeId: asNodeId(rest.slice(0, separator)), remotePath: rest.slice(separator + 1) }
}

/** The remote target the daemon needs, or a typed failure when the node is offline. */
function requireChannel(deps: RoutingFileSystemDeps, nodeId: NodeId) {
  const channel = deps.channel(nodeId)
  if (channel === undefined) {
    throw new FsError(
      `remote node "${nodeId}" is not connected; open the machine before using this workspace`,
      'FS_IO_ERROR',
    )
  }
  return channel
}

/**
 * Translate a daemon failure into the seam's typed error so callers branch on
 * the same codes they would see locally. A failure outside the filesystem
 * family is left as the transport error it is.
 * @param error - any failure raised by a channel request.
 * @returns the error to throw.
 */
function toFsError(error: unknown): unknown {
  if (!(error instanceof NodeRequestError)) return error
  if (!isFsErrorCode(error.data.code)) return error
  return new FsError(error.data.message, error.data.code)
}

/**
 * Ask the daemon and hand back its answer.
 *
 * Every remote verb maps a failure the same way, so the mapping lives here
 * rather than at each of them: a daemon failure inside the filesystem family
 * becomes the typed error a caller branches on, and anything else stays the
 * transport error it is.
 * @param deps - the routing filesystem's dependencies.
 * @param nodeId - the machine to ask.
 * @param call - the request to issue against the live channel.
 * @returns the daemon's answer.
 */
async function ask<T>(
  deps: RoutingFileSystemDeps,
  nodeId: NodeId,
  call: (channel: NodeChannel) => Promise<T>,
): Promise<T> {
  try {
    return await call(requireChannel(deps, nodeId))
  } catch (error) {
    throw toFsError(error)
  }
}

/** Reject an operation whose signal already fired, before any round trip. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new FsError('filesystem operation aborted', 'FS_ABORTED')
}

/**
 * The failure an ambiguous remote path raises. Two nodes commonly share a
 * remote root, and picking one would read on one machine while writing on
 * another, so the path is refused with the spellings that would work.
 * @param route - the ambiguous verdict naming every claiming node.
 * @returns the typed error to throw.
 */
function ambiguousError(route: { readonly remotePath: string; readonly nodeIds: readonly NodeId[] }): FsError {
  return new FsError(ambiguousPathMessage(route), 'FS_IO_ERROR')
}

/**
 * Pull one remote text file as decoded chunks.
 *
 * The daemon decodes and rejects binary content, so this loop never splits a
 * code point; the plugin only reassembles what it is given.
 * @param channel - the live node channel.
 * @param remotePath - canonical remote path.
 * @param signal - aborts the pull between round trips.
 * @returns the chunk iterable.
 */
function remoteTextStream(
  channel: NodeChannel,
  remotePath: string,
  signal: AbortSignal | undefined,
): AsyncIterable<string> {
  return (async function* pull() {
    let offset = 0
    for (;;) {
      throwIfAborted(signal)
      let chunk
      try {
        chunk = await channel.request('fs.readTextChunk', {
          path: remotePath,
          offset,
          length: TEXT_CHUNK_BYTES,
        })
      } catch (error) {
        throw toFsError(error)
      }
      if (chunk.text.length > 0) yield chunk.text
      offset = chunk.nextOffset
      if (chunk.eof) return
    }
  })()
}

/**
 * Whether the resolved policy permits writing `remotePath` on a node.
 *
 * A remote world is not confined by `ctx.sandbox`, so the only enforceable
 * boundary is the one this provider applies per call: `workspace-write` allows
 * the anchor's remote root and the remote temp area, `read-only` allows
 * nothing, and `danger-full-access` allows everything.
 * @param policy - the per-call policy the caller resolved, when it supplied one.
 * @param remotePath - the canonical remote path about to be written.
 * @param remoteRoot - the anchor's remote root, or undefined when unknown.
 * @returns true when the write may proceed.
 */
function remoteWriteAllowed(
  policy: SandboxExecutionPolicy | undefined,
  remotePath: string,
  remoteRoot: string | undefined,
): boolean {
  if (policy === undefined) return true
  switch (policy.mode) {
    case 'danger-full-access': return true
    case 'read-only': return false
    case 'workspace-write':
      if (isWithin(REMOTE_TEMP_ROOT, remotePath)) return true
      return remoteRoot !== undefined && isWithin(remoteRoot, remotePath)
  }
}

/**
 * Build the routing filesystem.
 * @param deps - the composed local delegate, the live anchors, and channel lookup.
 * @returns an object satisfying the filesystem seam, ready for `ctx.provide`.
 */
export function createRoutingFileSystem(deps: RoutingFileSystemDeps): FileSystemContract {
  /** The anchor whose remote root owns `remotePath`, when one does. */
  const anchorFor = (nodeId: NodeId, remotePath: string): AnchorRoute | undefined =>
    deps.anchors().find(anchor =>
      anchor.nodeId === nodeId && isWithin(anchor.remoteRoot, remotePath))

  /**
   * Refuse a remote mutation the per-call policy does not allow.
   * @param nodeId - the machine the path lives on.
   * @param remotePath - the canonical remote path about to be written.
   * @param verb - the operation, for the message.
   * @param policy - the per-call policy the caller resolved, when it supplied one.
   * @throws the typed error naming the policy that refused it.
   */
  const requireRemoteWrite = (
    nodeId: NodeId,
    remotePath: string,
    verb: 'edit' | 'write',
    policy: SandboxExecutionPolicy | undefined,
  ): void => {
    if (remoteWriteAllowed(policy, remotePath, anchorFor(nodeId, remotePath)?.remoteRoot)) return
    throw new FsError(
      `remote ${verb} denied by the ${String(policy?.mode)} policy: ${remotePath}`,
      'FS_SANDBOX_DENIED',
    )
  }

  const router: FileSystemContract = {
    // Delegated for the same reason as the shell executor: this provider really
    // does fence local mutations at the deployment's mode through the composed
    // sandboxed filesystem, and reporting `undefined` would misstate that.
    // Remote writes are bounded by the remote policy instead.
    get sandboxMode(): SandboxMode | undefined {
      return deps.localFs.sandboxMode
    },

    async resolve(path, opts) {
      throwIfAborted(opts?.signal)
      const route = classifyPath(path, opts?.cwd, deps.anchors())
      if (route.kind === 'local') return deps.localFs.resolve(path, opts)
      if (route.kind === 'ambiguous') throw ambiguousError(route)
      const resolved = await ask(deps, route.nodeId, channel =>
        channel.request('fs.resolve', { path: route.remotePath }))
      return {
        targetKey: composeKey(route.nodeId, resolved.canonicalPath),
        displayPath: resolved.canonicalPath,
      }
    },

    processPath(target) {
      const parsed = parseKey(target.targetKey)
      return parsed.kind === 'local'
        ? deps.localFs.processPath(target)
        : parsed.remotePath
    },

    // A host file is not a remote file. Delegating keeps local attachments
    // working; an attachment inside a remote session resolves to a host path
    // the remote world cannot read, and fails there with the daemon's own
    // error rather than silently reading a different file.
    processPathFromHostPath(hostPath) {
      return deps.localFs.processPathFromHostPath(hostPath)
    },

    fileUrl(target) {
      const parsed = parseKey(target.targetKey)
      if (parsed.kind === 'local') return deps.localFs.fileUrl(target)
      return `file://${parsed.remotePath.split('/').map(encodeURIComponent).join('/')}`
    },

    contains(parent, child) {
      const left = parseKey(parent.targetKey)
      const right = parseKey(child.targetKey)
      if (left.kind === 'local' && right.kind === 'local') return deps.localFs.contains(parent, child)
      if (left.kind === 'local' || right.kind === 'local') return false
      return left.nodeId === right.nodeId && isWithin(left.remotePath, right.remotePath)
    },

    async stat(target, signal) {
      throwIfAborted(signal)
      const parsed = parseKey(target.targetKey)
      if (parsed.kind === 'local') return deps.localFs.stat(target, signal)
      const info = await ask(deps, parsed.nodeId, channel =>
        channel.request('fs.stat', { path: parsed.remotePath }))
      if (info === null) return undefined
      return {
        version: FsVersion(info.version),
        type: info.type,
        ...info.size === undefined ? {} : { size: info.size },
      } satisfies FsInfo
    },

    async lstat(path, opts, signal) {
      throwIfAborted(signal)
      const route = classifyPath(path, opts?.cwd, deps.anchors())
      if (route.kind === 'local') return deps.localFs.lstat(path, opts, signal)
      if (route.kind === 'ambiguous') throw ambiguousError(route)
      const info = await ask(deps, route.nodeId, channel =>
        channel.request('fs.lstat', { path: route.remotePath }))
      if (info === null) return undefined
      return {
        version: FsVersion(info.version),
        type: info.type,
        ...info.size === undefined ? {} : { size: info.size },
      } satisfies FsPathInfo
    },

    async readText(target, signal) {
      throwIfAborted(signal)
      const parsed = parseKey(target.targetKey)
      if (parsed.kind === 'local') return deps.localFs.readText(target, signal)
      const chunks: string[] = []
      const stream = remoteTextStream(
        requireChannel(deps, parsed.nodeId),
        parsed.remotePath,
        signal,
      )
      for await (const chunk of stream) chunks.push(chunk)
      return chunks.join('')
    },

    async streamText(target, signal) {
      throwIfAborted(signal)
      const parsed = parseKey(target.targetKey)
      if (parsed.kind === 'local') return deps.localFs.streamText(target, signal)
      return remoteTextStream(
        requireChannel(deps, parsed.nodeId),
        parsed.remotePath,
        signal,
      )
    },

    async readBytes(target, signal, maxBytes) {
      throwIfAborted(signal)
      const parsed = parseKey(target.targetKey)
      if (parsed.kind === 'local') return deps.localFs.readBytes(target, signal, maxBytes)
      const bytes = await ask(deps, parsed.nodeId, channel =>
        channel.request('fs.readBytes', { path: parsed.remotePath, maxBytes }))
      return new Uint8Array(Buffer.from(bytes.data, 'base64'))
    },

    async readByteRange(target, range, signal) {
      throwIfAborted(signal)
      const parsed = parseKey(target.targetKey)
      if (parsed.kind === 'local') return deps.localFs.readByteRange(target, range, signal)
      const bytes = await ask(deps, parsed.nodeId, channel =>
        channel.request('fs.readByteRange', {
          path: parsed.remotePath,
          offset: range.offset,
          length: range.length,
        }))
      return new Uint8Array(Buffer.from(bytes.data, 'base64'))
    },

    async listDir(target, signal) {
      throwIfAborted(signal)
      const parsed = parseKey(target.targetKey)
      if (parsed.kind === 'local') return deps.localFs.listDir(target, signal)
      const entries = await ask(deps, parsed.nodeId, channel =>
        channel.request('fs.listDir', { path: parsed.remotePath }))
      return entries.map((entry): FsDirEntry => ({
        name: entry.name,
        type: entry.type,
        target: {
          targetKey: composeKey(parsed.nodeId, entry.target.canonicalPath),
          displayPath: entry.target.canonicalPath,
        },
        ...entry.version === undefined ? {} : { version: FsVersion(entry.version) },
        ...entry.size === undefined ? {} : { size: entry.size },
      }))
    },

    async writeText(target, content, expected, signal, sandboxPolicy) {
      throwIfAborted(signal)
      const parsed = parseKey(target.targetKey)
      if (parsed.kind === 'local') {
        return deps.localFs.writeText(target, content, expected, signal, sandboxPolicy)
      }
      requireRemoteWrite(parsed.nodeId, parsed.remotePath, 'write', sandboxPolicy)
      const outcome = await ask(deps, parsed.nodeId, channel => channel.request('fs.writeText', {
        path: parsed.remotePath,
        content,
        ...expected === undefined ? {} : {
          expected: expected.kind === 'createIfAbsent'
            ? { kind: 'createIfAbsent' as const }
            : { kind: 'replaceIfVersion' as const, version: expected.version as string },
        },
      }))
      return {
        operation: outcome.operation,
        version: FsVersion(outcome.version),
        before: outcome.before,
        after: outcome.after,
      } satisfies FsWriteOutcome
    },

    async editText(target, edit: FsEditRequest, expected, signal, sandboxPolicy) {
      throwIfAborted(signal)
      const parsed = parseKey(target.targetKey)
      if (parsed.kind === 'local') {
        return deps.localFs.editText(target, edit, expected, signal, sandboxPolicy)
      }
      requireRemoteWrite(parsed.nodeId, parsed.remotePath, 'edit', sandboxPolicy)
      const outcome = await ask(deps, parsed.nodeId, channel => channel.request('fs.editText', {
        path: parsed.remotePath,
        edit: { oldString: edit.oldString, newString: edit.newString, replaceAll: edit.replaceAll },
        ...expected === undefined ? {} : { expected: { version: expected.version as string } },
      }))
      return {
        version: FsVersion(outcome.version),
        before: outcome.before,
        after: outcome.after,
      } satisfies FsEditOutcome
    },
  }

  return router
}
