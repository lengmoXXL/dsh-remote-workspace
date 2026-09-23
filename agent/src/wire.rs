//! The daemon's side of the wire contract.
//!
//! One method table maps a plugin method onto a backend call, and
//! the readers beside it turn unvalidated JSON into the parameters that table
//! passes on: a request whose shape does not match its method fails as
//! `InvalidParams` here, and a nested shape these readers hand on — `edit`'s
//! fields, which only the filesystem backend can judge — fails with the same
//! code where it is read.
//!
//! @module dsh-remote-agent/wire

use serde_json::{Map, Value};
use std::sync::Arc;

use crate::failure::{Failure, Result};
use crate::fs::FsBackend;
use crate::git::GitBackend;
use crate::protocol::{
    OutputMode, SpawnSpec, StdinMode, TerminalSignal, TerminalSpawnSpec, MAX_GRACE_MS,
};
use crate::subprocess::SubprocessBackend;
use crate::terminal::TerminalBackend;

/// The method implementations one connection dispatches to.
#[derive(Clone)]
pub struct Backends {
    /// The shared filesystem backend.
    pub fs: Arc<FsBackend>,
    /// The shared git backend.
    pub git: Arc<GitBackend>,
    /// The subprocesses this connection started.
    pub sp: Arc<SubprocessBackend>,
    /// The terminals this connection allocated.
    pub term: Arc<TerminalBackend>,
}

