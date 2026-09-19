//! Terminal operations behind the daemon's `term.*` wire methods.
//!
//! A PTY is allocated with `posix_openpt` and the child is `fork`ed into its own
//! session with the slave as its controlling terminal, so the daemon can address
//! the whole terminal session by process group: termination and foreground
//! signalling both work on the group the terminal driver published, not on the
//! shell alone. Output is kept as raw bytes and addressed by whole-stream byte
//! offset, exactly like `sp.readOutput`.
//!
//! One backend owns the terminals one connection allocated; `close` kills their
//! sessions and releases their buffers when that connection ends.
//!
//! @module dsh-remote-agent/terminal

use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::io::RawFd;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Mutex as AsyncMutex;

use crate::execution::{
    group_alive, scrubbed_environment, signal_group, unique_id, usable_directory, StreamBuffer,
};
use crate::failure::{Failure, Result};
use crate::protocol::{Outcome, TerminalSignal, TerminalSpawnSpec};

/// Bytes of terminal output the daemon retains for `term.read`.
const TERMINAL_WINDOW_BYTES: usize = 1 << 20;

/// Interval between session liveness checks while a terminal is terminated.
const SESSION_POLL: Duration = Duration::from_millis(25);

/// Terminal name the daemon publishes as `TERM`.
const TERMINAL_NAME: &str = "xterm-256color";

/// The terminal methods the daemon serves, one per `term.*` wire method.
pub struct TerminalBackend {
    terminals: Mutex<HashMap<String, Arc<ManagedTerminal>>>,
    /// Set once the owning connection closed, so a late spawn ends instead.
    closed: AtomicBool,
    counter: AtomicU64,
}

impl TerminalBackend {
    /// Build the terminal backend for one connection.
    /// @returns the backend owning the terminals this connection allocates.
    pub fn new() -> Self {
        Self {
            terminals: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(0),
            closed: AtomicBool::new(false),
        }
    }

    /// The terminal behind an id, or the typed failure.
    fn require(&self, term_id: &str) -> Result<Arc<ManagedTerminal>> {
        self.terminals
            .lock()
            .expect("terminal table poisoned")
            .get(term_id)
            .cloned()
            .ok_or_else(|| {
                Failure::new(
                    "SP_NO_SUCH_TERMINAL",
                    format!("no such terminal \"{term_id}\""),
                )
            })
    }

    /// Allocate a PTY and start a program on it.
    pub fn spawn(&self, spec: TerminalSpawnSpec) -> Result<Value> {
        let program = spec.argv.first().cloned().ok_or_else(|| {
            Failure::new(
                "SP_TERMINAL_FAILED",
                "cannot allocate a terminal: argv does not name a program",
            )
        })?;
        let cwd = usable_directory(&spec.cwd, "SP_TERMINAL_FAILED")?;
        let (master, pid) = spawn_on_pty(&program, &spec.argv[1..], &cwd, &spec)?;
        let terminal = Arc::new(ManagedTerminal {
            pid,
            grace_ms: spec.grace_ms,
            output: StreamBuffer::new(TERMINAL_WINDOW_BYTES),
            outcome: Mutex::new(None),
            master: Mutex::new(Some(master)),
            ladder: AsyncMutex::new(()),
        });
        let term_id = unique_id(&self.counter);
        start_watchers(&terminal, master);
        let published = terminal.clone();
        self.terminals
            .lock()
            .expect("terminal table poisoned")
            .insert(term_id.clone(), terminal);
        // A terminal allocated just before the connection closed lands here
        // after the table was drained; it is ended rather than left allocated.
        if self.closed.load(Ordering::SeqCst) {
            self.terminals
                .lock()
                .expect("terminal table poisoned")
                .remove(&term_id);
            published.dispose();
        }
        Ok(json!({ "termId": term_id, "pid": pid }))
    }

    /// Read retained terminal output from a whole-stream byte offset.
    pub fn read(&self, term_id: &str, from_byte: u64) -> Result<Value> {
        let (bytes, next_offset, lossy) = self.require(term_id)?.output.read(from_byte);
        Ok(json!({
            "data": base64::engine::general_purpose::STANDARD.encode(&bytes),
            "nextOffset": next_offset,
            "lossy": lossy,
        }))
    }

