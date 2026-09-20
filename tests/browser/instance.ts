/**
 * One disposable DSH deployment that runs this plugin for a browser test.
 *
 * The instance is isolated from the operator's own harness in every way that
 * matters: a temporary `DSH_HOME` (so the node registry, repositories, and
 * anchors live and die with the test), its own port, and its own daemon process
 * serving a temporary root. The profile is copied from the operator's `web`
 * profile, and the plugin's `link:` symlink inside that copy is rewritten to
 * this checkout so the instance loads the code under test.
 *
 * The daemon is reached over the plugin's `direct` transport, which is the
 * record shape a document written before the SSH transport carries. That keeps
 * the whole management path real — handshake, directory browsing, repository
 * state, worktree lifecycle — without requiring an SSH server on this machine;
 * the SSH forward itself is covered by `tests/unit/ssh.test.ts`.
 *
 * @module dsh-remote-workspace/tests/browser/instance
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, Socket } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { agentBinaryPath } from '../agent-binary.ts'

const run = promisify(execFile)

/** Where this machine keeps the harness checkout the CLI boots from. */
const DEFAULT_CHECKOUT = '/Users/lzy/Projects/deepseek-harness'

/** The pnpm launcher the operator's own harness runs through. */
const PNPM = join(homedir(), '.local', 'bin', 'pnpm')

/** The plugin's profile name inside the copied home. */
const PROFILE = 'web'

/** A running deployment, plus everything a test needs to address it. */
export interface E2eInstance {
  /** Base URL of the management API. */
  readonly apiBase: string
  /** The shell URL carrying the trust token the fence demands. */
  readonly pageUrl: string
  /** The machine id the seeded record carries. */
  readonly nodeId: string
  /** Absolute POSIX path of the fixture repository on the daemon's machine. */
  readonly repoPath: string
  /** A directory on the same machine that is not a git repository yet. */
  readonly plainDir: string
  /** Absolute path of a fixture repository on this host, for the local machine. */
  readonly localRepo: string
  /** Local directory the remote world maps onto inside the anchor store. */
  readonly home: string
  /** Home directory both processes see, which is where checkouts land. */
  readonly userHome: string
  /** Scratch directory holding the home, the remote root, and artifacts. */
  readonly root: string
  /** Directory artifacts such as screenshots are written to. */
  readonly artifacts: string
  /** Port the daemon listens on. */
  readonly daemonPort: number
  /** Everything the two processes wrote, for a failure report. */
  logs(): string
  /** Process-group leader of the daemon and of the web process, in that order. */
  readonly pids: readonly number[]
  /**
   * Stop both processes and delete the scratch directory.
   * @param options - `keep` retains the scratch directory; `leave` keeps the
   *   daemon and the web server running so an operator can open the instance,
   *   and prints nothing — the caller reports the URLs.
   */
  stop(options?: { readonly keep?: boolean; readonly leave?: boolean }): Promise<void>
}

/**
 * Build the deployment and wait until its management route answers.
 * @param options - optional overrides for paths and settings.
 * @returns the running instance.
 */
