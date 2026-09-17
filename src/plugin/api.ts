/**
 * The management API behind the plugin's Web routes, and the adapter that
 * mounts it.
 *
 * The rules and the transport are separate halves of one module, in that order:
 * {@link handleNodeApi} takes a normalized request and returns a status plus a
 * JSON body, so validation, which fields may leave the host, and which failures
 * are client errors are all exercised without opening a socket; the adapter
 * below it owns only reading a bounded body, parsing the URL, and writing JSON
 * back.
 *
 * A node's token never appears in a response. {@link toNodeView} is the only
 * projection used here.
 *
 * The route is registered through `ctx.get('webServer')` rather than an
 * injected dependency, because a non-Web profile (headless, SDK) has no HTTP
 * server and the plugin must still load there.
 *
 * @module dsh-remote-workspace/plugin/api
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
// Type-only: pulls the Web-server plugin's Context merge (ctx.get('webServer')),
// which is how these routes register without injecting the service.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { NodeConnections, NodeStatus } from '../models/machines.ts'
import type { NodeId } from '../storage/nodes.ts'
import type { NodeRecord, NodeRegistry, NodeTransport } from '../storage/nodes.ts'
import { toNodeView } from '../storage/nodes.ts'
import { asAnchorId } from '../storage/anchors.ts'
import { asNodeId } from '../storage/nodes.ts'
import { asRepoId } from '../storage/repos.ts'
import type { RepoRecord, RepoStore } from '../storage/repos.ts'
import { NodeRequestError } from '../remote/client.ts'
import type { WorktreeManager } from '../models/worktrees.ts'
import { homedir } from 'node:os'
import type { LocalPathType } from '../local/fs.ts'
import { listLocalDir, localPathType, resolveLocalPath } from '../local/fs.ts'
import { isRepository } from '../local/git.ts'
import type { TerminalRegistry } from '../terminal/host/registry.ts'

/** One normalized request, already routed to this API's prefix. */
export interface ApiRequest {
  /** Upper-case HTTP method. */
  readonly method: string
  /** Path below the API prefix; always starts with `/`. */
  readonly path: string
  /** Parsed query string. */
  readonly query: URLSearchParams
  /** Parsed JSON body, or undefined when the request carried none. */
  readonly body: unknown
}

/** One normalized response. */
export interface ApiResponse {
  /** HTTP status code. */
  readonly status: number
  /** JSON-serializable body. */
  readonly body: unknown
}

/** What the API needs from the plugin. */
export interface ManagementApiDeps {
  /** Durable node records. */
  readonly registry: NodeRegistry
  /** Durable repository records. */
  readonly repos: RepoStore
  /** Live connections. */
  readonly connections: NodeConnections
  /** The remote worktree lifecycle. */
  readonly worktrees: WorktreeManager
  /**
   * The shells a person's tabs have open.
   *
   * The panel reads the same table the agent's terminal tool addresses, so a
   * terminal a reload left without a tab is still findable — and closable.
   */
  readonly terminals: TerminalRegistry
  /**
   * Where one machine cuts its checkouts, for the panel's default path.
   *
   * It throws while the machine's home is still unknown.
   */
  readonly worktreeRoot: (nodeId: NodeId) => string
}

/** One repository as the API reports it: the record, and whether git owns it. */
interface RepoReport {
  readonly repo: RepoRecord
  /**
   * Whether the directory is inside a git repository on the machine, as of this
   * read. A plain directory is a legitimate record — it can be opened as a
   * workspace and initialized later — so this is asked every time rather than
   * written down at registration.
   */
  readonly git: boolean
  /**
   * Where this repository's machine cuts its checkouts, when its home is
   * already known. The panel shows it as the default path of a new worktree.
   */
  readonly worktreeRoot?: string
  /** Why the question could not be answered, when it could not. */
  readonly error?: string
}

/** A failure carrying the status this API answers with. */
class ApiError extends Error {
  /** HTTP status this failure answers with. */
  readonly status: number

  /**
   * @param status - the HTTP status to answer with.
   * @param message - the client-facing reason.
   */
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** The named string field of an unknown value, or undefined. */
function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' ? field : undefined
}

/** The failure for a method one of these routes does not answer. */
function notAllowed(request: ApiRequest): ApiError {
  return new ApiError(405, `${request.method} is not allowed on ${request.path}`)
}

