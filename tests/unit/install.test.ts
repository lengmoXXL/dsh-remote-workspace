/**
 * The install path is the one place the plugin mutates a machine, so its cases
 * are about what it must not do: reinstall a machine that is already running
 * the expected build, put a secret into a command string where `ps` can read
 * it, or report success for an agent that never published a port. Every remote
 * command is scripted, so none of this opens an SSH connection. The build it
 * names is pinned to the crate manifest here too, because a plugin that
 * expected a build the release does not carry would fail on every machine at
 * once.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import type { SshCommandResult, SshTarget } from '../../src/remote/ssh.ts'
import type { AgentBinaryOptions } from '../../src/remote/agent/release.ts'
import type { AgentCommandRunner, AgentProgress } from '../../src/remote/agent/install.ts'
import {
  AGENT_VERSION,
  LAUNCH_RECIPE_VERSION,
  ensureAgent,
  ensurePtcHost,
} from '../../src/remote/agent/install.ts'

const SSH: SshTarget = { target: 'me@build-01' }
const DIR = '$HOME/.dsh/remote-agent'

/** A scripted machine the injected runner reads and mutates. */
interface Machine {
  readonly commands: string[]
  readonly inputs: (Buffer | string | undefined)[]
  /** The state file's contents, absent until an agent publishes one. */
  state: string | undefined
  /** The plugin's version marker, absent until an install writes one. */
  installed: string | undefined
  /** The plugin's launch-recipe marker, absent until a start records one. */
  launchEnv: string | undefined
  /** Whether the PTC program-host binary is present and executable. */
  ptcHostBinary: boolean
  /** The PTC program-host marker, absent until an install writes one. */
  ptcHostMarker: string | undefined
  readonly alive: Set<number>
  /** Runs when the start command is issued, to publish a fresh state. */
  onStart?: () => void
}

/** A fresh, empty machine. */
function machine(): Machine {
  return {
    commands: [],
    inputs: [],
    state: undefined,
    installed: undefined,
    launchEnv: undefined,
    ptcHostBinary: false,
    ptcHostMarker: undefined,
    alive: new Set(),
  }
}

/** The marker a machine records when it started the agent with the current recipe. */
function currentRecipe(): string {
  return JSON.stringify({ recipe: LAUNCH_RECIPE_VERSION })
}

/** An agent state file for one build. */
function stateFile(version: string, pid: number, port: number): string {
  return JSON.stringify({ version, protocol: 1, pid, port, startedAt: '2026-01-01T00:00:00Z' })
}

/** The scripted runner; any command it does not know fails the test loudly. */
function runnerFor(machine: Machine): AgentCommandRunner {
  return (_ssh, command, options) => {
    machine.commands.push(command)
    machine.inputs.push(options?.input)
    const ok = (stdout = ''): SshCommandResult => ({ code: 0, stdout, stderr: '' })
    const exit = (code: number): SshCommandResult => ({ code, stdout: '', stderr: '' })

    if (command === 'uname -s; uname -m') return Promise.resolve(ok('Linux\nx86_64\n'))
    if (command === `cat "${DIR}/state.json" 2>/dev/null || true`) {
      return Promise.resolve(ok(machine.state ?? ''))
    }
    if (command === `cat "${DIR}/installed.json" 2>/dev/null || true`) {
      return Promise.resolve(ok(machine.installed ?? ''))
    }
    if (command === `cat "${DIR}/launch-env.json" 2>/dev/null || true`) {
      return Promise.resolve(ok(machine.launchEnv ?? ''))
    }
    if (command === `test -x "${DIR}/dsh-ptc-host" && cat "${DIR}/ptc-host.json" 2>/dev/null || true`) {
      return Promise.resolve(ok(machine.ptcHostBinary ? machine.ptcHostMarker ?? '' : ''))
    }
    if (command === `mkdir -p "${DIR}"`) return Promise.resolve(ok())
    if (command.startsWith(`cat > "${DIR}/dsh-ptc-host.new"`)) {
      machine.ptcHostBinary = true
      return Promise.resolve(ok())
    }
    if (command === `cat > "${DIR}/ptc-host.json"`) {
      machine.ptcHostMarker = String(options?.input ?? '')
      return Promise.resolve(ok())
    }
    if (command.startsWith(`cat > "${DIR}/dsh-remote-agent.new"`)) return Promise.resolve(ok())
    if (command === `cat > "${DIR}/installed.json"`) {
      machine.installed = String(options?.input ?? '')
      return Promise.resolve(ok())
    }
    if (command === `cat > "${DIR}/launch-env.json"`) {
      machine.launchEnv = String(options?.input ?? '')
      return Promise.resolve(ok())
    }
    if (command === `cat > "${DIR}/token" && chmod 600 "${DIR}/token"`) return Promise.resolve(ok())
    if (command.startsWith('kill -0 ')) {
      return Promise.resolve(exit(machine.alive.has(Number(command.slice('kill -0 '.length))) ? 0 : 1))
    }
    if (command.startsWith('kill ')) {
      machine.alive.delete(Number(command.slice('kill '.length)))
      return Promise.resolve(ok())
    }
    if (command.startsWith(`cd "${DIR}"`)) {
      machine.onStart?.()
      return Promise.resolve(ok())
    }
    return Promise.reject(new Error(`unexpected command: ${command}`))
  }
}

