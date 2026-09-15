/**
 * The login environment, end to end and without a profile of this machine's
 * own.
 *
 * `ensureAgent` runs the real start command through the real shell on this
 * machine — only `ssh` is replaced, by a runner that executes each command
 * locally under a temporary `$HOME`. A temporary "login shell" stands in for
 * the account's profile and its interactive guard: like the node's `.bashrc`,
 * which returns early unless `$-` contains `i` and only then adds
 * `~/.local/bin`, it extends PATH with a marker directory only when the shell
 * was asked to be interactive. The suite proves that environment reaches the
 * agent and every process it spawns, without depending on whatever the
 * developer's own profile happens to contain — and, because the guard is real,
 * without a start command that quietly skips the interactive branch.
 *
 * The second half pins the other side of the launch recipe: a machine whose
 * recorded recipe no longer matches is restarted, not reused.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentBinaryPath } from '../agent-binary.ts'
import {
  AGENT_VERSION,
  LAUNCH_RECIPE_VERSION,
  ensureAgent,
} from '../../src/remote/agent/install.ts'
import type { AgentCommandRunner, AgentEndpoint } from '../../src/remote/agent/install.ts'
import type { SshCommandResult, SshTarget } from '../../src/remote/ssh.ts'
import { connectNode } from '../../src/remote/client.ts'
import type { ConnectedNode } from '../../src/remote/client.ts'
import type { AnchorRoute } from '../../src/storage/anchors.ts'
import { createRoutingSubprocessRuntime } from '../../src/plugin/routing/subprocess.ts'
import { asNodeId } from '../../src/storage/nodes.ts'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

const TOKEN = 'launch-env-token-0123456789'
const MARKER_TOOL = 'drw-login-marker'
const MARKER_OUTPUT = 'set-by-the-login-shell'
const SSH: SshTarget = { target: 'localhost' }

let home: string
let remoteRoot: string
let loginShell: string
let markerTool: string
let run: AgentCommandRunner
let binary: Buffer
let endpoint: AgentEndpoint
const nodes: ConnectedNode[] = []

/** The agent directory under the fake home. */
function agentDir(): string {
  return join(home, '.dsh', 'remote-agent')
}

/** One published state document. */
interface State {
  readonly pid: number
  readonly port: number
  readonly version: string
}

/** Read the state file the agent published. */
async function readState(): Promise<State> {
  return JSON.parse(await readFile(join(agentDir(), 'state.json'), 'utf8')) as State
}

/** Whether a pid still answers `kill -0`, after giving the kernel a moment to reap. */
async function gone(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/**
 * Run one remote command on "the node": this machine, under the fake home.
 *
 * This is the whole of the SSH stand-in. The command text is exactly what a
 * machine would receive, so the login shell, the resolution, and the launch are
 * all the real ones.
 */
function localRunner(env: NodeJS.ProcessEnv): AgentCommandRunner {
  return (_ssh, command, options) => new Promise<SshCommandResult>((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => { resolve({ code: code ?? 0, stdout, stderr }) })
    child.stdin.on('error', () => {})
    child.stdin.end(options?.input)
  })
}

/** A local delegate that fails loudly if the remote branch ever reaches it. */
const localDelegate = new Proxy({}, {
  get(_target, property) {
    return () => {
      throw new Error(`the local subprocess delegate was reached for "${String(property)}"`)
    }
  },
}) as unknown as SubprocessRuntime