export async function startInstance(startOptions: {
  /** The checkout the CLI runs from. Defaults to this machine's harness. */
  readonly checkout?: string
  /** Keep the scratch directory after `stop()`. Defaults to false. */
  readonly keep?: boolean
} = {}): Promise<E2eInstance> {
  const checkout = startOptions.checkout ?? process.env['RWT_DSH_CHECKOUT'] ?? DEFAULT_CHECKOUT
  const root = await mkdtemp(join(tmpdir(), 'rwt-e2e-'))
  // A failed deployment must not outlive the call: the daemon and the web
  // process are detached so their groups can be signalled, which also means
  // nothing else will collect them if this function throws half-built.
  const spawned: ChildProcess[] = []
  try {
    return await deploy(root, checkout, startOptions, spawned)
  } catch (error) {
    for (const child of spawned) kill(child)
    await delay(500)
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

/**
 * Build one deployment inside an already-created scratch directory.
 * @param root - the scratch directory.
 * @param checkout - the harness checkout the CLI boots from.
 * @param startOptions - the caller's overrides.
 * @param spawned - collects every child so the caller can reap them.
 * @returns the running instance.
 */
async function deploy(
  root: string,
  checkout: string,
  startOptions: { readonly keep?: boolean },
  spawned: ChildProcess[],
): Promise<E2eInstance> {
  const home = join(root, 'home')
  const userHomeDir = join(root, 'user-home')
  const remoteRoot = join(root, 'remote-root')
  const artifacts = join(root, 'artifacts')
  const daemonPort = await freePort()
  const webPort = await freePort()
  const nodeId = 'e2e-node'
  const token = `e2e-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`

  await mkdir(artifacts, { recursive: true })
  await mkdir(remoteRoot, { recursive: true })
  // Both processes take this as `$HOME`, so a machine's default worktree root
  // (`~/.dsh/worktrees`) lands inside the scratch directory instead of the
  // operator's own home. Resolved, because a real home is: the scratch `/var`
  // is a link, and git records the checkouts it creates under the real path.
  await mkdir(userHomeDir, { recursive: true })
  const userHome = await realpath(userHomeDir)
  const repoPath = await createFixtureRepo(join(remoteRoot, 'demo-repo'))
  // A checkout this plugin never cut, outside the root it cuts into: the panel
  // can only reach it by adopting what git lists.
  await run('git', ['worktree', 'add', '-b', 'worktree/hand', join(remoteRoot, 'hand-cut')], { cwd: repoPath })
  // Beside the repository, a directory nobody has initialized: the plugin has
  // to accept it as a plain directory and keep accepting it after `git init`.
  // Resolved for the same reason the repository path is: a management response
  // carries the canonical spelling, and on macOS the scratch `/var` is a link.
  await mkdir(join(remoteRoot, 'plain-dir'), { recursive: true })
  const plainDir = await realpath(join(remoteRoot, 'plain-dir'))
  await writeFile(join(plainDir, 'notes.md'), 'plain\n', 'utf8')
  // A repository of this host's own, which is what the built-in local machine
  // manages: the same lifecycle, run where the checkout already is.
  const localRepo = await createFixtureRepo(join(root, 'local-repo'))

  await cp(join(homedir(), '.dsh', 'profiles'), join(home, 'profiles'), { recursive: true })
  // The copy may name this checkout by its scoped package or the bare one,
  // depending on when the operator installed it, so both spellings point here.
  for (const name of ['@lengmoxxl/dsh-remote-workspace', 'dsh-remote-workspace']) {
    const linked = join(home, 'profiles', PROFILE, 'node_modules', name)
    await mkdir(dirname(linked), { recursive: true })
    await rm(linked, { force: true })
    await symlink(process.cwd(), linked, 'dir')
  }

  const registryDir = join(home, 'remote-worktrees')
  await mkdir(registryDir, { recursive: true })
  const stamp = new Date().toISOString()
  await writeFile(join(registryDir, 'nodes.json'), `${JSON.stringify({
    version: 2,
    nodes: [{
      nodeId,
      title: 'e2e daemon',
      transport: { kind: 'direct', host: '127.0.0.1', port: daemonPort },
      token,
      createdAt: stamp,
      updatedAt: stamp,
    }],
  }, null, 2)}\n`)

  const tokenFile = join(root, 'daemon-token')
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 })

  const logs: string[] = []
  const daemon = spawn(agentBinaryPath(), [
    '--listen', `127.0.0.1:${String(daemonPort)}`,
    '--token-file', tokenFile,
    '--root', remoteRoot,
  ], { detached: true, env: { ...process.env, HOME: userHome }, stdio: ['ignore', 'pipe', 'pipe'] })
  spawned.push(daemon)
  capture(daemon, logs, '[daemon] ')
  await waitForPort(daemonPort)

  const web = spawn(process.execPath, [PNPM, 'dsh', 'web', '--port', String(webPort), '--no-open'], {
    cwd: checkout,
    detached: true,
    env: { ...process.env, DSH_HOME: home, HOME: userHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  spawned.push(web)
  capture(web, logs, '[dsh] ')

  const apiBase = `http://127.0.0.1:${String(webPort)}/dsh-remote-workspace`
  const pageUrl = `http://127.0.0.1:${String(webPort)}/?token=${await waitForToken(web, logs)}`
  await waitForApi(apiBase)

  return {
    apiBase,
    pageUrl,
    nodeId,
    repoPath,
    plainDir,
    localRepo,
    home,
    userHome,
    root,
    artifacts,
    daemonPort,
    logs: () => logs.join(''),
    pids: [daemon.pid, web.pid].filter((pid): pid is number => pid !== undefined),
    async stop(options = {}) {
      const keep = options.keep === true || startOptions.keep === true || process.env['RWT_KEEP'] === '1'
      const leave = options.leave === true || process.env['RWT_LEAVE'] === '1'
      if (!leave) {
        kill(web)
        kill(daemon)
        await delay(500)
      } else {
        // Piped stdio keeps the test process alive after it finishes; unref the
        // children and their pipes so the deployment outlives the run.
        for (const child of [daemon, web]) {
          child.unref()
          for (const stream of [child.stdout, child.stderr]) {
            const unref = (stream as unknown as { unref?: () => void } | null)?.unref
            if (typeof unref === 'function') unref.call(stream)
          }
        }
      }
      if (!keep && !leave) await rm(root, { recursive: true, force: true })
    },
  }
}

/**
 * Create a git repository with one commit, so the daemon can report its branch
 * and cut a worktree from it.
 * @param path - directory to create the repository in.
 * @returns the repository's canonical absolute path, which is what the daemon
 *   reports back: on macOS the scratch directory's `/var` is a symlink, so the
 *   resolved form is the one every management response carries.
 */
export async function createFixtureRepo(path: string): Promise<string> {
  await mkdir(path, { recursive: true })
  await run('git', ['-c', 'init.defaultBranch=main', 'init'], { cwd: path })
  await writeFile(join(path, 'README.md'), '# fixture\n')
  await run('git', ['add', 'README.md'], { cwd: path })
  await run('git', [
    '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com',
    'commit', '-m', 'fixture',
  ], { cwd: path })
  return await realpath(path)
}

/** Reserve a free loopback port. */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('no port was bound'))
        return
      }
      const { port } = address
      server.close(() => { resolve(port) })
    })
  })
}