    pub async fn write(&self, term_id: &str, data: &str) -> Result<Value> {
        let terminal = self.require(term_id)?;
        let payload = data.as_bytes().to_vec();
        // A write can block once the session stops reading, so it must not hold a
        // runtime worker while it waits for the terminal to drain.
        tokio::task::spawn_blocking(move || terminal.write(&payload))
            .await
            .map_err(|error| {
                Failure::new(
                    "SP_TERMINAL_FAILED",
                    format!("terminal write failed: {error}"),
                )
            })??;
        Ok(json!({}))
    }

    /// Adopt a new size for one terminal's window.
    pub fn resize(&self, term_id: &str, cols: u16, rows: u16) -> Result<Value> {
        self.require(term_id)?.resize(cols, rows)?;
        Ok(json!({}))
    }

    pub async fn inspect_foreground(&self, term_id: &str) -> Result<Value> {
        let terminal = self.require(term_id)?;
        match foreground_group_id(terminal.pid).await {
            None => Ok(Value::Null),
            Some(group) => Ok(json!({
                "processGroupId": group,
                "inputWaiting": group_waits_on_input(group, terminal.pid).await,
            })),
        }
    }

    /// Deliver a signal to the current foreground process group.
    pub async fn signal_foreground(&self, term_id: &str, signal: TerminalSignal) -> Result<Value> {
        let terminal = self.require(term_id)?;
        let group = foreground_group_id(terminal.pid).await.ok_or_else(|| {
            Failure::new(
                "SP_TERMINAL_FAILED",
                format!(
                    "cannot resolve the foreground process group of terminal {}",
                    terminal.pid
                ),
            )
        })?;
        if signal == TerminalSignal::Kill && group == terminal.pid {
            return Err(Failure::new(
                "SP_TERMINAL_FAILED",
                "refusing to SIGKILL the terminal shell; terminate the terminal session instead",
            ));
        }
        signal_group(group, signal.number());
        Ok(json!({ "processGroupId": group }))
    }

    /// Terminate the whole terminal session.
    pub async fn terminate(&self, term_id: &str) -> Result<Value> {
        self.require(term_id)?.terminate().await?;
        Ok(json!({}))
    }

    /// Read the exit facts of the session's top-level process.
    pub fn outcome(&self, term_id: &str) -> Result<Value> {
        let terminal = self.require(term_id)?;
        let facts = terminal
            .outcome
            .lock()
            .expect("terminal outcome poisoned")
            .clone();
        Ok(Outcome::to_json(facts.as_ref()))
    }

    /// Kill every terminal session this connection allocated and release its buffers.
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let terminals: Vec<Arc<ManagedTerminal>> = self
            .terminals
            .lock()
            .expect("terminal table poisoned")
            .drain()
            .map(|(_, terminal)| terminal)
            .collect();
        for terminal in terminals {
            terminal.dispose();
        }
    }
}

impl Default for TerminalBackend {
    fn default() -> Self {
        Self::new()
    }
}

/// One allocated terminal: its retained output, exit facts, and teardown.
struct ManagedTerminal {
    pid: i32,
    grace_ms: u64,
    output: StreamBuffer,
    outcome: Mutex<Option<Outcome>>,
    /// The master descriptor, or `None` once the reader has released it.
    master: Mutex<Option<RawFd>>,
    /// Serializes teardown so a repeated `term.terminate` joins the same ladder.
    ladder: AsyncMutex<()>,
}

impl ManagedTerminal {
    /// The refusal for input or a resize that arrives after the session ended.
    fn exited(&self) -> Failure {
        Failure::new(
            "SP_TERMINAL_FAILED",
            format!("terminal {} has exited", self.pid),
        )
    }