/** The index of the binary upload, or -1. */
function uploadIndex(machine: Machine): number {
  return machine.commands.findIndex(command => command.includes('dsh-remote-agent.new'))
}

/** The index of the PTC program-host upload, or -1. */
function ptcUploadIndex(machine: Machine): number {
  return machine.commands.findIndex(command => command.includes('dsh-ptc-host.new'))
}

test('the PTC program host is installed once and reused afterwards', async () => {
  const host = machine()
  const assets: string[] = []
  const resolveBinary = (options: AgentBinaryOptions): Promise<Buffer> => {
    assets.push(options.assetName)
    return Promise.resolve(Buffer.from('the worker bytes'))
  }

  await ensurePtcHost({
    ssh: SSH,
    version: AGENT_VERSION,
    cacheDir: '/cache',
    run: runnerFor(host),
    resolveBinary,
  })

  assert.deepEqual(assets, ['dsh-ptc-host-linux-x86_64'])
  assert.equal(host.inputs[ptcUploadIndex(host)]!.toString(), 'the worker bytes')
  assert.equal(host.ptcHostMarker, JSON.stringify({ version: AGENT_VERSION }))

  await ensurePtcHost({
    ssh: SSH,
    version: AGENT_VERSION,
    cacheDir: '/cache',
    run: runnerFor(host),
    resolveBinary,
  })

  assert.deepEqual(assets, ['dsh-ptc-host-linux-x86_64'], 'a matching marker stops the fetch')
  assert.equal(
    host.commands.filter(command => command.includes('dsh-ptc-host.new')).length,
    1,
    'and the upload too',
  )
})

test('an older PTC program host is replaced', async () => {
  const host = machine()
  host.ptcHostBinary = true
  host.ptcHostMarker = JSON.stringify({ version: '0.0.1' })

  await ensurePtcHost({
    ssh: SSH,
    version: AGENT_VERSION,
    cacheDir: '/cache',
    run: runnerFor(host),
    resolveBinary: () => Promise.resolve(Buffer.from('the newer worker')),
  })

  assert.equal(host.ptcHostMarker, JSON.stringify({ version: AGENT_VERSION }))
  assert.equal(host.inputs[ptcUploadIndex(host)]!.toString(), 'the newer worker')
})

test('an executable with no marker is reinstalled', async () => {
  const host = machine()
  host.ptcHostBinary = true

  await ensurePtcHost({
    ssh: SSH,
    version: AGENT_VERSION,
    cacheDir: '/cache',
    run: runnerFor(host),
    resolveBinary: () => Promise.resolve(Buffer.from('the worker bytes')),
  })

  assert.equal(host.ptcHostMarker, JSON.stringify({ version: AGENT_VERSION }))
  assert.equal(ptcUploadIndex(host) >= 0, true)
})

