// dsh-remote-workspace host half
import { LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
import { SandboxBashExecutor } from "@deepseek-ai/dsh-bash-sandbox";
import { SandboxedFileSystem } from "@deepseek-ai/dsh-fs-sandbox";
import { LocalSubprocessRuntime } from "@deepseek-ai/dsh-subprocess-local";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import z from "@deepseek-ai/schemastery";
import { constants, homedir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { PassThrough } from "node:stream";
import * as nodePty from "node-pty";
import { Service } from "@deepseek-ai/cordis";
import { Socket, connect, createServer } from "node:net";
import { ResponseError, StreamMessageReader, StreamMessageWriter, createMessageConnection } from "vscode-jsonrpc/node.js";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { brandString } from "@deepseek-ai/dsh-brand";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { promisify } from "node:util";
import { FsError, FsTargetKey, FsVersion } from "@deepseek-ai/dsh-fs";
import { StringDecoder } from "node:string_decoder";
import { Buffer as Buffer$1 } from "node:buffer";
import { WebSocket, WebSocketServer } from "ws";
import { defineTool } from "@deepseek-ai/dsh-tools";
/**
* Service provider for terminals.
*
* Extending this class is what publishes the provider as `ctx.tty`; a routing
* provider that is not a subclass is registered with `ctx.provide` instead, the
* way the other routing seams in this workspace are.
*/
var TtyRuntime = class extends Service {
	constructor(ctx) {
		super(ctx, "tty");
	}
};
//#endregion
//#region src/local/tty.ts
/**
* The local terminal provider: a PTY on this host.
*
* This is the shape a deployment gets when nothing routes a working directory
* elsewhere. A routing provider composes it for the directories it does not own,
* which is why the work lives in a class: the same code serves a standalone
* deployment and one that answers for local paths inside a router.
*
* node-pty is the substrate because the seam needs `resize`, and the PTY is what
* holds the window size: writing to a master descriptor cannot change it. The
* size a terminal was born with is therefore not the size it keeps, which is the
* whole point of this package.
*
* @module dsh-remote-workspace/local/tty
*/
/** What a PTY calls itself when the caller names no terminal type. */
const TERM = "xterm-256color";
/** How long a killed terminal is given to report its exit before the wait ends. */
const KILL_SETTLE_MS = 2e3;
/**
* The environment a shell starts in.
*
* This process's own environment, so a terminal sees the same PATH and tooling
* an agent on this host would, with the terminal type and the caller's entries
* layered over it. Variables Node leaves undefined are dropped rather than sent
* as the string "undefined".
* @param overrides - entries the caller supplied.
* @returns the environment to spawn with.
*/
function spawnEnv(overrides) {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== void 0) env[key] = value;
	return {
		...env,
		TERM,
		...overrides
	};
}
/**
* The name of a signal node-pty reported as a number.
* @param code - the number from the exit event; zero means no signal.
* @returns the signal name, or null when the process exited on its own.
*/
function signalName(code) {
	if (code === 0) return null;
	for (const [name, value] of Object.entries(constants.signals)) if (value === code) return name;
	return null;
}
/** Wait for one promise, or for its budget to run out. */
async function within(ms, promise) {
	let timer;
	const expiry = new Promise((resolve) => {
		timer = setTimeout(resolve, ms);
	});
	await Promise.race([promise, expiry]);
	if (timer !== void 0) clearTimeout(timer);
}
/** One terminal this host owns. */
var LocalTtyHandle = class {
	pid;
	output = new PassThrough();
	done;
	terminal;
	graceMs;
	exited = false;
	stopping;
	exit;
	/**
	* @param terminal - the allocated node-pty process.
	* @param graceMs - milliseconds between the terminate signal and the kill.
	*/
	constructor(terminal, graceMs) {
		this.terminal = terminal;
		this.pid = terminal.pid;
		this.graceMs = graceMs;
		let settleExit = () => {};
		this.exit = new Promise((resolve) => {
			settleExit = resolve;
		});
		let settleDone = () => {};
		this.done = new Promise((resolve) => {
			settleDone = resolve;
		});
		terminal.onData((data) => {
			this.output.write(Buffer.from(data, "utf8"));
		});
		terminal.onExit(({ exitCode, signal }) => {
			this.exited = true;
			this.output.end();
			settleExit();
			settleDone({
				exitCode,
				signal: signalName(signal ?? 0)
			});
		});
	}
	async write(data) {
		this.terminal.write(data);
	}
	async resize(cols, rows) {
		this.terminal.resize(cols, rows);
	}
	async terminate() {
		this.stopping ??= this.stop();
		await this.stopping;
	}
	/**
	* Signal the process, kill it if it outlives the grace period, and wait for
	* the exit it reports. A terminal that never reports one ends the wait rather
	* than hanging the caller on a process the kernel has already killed.
	*/
	async stop() {
		if (this.exited) return;
		this.terminal.kill("SIGTERM");
		await within(this.graceMs, this.exit);
		if (this.exited) return;
		this.terminal.kill("SIGKILL");
		await within(KILL_SETTLE_MS, this.exit);
	}
};
/**
* A terminal provider that owns PTYs on this host.
*
* It takes no config: every choice a terminal needs — what to run, where, how
* large, how long to wait before killing — arrives on the request, so nothing
* about a deployment has to be settled before a terminal is asked for.
*/
var LocalTtyRuntime = class extends TtyRuntime {
	async spawn(request) {
		return new LocalTtyHandle(nodePty.spawn(request.argv[0], request.argv.slice(1), {
			name: TERM,
			cols: request.cols,
			rows: request.rows,
			cwd: request.cwd,
			env: spawnEnv(request.env)
		}), request.graceMs ?? 3e3);
	}
};
//#endregion
//#region src/models/autoconnect.ts
/** How many times one machine is attempted before the startup pass gives up on it. */
const ATTEMPTS = 3;
/** Gap between those attempts, in milliseconds. */
const RETRY_GAP_MS = 2e3;
/**
* Start the connection passes over every configured machine.
* @param deps - the machines, the connection manager, and the retry knobs.
* @returns a function that stops the passes; an attempt already in flight is
*   left to finish or fail on its own, and no further attempt starts.
*/
function autoconnect(deps) {
	const attempts = deps.attempts ?? ATTEMPTS;
	const gapMs = deps.gapMs ?? RETRY_GAP_MS;
	const delay = deps.delay ?? ((ms) => new Promise((resolve) => {
		setTimeout(resolve, ms);
	}));
	let stopped = false;
	/** Attempt one machine until it connects, the attempts run out, or this stops. */
	const pass = async (record) => {
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			if (stopped) return;
			if (attempt > 0) await delay(gapMs);
			if (stopped) return;
			try {
				await deps.connections.connect(record);
				return;
			} catch {}
		}
	};
	/** One machine's part of a pass; the local host has nothing to reach. */
	const consider = (record, retryOnlyFailed) => {
		if (record.transport.kind === "local") return;
		if (retryOnlyFailed && deps.status !== void 0 && deps.status(record.nodeId).state !== "failed") return;
		pass(record);
	};
	for (const record of deps.records()) consider(record, false);
	const timer = deps.refreshMs === void 0 ? void 0 : setInterval(() => {
		if (stopped) return;
		for (const record of deps.records()) consider(record, true);
	}, deps.refreshMs);
	timer?.unref();
	return () => {
		stopped = true;
		if (timer !== void 0) clearInterval(timer);
	};
}
//#endregion
//#region src/remote/protocol.ts
/** Prefix every composite target key the plugin mints carries. */
const TARGET_KEY_PREFIX = "node:";
/**
* Whether a failure code belongs to the filesystem family.
* @param code - the code a daemon reported.
* @returns true when the code is one this module declares for filesystem failures.
*/
function isFsErrorCode(code) {
	return code.startsWith("FS_");
}
/**
* The notification a daemon pushes for every chunk of a `'pipe'` stream.
*
* A raw piped stream is not a retained window: the consumer needs every byte in
* order, so the daemon pushes instead of waiting to be polled. `seq` is
* monotonic per stream so a client can tell that bytes were lost rather than
* silently splicing a gap.
*/
const SP_PIPE_NOTIFICATION = "sp.pipe";
/**
* Admit a string as a terminal session id.
* @param value - a string the daemon minted, or one the wire delivered.
* @returns the same string, branded.
*/
function asTermId(value) {
	return value;
}
//#endregion
//#region src/remote/client.ts
/**
* The node channel: what the rest of the plugin may ask one node, and the TCP
* client that answers it.
*
* {@link NodeChannel} is the narrow view every consumer holds — round-trip one
* protocol method, watch the pushed frames of a piped stream — so the file
* layer, the process layer, and the worktree lifecycle never see a socket,
* a handshake, or `vscode-jsonrpc`. {@link NodeRequestError} is the other half
* of that view: a daemon failure with the code the call sites branch on.
*
* The client below is the only implementation: `vscode-jsonrpc` owns framing,
* request correlation, and cancellation on top of the socket, so it only
* establishes the connection, performs the handshake, and translates a daemon
* failure into that error. What supplies the socket — an SSH forward today, the
* recorded address for a `direct` record — is the caller's business, which is
* what lets one client serve both.
*
* @module dsh-remote-workspace/remote/client
*/
/** A typed failure the daemon reported, carrying the seam's own error code. */
var NodeRequestError = class extends Error {
	/** The daemon's structured payload, verbatim. */
	data;
	/**
	* @param data - the daemon's structured error payload.
	*/
	constructor(data) {
		super(`${data.message} (${data.code})`);
		this.name = "NodeRequestError";
		this.data = data;
	}
};
/** Whether an unknown value is the daemon's structured failure payload. */
function isWireErrorData(value) {
	return typeof value === "object" && value !== null && typeof value.code === "string" && typeof value.message === "string";
}
/**
* Translate a `vscode-jsonrpc` rejection into the plugin's typed failure.
* @param error - whatever the connection raised.
* @returns the error to reject with.
*/
function toChannelError(error) {
	if (error instanceof ResponseError && isWireErrorData(error.data)) return new NodeRequestError(error.data);
	return error;
}
/**
* Settle `work` or fail once the deadline passes.
*
* The handshake needs its own bound: a daemon that closes the socket without
* answering leaves the request pending forever, and "the machine answered
* nothing" must be a failure rather than a hang.
* @param work - the operation to bound.
* @param timeoutMs - the deadline, or undefined to wait indefinitely.
* @param onTimeout - builds the failure to reject with.
* @returns the operation's result.
*/
async function withTimeout(work, timeoutMs, onTimeout) {
	if (timeoutMs === void 0) return work;
	let timer;
	try {
		return await Promise.race([work, new Promise((_resolve, reject) => {
			timer = setTimeout(() => reject(onTimeout()), timeoutMs);
		})]);
	} finally {
		if (timer !== void 0) clearTimeout(timer);
	}
}
/**
* A writer that hands a failed write to the connection instead of rejecting.
*
* `vscode-jsonrpc` reports a failed write by rejecting the request from inside
* an `async` Promise executor, and nothing awaits that rejection. The host
* process sees the orphan and reports a fatal load failure, which is what a
* write to a socket destroyed underneath it — a teardown racing an in-flight
* call, or a link that just dropped — produces. The failure is not dropped:
* the connection is disposed, which rejects the request through the
* pending-response path its caller already handles.
*/
var SocketWriter = class extends StreamMessageWriter {
	/** Disposes the connection this writer serves; set once that connection exists. */
	onWriteFailure;
	/**
	* @param socket - the socket the connection is written to.
	* @param onWriteFailure - tears down the owning connection.
	*/
	constructor(socket, onWriteFailure) {
		super(socket);
		this.onWriteFailure = onWriteFailure;
	}
	async write(message) {
		try {
			await super.write(message);
		} catch {
			this.onWriteFailure();
		}
	}
};
/**
* Connect to a daemon and complete the handshake.
* @param options - address, token, and optional timeout.
* @returns the live connection, already past `node.hello`.
* @throws when the socket fails, the handshake times out, or the daemon
*   refuses the protocol revision or the token.
*/
async function connectNode(options) {
	const socket = new Socket();
	socket.setNoDelay(true);
	await withTimeout(new Promise((resolve, reject) => {
		socket.once("error", reject);
		socket.once("connect", () => resolve());
		socket.connect({
			host: options.host,
			port: options.port
		});
	}), options.timeoutMs, () => {
		socket.destroy();
		return /* @__PURE__ */ new Error(`timed out connecting to ${options.host}:${String(options.port)}`);
	});
	let disposeConnection = () => {};
	const writer = new SocketWriter(socket, () => {
		disposeConnection();
	});
	const connection = createMessageConnection(new StreamMessageReader(socket), writer);
	disposeConnection = () => {
		connection.dispose();
	};
	connection.listen();
	const channel = {
		async request(method, params) {
			try {
				return await connection.sendRequest(method, params);
			} catch (error) {
				throw toChannelError(error);
			}
		},
		onPipeFrame(handler) {
			connection.onNotification(SP_PIPE_NOTIFICATION, (frame) => {
				handler(frame);
			});
			return () => {
				connection.onNotification(SP_PIPE_NOTIFICATION, () => {});
			};
		}
	};
	let info;
	try {
		info = await withTimeout(channel.request("node.hello", {
			protocol: 1,
			token: options.token
		}), options.timeoutMs, () => /* @__PURE__ */ new Error(`handshake with ${options.host}:${String(options.port)} timed out`));
	} catch (error) {
		connection.dispose();
		socket.destroy();
		throw toChannelError(error);
	}
	let closed = false;
	return {
		channel,
		info,
		close() {
			if (closed) return;
			closed = true;
			connection.dispose();
			socket.destroy();
		}
	};
}
//#endregion
//#region src/remote/ssh.ts
/**
* Reaching one machine over `ssh`: the one-shot commands that install and start
* its daemon, and the port forward that then carries daemon traffic.
*
* Both jobs share the same two decisions, so both live here: the options that
* keep `ssh` from ever prompting, and the translation of what it wrote on
* failure into a remedy. A change to either reaches every caller.
*
* The two jobs report differently because their processes differ. A command
* runs to completion and hands back its exit status and both streams, so
* {@link runSsh} resolves for any normal exit, non-zero included — a command
* that reports "no" is a result the caller inspects, not an exception — and
* rejects only when `ssh` could not be started or the caller's deadline passed.
* A forward is a long-lived process that either starts accepting connections or
* does not, so {@link openTunnel} resolves once the local port is live and
* never reports an exit status.
*
* The daemon binds the machine's own loopback, so the host reaches it the way a
* person would by hand: a local port, a `ssh -L` forward, and a connection
* through it. That port is chosen per connection from whatever the host has
* free, because a fixed one would collide with whatever else the operator runs
* and is not part of a machine's identity. The host never accepts a host key on
* the operator's behalf: an unknown key fails the forward with a diagnostic
* naming the command that would accept it, because this forward grants shell
* access as the remote user.
*
* @module dsh-remote-workspace/remote/ssh
*/
/**
* Build the `ssh` options that make a run non-interactive against this target.
*
* The SSH port and identity file default to the operator's own configuration,
* so a `~/.ssh/config` alias reaches the machine exactly as `ssh` itself would.
* @param target - the machine to reach.
* @returns the arguments, excluding the subcommand and the destination.
*/
function sshArgs(target) {
	return [
		"-o",
		"BatchMode=yes",
		"-o",
		"ExitOnForwardFailure=yes",
		"-o",
		"ServerAliveInterval=15",
		"-o",
		"ServerAliveCountMax=3",
		...target.sshPort === void 0 ? [] : ["-p", String(target.sshPort)],
		...target.identityFile === void 0 ? [] : ["-i", target.identityFile]
	];
}
/**
* Turn what `ssh` wrote into a reason an operator can act on.
*
* The raw text stays in the message: this maps only the failures with a known
* remedy, and everything else is more useful verbatim than paraphrased.
* @param target - the destination the run named.
* @param stderr - everything the process wrote to stderr.
* @param fallback - what to say when nothing matches, without the raw text.
* @returns the message to raise.
*/
function sshFailure(target, stderr, fallback) {
	const text = stderr.trim();
	const suffix = text === "" ? "" : `: ${text}`;
	if (/host key verification failed/i.test(text)) return `the SSH host key for "${target}" is not known yet; run \`ssh ${target}\` once to verify and accept it${suffix}`;
	if (/administratively prohibited/i.test(text)) return `"${target}" refuses TCP forwarding; its sshd needs AllowTcpForwarding yes${suffix}`;
	if (/permission denied|no supported authentication/i.test(text)) return `"${target}" rejected the key or agent; check the SSH key and ssh-agent${suffix}`;
	if (/could not resolve hostname/i.test(text)) return `"${target}" cannot be resolved; check the SSH destination${suffix}`;
	if (/connection refused|connection timed out|no route to host/i.test(text)) return `"${target}" is unreachable over SSH${suffix}`;
	return `${fallback}${suffix}`;
}
/** Start the real `ssh` process for one command run. */
function startSshCommand(args) {
	const child = spawn("ssh", [...args], { stdio: [
		"pipe",
		"pipe",
		"pipe"
	] });
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	child.stdin.on("error", () => {});
	return {
		exited: new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code) => {
				resolve(code ?? 0);
			});
		}),
		readStdout: () => stdout,
		readStderr: () => stderr,
		send: (input) => {
			child.stdin.end(input);
		},
		kill: () => {
			child.kill("SIGTERM");
		}
	};
}
/**
* Run one command on a machine over SSH.
*
* Resolves with the exit status, stdout, and stderr for any exit the process
* reached on its own, a non-zero one included. Rejects only when `ssh` could
* not be started or `options.timeoutMs` elapsed; in the first case the
* diagnostic says so, and in the second it carries whatever stderr arrived.
* @param ssh - the machine to reach.
* @param command - the command string the remote shell runs.
* @param options - optional stdin bytes and a deadline.
* @param deps - an optional process starter, for tests.
* @returns the exit status and both streams.
* @throws when `ssh` cannot start or the deadline passes.
*/
async function runSsh(ssh, command, options = {}, deps = {}) {
	const child = (deps.start ?? startSshCommand)([
		...sshArgs(ssh),
		ssh.target,
		command
	]);
	child.send(options.input);
	const timeoutMs = options.timeoutMs;
	let timer;
	let timedOut = false;
	const deadline = timeoutMs === void 0 ? void 0 : new Promise((_resolve, reject) => {
		timer = setTimeout(() => {
			timedOut = true;
			reject(/* @__PURE__ */ new Error("timeout"));
		}, timeoutMs);
	});
	try {
		return {
			code: await (deadline === void 0 ? child.exited : Promise.race([child.exited, deadline])),
			stdout: child.readStdout(),
			stderr: child.readStderr()
		};
	} catch (error) {
		child.kill();
		if (timedOut) throw new Error(`the SSH command on "${ssh.target}" did not finish within ${String(timeoutMs)}ms`, { cause: error });
		throw new Error(`could not start ssh for "${ssh.target}": ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	} finally {
		if (timer !== void 0) clearTimeout(timer);
	}
}
/** Default gap between readiness probes. */
const READY_POLL_MS = 120;
/**
* Resolve a free TCP port on the host.
*
* The port is released before it is returned, so a caller racing for it can
* lose; a forward that loses reports a bind failure rather than silently
* forwarding nothing.
* @returns the port number the host had free.
*/
function allocateLocalPort() {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			if (address === null || typeof address === "string") {
				probe.close();
				reject(/* @__PURE__ */ new Error("could not determine a free local port"));
				return;
			}
			const { port } = address;
			probe.close(() => resolve(port));
		});
	});
}
/**
* Build the `ssh` argument vector for one forward.
* @param spec - the machine and the daemon port to reach.
* @param localPort - the host port to forward.
* @returns the arguments, excluding the executable.
*/
function tunnelArgs(spec, localPort) {
	return [
		"-N",
		...sshArgs(spec.ssh),
		"-L",
		`127.0.0.1:${String(localPort)}:127.0.0.1:${String(spec.remotePort)}`,
		spec.ssh.target
	];
}
/**
* Turn what `ssh` wrote into a reason an operator can act on.
* @param target - the destination the forward named.
* @param stderr - everything the process wrote to stderr.
* @returns the message to raise.
*/
function tunnelFailure(target, stderr) {
	return sshFailure(target, stderr, `could not open an SSH forward to "${target}"`);
}
/** Start the real `ssh` process for one forward. */
function startSshForward(args) {
	const child = spawn("ssh", [...args], { stdio: [
		"ignore",
		"ignore",
		"pipe"
	] });
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	return {
		exited: new Promise((resolve) => {
			child.once("error", () => {
				resolve();
			});
			child.once("exit", () => {
				resolve();
			});
		}),
		diagnostics: () => stderr,
		kill: () => {
			child.kill("SIGTERM");
		}
	};
}
/** Probe one TCP port on the host's loopback. */
function probePort(port) {
	return new Promise((resolve) => {
		const socket = connect({
			host: "127.0.0.1",
			port
		});
		const settle = (open) => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(open);
		};
		socket.once("connect", () => {
			settle(true);
		});
		socket.once("error", () => {
			settle(false);
		});
	});
}
/** Wait until a port accepts a connection, the process dies, or time runs out. */
async function waitForForward(target, port, process, timeoutMs, pollMs) {
	const deadline = Date.now() + timeoutMs;
	let exited = false;
	process.exited.then(() => {
		exited = true;
	});
	for (;;) {
		if (await probePort(port)) return;
		if (exited) throw new Error(tunnelFailure(target, process.diagnostics()));
		if (Date.now() >= deadline) throw new Error(`the SSH forward to "${target}" did not start accepting connections within ${String(timeoutMs)}ms`);
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}
/**
* Open a forward from a free host port to one machine's daemon.
*
* Resolves once the forward accepts connections, so a caller that receives a
* tunnel can connect through it immediately. Rejects — after killing the
* process — when `ssh` refuses, exits, or never becomes ready.
* @param spec - the machine and the daemon port to reach.
* @param deps - overrides for tests.
* @returns the live forward.
* @throws when the forward could not be established.
*/
async function openTunnel(spec, deps = {}) {
	const allocatePort = deps.allocatePort ?? allocateLocalPort;
	const start = deps.start ?? startSshForward;
	const localPort = await allocatePort();
	const process = start(tunnelArgs(spec, localPort));
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		process.kill();
	};
	try {
		await waitForForward(spec.ssh.target, localPort, process, deps.readyTimeoutMs ?? 15e3, deps.readyPollMs ?? READY_POLL_MS);
	} catch (error) {
		close();
		const stderr = process.diagnostics();
		if (stderr !== "" && error instanceof Error) throw new Error(tunnelFailure(spec.ssh.target, stderr), { cause: error });
		throw error;
	}
	return {
		localPort,
		exited: process.exited,
		close
	};
}
//#endregion
//#region src/remote/agent/release.ts
/**
* Resolve the agent binary for one machine's platform.
*
* The agent is a static Rust binary published on GitHub Releases inside a
* per-platform `.tar.gz`, so "install the agent" reduces to naming the right
* archive for `uname` and caching the binary it holds. The cache is keyed by
* version and asset, which is what makes a version bump a fresh download and a
* second machine of the same platform a cache hit.
*
* The archive is read from the release's own download address — the URL a
* browser would follow, built from the tag and the asset name — so nothing here
* calls the GitHub API: no release metadata, no asset listing, no media type to
* negotiate, and no anonymous rate limit to spend. A release that carries no
* such archive answers 404 and is reported with the address that failed.
*
* Every download is verified against the release's `SHA256SUMS` before it is
* unpacked and cached: the bytes are executed on a remote machine, so a
* truncated or substituted archive must fail here rather than at exec time
* there.
*
* @module dsh-remote-workspace/remote/agent/release
*/
/** Address one release file is downloaded from, by tag and file name. */
const DOWNLOAD_ROOT = `https://github.com/lengmoXXL/dsh-remote-workspace/releases/download`;
/** The regular file every release archive carries: the agent itself. */
const AGENT_MEMBER = "dsh-remote-agent";
/** The sums file every release carries beside its archives. */
const SUMS_FILE = "SHA256SUMS";
/** Bytes one tar header block holds. */
const TAR_BLOCK = 512;
/** Platform names `uname -s` reports, and the asset token each maps to. */
const PLATFORMS = {
	linux: "linux",
	darwin: "darwin"
};
/** Architecture names `uname -m` reports, and the asset token each maps to. */
const ARCHITECTURES = {
	x86_64: "x86_64",
	amd64: "x86_64",
	aarch64: "aarch64",
	arm64: "aarch64"
};
/**
* Name the release asset for a machine's reported platform.
*
* Matching is case-insensitive because `uname` casing is not portable, and
* both the GNU and the BSD spelling of each architecture is accepted so the
* plugin never depends on which userland `uname` came from.
* @param platform - `uname -s` output, e.g. `Linux`.
* @param arch - `uname -m` output, e.g. `x86_64`.
* @returns the release asset name.
* @throws when the machine reports a platform or architecture with no asset.
*/
function agentAssetName(platform, arch) {
	const os = PLATFORMS[platform.trim().toLowerCase()];
	const cpu = ARCHITECTURES[arch.trim().toLowerCase()];
	if (os === void 0 || cpu === void 0) throw new Error(`the machine reports platform "${platform.trim()}" and architecture "${arch.trim()}", which has no dsh-remote-agent release; it ships for Linux and Darwin on x86_64 and aarch64`);
	return `dsh-remote-agent-${os}-${cpu}`;
}
/** The release file one asset is published as. */
function archiveName(assetName) {
	return `${assetName}.tar.gz`;
}
/** The direct download address of one platform's archive. */
function agentArchiveUrl(version, assetName) {
	return `${DOWNLOAD_ROOT}/v${version}/${archiveName(assetName)}`;
}
/** The direct download address of one version's sums file. */
function agentSumsUrl(version) {
	return `${DOWNLOAD_ROOT}/v${version}/${SUMS_FILE}`;
}
/** Download one URL, or fail with a message that names it. */
async function download(fetcher, url) {
	try {
		return await fetcher(url);
	} catch (error) {
		throw new Error(`downloading ${url} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}
/** The real HTTPS GET, refusing any non-2xx answer. */
async function fetchOverHttps(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
	return Buffer.from(await response.arrayBuffer());
}
/** One tar header field, read to its NUL or its field boundary and trimmed. */
function headerText(header, start, length) {
	const nul = header.indexOf(0, start);
	const end = nul === -1 || nul > start + length ? start + length : nul;
	return header.toString("utf8", start, end).trim();
}
/** The octal byte count of one tar header's data. */
function headerSize(header) {
	const text = headerText(header, 124, 12);
	return text === "" ? 0 : Number.parseInt(text, 8);
}
/**
* The agent binary inside one release archive.
*
* Only what this repository's own release job writes needs to be understood:
* one regular file, named {@link AGENT_MEMBER}, packed by `tar -czf`. A tar may
* write metadata records ahead of it — a PAX header from a newer tar, a long
* name — so every record is stepped over by its own size until the file is
* found, rather than assuming it comes first.
* @param archive - the `.tar.gz` bytes.
* @param sourceUrl - the URL they came from, for the diagnostic.
* @returns the member's bytes.
* @throws when the archive carries no such member or is not a gzipped tar.
*/
function archiveMember(archive, sourceUrl) {
	let tar;
	try {
		tar = gunzipSync(archive);
	} catch (error) {
		throw new Error(`${sourceUrl} is not a gzipped tar archive`, { cause: error });
	}
	for (let offset = 0; offset + TAR_BLOCK <= tar.length;) {
		const header = tar.subarray(offset, offset + TAR_BLOCK);
		if (header.every((byte) => byte === 0)) break;
		const size = headerSize(header);
		const start = offset + TAR_BLOCK;
		const type = String.fromCharCode(header[156] ?? 0);
		const name = headerText(header, 0, 100);
		if ((type === "0" || type === "\0") && name.split("/").pop() === AGENT_MEMBER) return tar.subarray(start, start + size);
		offset = start + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
	}
	throw new Error(`${sourceUrl} carries no "${AGENT_MEMBER}"`);
}
/**
* Read the expected hash for one release file out of a `SHA256SUMS` body.
* @param sums - the decoded sums file.
* @param fileName - the release file to look up.
* @param sumsUrl - the URL the sums came from, for the diagnostic.
* @returns the expected lowercase hex digest.
* @throws when the sums file names no such file.
*/
function expectedChecksum(sums, fileName, sumsUrl) {
	for (const line of sums.split("\n")) {
		const match = /^([0-9a-f]{64})\s+(.+)$/i.exec(line.trim());
		if (match !== null && match[2]?.trim() === fileName) return match[1].toLowerCase();
	}
	throw new Error(`${sumsUrl} names no "${fileName}"`);
}
/**
* Fetch, verify, unpack, and cache one agent binary.
*
* A cached file is returned untouched: it was verified when it was written,
* and re-hashing every connect would spend a slow link's budget on a file the
* plugin itself produced.
* @param options - version, asset, cache directory, and an optional fetch.
* @returns the verified binary bytes.
* @throws when the archive cannot be read, fails its checksum, carries no
*   agent, or the cache cannot be written.
*/
async function resolveAgentBinary(options) {
	const fetcher = options.fetch ?? fetchOverHttps;
	const cached = join(options.cacheDir, options.version, options.assetName);
	try {
		const bytes = await readFile(cached);
		options.onSource?.("cache");
		return bytes;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	options.onSource?.("network");
	const archiveUrl = agentArchiveUrl(options.version, options.assetName);
	const sumsUrl = agentSumsUrl(options.version);
	const [archive, sums] = await Promise.all([download(fetcher, archiveUrl), download(fetcher, sumsUrl)]);
	const expected = expectedChecksum(sums.toString("utf8"), archiveName(options.assetName), sumsUrl);
	const actual = createHash("sha256").update(archive).digest("hex");
	if (actual !== expected) throw new Error(`the download from ${archiveUrl} failed its SHA-256 check: expected ${expected}, got ${actual}`);
	const binary = archiveMember(archive, archiveUrl);
	await mkdir(dirname(cached), {
		recursive: true,
		mode: 448
	});
	const temp = `${cached}.${String(process.pid)}.${randomUUID()}`;
	try {
		await writeFile(temp, binary, { mode: 493 });
		await rename(temp, cached);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
	return binary;
}
//#endregion
//#region src/remote/agent/install.ts
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
/**
* Agent build this plugin installs on every machine it reaches.
*
* A single constant, not a config knob: the plugin and the release it
* downloads are one artifact, and a plugin that let a deployment name a
* different build would be describing a wire contract it cannot check. Bump
* this together with the release tag and `agent/Cargo.toml`, which a unit test
* keeps in step.
*/
const AGENT_VERSION = "0.0.4";
/**
* How long a freshly started agent may take to publish `state.json`. Generous
* enough for a slow link, short enough that a binary that cannot exec is
* reported rather than waited on.
*/
const DEFAULT_AGENT_START_TIMEOUT_MS = 1e4;
/** Default gap between state-file polls. */
const START_POLL_MS = 120;
/**
* Read the state file; `|| true` keeps a machine that has never run the agent
* from reading as a failed command, which is an expected state, not an error.
*/
const READ_STATE = "cat \"$HOME/.dsh/remote-agent/state.json\" 2>/dev/null || true";
/** Read the plugin's own marker for which build it installed. */
const READ_INSTALLED = "cat \"$HOME/.dsh/remote-agent/installed.json\" 2>/dev/null || true";
/** Read the plugin's own marker for how the running agent was launched. */
const READ_LAUNCH_ENV = "cat \"$HOME/.dsh/remote-agent/launch-env.json\" 2>/dev/null || true";
/** Seed the agent directory before anything is written into it. */
const ENSURE_DIR = "mkdir -p \"$HOME/.dsh/remote-agent\"";
/**
* Replace the binary through a temp name, so a crash or a killed connection
* never leaves a half-written executable in place, and stamp the executable
* bit. The bytes arrive on stdin: a buffer interpolated into the command would
* be mangled by the remote shell.
*/
const UPLOAD_BINARY = "cat > \"$HOME/.dsh/remote-agent/dsh-remote-agent.new\" && chmod 755 \"$HOME/.dsh/remote-agent/dsh-remote-agent.new\" && mv \"$HOME/.dsh/remote-agent/dsh-remote-agent.new\" \"$HOME/.dsh/remote-agent/dsh-remote-agent\"";
/** Record which build the step above installed, so a version bump reinstalls. */
const WRITE_INSTALLED = "cat > \"$HOME/.dsh/remote-agent/installed.json\"";
/** Write the secret on stdin too, and keep it owner-only. */
const WRITE_TOKEN = "cat > \"$HOME/.dsh/remote-agent/token\" && chmod 600 \"$HOME/.dsh/remote-agent/token\"";
/** Record how the agent was launched, so a changed recipe forces a restart. */
const WRITE_LAUNCH_ENV = "cat > \"$HOME/.dsh/remote-agent/launch-env.json\"";
/**
* The agent invocation, run with `exec` from inside the interactive login shell.
*
* Quoted as one word so the outer non-interactive shell hands it to the login
* shell untouched; it holds no single quote of its own. The paths stay relative
* because the start command changed into the agent directory, and the login
* shell inherits that directory.
*/
const AGENT_UNDER_LOGIN_SHELL = "'exec ./dsh-remote-agent --listen 127.0.0.1:0 --token-file token --state-file state.json'";
/**
* Quote one string as a single POSIX shell word.
* @param value - the literal text to quote.
* @returns the quoted word.
*/
function shQuote(value) {
	return `'${value.replaceAll("'", "'\\''")}'`;
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
function startAgentCommand(loginShell) {
	const seed = loginShell === void 0 ? "\"$SHELL\"" : shQuote(loginShell);
	const launch = `"$agent_shell" -ilc ${AGENT_UNDER_LOGIN_SHELL} >>agent.log 2>&1 </dev/null &`;
	return `cd "\$HOME/.dsh/remote-agent" && { agent_shell=${seed}; if [ ! -x "\$agent_shell" ]; then agent_shell="\$(getent passwd "\$(id -un)" 2>/dev/null | cut -d: -f7)"; fi; if [ ! -x "\$agent_shell" ]; then agent_shell="\$(dscl . -read "/Users/\$(id -un)" UserShell 2>/dev/null | awk 'NR==1 {print \$2}')"; fi; if [ ! -x "\$agent_shell" ]; then agent_shell="\$(command -v bash)"; fi; if [ ! -x "\$agent_shell" ]; then agent_shell="\$(command -v sh)"; fi; if command -v setsid >/dev/null 2>&1; then setsid nohup ${launch} else nohup ${launch} fi; }; exit 0`;
}
/**
* Parse the agent's state file.
* @param stdout - the file's contents, or empty when it is absent.
* @returns the fields a reuse decision needs, or undefined when unusable.
*/
function parseState(stdout) {
	let value;
	try {
		value = JSON.parse(stdout);
	} catch {
		return;
	}
	if (typeof value !== "object" || value === null) return void 0;
	const { pid, port, version } = value;
	if (typeof version !== "string" || version === "") return void 0;
	if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) return void 0;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return void 0;
	return {
		pid,
		port,
		version
	};
}
/** Read and parse the state file. */
async function readState(run, ssh) {
	return parseState((await run(ssh, READ_STATE)).stdout);
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
async function runChecked(run, ssh, command, fallback, input) {
	const result = await (input === void 0 ? run(ssh, command) : run(ssh, command, { input }));
	if (result.code !== 0) throw new Error(sshFailure(ssh.target, result.stderr, fallback));
}
/** Read the version marker the plugin writes beside the binary. */
async function installedVersion(run, ssh) {
	const result = await run(ssh, READ_INSTALLED);
	if (result.code !== 0) return void 0;
	try {
		const marker = JSON.parse(result.stdout);
		return typeof marker.version === "string" ? marker.version : void 0;
	} catch {
		return;
	}
}
/** Whether a process id is still alive on the machine, best effort. */
async function isAlive(run, ssh, pid) {
	try {
		return (await run(ssh, `kill -0 ${String(pid)}`)).code === 0;
	} catch {
		return false;
	}
}
/** Whether the machine records this plugin's current launch recipe. */
async function launchRecipeMatches(run, ssh) {
	const result = await run(ssh, READ_LAUNCH_ENV);
	if (result.code !== 0) return false;
	try {
		return JSON.parse(result.stdout).recipe === 2;
	} catch {
		return false;
	}
}
/**
* Ensure the agent is installed and running on one machine.
* @param options - the machine, token, version, cache, and optional seams.
* @returns the port and build the machine's agent is serving on.
* @throws when the platform cannot be resolved, the binary cannot be fetched,
*   a remote command fails, or a started agent never publishes its state.
*/
async function ensureAgent(options) {
	const run = options.run ?? runSsh;
	const resolveBinary = options.resolveBinary ?? resolveAgentBinary;
	const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_AGENT_START_TIMEOUT_MS;
	const pollMs = options.pollMs ?? START_POLL_MS;
	const { ssh, token, version, cacheDir } = options;
	const report = options.onProgress ?? (() => {});
	report({
		phase: "checking",
		version
	});
	const uname = await run(ssh, "uname -s; uname -m");
	if (uname.code !== 0) throw new Error(sshFailure(ssh.target, uname.stderr, `could not read the platform of "${ssh.target}"`));
	const [platform, arch] = uname.stdout.split("\n");
	const assetName = agentAssetName(platform?.trim() ?? "", arch?.trim() ?? "");
	const state = await readState(run, ssh);
	const runningPid = state !== void 0 && await isAlive(run, ssh, state.pid) ? state.pid : void 0;
	if (state !== void 0 && runningPid === state.pid && state.version === version && await launchRecipeMatches(run, ssh)) {
		report({
			phase: "reusing",
			version
		});
		return {
			port: state.port,
			version,
			reused: true
		};
	}
	const replacedPid = state?.pid;
	await runChecked(run, ssh, ENSURE_DIR, `could not create ~/.dsh/remote-agent on "${ssh.target}"`);
	if (await installedVersion(run, ssh) !== version) {
		report({
			phase: "fetching",
			version,
			asset: assetName
		});
		const binary = await resolveBinary({
			version,
			assetName,
			cacheDir,
			onSource: (source) => {
				report({
					phase: "fetching",
					version,
					asset: assetName,
					source
				});
			}
		});
		report({
			phase: "uploading",
			version
		});
		await runChecked(run, ssh, UPLOAD_BINARY, `could not install the agent binary on "${ssh.target}"`, binary);
		await runChecked(run, ssh, WRITE_INSTALLED, `could not record the installed agent version on "${ssh.target}"`, JSON.stringify({ version }));
	}
	await runChecked(run, ssh, WRITE_TOKEN, `could not write the agent token on "${ssh.target}"`, token);
	if (runningPid !== void 0) await run(ssh, `kill ${String(runningPid)}`).catch(() => {});
	report({
		phase: "starting",
		version
	});
	await runChecked(run, ssh, startAgentCommand(options.loginShell), `could not start the agent on "${ssh.target}"`);
	const deadline = Date.now() + startTimeoutMs;
	for (;;) {
		const published = await readState(run, ssh).catch(() => void 0);
		if (published !== void 0 && published.version === version && published.port > 0 && published.pid !== replacedPid) {
			await runChecked(run, ssh, WRITE_LAUNCH_ENV, `could not record the agent launch recipe on "${ssh.target}"`, JSON.stringify({ recipe: 2 }));
			return {
				port: published.port,
				version,
				reused: false
			};
		}
		if (Date.now() >= deadline) throw new Error(`the agent on "${ssh.target}" did not publish a port within ${String(startTimeoutMs)}ms; check ~/.dsh/remote-agent/agent.log on the machine`);
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}
//#endregion
//#region src/models/machines.ts
/** How many times a dropped connection is re-established before it is left failed. */
const RECOVERY_ATTEMPTS = 3;
/** Gap before the first recovery attempt, growing by that much for each later one. */
const RECOVERY_GAP_MS = 2e3;
/**
* Explain a failed connect attempt in the terms the operator can act on.
*
* A `ssh -L` forward binds its local port whether or not the agent listens
* behind it on the machine, so a handshake that times out through a forward
* means the agent is absent or wedged far more often than it means the network
* failed — and the agent's own log is where the reason will be.
* @param record - the machine that was being reached.
* @param error - the failure the connector raised.
* @returns the error to record and rethrow.
*/
function describeFailure(record, error) {
	const message = error instanceof Error ? error.message : String(error);
	if (record.transport.kind === "ssh" && /timed out connecting to|handshake with .* timed out/.test(message)) return new Error(`the SSH forward to "${record.transport.target}" is up, but nothing answered; check ~/.dsh/remote-agent/agent.log on the machine`, { cause: error });
	return error instanceof Error ? error : new Error(message);
}
/**
* Build the default transport opener.
*
* An `ssh` record is reached in two steps — ensure the agent is running, then
* forward the port it published — because the port is kernel-assigned and
* known only from the machine. A `direct` address is dialled as recorded. The
* local machine is refused here rather than dialled: it has no transport, and
* connecting it means nothing.
* @param deps - forward budget and the agent-ensuring seams.
* @returns an opener for the transports that have somewhere to connect to.
*/
function defaultOpenTransport(deps) {
	return async (record, report) => {
		if (record.transport.kind === "local") throw new Error("the local machine needs no connection");
		if (record.transport.kind === "direct") return {
			host: record.transport.host,
			port: record.transport.port,
			close: () => {}
		};
		if (deps.cacheDir === void 0) throw new Error("reaching a machine over SSH needs the plugin data directory to cache the agent");
		const endpoint = await deps.ensureAgent({
			ssh: record.transport,
			token: record.token,
			version: deps.agentVersion,
			cacheDir: deps.cacheDir,
			onProgress: report
		});
		const tunnel = await openTunnel({
			ssh: record.transport,
			remotePort: endpoint.port
		}, { readyTimeoutMs: deps.forwardTimeoutMs });
		return {
			host: "127.0.0.1",
			port: tunnel.localPort,
			exited: tunnel.exited,
			close: () => {
				tunnel.close();
			}
		};
	};
}
/**
* Build the connection manager.
* @param deps - an optional connection implementation, defaulting to the TCP client.
* @returns the manager.
*/
function createNodeConnections(deps = {}) {
	const connect = deps.connect ?? connectNode;
	const openTransport = deps.openTransport ?? defaultOpenTransport({
		forwardTimeoutMs: deps.sshForwardTimeoutMs ?? 15e3,
		agentVersion: deps.agentVersion ?? "0.0.4",
		cacheDir: deps.cacheDir,
		ensureAgent: deps.ensureAgent ?? ensureAgent
	});
	const handshakeTimeoutMs = deps.daemonHandshakeTimeoutMs ?? 1e4;
	const recoveryAttempts = deps.recoveryAttempts ?? RECOVERY_ATTEMPTS;
	const recoveryGapMs = deps.recoveryGapMs ?? RECOVERY_GAP_MS;
	const entries = /* @__PURE__ */ new Map();
	/**
	* Transports whose loss has already been published.
	*
	* A transport that answers `exited` again — a reused object, or one that was
	* already gone when it was handed over — must not start a second recovery:
	* the failure is the same event, and retrying it would reconnect forever.
	*/
	const lost = /* @__PURE__ */ new WeakSet();
	const entryFor = (nodeId) => {
		const existing = entries.get(nodeId);
		if (existing !== void 0) return existing;
		const created = {
			state: "idle",
			info: void 0,
			error: void 0,
			live: void 0,
			pending: void 0,
			transport: void 0,
			localPort: void 0,
			progress: void 0,
			recovery: void 0,
			published: void 0
		};
		entries.set(nodeId, created);
		return created;
	};
	/** Drop everything a connection holds, leaving the entry itself in place. */
	const clear = (entry) => {
		entry.published = void 0;
		entry.live?.close();
		entry.live = void 0;
		entry.pending = void 0;
		entry.info = void 0;
		entry.transport?.close();
		entry.transport = void 0;
		entry.localPort = void 0;
		entry.progress = void 0;
	};
	/** Publish a terminal state and drop everything the failure invalidates. */
	const fail = (entry, error) => {
		clear(entry);
		entry.state = "failed";
		entry.error = error instanceof Error ? error.message : String(error);
	};
	/** One entry as the status a caller reads. */
	const statusOf = (nodeId, entry) => ({
		nodeId,
		state: entry.state,
		...entry.info === void 0 ? {} : { info: entry.info },
		...entry.localPort === void 0 ? {} : { localPort: entry.localPort },
		...entry.progress === void 0 ? {} : { progress: entry.progress },
		...entry.error === void 0 ? {} : { error: entry.error }
	});
	/**
	* Bring a dropped connection back without waiting to be asked.
	*
	* A drop is the one failure worth retrying unattended: the machine answered a
	* moment ago, so the reason is usually the link or a restarted daemon rather
	* than a configuration only a person could change. The attempts are bounded,
	* and whatever the last one reported stays on the entry.
	* @param entry - the entry whose connection dropped.
	* @param record - the machine to reach again.
	*/
	const recover = (entry, record) => {
		const mine = Symbol("recovery");
		entry.recovery = mine;
		(async () => {
			for (let attempt = 1; attempt <= recoveryAttempts; attempt += 1) {
				await new Promise((resolve) => {
					setTimeout(resolve, recoveryGapMs * attempt).unref();
				});
				if (entry.recovery !== mine) return;
				try {
					await connectRecord(record);
					return;
				} catch {}
			}
		})();
	};
	/**
	* The channel one connection hands out.
	*
	* The transport can die without the SSH process that carries it noticing: a
	* node whose daemon is killed leaves the forward open, so nothing arrives to
	* say the connection is gone until a call fails on it. A refusal the daemon
	* itself answered is a typed error and stays the caller's business; anything
	* else on the wire is a lost connection, which is published and recovered
	* from exactly like a forward that closed.
	* @param entry - the entry this connection belongs to.
	* @param record - the machine, for the retry.
	* @param live - the connection being published.
	* @returns the channel the routers call.
	*/
	const publish = (entry, record, live) => ({
		async request(method, params) {
			try {
				return await live.channel.request(method, params);
			} catch (error) {
				if (entry.live === live && !(error instanceof NodeRequestError)) {
					fail(entry, error instanceof Error ? error : new Error(String(error)));
					recover(entry, record);
				}
				throw error;
			}
		},
		onPipeFrame: (handler) => live.channel.onPipeFrame(handler)
	});
	/** Connect one node, or return the attempt already in flight. */
	const connectRecord = async (record) => {
		const entry = entryFor(record.nodeId);
		if (entry.state === "ready" && entry.info !== void 0) return entry.info;
		if (entry.pending !== void 0) return entry.pending;
		entry.state = "connecting";
		entry.error = void 0;
		entry.progress = void 0;
		const attempt = (async () => {
			try {
				const opened = await openTransport(record, (progress) => {
					entry.progress = progress;
				});
				entry.transport = opened;
				const live = await connect({
					host: opened.host,
					port: opened.port,
					token: record.token,
					timeoutMs: handshakeTimeoutMs
				});
				entry.live = live;
				entry.published = publish(entry, record, live);
				entry.info = live.info;
				entry.localPort = record.transport.kind === "ssh" ? opened.port : void 0;
				entry.pending = void 0;
				entry.progress = void 0;
				entry.state = "ready";
				opened.exited?.then(() => {
					if (lost.has(opened) || entry.transport !== opened) return;
					lost.add(opened);
					fail(entry, /* @__PURE__ */ new Error(`the SSH forward to "${record.title}" closed`));
					recover(entry, record);
				});
				return live.info;
			} catch (error) {
				const reported = describeFailure(record, error);
				fail(entry, reported);
				throw reported;
			}
		})();
		entry.pending = attempt;
		return attempt;
	};
	return {
		channel(nodeId) {
			return entries.get(nodeId)?.published;
		},
		status(nodeId) {
			const entry = entries.get(nodeId);
			return entry === void 0 ? {
				nodeId,
				state: "idle"
			} : statusOf(nodeId, entry);
		},
		list() {
			return [...entries].map(([nodeId, entry]) => statusOf(nodeId, entry));
		},
		connect: connectRecord,
		disconnect(nodeId) {
			const entry = entries.get(nodeId);
			if (entry === void 0) return;
			entry.recovery = void 0;
			clear(entry);
			entry.error = void 0;
			entry.state = "disconnected";
		},
		dispose() {
			for (const entry of entries.values()) {
				entry.recovery = void 0;
				clear(entry);
			}
			entries.clear();
		}
	};
}
//#endregion
//#region src/storage/document.ts
/**
* The durable JSON document the node and repository stores share.
*
* A document is one file holding a versioned array of records, replaced
* atomically under a cross-process lock, so two harness processes never
* interleave a read-render-commit cycle. A caller owns its record shape, the
* guard that recognizes one, and what the records mean; this module owns the
* revision gate, the write lock, the atomic publication, and the diagnostics
* that name a document this build cannot read.
*
* @module dsh-remote-workspace/storage/document
*/
/** Owner-only permissions: these documents name paths and carry secrets. */
const FILE_MODE$1 = 384;
/**
* Read a document, refusing anything this build did not write.
* @param spec - layout, revision, and the record guard.
* @returns the stored records in document order, or none when the file is absent.
* @throws when the JSON is malformed, the revision is unsupported, or an entry
*   is not a record this build wrote.
*/
async function readDocument(spec) {
	let text;
	try {
		text = await readFile(spec.file, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${spec.file} is not valid JSON`, { cause: error });
	}
	if (typeof parsed !== "object" || parsed === null) throw new Error(`${spec.file} is not a ${spec.label} document`);
	const document = parsed;
	const entries = document[spec.key];
	if (!Array.isArray(entries)) throw new Error(`${spec.file} carries no ${spec.key} list`);
	if (document["version"] === 1 && spec.migrate !== void 0) return entries.map(spec.migrate);
	if (document["version"] !== spec.version) throw new Error(`${spec.file} has document version ${String(document["version"])}; this build reads ${String(spec.version)}`);
	if (!entries.every(spec.isRecord)) throw new Error(`${spec.file} carries a ${spec.label} entry this build does not understand`);
	return entries;
}
/**
* Replace a document with one complete serialization.
*
* The candidate is serialized before the lock is taken and the caller's
* in-memory list is replaced only after the write returns, so a failed commit
* leaves it untouched instead of committing an unreported mutation whose caller
* already saw an error.
* @param spec - layout and revision.
* @param records - the complete record list to publish.
*/
async function writeDocument(spec, records) {
	const content = `${JSON.stringify({
		version: spec.version,
		[spec.key]: records
	}, null, 2)}\n`;
	await mkdir(dirname(spec.file), {
		recursive: true,
		mode: 448
	});
	await withFileLock(spec.file, async () => {
		await writeFileAtomic(spec.file, content, { mode: FILE_MODE$1 });
	});
}
//#endregion
//#region src/storage/nodes.ts
/**
* The durable record of the remote machines a user has configured.
*
* Records carry the node's shared secret; every projection that leaves this
* module drops it, and {@link toNodeView} is the only supported way to produce
* one.
*
* @module dsh-remote-workspace/storage/nodes
*/
/**
* Document revision. Revision 1 stored `host`/`port` on the record; revision 2
* stores a transport that says how the host reaches the daemon.
*/
const DOCUMENT_VERSION$2 = 2;
/**
* The title a node gets when its caller named none.
* @param transport - how the host reaches the daemon.
* @returns the SSH destination, the direct address, or the local machine's name.
*/
function defaultNodeTitle(transport) {
	if (transport.kind === "local") return LOCAL_TITLE;
	return transport.kind === "ssh" ? transport.target : `${transport.host}:${String(transport.port)}`;
}
/**
* Admit a string as a machine id.
*
* Called where a string first becomes an id: a tool argument, a route segment,
* or one this plugin derives from the coordinates it names. Every later hop
* carries the type.
* @param value - the string the parser produced.
* @returns the same string, branded.
*/
function asNodeId(value) {
	return brandString(value);
}
/**
* The id, title, and instant the built-in local machine always carries.
*
* It is deliberately not a document entry: nothing configures it, so nothing
* can leave it unreachable or removed, and a deployment that has never added a
* machine still has this one to work in. The instant is the epoch because the
* machine has been there since before the plugin was.
*/
const LOCAL_NODE_ID = brandString("local");
/** Title the local machine carries, in the record and in every view. */
const LOCAL_TITLE = "Local";
/**
* The machine that is this host itself.
*
* Every surface treats it like any other machine — the same repository rows,
* the same worktree lifecycle, the same dialogs — with two differences that
* follow from where it is: there is no daemon to install and no connection to
* make, and its paths are the paths this process already has.
* @returns the local machine's record, for a caller that needs one.
*/
function localNode() {
	return {
		nodeId: LOCAL_NODE_ID,
		title: LOCAL_TITLE,
		transport: { kind: "local" },
		token: "",
		createdAt: "1970-01-01T00:00:00.000Z",
		updatedAt: "1970-01-01T00:00:00.000Z"
	};
}
/** Whether an unknown parsed value is a transport this build understands. */
function isTransport(value) {
	if (typeof value !== "object" || value === null) return false;
	const transport = value;
	if (transport["kind"] === "local") return true;
	if (transport["kind"] === "ssh") return typeof transport["target"] === "string" && (transport["sshPort"] === void 0 || typeof transport["sshPort"] === "number") && (transport["identityFile"] === void 0 || typeof transport["identityFile"] === "string");
	if (transport["kind"] === "direct") return typeof transport["host"] === "string" && typeof transport["port"] === "number";
	return false;
}
/** Whether an unknown parsed value is a record this module wrote. */
function isNodeRecord(value) {
	if (typeof value !== "object" || value === null) return false;
	const record = value;
	return typeof record["nodeId"] === "string" && typeof record["title"] === "string" && isTransport(record["transport"]) && typeof record["token"] === "string" && typeof record["createdAt"] === "string" && typeof record["updatedAt"] === "string";
}
/**
* Read one revision-1 record as the revision-2 record.
*
* Revision 1 recorded a reachable address and nothing else, which is what the
* `direct` transport still means. The record therefore carries over with no
* field lost and no id change, so every repository and worktree already
* anchored to this node keeps resolving.
* @param value - the parsed revision-1 entry.
* @param index - the entry's position, for the diagnostic.
* @returns the equivalent revision-2 record.
* @throws when the entry is not one this build can read.
*/
function migrateV1(value, index) {
	const record = typeof value === "object" && value !== null ? value : {};
	for (const field of [
		"nodeId",
		"title",
		"host",
		"token",
		"createdAt",
		"updatedAt"
	]) if (typeof record[field] !== "string") throw new Error(`node entry ${String(index)} from revision 1 carries no usable "${field}"`);
	if (typeof record["port"] !== "number") throw new Error(`node entry ${String(index)} from revision 1 carries no usable "port"`);
	const port = record["port"];
	const host = record["host"];
	return {
		nodeId: brandString(record["nodeId"]),
		title: record["title"],
		transport: {
			kind: "direct",
			host,
			port
		},
		token: record["token"],
		createdAt: record["createdAt"],
		updatedAt: record["updatedAt"]
	};
}
/**
* Project a record for a caller that may render it.
* @param record - the stored record.
* @returns the record without its secret, plus the presence flag a form needs.
*/
function toNodeView(record) {
	return {
		nodeId: record.nodeId,
		title: record.title,
		transport: record.transport,
		hasToken: record.token.length > 0,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt
	};
}
/**
* Build a node registry over one document.
* @param deps - the document path and an optional clock.
* @returns the registry; call {@link NodeRegistry.load} before serving reads.
*/
function createNodeRegistry(deps) {
	const now = deps.now ?? (() => /* @__PURE__ */ new Date());
	let nodes = [];
	let loaded = false;
	const requireLoaded = () => {
		if (!loaded) throw new Error("node registry used before load()");
	};
	const document = {
		file: deps.file,
		version: DOCUMENT_VERSION$2,
		key: "nodes",
		label: "node",
		isRecord: isNodeRecord,
		migrate: migrateV1
	};
	return {
		async load() {
			nodes = [...await readDocument(document)];
			loaded = true;
			return nodes;
		},
		list() {
			requireLoaded();
			return [localNode(), ...nodes];
		},
		get(nodeId) {
			requireLoaded();
			if (nodeId === LOCAL_NODE_ID) return localNode();
			return nodes.find((node) => node.nodeId === nodeId);
		},
		async upsert(draft) {
			requireLoaded();
			if (draft.nodeId === LOCAL_NODE_ID) throw new Error("the local machine is built in and cannot be configured");
			const stamp = now().toISOString();
			const existing = draft.nodeId === void 0 ? void 0 : nodes.find((node) => node.nodeId === draft.nodeId);
			const record = {
				nodeId: existing?.nodeId ?? draft.nodeId ?? brandString(randomUUID()),
				title: draft.title?.trim() || defaultNodeTitle(draft.transport),
				transport: draft.transport,
				token: draft.token,
				createdAt: existing?.createdAt ?? stamp,
				updatedAt: stamp
			};
			const next = existing === void 0 ? [...nodes, record] : nodes.map((node) => node.nodeId === record.nodeId ? record : node);
			await writeDocument(document, next);
			nodes = next;
			return record;
		},
		async remove(nodeId) {
			requireLoaded();
			if (nodeId === LOCAL_NODE_ID) return false;
			const next = nodes.filter((node) => node.nodeId !== nodeId);
			if (next.length === nodes.length) return false;
			await writeDocument(document, next);
			nodes = next;
			return true;
		}
	};
}
//#endregion
//#region src/models/routing.ts
/**
* Route classification: decide which execution world a model- or
* plugin-supplied path belongs to.
*
* Two spellings name the same remote file, and both occur in practice:
*
* - the **anchor** path — a real local directory the session's cwd and
*   workspace point at, which is what the harness itself passes around;
* - the **remote** path — the absolute path on the node, which is what the
*   model sees once the prompt's cwd variable is overridden.
*
* A remote absolute path is only routable while exactly one live anchor claims
* it as its remote root. Two nodes commonly share `/home/<user>/<repo>`, so an
* ambiguous match is a typed failure rather than a silent pick: guessing would
* read one machine and write another.
*
* @module dsh-remote-workspace/models/routing
*/
/**
* What an ambiguous path is refused with. Shared because three seams refuse it
* — the filesystem's typed error, a process spawn, and a terminal allocation —
* and all three must name the same claiming nodes.
*/
function ambiguousPathMessage(route) {
	return `"${route.remotePath}" belongs to more than one node (${route.nodeIds.join(", ")}); address it as node:<id>:<path>`;
}
/**
* The explicit `node:<nodeId>:<path>` spelling. `nodeId` never contains a
* colon, so the first one separates the id from an absolute POSIX path.
*/
const EXPLICIT = /^node:([^:/]+):(\/.*)$/s;
/**
* Whether `child` equals `parent` or lies below it, on whole path segments.
*
* A plain `startsWith` would match `/srv/app-old` against `/srv/app`.
* @param parent - the canonical ancestor.
* @param child - the canonical candidate.
* @returns true when the candidate is the ancestor or one of its descendants.
*/
function isWithin(parent, child) {
	if (child === parent) return true;
	const root = parent.endsWith("/") ? parent : `${parent}/`;
	return child.startsWith(root);
}
/**
* Make a path absolute and remove `.` and `..` segments without touching the
* filesystem. A relative path resolves against `cwd`, falling back to `/` so
* classification always yields a definite answer.
* @param input - the path as supplied.
* @param cwd - the resolving base, typically the session cwd.
* @returns a normalized absolute POSIX path.
*/
function toAbsolute(input, cwd) {
	const unified = input.replaceAll("\\", "/");
	if (unified.startsWith("/")) return posix.normalize(unified);
	return posix.normalize(posix.join(cwd === void 0 ? "/" : cwd, unified));
}
/**
* Classify one path against the live anchors.
*
* Precedence is: the explicit `node:<id>:<path>` spelling, then the anchor
* prefix, then a remote root claimed by exactly one anchor, then the local
* world. The anchor branch wins over the remote-root branch because it carries
* the node id unambiguously.
* @param input - the path as supplied by a tool call or another plugin.
* @param cwd - the resolving base for a relative path.
* @param anchors - every anchor this plugin currently owns.
* @returns the route, including the `ambiguous` verdict this module exists for.
*/
function classifyPath(input, cwd, anchors) {
	const explicit = EXPLICIT.exec(input);
	if (explicit !== null) return {
		kind: "remote",
		nodeId: asNodeId(explicit[1]),
		remotePath: posix.normalize(explicit[2])
	};
	const absolute = toAbsolute(input, cwd);
	for (const anchor of anchors) if (isWithin(anchor.anchorPath, absolute)) {
		const suffix = absolute.slice(anchor.anchorPath.length);
		return {
			kind: "remote",
			nodeId: anchor.nodeId,
			remotePath: posix.join(anchor.remoteRoot, suffix)
		};
	}
	const claiming = anchors.filter((anchor) => isWithin(anchor.remoteRoot, absolute));
	if (claiming.length === 1) return {
		kind: "remote",
		nodeId: claiming[0].nodeId,
		remotePath: absolute
	};
	if (claiming.length > 1) return {
		kind: "ambiguous",
		remotePath: absolute,
		nodeIds: claiming.map((anchor) => anchor.nodeId)
	};
	return { kind: "local" };
}
//#endregion
//#region src/storage/anchors.ts
/**
* The anchor directory store.
*
* A remote worktree has no local directory of its own, but the harness gives a
* session a local cwd, requires a workspace path to exist and to survive
* `realpath`, and validates session membership against it. An anchor is the
* answer: a real, empty local directory whose metadata names the remote
* coordinates, so `ctx.fs` can route everything below it to the node while
* every other subsystem keeps working on an ordinary local path.
*
* Layout, one directory per worktree:
*
* ```
* <root>/<nodeId>/<repo base>/<name>/.dsh-remote-worktree.json
* ```
*
* The directory is the identity; the metadata is the mapping. Removing the
* metadata without the directory would leave a path that still routes, so both
* move together.
*
* An anchor maps one remote directory, and there are two cases. A worktree
* anchor maps the checkout `git worktree add` produced, and is what the
* lifecycle cuts and removes. A directory anchor maps the repository directory
* itself, which is what lets a machine's plain directory be opened as a
* workspace before it is a git repository — and stay one after it becomes a
* repository and worktrees are cut beside it.
*
* @module dsh-remote-workspace/storage/anchors
*/
/** Metadata file name inside every anchor directory. */
const ANCHOR_FILE = ".dsh-remote-worktree.json";
/** Metadata revision; a field change bumps it and refuses the old form. */
const DOCUMENT_VERSION$1 = 1;
/** Segment a directory anchor lives at, beside the worktrees of its repository. */
const DIRECTORY_SEGMENT = ".self";
/**
* Admit a string as an anchor id.
*
* Called where a string first becomes an id: a tool argument, a route segment,
* or one this plugin derives from the coordinates it names. Every later hop
* carries the type.
* @param value - the string the parser produced.
* @returns the same string, branded.
*/
function asAnchorId(value) {
	return brandString(value);
}
/** Owner-only permissions: the file is bookkeeping, not a secret. */
const FILE_MODE = 384;
/** How deep the loader walks below the anchor root: node / repo / name. */
const SCAN_DEPTH = 3;
/** Whether an unknown value is a record this module wrote. */
function isAnchorRecord(value) {
	if (typeof value !== "object" || value === null) return false;
	const record = value;
	const kind = record.kind;
	return typeof record.anchorId === "string" && typeof record.nodeId === "string" && (kind === void 0 || kind === "worktree" || kind === "directory") && typeof record.name === "string" && typeof record.anchorPath === "string" && typeof record.remoteRoot === "string" && typeof record.repoPath === "string" && (typeof record.branch === "string" || record.branch === void 0 && kind === "directory") && typeof record.createdAt === "string";
}
/**
* Parse one metadata document.
* @param text - the file content.
* @param file - the path, used only to name a failure.
* @returns the record.
* @throws when the JSON is malformed, the version is unsupported, or the
*   record does not match the stored fields.
*/
function parseAnchor(text, file) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${file} is not valid JSON`, { cause: error });
	}
	const document = parsed;
	if (document.version !== DOCUMENT_VERSION$1) throw new Error(`${file} has document version ${String(document.version)}; this build reads ${String(DOCUMENT_VERSION$1)}`);
	if (!isAnchorRecord(document.anchor)) throw new Error(`${file} carries an anchor this build does not understand`);
	const anchor = document.anchor;
	if (anchor.kind === "directory") return anchor;
	return {
		...anchor,
		kind: "worktree",
		origin: anchor.origin === "adopted" ? "adopted" : "created"
	};
}
/**
* Walk the anchor tree and collect every metadata file it finds.
*
* Only directories are descended into, and a symlink is neither a directory
* nor a metadata file here, so a link planted in the tree cannot make the scan
* loop or escape the root.
* @param dir - the directory to scan.
* @param depth - levels still permitted below `dir`.
* @returns the metadata file paths.
*/
async function findMetadataFiles(dir, depth) {
	if (depth < 0) return [];
	const found = [];
	const entries = await readdir(dir, { withFileTypes: true }).catch((error) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	for (const entry of entries) {
		const child = join(dir, entry.name);
		if (entry.isFile() && entry.name === ".dsh-remote-worktree.json") {
			found.push(child);
			continue;
		}
		if (entry.isDirectory()) found.push(...await findMetadataFiles(child, depth - 1));
	}
	return found;
}
/**
* Build an anchor store over one root.
* @param deps - the root and an optional clock.
* @returns the store; call {@link AnchorStore.load} before serving reads.
*/
function createAnchorStore(deps) {
	const now = deps.now ?? (() => /* @__PURE__ */ new Date());
	let root = resolve(deps.root);
	let anchors = [];
	let loaded = false;
	const requireLoaded = () => {
		if (!loaded) throw new Error("anchor store read before load()");
	};
	return {
		async load() {
			await mkdir(root, { recursive: true });
			root = await realpath(root);
			const files = (await findMetadataFiles(root, SCAN_DEPTH)).sort();
			anchors = [];
			for (const file of files) {
				const record = parseAnchor(await readFile(file, "utf8"), file);
				anchors.push({
					...record,
					anchorPath: await realpath(dirname(file))
				});
			}
			loaded = true;
			return anchors;
		},
		list() {
			requireLoaded();
			return anchors;
		},
		get(anchorId) {
			requireLoaded();
			return anchors.find((anchor) => anchor.anchorId === anchorId);
		},
		async create(draft) {
			requireLoaded();
			const anchorPath = join(root, draft.nodeId, basename(draft.repoPath), draft.kind === "directory" ? DIRECTORY_SEGMENT : draft.name);
			if (anchors.some((anchor) => anchor.anchorPath === anchorPath)) throw new Error(`an anchor already owns ${anchorPath}`);
			const shared = {
				anchorId: brandString(randomUUID()),
				nodeId: draft.nodeId,
				name: draft.name,
				anchorPath,
				remoteRoot: draft.remoteRoot,
				repoPath: draft.repoPath,
				createdAt: now().toISOString()
			};
			const record = draft.kind === "worktree" ? {
				...shared,
				kind: "worktree",
				branch: draft.branch,
				origin: draft.origin ?? "created"
			} : {
				...shared,
				kind: "directory"
			};
			await mkdir(anchorPath, { recursive: true });
			await writeFileAtomic(join(anchorPath, ANCHOR_FILE), `${JSON.stringify({
				version: DOCUMENT_VERSION$1,
				anchor: record
			}, null, 2)}\n`, { mode: FILE_MODE });
			anchors = [...anchors, record];
			return record;
		},
		async remove(anchorId) {
			requireLoaded();
			const record = anchors.find((anchor) => anchor.anchorId === anchorId);
			if (record === void 0) return void 0;
			await rm(record.anchorPath, {
				recursive: true,
				force: true
			});
			anchors = anchors.filter((anchor) => anchor.anchorId !== anchorId);
			return record;
		},
		routes() {
			requireLoaded();
			return anchors.map((anchor) => ({
				nodeId: anchor.nodeId,
				anchorPath: anchor.anchorPath,
				remoteRoot: anchor.remoteRoot
			}));
		}
	};
}
//#endregion
//#region src/local/git.ts
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
const run = promisify(execFile);
/** Everything one git invocation is allowed to buffer. */
const MAX_BUFFER = 8 << 20;
/** A git failure, carrying the same discriminant the daemon's errors carry. */
var LocalGitError = class extends Error {
	/** Which kind of failure this is. */
	code;
	/**
	* @param code - the failure's kind.
	* @param message - what git said.
	*/
	constructor(code, message) {
		super(message);
		this.name = "LocalGitError";
		this.code = code;
	}
};
/** How git spells a directory it does not consider a repository. */
const NOT_A_REPOSITORY = /not a git repository/i;
/**
* Run one git command in a repository.
* @param repoPath - the directory git runs in.
* @param args - the arguments after `-C <repoPath>`.
* @returns git's standard output.
* @throws LocalGitError, distinguishing "not a repository" from every other failure.
*/
async function git(repoPath, args) {
	try {
		const { stdout } = await run("git", [
			"-C",
			repoPath,
			...args
		], {
			env: {
				...process.env,
				GIT_OPTIONAL_LOCKS: "0"
			},
			maxBuffer: MAX_BUFFER
		});
		return stdout;
	} catch (error) {
		const stderr = String(error.stderr ?? "").trim();
		const message = stderr === "" ? String(error instanceof Error ? error.message : error) : stderr;
		throw new LocalGitError(NOT_A_REPOSITORY.test(message) ? "GIT_NOT_A_REPOSITORY" : "GIT_COMMAND_FAILED", message);
	}
}
/**
* Whether git owns a directory.
* @param repoPath - the directory to ask about.
* @returns true when the directory is inside a work tree.
* @throws LocalGitError when git could not be asked at all.
*/
async function isRepository(repoPath) {
	try {
		return (await git(repoPath, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
	} catch (error) {
		if (error instanceof LocalGitError && error.code === "GIT_NOT_A_REPOSITORY") return false;
		throw error;
	}
}
/**
* Every checkout git knows for a repository.
* @param repoPath - the repository to ask.
* @returns the entries in git's own order, the main worktree first.
* @throws LocalGitError when the directory is not a repository.
*/
async function listWorktrees(repoPath) {
	const porcelain = await git(repoPath, [
		"worktree",
		"list",
		"--porcelain"
	]);
	const found = [];
	for (const block of porcelain.split("\n\n")) {
		const lines = block.split("\n").filter((line) => line !== "");
		const path = lines.find((line) => line.startsWith("worktree "))?.slice(9);
		if (path === void 0) continue;
		const ref = lines.find((line) => line.startsWith("branch "))?.slice(7);
		found.push({
			path,
			branch: ref === void 0 ? null : ref.replace(/^refs\/heads\//, ""),
			main: found.length === 0
		});
	}
	return found;
}
/**
* Cut a worktree and its branch.
* @param options - the repository, the checkout path, and the branch to create.
* @throws LocalGitError when git refuses.
*/
async function addWorktree(options) {
	await git(options.repoPath, [
		"worktree",
		"add",
		"-b",
		options.branch,
		options.worktreePath,
		...options.baseRef === void 0 ? [] : [options.baseRef]
	]);
}
/**
* Remove one checkout, leaving its branch.
* @param options - the repository, the checkout, and whether to discard changes.
* @throws LocalGitError when git refuses.
*/
async function removeWorktree(options) {
	await git(options.repoPath, [
		"worktree",
		"remove",
		...options.force ? ["--force"] : [],
		options.worktreePath
	]);
}
/**
* Delete one branch.
* @param options - the repository, the branch, and whether an unmerged branch goes too.
* @throws LocalGitError when git refuses.
*/
async function deleteBranch(options) {
	await git(options.repoPath, [
		"branch",
		options.force ? "-D" : "-d",
		options.branch
	]);
}
//#endregion
//#region src/local/fs.ts
/**
* This host's own filesystem, for the management plane.
*
* The panel's operations run where the plugin runs, so the local machine's
* answers come from `node:fs` rather than from the routed `ctx.fs` seam: that
* seam belongs to a session's execution world, and the panel has to keep
* working from a deployment whose sessions are confined somewhere else — or
* whose execution world is another machine entirely.
*
* @module dsh-remote-workspace/local/fs
*/
/**
* Resolve a path the way a machine resolves one.
*
* Existence is not part of the answer: a path that is not there still has a
* canonical spelling, and keeping the two questions apart is what lets the
* caller answer "does not exist" with the status that belongs to it rather
* than with a resolver failure.
* @param path - the caller's path, absolute or relative to the harness' cwd.
* @returns the canonical absolute path.
*/
async function resolveLocalPath(path) {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
}
/**
* Read one path's type.
*
* A symlink reports what it resolves to, because every caller is asking what a
* workspace would run in. The listing below answers the other question.
* @param path - the absolute path to probe.
* @returns the type, or undefined when nothing is there.
*/
async function localPathType(path) {
	try {
		const info = await stat(path);
		if (info.isDirectory()) return "directory";
		if (info.isFile()) return "file";
		return "other";
	} catch {
		return;
	}
}
/**
* List one directory's entries.
*
* Sizes are not read: nothing in the panel shows them, and one `stat` per entry
* would buy a column no surface renders.
* @param path - the absolute directory to read.
* @returns its entries in the order the filesystem reports them.
* @throws the filesystem failure when the directory cannot be read.
*/
async function listLocalDir(path) {
	return (await readdir(path, { withFileTypes: true })).map((entry) => ({
		name: entry.name,
		type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
		path: resolve(path, entry.name)
	}));
}
//#endregion
//#region src/models/worktrees.ts
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
/** Prefix every managed branch carries. */
const BRANCH_PREFIX = "worktree/";
/** The path a managed checkout is created at, on whichever machine owns it. */
function managedWorktreePath(root, repoPath, name) {
	return posix.join(root, posix.basename(repoPath), name);
}
/** The branch a managed checkout is created on. */
function branchFor(name) {
	return `${BRANCH_PREFIX}${name}`;
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
async function isManaged(deps, anchor) {
	if (anchor.kind !== "worktree") return false;
	if (anchor.origin !== void 0) return anchor.origin === "created";
	const root = deps.worktreeRoot(anchor.nodeId).replace(/\/+$/, "");
	const prefix = deps.isLocalNode(anchor.nodeId) ? await resolveLocalPath(root) : root;
	return anchor.remoteRoot.startsWith(`${prefix}/`);
}
/**
* Register an anchor as a workspace, best effort.
* @param deps - the manager's dependencies.
* @param anchor - the anchor to register as a workspace.
*/
async function registerWorkspace(deps, anchor) {
	try {
		await deps.workspace?.register(anchor);
	} catch {}
}
/**
* Drop an anchor's workspace registration.
* @param deps - the manager's dependencies.
* @param anchor - the anchor that was removed.
*/
async function unregisterWorkspace(deps, anchor) {
	try {
		await deps.workspace?.unregister(anchor);
	} catch {}
}
/**
* Prefix that marks an id as naming a path on this host.
*
* A machine's ids come from the anchor store and are generated once. This host
* has no such store, so its ids are derived from what they name and stay opaque
* to every caller: nothing outside this module reads more than this prefix.
*/
const LOCAL_ID_PREFIX = "local:";
/** The id one local path is addressed by. */
function localAnchorId(kind, path, repoPath) {
	return asAnchorId(kind === "directory" ? `${LOCAL_ID_PREFIX}directory:${encodePart(path)}` : `${LOCAL_ID_PREFIX}worktree:${encodePart(path)}:${encodePart(repoPath)}`);
}
/** Prefix that marks an id as naming a checkout git reports on a machine. */
const REMOTE_ID_PREFIX = "remote:";
/** One URL-safe encoding of a value, for composing a derived id. */
const encodePart = (value) => Buffer.from(value, "utf8").toString("base64url");
/** The inverse of {@link encodePart}. */
const decodePart = (value) => Buffer.from(value, "base64url").toString("utf8");
/** The id one machine's git-reported checkout is addressed by before it is held. */
function remoteAnchorId(nodeId, repoPath, path) {
	return asAnchorId(`${REMOTE_ID_PREFIX}${encodePart(nodeId)}:${encodePart(repoPath)}:${encodePart(path)}`);
}
/** The coordinates a git-reported id carries, or undefined for any other id. */
function parseRemoteAnchorId(value) {
	if (!value.startsWith(REMOTE_ID_PREFIX)) return void 0;
	const [node, repo, path] = value.slice(7).split(":");
	if (node === void 0 || repo === void 0 || path === void 0) return void 0;
	return {
		nodeId: asNodeId(decodePart(node)),
		repoPath: decodePart(repo),
		path: decodePart(path)
	};
}
/**
* The record a git-reported checkout is shown as before this plugin holds it.
*
* The id is derived from the checkout's coordinates rather than minted, so the
* same git worktree lists under the same id on every read; `anchorPath` is a
* placeholder until an open adopts it and mints the real local directory.
*/
function remotePlaceholder(nodeId, repoPath, path, branch, createdAt) {
	return {
		anchorId: remoteAnchorId(nodeId, repoPath, path),
		nodeId,
		kind: "worktree",
		name: posix.basename(path) || path,
		repoPath,
		anchorPath: path,
		remoteRoot: path,
		branch,
		origin: "adopted",
		createdAt
	};
}
/** The row a local repository itself is opened through. */
function localDirectoryAnchor(record) {
	const name = posix.basename(record.repoPath) || record.repoPath;
	return {
		anchorId: localAnchorId("directory", record.repoPath, record.repoPath),
		nodeId: record.nodeId,
		kind: "directory",
		name,
		repoPath: record.repoPath,
		anchorPath: record.repoPath,
		remoteRoot: record.repoPath,
		createdAt: record.createdAt
	};
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
async function rowStatus(deps, anchor, offlineError) {
	try {
		return {
			anchor,
			open: await deps.workspace?.registered(anchor) ?? false,
			managed: await isManaged(deps, anchor),
			held: true,
			...offlineError === void 0 ? {} : { error: offlineError }
		};
	} catch (error) {
		return {
			anchor,
			open: false,
			managed: false,
			held: true,
			error: error instanceof Error ? error.message : String(error)
		};
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
async function localStatuses(deps) {
	const statuses = [];
	for (const repo of deps.repos.list()) {
		if (!deps.isLocalNode(repo.nodeId)) continue;
		const directory = localDirectoryAnchor(repo);
		statuses.push(await rowStatus(deps, directory));
		if (!await isRepository(repo.repoPath).catch(() => false)) continue;
		const checkouts = await listWorktrees(repo.repoPath).catch(() => []);
		for (const checkout of checkouts.slice(1)) {
			if (await localPathType(checkout.path).catch(() => void 0) !== "directory") continue;
			const anchor = {
				anchorId: localAnchorId("worktree", checkout.path, repo.repoPath),
				nodeId: repo.nodeId,
				kind: "worktree",
				name: posix.basename(checkout.path) || checkout.path,
				repoPath: repo.repoPath,
				anchorPath: checkout.path,
				remoteRoot: checkout.path,
				branch: checkout.branch ?? "",
				createdAt: repo.createdAt
			};
			statuses.push(await rowStatus(deps, anchor));
		}
	}
	return statuses;
}
/** Register a repository nobody has registered yet, keeping a known name. */
async function registerRepoIfUnknown(deps, nodeId, repoPath) {
	if (deps.repos.find({
		nodeId,
		repoPath
	}) === void 0) await deps.repos.upsert({
		nodeId,
		repoPath
	});
}
/** Narrow a record to a worktree, refusing the repository directory. */
function requireWorktree(anchor) {
	if (anchor.kind !== "worktree") throw new Error(`"${anchor.name}" is the repository directory, not a worktree; close it instead`);
	return anchor;
}
/** The directory anchor one machine path is held under, if this host holds one. */
function directoryAnchorOf(deps, ref) {
	return deps.anchors.list().find((anchor) => anchor.kind === "directory" && anchor.nodeId === ref.nodeId && anchor.repoPath === ref.repoPath);
}
/** One local row by the id a caller holds, or undefined when none carries it. */
async function localEntry(deps, anchorId) {
	return (await localStatuses(deps)).find((status) => status.anchor.anchorId === anchorId)?.anchor;
}
/**
* Cut a worktree on this host and register its checkout.
* @param deps - the manager's dependencies.
* @param draft - node, repository, name, and optional base revision.
* @returns the created checkout's record.
*/
async function createLocalWorktree(deps, draft) {
	const repoPath = await resolveLocalPath(draft.repoPath);
	if (!await isRepository(repoPath)) throw new Error(`"${repoPath}" is not a git repository on this machine`);
	const branch = branchFor(draft.name);
	const plannedPath = draft.path ?? managedWorktreePath(deps.worktreeRoot(draft.nodeId), repoPath, draft.name);
	await addWorktree({
		repoPath,
		worktreePath: plannedPath,
		branch,
		...draft.baseRef === void 0 ? {} : { baseRef: draft.baseRef }
	});
	const worktreePath = await resolveLocalPath(plannedPath);
	const anchor = {
		anchorId: localAnchorId("worktree", worktreePath, repoPath),
		nodeId: draft.nodeId,
		kind: "worktree",
		name: draft.name,
		repoPath,
		anchorPath: worktreePath,
		remoteRoot: worktreePath,
		branch,
		createdAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	await registerRepoIfUnknown(deps, draft.nodeId, repoPath);
	await registerWorkspace(deps, anchor);
	return anchor;
}
/**
* Remove one checkout on this host, leaving its branch.
* @param deps - the manager's dependencies.
* @param anchor - the checkout's record.
* @param options - `force` discards uncommitted changes; `deleteBranch` also
*   deletes the branch.
* @returns what was removed, and whether the branch followed.
*/
async function removeLocalWorktree(deps, anchor, options) {
	await removeWorktree({
		repoPath: anchor.repoPath,
		worktreePath: anchor.anchorPath,
		force: options.force
	});
	await unregisterWorkspace(deps, anchor);
	return await dropBranchOrReport(anchor, options, () => deleteBranch({
		repoPath: anchor.repoPath,
		branch: anchor.branch,
		force: options.force
	}));
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
async function openOrDrop(deps, anchor, open) {
	try {
		await open();
	} catch (error) {
		await deps.anchors.remove(anchor.anchorId);
		throw error;
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
async function dropBranchOrReport(anchor, options, remove) {
	if (!options.deleteBranch) return {
		anchor,
		branchDeleted: false
	};
	try {
		await remove();
		return {
			anchor,
			branchDeleted: true
		};
	} catch (error) {
		return {
			anchor,
			branchDeleted: false,
			branchError: error instanceof Error ? error.message : String(error)
		};
	}
}
/**
* Register one path as a workspace, so a session can be opened on it.
* @param deps - the manager's dependencies.
* @param anchor - the worktree or directory to open.
* @returns the anchor that is now open.
* @throws when the deployment composes no workspace registry, or it refuses.
*/
async function openAsWorkspace(deps, anchor) {
	const workspace = deps.workspace;
	if (workspace === void 0) throw new Error("this deployment composes no workspace registry, so a worktree cannot be opened");
	await workspace.register(anchor);
	return anchor;
}
/**
* Build the worktree manager.
* @param deps - the anchor store, the repository records, and the node lookups.
* @returns the lifecycle handle.
*/
function createWorktreeManager(deps) {
	/** The live channel for an anchor's node, or the typed offline failure. */
	const channelFor = (nodeId) => {
		const channel = deps.channel(nodeId);
		if (channel === void 0) throw new NodeRequestError({
			code: "GIT_COMMAND_FAILED",
			message: `remote node "${nodeId}" is not connected`
		});
		return channel;
	};
	/** The machine's own checkouts for one repository, minus its main one. */
	const listExisting = async (ref) => {
		if (deps.isLocalNode(ref.nodeId)) return (await listWorktrees(ref.repoPath).catch(() => [])).slice(1).map((checkout) => ({
			path: checkout.path,
			name: posix.basename(checkout.path) || checkout.path,
			branch: checkout.branch ?? "",
			registered: true
		}));
		const channel = channelFor(ref.nodeId);
		const { canonicalPath } = await channel.request("fs.resolve", { path: ref.repoPath });
		const listed = await channel.request("git.worktreeList", { repoPath: canonicalPath });
		const held = deps.anchors.list();
		return listed.filter((entry) => !entry.main).map((entry) => ({
			path: entry.path,
			name: posix.basename(entry.path) || entry.path,
			branch: entry.branch ?? "",
			registered: held.some((anchor) => anchor.nodeId === ref.nodeId && anchor.remoteRoot === entry.path)
		}));
	};
	/** The held anchor for one git-reported checkout, if this plugin already holds it. */
	const heldRemote = (discovered) => deps.anchors.list().find((anchor) => anchor.kind === "worktree" && anchor.nodeId === discovered.nodeId && anchor.repoPath === discovered.repoPath && anchor.remoteRoot === discovered.path);
	/** Open a remote checkout git already lists, adopting it when it is new. */
	const adoptRemote = async (ref, path) => {
		const entry = (await listExisting(ref)).find((candidate) => candidate.path === path);
		if (entry === void 0) throw new Error(`"${path}" is not a worktree of "${ref.repoPath}" on that machine`);
		const held = heldRemote({
			nodeId: ref.nodeId,
			repoPath: ref.repoPath,
			path
		});
		if (held !== void 0) return await openAsWorkspace(deps, held);
		const anchor = await deps.anchors.create({
			kind: "worktree",
			nodeId: ref.nodeId,
			name: posix.basename(path) || path,
			repoPath: ref.repoPath,
			remoteRoot: path,
			branch: entry.branch,
			origin: "adopted"
		});
		await openOrDrop(deps, anchor, () => openAsWorkspace(deps, anchor));
		return {
			...anchor,
			kind: "worktree",
			branch: entry.branch
		};
	};
	/** Remove one held remote checkout, dropping its record with the checkout. */
	const removeRemote = async (anchor, options) => {
		const channel = channelFor(anchor.nodeId);
		await channel.request("git.worktreeRemove", {
			repoPath: anchor.repoPath,
			worktreePath: anchor.remoteRoot,
			force: options.force
		});
		await unregisterWorkspace(deps, anchor);
		await deps.anchors.remove(anchor.anchorId);
		return await dropBranchOrReport(anchor, options, () => channel.request("git.branchDelete", {
			repoPath: anchor.repoPath,
			branch: anchor.branch,
			force: options.force
		}));
	};
	/** Remove a checkout git reports but this plugin never adopted. */
	const removeDiscovered = async (discovered, options) => {
		const ref = {
			nodeId: discovered.nodeId,
			repoPath: discovered.repoPath
		};
		const entry = (await listExisting(ref)).find((candidate) => candidate.path === discovered.path);
		if (entry === void 0) throw new Error(`"${discovered.path}" is not a worktree of "${discovered.repoPath}" on that machine`);
		const channel = channelFor(discovered.nodeId);
		await channel.request("git.worktreeRemove", {
			repoPath: discovered.repoPath,
			worktreePath: discovered.path,
			force: options.force
		});
		const anchor = remotePlaceholder(discovered.nodeId, discovered.repoPath, discovered.path, entry.branch, (/* @__PURE__ */ new Date()).toISOString());
		if (!options.deleteBranch || entry.branch === "") return {
			anchor,
			branchDeleted: false
		};
		return await dropBranchOrReport(anchor, options, () => channel.request("git.branchDelete", {
			repoPath: discovered.repoPath,
			branch: entry.branch,
			force: options.force
		}));
	};
	/**
	* Rows for every checkout git reports on a machine that this plugin does not
	* hold yet, so the panel reads worktrees from git rather than from records a
	* person had to create by hand. A repository whose git cannot be read is
	* skipped, because one broken repository must not blank the others.
	*/
	const discoveredRemote = async (held) => {
		const statuses = [];
		for (const repo of deps.repos.list()) {
			if (deps.isLocalNode(repo.nodeId) || deps.channel(repo.nodeId) === void 0) continue;
			try {
				for (const checkout of await listExisting(repo)) {
					if (held.has(`${repo.nodeId}\u0000${checkout.path}`)) continue;
					statuses.push({
						anchor: remotePlaceholder(repo.nodeId, repo.repoPath, checkout.path, checkout.branch, repo.createdAt),
						open: false,
						held: false,
						managed: false
					});
				}
			} catch {}
		}
		return statuses;
	};
	/** The anchor a caller's id names, wherever it is recorded. */
	const entryById = async (anchorId) => anchorId.startsWith(LOCAL_ID_PREFIX) ? await localEntry(deps, anchorId) : deps.anchors.get(anchorId);
	return {
		async create(draft) {
			if (deps.isLocalNode(draft.nodeId)) return await createLocalWorktree(deps, draft);
			const channel = channelFor(draft.nodeId);
			const { canonicalPath: repoPath } = await channel.request("fs.resolve", { path: draft.repoPath });
			const branch = branchFor(draft.name);
			const worktreePath = draft.path ?? managedWorktreePath(deps.worktreeRoot(draft.nodeId), repoPath, draft.name);
			const worktree = await channel.request("git.worktreeAdd", {
				repoPath,
				worktreePath,
				branch,
				...draft.baseRef === void 0 ? {} : { baseRef: draft.baseRef }
			});
			const checkedOut = worktree.branch ?? branch;
			const anchor = await deps.anchors.create({
				kind: "worktree",
				nodeId: draft.nodeId,
				name: draft.name,
				repoPath,
				remoteRoot: worktree.path,
				branch: checkedOut,
				origin: "created"
			});
			await registerRepoIfUnknown(deps, draft.nodeId, repoPath);
			await registerWorkspace(deps, anchor);
			return {
				...anchor,
				kind: "worktree",
				branch: checkedOut
			};
		},
		async list() {
			const statuses = [...await localStatuses(deps)];
			const held = /* @__PURE__ */ new Set();
			for (const anchor of deps.anchors.list()) {
				const offline = deps.channel(anchor.nodeId) === void 0 ? `node "${anchor.nodeId}" is not connected` : void 0;
				statuses.push(await rowStatus(deps, anchor, offline));
				if (anchor.kind === "worktree") held.add(`${anchor.nodeId}\u0000${anchor.remoteRoot}`);
			}
			statuses.push(...await discoveredRemote(held));
			return statuses;
		},
		existing: listExisting,
		async adopt(ref, path) {
			if (deps.isLocalNode(ref.nodeId)) {
				if (!(await listExisting(ref)).some((candidate) => candidate.path === path)) throw new Error(`"${path}" is not a worktree of "${ref.repoPath}" on that machine`);
				const local = (await localStatuses(deps)).find((status) => status.anchor.nodeId === ref.nodeId && status.anchor.anchorPath === path)?.anchor;
				if (local === void 0 || local.kind !== "worktree") throw new Error(`no local checkout "${path}"`);
				return await openAsWorkspace(deps, local);
			}
			return await adoptRemote(ref, path);
		},
		async anchorsIn(ref) {
			if (deps.isLocalNode(ref.nodeId)) return (await localStatuses(deps)).filter((status) => status.anchor.repoPath === ref.repoPath).map((status) => status.anchor);
			return deps.anchors.list().filter((anchor) => anchor.nodeId === ref.nodeId && anchor.repoPath === ref.repoPath);
		},
		async remove(anchorId, options) {
			if (anchorId.startsWith(LOCAL_ID_PREFIX)) {
				const anchor = await localEntry(deps, anchorId);
				if (anchor === void 0) throw new Error(`no worktree "${anchorId}" on this machine`);
				return await removeLocalWorktree(deps, requireWorktree(anchor), options);
			}
			const discovered = parseRemoteAnchorId(anchorId);
			if (discovered !== void 0) {
				const held = heldRemote(discovered);
				return held === void 0 ? await removeDiscovered(discovered, options) : await removeRemote(held, options);
			}
			const anchor = deps.anchors.get(anchorId);
			if (anchor === void 0) throw new Error(`no anchor "${anchorId}"`);
			return await removeRemote(requireWorktree(anchor), options);
		},
		async open(anchorId) {
			const discovered = parseRemoteAnchorId(anchorId);
			if (discovered !== void 0) return await adoptRemote({
				nodeId: discovered.nodeId,
				repoPath: discovered.repoPath
			}, discovered.path);
			const anchor = await entryById(anchorId);
			if (anchor === void 0) throw new Error(`no worktree "${anchorId}" on this machine`);
			return await openAsWorkspace(deps, anchor);
		},
		async close(anchorId) {
			const discovered = parseRemoteAnchorId(anchorId);
			if (discovered !== void 0) {
				const held = heldRemote(discovered);
				if (held === void 0) throw new Error(`no worktree "${anchorId}" on this machine`);
				await deps.workspace?.unregister(held);
				return held;
			}
			const anchor = await entryById(anchorId);
			if (anchor === void 0) throw new Error(`no worktree "${anchorId}" on this machine`);
			await deps.workspace?.unregister(anchor);
			return anchor;
		},
		async release(anchorId) {
			const discovered = parseRemoteAnchorId(anchorId);
			if (discovered !== void 0) {
				const held = heldRemote(discovered);
				if (held === void 0) throw new Error(`no worktree "${anchorId}" on this machine`);
				await deps.workspace?.unregister(held);
				await deps.anchors.remove(held.anchorId);
				return held;
			}
			const anchor = await entryById(anchorId);
			if (anchor === void 0) throw new Error(`no worktree "${anchorId}" on this machine`);
			await deps.workspace?.unregister(anchor);
			if (!anchorId.startsWith(LOCAL_ID_PREFIX)) await deps.anchors.remove(anchorId);
			return anchor;
		},
		async openDirectory(ref) {
			const workspace = deps.workspace;
			if (workspace === void 0) throw new Error("this deployment composes no workspace registry, so a directory cannot be opened");
			if (deps.isLocalNode(ref.nodeId)) {
				const record = deps.repos.find(ref);
				if (record === void 0) throw new Error(`no repository record for "${ref.repoPath}"`);
				return await openAsWorkspace(deps, localDirectoryAnchor(record));
			}
			const existing = directoryAnchorOf(deps, ref);
			if (existing !== void 0) {
				await workspace.register(existing);
				return existing;
			}
			const { canonicalPath: repoPath } = await channelFor(ref.nodeId).request("fs.resolve", { path: ref.repoPath });
			const anchor = await deps.anchors.create({
				kind: "directory",
				nodeId: ref.nodeId,
				name: posix.basename(repoPath) || repoPath,
				repoPath,
				remoteRoot: repoPath
			});
			await openOrDrop(deps, anchor, () => workspace.register(anchor));
			return {
				...anchor,
				kind: "directory"
			};
		},
		async closeDirectory(ref) {
			if (deps.isLocalNode(ref.nodeId)) {
				const record = deps.repos.find(ref);
				if (record === void 0) return void 0;
				const anchor = localDirectoryAnchor(record);
				if (!(await deps.workspace?.registered(anchor) ?? false)) return void 0;
				await unregisterWorkspace(deps, anchor);
				return anchor;
			}
			const anchor = directoryAnchorOf(deps, ref);
			if (anchor === void 0) return void 0;
			await unregisterWorkspace(deps, anchor);
			await deps.anchors.remove(anchor.anchorId);
			return anchor;
		}
	};
}
/** Separator between the three parts. */
const SEPARATOR = " · ";
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
function workspaceLabel(parts) {
	const base = posix.basename(parts.repoPath);
	const repo = parts.repoName?.trim() || (base === "" || base === "/" ? parts.repoPath : base);
	return (parts.name === void 0 ? [repo, parts.machine] : [
		parts.name,
		repo,
		parts.machine
	]).join(SEPARATOR);
}
//#endregion
//#region src/storage/repos.ts
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
/** Document revision; a field change bumps it and refuses the old form. */
const DOCUMENT_VERSION = 1;
/**
* Admit a string as a repository id.
*
* Called where a string first becomes an id: a field a request carried. Every
* later hop carries the type.
* @param value - the string that request named.
* @returns the same string, branded.
*/
function asRepoId(value) {
	return brandString(value);
}
/** Whether an unknown parsed value is a record this module wrote. */
function isRepoRecord(value) {
	if (typeof value !== "object" || value === null) return false;
	const record = value;
	return typeof record.repoId === "string" && typeof record.nodeId === "string" && typeof record.repoPath === "string" && typeof record.name === "string" && typeof record.createdAt === "string";
}
/**
* The name to show for a path no caller named.
* @param repoPath - absolute POSIX path of the checkout.
* @returns the last path segment.
*/
function defaultRepoName(repoPath) {
	return posix.basename(repoPath);
}
/**
* Build a repository store over one document.
* @param deps - the document path and an optional clock.
* @returns the store; call {@link RepoStore.load} before serving reads.
*/
function createRepoStore(deps) {
	const now = deps.now ?? (() => /* @__PURE__ */ new Date());
	let repos = [];
	let loaded = false;
	const requireLoaded = () => {
		if (!loaded) throw new Error("repository store read before load()");
	};
	const document = {
		file: deps.file,
		version: DOCUMENT_VERSION,
		key: "repos",
		label: "repository",
		isRecord: isRepoRecord
	};
	return {
		async load() {
			repos = [...await readDocument(document)];
			loaded = true;
			return repos;
		},
		list() {
			requireLoaded();
			return repos;
		},
		get(repoId) {
			requireLoaded();
			return repos.find((repo) => repo.repoId === repoId);
		},
		find(ref) {
			requireLoaded();
			return repos.find((repo) => repo.nodeId === ref.nodeId && repo.repoPath === ref.repoPath);
		},
		async upsert(draft) {
			requireLoaded();
			const existing = draft.repoId === void 0 ? void 0 : repos.find((repo) => repo.repoId === draft.repoId);
			const kept = existing !== void 0 && existing.repoPath === draft.repoPath;
			const record = {
				repoId: existing?.repoId ?? draft.repoId ?? brandString(randomUUID()),
				nodeId: draft.nodeId,
				repoPath: draft.repoPath,
				name: draft.name?.trim() || (kept ? existing.name : "") || defaultRepoName(draft.repoPath),
				createdAt: existing?.createdAt ?? now().toISOString()
			};
			const next = existing === void 0 ? [...repos, record] : repos.map((repo) => repo.repoId === record.repoId ? record : repo);
			await writeDocument(document, next);
			repos = next;
			return record;
		},
		async remove(repoId) {
			requireLoaded();
			const next = repos.filter((repo) => repo.repoId !== repoId);
			if (next.length === repos.length) return false;
			await writeDocument(document, next);
			repos = next;
			return true;
		},
		async removeByNode(nodeId) {
			requireLoaded();
			const next = repos.filter((repo) => repo.nodeId !== nodeId);
			const removed = repos.length - next.length;
			if (removed === 0) return 0;
			await writeDocument(document, next);
			repos = next;
			return removed;
		}
	};
}
//#endregion
//#region src/plugin/api.ts
/** A failure carrying the status this API answers with. */
var ApiError = class extends Error {
	/** HTTP status this failure answers with. */
	status;
	/**
	* @param status - the HTTP status to answer with.
	* @param message - the client-facing reason.
	*/
	constructor(status, message) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}
};
/** The named string field of an unknown value, or undefined. */
function stringField(value, key) {
	if (typeof value !== "object" || value === null) return void 0;
	const field = value[key];
	return typeof field === "string" ? field : void 0;
}
/** The failure for a method one of these routes does not answer. */
function notAllowed(request) {
	return new ApiError(405, `${request.method} is not allowed on ${request.path}`);
}
/**
* Read a required non-empty string field, or fail as a client error.
* @param body - the parsed request body.
* @param key - the field name.
* @returns the trimmed value.
* @throws ApiError 400 when the field is missing or empty.
*/
function requireString(body, key) {
	const value = stringField(body, key)?.trim();
	if (value === void 0 || value === "") throw new ApiError(400, `"${key}" is required and must be a non-empty string`);
	return value;
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
function requireTransport(body) {
	const ssh = typeof body === "object" && body !== null ? body["ssh"] : void 0;
	if (typeof ssh !== "object" || ssh === null) throw new ApiError(400, "\"ssh\" is required and must name how to reach the machine");
	const fields = ssh;
	const target = typeof fields["target"] === "string" ? fields["target"].trim() : "";
	if (target === "") throw new ApiError(400, "\"ssh.target\" is required and must be a non-empty string");
	const portField = fields["port"];
	if (portField !== void 0 && (typeof portField !== "number" || !Number.isInteger(portField) || portField < 1 || portField > 65535)) throw new ApiError(400, "\"ssh.port\" must be between 1 and 65535");
	const identity = typeof fields["identityFile"] === "string" ? fields["identityFile"].trim() : "";
	return {
		kind: "ssh",
		target,
		...portField === void 0 ? {} : { sshPort: portField },
		...identity === "" ? {} : { identityFile: identity }
	};
}
/** One machine's status, as this API reports it. */
function statusOf(connections, record) {
	return record.transport.kind === "local" ? {
		nodeId: record.nodeId,
		state: "ready"
	} : connections.status(record.nodeId);
}
/**
* The live channel to one machine, or the client error this API answers with.
* @param deps - the management dependencies.
* @param nodeId - the machine to reach.
* @returns the live channel.
* @throws ApiError 409 when the machine is not connected.
*/
function requireChannel$1(deps, nodeId) {
	const channel = deps.connections.channel(nodeId);
	if (channel === void 0) throw new ApiError(409, `node "${nodeId}" is not connected`);
	return channel;
}
/**
* Resolve a node id to a stored record, or fail as a client error.
* @param registry - the durable registry.
* @param nodeId - the path segment.
* @returns the record.
* @throws ApiError 404 when no node carries that id.
*/
function requireNode(registry, nodeId) {
	const record = registry.get(nodeId);
	if (record === void 0) throw new ApiError(404, `no node "${nodeId}"`);
	return record;
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
async function resolveOnNode(deps, record, path) {
	if (record.transport.kind === "local") return await resolveLocalPath(path);
	return (await requireChannel$1(deps, record.nodeId).request("fs.resolve", { path })).canonicalPath;
}
/**
* Read what one path is on a machine.
* @param deps - the management dependencies.
* @param record - the machine to ask.
* @param path - the canonical absolute path to probe.
* @returns the entry's type, or undefined when nothing is there.
* @throws ApiError 409 when the machine is not connected.
*/
async function statOnNode(deps, record, path) {
	if (record.transport.kind === "local") return await localPathType(path);
	return (await requireChannel$1(deps, record.nodeId).request("fs.stat", { path }))?.type;
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
async function reportRepo(deps, record) {
	let root;
	try {
		root = deps.worktreeRoot(record.nodeId);
	} catch {
		root = void 0;
	}
	const placed = root === void 0 ? {} : { worktreeRoot: root };
	const node = deps.registry.get(record.nodeId);
	let git = false;
	let error;
	try {
		if (node?.transport.kind === "local") git = await isRepository(record.repoPath);
		else {
			const channel = deps.connections.channel(record.nodeId);
			if (channel === void 0) error = `node "${record.nodeId}" is not connected`;
			else {
				await channel.request("git.repoState", { repoPath: record.repoPath });
				git = true;
			}
		}
	} catch (caught) {
		if (!(caught instanceof NodeRequestError && caught.data.code === "GIT_NOT_A_REPOSITORY")) error = caught instanceof Error ? caught.message : String(caught);
	}
	return {
		repo: record,
		...placed,
		git,
		...error === void 0 ? {} : { error }
	};
}
/**
* Handle the repository half of the API.
* @param request - the normalized request.
* @param parts - path segments below `/repos`.
* @param deps - the management dependencies.
* @returns the status and JSON body to answer with.
*/
async function handleRepos(request, parts, deps) {
	const [rawRepoId, action] = parts;
	const repoId = rawRepoId === void 0 ? void 0 : asRepoId(rawRepoId);
	if (repoId === void 0) {
		if (request.method === "GET") return {
			status: 200,
			body: { repos: await Promise.all(deps.repos.list().map((repo) => reportRepo(deps, repo))) }
		};
		if (request.method === "POST") {
			const nodeId = asNodeId(requireString(request.body, "nodeId"));
			const requested = requireString(request.body, "repoPath");
			const node = requireNode(deps.registry, nodeId);
			const repoPath = await resolveOnNode(deps, node, requested);
			const target = await statOnNode(deps, node, repoPath);
			if (target === void 0) throw new ApiError(400, `"${repoPath}" does not exist on that machine`);
			if (target !== "directory") throw new ApiError(400, `"${repoPath}" is a ${target} on that machine, not a directory`);
			const existing = deps.repos.find({
				nodeId,
				repoPath
			});
			const name = stringField(request.body, "name")?.trim();
			const record = await deps.repos.upsert({
				...existing === void 0 ? {} : { repoId: existing.repoId },
				nodeId,
				repoPath,
				...name === void 0 || name === "" ? {} : { name }
			});
			return {
				status: existing === void 0 ? 201 : 200,
				body: { repo: await reportRepo(deps, record) }
			};
		}
		throw notAllowed(request);
	}
	const record = deps.repos.get(repoId);
	if (record === void 0) throw new ApiError(404, `no repository "${repoId}"`);
	const ref = {
		nodeId: record.nodeId,
		repoPath: record.repoPath
	};
	if (action === "open" || action === "close") {
		if (request.method !== "POST") throw notAllowed(request);
		if (action === "open") return {
			status: 200,
			body: { anchor: await deps.worktrees.openDirectory(ref) }
		};
		return {
			status: 200,
			body: { closed: await deps.worktrees.closeDirectory(ref) !== void 0 }
		};
	}
	if (action === "worktrees") {
		if (request.method === "GET") return {
			status: 200,
			body: { worktrees: await deps.worktrees.existing(ref) }
		};
		if (request.method === "POST") return {
			status: 201,
			body: { worktree: await deps.worktrees.adopt(ref, requireString(request.body, "path")) }
		};
		throw notAllowed(request);
	}
	if (action !== void 0) throw new ApiError(404, `unknown endpoint ${request.method} ${request.path}`);
	if (request.method === "GET") return {
		status: 200,
		body: { repo: await reportRepo(deps, record) }
	};
	if (request.method === "DELETE") {
		const held = (await deps.worktrees.anchorsIn(ref)).filter((anchor) => anchor.kind === "worktree");
		if (held.length > 0) throw new ApiError(409, `${String(held.length)} worktree(s) still belong to this repository; remove them first`);
		await deps.worktrees.closeDirectory(ref);
		return {
			status: 200,
			body: { deleted: await deps.repos.remove(repoId) }
		};
	}
	throw notAllowed(request);
}
/**
* Handle the worktree half of the API.
* @param request - the normalized request.
* @param parts - path segments below `/worktrees`.
* @param deps - the management dependencies.
* @returns the status and JSON body to answer with.
*/
async function handleWorktrees(request, parts, deps) {
	const [rawAnchorId, action] = parts;
	const anchorId = rawAnchorId === void 0 ? void 0 : asAnchorId(rawAnchorId);
	if (anchorId === void 0) {
		if (request.method === "GET") return {
			status: 200,
			body: { worktrees: await deps.worktrees.list() }
		};
		if (request.method === "POST") {
			const rawRepoId = stringField(request.body, "repoId")?.trim();
			const repoId = rawRepoId === void 0 || rawRepoId === "" ? void 0 : asRepoId(rawRepoId);
			const target = repoId === void 0 ? {
				nodeId: asNodeId(requireString(request.body, "nodeId")),
				repoPath: requireString(request.body, "repoPath")
			} : (() => {
				const record = deps.repos.get(repoId);
				if (record === void 0) throw new ApiError(404, `no repository "${repoId}"`);
				return {
					nodeId: record.nodeId,
					repoPath: record.repoPath
				};
			})();
			const baseRef = stringField(request.body, "baseRef");
			const path = stringField(request.body, "path")?.trim();
			if (path !== void 0 && path !== "" && !path.startsWith("/")) throw new ApiError(400, `"path" must be absolute: "${path}"`);
			return {
				status: 201,
				body: { worktree: await deps.worktrees.create({
					...target,
					name: requireString(request.body, "name"),
					...path === void 0 || path === "" ? {} : { path },
					...baseRef === void 0 ? {} : { baseRef }
				}) }
			};
		}
		throw notAllowed(request);
	}
	if (action === "open" || action === "close" || action === "release") {
		if (request.method !== "POST") throw notAllowed(request);
		if (action === "release") return {
			status: 200,
			body: { worktree: await deps.worktrees.release(anchorId) }
		};
		return {
			status: 200,
			body: { worktree: action === "open" ? await deps.worktrees.open(anchorId) : await deps.worktrees.close(anchorId) }
		};
	}
	if (action === void 0 && request.method === "DELETE") return {
		status: 200,
		body: { removal: await deps.worktrees.remove(anchorId, {
			force: request.query.get("force") === "true",
			deleteBranch: request.query.get("deleteBranch") === "true"
		}) }
	};
	throw new ApiError(404, `unknown endpoint ${request.method} ${request.path}`);
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
async function handleTerminals(request, parts, deps) {
	const [id, action] = parts;
	if (id === void 0) {
		if (request.method !== "GET") throw notAllowed(request);
		const sessionId = (request.query.get("sessionId") ?? "").trim();
		if (sessionId === "") throw new ApiError(400, "\"sessionId\" is required");
		return {
			status: 200,
			body: { terminals: deps.terminals.listFor(sessionId) }
		};
	}
	if (action !== "close") throw new ApiError(404, `unknown endpoint ${request.method} ${request.path}`);
	if (request.method !== "POST") throw notAllowed(request);
	if (!await deps.terminals.kill(id)) throw new ApiError(404, `no terminal "${id}"`);
	return {
		status: 200,
		body: { closed: true }
	};
}
/**
* Handle one management request.
* @param request - the normalized request.
* @param deps - the registry, connection manager, worktree lifecycle, and terminals.
* @returns the status and JSON body to answer with.
*/
async function handleNodeApi(request, deps) {
	try {
		const parts = request.path.split("/").filter((segment) => segment !== "");
		const head = parts[0];
		if (head === "terminals") return await handleTerminals(request, parts.slice(1), deps);
		if (head === "worktrees") return await handleWorktrees(request, parts.slice(1), deps);
		if (head === "repos") return await handleRepos(request, parts.slice(1), deps);
		if (head !== "nodes") throw new ApiError(404, `unknown endpoint ${request.method} ${request.path}`);
		const [, rawNodeId, action] = parts;
		const nodeId = rawNodeId === void 0 ? void 0 : asNodeId(rawNodeId);
		if (nodeId === void 0) {
			if (request.method === "GET") {
				const records = deps.registry.list();
				return {
					status: 200,
					body: {
						nodes: records.map(toNodeView),
						statuses: records.map((record) => statusOf(deps.connections, record))
					}
				};
			}
			if (request.method === "POST") {
				const title = stringField(request.body, "title");
				return {
					status: 201,
					body: { node: toNodeView(await deps.registry.upsert({
						transport: requireTransport(request.body),
						token: requireString(request.body, "token"),
						...title === void 0 ? {} : { title }
					})) }
				};
			}
			throw notAllowed(request);
		}
		const record = requireNode(deps.registry, nodeId);
		if (action === void 0) {
			if (request.method === "GET") return {
				status: 200,
				body: {
					node: toNodeView(record),
					status: statusOf(deps.connections, record)
				}
			};
			if (request.method === "DELETE") {
				if (record.transport.kind === "local") throw new ApiError(400, "the local machine is built in and cannot be removed");
				deps.connections.disconnect(nodeId);
				const deleted = await deps.registry.remove(nodeId);
				if (deleted) await deps.repos.removeByNode(nodeId);
				return {
					status: 200,
					body: { deleted }
				};
			}
			if (request.method === "PATCH") {
				if (record.transport.kind === "local") throw new ApiError(400, "the local machine is built in and cannot be changed");
				const ssh = typeof request.body === "object" && request.body !== null ? request.body["ssh"] : void 0;
				return {
					status: 200,
					body: { node: toNodeView(await deps.registry.upsert({
						nodeId,
						transport: ssh === void 0 ? record.transport : requireTransport(request.body),
						token: stringField(request.body, "token") ?? record.token,
						title: stringField(request.body, "title") ?? record.title
					})) }
				};
			}
			throw notAllowed(request);
		}
		if (action === "connect" || action === "disconnect") {
			if (request.method !== "POST") throw notAllowed(request);
			if (record.transport.kind !== "local") {
				if (action === "disconnect") deps.connections.disconnect(nodeId);
				else await deps.connections.connect(record);
			}
			return {
				status: 200,
				body: { status: statusOf(deps.connections, record) }
			};
		}
		if (action === "dirs") {
			if (request.method !== "GET") throw notAllowed(request);
			const requested = (request.query.get("path") ?? "").trim();
			if (record.transport.kind === "local") {
				const path = await resolveLocalPath(requested === "" ? homedir() : requested);
				return {
					status: 200,
					body: {
						path,
						entries: await listLocalDir(path)
					}
				};
			}
			const path = await resolveOnNode(deps, record, requested === "" ? deps.connections.status(nodeId).info?.homedir ?? "/" : requested);
			return {
				status: 200,
				body: {
					path,
					entries: (await requireChannel$1(deps, nodeId).request("fs.listDir", { path })).map((entry) => ({
						name: entry.name,
						type: entry.type,
						path: entry.target.canonicalPath,
						...entry.size === void 0 ? {} : { size: entry.size }
					}))
				}
			};
		}
		throw new ApiError(404, `unknown endpoint ${request.method} ${request.path}`);
	} catch (error) {
		if (error instanceof ApiError) return {
			status: error.status,
			body: { error: error.message }
		};
		return {
			status: 502,
			body: { error: error instanceof Error ? error.message : String(error) }
		};
	}
}
/** The path prefix this plugin owns. */
const API_PREFIX = "/dsh-remote-workspace";
/** Bound on one management request body. */
const MAX_BODY_BYTES = 1 << 20;
/** Read a bounded request body and parse it as JSON. */
async function readJsonBody(request) {
	const chunks = [];
	let total = 0;
	for await (const chunk of request) {
		const buffer = chunk;
		total += buffer.length;
		if (total > MAX_BODY_BYTES) throw new Error("request body is too large");
		chunks.push(buffer);
	}
	if (total === 0) return void 0;
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function writeResponse(response, result) {
	const payload = JSON.stringify(result.body);
	response.writeHead(result.status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(payload),
		"cache-control": "no-store"
	});
	response.end(payload);
}
/**
* Register the management routes on the host's Web server.
*
* A missing Web server is not a failure: it means this profile serves no
* browser, and the plugin's model-facing behavior is unaffected.
* @param ctx - the host context.
* @param deps - the registry and connection manager the API reads.
*/
function registerNodeApi(ctx, deps) {
	const webServer = ctx.get("webServer");
	if (webServer === void 0) return;
	ctx.effect(() => webServer.register({
		kind: "prefix",
		path: API_PREFIX,
		handler: async (request, response) => {
			const url = new URL(request.url ?? "/", "http://localhost");
			const path = url.pathname.slice(21);
			let decoded;
			try {
				decoded = path === "" ? "/" : path.split("/").map((segment) => decodeURIComponent(segment)).join("/");
			} catch {
				writeResponse(response, {
					status: 400,
					body: { error: `${path} is not valid percent-encoding` }
				});
				return;
			}
			let body;
			try {
				body = await readJsonBody(request);
			} catch (error) {
				writeResponse(response, {
					status: 400,
					body: { error: error instanceof Error ? error.message : String(error) }
				});
				return;
			}
			writeResponse(response, await handleNodeApi({
				method: request.method ?? "GET",
				path: decoded,
				query: url.searchParams,
				body
			}, deps));
		}
	}));
}
//#endregion
//#region src/plugin/routing/fs.ts
/** Bytes per remote text pull. Bounds one round trip without capping file size. */
const TEXT_CHUNK_BYTES = 1 << 20;
/** Remote paths `workspace-write` always permits, matching the local provider's temp allowance. */
const REMOTE_TEMP_ROOT = "/tmp";
/** Compose the opaque key the harness passes back to this provider. */
function composeKey(nodeId, remotePath) {
	return FsTargetKey(`${TARGET_KEY_PREFIX}${nodeId}:${remotePath}`);
}
/**
* Decompose this provider's own key. The seam forbids a *consumer* from
* parsing a key; the provider that mints one owns its format.
* @param key - a key this provider previously returned.
* @returns the local verdict, or the node and remote path for a remote target.
*/
function parseKey(key) {
	const raw = key;
	if (!raw.startsWith("node:")) return { kind: "local" };
	const rest = raw.slice(5);
	const separator = rest.indexOf(":");
	if (separator <= 0 || !rest.slice(separator + 1).startsWith("/")) return { kind: "local" };
	return {
		kind: "remote",
		nodeId: asNodeId(rest.slice(0, separator)),
		remotePath: rest.slice(separator + 1)
	};
}
/** The remote target the daemon needs, or a typed failure when the node is offline. */
function requireChannel(deps, nodeId) {
	const channel = deps.channel(nodeId);
	if (channel === void 0) throw new FsError(`remote node "${nodeId}" is not connected; open the machine before using this workspace`, "FS_IO_ERROR");
	return channel;
}
/**
* Translate a daemon failure into the seam's typed error so callers branch on
* the same codes they would see locally. A failure outside the filesystem
* family is left as the transport error it is.
* @param error - any failure raised by a channel request.
* @returns the error to throw.
*/
function toFsError(error) {
	if (!(error instanceof NodeRequestError)) return error;
	if (!isFsErrorCode(error.data.code)) return error;
	return new FsError(error.data.message, error.data.code);
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
async function ask(deps, nodeId, call) {
	try {
		return await call(requireChannel(deps, nodeId));
	} catch (error) {
		throw toFsError(error);
	}
}
/** Reject an operation whose signal already fired, before any round trip. */
function throwIfAborted(signal) {
	if (signal?.aborted === true) throw new FsError("filesystem operation aborted", "FS_ABORTED");
}
/**
* The failure an ambiguous remote path raises. Two nodes commonly share a
* remote root, and picking one would read on one machine while writing on
* another, so the path is refused with the spellings that would work.
* @param route - the ambiguous verdict naming every claiming node.
* @returns the typed error to throw.
*/
function ambiguousError(route) {
	return new FsError(ambiguousPathMessage(route), "FS_IO_ERROR");
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
function remoteTextStream(channel, remotePath, signal) {
	return (async function* pull() {
		let offset = 0;
		for (;;) {
			throwIfAborted(signal);
			let chunk;
			try {
				chunk = await channel.request("fs.readTextChunk", {
					path: remotePath,
					offset,
					length: TEXT_CHUNK_BYTES
				});
			} catch (error) {
				throw toFsError(error);
			}
			if (chunk.text.length > 0) yield chunk.text;
			offset = chunk.nextOffset;
			if (chunk.eof) return;
		}
	})();
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
function remoteWriteAllowed(policy, remotePath, remoteRoot) {
	if (policy === void 0) return true;
	switch (policy.mode) {
		case "danger-full-access": return true;
		case "read-only": return false;
		case "workspace-write":
			if (isWithin(REMOTE_TEMP_ROOT, remotePath)) return true;
			return remoteRoot !== void 0 && isWithin(remoteRoot, remotePath);
	}
}
/**
* Build the routing filesystem.
* @param deps - the composed local delegate, the live anchors, and channel lookup.
* @returns an object satisfying the filesystem seam, ready for `ctx.provide`.
*/
function createRoutingFileSystem(deps) {
	/** The anchor whose remote root owns `remotePath`, when one does. */
	const anchorFor = (nodeId, remotePath) => deps.anchors().find((anchor) => anchor.nodeId === nodeId && isWithin(anchor.remoteRoot, remotePath));
	/**
	* Refuse a remote mutation the per-call policy does not allow.
	* @param nodeId - the machine the path lives on.
	* @param remotePath - the canonical remote path about to be written.
	* @param verb - the operation, for the message.
	* @param policy - the per-call policy the caller resolved, when it supplied one.
	* @throws the typed error naming the policy that refused it.
	*/
	const requireRemoteWrite = (nodeId, remotePath, verb, policy) => {
		if (remoteWriteAllowed(policy, remotePath, anchorFor(nodeId, remotePath)?.remoteRoot)) return;
		throw new FsError(`remote ${verb} denied by the ${String(policy?.mode)} policy: ${remotePath}`, "FS_SANDBOX_DENIED");
	};
	return {
		get sandboxMode() {
			return deps.localFs.sandboxMode;
		},
		async resolve(path, opts) {
			throwIfAborted(opts?.signal);
			const route = classifyPath(path, opts?.cwd, deps.anchors());
			if (route.kind === "local") return deps.localFs.resolve(path, opts);
			if (route.kind === "ambiguous") throw ambiguousError(route);
			const resolved = await ask(deps, route.nodeId, (channel) => channel.request("fs.resolve", { path: route.remotePath }));
			return {
				targetKey: composeKey(route.nodeId, resolved.canonicalPath),
				displayPath: resolved.canonicalPath
			};
		},
		processPath(target) {
			const parsed = parseKey(target.targetKey);
			return parsed.kind === "local" ? deps.localFs.processPath(target) : parsed.remotePath;
		},
		processPathFromHostPath(hostPath) {
			return deps.localFs.processPathFromHostPath(hostPath);
		},
		fileUrl(target) {
			const parsed = parseKey(target.targetKey);
			if (parsed.kind === "local") return deps.localFs.fileUrl(target);
			return `file://${parsed.remotePath.split("/").map(encodeURIComponent).join("/")}`;
		},
		contains(parent, child) {
			const left = parseKey(parent.targetKey);
			const right = parseKey(child.targetKey);
			if (left.kind === "local" && right.kind === "local") return deps.localFs.contains(parent, child);
			if (left.kind === "local" || right.kind === "local") return false;
			return left.nodeId === right.nodeId && isWithin(left.remotePath, right.remotePath);
		},
		async stat(target, signal) {
			throwIfAborted(signal);
			const parsed = parseKey(target.targetKey);
			if (parsed.kind === "local") return deps.localFs.stat(target, signal);
			const info = await ask(deps, parsed.nodeId, (channel) => channel.request("fs.stat", { path: parsed.remotePath }));
			if (info === null) return void 0;
			return {
				version: FsVersion(info.version),
				type: info.type,
				...info.size === void 0 ? {} : { size: info.size }
			};
		},
		async lstat(path, opts, signal) {
			throwIfAborted(signal);
			const route = classifyPath(path, opts?.cwd, deps.anchors());
			if (route.kind === "local") return deps.localFs.lstat(path, opts, signal);
			if (route.kind === "ambiguous") throw ambiguousError(route);
			const info = await ask(deps, route.nodeId, (channel) => channel.request("fs.lstat", { path: route.remotePath }));
			if (info === null) return void 0;
			return {
				version: FsVersion(info.version),
				type: info.type,
				...info.size === void 0 ? {} : { size: info.size }
			};
		},
		async readText(target, signal) {
			throwIfAborted(signal);
			const parsed = parseKey(target.targetKey);
			if (parsed.kind === "local") return deps.localFs.readText(target, signal);
			const chunks = [];
			const stream = remoteTextStream(requireChannel(deps, parsed.nodeId), parsed.remotePath, signal);
			for await (const chunk of stream) chunks.push(chunk);
			return chunks.join("");
		},
		async streamText(target, signal) {
			throwIfAborted(signal);
			const parsed = parseKey(target.targetKey);
			if (parsed.kind === "local") return deps.localFs.streamText(target, signal);
			return remoteTextStream(requireChannel(deps, parsed.nodeId), parsed.remotePath, signal);
		},
		async readBytes(target, signal, maxBytes) {
			throwIfAborted(signal);
			const parsed = parseKey(target.targetKey);
			if (parsed.kind === "local") return deps.localFs.readBytes(target, signal, maxBytes);
			const bytes = await ask(deps, parsed.nodeId, (channel) => channel.request("fs.readBytes", {
				path: parsed.remotePath,
				maxBytes
			}));
			return new Uint8Array(Buffer.from(bytes.data, "base64"));
		},
		async readByteRange(target, range, signal) {
			throwIfAborted(signal);
			const parsed = parseKey(target.targetKey);
			if (parsed.kind === "local") return deps.localFs.readByteRange(target, range, signal);
			const bytes = await ask(deps, parsed.nodeId, (channel) => channel.request("fs.readByteRange", {
				path: parsed.remotePath,
				offset: range.offset,
				length: range.length
			}));
			return new Uint8Array(Buffer.from(bytes.data, "base64"));
		},
		async listDir(target, signal) {
			throwIfAborted(signal);
			const parsed = parseKey(target.targetKey);
			if (parsed.kind === "local") return deps.localFs.listDir(target, signal);
			return (await ask(deps, parsed.nodeId, (channel) => channel.request("fs.listDir", { path: parsed.remotePath }))).map((entry) => ({
				name: entry.name,
				type: entry.type,
				target: {
					targetKey: composeKey(parsed.nodeId, entry.target.canonicalPath),
					displayPath: entry.target.canonicalPath
				},
				...entry.version === void 0 ? {} : { version: FsVersion(entry.version) },
				...entry.size === void 0 ? {} : { size: entry.size }
			}));
		},
		async writeText(target, content, expected, signal, sandboxPolicy) {
			throwIfAborted(signal);
			const parsed = parseKey(target.targetKey);
			if (parsed.kind === "local") return deps.localFs.writeText(target, content, expected, signal, sandboxPolicy);
			requireRemoteWrite(parsed.nodeId, parsed.remotePath, "write", sandboxPolicy);
			const outcome = await ask(deps, parsed.nodeId, (channel) => channel.request("fs.writeText", {
				path: parsed.remotePath,
				content,
				...expected === void 0 ? {} : { expected: expected.kind === "createIfAbsent" ? { kind: "createIfAbsent" } : {
					kind: "replaceIfVersion",
					version: expected.version
				} }
			}));
			return {
				operation: outcome.operation,
				version: FsVersion(outcome.version),
				before: outcome.before,
				after: outcome.after
			};
		},
		async editText(target, edit, expected, signal, sandboxPolicy) {
			throwIfAborted(signal);
			const parsed = parseKey(target.targetKey);
			if (parsed.kind === "local") return deps.localFs.editText(target, edit, expected, signal, sandboxPolicy);
			requireRemoteWrite(parsed.nodeId, parsed.remotePath, "edit", sandboxPolicy);
			const outcome = await ask(deps, parsed.nodeId, (channel) => channel.request("fs.editText", {
				path: parsed.remotePath,
				edit: {
					oldString: edit.oldString,
					newString: edit.newString,
					replaceAll: edit.replaceAll
				},
				...expected === void 0 ? {} : { expected: { version: expected.version } }
			}));
			return {
				version: FsVersion(outcome.version),
				before: outcome.before,
				after: outcome.after
			};
		}
	};
}
//#endregion
//#region src/plugin/routing/shell.ts
/**
* Build the routing bash executor.
* @param deps - the two composed delegates and the live anchors.
* @returns an object satisfying the shell seam, ready for `ctx.provide`.
*/
function createRoutingShellExecutor(deps) {
	/**
	* The delegate that owns one workdir.
	* @param workdir - the resolved working directory of the request or spec.
	* @returns the machine's executor for a remote path, this host's otherwise.
	*/
	const delegateFor = (workdir) => classifyPath(workdir, void 0, deps.anchors()).kind === "remote" ? deps.remoteShell : deps.localShell;
	return {
		get sandboxMode() {
			return deps.localShell.sandboxMode;
		},
		resolve(request) {
			return delegateFor(request.workdir ?? "").resolve(request);
		},
		run(spec) {
			return delegateFor(spec.workdir).run(spec);
		},
		start(spec) {
			return delegateFor(spec.workdir).start(spec);
		}
	};
}
//#endregion
//#region src/remote/tty.ts
/**
* The remote terminal provider: a PTY a node daemon owns.
*
* A terminal on another machine cannot be streamed: the wire answers one
* request at a time, and the daemon retains a bounded window of output rather
* than pushing it. This provider therefore polls that window into a local
* `PassThrough`, so a consumer reads the same `Readable` it would read from a
* local PTY, one poll interval behind.
*
* What it drives is a port, not the harness wire directly: {@link TtyWire} is
* the six terminal methods this provider needs, and the plugin that owns the
* protocol adapts its channel to it. The shapes a port declares and the shapes
* that adapter passes are checked against each other in one place, so a wire
* that drifts fails to compile rather than failing at a terminal.
*
* @module dsh-remote-workspace/remote/tty
*/
/**
* How often the proxy asks the daemon for new output.
*
* The wire serves retained windows rather than pushing, so this is the
* interactive latency floor: small enough that a prompt appears promptly, large
* enough that an idle terminal does not flood the connection.
*/
const POLL_MS = 40;
async function createRemoteTty(wire, request, verbs) {
	const started = await wire.spawn({
		argv: [...request.argv],
		cwd: request.cwd,
		rows: request.rows,
		cols: request.cols,
		graceMs: request.graceMs ?? 3e3,
		...request.env === void 0 ? {} : { env: request.env }
	});
	const output = new PassThrough();
	const decoder = new StringDecoder("utf8");
	let offset = 0;
	let finished = false;
	let pumping = false;
	let timer;
	let settleDone = () => {};
	const done = new Promise((resolve) => {
		settleDone = resolve;
	});
	/** Publish the outcome once and stop polling. */
	const finish = (outcome) => {
		if (finished) return;
		finished = true;
		if (timer !== void 0) clearInterval(timer);
		output.end(decoder.end());
		settleDone(outcome);
	};
	/** Pull whatever the daemon has written since the last offset. */
	const pull = async () => {
		const read = await wire.read(started.termId, offset);
		offset = read.nextOffset;
		if (read.data.length > 0) output.write(decoder.write(Buffer.from(read.data, "base64")));
	};
	/** One poll: pull what the daemon retains, then ask whether it exited. */
	const tick = async () => {
		if (pumping || finished) return;
		pumping = true;
		try {
			await pull();
			const outcome = await wire.outcome(started.termId);
			if (outcome !== null) finish({
				exitCode: outcome.exitCode,
				signal: outcome.signal
			});
		} catch {
			finish({
				exitCode: null,
				signal: null
			});
		} finally {
			pumping = false;
		}
	};
	timer = setInterval(() => void tick(), POLL_MS);
	timer.unref();
	tick();
	/** The teardown in flight, so a second `terminate` joins the first. */
	let stopping;
	const handle = {
		pid: started.pid,
		output,
		done,
		async write(data) {
			await wire.write(started.termId, data);
		},
		async resize(cols, rows) {
			await wire.resize(started.termId, cols, rows);
		},
		async terminate() {
			stopping ??= (async () => {
				if (finished) return;
				await wire.terminate(started.termId);
				await pull().catch(() => void 0);
				const outcome = await wire.outcome(started.termId).catch(() => null);
				finish({
					exitCode: outcome?.exitCode ?? null,
					signal: outcome?.signal ?? null
				});
			})();
			await stopping;
		}
	};
	return verbs === void 0 ? handle : {
		...handle,
		...verbs(started.termId)
	};
}
//#endregion
//#region src/plugin/routing/remote.ts
/**
* Resolve one working directory to the machine that owns it.
* @param cwd - the working directory the caller asked for.
* @param anchors - every anchor this plugin currently owns.
* @param channel - resolves the live channel for a node.
* @returns the machine and its path, or undefined when this host owns the cwd.
* @throws when more than one node claims the path, or the node is not connected.
*/
function remoteTarget(cwd, anchors, channel) {
	const route = classifyPath(cwd, void 0, anchors);
	if (route.kind === "local") return void 0;
	if (route.kind === "ambiguous") throw new Error(ambiguousPathMessage(route));
	const live = channel(route.nodeId);
	if (live === void 0) throw new Error(`remote node "${route.nodeId}" is not connected`);
	return {
		channel: live,
		remotePath: route.remotePath
	};
}
//#endregion
//#region src/plugin/routing/tty.ts
/**
* Adapt one node channel to the terminal port.
*
* Both seams that allocate a terminal on a node drive the same daemon methods,
* so they drive them through this one adapter — and this is the one place the
* daemon's opaque session id becomes the branded id the wire contract carries.
* @param channel - the live node channel.
* @returns the port `createRemoteTty` drives.
*/
function terminalWire(channel) {
	return {
		spawn: (request) => channel.request("term.spawn", request),
		read: (termId, fromByte) => channel.request("term.read", {
			termId: asTermId(termId),
			fromByte
		}),
		write: async (termId, data) => {
			await channel.request("term.write", {
				termId: asTermId(termId),
				data
			});
		},
		resize: async (termId, cols, rows) => {
			await channel.request("term.resize", {
				termId: asTermId(termId),
				cols,
				rows
			});
		},
		terminate: async (termId) => {
			await channel.request("term.terminate", { termId: asTermId(termId) });
		},
		outcome: (termId) => channel.request("term.outcome", { termId: asTermId(termId) })
	};
}
/**
* Build the routing terminal runtime.
* @param deps - the composed local provider, the live anchors, and channel lookup.
* @returns an object satisfying the terminal seam, ready for `ctx.provide`.
*/
function createRoutingTty(deps) {
	return { async spawn(request) {
		const remote = remoteTarget(request.cwd, deps.anchors(), deps.channel);
		if (remote === void 0) return await deps.localTty.spawn(request);
		return await createRemoteTty(terminalWire(remote.channel), {
			...request,
			cwd: remote.remotePath
		});
	} };
}
//#endregion
//#region src/plugin/routing/subprocess.ts
/**
* The routing subprocess runtime the plugin registers as `ctx.subprocess`.
*
* A plain object, like the filesystem router: `ctx.provide` is the primitive
* Cordis' own `Service` constructor calls, so nothing is inherited here.
*
* Two facts drive this module.
*
* First, `spawn` returns its handle **synchronously** while a remote start
* needs a round trip. The handle is therefore a local proxy: it exists
* immediately, queues `terminate` and `waitForExit` until the daemon has
* answered, and lets `done` reject when the start itself failed.
*
* Second, a collected reader is read **synchronously** while the daemon is
* reached asynchronously. The proxy keeps a local mirror of each stream and
* fills it at exit, which is when every documented consumer — the bash
* executor, the spill policy — actually reads. Collected output that this
* design cannot fetch without an async reader is fetched once, completely,
* before `done` settles.
*
* @module dsh-remote-workspace/plugin/routing/subprocess
*/
/** One stream's local mirror of the daemon's retained window. */
var CollectedMirror = class {
	chunks = [];
	/** Whole-stream offset of the first retained byte. */
	start = 0;
	/** Whole-stream offset one past the last retained byte. */
	end = 0;
	/** True when an earlier read reported that bytes had already been dropped. */
	dropped = false;
	maxBytes;
	/**
	* @param maxBytes - the in-memory cap the caller asked the daemon for.
	*/
	constructor(maxBytes) {
		this.maxBytes = maxBytes;
	}
	/**
	* Replace the mirror with the window's tail.
	*
	* An answer to an offset that has slid out of the daemon's window carries the
	* retained tail rather than the bytes from that offset, so appending it would
	* splice two ranges into one stream. The tail becomes the whole content, and
	* the loss is reported.
	* @param bytes - the tail the daemon retained.
	* @param nextOffset - whole-stream offset one past `bytes`.
	*/
	reset(bytes, nextOffset) {
		this.chunks.length = 0;
		if (bytes.length > 0) this.chunks.push(bytes);
		this.start = nextOffset - bytes.length;
		this.end = nextOffset;
		this.dropped = true;
	}
	/** Append one fetched window and trim the head to the cap. */
	push(bytes) {
		if (bytes.length === 0) return;
		this.chunks.push(bytes);
		this.end += bytes.length;
		let retained = this.end - this.start;
		while (retained > this.maxBytes && this.chunks.length > 0) {
			const head = this.chunks[0];
			const overflow = retained - this.maxBytes;
			if (head.length <= overflow) {
				this.chunks.shift();
				this.start += head.length;
			} else {
				this.chunks[0] = head.subarray(overflow);
				this.start += overflow;
			}
			this.dropped = true;
			retained = this.end - this.start;
		}
	}
	/** The whole-stream offset a caller should resume from. */
	get nextOffset() {
		return this.end;
	}
	/**
	* Read everything captured since `fromByte`.
	* @param fromByte - whole-stream byte offset to resume from.
	* @returns the delta text, the next offset, and whether the offset was lost.
	*/
	readFrom(fromByte) {
		if (fromByte < this.start) return {
			text: Buffer.concat(this.chunks).toString("utf8"),
			nextOffset: this.end,
			lossy: true
		};
		if (fromByte >= this.end) return {
			text: "",
			nextOffset: this.end,
			lossy: this.dropped
		};
		return {
			text: Buffer.concat(this.chunks).subarray(fromByte - this.start).toString("utf8"),
			nextOffset: this.end,
			lossy: this.dropped
		};
	}
};
/**
* Absorb a teardown request whose failure cannot matter.
*
* Every call runs after the decision to release a process, against a transport
* that may already be gone; the daemon reaps the process either way, so a
* rejection carries nothing the caller could act on.
* @param request - the teardown request already issued.
* @returns a promise that settles when the request does, whatever its outcome.
*/
function settled(request) {
	return request.then(() => {}, () => {});
}
/**
* Build the proxy handle for one remote spawn.
* @param channel - the live node channel.
* @param remoteCwd - the canonical remote working directory.
* @param spec - the caller's fully specified spawn request.
* @returns the handle, valid before the daemon has answered.
*/
function createRemoteHandle(channel, remoteCwd, spec) {
	const stdoutMirror = typeof spec.stdio.stdout === "object" ? new CollectedMirror(spec.stdio.stdout.maxBytes) : void 0;
	const stderrMirror = typeof spec.stdio.stderr === "object" ? new CollectedMirror(spec.stdio.stderr.maxBytes) : void 0;
	const stdoutPipe = spec.stdio.stdout === "pipe" ? new PassThrough() : void 0;
	const stderrPipe = spec.stdio.stderr === "pipe" ? new PassThrough() : void 0;
	const bufferedFrames = [];
	let procId;
	let offPipe;
	const deliverPipeFrame = (frame) => {
		if (frame.procId !== procId) return;
		(frame.stream === "stdout" ? stdoutPipe : stderrPipe)?.write(Buffer.from(frame.data, "base64"));
	};
	if (stdoutPipe !== void 0 || stderrPipe !== void 0) offPipe = channel.onPipeFrame((frame) => {
		if (procId === void 0) {
			bufferedFrames.push(frame);
			return;
		}
		deliverPipeFrame(frame);
	});
	/** Stop pushing and end every piped stream, exactly once. */
	const closePipes = () => {
		offPipe?.();
		offPipe = void 0;
		stdoutPipe?.end();
		stderrPipe?.end();
	};
	let startFailure;
	let terminated = false;
	let resolveDone = () => {};
	let rejectDone = () => {};
	const done = new Promise((resolve, reject) => {
		resolveDone = resolve;
		rejectDone = reject;
	});
	const stdinStream = spec.stdio.stdin === "pipe" ? new PassThrough() : void 0;
	/** Fetch every remaining byte of one stream until the daemon stops advancing. */
	const drain = async (id, stream, mirror) => {
		for (;;) {
			const read = await channel.request("sp.readOutput", {
				procId: id,
				stream,
				fromByte: mirror.nextOffset
			});
			const bytes = Buffer.from(read.data, "base64");
			if (read.lossy) mirror.reset(bytes, read.nextOffset);
			else {
				if (bytes.length === 0) return;
				mirror.push(bytes);
			}
			if (read.nextOffset <= mirror.nextOffset) return;
		}
	};
	const run = async () => {
		let id;
		try {
			id = (await channel.request("sp.spawn", {
				argv: [...spec.argv],
				cwd: remoteCwd,
				stdin: spec.stdio.stdin === "pipe" ? "pipe" : spec.stdio.stdin === "ignore" ? "ignore" : { data: spec.stdio.stdin.data },
				stdout: collectSpec(spec.stdio.stdout),
				stderr: collectSpec(spec.stdio.stderr),
				graceMs: spec.graceMs,
				...spec.env === void 0 ? {} : { env: definedEnv(spec.env) }
			})).procId;
			procId = id;
			for (const frame of bufferedFrames.splice(0)) deliverPipeFrame(frame);
		} catch (error) {
			startFailure = error;
			closePipes();
			rejectDone(error);
			return;
		}
		if (terminated) await settled(channel.request("sp.terminate", { procId: id }));
		if (typeof spec.stdio.stdin === "object") {
			await settled(channel.request("sp.writeStdin", {
				procId: id,
				data: spec.stdio.stdin.data
			}));
			await settled(channel.request("sp.closeStdin", { procId: id }));
		}
		if (stdinStream !== void 0) {
			stdinStream.on("data", (chunk) => {
				settled(channel.request("sp.writeStdin", {
					procId: id,
					data: chunk.toString("utf8")
				}));
			});
			stdinStream.on("end", () => {
				settled(channel.request("sp.closeStdin", { procId: id }));
			});
		}
		try {
			await channel.request("sp.waitForExit", { procId: id });
			if (stdoutMirror !== void 0) await drain(id, "stdout", stdoutMirror);
			if (stderrMirror !== void 0) await drain(id, "stderr", stderrMirror);
			const outcome = await channel.request("sp.outcome", { procId: id });
			closePipes();
			resolveDone({
				exitCode: outcome?.exitCode ?? null,
				signal: outcome?.signal ?? null
			});
		} catch (error) {
			closePipes();
			rejectDone(error);
		}
	};
	run();
	return {
		stdin: stdinStream,
		stdout: stdoutPipe,
		stderr: stderrPipe,
		control: void 0,
		collected: {
			...stdoutMirror === void 0 ? {} : { stdout: stdoutMirror },
			...stderrMirror === void 0 ? {} : { stderr: stderrMirror }
		},
		done,
		terminate() {
			terminated = true;
			if (procId === void 0) return;
			settled(channel.request("sp.terminate", { procId }));
		},
		async waitForExit(signal) {
			if (startFailure !== void 0) return false;
			await done;
			return signal?.aborted !== true;
		}
	};
}
/** Project a seam output disposition onto the wire form. */
function collectSpec(mode) {
	if (mode === "pipe") return "pipe";
	return typeof mode === "object" ? { maxBytes: mode.maxBytes } : "inherit";
}
/** Drop undefined entries from a spawn environment. */
function definedEnv(env) {
	const out = {};
	for (const [key, value] of Object.entries(env)) if (value !== void 0) out[key] = value;
	return out;
}
/**
* Rewrite a host-only executable path into something the node can run.
*
* The search tools resolve a packaged `rg` on the host and hand this seam that
* absolute path; the node has its own binary under a bare name. Any other
* absolute path is passed through, and the daemon reports it missing.
* @param argv - the caller's argv.
* @param remoteRipgrep - the configured remote binary name.
* @returns the argv to send.
*/
function rewriteExecutable(argv, remoteRipgrep) {
	const head = argv[0];
	if (head === void 0 || !head.startsWith("/")) return argv;
	if (head.slice(head.lastIndexOf("/") + 1) !== "rg") return argv;
	return [remoteRipgrep, ...argv.slice(1)];
}
/**
* Build the routing subprocess runtime.
* @param deps - the composed local delegate, the live anchors, and channel lookup.
* @returns an object satisfying the subprocess seam, ready for `ctx.provide`.
*/
function createRoutingSubprocessRuntime(deps) {
	const remoteRipgrep = deps.remoteRipgrep ?? "rg";
	return {
		resolveExecutable(command, env, signal) {
			return deps.localProc.resolveExecutable(command, env, signal);
		},
		spawn(spec) {
			const remote = remoteTarget(spec.cwd, deps.anchors(), deps.channel);
			if (remote === void 0) return deps.localProc.spawn(spec);
			return createRemoteHandle(remote.channel, remote.remotePath, {
				...spec,
				argv: rewriteExecutable(spec.argv, remoteRipgrep)
			});
		},
		async spawnTerminal(spec) {
			const remote = remoteTarget(spec.cwd, deps.anchors(), deps.channel);
			if (remote === void 0) return deps.localProc.spawnTerminal(spec);
			const request = {
				argv: [...spec.argv],
				cwd: remote.remotePath,
				cols: spec.cols,
				rows: spec.rows,
				graceMs: spec.graceMs,
				...spec.env === void 0 ? {} : { env: spec.env }
			};
			let observed = {
				state: "unknown",
				revision: 0
			};
			return await createRemoteTty(terminalWire(remote.channel), request, (termId) => ({
				async inspectForeground() {
					return await remote.channel.request("term.inspectForeground", { termId: asTermId(termId) }) ?? void 0;
				},
				async inspectActivity() {
					const foreground = await remote.channel.request("term.inspectForeground", { termId: asTermId(termId) }) ?? void 0;
					const state = foreground === void 0 ? "unknown" : foreground.inputWaiting ? "idle" : "busy";
					if (state !== observed.state) observed = {
						state,
						revision: observed.revision + 1
					};
					return observed;
				},
				async signalForeground(signal) {
					return (await remote.channel.request("term.signalForeground", {
						termId: asTermId(termId),
						signal
					})).processGroupId;
				}
			}));
		}
	};
}
//#endregion
//#region src/terminal/shared/display.ts
/**
* The terminal's display preferences, named once for both halves.
*
* The preferences are the plugin's own settings: they live in the Host's
* user-settings document, under the namespace below, and the browser half draws
* them as this plugin's card in the Plugins settings page. Nothing here depends
* on either half's runtime, so the Host can build its schema from the same
* bounds the browser steps between.
*
* @module dsh-remote-workspace/terminal/shared/display
*/
/** Settings namespace the terminal's display preferences are stored under. */
const TERMINAL_DISPLAY_NAMESPACE = "dsh-remote-workspace";
/**
* The preferences in force before one is chosen.
*
* The family is the generic one, which every machine has, until the list this
* machine offers is read.
*/
const TERMINAL_DISPLAY_DEFAULTS = {
	fontFamily: "monospace",
	fontSize: 12,
	lineHeight: 1,
	cursorBlink: true,
	scrollback: 5e4
};
//#endregion
//#region src/terminal/host/display.ts
/**
* The terminal's display preferences as a Host settings namespace.
*
* Registering the namespace is what lets the browser half bind a scope to it
* and what makes the plugin's card appear in the Plugins settings page: the
* page dispatches cards by namespace, and a namespace nobody registered is a
* card nobody sees. Every field carries its default, so a document that has
* never held one still describes a working terminal.
*
* @module dsh-remote-workspace/terminal/host/display
*/
const { fontSize, lineHeight, scrollback } = {
	fontSize: {
		min: 11,
		max: 16,
		step: 1
	},
	lineHeight: {
		min: 1,
		max: 1.6,
		step: .1
	},
	scrollback: {
		min: 1e3,
		max: 1e5,
		step: 1
	}
};
/** Durable display schema; also the wire envelope the browser scope validates against. */
const TerminalDisplaySchema = z.object({
	fontFamily: z.string().default(TERMINAL_DISPLAY_DEFAULTS.fontFamily),
	fontSize: z.number().step(fontSize.step).min(fontSize.min).max(fontSize.max).default(TERMINAL_DISPLAY_DEFAULTS.fontSize),
	lineHeight: z.number().step(lineHeight.step).min(lineHeight.min).max(lineHeight.max).default(TERMINAL_DISPLAY_DEFAULTS.lineHeight),
	cursorBlink: z.boolean().default(TERMINAL_DISPLAY_DEFAULTS.cursorBlink),
	scrollback: z.number().step(scrollback.step).min(scrollback.min).max(scrollback.max).default(TERMINAL_DISPLAY_DEFAULTS.scrollback)
});
//#endregion
//#region src/terminal/host/registry.ts
/**
* The host's terminals, as a lookup table of the shells a person's tabs have
* open.
*
* A tab owns its shell, but the socket is only a view of it. The socket closing
* detaches: the terminal stays in the table, its output keeps filling the ring
* buffer, and the model's tool can still address it for as long as the process
* lives. An explicit end — the chooser's close route — the process exiting, the
* owning Session ending, or an optional detach valve releases it; nobody
* watching is not by itself a reason to end a shell.
*
* The table exists for the model. The sidebar terminal never needs to look up
* its own shell, but the model-facing terminal tool must find one that a
* person opened — and must not create one. Each terminal therefore carries a
* registry-unique id (`t1`, `t2`, …) and a human label, and every operation the
* tool performs passes through {@link TerminalRegistry.requireOwned}, the one
* place that decides whether the calling Session may touch a terminal at all.
*
* Output is retained in a byte ring buffer with absolute offsets, so the tool
* can read the tail, resume from where it last read, and wait for a match
* without holding a second PTY or a second stream. The buffer is bounded at
* {@link BUFFER_BYTES}; the bytes it drops stay accounted for, so an offset
* never silently changes meaning.
*
* @module dsh-remote-workspace/terminal/host/registry
*/
/** A terminal request the registry refused. */
var TerminalRegistryError = class extends Error {
	name = "TerminalRegistryError";
};
/** Bytes one terminal retains before the oldest are dropped. */
const BUFFER_BYTES = 262144;
/** Largest tail a read may ask for. */
const MAX_READ_LINES = 2e3;
/** Longest wait budget a caller may ask for. */
const MAX_WAIT_MS = 3e5;
/**
* Logical key names a caller may send, in the order the refusal lists them.
*
* The values are the byte sequences a terminal emulator would send, so a caller
* names an intent (`ctrl+c`) rather than spelling an escape.
*/
const KEYS = {
	enter: "\r",
	esc: "\x1B",
	escape: "\x1B",
	tab: "	",
	backspace: "",
	delete: "\x1B[3~",
	up: "\x1B[A",
	down: "\x1B[B",
	right: "\x1B[C",
	left: "\x1B[D",
	home: "\x1B[H",
	end: "\x1B[F",
	pageup: "\x1B[5~",
	pagedown: "\x1B[6~",
	space: " ",
	...Object.fromEntries(Array.from({ length: 26 }, (_, index) => [`ctrl+${String.fromCharCode(97 + index)}`, String.fromCharCode(index + 1)]))
};
/** Every logical key name, for a refusal that tells the caller what is valid. */
const KEY_NAMES = Object.keys(KEYS);
/**
* Build the terminal registry.
* @param options - what the registry needs to create a terminal.
* @returns the registry the socket and the tool share.
*/
function createTerminalRegistry(options) {
	const entries = /* @__PURE__ */ new Map();
	/** Monotonic id source; never reused, so a restart never inherits an id. */
	let nextOrdinal = 0;
	const detachGraceMs = options.settings.detachGraceMs ?? 0;
	/** Append output, dropping the oldest bytes once the cap is reached. */
	const append = (entry, chunk) => {
		entry.bytes += chunk.length;
		if (chunk.length >= BUFFER_BYTES) {
			entry.buffer = Buffer$1.from(chunk.subarray(chunk.length - BUFFER_BYTES));
			entry.dropped = entry.bytes - entry.buffer.length;
			return;
		}
		const grown = entry.buffer.length === 0 ? Buffer$1.from(chunk) : Buffer$1.concat([entry.buffer, chunk]);
		const overflow = grown.length - BUFFER_BYTES;
		entry.buffer = overflow > 0 ? Buffer$1.from(grown.subarray(overflow)) : grown;
		entry.dropped = entry.bytes - entry.buffer.length;
	};
	/** The retained text from one absolute offset, and whether earlier bytes are gone. */
	const textFrom = (entry, from) => {
		const start = Math.max(from, entry.dropped);
		return {
			text: entry.buffer.subarray(start - entry.dropped).toString("utf8"),
			truncated: from < entry.dropped
		};
	};
	/** Keep only the last `lines` lines of one string. */
	const tailLines = (text, lines) => {
		const parts = text.split("\n");
		if (parts.length <= lines) return {
			text,
			cut: false
		};
		return {
			text: parts.slice(parts.length - lines).join("\n"),
			cut: true
		};
	};
	/**
	* The absolute offset that begins the tail a default read returns.
	*
	* An offset-less wait searches from here rather than from the current end, so
	* output that arrived before the wait can still match.
	*/
	const retainedStart = (entry) => {
		const seen = textFrom(entry, entry.dropped);
		const tail = tailLines(seen.text, 200);
		return Math.max(entry.dropped, entry.bytes - Buffer$1.byteLength(tail.text, "utf8"));
	};
	/** Wake every waiter, which re-checks the terminal's new state. */
	const notify = (entry) => {
		for (const waiter of [...entry.waiters]) waiter();
	};
	/** Stream a spawned terminal into its buffer, its sinks, and its waiters. */
	const pump = (entry) => {
		entry.handle.output.on("data", (chunk) => {
			append(entry, chunk);
			notify(entry);
			const sinks = [...entry.attaches];
			if (sinks.length === 0) return;
			entry.handle.output.pause();
			const resume = () => {
				if (entry.state === "running") entry.handle.output.resume();
			};
			Promise.all(sinks.map((sink) => Promise.resolve().then(() => sink.output(chunk)))).then(resume, resume);
		});
		entry.handle.done.then((outcome) => {
			settle(entry, (sink) => {
				sink.exit(outcome);
			});
		}, (error) => {
			settle(entry, (sink) => {
				sink.fail(error);
			});
		});
	};
	/**
	* Mark a terminal exited, report it, and release it if nobody is watching.
	*
	* A detached shell whose process exits has no browser to come back to and no
	* valve to wait on, so the entry goes with the process.
	*/
	const settle = (entry, report) => {
		entry.state = "exited";
		for (const sink of entry.attaches) report(sink);
		notify(entry);
		if (entry.attaches.size === 0) registry.kill(entry.id);
	};
	/** The entry, or a failure — for internal callers that already hold a live id. */
	const entryOf = (id) => {
		const entry = entries.get(id);
		if (entry === void 0) throw new TerminalRegistryError(`terminal "${id}" is not open`);
		return entry;
	};
	/** Refuse a request on a terminal that has already exited. */
	const requireLive = (entry) => {
		if (entry.state === "exited") throw new TerminalRegistryError(`terminal "${entry.id}" has already exited`);
		return entry;
	};
	const registry = {
		async open(sessionId, cwd, size) {
			const handle = await options.spawn({
				argv: [options.settings.shell, ...options.settings.shellArgs],
				cwd,
				env: { ...options.settings.env },
				cols: size.cols,
				rows: size.rows,
				graceMs: options.settings.graceMs
			});
			const ordinal = nextOrdinal + 1;
			nextOrdinal = ordinal;
			const where = options.machine(cwd);
			const entry = {
				id: `t${String(ordinal)}`,
				label: `Terminal ${String(ordinal)}`,
				sessionId,
				machine: where.label,
				cwd: options.directory(cwd),
				handle,
				buffer: Buffer$1.alloc(0),
				bytes: 0,
				dropped: 0,
				state: "running",
				cols: size.cols,
				rows: size.rows,
				attaches: /* @__PURE__ */ new Set(),
				waiters: /* @__PURE__ */ new Set()
			};
			entries.set(entry.id, entry);
			pump(entry);
			return entry;
		},
		attach(id, sink) {
			const entry = requireLive(entryOf(id));
			if (entry.detachTimer !== void 0) {
				clearTimeout(entry.detachTimer);
				entry.detachTimer = void 0;
			}
			if (entry.state === "detached") entry.state = "running";
			entry.attaches.add(sink);
			if (entry.buffer.length > 0) sink.output(entry.buffer);
			return entry;
		},
		detach(id, sink) {
			const entry = entries.get(id);
			if (entry === void 0) return;
			entry.attaches.delete(sink);
			if (entry.attaches.size > 0) return;
			if (entry.state === "exited") {
				registry.kill(id);
				return;
			}
			entry.state = "detached";
			if (entry.detachTimer !== void 0 || detachGraceMs <= 0) return;
			entry.detachTimer = setTimeout(() => {
				entry.detachTimer = void 0;
				registry.kill(id);
			}, detachGraceMs);
			entry.detachTimer.unref();
		},
		async resize(id, cols, rows) {
			const entry = entryOf(id);
			const accepted = await entry.handle.resize(cols, rows).then(() => true, () => false);
			if (accepted) {
				entry.cols = cols;
				entry.rows = rows;
			}
			return accepted;
		},
		listFor(sessionId) {
			return [...entries.values()].filter((entry) => entry.sessionId === sessionId).map((entry) => ({
				id: entry.id,
				label: entry.label,
				cwd: entry.cwd,
				machine: entry.machine,
				pid: entry.handle.pid,
				state: entry.state,
				cols: entry.cols,
				rows: entry.rows
			}));
		},
		requireOwned(sessionId, id) {
			const mine = [...entries.values()].filter((entry) => entry.sessionId === sessionId);
			if (id !== void 0) {
				const entry = mine.find((candidate) => candidate.id === id);
				if (entry === void 0) throw new TerminalRegistryError(`no terminal "${id}" is open in this session` + (mine.length === 0 ? "; this session has no open terminal" : `; open terminals: ${describe$1(mine)}`));
				return requireLive(entry);
			}
			const live = mine.filter((entry) => entry.state !== "exited");
			if (live.length === 0) throw new TerminalRegistryError(mine.length === 0 ? "this session has no open terminal; open one in the sidebar first" : `every terminal in this session has exited: ${describe$1(mine)}`);
			if (live.length > 1) throw new TerminalRegistryError(`this session has ${String(live.length)} open terminals; pass "terminal" with one of: ${describe$1(live)}`);
			return live[0];
		},
		async write(id, text) {
			await requireLive(entryOf(id)).handle.write(text);
			return Buffer$1.byteLength(text, "utf8");
		},
		async keys(id, names) {
			const entry = requireLive(entryOf(id));
			const bytes = names.map((name) => {
				const sequence = KEYS[name];
				if (sequence === void 0) throw new TerminalRegistryError(`unknown key "${name}"; known keys are ${KEY_NAMES.join(", ")}`);
				return sequence;
			}).join("");
			await entry.handle.write(bytes);
			return {
				bytes: Buffer$1.byteLength(bytes, "utf8"),
				keys: names.length
			};
		},
		read(id, offset, lines) {
			const entry = entryOf(id);
			const cap = Math.min(Math.max(Math.trunc(lines ?? 200), 1), MAX_READ_LINES);
			const from = offset ?? entry.dropped;
			const seen = textFrom(entry, from);
			const tail = tailLines(seen.text, cap);
			return {
				id: entry.id,
				offset: entry.bytes,
				text: tail.text,
				truncated: seen.truncated || tail.cut
			};
		},
		async wait(id, request, signal) {
			const entry = entryOf(id);
			const budget = Math.min(Math.max(Math.trunc(request.timeoutMs ?? 3e4), 1), MAX_WAIT_MS);
			const start = request.offset ?? retainedStart(entry);
			const test = matcher(request);
			return new Promise((resolve, reject) => {
				let timer;
				const settle = () => {
					if (timer !== void 0) clearTimeout(timer);
					entry.waiters.delete(check);
					signal?.removeEventListener("abort", abort);
				};
				const finish = (matched, reason) => {
					settle();
					const seen = textFrom(entry, start);
					resolve({
						id: entry.id,
						offset: entry.bytes,
						text: seen.text,
						matched,
						reason
					});
				};
				function abort() {
					settle();
					reject(signal?.reason instanceof Error ? signal.reason : new TerminalRegistryError("the wait was cancelled"));
				}
				function check() {
					if (signal?.aborted === true) {
						abort();
						return;
					}
					const seen = textFrom(entry, start);
					if (test(seen.text)) {
						finish(true, "match");
						return;
					}
					if (entry.state === "exited") finish(false, "exit");
				}
				signal?.addEventListener("abort", abort, { once: true });
				entry.waiters.add(check);
				check();
				if (entry.waiters.has(check)) timer = setTimeout(() => {
					finish(false, "timeout");
				}, budget);
			});
		},
		async kill(id) {
			const entry = entries.get(id);
			if (entry === void 0) return false;
			if (entry.detachTimer !== void 0) {
				clearTimeout(entry.detachTimer);
				entry.detachTimer = void 0;
			}
			entries.delete(id);
			entry.attaches.clear();
			entry.state = "exited";
			notify(entry);
			await entry.handle.terminate().catch(() => void 0);
			return true;
		},
		async releaseSession(sessionId) {
			await Promise.all([...entries.values()].filter((entry) => entry.sessionId === sessionId).map((entry) => registry.kill(entry.id)));
		},
		async disposeAll() {
			await Promise.all([...entries.keys()].map((id) => registry.kill(id)));
		}
	};
	return registry;
}
/** Compile a wait's matcher once, refusing a bad pattern and a missing one. */
function matcher(request) {
	const hasMatch = request.match !== void 0;
	if (hasMatch === (request.regex !== void 0)) throw new TerminalRegistryError(hasMatch ? "pass either \"match\" or \"regex\", not both" : "wait requires \"match\" or \"regex\"");
	if (hasMatch) {
		const needle = request.match;
		return (text) => text.includes(needle);
	}
	let expression;
	try {
		expression = new RegExp(request.regex);
	} catch (error) {
		throw new TerminalRegistryError(`"regex" is not a valid pattern: ${error instanceof Error ? error.message : String(error)}`);
	}
	return (text) => expression.test(text);
}
/** The candidate list one refusal shows: id and human label. */
function describe$1(entries) {
	return entries.map((entry) => `${entry.id} (${entry.label})`).join(", ");
}
//#endregion
//#region src/terminal/host/workspace.ts
/** A terminal request the host refused. */
var TerminalFailure = class extends Error {
	name = "TerminalFailure";
};
/**
* The workspace directory one Session's terminal belongs in.
* @param ctx - the host context carrying the session store.
* @param sessionId - the identity the browser supplied.
* @returns the absolute workspace directory.
* @throws TerminalFailure when neither a live nor a persisted header names one.
*/
async function resolveWorkspace(ctx, sessionId) {
	if (sessionId.trim() === "") throw new TerminalFailure("no session identity was supplied, so the workspace is unknown");
	const identity = sessionId;
	const live = ctx.get("sessions")?.get(identity)?.header;
	const stored = live === void 0 ? await ctx.get("sessionPersistence")?.stat(identity) : void 0;
	const cwd = (live ?? stored?.header)?.cwd;
	if (cwd === void 0 || cwd === "") throw new TerminalFailure(`session "${sessionId}" is unknown, so its workspace is too`);
	return cwd;
}
//#endregion
//#region src/terminal/host/terminal.ts
/**
* One browser socket, one terminal in the shared registry.
*
* The bridge owns the socket's half of the correspondence: it resolves the
* Session's workspace, asks the registry to register the shell a person just
* opened, and forwards keystrokes, resizes, and output. The registry owns the
* terminal itself, because the model-facing terminal tool drives the same
* shell; this module never allocates or releases one directly.
*
* A tab owns its shell, but the socket is only a view of it. A socket that
* closes detaches: the registry keeps the PTY and its retained output, so a
* reload, a closed tab, or a dropped connection can `attach` back and see the
* same shell for as long as it lives. Ending one is the chooser's own route,
* which reaches the registry without holding a socket, and a shell whose
* process exits still closes its socket and is released. A Session ending
* releases its terminals through the registry's own hook.
*
* Output is paced one chunk at a time through the sink the registry calls: a
* command that floods the terminal pauses the PTY's output stream until the
* socket has taken the chunk, instead of queueing the whole flood inside this
* process.
*
* @module dsh-remote-workspace/terminal/host/terminal
*/
/** Largest dimension a browser may ask a PTY for. */
const MAX_DIMENSION = 1e3;
/** Keystrokes held while a shell is still being allocated, before they are dropped. */
const MAX_PENDING_INPUT = 256;
/**
* Clamp a browser-measured dimension into something a PTY accepts.
* @param value - the measured value.
* @param fallback - the value to use when the measurement is not a number.
* @returns a whole number of rows or columns in range.
*/
function dimension(value, fallback) {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(MAX_DIMENSION, Math.max(1, Math.floor(value)));
}
/**
* Decode one WebSocket text message.
* @param data - the message as the server delivered it.
* @returns its UTF-8 text.
*/
function textOf(data) {
	if (Array.isArray(data)) return Buffer$1.concat(data).toString("utf8");
	if (Buffer$1.isBuffer(data)) return data.toString("utf8");
	return Buffer$1.from(data).toString("utf8");
}
/**
* Report a failure the way the browser's status line reads it.
* @param error - the thrown value.
* @returns its message, or its string form when it is not an Error.
*/
function describe(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* Serve one terminal over one accepted socket.
* @param ctx - the host context the workspace resolver reads.
* @param registry - the terminals a person's tabs have open.
* @param socket - the accepted browser socket.
*/
function attachTerminal(ctx, registry, socket) {
	let entryId;
	let opening = false;
	let closed = false;
	/** The size the browser last asked for; the spawn uses it even if it changed mid-allocation. */
	let requested = {
		cols: 80,
		rows: 24
	};
	/** The size last forwarded, so an unchanged resize is not asked for again. */
	let applied;
	const typed = [];
	const post = (frame) => {
		if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
	};
	/**
	* The registry's view of this socket.
	*
	* Output is handed to the socket one chunk at a time and the returned promise
	* is what lets the registry pause the PTY, so a socket that cannot keep up
	* slows the shell rather than this process.
	*/
	const sink = {
		output(chunk) {
			if (socket.readyState !== WebSocket.OPEN) return;
			return new Promise((resolve) => {
				socket.send(chunk, () => {
					resolve();
				});
			});
		},
		exit(outcome) {
			post({
				t: "exit",
				code: outcome.exitCode,
				signal: outcome.signal
			});
			socket.close(1e3, "terminal exited");
		},
		fail(error) {
			post({
				t: "error",
				message: describe(error)
			});
			socket.close(1011, "terminal failed");
		}
	};
	/** This socket went away: keep the shell it was viewing. */
	const stop = () => {
		if (closed) return;
		closed = true;
		const current = entryId;
		entryId = void 0;
		if (current !== void 0) registry.detach(current, sink);
	};
	/** Whether this socket may take on a terminal now, answering the browser if not. */
	const claim = () => {
		if (entryId === void 0 && !opening) return true;
		post({
			t: "error",
			message: "this connection already owns a terminal"
		});
		return false;
	};
	/** Deliver the keystrokes typed before the shell existed. */
	const flushTyped = (id) => {
		for (const data of typed.splice(0)) registry.write(id, data).catch(() => void 0);
	};
	/** Register the shell for one Session's workspace and start streaming it. */
	const open = async (frame) => {
		if (closed) return;
		if (!claim()) return;
		requested = {
			cols: dimension(frame.cols, 80),
			rows: dimension(frame.rows, 24)
		};
		opening = true;
		try {
			const cwd = await resolveWorkspace(ctx, frame.sessionId);
			const entry = await registry.open(frame.sessionId, cwd, requested);
			if (closed) {
				registry.kill(entry.id);
				return;
			}
			entryId = entry.id;
			applied = { ...requested };
			registry.attach(entry.id, sink);
			post({
				t: "ready",
				pid: entry.handle.pid,
				cwd: entry.cwd,
				id: entry.id,
				label: entry.label
			});
			flushTyped(entry.id);
		} catch (error) {
			post({
				t: "error",
				message: describe(error)
			});
		} finally {
			opening = false;
		}
	};
	/** Adopt a browser-measured size, now or as the size the shell will start at. */
	const applySize = async (cols, rows) => {
		const next = {
			cols: dimension(cols, requested.cols),
			rows: dimension(rows, requested.rows)
		};
		requested = next;
		const current = entryId;
		if (current === void 0) return;
		if (applied !== void 0 && applied.cols === next.cols && applied.rows === next.rows) return;
		applied = next;
		const live = await registry.resize(current, next.cols, next.rows);
		post({
			t: "size",
			cols: next.cols,
			rows: next.rows,
			live
		});
	};
	/** Reattach this socket to a terminal it already knows by id. */
	const reattach = (frame) => {
		if (closed) return;
		if (!claim()) return;
		let entry;
		try {
			registry.requireOwned(frame.sessionId, frame.id);
			entry = registry.attach(frame.id, sink);
		} catch (error) {
			post({
				t: "error",
				message: describe(error)
			});
			return;
		}
		entryId = entry.id;
		applied = {
			cols: entry.cols,
			rows: entry.rows
		};
		post({
			t: "ready",
			pid: entry.handle.pid,
			cwd: entry.cwd,
			id: entry.id,
			label: entry.label
		});
		flushTyped(entry.id);
		applySize(frame.cols, frame.rows);
	};
	socket.on("close", stop);
	socket.on("error", stop);
	socket.on("message", (data, isBinary) => {
		if (isBinary) return;
		let frame;
		try {
			frame = JSON.parse(textOf(data));
		} catch {
			return;
		}
		switch (frame.t) {
			case "open":
				open(frame);
				return;
			case "attach":
				reattach(frame);
				return;
			case "input": {
				const current = entryId;
				if (current === void 0) {
					if (typed.length < MAX_PENDING_INPUT) typed.push(frame.data);
					return;
				}
				registry.write(current, frame.data).catch(() => void 0);
				return;
			}
			case "resize":
				applySize(frame.cols, frame.rows);
				return;
			default: return;
		}
	});
}
//#endregion
//#region src/terminal/host/socket.ts
/**
* Refuse an upgrade without giving the socket to the WebSocket server.
* @param socket - the socket still owned by this handler.
* @param status - the HTTP status to answer with.
*/
function rejectUpgrade(socket, status) {
	const reason = status === 401 ? "Unauthorized" : "Forbidden";
	socket.end(`HTTP/1.1 ${String(status)} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
}
/**
* Register the terminal socket for this plugin's lifetime.
*
* A missing Web server is not a failure: it means nobody can open a terminal,
* not that the plugin is misconfigured.
*
* @param ctx - the host context.
* @param path - the absolute pathname the socket is served at.
* @param registry - the terminals a person's tabs have open.
*/
function registerTerminalSocket(ctx, path, registry) {
	const webServer = ctx.get("webServer");
	if (webServer === void 0) return;
	const server = new WebSocketServer({
		noServer: true,
		perMessageDeflate: false
	});
	const live = /* @__PURE__ */ new Set();
	ctx.effect(() => {
		const unregister = webServer.registerUpgrade({
			path,
			handler: (request, socket, head) => {
				const rejection = ctx.get("connection")?.requestRejection(request);
				if (rejection !== void 0) {
					rejectUpgrade(socket, rejection);
					return;
				}
				server.handleUpgrade(request, socket, head, (accepted) => {
					live.add(accepted);
					accepted.on("close", () => live.delete(accepted));
					attachTerminal(ctx, registry, accepted);
				});
			}
		});
		return () => {
			unregister();
			for (const socket of live) socket.terminate();
			live.clear();
		};
	}, `dsh-terminal: ${path} socket`);
}
//#endregion
//#region src/terminal/shared/wire.ts
/**
* The wire between the browser terminal and the host that owns its PTY.
*
* Two kinds of frame share one socket, told apart by how WebSocket carries
* them rather than by a tag inside them:
*
* - **text** carries JSON control — opening a terminal, keystrokes, resizes,
*   and the host's answers;
* - **binary** carries raw terminal bytes, host to browser only, so a shell's
*   output is not base64-encoded and re-decoded once per chunk.
*
* A socket's life is one *view* of a terminal, not the terminal itself. A
* socket that closes detaches: the host keeps the PTY and its retained output
* so a reload, a closed tab, or a dropped connection can `attach` back to the
* same shell, which lives for as long as its process does.
*
* @module dsh-remote-workspace/terminal/shared/wire
*/
/** Where the host serves the terminal socket. */
const SOCKET_PATH = "/dsh-terminal/ws";
//#endregion
//#region src/tools/terminal.ts
/** The one tool's actions, in the order the description lists them. */
const ACTIONS = [
	"list",
	"read",
	"send",
	"keys",
	"wait"
];
/**
* Which actions each optional parameter belongs to.
*
* This table is the whole per-action contract: a parameter present in a call
* whose action is not in its list is refused, and no action handler has to
* re-state the rule.
*/
const PARAM_ACTIONS = {
	terminal: [
		"read",
		"send",
		"keys",
		"wait"
	],
	text: ["send"],
	enter: ["send"],
	keys: ["keys"],
	lines: ["read"],
	offset: ["read", "wait"],
	match: ["wait"],
	regex: ["wait"],
	timeoutMs: ["wait"]
};
/** The canonical schemas, one branch per distinct return shape. */
const TERMINAL_VALUE_SCHEMA = { oneOf: [
	{
		type: "object",
		additionalProperties: false,
		properties: { terminals: {
			type: "array",
			required: true,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					label: {
						type: "string",
						required: true
					},
					cwd: {
						type: "string",
						required: true
					},
					machine: {
						type: "string",
						required: true
					},
					pid: {
						type: "number",
						required: true
					},
					state: {
						type: "string",
						required: true,
						enum: [
							"running",
							"detached",
							"exited"
						]
					},
					cols: {
						type: "number",
						required: true
					},
					rows: {
						type: "number",
						required: true
					}
				}
			}
		} }
	},
	{
		type: "object",
		additionalProperties: false,
		properties: {
			id: {
				type: "string",
				required: true
			},
			offset: {
				type: "number",
				required: true
			},
			text: {
				type: "string",
				required: true
			},
			truncated: {
				type: "boolean",
				required: true
			}
		}
	},
	{
		type: "object",
		additionalProperties: false,
		properties: {
			id: {
				type: "string",
				required: true
			},
			wrote: {
				type: "object",
				additionalProperties: false,
				required: true,
				properties: {
					bytes: {
						type: "number",
						required: true
					},
					keys: {
						type: "number",
						required: true
					}
				}
			}
		}
	},
	{
		type: "object",
		additionalProperties: false,
		properties: {
			id: {
				type: "string",
				required: true
			},
			offset: {
				type: "number",
				required: true
			},
			text: {
				type: "string",
				required: true
			},
			matched: {
				type: "boolean",
				required: true
			},
			reason: {
				type: "string",
				required: true,
				enum: [
					"match",
					"exit",
					"timeout"
				]
			}
		}
	}
] };
/**
* Render one page of a terminal's output with the offset that resumes after it.
*
* The model sees only this text, so the resumable offset is part of it: that is
* what lets a caller chain a wait after a read without guessing.
* @param id - the terminal.
* @param offset - the absolute byte offset just past `text`.
* @param text - the page's text, possibly empty.
* @param label - what the page is: a wait reason, `truncated`, `no output`, or nothing.
* @returns the model-facing text.
*/
function renderPage(id, offset, text, label = "") {
	const marker = `[${id}${label === "" ? "" : ` ${label}`} offset ${String(offset)}]`;
	return text === "" ? marker : `${marker}\n${text}`;
}
/**
* Render one canonical value for the model.
*
* A read and a wait answer with the terminal's own text under a marker that
* carries what the page is and the offset that resumes after it; the other
* actions say what they did in one line.
* @param value - the canonical value the body returned.
* @returns the model-facing text.
*/
function renderValue(value) {
	if ("terminals" in value) {
		if (value.terminals.length === 0) return "No terminal is open in this session.";
		return value.terminals.map((terminal) => `${terminal.id} (${terminal.label}) ${terminal.state} · ${terminal.cwd} · ${terminal.machine}`).join("\n");
	}
	if ("wrote" in value) return value.wrote.keys === 0 ? `Wrote ${String(value.wrote.bytes)} byte(s) to ${value.id}.` : `Sent ${String(value.wrote.keys)} key(s) to ${value.id}.`;
	if ("matched" in value) return renderPage(value.id, value.offset, value.text, value.reason);
	return renderPage(value.id, value.offset, value.text, value.text === "" ? "no output" : value.truncated ? "truncated" : "");
}
/**
* Refuse a parameter that belongs to another action.
* @param args - the validated, frozen model arguments.
* @param action - the action being executed.
* @throws TerminalRegistryError naming the parameter and the action that owns it.
*/
function rejectForeign(args, action) {
	for (const [name, allowed] of Object.entries(PARAM_ACTIONS)) {
		if (args[name] === void 0 || allowed.includes(action)) continue;
		throw new TerminalRegistryError(`"${name}" is valid only with action ${allowed.join(" or ")}, not "${action}"`);
	}
}
/**
* Register the terminal tool on the host plane.
*
* A profile with no tool runtime is not a failure: the terminal socket and the
* sidebar still work, and the model simply has no way to drive a shell.
* @param ctx - the host context.
* @param registry - the terminals a person's tabs have open.
*/
function registerTerminalTool(ctx, registry) {
	const tools = ctx.get("tools");
	if (tools === void 0) return;
	tools.register(defineTool({
		name: "terminal",
		description: "Work with the terminals a person has open in the sidebar: read their output, type into them, send named keys, and wait for output. This is one terminal tool with an \"action\"; the other parameters apply only to the actions named in their descriptions. It never opens a terminal — a person opening a sidebar tab does that — and it never closes one: a shell is ended from the list a person picks one in, not from a tool call. A terminal whose tab lost its connection without closing is \"detached\": it stays addressable until it is closed, its process exits, or its session ends. Use \"list\" to see what is open, \"read\" for recent output, \"send\" to run a command (\"enter\" defaults to true), \"keys\" for named keys such as ctrl+c, and \"wait\" to search the recent output and settle when it matches or the command exits.",
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: ACTIONS,
				description: "list | read | send | keys | wait"
			},
			terminal: {
				type: "string",
				description: "Terminal id from list. Required when more than one terminal is open in this session; omit it when exactly one is."
			},
			text: {
				type: "string",
				description: "Literal text to type; valid only with action send."
			},
			enter: {
				type: "boolean",
				description: "Append a carriage return after text; defaults to true. Valid only with action send."
			},
			keys: {
				type: "array",
				items: { type: "string" },
				description: "Logical key names (enter, esc, tab, backspace, up, down, left, right, ctrl+a…ctrl+z); valid only with action keys. Every name is checked before anything is written."
			},
			lines: {
				type: "number",
				description: "Tail line count to read, default 200, max 2000; valid only with action read."
			},
			offset: {
				type: "number",
				description: "Absolute byte offset to read or wait from. Omitted reads the tail, and starts a wait at the beginning of that same retained tail, so output that already arrived can match. Valid with read and wait; the render carries the offset that resumes after it."
			},
			match: {
				type: "string",
				description: "Plain text to wait for; pass exactly one of match and regex. Valid only with action wait."
			},
			regex: {
				type: "string",
				description: "Regular expression source to wait for; pass exactly one of match and regex. Valid only with action wait."
			},
			timeoutMs: {
				type: "number",
				description: "Wait budget in milliseconds, default 30000, max 300000. A timeout returns reason \"timeout\" instead of failing. Valid only with action wait."
			}
		},
		output: {
			schema: TERMINAL_VALUE_SCHEMA,
			render: (_args, value) => [{
				type: "text",
				text: renderValue(value)
			}]
		},
		async execute(args, exec) {
			if (exec.agent === void 0) throw new TerminalRegistryError("the terminal tool requires an Agent Session");
			const sessionId = String(exec.agent.id);
			const action = args.action;
			rejectForeign(args, action);
			if (action === "list") return { terminals: registry.listFor(sessionId) };
			const entry = registry.requireOwned(sessionId, args.terminal);
			if (action === "read") return registry.read(entry.id, args.offset, args.lines);
			if (action === "send") {
				if (args.text === void 0) throw new TerminalRegistryError("send requires \"text\"");
				const payload = args.enter === false ? args.text : `${args.text}\r`;
				const bytes = await registry.write(entry.id, payload);
				return {
					id: entry.id,
					wrote: {
						bytes,
						keys: 0
					}
				};
			}
			if (action === "keys") {
				if (args.keys === void 0 || args.keys.length === 0) throw new TerminalRegistryError("keys requires a non-empty \"keys\" array");
				return {
					id: entry.id,
					wrote: await registry.keys(entry.id, args.keys)
				};
			}
			if (args.match === void 0 === (args.regex === void 0)) throw new TerminalRegistryError(args.match === void 0 ? "wait requires exactly one of \"match\" and \"regex\"" : "wait accepts only one of \"match\" and \"regex\"");
			const request = {
				...args.offset === void 0 ? {} : { offset: args.offset },
				...args.match === void 0 ? {} : { match: args.match },
				...args.regex === void 0 ? {} : { regex: args.regex },
				...args.timeoutMs === void 0 ? {} : { timeoutMs: args.timeoutMs }
			};
			return await registry.wait(entry.id, request, exec.signal);
		}
	}));
}
//#endregion
//#region src/index.ts
/** Plugin name used by the Loader and by diagnostics. */
const name = "dsh-remote-workspace";
/**
* Services this plugin needs before it activates. `sandboxPolicy` is required
* by the composed local delegate, and declaring it here keeps provision of
* `ctx.fs` behind that dependency rather than racing it. The Sidebar terminal
* reads the session store and the terminal seam it serves, so it looks both up
* dynamically rather than making them activation dependencies.
*/
const inject = ["sandboxPolicy"];
/**
* The stock rows providing the seams this plugin routes. The host plane holds
* one implementation per service, so a deployment disables these in its own
* patch layer before this plugin can publish; see the README's install section.
*/
const STOCK_ROWS = [
	"subprocess",
	"fs-sandbox",
	"bash-sandbox",
	"pwsh-sandbox"
];
/**
* Publish one routing seam, naming the profile edit when a stock row got there
* first.
*
* `ctx.provide` refuses a service that already has a provider: the failure a
* deployment sees when it added this plugin without disabling the stock rows.
* That refusal names the row, not the fix, so this reports the fix.
*
* The value is cast because each seam type extends `Service`, whose protected
* members make it nominal: a plain object cannot be assigned structurally.
* Every router is checked against its seam's contract factory instead.
* @param ctx - the host context.
* @param service - the service being published.
* @param value - the routing implementation.
* @returns the disposer `ctx.provide` returned.
*/
function publishSeam(ctx, service, value) {
	try {
		return ctx.provide(service, value);
	} catch (cause) {
		const hint = `${name}: ctx.${service} already has a provider, so this router is inert. Disable ${STOCK_ROWS.join(", ")} in the profile's cordis.patch.yml — see the README's install section.`;
		ctx.logger.error(hint);
		process.stderr.write(`${hint}\n`);
		throw new Error(hint, { cause });
	}
}
/** Validated plugin config. */
const Config = z.object({
	dataDir: z.string(),
	remoteRipgrep: z.string(),
	worktreeRoot: z.string(),
	sshForwardTimeoutMs: z.number().step(1).min(1),
	daemonHandshakeTimeoutMs: z.number().step(1).min(1),
	shell: z.string(),
	shellArgs: z.array(z.string()),
	graceMs: z.number().step(1).min(1),
	detachGraceMs: z.number().step(1).min(0)
});
/** Root managed worktrees are cut under when the config names none. */
const DEFAULT_WORKTREE_ROOT = "~/.dsh/worktrees";
/**
* Mount the plugin.
*
* @param ctx - the host context this plugin was mounted on.
* @param config - the validated plugin config.
*/
async function apply(ctx, config) {
	const configuredRoot = config.worktreeRoot ?? DEFAULT_WORKTREE_ROOT;
	if (configuredRoot !== "~" && !configuredRoot.startsWith("~/") && !configuredRoot.startsWith("/")) throw new Error(`worktreeRoot must be absolute, "~", or "~/…": "${configuredRoot}"`);
	const dataDir = config.dataDir ?? dshHomePath("remote-worktrees");
	const registry = createNodeRegistry({ file: join(dataDir, "nodes.json") });
	await registry.load();
	const anchorStore = createAnchorStore({ root: join(dataDir, "anchors") });
	await anchorStore.load();
	const repos = createRepoStore({ file: join(dataDir, "repos.json") });
	await repos.load();
	const connections = createNodeConnections({
		cacheDir: join(dataDir, "agents"),
		agentVersion: AGENT_VERSION,
		sshForwardTimeoutMs: config.sshForwardTimeoutMs ?? 15e3,
		daemonHandshakeTimeoutMs: config.daemonHandshakeTimeoutMs ?? 1e4
	});
	ctx.effect(() => {
		const stop = autoconnect({
			records: () => registry.list(),
			connections,
			status: (nodeId) => connections.status(nodeId),
			refreshMs: 3e4
		});
		return () => {
			stop();
			connections.dispose();
		};
	});
	const isLocalNode = (nodeId) => registry.get(nodeId)?.transport.kind === "local";
	/** Where managed checkouts live on one machine. */
	const worktreeRoot = (nodeId) => {
		if (!configuredRoot.startsWith("~")) return configuredRoot;
		const home = isLocalNode(nodeId) ? homedir() : connections.status(nodeId).info?.homedir;
		if (home === void 0) throw new Error(`the home directory of "${nodeId}" is unknown; connect that machine first`);
		return posix.join(home, configuredRoot.slice(1));
	};
	const worktrees = createWorktreeManager({
		anchors: anchorStore,
		repos,
		channel: (nodeId) => connections.channel(nodeId),
		isLocalNode,
		worktreeRoot,
		workspace: {
			async register(anchor) {
				const node = registry.get(anchor.nodeId);
				await workspaceRegistry(ctx)?.create(anchor.anchorPath, workspaceLabel({
					machine: node?.title ?? anchor.nodeId,
					repoPath: anchor.repoPath,
					repoName: repos.find({
						nodeId: anchor.nodeId,
						repoPath: anchor.repoPath
					})?.name,
					...anchor.kind === "worktree" ? { name: anchor.name } : {}
				}));
			},
			async unregister(anchor) {
				const service = workspaceRegistry(ctx);
				if (service === void 0) return;
				const record = await service.resolveByPath(anchor.anchorPath);
				if (record !== void 0) await service.delete(record.id);
			},
			async registered(anchor) {
				return await workspaceRegistry(ctx)?.resolveByPath(anchor.anchorPath) !== void 0;
			}
		}
	});
	const subprocessScope = ctx.isolate("subprocess");
	subprocessScope.plugin(LocalSubprocessRuntime);
	subprocessScope.inject(["subprocess"], (scoped) => {
		return publishSeam(ctx, "subprocess", createRoutingSubprocessRuntime({
			localProc: scoped.subprocess,
			anchors: () => anchorStore.routes(),
			channel: (nodeId) => connections.channel(nodeId),
			...config.remoteRipgrep === void 0 ? {} : { remoteRipgrep: config.remoteRipgrep }
		}));
	});
	const fsScope = ctx.isolate("fs");
	fsScope.plugin(SandboxedFileSystem, {});
	fsScope.inject(["fs"], (scoped) => {
		return publishSeam(ctx, "fs", createRoutingFileSystem({
			localFs: scoped.fs,
			anchors: () => anchorStore.routes(),
			channel: (nodeId) => connections.channel(nodeId)
		}));
	});
	const localShellScope = ctx.isolate("shell");
	localShellScope.plugin(SandboxBashExecutor, {});
	const remoteShellScope = ctx.isolate("shell");
	remoteShellScope.plugin(LocalBashExecutor);
	localShellScope.inject(["shell"], (localScoped) => {
		remoteShellScope.inject(["shell"], (remoteScoped) => {
			return publishSeam(ctx, "shell", createRoutingShellExecutor({
				localShell: localScoped.shell,
				remoteShell: remoteScoped.shell,
				anchors: () => anchorStore.routes()
			}));
		});
	});
	const ttyScope = ctx.isolate("tty");
	ttyScope.plugin(LocalTtyRuntime);
	ttyScope.inject(["tty"], (scoped) => {
		return publishSeam(ctx, "tty", createRoutingTty({
			localTty: scoped.tty,
			anchors: () => anchorStore.routes(),
			channel: (nodeId) => connections.channel(nodeId)
		}));
	});
	const configuredShell = config.shell !== void 0 && config.shell.length > 0 ? config.shell : void 0;
	const terminalSettings = {
		shell: configuredShell ?? "/bin/sh",
		shellArgs: configuredShell === void 0 ? ["-c", "exec \"${SHELL:-/bin/sh}\" -l"] : config.shellArgs !== void 0 && config.shellArgs.length > 0 ? config.shellArgs : ["-l"],
		env: {
			TERM: "xterm-256color",
			COLORTERM: "truecolor"
		},
		graceMs: config.graceMs ?? 3e3,
		detachGraceMs: config.detachGraceMs ?? 0
	};
	const routeOf = (cwd) => classifyPath(cwd, void 0, anchorStore.routes());
	const terminals = createTerminalRegistry({
		spawn: (request) => {
			const tty = ctx.get("tty");
			if (tty === void 0) throw new Error("no terminal provider is composed");
			return tty.spawn(request);
		},
		settings: terminalSettings,
		machine: (cwd) => {
			const route = routeOf(cwd);
			const nodeId = route.kind === "remote" ? route.nodeId : LOCAL_NODE_ID;
			return { label: registry.get(nodeId)?.title ?? nodeId };
		},
		directory: (cwd) => {
			const route = routeOf(cwd);
			return route.kind === "remote" ? route.remotePath : cwd;
		}
	});
	registerNodeApi(ctx, {
		registry,
		repos,
		connections,
		worktrees,
		worktreeRoot,
		terminals
	});
	registerTerminalSocket(ctx, SOCKET_PATH, terminals);
	registerTerminalTool(ctx, terminals);
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.register(TERMINAL_DISPLAY_NAMESPACE, TerminalDisplaySchema);
	});
	ctx.on("agent/disposed", ({ agent }) => {
		terminals.releaseSession(String(agent.id));
	});
	ctx.effect(() => () => terminals.disposeAll(), "dsh-terminal: registry disposal");
}
/**
* The deployment's workspace registry, when one is composed.
*
* Read dynamically rather than injected: a headless or SDK profile may compose
* no registry, and the plugin must still load and route there.
* @param ctx - the host context.
* @returns the registry, or undefined when this deployment composes none.
*/
function workspaceRegistry(ctx) {
	return ctx.get("workspaceRegistry");
}
//#endregion
export { Config, apply, inject, name };

//# sourceMappingURL=index.js.map