/** Wait until a TCP port accepts connections. */
async function waitForPort(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const open = await new Promise<boolean>(resolve => {
      const socket = new Socket()
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => { resolve(false) })
      socket.connect(port, '127.0.0.1')
    })
    if (open) return
    if (Date.now() > deadline) throw new Error(`port ${String(port)} never opened`)
    await delay(200)
  }
}

/** Read the trust token the shell prints on boot. */
async function waitForToken(web: ChildProcess, logs: string[], timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const match = /[?&]token=([\w-]+)/.exec(logs.join(''))
    if (match?.[1] !== undefined) return match[1]
    if (web.exitCode !== null) throw new Error(`dsh web exited with ${String(web.exitCode)}:\n${logs.join('')}`)
    if (Date.now() > deadline) throw new Error(`dsh web never printed its URL:\n${logs.join('')}`)
    await delay(250)
  }
}

/** Wait until the plugin's management route answers. */
async function waitForApi(apiBase: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(`${apiBase}/nodes`)
      if (response.ok) return
    } catch {
      // The server is still binding.
    }
    if (Date.now() > deadline) throw new Error(`${apiBase} never answered`)
    await delay(250)
  }
}

/** Forward a child's output into the shared log. */
function capture(child: ChildProcess, logs: string[], prefix: string): void {
  const collect = (chunk: Buffer): void => { logs.push(`${prefix}${chunk.toString('utf8')}`) }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
}

/** Stop a detached child together with anything it started. */
function kill(child: ChildProcess): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

/** Wait for a bounded interval. */
async function delay(ms: number): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(resolve, ms) })
}
