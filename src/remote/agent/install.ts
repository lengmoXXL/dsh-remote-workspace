/**
 * Ensure the right agent is installed and running on one machine.
 *
 * A machine is configured by its SSH destination and a token, nothing else:
 * the plugin resolves the platform, downloads the matching binary if this
 * machine does not already run the expected build, uploads it over the same
 * SSH connection, and starts it detached. The agent then binds a random
 * loopback port and publishes it in `state.json`, which is where the forward
 * learns where to point.
 *
 * Reuse is decided from that state file and one marker beside the binary: a live
 * process running the expected build, started with the current launch recipe, is
 * left untouched, and the caller's own handshake is the real liveness check, so
 * this module never opens a TCP probe from the host.
 *
 * The agent is started through the account's interactive login shell rather
 * than directly, because the SSH command that reaches this module runs under
 * sshd, whose environment is minimal, and because rc files routinely hide their
 * PATH setup behind an interactive guard. Without the login shell the daemon
 * would inherit that minimal environment and pass it on to everything it starts
 * — the routing subprocess, git, and the Sidebar terminal — so a PATH the
 * profile extends or the user's own `SHELL` would never arrive. A launch-recipe
 * marker beside the binary is what keeps that from going stale: a machine still
 * running an agent started the old way is restarted instead of reused.
 *
 * Every remote snippet below is shaped for the same three reasons: bytes the
 * plugin owns travel on stdin rather than in the command string, where shell
 * quoting would mangle them and a token would become visible in `ps`; the
 * agent's stdio is redirected away from the SSH channel so `ssh` does not wait
 * on a process meant to outlive it; and `setsid`/`nohup` detach that process
 * from a session that is about to end.
 *
 * @module dsh-remote-workspace/remote/agent/install
 */

import { PTC_HOST_MEMBER, agentAssetName, ptcHostAssetName, resolveAgentBinary } from './release.ts'
import type { AgentBinaryOptions } from './release.ts'
import type { SshCommandResult, SshRunOptions, SshTarget } from '../ssh.ts'
import { runSsh, sshFailure } from '../ssh.ts'

/**
 * Agent build this plugin installs on every machine it reaches.
 *
 * A single constant, not a config knob: the plugin and the release it
 * downloads are one artifact, and a plugin that let a deployment name a
 * different build would be describing a wire contract it cannot check. Bump
 * this together with the release tag and `agent/Cargo.toml`, which a unit test
 * keeps in step.
 */
export const AGENT_VERSION = '0.0.6'

/**
 * Version of the launch recipe recorded in `launch-env.json`.
 *
 * The recipe is how the agent was started, not which build it runs: the
 * environment a start hands the agent is what everything it later spawns
 * inherits. Bump this whenever {@link startAgentCommand} changes what
 * environment that is, so a machine left running an agent from the previous
 * recipe is restarted rather than reused.
 */
export const LAUNCH_RECIPE_VERSION = 2

/** A started agent, and where a forward can reach it. */
export interface AgentEndpoint {
  /** Loopback port the agent published. */
  readonly port: number
  /** Agent build the endpoint runs. */
  readonly version: string
  /** Whether an agent already running the expected build was left alone. */
  readonly reused: boolean
}

/**
 * What an install or update is doing, for a surface that can show it.
 *
 * The plugin runs this while the user waits on a connection, so the phase is
 * what a status line reports. `source` separates a cached fetch from a network
 * one because the two look identical from the outside and take very different
 * amounts of time.
 */
export interface AgentProgress {
  /** The step in flight. */
  readonly phase: 'checking' | 'reusing' | 'fetching' | 'uploading' | 'starting'
  /** Agent build the step concerns. */
  readonly version: string
  /** Release asset being fetched; present while `phase` is `fetching`. */
  readonly asset?: string
  /** Where the bytes came from, once the cache has been consulted. */
  readonly source?: 'cache' | 'network'
}

/** Runs one remote command; injectable so tests need no `ssh` process. */
export type AgentCommandRunner = (
  ssh: SshTarget,
  command: string,
  options?: SshRunOptions,
) => Promise<SshCommandResult>

