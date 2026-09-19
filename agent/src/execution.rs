//! The process primitives both execution backends share.
//!
//! The subprocess and terminal backends start children the same way and report
//! their failures with the same vocabulary, so the bounded output window, the
//! scrubbed environment, and the working-directory check live here rather than
//! inside either backend.
//!
//! @module dsh-remote-agent/execution

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::failure::{Failure, Result};
use crate::protocol::{signal_name, Outcome};

/// Credential-shaped environment names, matching the subprocess seam's scrub.
const SENSITIVE_ENV_MARKERS: [&str; 4] = ["KEY", "PASSWORD", "SECRET", "TOKEN"];

/// The harness-reserved environment namespace, matched case-insensitively.
const DSH_ENV_PREFIX: &str = "DSH_";

/// Bounded in-memory tail of one collected stream.
///
/// Offsets are whole-stream byte coordinates, so a read consumes nothing and two
/// readers asking from the same offset see the same bytes. Callers that collect
/// terminal output use the same window with spilling disabled.
pub struct StreamBuffer {
    inner: Mutex<Window>,
}

/// The retained tail and the counters that place it in the whole stream.
struct Window {
    chunks: VecDeque<Vec<u8>>,
    retained: usize,
    dropped: u64,
    total: u64,
    max_bytes: usize,
}

impl StreamBuffer {
    /// Build a window retaining at most `max_bytes` of the stream's tail.
    /// @param max_bytes - the caller's in-memory cap.
    /// @returns the window.
    pub fn new(max_bytes: usize) -> Self {
        Self {
            inner: Mutex::new(Window {
                chunks: VecDeque::new(),
                retained: 0,
                dropped: 0,
                total: 0,
                max_bytes,
            }),
        }
    }

    /// Append captured bytes, keeping only the last `max_bytes` of them.
    /// @param chunk - the bytes one read produced.
    pub fn push(&self, chunk: &[u8]) {
        let mut window = self.inner.lock().expect("stream window poisoned");
        window.total += chunk.len() as u64;
        window.chunks.push_back(chunk.to_vec());
        window.retained += chunk.len();
        while window.retained > window.max_bytes {
            let Some(head_len) = window.chunks.front().map(Vec::len) else {
                break;
            };
            let excess = window.retained - window.max_bytes;
            if head_len <= excess {
                window.chunks.pop_front();
                window.retained -= head_len;
                window.dropped += head_len as u64;
            } else {
                if let Some(head) = window.chunks.front_mut() {
                    head.drain(..excess);
                }
                window.retained -= excess;
                window.dropped += excess as u64;
            }
        }
    }

    /// Read the retained window from a whole-stream offset.
    /// @param from_byte - the offset to read from.
    /// @returns the bytes from there, the resume offset, and whether the offset
    ///   had already been dropped from the window.
    pub fn read(&self, from_byte: u64) -> (Vec<u8>, u64, bool) {
        let window = self.inner.lock().expect("stream window poisoned");
        let lossy = from_byte < window.dropped;
        let skip = if lossy {
            0
        } else {
            (from_byte - window.dropped).min(window.retained as u64) as usize
        };
        let mut bytes = Vec::with_capacity(window.retained);
        for chunk in &window.chunks {
            bytes.extend_from_slice(chunk);
        }
        (bytes.split_off(skip), window.total, lossy)
    }
}

/// The environment a child starts from: the daemon's own, minus credential-shaped
/// names and every `DSH_*` name.
/// @returns the environment entries the caller may extend with its own overrides.
pub fn scrubbed_environment() -> Vec<(String, String)> {
    std::env::vars()
        .filter(|(key, _)| {
            let upper = key.to_uppercase();
            if upper.starts_with(DSH_ENV_PREFIX) {
                return false;
            }
            !SENSITIVE_ENV_MARKERS
                .iter()
                .any(|marker| upper.contains(marker))
        })
        .collect()
}

/// The canonical working directory a launch starts in, or the typed failure that
/// refuses it.
/// @param cwd - the caller's working directory.
/// @param code - the failure code the calling family uses.
/// @returns the realpath-normalized directory.
pub fn usable_directory(cwd: &str, code: &'static str) -> Result<PathBuf> {
    let requested = Path::new(cwd);
    if !requested.is_absolute() {
        return Err(Failure::new(
            code,
            format!("cannot start in \"{cwd}\": the working directory is not absolute"),
        ));
    }
    let info = std::fs::metadata(requested)
        .map_err(|error| Failure::new(code, format!("cannot start in \"{cwd}\": {error}")))?;
    if !info.is_dir() {
        return Err(Failure::new(
            code,
            format!("cannot start in \"{cwd}\": not a directory"),
        ));
    }
    std::fs::canonicalize(requested)
        .map_err(|error| Failure::new(code, format!("cannot start in \"{cwd}\": {error}")))
}

/// Whether any member of a process group is still alive.
/// @param pid - the group leader's process id.
/// @returns true when the group still exists.
pub fn group_alive(pid: i32) -> bool {
    if unsafe { libc::kill(-pid, 0) } == 0 {
        return true;
    }
    // EPERM means the group exists but is not ours to signal; anything other
    // than ESRCH is treated as alive rather than reporting a false exit.
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

/// Signal a whole process group, falling back to the leader.
/// @param pid - the group leader's process id.
/// @param signal - the signal number to deliver.
pub fn signal_group(pid: i32, signal: i32) {
    unsafe {
        if libc::kill(-pid, signal) != 0 {
            libc::kill(pid, signal);
        }
    }
}

/// The protocol's exit facts for one raw wait status.
/// @param status - the status `waitpid` reported.
/// @returns the outcome the wire reports for it.
pub fn outcome_of_status(status: i32) -> Outcome {
    if libc::WIFSIGNALED(status) {
        return Outcome {
            exit_code: None,
            signal: signal_name(libc::WTERMSIG(status)),
        };
    }
    Outcome {
        exit_code: Some(libc::WEXITSTATUS(status)),
        signal: None,
    }
}

/// Generate an identifier unique to this daemon process.
/// @param counter - the family's monotonic counter.
/// @returns the identifier.
pub fn unique_id(counter: &std::sync::atomic::AtomicU64) -> String {
    let sequence = counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    format!("{:x}-{:x}-{:x}", std::process::id(), nanos, sequence)
}