    /// Deliver bytes to the terminal input.
    fn write(&self, data: &[u8]) -> Result<()> {
        if self
            .outcome
            .lock()
            .expect("terminal outcome poisoned")
            .is_some()
        {
            return Err(self.exited());
        }
        let guard = self.master.lock().expect("terminal master poisoned");
        let Some(fd) = *guard else {
            return Err(self.exited());
        };
        let mut written = 0;
        while written < data.len() {
            let count =
                unsafe { libc::write(fd, data[written..].as_ptr().cast(), data.len() - written) };
            if count <= 0 {
                return Err(Failure::new(
                    "SP_TERMINAL_FAILED",
                    format!(
                        "cannot write to terminal {}: {}",
                        self.pid,
                        std::io::Error::last_os_error()
                    ),
                ));
            }
            written += count as usize;
        }
        Ok(())
    }

    /// Adopt a new window size for this terminal.
    ///
    /// The size lives on the terminal itself, so it is set through the master
    /// descriptor. The kernel signals the foreground process group when the
    /// size actually changed, which is how a full-screen program redraws; a
    /// terminal whose size is already the requested one is left silent.
    fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        if self
            .outcome
            .lock()
            .expect("terminal outcome poisoned")
            .is_some()
        {
            return Err(self.exited());
        }
        let guard = self.master.lock().expect("terminal master poisoned");
        let Some(fd) = *guard else {
            return Err(self.exited());
        };
        let winsize = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        if unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &winsize) } != 0 {
            return Err(Failure::new(
                "SP_TERMINAL_FAILED",
                format!(
                    "cannot resize terminal {}: {}",
                    self.pid,
                    std::io::Error::last_os_error()
                ),
            ));
        }
        Ok(())
    }

    /// Run the TERM-to-KILL ladder once; later calls join the same teardown.
    async fn terminate(self: &Arc<Self>) -> Result<()> {
        let _guard = self.ladder.lock().await;
        signal_group(self.pid, libc::SIGTERM);
        if self.session_gone_within().await {
            return Ok(());
        }
        signal_group(self.pid, libc::SIGKILL);
        if self.session_gone_within().await {
            return Ok(());
        }
        Err(Failure::new(
            "SP_TERMINAL_FAILED",
            format!(
                "terminal {} still had session members after SIGKILL",
                self.pid
            ),
        ))
    }

    /// Kill the session; safe to call more than once.
    fn dispose(&self) {
        signal_group(self.pid, libc::SIGKILL);
    }

    /// Wait for the session to disappear, up to the allocation's grace.
    async fn session_gone_within(&self) -> bool {
        let deadline = Instant::now() + Duration::from_millis(self.grace_ms);
        loop {
            if !group_alive(self.pid) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(SESSION_POLL).await;
        }
    }
}

/// Start the output reader and the reaper for one freshly forked session.
fn start_watchers(terminal: &Arc<ManagedTerminal>, master: RawFd) {
    let reader = terminal.clone();
    std::thread::spawn(move || {
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let read = unsafe { libc::read(master, buffer.as_mut_ptr().cast(), buffer.len()) };
            if read <= 0 {
                break;
            }
            reader.output.push(&buffer[..read as usize]);
        }
        // The reader owns the descriptor's lifetime, so a close can never race a
        // write that already observed it.
        let mut guard = reader.master.lock().expect("terminal master poisoned");
        if let Some(fd) = guard.take() {
            unsafe { libc::close(fd) };
        }
    });
    let reaper = terminal.clone();
    std::thread::spawn(move || {
        let mut status: c_int = 0;
        loop {
            let waited = unsafe { libc::waitpid(reaper.pid, &mut status, 0) };
            if waited == reaper.pid {
                *reaper.outcome.lock().expect("terminal outcome poisoned") = Some(facts_of(status));
                return;
            }
            if waited < 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                // A session reaped elsewhere still ended; the exit facts are
                // simply unknown rather than the daemon hanging on it.
                *reaper.outcome.lock().expect("terminal outcome poisoned") = Some(Outcome {
                    exit_code: None,
                    signal: None,
                });
                return;
            }
        }
    });
}

