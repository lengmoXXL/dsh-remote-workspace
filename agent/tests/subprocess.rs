//! The subprocess backend, against real children.

mod common;

use base64::Engine;
use common::TempDir;
use dsh_remote_agent::outbound::{Outbound, WriteCommand};
use dsh_remote_agent::protocol::{OutputMode, SpawnSpec, StdinMode};
use dsh_remote_agent::subprocess::SubprocessBackend;
use serde_json::Value;
use std::path::Path;
use std::time::Duration;
use tokio::sync::mpsc;

/// A backend plus the connection channel it would push frames into.
fn backend() -> (SubprocessBackend, mpsc::Receiver<WriteCommand>) {
    let (sender, receiver) = mpsc::channel(256);
    (SubprocessBackend::new(Outbound::new(sender)), receiver)
}

/// A collect-everything spawn request.
fn spec(cwd: &Path, argv: &[&str]) -> SpawnSpec {
    SpawnSpec {
        argv: argv.iter().map(|value| value.to_string()).collect(),
        cwd: cwd.to_string_lossy().into_owned(),
        stdin: StdinMode::Ignore,
        stdout: OutputMode::Collect { max_bytes: 1 << 20 },
        stderr: OutputMode::Collect { max_bytes: 1 << 20 },
        grace_ms: 2_000,
        env: Vec::new(),
    }
}

/// The id a spawn answered with.
fn proc_id(result: Value) -> String {
    result["procId"].as_str().expect("procId").to_string()
}

/// Decode one collected read's base64 payload.
fn payload(read: &Value) -> String {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(read["data"].as_str().expect("data"))
        .expect("base64");
    String::from_utf8_lossy(&bytes).into_owned()
}

#[tokio::test]
async fn collects_both_streams_and_reports_the_exit_facts() {
    let fixture = TempDir::new("drw-sp-collect");
    let (sp, _frames) = backend();
    let id = proc_id(
        sp.spawn(spec(
            fixture.path(),
            &["/bin/sh", "-c", "printf out; printf err 1>&2; exit 3"],
        ))
        .await
        .unwrap(),
    );

    assert!(sp.wait_for_exit(&id).await.unwrap()["empty"]
        .as_bool()
        .unwrap());
    let outcome = sp.outcome(&id).unwrap();
    assert_eq!(outcome["exitCode"], 3);
    assert!(outcome["signal"].is_null());

    let stdout = sp.read_output(&id, "stdout", 0).unwrap();
    assert_eq!(payload(&stdout), "out");
    assert_eq!(stdout["nextOffset"], 3);
    let stderr = sp.read_output(&id, "stderr", 0).unwrap();
    assert_eq!(payload(&stderr), "err");
}

#[tokio::test]
async fn writes_batch_stdin_before_the_process_runs() {
    let fixture = TempDir::new("drw-sp-stdin");
    let (sp, _frames) = backend();
    let mut request = spec(fixture.path(), &["/bin/cat"]);
    request.stdin = StdinMode::Data(b"hello\n".to_vec());
    let id = proc_id(sp.spawn(request).await.unwrap());

    sp.wait_for_exit(&id).await.unwrap();
    assert_eq!(
        payload(&sp.read_output(&id, "stdout", 0).unwrap()),
        "hello\n"
    );
}

#[tokio::test]
async fn a_piped_stream_is_pushed_as_frames_and_cannot_be_collected() {
    let fixture = TempDir::new("drw-sp-pipe");
    let (sp, mut frames) = backend();
    let mut request = spec(fixture.path(), &["/bin/sh", "-c", "printf 'a\\nb\\n'"]);
    request.stdout = OutputMode::Pipe;
    let id = proc_id(sp.spawn(request).await.unwrap());
    sp.wait_for_exit(&id).await.unwrap();

    let mut piped = String::new();
    while let Ok(Some(command)) =
        tokio::time::timeout(Duration::from_millis(500), frames.recv()).await
    {
        let WriteCommand::Frame(frame) = command else {
            break;
        };
        // The writer is handed a fully framed message, header block included.
        let body = frame
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|start| &frame[start + 4..])
            .expect("a header block");
        let message: Value = serde_json::from_slice(body).unwrap();
        assert_eq!(message["method"], "sp.pipe");
        let params = &message["params"];
        assert_eq!(params["procId"], id.as_str());
        assert_eq!(params["stream"], "stdout");
        piped.push_str(&payload(params));
        if piped == "a\nb\n" {
            break;
        }
    }
    assert_eq!(piped, "a\nb\n");

    let failure = sp
        .read_output(&id, "stdout", 0)
        .expect_err("a piped stream has no window");
    assert_eq!(failure.code, "SP_UNSUPPORTED_STDIO");
}

