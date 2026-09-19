//! The terminal backend, against a real PTY.

mod common;

use base64::Engine;
use common::TempDir;
use dsh_remote_agent::protocol::{TerminalSignal, TerminalSpawnSpec};
use dsh_remote_agent::terminal::TerminalBackend;
use serde_json::Value;
use std::path::Path;
use std::time::{Duration, Instant};

/// An allocation request for one program.
fn spec(cwd: &Path, argv: &[&str]) -> TerminalSpawnSpec {
    TerminalSpawnSpec {
        argv: argv.iter().map(|value| value.to_string()).collect(),
        cwd: cwd.to_string_lossy().into_owned(),
        env: Vec::new(),
        rows: 24,
        cols: 80,
        grace_ms: 3_000,
    }
}

/// The id a spawn answered with.
fn term_id(result: Value) -> String {
    result["termId"].as_str().expect("termId").to_string()
}

/// Decode one terminal read's base64 payload.
fn payload(read: &Value) -> String {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(read["data"].as_str().expect("data"))
        .expect("base64");
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Read everything the terminal has produced so far.
fn read_all(term: &TerminalBackend, id: &str) -> String {
    payload(&term.read(id, 0).unwrap())
}

/// Poll until the accumulated output contains `needle`, or give up.
async fn output_contains(term: &TerminalBackend, id: &str, needle: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let output = read_all(term, id);
        if output.contains(needle) {
            return output;
        }
        if Instant::now() >= deadline {
            panic!("terminal never produced {needle:?}; saw {output:?}");
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[tokio::test]
async fn runs_a_program_on_a_pty_and_streams_its_output() {
    let fixture = TempDir::new("drw-term-run");
    let term = TerminalBackend::new();
    let id = term_id(term.spawn(spec(fixture.path(), &["/bin/sh"])).unwrap());

    term.write(&id, "printf hello-from-pty\n").await.unwrap();
    let output = output_contains(&term, &id, "hello-from-pty").await;
    // A terminal echoes what was typed, so the command line itself is visible.
    assert!(output.contains("printf hello-from-pty"));

    term.terminate(&id).await.unwrap();
    assert!(term.outcome(&id).unwrap().is_object());
}

#[tokio::test]
async fn reports_foreground_facts_and_refuses_to_kill_the_shell_itself() {
    let fixture = TempDir::new("drw-term-foreground");
    let term = TerminalBackend::new();
    let id = term_id(term.spawn(spec(fixture.path(), &["/bin/sh"])).unwrap());

    let foreground = term.inspect_foreground(&id).await.unwrap();
    if !foreground.is_null() {
        assert!(foreground["processGroupId"].as_i64().unwrap() > 0);
        assert!(foreground["inputWaiting"].is_boolean());
    }

    // The shell itself is the foreground group, so SIGKILL is refused; a
    // machine that cannot resolve the group fails for that reason instead.
    assert_eq!(
        term.signal_foreground(&id, TerminalSignal::Kill)
            .await
            .unwrap_err()
            .code,
        "SP_TERMINAL_FAILED"
    );
    term.terminate(&id).await.unwrap();
}

#[tokio::test]
async fn a_repeated_terminate_joins_the_same_teardown() {
    let fixture = TempDir::new("drw-term-terminate");
    let term = TerminalBackend::new();
    let id = term_id(term.spawn(spec(fixture.path(), &["/bin/sh"])).unwrap());

    term.terminate(&id).await.unwrap();
    term.terminate(&id).await.unwrap();
    assert!(term.outcome(&id).unwrap().is_object());
}

#[tokio::test]
async fn a_resize_reaches_the_kernel_window_size() {
    let fixture = TempDir::new("drw-term-resize");
    let term = TerminalBackend::new();
    let id = term_id(term.spawn(spec(fixture.path(), &["/bin/sh"])).unwrap());

    term.resize(&id, 120, 40).unwrap();
    // `stty size` reads the terminal's own window size, so its answer is the
    // kernel's, not this backend's bookkeeping.
    term.write(&id, "stty size\n").await.unwrap();
    output_contains(&term, &id, "40 120").await;

    term.terminate(&id).await.unwrap();
}

#[tokio::test]
async fn a_resize_of_an_unknown_terminal_is_reported() {
    let term = TerminalBackend::new();
    assert_eq!(
        term.resize("nope", 80, 24).unwrap_err().code,
        "SP_NO_SUCH_TERMINAL"
    );
}

#[tokio::test]
async fn refuses_a_program_that_does_not_exist() {
    let fixture = TempDir::new("drw-term-missing");
    let term = TerminalBackend::new();
    let failure = term
        .spawn(spec(fixture.path(), &["/no/such/program"]))
        .unwrap_err();
    assert_eq!(failure.code, "SP_TERMINAL_FAILED");
}

#[tokio::test]
async fn an_unknown_terminal_is_reported_rather_than_ignored() {
    let term = TerminalBackend::new();
    assert_eq!(
        term.read("nope", 0).unwrap_err().code,
        "SP_NO_SUCH_TERMINAL"
    );
    assert_eq!(
        term.write("nope", "x").await.unwrap_err().code,
        "SP_NO_SUCH_TERMINAL"
    );
    assert_eq!(
        term.outcome("nope").unwrap_err().code,
        "SP_NO_SUCH_TERMINAL"
    );
    assert_eq!(
        term.terminate("nope").await.unwrap_err().code,
        "SP_NO_SUCH_TERMINAL"
    );
    assert_eq!(
        term.inspect_foreground("nope").await.unwrap_err().code,
        "SP_NO_SUCH_TERMINAL"
    );
}

#[tokio::test]
async fn a_spawn_after_close_ends_the_terminal_instead_of_publishing_it() {
    let fixture = TempDir::new("drw-term-closed");
    let term = TerminalBackend::new();
    term.close();

    let result = term
        .spawn(spec(fixture.path(), &["/bin/sh", "-c", "sleep 30"]))
        .expect("a closed backend answers the spawn it already accepted");
    let id = term_id(result.clone());
    let pid = result["pid"].as_i64().expect("pid") as i32;
    assert_eq!(term.read(&id, 0).unwrap_err().code, "SP_NO_SUCH_TERMINAL");

    let deadline = Instant::now() + Duration::from_secs(5);
    while unsafe { libc::kill(pid, 0) } == 0 {
        assert!(Instant::now() < deadline, "the late terminal is still alive");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[tokio::test]
async fn refuses_a_program_or_argument_holding_a_nul() {
    let fixture = TempDir::new("drw-term-nul");
    let term = TerminalBackend::new();

    // The wire carries any string a caller sends, NUL included, and a spawn that
    // cannot build its C strings must fail rather than leave a pty allocated.
    for _ in 0..16 {
        let error = term
            .spawn(spec(fixture.path(), &["/bin/sh", "a\0b"]))
            .expect_err("a NUL in argv cannot start a program");
        assert_eq!(error.code, "SP_TERMINAL_FAILED");
    }
}
