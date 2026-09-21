//! The connection itself: framing, the handshake gate, and dispatch.

mod common;

use common::TempDir;
use dsh_remote_agent::fs::FsBackend;
use dsh_remote_agent::git::GitBackend;
use dsh_remote_agent::jsonrpc::encode;
use dsh_remote_agent::protocol::PROTOCOL_VERSION;
use dsh_remote_agent::server::{serve, SharedBackends};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// Start a daemon on a kernel-assigned port.
async fn start(root: &Path, token: &str) -> String {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    let shared = Arc::new(SharedBackends {
        fs: Arc::new(FsBackend::new(Some(root.to_path_buf()))),
        git: Arc::new(GitBackend::new(Some(root.to_path_buf()))),
        token: token.to_string(),
        agent_version: "test-build".to_string(),
    });
    tokio::spawn(serve(listener, shared));
    format!("127.0.0.1:{}", address.port())
}

/// Write one framed JSON-RPC message.
async fn send(stream: &mut TcpStream, message: &Value) {
    stream.write_all(&encode(message)).await.unwrap();
}

/// Read one framed JSON-RPC message.
async fn receive(stream: &mut TcpStream) -> Value {
    let mut headers = Vec::new();
    let mut byte = [0u8; 1];
    while !headers.ends_with(b"\r\n\r\n") {
        stream
            .read_exact(&mut byte)
            .await
            .expect("read a header byte");
        headers.push(byte[0]);
    }
    let text = String::from_utf8_lossy(&headers).into_owned();
    let length: usize = text
        .lines()
        .find_map(|line| line.strip_prefix("Content-Length: "))
        .expect("Content-Length header")
        .trim()
        .parse()
        .expect("a numeric length");
    let mut body = vec![0u8; length];
    stream.read_exact(&mut body).await.unwrap();
    serde_json::from_slice(&body).unwrap()
}

/// One client connection with request correlation.
struct Client {
    stream: TcpStream,
    next_id: i64,
}

impl Client {
    /// Connect to the daemon without handshaking.
    async fn connect(address: &str) -> Self {
        Self {
            stream: TcpStream::connect(address).await.unwrap(),
            next_id: 0,
        }
    }