/// Route one authenticated request onto the backend.
/// @param method - the wire method name.
/// @param params - the request's parameters, unvalidated.
/// @param backends - the backends this connection serves.
/// @returns the method result.
pub async fn dispatch(method: &str, params: &Value, backends: &Backends) -> Result<Value> {
    match method {
        "fs.resolve" => {
            let source = as_record(params, method)?;
            backends.fs.resolve(require_string(source, "path", method)?)
        }
        "fs.stat" => {
            let source = as_record(params, method)?;
            backends.fs.stat(require_string(source, "path", method)?)
        }
        "fs.lstat" => {
            let source = as_record(params, method)?;
            backends.fs.lstat(require_string(source, "path", method)?)
        }
        "fs.listDir" => {
            let source = as_record(params, method)?;
            backends
                .fs
                .list_dir(require_string(source, "path", method)?)
        }
        "fs.readTextChunk" => {
            let source = as_record(params, method)?;
            backends.fs.read_text_chunk(
                require_string(source, "path", method)?,
                require_integer(source, "offset", method, 0)?,
                require_integer(source, "length", method, 1)?,
            )
        }
        "fs.readBytes" => {
            let source = as_record(params, method)?;
            backends.fs.read_bytes(
                require_string(source, "path", method)?,
                require_integer(source, "maxBytes", method, 0)?,
            )
        }
        "fs.readByteRange" => {
            let source = as_record(params, method)?;
            backends.fs.read_byte_range(
                require_string(source, "path", method)?,
                require_integer(source, "offset", method, 0)?,
                require_integer(source, "length", method, 0)?,
            )
        }
        "fs.writeText" => {
            let source = as_record(params, method)?;
            backends.fs.write_text(
                require_string(source, "path", method)?,
                require_string(source, "content", method)?,
                source.get("expected"),
            )
        }
        "fs.editText" => {
            let source = as_record(params, method)?;
            backends.fs.edit_text(
                require_string(source, "path", method)?,
                source
                    .get("edit")
                    .filter(|value| value.is_object())
                    .ok_or_else(|| {
                        Failure::invalid_params(method, "\"edit\" must be a JSON object")
                    })?,
                read_expected_version(source, method)?,
            )
        }
        "git.worktreeAdd" => {
            let source = as_record(params, method)?;
            backends
                .git
                .worktree_add(
                    require_string(source, "repoPath", method)?,
                    require_string(source, "worktreePath", method)?,
                    require_string(source, "branch", method)?,
                    optional_string(source, "baseRef", method)?,
                )
                .await
        }
        "git.worktreeList" => {
            let source = as_record(params, method)?;
            backends
                .git
                .worktree_list(require_string(source, "repoPath", method)?)
                .await
        }
        "git.worktreeRemove" => {
            let source = as_record(params, method)?;
            backends
                .git
                .worktree_remove(
                    require_string(source, "repoPath", method)?,
                    require_string(source, "worktreePath", method)?,
                    require_boolean(source, "force", method)?,
                )
                .await
        }
        "git.branchDelete" => {
            let source = as_record(params, method)?;
            backends
                .git
                .branch_delete(
                    require_string(source, "repoPath", method)?,
                    require_string(source, "branch", method)?,
                    require_boolean(source, "force", method)?,
                )
                .await
        }
        "git.repoState" => {
            let source = as_record(params, method)?;
            backends
                .git
                .repo_state(require_string(source, "repoPath", method)?)
                .await
        }
        "git.mergeBranch" => {
            let source = as_record(params, method)?;
            backends
                .git
                .merge_branch(
                    require_string(source, "repoPath", method)?,
                    require_string(source, "branch", method)?,
                )
                .await
        }
        "sp.resolveExecutable" => {
            let source = as_record(params, method)?;
            backends.sp.resolve_executable(
                require_string(source, "command", method)?,
                &read_environment(source.get("env"), method)?,
            )
        }
        "sp.spawn" => backends.sp.spawn(read_spawn_spec(params, method)?).await,
        "sp.readOutput" => {
            let source = as_record(params, method)?;
            backends.sp.read_output(
                require_string(source, "procId", method)?,
                read_stream_name(source, method)?,
                require_integer(source, "fromByte", method, 0)?,
            )
        }
        "sp.writeStdin" => {
            let source = as_record(params, method)?;
            backends
                .sp
                .write_stdin(
                    require_string(source, "procId", method)?,
                    require_string(source, "data", method)?,
                )
                .await
        }
        "sp.writeControl" => {
            let source = as_record(params, method)?;
            backends
                .sp
                .write_control(
                    require_string(source, "procId", method)?,
                    require_string(source, "data", method)?,
                )
                .await
        }
        "sp.closeStdin" => {
            let source = as_record(params, method)?;
            backends
                .sp
                .close_stdin(require_string(source, "procId", method)?)
                .await
        }
        "sp.terminate" => {
            let source = as_record(params, method)?;
            backends
                .sp
                .terminate(require_string(source, "procId", method)?)
        }
        "sp.waitForExit" => {
            let source = as_record(params, method)?;
            backends
                .sp
                .wait_for_exit(require_string(source, "procId", method)?)
                .await
        }
        "sp.outcome" => {
            let source = as_record(params, method)?;
            backends
                .sp
                .outcome(require_string(source, "procId", method)?)
        }
        "term.spawn" => backends.term.spawn(read_terminal_spec(params, method)?),
        "term.read" => {
            let source = as_record(params, method)?;
            backends
                .term
                .read(
                    require_string(source, "termId", method)?,
                    require_integer(source, "fromByte", method, 0)?,
                    optional_integer(source, "waitMs", method, 0)?,
                )
                .await
        }
        "term.write" => {
            let source = as_record(params, method)?;
            backends
                .term
                .write(
                    require_string(source, "termId", method)?,
                    require_string(source, "data", method)?,
                )
                .await
        }
        "term.resize" => {
            let source = as_record(params, method)?;
            backends.term.resize(
                require_string(source, "termId", method)?,
                read_dimension(source, "cols", method)?,
                read_dimension(source, "rows", method)?,
            )
        }
        "term.inspectForeground" => {
            let source = as_record(params, method)?;
            backends
                .term
                .inspect_foreground(require_string(source, "termId", method)?)
                .await
        }
        "term.signalForeground" => {
            let source = as_record(params, method)?;
            backends
                .term
                .signal_foreground(
                    require_string(source, "termId", method)?,
                    read_terminal_signal(source, method)?,
                )
                .await
        }
        "term.terminate" => {
            let source = as_record(params, method)?;
            backends
                .term
                .terminate(require_string(source, "termId", method)?)
                .await
        }
        "term.outcome" => {
            let source = as_record(params, method)?;
            backends
                .term
                .outcome(require_string(source, "termId", method)?)
        }
        other => Err(Failure::method_not_found(other)),
    }
}

/// The handshake request, once its shape is validated.
pub struct Hello {
    /// The protocol revision the client speaks.
    pub protocol: i64,
    /// The shared secret the client presented.
    pub token: String,
}

/// Read and validate the handshake request.
/// @param params - the request's parameters.
/// @returns the parsed handshake.
pub fn read_hello(params: &Value) -> Result<Hello> {
    let method = "node.hello";
    let source = as_record(params, method)?;
    let protocol = source
        .get("protocol")
        .and_then(Value::as_i64)
        .ok_or_else(|| Failure::invalid_params(method, "\"protocol\" must be a safe integer"))?;
    Ok(Hello {
        protocol,
        token: require_string(source, "token", method)?.to_string(),
    })
}

