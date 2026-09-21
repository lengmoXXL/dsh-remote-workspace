//! The parameter and result shapes of the wire contract.
//!
//! These mirror the plugin's `src/protocol.ts`, which is the same contract
//! written for the TypeScript half; the two are maintained by hand, so a
//! change on one side is a change on the other. The plugin's e2e suite calls
//! every method against this binary, which is what makes a hand-maintained
//! copy safe.
//! Only the shapes a backend needs as typed Rust values live here; everything
//! else travels as `serde_json::Value`.
//!
//! @module dsh-remote-agent/protocol

/// Protocol revision; a mismatch is refused at the handshake.
pub const PROTOCOL_VERSION: i64 = 2;

/// The notification a daemon pushes for every chunk of a `'pipe'` stream.
pub const SP_PIPE_NOTIFICATION: &str = "sp.pipe";

/// Largest grace a spawn may request, matching the largest delay the plugin's
/// own timers accept.
pub const MAX_GRACE_MS: u64 = 2_147_483_647;

/// One stdin disposition, mirroring the subprocess seam.
#[derive(Debug, Clone)]
pub enum StdinMode {
    /// The child inherits nothing and reads end-of-file immediately.
    Ignore,
    /// The client writes to a live pipe.
    Pipe,
    /// The child starts with this complete input already written.
    Data(Vec<u8>),
}

/// One stdout/stderr disposition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OutputMode {
    /// The child writes to the daemon's own stream.
    Inherit,
    /// Every byte is pushed as a `sp.pipe` notification.
    Pipe,
    /// The last `max_bytes` are retained for `sp.readOutput`.
    Collect { max_bytes: usize },
}

/// A fully specified spawn request; this seam applies no defaults.
#[derive(Debug, Clone)]
pub struct SpawnSpec {
    /// Executable and arguments; never shell-interpreted.
    pub argv: Vec<String>,
    /// Absolute working directory.
    pub cwd: String,
    /// stdin disposition.
    pub stdin: StdinMode,
    /// stdout disposition.
    pub stdout: OutputMode,
    /// stderr disposition.
    pub stderr: OutputMode,
    /// Whether the child gets an inherited bidirectional control channel.
    pub control: bool,
    /// Grace the termination ladder may spend before killing.
    pub grace_ms: u64,
    /// Explicit environment entries layered over the daemon's scrubbed base.
    pub env: Vec<(String, String)>,
}

/// A fully specified terminal allocation.
#[derive(Debug, Clone)]
pub struct TerminalSpawnSpec {
    /// Executable and arguments; never shell-interpreted.
    pub argv: Vec<String>,
    /// Absolute working directory.
    pub cwd: String,
    /// Explicit environment entries layered over the daemon's scrubbed base.
    pub env: Vec<(String, String)>,
    /// Initial terminal row count.
    pub rows: u16,
    /// Initial terminal column count.
    pub cols: u16,
    /// TERM-to-KILL cleanup grace for the complete terminal session.
    pub grace_ms: u64,
}

/// Signals the terminal primitive may deliver to a foreground group.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalSignal {
    /// Interrupt.
    Int,
    /// Polite termination.
    Term,
    /// Unconditional kill.
    Kill,
    /// Stop for later resumption.
    Tstp,
    /// Hangup.
    Hup,
}

impl TerminalSignal {
    /// The libc signal number this variant delivers.
    /// @returns the signal number.
    pub fn number(self) -> i32 {
        match self {
            TerminalSignal::Int => libc::SIGINT,
            TerminalSignal::Term => libc::SIGTERM,
            TerminalSignal::Kill => libc::SIGKILL,
            TerminalSignal::Tstp => libc::SIGTSTP,
            TerminalSignal::Hup => libc::SIGHUP,
        }
    }
}

/// Exit facts of one closed process.
#[derive(Debug, Clone)]
pub struct Outcome {
    /// Exit code; absent when the process died from a signal.
    pub exit_code: Option<i32>,
    /// Terminating signal name; absent on a normal exit.
    pub signal: Option<String>,
}

impl Outcome {
    /// The facts of a process whose exit was never observed.
    pub fn unknown() -> Self {
        Self {
            exit_code: None,
            signal: None,
        }
    }

    /// Render the outcome as the wire result, or `null` while it is unknown.
    /// @param outcome - the settled facts, if any.
    /// @returns the JSON value `sp.outcome` and `term.outcome` answer with.
    pub fn to_json(outcome: Option<&Outcome>) -> serde_json::Value {
        match outcome {
            None => serde_json::Value::Null,
            Some(facts) => serde_json::json!({
                "exitCode": facts.exit_code,
                "signal": facts.signal,
            }),
        }
    }
}

/// The name of a terminating signal number, or `None` when unrecognised.
/// @param number - the signal number a wait status carried.
/// @returns the name, or `None`.
pub fn signal_name(number: i32) -> Option<String> {
    let name = match number {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGILL => "SIGILL",
        libc::SIGTRAP => "SIGTRAP",
        libc::SIGABRT => "SIGABRT",
        libc::SIGBUS => "SIGBUS",
        libc::SIGFPE => "SIGFPE",
        libc::SIGKILL => "SIGKILL",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGALRM => "SIGALRM",
        libc::SIGTERM => "SIGTERM",
        libc::SIGCHLD => "SIGCHLD",
        libc::SIGCONT => "SIGCONT",
        libc::SIGSTOP => "SIGSTOP",
        libc::SIGTSTP => "SIGTSTP",
        libc::SIGTTIN => "SIGTTIN",
        libc::SIGTTOU => "SIGTTOU",
        libc::SIGURG => "SIGURG",
        libc::SIGXCPU => "SIGXCPU",
        libc::SIGXFSZ => "SIGXFSZ",
        libc::SIGVTALRM => "SIGVTALRM",
        libc::SIGPROF => "SIGPROF",
        libc::SIGWINCH => "SIGWINCH",
        libc::SIGSYS => "SIGSYS",
        _ => return None,
    };
    Some(name.to_string())
}
