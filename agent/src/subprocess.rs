//! Subprocess operations behind the daemon's `sp.*` wire methods.
//!
//! Every child is started as an argv array directly, never through a shell, and
//! detached so it leads its own process group: termination and
//! `sp.waitForExit` address the whole managed range, not just the top-level
//! child. Collected output is kept as raw bytes addressed by whole-stream byte
//! offset, so two readers asking from the same offset see the same bytes and
//! nothing is decoded or normalized on the way through.
//!
//! One backend owns the processes one connection started; `close` kills their
//! ranges and releases their buffers when that connection ends.
//!
//! @module dsh-remote-agent/subprocess

use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::{FromRawFd, RawFd};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::unix::OwnedWriteHalf;
use tokio::process::{Child, ChildStdin};
use tokio::sync::{watch, Mutex as AsyncMutex};

use crate::execution::{
    group_alive, outcome_of_status, scrubbed_environment, signal_group, unique_id,
    usable_directory, StreamBuffer,
};
use crate::failure::{Failure, Result};
use crate::outbound::Outbound;
use crate::protocol::{Outcome, OutputMode, SpawnSpec, StdinMode, SP_PIPE_NOTIFICATION};

/// Interval between managed-range liveness checks after the child has exited.
const GROUP_POLL: Duration = Duration::from_millis(25);

/// Descriptor the child opens its inherited control channel on. It matches the
/// `@deepseek-ai/dsh-subprocess/control` helper both halves share.
const SUBPROCESS_CONTROL_FD: RawFd = 7;

/// Environment marker announcing the inherited control descriptor.
const SUBPROCESS_CONTROL_ENV: &str = "DSH_SUBPROCESS_CONTROL";

/// One of a child's two captured streams.
#[derive(Clone, Copy)]
enum Which {
    Out = 0,
    Err = 1,
    Control = 2,
}

impl Which {
    /// The name the wire contract spells this stream with.
    fn name(self) -> &'static str {
        match self {
            Which::Out => "stdout",
            Which::Err => "stderr",
            Which::Control => "control",
        }
    }

    /// The stream one wire name selects, or `None` for a name it does not define.
    fn from_name(name: &str) -> Option<Self> {
        match name {
            "stdout" => Some(Which::Out),
            "stderr" => Some(Which::Err),
            _ => None,
        }
    }
}

/// The subprocess methods the daemon serves, one per `sp.*` wire method.
pub struct SubprocessBackend {
    outbound: Outbound,
    processes: Mutex<HashMap<String, Arc<ManagedProcess>>>,
    /// Set once the owning connection closed, so a late spawn ends instead.
    closed: AtomicBool,
    counter: AtomicU64,
}

impl SubprocessBackend {
    /// Build the subprocess backend for one connection.
    /// @param outbound - the handle that pushes pipe frames to that connection.
    /// @returns the backend owning the processes this connection starts.
    pub fn new(outbound: Outbound) -> Self {
        Self {
            outbound,
            processes: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(0),
            closed: AtomicBool::new(false),
        }
    }

    /// The managed process behind an id, or the typed failure.
    fn require(&self, proc_id: &str) -> Result<Arc<ManagedProcess>> {
        self.processes
            .lock()
            .expect("process table poisoned")
            .get(proc_id)
            .cloned()
            .ok_or_else(|| {
                Failure::new(
                    "SP_NO_SUCH_PROCESS",
                    format!("no such process \"{proc_id}\""),
                )
            })
    }