/// Reject a parameter object that is not a JSON object.
fn as_record<'a>(params: &'a Value, method: &str) -> Result<&'a Map<String, Value>> {
    params
        .as_object()
        .ok_or_else(|| Failure::invalid_params(method, "params must be a JSON object"))
}

/// Read a required string member.
fn require_string<'a>(
    source: &'a Map<String, Value>,
    field: &str,
    method: &str,
) -> Result<&'a str> {
    source
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| Failure::invalid_params(method, format!("\"{field}\" must be a string")))
}

/// Read an optional string member.
fn optional_string<'a>(
    source: &'a Map<String, Value>,
    field: &str,
    method: &str,
) -> Result<Option<&'a str>> {
    match source.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value)),
        Some(_) => Err(Failure::invalid_params(
            method,
            format!("\"{field}\" must be a string"),
        )),
    }
}

/// Read a required safe integer member at or above `minimum`.
fn require_integer(
    source: &Map<String, Value>,
    field: &str,
    method: &str,
    minimum: u64,
) -> Result<u64> {
    source
        .get(field)
        .and_then(Value::as_u64)
        .filter(|value| *value >= minimum)
        .ok_or_else(|| {
            Failure::invalid_params(
                method,
                format!("\"{field}\" must be a safe integer no smaller than {minimum}"),
            )
        })
}

/// Read an optional integer member, or `default` when it is absent.
fn optional_integer(
    source: &Map<String, Value>,
    field: &str,
    method: &str,
    default: u64,
) -> Result<u64> {
    match source.get(field) {
        None | Some(Value::Null) => Ok(default),
        _ => require_integer(source, field, method, 0),
    }
}

/// Read a required boolean member.
fn require_boolean(source: &Map<String, Value>, field: &str, method: &str) -> Result<bool> {
    source
        .get(field)
        .and_then(Value::as_bool)
        .ok_or_else(|| Failure::invalid_params(method, format!("\"{field}\" must be a boolean")))
}

/// Read and validate the optional expected version of an edit.
fn read_expected_version<'a>(
    source: &'a Map<String, Value>,
    method: &str,
) -> Result<Option<&'a str>> {
    match source.get("expected") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let record = value.as_object().ok_or_else(|| {
                Failure::invalid_params(method, "\"expected\" must be a JSON object")
            })?;
            Ok(Some(require_string(record, "version", method)?))
        }
    }
}

/// Read and validate an optional environment overlay.
fn read_environment(value: Option<&Value>, method: &str) -> Result<Vec<(String, String)>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let source = value
        .as_object()
        .ok_or_else(|| Failure::invalid_params(method, "\"env\" must be a JSON object"))?;
    let mut environment = Vec::with_capacity(source.len());
    for (key, entry) in source {
        let text = entry.as_str().ok_or_else(|| {
            Failure::invalid_params(method, format!("\"env.{key}\" must be a string"))
        })?;
        environment.push((key.clone(), text.to_string()));
    }
    Ok(environment)
}

/// Read and validate one spawn request.
fn read_spawn_spec(params: &Value, method: &str) -> Result<SpawnSpec> {
    let source = as_record(params, method)?;
    let grace_ms = read_grace(source, method)?;
    Ok(SpawnSpec {
        argv: read_argv(source, method)?,
        cwd: require_string(source, "cwd", method)?.to_string(),
        stdin: read_stdin_mode(source.get("stdin"), method)?,
        stdout: read_output_mode(source.get("stdout"), "stdout", method)?,
        stderr: read_output_mode(source.get("stderr"), "stderr", method)?,
        control: read_control_mode(source.get("control"), method)?,
        grace_ms,
        env: read_environment(source.get("env"), method)?,
    })
}

/// Read and validate one terminal allocation request.
fn read_terminal_spec(params: &Value, method: &str) -> Result<TerminalSpawnSpec> {
    let source = as_record(params, method)?;
    Ok(TerminalSpawnSpec {
        argv: read_argv(source, method)?,
        cwd: require_string(source, "cwd", method)?.to_string(),
        env: read_environment(source.get("env"), method)?,
        rows: read_dimension(source, "rows", method)?,
        cols: read_dimension(source, "cols", method)?,
        grace_ms: read_grace(source, method)?,
    })
}