/** What {@link ensureAgent} needs from its caller. */
export interface EnsureAgentOptions {
  /** The machine to install onto. */
  readonly ssh: SshTarget
  /** Shared secret the agent authenticates callers with. */
  readonly token: string
  /** Agent build to install and run. */
  readonly version: string
  /** Host directory holding cached agent binaries. */
  readonly cacheDir: string
  /** Command runner; defaults to {@link runSsh}. */
  readonly run?: AgentCommandRunner
  /** Binary resolver; defaults to {@link resolveAgentBinary}. */
  readonly resolveBinary?: (options: AgentBinaryOptions) => Promise<Buffer>
  /**
   * Login shell the start command uses instead of resolving the account's own.
   *
   * A test seam: a deployment never sets it, and production resolves `$SHELL`,
   * then the passwd entry, then `bash`, then `sh` on the machine.
   */
  readonly loginShell?: string
  /** Receives each step as it starts; omitted stays silent. */
  readonly onProgress?: (progress: AgentProgress) => void
  /** Budget for a fresh agent to publish its state, in milliseconds. */
  readonly startTimeoutMs?: number
  /** Gap between state-file polls, in milliseconds. */
  readonly pollMs?: number
}

/**
 * How long a freshly started agent may take to publish `state.json`. Generous
 * enough for a slow link, short enough that a binary that cannot exec is
 * reported rather than waited on.
 */
const DEFAULT_AGENT_START_TIMEOUT_MS = 10_000

/** Default gap between state-file polls. */
const START_POLL_MS = 120

/**
 * Read the state file; `|| true` keeps a machine that has never run the agent
 * from reading as a failed command, which is an expected state, not an error.
 */
const READ_STATE = 'cat "$HOME/.dsh/remote-agent/state.json" 2>/dev/null || true'

/** Read the plugin's own marker for which build it installed. */
const READ_INSTALLED = 'cat "$HOME/.dsh/remote-agent/installed.json" 2>/dev/null || true'

/** Read the plugin's own marker for how the running agent was launched. */
const READ_LAUNCH_ENV = 'cat "$HOME/.dsh/remote-agent/launch-env.json" 2>/dev/null || true'

/**
 * Read the PTC program host's marker, but only while its binary is still
 * executable.
 *
 * One round trip answers both halves of the reuse question: an executable with
 * a matching marker is the build this plugin installed, and anything else — a
 * missing binary, a stale marker, a half-written upload — is a fresh install.
 */
const READ_PTC_HOST = 'test -x "$HOME/.dsh/remote-agent/dsh-ptc-host"'
  + ' && cat "$HOME/.dsh/remote-agent/ptc-host.json" 2>/dev/null || true'

/** Seed the agent directory before anything is written into it. */
const ENSURE_DIR = 'mkdir -p "$HOME/.dsh/remote-agent"'

/**
 * Replace the binary through a temp name, so a crash or a killed connection
 * never leaves a half-written executable in place, and stamp the executable
 * bit. The bytes arrive on stdin: a buffer interpolated into the command would
 * be mangled by the remote shell.
 */
const UPLOAD_BINARY = 'cat > "$HOME/.dsh/remote-agent/dsh-remote-agent.new"'
  + ' && chmod 755 "$HOME/.dsh/remote-agent/dsh-remote-agent.new"'
  + ' && mv "$HOME/.dsh/remote-agent/dsh-remote-agent.new" "$HOME/.dsh/remote-agent/dsh-remote-agent"'

/** Record which build the step above installed, so a version bump reinstalls. */
const WRITE_INSTALLED = 'cat > "$HOME/.dsh/remote-agent/installed.json"'

/** Write the secret on stdin too, and keep it owner-only. */
const WRITE_TOKEN = 'cat > "$HOME/.dsh/remote-agent/token" && chmod 600 "$HOME/.dsh/remote-agent/token"'

/** Record how the agent was launched, so a changed recipe forces a restart. */
const WRITE_LAUNCH_ENV = 'cat > "$HOME/.dsh/remote-agent/launch-env.json"'

/** Replace the PTC program host through a temp name, exactly as the agent is. */
const UPLOAD_PTC_HOST = 'cat > "$HOME/.dsh/remote-agent/dsh-ptc-host.new"'
  + ' && chmod 755 "$HOME/.dsh/remote-agent/dsh-ptc-host.new"'
  + ' && mv "$HOME/.dsh/remote-agent/dsh-ptc-host.new" "$HOME/.dsh/remote-agent/dsh-ptc-host"'

/** Record which PTC program host build the step above installed. */
const WRITE_PTC_HOST = 'cat > "$HOME/.dsh/remote-agent/ptc-host.json"'