test('an agent already on the expected build is reused untouched', async () => {
  const host = machine()
  host.alive.add(4242)
  host.state = stateFile('0.0.1', 4242, 41_234)
  host.launchEnv = currentRecipe()
  let resolved = 0

  const endpoint = await ensureAgent({
    ssh: SSH,
    token: 'hunter2',
    version: '0.0.1',
    cacheDir: '/unused',
    run: runnerFor(host),
    resolveBinary: () => {
      resolved += 1
      return Promise.resolve(Buffer.from('binary'))
    },
  })

  assert.deepEqual(endpoint, { port: 41_234, version: '0.0.1', reused: true })
  assert.equal(resolved, 0)
  assert.equal(uploadIndex(host), -1)
  assert.equal(host.commands.some(command => command.startsWith(`cd "${DIR}"`)), false)
})

test('a matching state whose pid is gone is reinstalled rather than reused', async () => {
  const host = machine()
  host.state = stateFile('0.0.1', 4242, 41_234)
  let resolved = 0
  host.onStart = () => {
    host.alive.add(5252)
    host.state = stateFile('0.0.1', 5252, 41_235)
  }

  const endpoint = await ensureAgent({
    ssh: SSH,
    token: 't',
    version: '0.0.1',
    cacheDir: '/unused',
    run: runnerFor(host),
    resolveBinary: () => {
      resolved += 1
      return Promise.resolve(Buffer.from('binary'))
    },
    pollMs: 1,
  })

  assert.equal(endpoint.reused, false)
  assert.equal(resolved, 1)
})

test('a live agent launched by an older recipe is replaced, not reused', async () => {
  const host = machine()
  host.alive.add(4242)
  host.state = stateFile('0.0.1', 4242, 41_234)
  host.installed = JSON.stringify({ version: '0.0.1' })
  host.launchEnv = JSON.stringify({ recipe: LAUNCH_RECIPE_VERSION - 1 })
  let resolved = 0
  host.onStart = () => {
    host.alive.add(5253)
    host.state = stateFile('0.0.1', 5253, 41_236)
  }

  const endpoint = await ensureAgent({
    ssh: SSH,
    token: 't',
    version: '0.0.1',
    cacheDir: '/unused',
    run: runnerFor(host),
    resolveBinary: () => {
      resolved += 1
      return Promise.resolve(Buffer.from('binary'))
    },
    pollMs: 1,
  })

  assert.equal(endpoint.reused, false)
  assert.equal(endpoint.port, 41_236)
  // The build is current, so only the launch is replaced.
  assert.equal(resolved, 0)
  assert.equal(host.commands.includes('kill 4242'), true)
  assert.equal(host.alive.has(4242), false)
  assert.equal(host.launchEnv, currentRecipe())
})

test('a live agent with no recorded launch recipe is replaced, not reused', async () => {
  const host = machine()
  host.alive.add(4242)
  host.state = stateFile('0.0.1', 4242, 41_234)
  host.launchEnv = undefined
  host.onStart = () => {
    host.alive.add(5254)
    host.state = stateFile('0.0.1', 5254, 41_237)
  }

  const endpoint = await ensureAgent({
    ssh: SSH,
    token: 't',
    version: '0.0.1',
    cacheDir: '/unused',
    run: runnerFor(host),
    resolveBinary: () => Promise.resolve(Buffer.from('binary')),
    pollMs: 1,
  })

  assert.equal(endpoint.reused, false)
  assert.equal(host.commands.includes('kill 4242'), true)
  assert.equal(host.alive.has(4242), false)
})