    /// Resolve a program name to an absolute executable path.
    pub fn resolve_executable(&self, command: &str, env: &[(String, String)]) -> Result<Value> {
        if Path::new(command).is_absolute() {
            return Ok(json!({ "path": canonical_executable(command)? }));
        }
        if command.contains('/') {
            return Err(Failure::new(
                "SP_NOT_EXECUTABLE",
                format!("cannot resolve \"{command}\": a relative path is not an executable name"),
            ));
        }
        let search_path = env
            .iter()
            .find(|(key, _)| key == "PATH")
            .map(|(_, value)| value.clone())
            .or_else(|| std::env::var("PATH").ok())
            .unwrap_or_default();
        for directory in search_path.split(':') {
            // An empty entry means "the current directory" to some shells; the
            // daemon never resolves a program relative to a working directory.
            if directory.is_empty() {
                continue;
            }
            let candidate = Path::new(directory).join(command);
            if let Ok(path) = canonical_executable(&candidate.to_string_lossy()) {
                return Ok(json!({ "path": path }));
            }
        }
        Err(Failure::new(
            "SP_NOT_FOUND",
            format!("cannot resolve \"{command}\": not found on PATH"),
        ))
    }

    /// Start a child process and keep its collected output and exit facts.
    pub async fn spawn(&self, spec: SpawnSpec) -> Result<Value> {
        let program = spec.argv.first().cloned().ok_or_else(|| {
            Failure::new(
                "SP_SPAWN_FAILED",
                "cannot spawn: argv does not name a program",
            )
        })?;
        let cwd = usable_directory(&spec.cwd, "SP_SPAWN_FAILED")?;

        let (stdout_stdio, stdout_window) = output_stream(&spec.stdout);
        let (stderr_stdio, stderr_window) = output_stream(&spec.stderr);
        let mut command = tokio::process::Command::new(&program);
        command
            .args(&spec.argv[1..])
            .current_dir(&cwd)
            .env_clear()
            .envs(scrubbed_environment())
            .envs(spec.env.iter().cloned())
            .stdin(stdin_disposition(&spec.stdin))
            .stdout(stdout_stdio)
            .stderr(stderr_stdio);
        // A child leads its own process group so termination addresses the whole
        // managed range rather than only the process we started.
        command.as_std_mut().process_group(0);

        // An optional control channel is a socketpair whose child end becomes
        // fd 7; the daemon keeps the other end and proxies it over control
        // frames and `sp.writeControl`.
        let control_pair = if spec.control {
            let pair = open_control_pair()?;
            command.as_std_mut().env(SUBPROCESS_CONTROL_ENV, "pipe");
            unsafe {
                command
                    .as_std_mut()
                    .pre_exec(move || inherit_control_fd(pair.0));
            }
            Some(pair)
        } else {
            None
        };

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                if let Some((child_fd, agent_fd)) = control_pair {
                    unsafe {
                        libc::close(child_fd);
                        libc::close(agent_fd);
                    }
                }
                return Err(Failure::new(
                    "SP_SPAWN_FAILED",
                    format!("cannot spawn \"{program}\": {error}"),
                ));
            }
        };

        // The child owns its duplicated end from the fork; releasing the
        // daemon's copy of it is what lets the reader observe the child's close.
        let control_stream = match control_pair {
            None => None,
            Some((child_fd, agent_fd)) => {
                unsafe {
                    libc::close(child_fd);
                }
                let stream = unsafe { std::os::unix::net::UnixStream::from_raw_fd(agent_fd) };
                Some(tokio::net::UnixStream::from_std(stream).map_err(|error| {
                    Failure::new(
                        "SP_SPAWN_FAILED",
                        format!("cannot adopt the control channel: {error}"),
                    )
                })?)
            }
        };
        // The child leads its own process group from here on, so a spawn that
        // reports no id is a failure rather than a process to signal later.
        let pid = child.id().map(|value| value as i32).ok_or_else(|| {
            Failure::new(
                "SP_SPAWN_FAILED",
                format!("cannot spawn \"{program}\": the child has no process id"),
            )
        })?;
        let stdin = child.stdin.take();
        let stdout_pipe = child.stdout.take();
        let stderr_pipe = child.stderr.take();
        let (control_read, control_write) = match control_stream {
            None => (None, None),
            Some(stream) => {
                let (read, write) = stream.into_split();
                (Some(read), Some(write))
            }
        };

        let managed = Arc::new(ManagedProcess {
            proc_id: unique_id(&self.counter),
            pid,
            grace_ms: spec.grace_ms,
            stdin: AsyncMutex::new(stdin),
            stdout: stdout_window,
            stderr: stderr_window,
            control: AsyncMutex::new(control_write),
            pipe_stdout: spec.stdout == OutputMode::Pipe,
            pipe_stderr: spec.stderr == OutputMode::Pipe,
            pipe_control: spec.control,
            state: Mutex::new(ProcessState::default()),
            settled: watch::channel(None).0,
            readers_left: watch::channel(0).0,
            sequence: [AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0)],
            outbound: self.outbound.clone(),
        });

        managed.readers_left.send_replace(
            usize::from(stdout_pipe.is_some())
                + usize::from(stderr_pipe.is_some())
                + usize::from(spec.control),
        );
        if let Some(pipe) = stdout_pipe {
            let reader = managed.clone();
            tokio::spawn(async move { read_stream(reader, Which::Out, pipe).await });
        }
        if let Some(pipe) = stderr_pipe {
            let reader = managed.clone();
            tokio::spawn(async move { read_stream(reader, Which::Err, pipe).await });
        }
        if let Some(pipe) = control_read {
            let reader = managed.clone();
            tokio::spawn(async move { read_stream(reader, Which::Control, pipe).await });
        }
        {
            let waiter = managed.clone();
            tokio::spawn(async move { await_child(waiter, child).await });
        }

        // Decided under the table lock: a process that lands before `close` sets
        // the flag is drained by it, and one that lands after is ended here.
        let sealed = {
            let mut table = self.processes.lock().expect("process table poisoned");
            if self.closed.load(Ordering::SeqCst) {
                true
            } else {
                table.insert(managed.proc_id.clone(), managed.clone());
                false
            }
        };
        if sealed {
            managed.dispose();
        }

        if let StdinMode::Data(data) = &spec.stdin {
            managed.write_stdin_bytes(data).await?;
            managed.close_stdin().await;
        }
        Ok(json!({ "procId": managed.proc_id }))
    }

    /// Read one collected stream from a whole-stream byte offset.
    pub fn read_output(&self, proc_id: &str, stream: &str, from_byte: u64) -> Result<Value> {
        let managed = self.require(proc_id)?;
        let which = Which::from_name(stream).ok_or_else(|| {
            Failure::invalid_params(
                "sp.readOutput",
                format!("\"stream\" must be \"stdout\" or \"stderr\", got \"{stream}\""),
            )
        })?;
        let buffer = match which {
            Which::Out => managed.stdout.as_ref(),
            Which::Err => managed.stderr.as_ref(),
            // `from_name` names only the collected streams; control is pushed.
            Which::Control => None,
        };
        let buffer = buffer.ok_or_else(|| {
            Failure::new(
                "SP_UNSUPPORTED_STDIO",
                format!("process \"{proc_id}\" did not collect {stream}"),
            )
        })?;
        let (bytes, next_offset, lossy) = buffer.read(from_byte);
        Ok(json!({
            "data": base64::engine::general_purpose::STANDARD.encode(&bytes),
            "nextOffset": next_offset,
            "lossy": lossy,
        }))
    }

    /// Write bytes to a child started with piped stdin.
    pub async fn write_stdin(&self, proc_id: &str, data: &str) -> Result<Value> {
        self.require(proc_id)?
            .write_stdin_bytes(data.as_bytes())
            .await?;
        Ok(json!({}))
    }

    /// Close a child's piped stdin.
    pub async fn close_stdin(&self, proc_id: &str) -> Result<Value> {
        self.require(proc_id)?.close_stdin().await;
        Ok(json!({}))
    }

    /// Write bytes to a child started with a control channel.
    ///
    /// `data` is base64 like every other binary payload on this wire, so the
    /// channel carries arbitrary bytes rather than only UTF-8.
    pub async fn write_control(&self, proc_id: &str, data: &str) -> Result<Value> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|error| {
                Failure::invalid_params(
                    "sp.writeControl",
                    format!("\"data\" must be base64: {error}"),
                )
            })?;
        self.require(proc_id)?.write_control_bytes(&bytes).await?;
        Ok(json!({}))
    }

    /// Signal the managed range and escalate to `SIGKILL` after the grace period.
    pub fn terminate(&self, proc_id: &str) -> Result<Value> {
        self.require(proc_id)?.terminate();
        Ok(json!({}))
    }

    /// Wait until the whole managed range is gone, not merely the direct child.
    pub async fn wait_for_exit(&self, proc_id: &str) -> Result<Value> {
        self.require(proc_id)?.wait_for_exit().await;
        Ok(json!({}))
    }

    /// Read the exit facts of a closed child.
    pub fn outcome(&self, proc_id: &str) -> Result<Value> {
        Ok(Outcome::to_json(self.require(proc_id)?.outcome().as_ref()))
    }

    /// Kill every managed range and release every retained buffer.
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let processes: Vec<Arc<ManagedProcess>> = self
            .processes
            .lock()
            .expect("process table poisoned")
            .drain()
            .map(|(_, managed)| managed)
            .collect();
        for managed in processes {
            managed.dispose();
        }
    }
}