/// Allocate a PTY and fork a child onto it.
/// @param program - the executable to run.
/// @param args - arguments after the executable.
/// @param cwd - the canonical working directory.
/// @param spec - row and column counts plus the environment overlay.
/// @returns the master descriptor and the session leader's pid.
fn spawn_on_pty(
    program: &str,
    args: &[String],
    cwd: &std::path::Path,
    spec: &TerminalSpawnSpec,
) -> Result<(RawFd, i32)> {
    let (master, slave_path) = open_pty().map_err(|error| {
        Failure::new(
            "SP_TERMINAL_FAILED",
            format!("cannot allocate a terminal for \"{program}\": {error}"),
        )
    })?;

    // Nothing owns the master descriptor yet, so every failure between here and
    // the fork closes it: a request carrying a NUL in its argv, environment, or
    // directory would otherwise leak a pty that stays allocated for good.
    fn failed(master: RawFd, error: Failure) -> Failure {
        unsafe { libc::close(master) };
        error
    }
    let (argv_owned, argv) = argv_pointers(program, args).map_err(|e| failed(master, e))?;
    let (env_owned, envp) = env_pointers(spec).map_err(|e| failed(master, e))?;
    let program_c = cstring(program).map_err(|e| failed(master, e))?;
    let cwd_c = CString::new(cwd.as_os_str().as_bytes()).map_err(|_| {
        let error = Failure::new(
            "SP_TERMINAL_FAILED",
            "cannot allocate a terminal: the working directory contains NUL",
        );
        failed(master, error)
    })?;

    let winsize = libc::winsize {
        ws_row: spec.rows,
        ws_col: spec.cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    unsafe { libc::ioctl(master, libc::TIOCSWINSZ, &winsize) };

    // The child reports a failed `execve` through this pipe; it closes on a
    // successful exec, so the parent reads either four errno bytes or EOF.
    let mut report = [0 as c_int; 2];
    if unsafe { libc::pipe(report.as_mut_ptr()) } != 0 {
        unsafe { libc::close(master) };
        return Err(Failure::new(
            "SP_TERMINAL_FAILED",
            format!(
                "cannot allocate a terminal for \"{program}\": {}",
                std::io::Error::last_os_error()
            ),
        ));
    }
    unsafe { libc::fcntl(report[1], libc::F_SETFD, libc::FD_CLOEXEC) };

    let pid = unsafe { libc::fork() };
    if pid < 0 {
        unsafe {
            libc::close(master);
            libc::close(report[0]);
            libc::close(report[1]);
        }
        return Err(Failure::new(
            "SP_TERMINAL_FAILED",
            format!(
                "cannot fork a terminal for \"{program}\": {}",
                std::io::Error::last_os_error()
            ),
        ));
    }
    if pid == 0 {
        // Child: only async-signal-safe calls between here and `execve`.
        unsafe {
            libc::close(master);
            libc::close(report[0]);
            if libc::setsid() < 0 {
                child_fail(report[1]);
            }
            let slave = libc::open(slave_path.as_ptr(), libc::O_RDWR);
            if slave < 0 {
                child_fail(report[1]);
            }
            // The request type is `Ioctl` on Linux (i32 on musl) and `c_ulong`
            // on macOS, so the cast follows whichever `ioctl` declares.
            libc::ioctl(slave, libc::TIOCSCTTY as _, 0);
            libc::dup2(slave, 0);
            libc::dup2(slave, 1);
            libc::dup2(slave, 2);
            if slave > 2 {
                libc::close(slave);
            }
            if libc::chdir(cwd_c.as_ptr()) != 0 {
                child_fail(report[1]);
            }
            libc::execve(program_c.as_ptr(), argv.as_ptr(), envp.as_ptr());
            child_fail(report[1]);
        }
    }

    unsafe { libc::close(report[1]) };
    let mut errno_bytes = [0u8; 4];
    let mut filled = 0usize;
    while filled < errno_bytes.len() {
        let read = unsafe {
            libc::read(
                report[0],
                errno_bytes[filled..].as_mut_ptr().cast(),
                errno_bytes.len() - filled,
            )
        };
        if read <= 0 {
            break;
        }
        filled += read as usize;
    }
    unsafe { libc::close(report[0]) };
    if filled == errno_bytes.len() {
        let code = c_int::from_ne_bytes(errno_bytes);
        let mut status: c_int = 0;
        unsafe { libc::waitpid(pid, &mut status, 0) };
        unsafe { libc::close(master) };
        return Err(Failure::new(
            "SP_TERMINAL_FAILED",
            format!(
                "cannot start \"{program}\" on a terminal: {}",
                std::io::Error::from_raw_os_error(code)
            ),
        ));
    }
    // The child shares these buffers until `execve`, so they must outlive the
    // fork above; they are released here, once the child no longer needs them.
    drop((argv_owned, env_owned));
    Ok((master, pid))
}

/// Report a failed setup step to the parent and stop the forked child.
/// @param report - the descriptor the parent is reading.
unsafe fn child_fail(report: c_int) -> ! {
    let code = std::io::Error::last_os_error()
        .raw_os_error()
        .unwrap_or(libc::EIO);
    let bytes = code.to_ne_bytes();
    libc::write(report, bytes.as_ptr().cast(), bytes.len());
    libc::_exit(127);
}

/// Wrap one spawn argument as a C string.
fn cstring(value: &str) -> Result<CString> {
    CString::new(value.as_bytes()).map_err(|_| {
        Failure::new(
            "SP_TERMINAL_FAILED",
            "cannot allocate a terminal: a value contains a NUL byte",
        )
    })
}

/// Build the NUL-terminated argv the child executes.
/// @returns the owned strings and their pointers.
fn argv_pointers(program: &str, args: &[String]) -> Result<(Vec<CString>, Vec<*const c_char>)> {
    let mut owned = Vec::with_capacity(args.len() + 1);
    owned.push(cstring(program)?);
    for argument in args {
        owned.push(cstring(argument)?);
    }
    Ok(nul_terminated(owned))
}

/// Point at each owned string and close the list with a null.
///
/// The pointers borrow the strings they came from, so the pair has to stay
/// alive together until the child has `execve`d.
fn nul_terminated(owned: Vec<CString>) -> (Vec<CString>, Vec<*const c_char>) {
    let mut pointers: Vec<*const c_char> = owned.iter().map(|value| value.as_ptr()).collect();
    pointers.push(std::ptr::null());
    (owned, pointers)
}

/// Build the NUL-terminated environment the child executes with.
/// @returns the owned strings and their pointers.
fn env_pointers(spec: &TerminalSpawnSpec) -> Result<(Vec<CString>, Vec<*const c_char>)> {
    let mut entries = scrubbed_environment();
    for (key, value) in &spec.env {
        entries.retain(|(existing, _)| existing != key);
        entries.push((key.clone(), value.clone()));
    }
    // `node-pty` sets TERM from the terminal name, so the allocation wins over
    // anything the caller layered in.
    entries.retain(|(key, _)| key != "TERM");
    entries.push(("TERM".to_string(), TERMINAL_NAME.to_string()));

    let mut owned = Vec::with_capacity(entries.len());
    for (key, value) in entries {
        owned.push(cstring(&format!("{key}={value}"))?);
    }
    Ok(nul_terminated(owned))
}

/// Open a PTY master and resolve its slave path.
fn open_pty() -> std::io::Result<(RawFd, CString)> {
    let master = unsafe { libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY) };
    if master < 0 {
        return Err(std::io::Error::last_os_error());
    }
    if unsafe { libc::grantpt(master) } != 0 || unsafe { libc::unlockpt(master) } != 0 {
        let error = std::io::Error::last_os_error();
        unsafe { libc::close(master) };
        return Err(error);
    }
    match pty_slave_name(master) {
        Ok(name) => Ok((master, name)),
        Err(error) => {
            unsafe { libc::close(master) };
            Err(error)
        }
    }
}