test('a missing agent is installed from the resolved binary and started', async () => {
  const host = machine()
  const binary = Buffer.from('ELF-ish bytes')
  host.onStart = () => {
    host.alive.add(5151)
    host.state = stateFile('0.7.0', 5151, 53_000)
  }
  let assetName = ''

  const endpoint = await ensureAgent({
    ssh: SSH,
    token: 'hunter2',
    version: '0.7.0',
    cacheDir: '/unused',
    run: runnerFor(host),
    resolveBinary: (options) => {
      assetName = options.assetName
      return Promise.resolve(binary)
    },
    pollMs: 1,
  })

  assert.deepEqual(endpoint, { port: 53_000, version: '0.7.0', reused: false })
  assert.equal(assetName, 'dsh-remote-agent-linux-x86_64')
  // The bytes travel on stdin, not in the command string.
  assert.deepEqual(host.inputs[uploadIndex(host)], binary)
  assert.equal(host.commands.every(command => !command.includes('ELF-ish')), true)
  assert.equal(host.installed, JSON.stringify({ version: '0.7.0' }))
})

test('reports each install step as it starts, with the build it concerns', async () => {
  const host = machine()
  host.onStart = () => {
    host.alive.add(8181)
    host.state = stateFile('0.7.0', 8181, 46_000)
  }
  const seen: AgentProgress[] = []

  await ensureAgent({
    ssh: SSH,
    token: 't',
    version: '0.7.0',
    cacheDir: '/unused',
    run: runnerFor(host),
    resolveBinary: (options) => {
      // The real resolver reports where the bytes came from; the stub stands in.
      options.onSource?.('network')
      return Promise.resolve(Buffer.from('binary'))
    },
    onProgress: (progress) => { seen.push(progress) },
    pollMs: 1,
  })

  assert.deepEqual(seen.map(progress => progress.phase), [
    'checking', 'fetching', 'fetching', 'uploading', 'starting',
  ])
  assert.equal(seen[0]?.version, '0.7.0')
  assert.equal(seen[1]?.asset, 'dsh-remote-agent-linux-x86_64')
  assert.equal(seen[2]?.source, 'network')
})

test('reports reuse without pretending to fetch anything', async () => {
  const host = machine()
  host.alive.add(4242)
  host.state = stateFile('0.0.1', 4242, 41_234)
  host.launchEnv = currentRecipe()
  const seen: AgentProgress[] = []

  await ensureAgent({
    ssh: SSH,
    token: 't',
    version: '0.0.1',
    cacheDir: '/unused',
    run: runnerFor(host),
    resolveBinary: () => Promise.resolve(Buffer.from('binary')),
    onProgress: (progress) => { seen.push(progress) },
  })

  assert.deepEqual(seen.map(progress => progress.phase), ['checking', 'reusing'])
})

test('the token is written over stdin and never appears in a command', async () => {
  const host = machine()
  host.onStart = () => {
    host.alive.add(6161)
    host.state = stateFile('0.0.1', 6161, 44_000)
  }

  await ensureAgent({
    ssh: SSH,
    token: 'hunter2',
    version: '0.0.1',
    cacheDir: '/unused',
    run: runnerFor(host),
    resolveBinary: () => Promise.resolve(Buffer.from('binary')),
    pollMs: 1,
  })

  const tokenIndex = host.commands.indexOf(`cat > "${DIR}/token" && chmod 600 "${DIR}/token"`)
  assert.notEqual(tokenIndex, -1)
  assert.equal(host.inputs[tokenIndex], 'hunter2')
  assert.equal(host.commands.every(command => !command.includes('hunter2')), true)
  assert.equal(JSON.stringify(host.commands).includes('hunter2'), false)
})

test('a machine that already carries the expected marker keeps its binary', async () => {
  const host = machine()
  host.installed = JSON.stringify({ version: '0.7.0' })
  let resolved = 0
  host.onStart = () => {
    host.alive.add(7171)
    host.state = stateFile('0.7.0', 7171, 45_000)
  }

  const endpoint = await ensureAgent({
    ssh: SSH,
    token: 't',
    version: '0.7.0',
    cacheDir: '/unused',
    run: runnerFor(host),
    resolveBinary: () => {
      resolved += 1
      return Promise.resolve(Buffer.from('binary'))
    },
    pollMs: 1,
  })

  assert.equal(endpoint.reused, false)
  assert.equal(resolved, 0)
  assert.equal(uploadIndex(host), -1)
})