/// The mutable facts one managed process publishes to its callers.
#[derive(Default)]
struct ProcessState {
    exit_facts: Option<Outcome>,
    settled: Option<Outcome>,
    terminating: bool,
    abandoned: bool,
    disposed: bool,
}

/// One managed child: its collected streams, exit facts, and termination ladder.
struct ManagedProcess {
    proc_id: String,
    pid: i32,
    grace_ms: u64,
    stdin: AsyncMutex<Option<ChildStdin>>,
    stdout: Option<StreamBuffer>,
    stderr: Option<StreamBuffer>,
    control: AsyncMutex<Option<OwnedWriteHalf>>,
    pipe_stdout: bool,
    pipe_stderr: bool,
    pipe_control: bool,
    state: Mutex<ProcessState>,
    settled: watch::Sender<Option<Outcome>>,
    readers_left: watch::Sender<usize>,
    /// One monotonic frame counter per stream, indexed by [`Which`].
    sequence: [AtomicU64; 3],
    outbound: Outbound,
}

impl ManagedProcess {
    /// Write to the child's piped stdin.
    async fn write_stdin_bytes(&self, data: &[u8]) -> Result<()> {
        let mut guard = self.stdin.lock().await;
        let Some(stdin) = guard.as_mut() else {
            return Err(Failure::new(
                "SP_UNSUPPORTED_STDIO",
                "this process was not started with piped stdin",
            ));
        };
        stdin.write_all(data).await.map_err(|error| {
            Failure::new(
                "SP_UNSUPPORTED_STDIO",
                format!("cannot write to stdin: {error}"),
            )
        })
    }