/// The slave device path of one PTY master.
#[cfg(target_os = "linux")]
fn pty_slave_name(master: RawFd) -> std::io::Result<CString> {
    let mut buffer = [0 as c_char; 256];
    let result = unsafe { libc::ptsname_r(master, buffer.as_mut_ptr(), buffer.len()) };
    if result != 0 {
        return Err(std::io::Error::from_raw_os_error(result));
    }
    Ok(unsafe { CStr::from_ptr(buffer.as_ptr()) }.to_owned())
}

/// The slave device path of one PTY master.
#[cfg(target_os = "macos")]
fn pty_slave_name(master: RawFd) -> std::io::Result<CString> {
    // `ptsname` keeps its result in a shared buffer, so concurrent allocations
    // must not interleave.
    static PTS_NAME_LOCK: Mutex<()> = Mutex::new(());
    let _guard = PTS_NAME_LOCK.lock().expect("ptsname lock poisoned");
    let pointer = unsafe { libc::ptsname(master) };
    if pointer.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { CStr::from_ptr(pointer) }.to_owned())
}

/// The protocol's exit facts for one raw wait status.
fn facts_of(status: c_int) -> Outcome {
    if libc::WIFSIGNALED(status) {
        return Outcome {
            exit_code: None,
            signal: crate::protocol::signal_name(libc::WTERMSIG(status)),
        };
    }
    Outcome {
        exit_code: Some(libc::WEXITSTATUS(status)),
        signal: None,
    }
}