test('an older build is replaced and the process running it stopped', async () => {
  const host = machine()
  host.alive.add(11)
  host.state = stateFile('0.0.1', 11, 40_000)
  host.installed = JSON.stringify({ version: '0.0.1' })
  let resolved = 0
  host.onStart = () => {
    host.alive.add(12)
    host.state = stateFile('0.7.0', 12, 41_000)
  }

  await ensureAgent({
    ssh: SSH,
    token: 't',
    version: '0.7.0',
    cacheDir: '/unused',
    run: runnerFor(host),
    resolveBinary: () => {
      resolved += 1
      return Promise.resolve(Buffer.from('binary'))
    },
    pollMs: 1,
  })

  assert.equal(resolved, 1)
  assert.equal(host.commands.includes('kill 11'), true)
  assert.equal(host.alive.has(11), false)
})

test('an agent that never publishes a port fails pointing at the log', async () => {
  const host = machine()

  await assert.rejects(
    () => ensureAgent({
      ssh: SSH,
      token: 't',
      version: '0.7.0',
      cacheDir: '/unused',
      run: runnerFor(host),
      resolveBinary: () => Promise.resolve(Buffer.from('binary')),
      startTimeoutMs: 30,
      pollMs: 2,
    }),
    /did not publish a port within 30ms; check ~\/\.dsh\/remote-agent\/agent\.log/,
  )
})

test('a platform the release does not cover fails with what the machine reported', async () => {
  const run: AgentCommandRunner = (_ssh, command) => Promise.resolve(
    command === 'uname -s; uname -m'
      ? { code: 0, stdout: 'FreeBSD\nx86_64\n', stderr: '' }
      : { code: 0, stdout: '', stderr: '' },
  )

  await assert.rejects(
    () => ensureAgent({
      ssh: SSH,
      token: 't',
      version: '0.0.1',
      cacheDir: '/unused',
      run,
      resolveBinary: () => Promise.resolve(Buffer.from('binary')),
    }),
    /FreeBSD/,
  )
})

test('an ssh failure before the platform is read keeps the tunnel diagnostic', async () => {
  const run: AgentCommandRunner = () => Promise.resolve({
    code: 255,
    stdout: '',
    stderr: 'Host key verification failed.',
  })

  await assert.rejects(
    () => ensureAgent({
      ssh: SSH,
      token: 't',
      version: '0.0.1',
      cacheDir: '/unused',
      run,
      resolveBinary: () => Promise.resolve(Buffer.from('binary')),
    }),
    /the SSH host key for "me@build-01" is not known yet; run `ssh me@build-01` once/,
  )
})

test('a setup command that fails reports the shared ssh diagnostic', async () => {
  const run: AgentCommandRunner = (_ssh, command) => Promise.resolve(
    command.startsWith(`mkdir -p "${DIR}"`)
      ? { code: 1, stdout: '', stderr: 'mkdir: Permission denied' }
      : command === 'uname -s; uname -m'
        ? { code: 0, stdout: 'Linux\nx86_64\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
  )

  await assert.rejects(
    () => ensureAgent({
      ssh: SSH,
      token: 't',
      version: '0.0.1',
      cacheDir: '/unused',
      run,
      resolveBinary: () => Promise.resolve(Buffer.from('binary')),
    }),
    /"me@build-01" rejected the key or agent; check the SSH key and ssh-agent: mkdir: Permission denied/,
  )
})

test('the crate versions match the build the plugin installs', async () => {
  // Read the manifests rather than trusting a build step to have copied them:
  // one release tag carries both binaries, so both versions move with it.
  for (const crate of ['agent', 'ptc-host']) {
    const manifest = await readFile(new URL(`../../${crate}/Cargo.toml`, import.meta.url), 'utf8')
    const match = /^version = "(.+)"$/m.exec(manifest)
    assert.notEqual(match, null, `${crate}/Cargo.toml has a version`)
    assert.equal(match?.[1], AGENT_VERSION, `${crate} is the build the plugin installs`)
  }
})