/**
 * The agent invocation, run with `exec` from inside the interactive login shell.
 *
 * Quoted as one word so the outer non-interactive shell hands it to the login
 * shell untouched; it holds no single quote of its own. The paths stay relative
 * because the start command changed into the agent directory, and the login
 * shell inherits that directory.
 */
const AGENT_UNDER_LOGIN_SHELL =
  "'exec ./dsh-remote-agent --listen 127.0.0.1:0 --token-file token --state-file state.json'"

/**
 * Quote one string as a single POSIX shell word.
 * @param value - the literal text to quote.
 * @returns the quoted word.
 */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Build the command that starts the agent through the account's login shell.
 *
 * The shell is resolved on the machine in the order a person would expect:
 * {@link EnsureAgentOptions.loginShell} when a test names one, then `$SHELL`,
 * then the passwd entry (`getent` on Linux, `dscl` on Darwin), then `bash`, then
 * `sh`. `exec` inside `-ilc` replaces that login shell with the agent, so the
 * agent's environment is the login environment, its pid is the pid the state
 * file publishes, and it stays the session leader `setsid` created.
 *
 * The `i` is the whole point of the recipe: rc files commonly hide their PATH
 * setup behind an interactive guard — the node's `~/.bashrc` returns early
 * unless `$-` contains `i`, and only then adds `~/.local/bin` — so a
 * non-interactive login shell silently drops exactly the tool directories the
 * agent's commands need. VS Code's remote resolver runs the interactive login
 * shell for the same reason. Banners and job-control warnings an interactive
 * shell may print are harmless: they follow the same `agent.log` redirection,
 * the state file is read from disk, and the handshake runs over the socket.
 *
 * The start itself is unchanged: `setsid` gives the agent a session of its own
 * where the machine has it, `nohup` survives the hangup either way, every
 * stream goes to the log or `/dev/null` so `ssh` does not wait on a process
 * meant to outlive it, and `exit 0` keeps a successful backgrounding from
 * reading as a failed command.
 * @param loginShell - the shell to force, or undefined to resolve the account's.
 * @returns the command string the remote shell runs.
 */
function startAgentCommand(loginShell?: string): string {
  const seed = loginShell === undefined ? '"$SHELL"' : shQuote(loginShell)
  const launch = `"$agent_shell" -ilc ${AGENT_UNDER_LOGIN_SHELL} >>agent.log 2>&1 </dev/null &`
  return 'cd "$HOME/.dsh/remote-agent" && {'
    + ` agent_shell=${seed};`
    + ' if [ ! -x "$agent_shell" ]; then agent_shell="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)"; fi;'
    + ' if [ ! -x "$agent_shell" ]; then agent_shell="$(dscl . -read "/Users/$(id -un)" UserShell 2>/dev/null | awk \'NR==1 {print $2}\')"; fi;'
    + ' if [ ! -x "$agent_shell" ]; then agent_shell="$(command -v bash)"; fi;'
    + ' if [ ! -x "$agent_shell" ]; then agent_shell="$(command -v sh)"; fi;'
    + ` if command -v setsid >/dev/null 2>&1; then setsid nohup ${launch}`
    + ` else nohup ${launch} fi;`
    + ' }; exit 0'
}

/** The subset of the agent's published state this module reads. */
interface AgentState {
  readonly pid: number
  readonly port: number
  readonly version: string
}

/**
 * Parse the agent's state file.
 * @param stdout - the file's contents, or empty when it is absent.
 * @returns the fields a reuse decision needs, or undefined when unusable.
 */
function parseState(stdout: string): AgentState | undefined {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const state = value as Record<string, unknown>
  const { pid, port, version } = state
  if (typeof version !== 'string' || version === '') return undefined
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) return undefined
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined
  return { pid, port, version }
}

/** Read and parse the state file. */
async function readState(
  run: AgentCommandRunner,
  ssh: SshTarget,
): Promise<AgentState | undefined> {
  const result = await run(ssh, READ_STATE)
  return parseState(result.stdout)
}

/**
 * Run one command the install cannot continue without, and fail with the
 * shared SSH diagnostic rather than letting a silent non-zero exit surface
 * later as an unexplained timeout.
 * @param run - the command runner.
 * @param ssh - the machine to reach.
 * @param command - the command string to run.
 * @param fallback - what to say when the failure has no known remedy.
 * @param input - optional stdin bytes.
 * @throws when the command exits non-zero.
 */