    /// Close the child's piped stdin; a second close is harmless.
    async fn close_stdin(&self) {
        drop(self.stdin.lock().await.take());
    }

    /// Write to the child's control channel.
    async fn write_control_bytes(&self, data: &[u8]) -> Result<()> {
        let mut guard = self.control.lock().await;
        let Some(control) = guard.as_mut() else {
            return Err(Failure::new(
                "SP_UNSUPPORTED_STDIO",
                "this process was not started with a control channel",
            ));
        };
        control.write_all(data).await.map_err(|error| {
            Failure::new(
                "SP_UNSUPPORTED_STDIO",
                format!("cannot write to the control channel: {error}"),
            )
        })
    }

    /// Start the terminate ladder once.
    fn terminate(self: &Arc<Self>) {
        {
            let mut state = self.state.lock().expect("process state poisoned");
            if state.terminating || state.settled.is_some() {
                return;
            }
            state.terminating = true;
        }
        signal_group(self.pid, libc::SIGTERM);
        let managed = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(managed.grace_ms)).await;
            let escalate = {
                let state = managed.state.lock().expect("process state poisoned");
                !state.disposed && state.settled.is_none()
            };
            if escalate {
                signal_group(managed.pid, libc::SIGKILL);
            }
        });
    }

    /// Resolve once no member of the managed range is left.
    ///
    /// Waiting for the settled facts first, not merely the direct child's exit,
    /// is what lets a caller read `sp.outcome` immediately afterwards without
    /// racing the tasks that drain the child's pipes.
    async fn wait_for_exit(self: &Arc<Self>) {
        let mut settled = self.settled.subscribe();
        if settled.borrow().is_none() {
            let _ = settled.wait_for(|value| value.is_some()).await;
        }
        while group_alive(self.pid) {
            tokio::time::sleep(GROUP_POLL).await;
        }
    }

    /// The settled exit facts, or `None` while the child has not closed.
    fn outcome(&self) -> Option<Outcome> {
        self.state
            .lock()
            .expect("process state poisoned")
            .settled
            .clone()
    }

    /// Kill the range and release the buffers; safe to call more than once.
    fn dispose(self: &Arc<Self>) {
        {
            let mut state = self.state.lock().expect("process state poisoned");
            if state.disposed {
                return;
            }
            state.disposed = true;
            if state.settled.is_none() {
                if group_alive(self.pid) {
                    signal_group(self.pid, libc::SIGKILL);
                }
                state.settled = Some(state.exit_facts.clone().unwrap_or_else(Outcome::unknown));
            }
        }
        self.settled.send_replace(self.outcome());
    }

    /// Retain one chunk for a collected window and, when the stream is piped,
    /// push it as a frame.
    fn capture(self: &Arc<Self>, which: Which, chunk: &[u8]) {
        let (buffer, piped) = match which {
            Which::Out => (self.stdout.as_ref(), self.pipe_stdout),
            Which::Err => (self.stderr.as_ref(), self.pipe_stderr),
            Which::Control => (None, self.pipe_control),
        };
        if let Some(buffer) = buffer {
            buffer.push(chunk);
        }
        if !piped {
            return;
        }
        {
            let state = self.state.lock().expect("process state poisoned");
            // Frames stop once the process settles, so the last flush is never
            // truncated and nothing arrives after the client has seen the exit.
            if state.disposed || state.abandoned || state.settled.is_some() {
                return;
            }
        }
        let sequence = self.sequence[which as usize].fetch_add(1, Ordering::Relaxed);
        let frame = json!({
            "procId": self.proc_id,
            "stream": which.name(),
            "seq": sequence,
            "data": base64::engine::general_purpose::STANDARD.encode(chunk),
        });
        if !self.outbound.try_notify(SP_PIPE_NOTIFICATION, &frame) {
            // A consumer that stopped draining must not grow the daemon's memory,
            // and it already sees the gap from the last `seq` it received.
            self.state.lock().expect("process state poisoned").abandoned = true;
            self.terminate();
        }
    }
}