/// The foreground process-group id of one terminal, or `None` when none resolves.
#[cfg(target_os = "linux")]
async fn foreground_group_id(shell_pid: i32) -> Option<i32> {
    proc_stat(shell_pid).and_then(|fields| {
        if fields.tpgid > 0 {
            Some(fields.tpgid)
        } else {
            None
        }
    })
}

/// The foreground process-group id of one terminal, or `None` when none resolves.
#[cfg(target_os = "macos")]
async fn foreground_group_id(shell_pid: i32) -> Option<i32> {
    // A process that exited between inspection steps has no foreground group.
    let output = tokio::process::Command::new("/bin/ps")
        .args(["-o", "tpgid=", "-p", &shell_pid.to_string()])
        .output()
        .await
        .ok()?;
    let value = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<i32>()
        .ok()?;
    (value > 0).then_some(value)
}

/// The `/proc/<pid>/stat` fields this module needs.
#[cfg(target_os = "linux")]
struct ProcStat {
    process_group: i32,
    tty_device: i64,
    tpgid: i32,
}

/// Read one process's `/proc/<pid>/stat` fields.
#[cfg(target_os = "linux")]
fn proc_stat(pid: i32) -> Option<ProcStat> {
    // The command name between the first parentheses can contain spaces and
    // parentheses, so the numeric fields are read from after the last `)`.
    let raw = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let close = raw.rfind(')')?;
    let fields: Vec<&str> = raw[close + 2..].split(' ').collect();
    Some(ProcStat {
        process_group: fields.get(2)?.parse().ok()?,
        tty_device: fields.get(4)?.parse().ok()?,
        tpgid: fields.get(5)?.parse().ok()?,
    })
}

/// Whether the daemon can prove the foreground group waits on terminal input.
#[cfg(target_os = "linux")]
async fn group_waits_on_input(process_group_id: i32, shell_pid: i32) -> bool {
    let Some(leader) = proc_stat(shell_pid) else {
        return false;
    };
    if leader.tty_device <= 0 {
        return false;
    }
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return false;
    };
    for entry in entries.flatten() {
        let Some(pid) = entry.file_name().to_string_lossy().parse::<i32>().ok() else {
            continue;
        };
        let Some(member) = proc_stat(pid) else {
            continue;
        };
        if member.process_group != process_group_id || member.tty_device != leader.tty_device {
            continue;
        }
        // Only a member sleeping in the tty line discipline's read is evidence
        // that the group is waiting on this terminal.
        if std::fs::read_to_string(format!("/proc/{pid}/wchan"))
            .is_ok_and(|channel| channel.contains("n_tty_read"))
        {
            return true;
        }
    }
    false
}

/// Only Linux exposes the evidence this build can read.
#[cfg(not(target_os = "linux"))]
async fn group_waits_on_input(process_group_id: i32, shell_pid: i32) -> bool {
    let _ = (process_group_id, shell_pid);
    false
}