/**
 * Read a required non-empty string field, or fail as a client error.
 * @param body - the parsed request body.
 * @param key - the field name.
 * @returns the trimmed value.
 * @throws ApiError 400 when the field is missing or empty.
 */
function requireString(body: unknown, key: string): string {
  const value = stringField(body, key)?.trim()
  if (value === undefined || value === '') {
    throw new ApiError(400, `"${key}" is required and must be a non-empty string`)
  }
  return value
}

/**
 * Read the SSH destination a caller wants to reach a machine through.
 *
 * Only the destination is required: the SSH port and identity file default to
 * whatever the operator's own `ssh` configuration already says, so a
 * `~/.ssh/config` alias works exactly as written.
 * @param body - the parsed request body.
 * @returns the stored transport.
 * @throws ApiError 400 when the destination is missing or a field is unusable.
 */
function requireTransport(body: unknown): NodeTransport {
  const ssh = typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)['ssh']
    : undefined
  if (typeof ssh !== 'object' || ssh === null) {
    throw new ApiError(400, '"ssh" is required and must name how to reach the machine')
  }
  const fields = ssh as Record<string, unknown>
  const target = typeof fields['target'] === 'string' ? fields['target'].trim() : ''
  if (target === '') {
    throw new ApiError(400, '"ssh.target" is required and must be a non-empty string')
  }
  const portField = fields['port']
  if (portField !== undefined
    && (typeof portField !== 'number' || !Number.isInteger(portField) || portField < 1 || portField > 65535)) {
    throw new ApiError(400, '"ssh.port" must be between 1 and 65535')
  }
  const identity = typeof fields['identityFile'] === 'string' ? fields['identityFile'].trim() : ''
  return {
    kind: 'ssh',
    target,
    ...portField === undefined ? {} : { sshPort: portField as number },
    ...identity === '' ? {} : { identityFile: identity },
  }
}

/** One machine's status, as this API reports it. */
function statusOf(connections: NodeConnections, record: NodeRecord): NodeStatus {
  // The local machine is reachable by definition: it is where this process
  // runs, so it has no connection state to report and never a failure.
  return record.transport.kind === 'local'
    ? { nodeId: record.nodeId, state: 'ready' }
    : connections.status(record.nodeId)
}

/**
 * Resolve a node id to a stored record, or fail as a client error.
 * @param registry - the durable registry.
 * @param nodeId - the path segment.
 * @returns the record.
 * @throws ApiError 404 when no node carries that id.
 */
function requireNode(registry: NodeRegistry, nodeId: NodeId) {
  const record = registry.get(nodeId)
  if (record === undefined) throw new ApiError(404, `no node "${nodeId}"`)
  return record
}

/**
 * Resolve a caller's path against a machine's own filesystem rules.
 * @param deps - the management dependencies.
 * @param record - the machine to ask.
 * @param path - the caller's path, absolute or starting with `~`.
 * @returns the canonical absolute path on that machine.
 * @throws ApiError 409 when the machine is not connected, 502 when it cannot
 *   resolve the path.
 */
async function resolveOnNode(
  deps: ManagementApiDeps,
  record: NodeRecord,
  path: string,
): Promise<string> {
  if (record.transport.kind === 'local') return await resolveLocalPath(path)
  const channel = deps.connections.channel(record.nodeId)
  if (channel === undefined) throw new ApiError(409, `node "${record.nodeId}" is not connected`)
  const resolved = await channel.request('fs.resolve', { path })
  return resolved.canonicalPath
}

/**
 * Read what one path is on a machine.
 * @param deps - the management dependencies.
 * @param record - the machine to ask.
 * @param path - the canonical absolute path to probe.
 * @returns the entry's type, or undefined when nothing is there.
 * @throws ApiError 409 when the machine is not connected.
 */
async function statOnNode(
  deps: ManagementApiDeps,
  record: NodeRecord,
  path: string,
): Promise<LocalPathType | undefined> {
  if (record.transport.kind === 'local') return await localPathType(path)
  const channel = deps.connections.channel(record.nodeId)
  if (channel === undefined) throw new ApiError(409, `node "${record.nodeId}" is not connected`)
  return (await channel.request('fs.stat', { path }))?.type
}