/// Read one piped stream to end of file.
async fn read_stream<R: AsyncRead + Unpin>(
    managed: Arc<ManagedProcess>,
    which: Which,
    mut pipe: R,
) {
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        match pipe.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => managed.capture(which, &buffer[..read]),
        }
    }
    managed
        .readers_left
        .send_modify(|count| *count = count.saturating_sub(1));
}

/// Reap the direct child, then settle its facts once its pipes have drained.
async fn await_child(managed: Arc<ManagedProcess>, mut child: Child) {
    let facts = match child.wait().await {
        Ok(status) => outcome_of_status(status.into_raw()),
        Err(_) => Outcome::unknown(),
    };
    {
        let mut state = managed.state.lock().expect("process state poisoned");
        state.exit_facts = Some(facts);
    }

    // A survivor holding a collected pipe open would otherwise keep the child's
    // streams pending forever; the caller's grace bounds it.
    let mut readers = managed.readers_left.subscribe();
    if *readers.borrow() != 0 {
        let _ = tokio::time::timeout(
            Duration::from_millis(managed.grace_ms),
            readers.wait_for(|count| *count == 0),
        )
        .await;
    }
    let settled = {
        let mut state = managed.state.lock().expect("process state poisoned");
        if state.settled.is_none() {
            state.settled = Some(state.exit_facts.clone().unwrap_or_else(Outcome::unknown));
        }
        state.settled.clone()
    };
    managed.settled.send_replace(settled);
}