    /// Send one request and read its answer.
    async fn request(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        send(
            &mut self.stream,
            &json!({ "jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params }),
        )
        .await;
        receive(&mut self.stream).await
    }

    /// Handshake with the given token and protocol.
    async fn hello(&mut self, token: &str, protocol: i64) -> Value {
        self.request(
            "node.hello",
            json!({ "protocol": protocol, "token": token }),
        )
        .await
    }
}

#[tokio::test]
async fn the_handshake_reports_the_build_identity_and_capabilities() {
    let fixture = TempDir::new("drw-server-hello");
    let address = start(fixture.path(), "secret").await;
    let mut client = Client::connect(&address).await;

    let answer = client.hello("secret", PROTOCOL_VERSION).await;
    let info = &answer["result"];
    assert_eq!(info["protocol"], PROTOCOL_VERSION);
    assert_eq!(info["agentVersion"], "test-build");
    assert_eq!(info["capability"]["pty"], true);
    assert_eq!(info["capability"]["spill"], false);
    assert!(info["capability"]["ripgrep"].is_null());
    assert!(info["homedir"].is_string());
}

#[tokio::test]
async fn a_wrong_token_is_refused_with_the_protocol_error_data() {
    let fixture = TempDir::new("drw-server-token");
    let address = start(fixture.path(), "secret").await;
    let mut client = Client::connect(&address).await;

    let answer = client.hello("wrong", PROTOCOL_VERSION).await;
    assert_eq!(answer["error"]["data"]["code"], "FS_IO_ERROR");
    assert_eq!(answer["error"]["message"], "invalid token");
}

#[tokio::test]
async fn any_method_before_the_handshake_is_refused() {
    let fixture = TempDir::new("drw-server-first");
    let address = start(fixture.path(), "secret").await;
    let mut client = Client::connect(&address).await;

    let answer = client.request("fs.stat", json!({ "path": "/tmp" })).await;
    assert_eq!(
        answer["error"]["message"],
        "node.hello must be the first request"
    );
}

#[tokio::test]
async fn a_protocol_mismatch_is_refused_rather_than_degraded() {
    let fixture = TempDir::new("drw-server-protocol");
    let address = start(fixture.path(), "secret").await;
    let mut client = Client::connect(&address).await;

    let answer = client.hello("secret", 99).await;
    assert_eq!(answer["error"]["data"]["code"], "FS_IO_ERROR");
    assert!(answer["error"]["message"]
        .as_str()
        .unwrap()
        .contains("protocol 99"));
}

#[tokio::test]
async fn an_unknown_method_and_bad_parameters_report_distinct_codes() {
    let fixture = TempDir::new("drw-server-errors");
    let address = start(fixture.path(), "secret").await;
    let mut client = Client::connect(&address).await;
    client.hello("secret", PROTOCOL_VERSION).await;

    let unknown = client.request("fs.nope", json!({})).await;
    assert_eq!(unknown["error"]["code"], -32601);
    assert_eq!(unknown["error"]["data"]["code"], "FS_IO_ERROR");

    let bad = client
        .request("fs.readTextChunk", json!({ "path": "/tmp" }))
        .await;
    assert_eq!(bad["error"]["code"], -32602);
    assert!(bad["error"]["message"].as_str().unwrap().contains("offset"));
}

#[tokio::test]
async fn serves_filesystem_requests_over_the_socket() {
    let fixture = TempDir::new("drw-server-fs");
    std::fs::write(fixture.join("note.txt"), "hello\n").unwrap();
    let address = start(fixture.path(), "secret").await;
    let mut client = Client::connect(&address).await;
    client.hello("secret", PROTOCOL_VERSION).await;

    let stat = client
        .request(
            "fs.stat",
            json!({ "path": fixture.join("note.txt").to_string_lossy() }),
        )
        .await;
    assert_eq!(stat["result"]["type"], "file");
    assert_eq!(stat["result"]["size"], 6);

    let read = client
        .request(
            "fs.readTextChunk",
            json!({ "path": fixture.join("note.txt").to_string_lossy(), "offset": 0, "length": 4096 }),
        )
        .await;
    assert_eq!(read["result"]["text"], "hello\n");
    assert_eq!(read["result"]["eof"], true);
}

#[tokio::test]
async fn runs_a_process_over_the_socket_while_the_connection_keeps_serving() {
    let fixture = TempDir::new("drw-server-spawn");
    let address = start(fixture.path(), "secret").await;
    let mut client = Client::connect(&address).await;
    client.hello("secret", PROTOCOL_VERSION).await;

    let spawned = client
        .request(
            "sp.spawn",
            json!({
                "argv": ["/bin/sh", "-c", "printf through-the-wire"],
                "cwd": fixture.path().to_string_lossy(),
                "stdin": "ignore",
                "stdout": { "maxBytes": 1 << 20 },
                "stderr": { "maxBytes": 1 << 20 },
                "graceMs": 2_000,
            }),
        )
        .await;
    let proc_id = spawned["result"]["procId"]
        .as_str()
        .expect("procId")
        .to_string();

    // `waitForExit` blocks on one request; the connection must still answer
    // the read that follows it.
    let waited = client
        .request("sp.waitForExit", json!({ "procId": proc_id }))
        .await;
    assert!(waited["result"].as_object().expect("an object").is_empty());

    let read = client
        .request(
            "sp.readOutput",
            json!({ "procId": proc_id, "stream": "stdout", "fromByte": 0 }),
        )
        .await;
    assert_eq!(read["result"]["nextOffset"], 16);
    let outcome = client
        .request("sp.outcome", json!({ "procId": proc_id }))
        .await;
    assert_eq!(outcome["result"]["exitCode"], 0);

    let unknown = client
        .request("sp.terminate", json!({ "procId": "gone" }))
        .await;
    assert_eq!(unknown["error"]["data"]["code"], "SP_NO_SUCH_PROCESS");
}
