//! JSON-RPC connection handling for the daemon.
//!
//! One connection serves one socket. `node.hello` must be the first request on
//! that socket: a wrong protocol revision, a wrong token, or any other method
//! arriving first is answered with an error and the socket is closed. After a
//! successful handshake the connection serves the `fs.*`, `git.*`, `sp.*`, and
//! `term.*` methods of the plugin's `src/protocol.ts`.
//!
//! Requests are served concurrently, because one of them (`sp.waitForExit`) is
//! allowed to block for as long as the process runs while the same connection
//! keeps reading its output.
//!
//! @module dsh-remote-agent/server

use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::net::tcp::OwnedWriteHalf;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

use crate::failure::{Failure, INVALID_REQUEST};
use crate::fs::FsBackend;
use crate::git::GitBackend;
use crate::jsonrpc::read_message;
use crate::outbound::{Outbound, WriteCommand};
use crate::protocol::PROTOCOL_VERSION;
use crate::subprocess::SubprocessBackend;
use crate::terminal::TerminalBackend;
use crate::wire::{self, Backends};

/// Frames one connection may have queued before writers start waiting.
const WRITE_BACKLOG_FRAMES: usize = 1024;

/// What every connection on this daemon shares.
pub struct SharedBackends {
    /// The filesystem backend, bound to the daemon's root.
    pub fs: Arc<FsBackend>,
    /// The git backend, bound to the daemon's root.
    pub git: Arc<GitBackend>,
    /// The shared secret every handshake must present.
    pub token: String,
    /// Build identity reported in the handshake answer.
    pub agent_version: String,
}

/// Accept connections until the listener fails.
/// @param listener - the bound socket.
/// @param shared - the state every connection shares.
pub async fn serve(listener: TcpListener, shared: Arc<SharedBackends>) {
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let shared = shared.clone();
                tokio::spawn(async move { serve_connection(stream, shared).await });
            }
            Err(error) => {
                eprintln!("dsh-remote-agent: accept: {error}");
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }
    }
}

/// Serve one accepted socket until it closes.
async fn serve_connection(stream: TcpStream, shared: Arc<SharedBackends>) {
    let _ = stream.set_nodelay(true);
    let (read_half, write_half) = stream.into_split();
    let (sender, receiver) = mpsc::channel::<WriteCommand>(WRITE_BACKLOG_FRAMES);
    let writer = tokio::spawn(write_loop(write_half, receiver));
    let outbound = Outbound::new(sender);
    // Process and terminal state belongs to the connection that created it.
    let sp = Arc::new(SubprocessBackend::new(outbound.clone()));
    let term = Arc::new(TerminalBackend::new());
    let mut reader = BufReader::new(read_half);
    let mut greeted = false;

    loop {
        let message = match read_message(&mut reader).await {
            Ok(Some(message)) => message,
            Ok(None) | Err(_) => break,
        };
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        let Some(method) = message
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            continue;
        };
        let params = message.get("params").cloned().unwrap_or(Value::Null);

        if !greeted {
            let outcome = match handshake(&method, &params, &shared) {
                Ok(()) => {
                    greeted = true;
                    Ok(node_info(&shared))
                }
                Err(failure) => Err(failure),
            };
            if !outbound.respond(&id, outcome).await {
                break;
            }
            if !greeted {
                // The response is already queued ahead of the shutdown, so the
                // client reads why it was refused before the socket closes.
                break;
            }
            continue;
        }

        let backends = Backends {
            fs: shared.fs.clone(),
            git: shared.git.clone(),
            sp: sp.clone(),
            term: term.clone(),
        };
        let responder = outbound.clone();
        tokio::spawn(async move {
            let result = wire::dispatch(&method, &params, &backends).await;
            responder.respond(&id, result).await;
        });
    }

    // A connection owns the process ranges and terminals it started: once its
    // socket is gone they are killed and their buffers released.
    sp.close();
    term.close();
    outbound.shutdown().await;
    let _ = writer.await;
}

/// Validate the first request on a connection.
fn handshake(method: &str, params: &Value, shared: &SharedBackends) -> Result<(), Failure> {
    if method != "node.hello" {
        return Err(Failure {
            code: "FS_IO_ERROR",
            message: "node.hello must be the first request".to_string(),
            rpc_code: INVALID_REQUEST,
        });
    }
    let hello = wire::read_hello(params)?;
    if hello.protocol != PROTOCOL_VERSION {
        return Err(Failure {
            code: "FS_IO_ERROR",
            message: format!(
                "protocol {} is not supported; this daemon speaks {PROTOCOL_VERSION}",
                hello.protocol
            ),
            rpc_code: INVALID_REQUEST,
        });
    }
    if !token_matches(&shared.token, &hello.token) {
        return Err(Failure {
            code: "FS_IO_ERROR",
            message: "invalid token".to_string(),
            rpc_code: INVALID_REQUEST,
        });
    }
    Ok(())
}

/// Write queued frames in order until the connection asks to shut down.
async fn write_loop(mut half: OwnedWriteHalf, mut receiver: mpsc::Receiver<WriteCommand>) {
    while let Some(command) = receiver.recv().await {
        match command {
            WriteCommand::Frame(frame) => {
                if half.write_all(&frame).await.is_err() || half.flush().await.is_err() {
                    break;
                }
            }
            WriteCommand::Shutdown => break,
        }
    }
    let _ = half.flush().await;
    let _ = half.shutdown().await;
}

/// Compare the presented token with the configured one in constant time.
fn token_matches(expected: &str, presented: &str) -> bool {
    let left = expected.as_bytes();
    let right = presented.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

/// The daemon's identity and capabilities for one successful handshake.
fn node_info(shared: &SharedBackends) -> Value {
    json!({
        "protocol": PROTOCOL_VERSION,
        "agentVersion": shared.agent_version,
        "platform": platform_name(),
        "arch": arch_name(),
        "node": "rust",
        "homedir": home_directory(),
        "capability": { "pty": true, "spill": false, "ripgrep": Value::Null },
    })
}

/// The platform name the plugin's own vocabulary uses.
fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else {
        std::env::consts::OS
    }
}

/// The architecture name the plugin's own vocabulary uses.
fn arch_name() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}

/// The daemon user's home directory.
fn home_directory() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
}