async function runChecked(
  run: AgentCommandRunner,
  ssh: SshTarget,
  command: string,
  fallback: string,
  input?: Buffer | string,
): Promise<void> {
  const result = await (input === undefined ? run(ssh, command) : run(ssh, command, { input }))
  if (result.code !== 0) throw new Error(sshFailure(ssh.target, result.stderr, fallback))
}

/** The version one of this plugin's own marker files records, when it records one. */
function markerVersion(stdout: string): string | undefined {
  try {
    const marker = JSON.parse(stdout) as { version?: unknown }
    return typeof marker.version === 'string' ? marker.version : undefined
  } catch {
    return undefined
  }
}

/** Read the version marker the plugin writes beside the agent binary. */
async function installedVersion(
  run: AgentCommandRunner,
  ssh: SshTarget,
): Promise<string | undefined> {
  const result = await run(ssh, READ_INSTALLED)
  return result.code === 0 ? markerVersion(result.stdout) : undefined
}

/** Whether a process id is still alive on the machine, best effort. */
async function isAlive(
  run: AgentCommandRunner,
  ssh: SshTarget,
  pid: number,
): Promise<boolean> {
  try {
    return (await run(ssh, `kill -0 ${String(pid)}`)).code === 0
  } catch {
    return false
  }
}

/** Whether the machine records this plugin's current launch recipe. */
async function launchRecipeMatches(run: AgentCommandRunner, ssh: SshTarget): Promise<boolean> {
  const result = await run(ssh, READ_LAUNCH_ENV)
  if (result.code !== 0) return false
  try {
    const marker = JSON.parse(result.stdout) as { recipe?: unknown }
    return marker.recipe === LAUNCH_RECIPE_VERSION
  } catch {
    return false
  }
}

/**
 * Ensure the agent is installed and running on one machine.
 * @param options - the machine, token, version, cache, and optional seams.
 * @returns the port and build the machine's agent is serving on.
 * @throws when the platform cannot be resolved, the binary cannot be fetched,
 *   a remote command fails, or a started agent never publishes its state.
 */
export async function ensureAgent(options: EnsureAgentOptions): Promise<AgentEndpoint> {
  const run = options.run ?? runSsh
  const resolveBinary = options.resolveBinary ?? resolveAgentBinary
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_AGENT_START_TIMEOUT_MS
  const pollMs = options.pollMs ?? START_POLL_MS
  const { ssh, token, version, cacheDir } = options
  const report = options.onProgress ?? (() => {})
  report({ phase: 'checking', version })

  // The platform is read once per call: every branch below either returns or
  // installs, so a second round trip would buy nothing.
  const uname = await run(ssh, 'uname -s; uname -m')
  if (uname.code !== 0) {
    throw new Error(
      sshFailure(ssh.target, uname.stderr, `could not read the platform of "${ssh.target}"`),
    )
  }
  const [platform, arch] = uname.stdout.split('\n')
  const assetName = agentAssetName(platform?.trim() ?? '', arch?.trim() ?? '')

  const state = await readState(run, ssh)
  // A pid that does not answer `kill -0` is a stale state file, not a running
  // agent; a pid that does is a process the install below must replace.
  const runningPid = state !== undefined && await isAlive(run, ssh, state.pid) ? state.pid : undefined
  // The recipe is read only where a reuse could happen, so the common path that
  // installs or replaces an agent pays for no extra round trip. It answers
  // whether the live agent's environment is the one this plugin would start.
  if (state !== undefined && runningPid === state.pid && state.version === version
    && await launchRecipeMatches(run, ssh)) {
    report({ phase: 'reusing', version })
    return { port: state.port, version, reused: true }
  }
  // A state file left by the agent being replaced still names its pid and port.
  // Waiting for a different pid is what makes the poll below read the new
  // agent's publication rather than the one the start just superseded.
  const replacedPid = state?.pid

  await runChecked(run, ssh, ENSURE_DIR, `could not create ~/.dsh/remote-agent on "${ssh.target}"`)

  if (await installedVersion(run, ssh) !== version) {
    report({ phase: 'fetching', version, asset: assetName })
    const binary = await resolveBinary({
      version,
      assetName,
      cacheDir,
      // The cache check is immediate, so this replaces the phase above with
      // one that says whether the wait will be a download or a local read.
      onSource: source => { report({ phase: 'fetching', version, asset: assetName, source }) },
    })
    report({ phase: 'uploading', version })
    await runChecked(
      run,
      ssh,
      UPLOAD_BINARY,
      `could not install the agent binary on "${ssh.target}"`,
      binary,
    )
    await runChecked(
      run,
      ssh,
      WRITE_INSTALLED,
      `could not record the installed agent version on "${ssh.target}"`,
      JSON.stringify({ version }),
    )
  }

  // The token is rewritten on every install path, so rotating it in the plugin
  // is enough to rotate it on the machine.
  await runChecked(run, ssh, WRITE_TOKEN, `could not write the agent token on "${ssh.target}"`, token)

  if (runningPid !== undefined) {
    // Best effort: the process is being replaced, and a kill that races its
    // own exit must not fail an install that is otherwise fine.
    await run(ssh, `kill ${String(runningPid)}`).catch(() => {})
  }

  report({ phase: 'starting', version })
  await runChecked(
    run,
    ssh,
    startAgentCommand(options.loginShell),
    `could not start the agent on "${ssh.target}"`,
  )

  const deadline = Date.now() + startTimeoutMs
  for (;;) {
    const published = await readState(run, ssh).catch(() => undefined)
    if (published !== undefined && published.version === version && published.port > 0
      && published.pid !== replacedPid) {
      // The recipe is recorded once an agent started this way is answering, so
      // the marker never describes a start that did not survive.
      await runChecked(
        run,
        ssh,
        WRITE_LAUNCH_ENV,
        `could not record the agent launch recipe on "${ssh.target}"`,
        JSON.stringify({ recipe: LAUNCH_RECIPE_VERSION }),
      )
      return { port: published.port, version, reused: false }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `the agent on "${ssh.target}" did not publish a port within ${String(startTimeoutMs)}ms; `
        + 'check ~/.dsh/remote-agent/agent.log on the machine',
      )
    }
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
}