/// Read the required grace both spawn families carry.
fn read_grace(source: &Map<String, Value>, method: &str) -> Result<u64> {
    let grace_ms = require_integer(source, "graceMs", method, 1)?;
    if grace_ms > MAX_GRACE_MS {
        return Err(Failure::invalid_params(
            method,
            format!("\"graceMs\" must not exceed {MAX_GRACE_MS}"),
        ));
    }
    Ok(grace_ms)
}

/// Read one terminal dimension: a positive count a `winsize` can hold.
fn read_dimension(source: &Map<String, Value>, field: &str, method: &str) -> Result<u16> {
    Ok(require_integer(source, field, method, 1)?.min(u64::from(u16::MAX)) as u16)
}

/// Read a non-empty argv array.
fn read_argv(source: &Map<String, Value>, method: &str) -> Result<Vec<String>> {
    let complaint =
        || Failure::invalid_params(method, "\"argv\" must be a non-empty array of strings");
    let Some(values) = source.get("argv").and_then(Value::as_array) else {
        return Err(complaint());
    };
    if values.is_empty() {
        return Err(complaint());
    }
    values
        .iter()
        .map(|value| value.as_str().map(str::to_string).ok_or_else(complaint))
        .collect()
}

/// Read and validate a stdin disposition.
fn read_stdin_mode(value: Option<&Value>, method: &str) -> Result<StdinMode> {
    match value {
        Some(Value::String(mode)) if mode == "ignore" => Ok(StdinMode::Ignore),
        Some(Value::String(mode)) if mode == "pipe" => Ok(StdinMode::Pipe),
        Some(Value::Object(record)) => {
            let data = record.get("data").and_then(Value::as_str).ok_or_else(|| {
                Failure::invalid_params(
                    method,
                    "\"stdin\" must be \"ignore\", \"pipe\", or { data }",
                )
            })?;
            Ok(StdinMode::Data(data.as_bytes().to_vec()))
        }
        _ => Err(Failure::invalid_params(
            method,
            "\"stdin\" must be \"ignore\", \"pipe\", or { data }",
        )),
    }
}

/// Read and validate an optional control-channel request.
fn read_control_mode(value: Option<&Value>, method: &str) -> Result<bool> {
    match value {
        None | Some(Value::Null) => Ok(false),
        Some(Value::String(mode)) if mode == "pipe" => Ok(true),
        _ => Err(Failure::invalid_params(
            method,
            "\"control\" must be \"pipe\" when present",
        )),
    }
}

/// Read and validate an output disposition.
fn read_output_mode(value: Option<&Value>, field: &str, method: &str) -> Result<OutputMode> {
    let complaint = || {
        Failure::invalid_params(
            method,
            format!("\"{field}\" must be \"inherit\", \"pipe\", or {{ maxBytes }}"),
        )
    };
    match value {
        Some(Value::String(mode)) if mode == "inherit" => Ok(OutputMode::Inherit),
        Some(Value::String(mode)) if mode == "pipe" => Ok(OutputMode::Pipe),
        Some(Value::Object(record)) => {
            let max_bytes = record
                .get("maxBytes")
                .and_then(Value::as_u64)
                .ok_or_else(complaint)?;
            Ok(OutputMode::Collect {
                max_bytes: max_bytes as usize,
            })
        }
        _ => Err(complaint()),
    }
}

/// Read and validate a collected stream name.
fn read_stream_name<'a>(source: &'a Map<String, Value>, method: &str) -> Result<&'a str> {
    match source.get("stream").and_then(Value::as_str) {
        Some(value @ ("stdout" | "stderr")) => Ok(value),
        _ => Err(Failure::invalid_params(
            method,
            "\"stream\" must be \"stdout\" or \"stderr\"",
        )),
    }
}

/// Read and validate one terminal signal name.
fn read_terminal_signal(source: &Map<String, Value>, method: &str) -> Result<TerminalSignal> {
    match source.get("signal").and_then(Value::as_str) {
        Some("SIGINT") => Ok(TerminalSignal::Int),
        Some("SIGTERM") => Ok(TerminalSignal::Term),
        Some("SIGKILL") => Ok(TerminalSignal::Kill),
        Some("SIGTSTP") => Ok(TerminalSignal::Tstp),
        Some("SIGHUP") => Ok(TerminalSignal::Hup),
        _ => Err(Failure::invalid_params(
            method,
            "\"signal\" must be one of SIGINT, SIGTERM, SIGKILL, SIGTSTP, SIGHUP",
        )),
    }
}