/// Open one connected socketpair for a child's control channel.
/// @returns the child end and the daemon end, both close-on-exec.
fn open_control_pair() -> Result<(RawFd, RawFd)> {
    let mut fds = [0 as RawFd; 2];
    let opened = unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) };
    if opened != 0 {
        return Err(Failure::new(
            "SP_SPAWN_FAILED",
            format!(
                "cannot create the control channel: {}",
                std::io::Error::last_os_error()
            ),
        ));
    }
    // Both ends start close-on-exec; the child keeps only a duplicate of fd 7.
    unsafe {
        libc::fcntl(fds[0], libc::F_SETFD, libc::FD_CLOEXEC);
        libc::fcntl(fds[1], libc::F_SETFD, libc::FD_CLOEXEC);
    }
    Ok((fds[0], fds[1]))
}

/// Publish the control channel at fd 7 in the forked child.
/// @param child_fd - the socketpair's child end.
/// @returns an error when the descriptor cannot be published.
fn inherit_control_fd(child_fd: RawFd) -> std::io::Result<()> {
    if child_fd != SUBPROCESS_CONTROL_FD {
        if unsafe { libc::dup2(child_fd, SUBPROCESS_CONTROL_FD) } < 0 {
            return Err(std::io::Error::last_os_error());
        }
        unsafe {
            libc::close(child_fd);
        }
    } else if unsafe { libc::fcntl(SUBPROCESS_CONTROL_FD, libc::F_SETFD, 0) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// Resolve one candidate path to a regular, executable, canonical file.
fn canonical_executable(candidate: &str) -> Result<String> {
    let unresolvable = |error: std::io::Error| {
        Failure::new(
            "SP_NOT_FOUND",
            format!("cannot resolve \"{candidate}\": {error}"),
        )
    };
    let canonical = std::fs::canonicalize(candidate).map_err(unresolvable)?;
    let info = std::fs::metadata(&canonical).map_err(unresolvable)?;
    if !info.is_file() {
        return Err(Failure::new(
            "SP_NOT_EXECUTABLE",
            format!("\"{candidate}\" is not a regular file"),
        ));
    }
    if info.permissions().mode() & 0o111 == 0 {
        return Err(Failure::new(
            "SP_NOT_EXECUTABLE",
            format!("\"{candidate}\" is not executable"),
        ));
    }
    Ok(canonical.to_string_lossy().into_owned())
}

/// The stdio disposition for stdin.
fn stdin_disposition(mode: &StdinMode) -> Stdio {
    match mode {
        StdinMode::Ignore => Stdio::null(),
        StdinMode::Pipe | StdinMode::Data(_) => Stdio::piped(),
    }
}

/// The stdio disposition and retained window for one output stream.
fn output_stream(mode: &OutputMode) -> (Stdio, Option<StreamBuffer>) {
    match mode {
        OutputMode::Inherit => (Stdio::inherit(), None),
        OutputMode::Pipe => (Stdio::piped(), None),
        OutputMode::Collect { max_bytes } => (Stdio::piped(), Some(StreamBuffer::new(*max_bytes))),
    }
}