/** What {@link ensurePtcHost} needs from its caller. */
export interface EnsurePtcHostOptions {
  /** The machine to install onto. */
  readonly ssh: SshTarget
  /** Build to install; the plugin uses its own agent version, which is one release. */
  readonly version: string
  /** Host directory holding cached release binaries. */
  readonly cacheDir: string
  /** Command runner; defaults to {@link runSsh}. */
  readonly run?: AgentCommandRunner
  /** Binary resolver; defaults to {@link resolveAgentBinary}. */
  readonly resolveBinary?: (options: AgentBinaryOptions) => Promise<Buffer>
}

/**
 * Ensure one machine carries this release's native PTC program host.
 *
 * A machine whose `run_code` runs in a routed workspace needs an interpreter
 * there, and the harness's PTC provider would otherwise launch Node. This
 * binary is that interpreter: the same process protocol, evaluated by an
 * embedded V8, so the machine needs no Node runtime of its own.
 *
 * It is installed beside the agent, in the background as soon as that machine
 * connects, so the first program run there does not wait on the download. A
 * machine that already holds the current build is left untouched, so the second
 * caller — the program that overtakes the warm-up — costs one round trip.
 * @param options - the machine, the build, and the binary cache.
 * @throws when the platform cannot be resolved, the archive cannot be fetched,
 *   or the upload fails.
 */
export async function ensurePtcHost(options: EnsurePtcHostOptions): Promise<void> {
  const run = options.run ?? runSsh
  const resolveBinary = options.resolveBinary ?? resolveAgentBinary
  const { ssh, version, cacheDir } = options

  const installed = await run(ssh, READ_PTC_HOST)
  if (installed.code === 0 && markerVersion(installed.stdout) === version) return

  // The archive name is chosen from what the machine reports, so the platform
  // is read before anything is fetched rather than guessed from this host.
  const uname = await run(ssh, 'uname -s; uname -m')
  if (uname.code !== 0) {
    throw new Error(
      sshFailure(ssh.target, uname.stderr, `could not read the platform of "${ssh.target}"`),
    )
  }
  const [platform, arch] = uname.stdout.split('\n')
  const assetName = ptcHostAssetName(platform?.trim() ?? '', arch?.trim() ?? '')
  const binary = await resolveBinary({
    version,
    assetName,
    member: PTC_HOST_MEMBER,
    cacheDir,
  })

  await runChecked(run, ssh, ENSURE_DIR, `could not create ~/.dsh/remote-agent on "${ssh.target}"`)
  await runChecked(
    run,
    ssh,
    UPLOAD_PTC_HOST,
    `could not install the PTC program host on "${ssh.target}"`,
    binary,
  )
  await runChecked(
    run,
    ssh,
    WRITE_PTC_HOST,
    `could not record the installed PTC program host on "${ssh.target}"`,
    JSON.stringify({ version }),
  )
}