/**
 * Ask one repository's machine whether git owns that directory.
 *
 * A record outlives the connection to its machine, so an unreachable one still
 * lists; only the answer goes missing, and `error` says why. The daemon's own
 * "not a repository" is the one failure that answers the question — everything
 * else means the question could not be put to the machine.
 * @param deps - the management dependencies.
 * @param record - the stored repository.
 * @returns the record and whether it is a repository right now.
 */
async function reportRepo(deps: ManagementApiDeps, record: RepoRecord): Promise<RepoReport> {
  // A machine that has not answered its handshake yet has no home to resolve
  // `~` against; the panel then shows no default and the host computes it.
  let root: string | undefined
  try {
    root = deps.worktreeRoot(record.nodeId)
  } catch {
    root = undefined
  }
  // Spread rather than assign: an unknown root is an absent key, not an
  // undefined one, under `exactOptionalPropertyTypes`.
  const placed = root === undefined ? {} : { worktreeRoot: root }
  const node = deps.registry.get(record.nodeId)
  try {
    if (node?.transport.kind === 'local') {
      return { repo: record, ...placed, git: await isRepository(record.repoPath) }
    }
    const channel = deps.connections.channel(record.nodeId)
    if (channel === undefined) {
      return { repo: record, ...placed, git: false, error: `node "${record.nodeId}" is not connected` }
    }
    await channel.request('git.repoState', { repoPath: record.repoPath })
    return { repo: record, ...placed, git: true }
  } catch (error) {
    if (error instanceof NodeRequestError && error.data.code === 'GIT_NOT_A_REPOSITORY') {
      return { repo: record, ...placed, git: false }
    }
    return {
      repo: record,
      ...placed,
      git: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Handle the repository half of the API.
 * @param request - the normalized request.
 * @param parts - path segments below `/repos`.
 * @param deps - the management dependencies.
 * @returns the status and JSON body to answer with.
 */
async function handleRepos(
  request: ApiRequest,
  parts: readonly string[],
  deps: ManagementApiDeps,
): Promise<ApiResponse> {
  const [rawRepoId, action] = parts
  // A route segment is a string from an untrusted request; this is where it
  // becomes an id. Everything below passes the branded value.
  const repoId = rawRepoId === undefined ? undefined : asRepoId(rawRepoId)

  if (repoId === undefined) {
    if (request.method === 'GET') {
      const reports = await Promise.all(deps.repos.list().map(repo => reportRepo(deps, repo)))
      return { status: 200, body: { repos: reports } }
    }
    if (request.method === 'POST') {
      // Both required fields are read before any lookup, so a malformed body is
      // always a 400 rather than whichever existence check runs first.
      const nodeId = asNodeId(requireString(request.body, 'nodeId'))
      const requested = requireString(request.body, 'repoPath')
      const node = requireNode(deps.registry, nodeId)
      const repoPath = await resolveOnNode(deps, node, requested)
      // Any directory can be registered: a plain one is opened as a workspace
      // and may become a repository later, so git is not this moment's
      // business. It has to be a directory, though — a file holds no checkout
      // and no workspace.
      const target = await statOnNode(deps, node, repoPath)
      if (target === undefined) throw new ApiError(400, `"${repoPath}" does not exist on that machine`)
      if (target !== 'directory') {
        throw new ApiError(400, `"${repoPath}" is a ${target} on that machine, not a directory`)
      }
      const existing = deps.repos.find({ nodeId, repoPath })
      const name = stringField(request.body, 'name')?.trim()
      const record = await deps.repos.upsert({
        ...existing === undefined ? {} : { repoId: existing.repoId },
        nodeId,
        repoPath,
        ...name === undefined || name === '' ? {} : { name },
      })
      return { status: existing === undefined ? 201 : 200, body: { repo: await reportRepo(deps, record) } }
    }
    throw notAllowed(request)
  }

  const record = deps.repos.get(repoId)
  if (record === undefined) throw new ApiError(404, `no repository "${repoId}"`)

  const ref = { nodeId: record.nodeId, repoPath: record.repoPath }

  // Opening the directory itself is what makes a machine's plain directory a
  // workspace before it is a repository; git is never consulted for it.
  if (action === 'open' || action === 'close') {
    if (request.method !== 'POST') throw notAllowed(request)
    if (action === 'open') {
      return { status: 200, body: { anchor: await deps.worktrees.openDirectory(ref) } }
    }
    return { status: 200, body: { closed: await deps.worktrees.closeDirectory(ref) !== undefined } }
  }

  // The checkouts git already knows about for this repository: how one cut by
  // hand, or before this plugin existed, becomes usable. Adopting one records
  // it and opens it; the checkout itself is never written to.
  if (action === 'worktrees') {
    if (request.method === 'GET') {
      return { status: 200, body: { worktrees: await deps.worktrees.existing(ref) } }
    }
    if (request.method === 'POST') {
      const anchor = await deps.worktrees.adopt(ref, requireString(request.body, 'path'))
      return { status: 201, body: { worktree: anchor } }
    }
    throw notAllowed(request)
  }

  if (action !== undefined) throw new ApiError(404, `unknown endpoint ${request.method} ${request.path}`)

  if (request.method === 'GET') {
    return { status: 200, body: { repo: await reportRepo(deps, record) } }
  }
  if (request.method === 'DELETE') {
    // A worktree is work that only exists in that checkout, so forgetting the
    // repository would strand it; a directory workspace is this host's own
    // bookkeeping and goes with the record.
    const held = (await deps.worktrees.anchorsIn(ref)).filter(anchor => anchor.kind === 'worktree')
    if (held.length > 0) {
      throw new ApiError(
        409,
        `${String(held.length)} worktree(s) still belong to this repository; remove them first`,
      )
    }
    await deps.worktrees.closeDirectory(ref)
    return { status: 200, body: { deleted: await deps.repos.remove(repoId) } }
  }
  throw notAllowed(request)
}

/**
 * Handle the worktree half of the API.
 * @param request - the normalized request.
 * @param parts - path segments below `/worktrees`.
 * @param deps - the management dependencies.
 * @returns the status and JSON body to answer with.
 */
async function handleWorktrees(
  request: ApiRequest,
  parts: readonly string[],
  deps: ManagementApiDeps,
): Promise<ApiResponse> {
  const [rawAnchorId, action] = parts
  const anchorId = rawAnchorId === undefined ? undefined : asAnchorId(rawAnchorId)

  if (anchorId === undefined) {
    if (request.method === 'GET') {
      return { status: 200, body: { worktrees: await deps.worktrees.list() } }
    }
    if (request.method === 'POST') {
      const rawRepoId = stringField(request.body, 'repoId')?.trim()
      const repoId = rawRepoId === undefined || rawRepoId === '' ? undefined : asRepoId(rawRepoId)
      const target = repoId === undefined
        ? {
            nodeId: asNodeId(requireString(request.body, 'nodeId')),
            repoPath: requireString(request.body, 'repoPath'),
          }
        : (() => {
            const record = deps.repos.get(repoId)
            if (record === undefined) throw new ApiError(404, `no repository "${repoId}"`)
            return { nodeId: record.nodeId, repoPath: record.repoPath }
          })()
      const baseRef = stringField(request.body, 'baseRef')
      // A caller may place the checkout itself; the machine's own root is the
      // default. A relative path would be resolved against that root by the
      // daemon, which is never what a caller means here.
      const path = stringField(request.body, 'path')?.trim()
      if (path !== undefined && path !== '' && !path.startsWith('/')) {
        throw new ApiError(400, `"path" must be absolute: "${path}"`)
      }
      const anchor = await deps.worktrees.create({
        ...target,
        name: requireString(request.body, 'name'),
        ...path === undefined || path === '' ? {} : { path },
        ...baseRef === undefined ? {} : { baseRef },
      })
      return { status: 201, body: { worktree: anchor } }
    }
    throw notAllowed(request)
  }

  // Opening, closing, and releasing are workspace and record bookkeeping, not
  // git: the checkout on the machine is untouched by all three.
  if (action === 'open' || action === 'close' || action === 'release') {
    if (request.method !== 'POST') throw notAllowed(request)
    if (action === 'release') {
      return { status: 200, body: { worktree: await deps.worktrees.release(anchorId) } }
    }
    const worktree = action === 'open'
      ? await deps.worktrees.open(anchorId)
      : await deps.worktrees.close(anchorId)
    return { status: 200, body: { worktree } }
  }

  if (action === undefined && request.method === 'DELETE') {
    return {
      status: 200,
      body: {
        removal: await deps.worktrees.remove(anchorId, {
          force: request.query.get('force') === 'true',
          // Deleting a branch is an explicit ask: this plugin owns worktrees,
          // not branches, so the default leaves it behind.
          deleteBranch: request.query.get('deleteBranch') === 'true',
        }),
      },
    }
  }

  throw new ApiError(404, `unknown endpoint ${request.method} ${request.path}`)
}

/**
 * Handle the terminal half of the API.
 *
 * The list is the registry's own projection for one Session, so what the panel
 * offers is exactly what the agent's terminal tool would address — including a
 * detached shell whose tab a reload took away. Closing is the registry's kill
 * path: it ends the shell an explicit end names, and an id nobody holds is a
 * client error rather than a silent success.
 * @param request - the normalized request.
 * @param parts - path segments below `/terminals`.
 * @param deps - the management dependencies.
 * @returns the status and JSON body to answer with.
 */
async function handleTerminals(
  request: ApiRequest,
  parts: readonly string[],
  deps: ManagementApiDeps,
): Promise<ApiResponse> {
  const [id, action] = parts
  if (id === undefined) {
    if (request.method !== 'GET') throw notAllowed(request)
    const sessionId = (request.query.get('sessionId') ?? '').trim()
    if (sessionId === '') throw new ApiError(400, '"sessionId" is required')
    return { status: 200, body: { terminals: deps.terminals.listFor(sessionId) } }
  }
  if (action !== 'close') throw new ApiError(404, `unknown endpoint ${request.method} ${request.path}`)
  if (request.method !== 'POST') throw notAllowed(request)
  if (!await deps.terminals.kill(id)) throw new ApiError(404, `no terminal "${id}"`)
  return { status: 200, body: { closed: true } }
}

/**
 * Handle one management request.
 * @param request - the normalized request.
 * @param deps - the registry, connection manager, worktree lifecycle, and terminals.
 * @returns the status and JSON body to answer with.
 */
export async function handleNodeApi(request: ApiRequest, deps: ManagementApiDeps): Promise<ApiResponse> {
  try {
    const parts = request.path.split('/').filter(segment => segment !== '')
    const head = parts[0]

    if (head === 'terminals') return await handleTerminals(request, parts.slice(1), deps)
    if (head === 'worktrees') return await handleWorktrees(request, parts.slice(1), deps)
    if (head === 'repos') return await handleRepos(request, parts.slice(1), deps)
    if (head !== 'nodes') {
      throw new ApiError(404, `unknown endpoint ${request.method} ${request.path}`)
    }

    const [, rawNodeId, action] = parts
    const nodeId = rawNodeId === undefined ? undefined : asNodeId(rawNodeId)

    if (nodeId === undefined) {
      if (request.method === 'GET') {
        const records = deps.registry.list()
        return {
          status: 200,
          body: {
            nodes: records.map(toNodeView),
            statuses: records.map(record => statusOf(deps.connections, record)),
          },
        }
      }
      if (request.method === 'POST') {
        const title = stringField(request.body, 'title')
        const record = await deps.registry.upsert({
          transport: requireTransport(request.body),
          token: requireString(request.body, 'token'),
          ...title === undefined ? {} : { title },
        })
        return { status: 201, body: { node: toNodeView(record) } }
      }
      throw notAllowed(request)
    }

    const record = requireNode(deps.registry, nodeId)

    if (action === undefined) {
      if (request.method === 'GET') {
        return { status: 200, body: { node: toNodeView(record), status: statusOf(deps.connections, record) } }
      }
      if (request.method === 'DELETE') {
        // The local machine is not a record: there is nothing to delete, and
        // answering otherwise would suggest it is gone when the next read
        // brings it back.
        if (record.transport.kind === 'local') {
          throw new ApiError(400, 'the local machine is built in and cannot be removed')
        }
        deps.connections.disconnect(nodeId)
        const deleted = await deps.registry.remove(nodeId)
        // A repository is only reachable through its machine, so its records
        // go with it rather than surviving as entries that can never load.
        if (deleted) await deps.repos.removeByNode(nodeId)
        return { status: 200, body: { deleted } }
      }
      if (request.method === 'PATCH') {
        if (record.transport.kind === 'local') {
          throw new ApiError(400, 'the local machine is built in and cannot be changed')
        }
        // A patch that names a destination replaces it; one that does not keeps
        // the stored one, so re-pointing a machine is a deliberate act.
        const ssh = typeof request.body === 'object' && request.body !== null
          ? (request.body as Record<string, unknown>)['ssh']
          : undefined
        const updated = await deps.registry.upsert({
          nodeId,
          transport: ssh === undefined ? record.transport : requireTransport(request.body),
          token: stringField(request.body, 'token') ?? record.token,
          title: stringField(request.body, 'title') ?? record.title,
        })
        return { status: 200, body: { node: toNodeView(updated) } }
      }
      throw notAllowed(request)
    }

    if (action === 'connect' || action === 'disconnect') {
      if (request.method !== 'POST') throw notAllowed(request)
      // Connecting this host, and disconnecting it, are both already true: it
      // answers without a connection, so neither needs to do anything.
      if (record.transport.kind !== 'local') {
        if (action === 'disconnect') deps.connections.disconnect(nodeId)
        else await deps.connections.connect(record)
      }
      return { status: 200, body: { status: statusOf(deps.connections, record) } }
    }

    if (action === 'dirs') {
      if (request.method !== 'GET') throw notAllowed(request)
      // A request without a path starts at the machine user's home: the home the
      // handshake reported for a node, and this user's home for this host.
      const requested = (request.query.get('path') ?? '').trim()
      if (record.transport.kind === 'local') {
        const path = await resolveLocalPath(requested === '' ? homedir() : requested)
        return { status: 200, body: { path, entries: await listLocalDir(path) } }
      }
      // The daemon itself expands no `~`, so the spelling never travels: the
      // home it named is asked for verbatim.
      const path = await resolveOnNode(deps, record, requested === ''
        ? deps.connections.status(nodeId).info?.homedir ?? '/'
        : requested)
      const channel = deps.connections.channel(nodeId)
      if (channel === undefined) throw new ApiError(409, `node "${nodeId}" is not connected`)
      const listing = await channel.request('fs.listDir', { path })
      return {
        status: 200,
        body: {
          path,
          entries: listing.map(entry => ({
            name: entry.name,
            type: entry.type,
            path: entry.target.canonicalPath,
            ...entry.size === undefined ? {} : { size: entry.size },
          })),
        },
      }
    }

    throw new ApiError(404, `unknown endpoint ${request.method} ${request.path}`)
  } catch (error) {
    if (error instanceof ApiError) return { status: error.status, body: { error: error.message } }
    return {
      status: 502,
      body: { error: error instanceof Error ? error.message : String(error) },
    }
  }
}

/** The path prefix this plugin owns. */
const API_PREFIX = '/dsh-remote-workspace'

/** Bound on one management request body. */
const MAX_BODY_BYTES = 1 << 20

/** Read a bounded request body and parse it as JSON. */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  if (total === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function writeResponse(response: ServerResponse, result: ApiResponse): void {
  const payload = JSON.stringify(result.body)
  response.writeHead(result.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  response.end(payload)
}

/**
 * Register the management routes on the host's Web server.
 *
 * A missing Web server is not a failure: it means this profile serves no
 * browser, and the plugin's model-facing behavior is unaffected.
 * @param ctx - the host context.
 * @param deps - the registry and connection manager the API reads.
 */
export function registerNodeApi(ctx: Context, deps: ManagementApiDeps): void {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const path = url.pathname.slice(API_PREFIX.length)
      let decoded: string
      try {
        // Each segment is decoded on its own, after the split, so an encoded
        // separator cannot invent a segment boundary. A caller percent-encodes
        // an id — the browser does, because an id is one opaque token — and an
        // id that arrived encoded would never match anything.
        decoded = path === ''
          ? '/'
          : path.split('/').map(segment => decodeURIComponent(segment)).join('/')
      } catch {
        writeResponse(response, { status: 400, body: { error: `${path} is not valid percent-encoding` } })
        return
      }
      let body: unknown
      try {
        body = await readJsonBody(request)
      } catch (error) {
        writeResponse(response, {
          status: 400,
          body: { error: error instanceof Error ? error.message : String(error) },
        })
        return
      }
      const result = await handleNodeApi({
        method: request.method ?? 'GET',
        path: decoded,
        query: url.searchParams,
        body,
      }, deps)
      writeResponse(response, result)
    },
  }))
}