#[tokio::test]
async fn an_unknown_process_is_reported_rather_than_ignored() {
    let (sp, _frames) = backend();
    assert_eq!(sp.outcome("nope").unwrap_err().code, "SP_NO_SUCH_PROCESS");
    assert_eq!(sp.terminate("nope").unwrap_err().code, "SP_NO_SUCH_PROCESS");
    assert_eq!(
        sp.read_output("nope", "stdout", 0).unwrap_err().code,
        "SP_NO_SUCH_PROCESS"
    );
}

#[tokio::test]
async fn resolves_an_absolute_path_and_searches_a_given_path() {
    let (sp, _frames) = backend();
    // Resolution realpaths its answer, so on a machine where `/bin` is a
    // symlink (Ubuntu) the canonical path is what comes back.
    let canonical_sh = std::fs::canonicalize("/bin/sh")
        .unwrap()
        .to_string_lossy()
        .into_owned();

    let absolute = sp.resolve_executable("/bin/sh", &[]).unwrap();
    assert_eq!(absolute["path"], canonical_sh);

    let searched = sp
        .resolve_executable("sh", &[("PATH".to_string(), "/bin:/usr/bin".to_string())])
        .unwrap();
    assert_eq!(searched["path"], canonical_sh);

    assert_eq!(
        sp.resolve_executable("sub/dir", &[])
            .unwrap_err()
            .code,
        "SP_NOT_EXECUTABLE"
    );
    assert_eq!(
        sp.resolve_executable("drw-no-such-program", &[])
            .unwrap_err()
            .code,
        "SP_NOT_FOUND"
    );
}

#[tokio::test]
async fn refuses_a_program_that_cannot_start_and_a_relative_directory() {
    let fixture = TempDir::new("drw-sp-fail");
    let (sp, _frames) = backend();
    assert_eq!(
        sp.spawn(spec(fixture.path(), &["/no/such/program"]))
            .await
            .unwrap_err()
            .code,
        "SP_SPAWN_FAILED"
    );
    let mut request = spec(fixture.path(), &["/bin/sh"]);
    request.cwd = "relative".to_string();
    assert_eq!(sp.spawn(request).await.unwrap_err().code, "SP_SPAWN_FAILED");
}

#[tokio::test]
async fn termination_signals_the_whole_range_and_settles_the_outcome() {
    let fixture = TempDir::new("drw-sp-terminate");
    let (sp, _frames) = backend();
    let id = proc_id(
        sp.spawn(spec(fixture.path(), &["/bin/sleep", "30"]))
            .await
            .unwrap(),
    );

    sp.terminate(&id).unwrap();
    sp.wait_for_exit(&id).await.unwrap();
    let outcome = sp.outcome(&id).unwrap();
    assert!(
        outcome["exitCode"].is_null(),
        "a signalled process reports no exit code"
    );
    assert_eq!(outcome["signal"], "SIGTERM");

    // A repeated termination is a no-op rather than an error.
    sp.terminate(&id).unwrap();
}

#[tokio::test]
async fn closing_releases_every_process_the_connection_started() {
    let fixture = TempDir::new("drw-sp-close");
    let (sp, _frames) = backend();
    let id = proc_id(
        sp.spawn(spec(fixture.path(), &["/bin/sleep", "30"]))
            .await
            .unwrap(),
    );
    sp.close();
    assert_eq!(
        sp.outcome(&id).unwrap_err().code,
        "SP_NO_SUCH_PROCESS",
        "closing drops the table with the processes"
    );
}