/** The options every ensure call in this suite shares. */
function ensureOptions(): Parameters<typeof ensureAgent>[0] {
  return {
    ssh: SSH,
    token: TOKEN,
    version: AGENT_VERSION,
    cacheDir: join(home, 'cache'),
    run,
    resolveBinary: () => Promise.resolve(binary),
    // The seam: the machine is told which login shell to run instead of
    // resolving the account's own, so the temporary one stands in for a profile.
    loginShell,
    startTimeoutMs: 30_000,
    pollMs: 50,
  }
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'drw-launch-home-'))
  remoteRoot = await mkdtemp(join(tmpdir(), 'drw-launch-root-'))
  const markerDir = join(home, 'login-bin')
  markerTool = join(markerDir, MARKER_TOOL)
  await mkdir(markerDir, { recursive: true })
  await writeFile(markerTool, `#!/bin/sh\nprintf %s '${MARKER_OUTPUT}'\n`, 'utf8')
  await chmod(markerTool, 0o755)
  loginShell = join(home, 'login-shell')
  await writeFile(loginShell, [
    '#!/bin/sh',
    '# A stand-in for the account\'s login shell and the profile it reads: like',
    '# the node\'s .bashrc, its PATH entry is added only in an interactive shell.',
    '# A script receives the flag cluster as an argument rather than in its own',
    '# `$-`, so the guard reads the invocation and then hands it to the real',
    '# shell. The banner stands for oh-my-bash or theme output: it must land in',
    '# agent.log and change nothing the start path reads.',
    'case "$1" in',
    `  *i*) PATH="${markerDir}:$PATH"; export PATH; echo 'banner from the login profile';;`,
    'esac',
    'exec /bin/sh "$@"',
    '',
  ].join('\n'), 'utf8')
  await chmod(loginShell, 0o755)
  binary = await readFile(agentBinaryPath())
  run = localRunner({ ...process.env, HOME: home })
  endpoint = await ensureAgent(ensureOptions())
})

after(async () => {
  for (const node of nodes) node.close()
  // The agent outlives the SSH channel by design, so the suite must reap the
  // one still running before its state file is swept away with the fake home.
  try {
    process.kill((await readState()).pid, 'SIGKILL')
  } catch {
    // No agent was started, or it already exited.
  }
  await rm(home, { recursive: true, force: true })
  await rm(remoteRoot, { recursive: true, force: true })
})

test('a command the agent spawns sees the interactive login shell PATH entry', async () => {
  assert.equal(endpoint.reused, false)
  assert.equal(endpoint.version, AGENT_VERSION)

  const node = await connectNode({
    host: '127.0.0.1',
    port: endpoint.port,
    token: TOKEN,
    timeoutMs: 5_000,
  })
  nodes.push(node)

  const anchors: AnchorRoute[] = [{ nodeId: asNodeId('n1'), anchorPath: remoteRoot, remoteRoot }]
  const runtime = createRoutingSubprocessRuntime({
    localProc: localDelegate,
    anchors: () => anchors,
    channel: id => (id === 'n1' ? node.channel : undefined),
  })

  const handle = runtime.spawn({
    argv: ['/bin/sh', '-c', `command -v ${MARKER_TOOL}`],
    cwd: remoteRoot,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 16 }, stderr: { maxBytes: 1 << 16 } },
    graceMs: 2_000,
  })
  await handle.done

  assert.equal(handle.collected.stdout?.readFrom(0).text.trim(), markerTool)
})

test('a changed launch recipe restarts the running agent instead of reusing it', async () => {
  const original = await readState()
  const markerFile = join(agentDir(), 'launch-env.json')
  assert.equal(
    (JSON.parse(await readFile(markerFile, 'utf8')) as { recipe: number }).recipe,
    LAUNCH_RECIPE_VERSION,
  )
  // Stand in for a plugin whose start recipe changed: the running agent is the
  // same build, but it was launched the old way.
  await writeFile(markerFile, JSON.stringify({ recipe: LAUNCH_RECIPE_VERSION + 1 }), 'utf8')

  const second = await ensureAgent(ensureOptions())
  assert.equal(second.reused, false)

  const restarted = await readState()
  assert.notEqual(restarted.pid, original.pid)
  assert.equal(await gone(original.pid), true)
  assert.equal(
    (JSON.parse(await readFile(markerFile, 'utf8')) as { recipe: number }).recipe,
    LAUNCH_RECIPE_VERSION,
  )
})
