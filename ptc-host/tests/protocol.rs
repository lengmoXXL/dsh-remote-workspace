//! The process protocol, end to end.
//!
//! A stand-in for the DeepSeek Harness PTC host drives the built binary over a
//! real socketpair on descriptor 7: it sends the boot payload, answers binding
//! calls, and asserts the frames and terminal message the worker produces. No
//! Node and no Cordis mount are involved, which is what keeps this runnable in
//! the crate's own CI job.

use std::io::Read;
use std::io::Write;
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;

use serde_json::json;
use serde_json::Value;

/// The frame limit the test hands the worker, matching the protocol's own.
const MAX_FRAME: usize = 8 * 1024 * 1024;

/// How long a test waits for the next frame before failing.
const READ_TIMEOUT_MS: libc::c_int = 20_000;

/// A spawned worker and the host end of its control channel.
struct Worker {
    child: Child,
    control: UnixStream,
    frames: Vec<String>,
    logs: Vec<String>,
}

impl Worker {
    /// Spawn the built worker with the control socketpair on descriptor 7.
    fn start() -> Self {
        let (host_end, child_end) = UnixStream::pair().expect("a control socketpair");
        let child_fd = child_end.as_raw_fd();
        let mut command = Command::new(env!("CARGO_BIN_EXE_dsh-ptc-host"));
        command
            .arg("--max-old-space-size=64")
            .arg(MAX_FRAME.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        // SAFETY: dup2 is async-signal-safe and the descriptor is this
        // process's own socket end.
        unsafe {
            command.pre_exec(move || {
                if libc::dup2(child_fd, 7) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn().expect("dsh-ptc-host starts");
        // The host end is what carries the parent's reads and writes; the child
        // end must not stay open here or a closed worker would never read as EOF.
        drop(child_end);
        Self {
            child,
            control: host_end,
            frames: Vec::new(),
            logs: Vec::new(),
        }
    }

    /// Write one length-framed JSON message.
    fn send(&mut self, message: &Value) {
        let body = serde_json::to_vec(message).expect("a JSON frame");
        let mut frame = Vec::with_capacity(body.len() + 4);
        frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
        frame.extend_from_slice(&body);
        self.control.write_all(&frame).expect("a written frame");
    }

    /// Fail the test rather than hang when the worker sends nothing.
    fn wait_readable(&self) {
        let mut descriptor = libc::pollfd {
            fd: self.control.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: poll reads and writes only this stack descriptor.
        let ready = unsafe { libc::poll(&mut descriptor, 1, READ_TIMEOUT_MS) };
        assert_eq!(
            ready, 1,
            "the worker sent no frame within {READ_TIMEOUT_MS}ms after {:?}",
            self.frames
        );
    }

    /// Read one length-framed JSON message.
    fn receive(&mut self) -> Value {
        self.wait_readable();
        let mut header = [0u8; 4];
        self.control
            .read_exact(&mut header)
            .expect("a frame header");
        let length = u32::from_be_bytes(header) as usize;
        let mut body = vec![0u8; length];
        self.control.read_exact(&mut body).expect("a frame body");
        let message: Value = serde_json::from_slice(&body).expect("a JSON frame");
        let kind = message["type"].as_str().expect("a frame type").to_string();
        if kind == "log" {
            let text = message["text"].as_str().expect("log text").to_string();
            self.logs.push(text);
        }
        self.frames.push(kind);
        message
    }

    /// Wait for the worker to exit on its own, reporting the code it chose.
    fn wait_for_exit(&mut self, timeout: Duration) -> Option<i32> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            match self.child.try_wait().expect("a waitable child") {
                Some(status) => return status.code(),
                None => std::thread::sleep(Duration::from_millis(10)),
            }
        }
        None
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Run one program to its terminal message, answering binding calls as told.
fn execute(
    code: &str,
    namespaces: Value,
    max_output_bytes: u64,
    answer: impl Fn(&Value) -> Value,
) -> (Vec<String>, Vec<String>, Value) {
    let mut worker = Worker::start();
    let ready = worker.receive();
    assert_eq!(ready["type"], "ready");
    worker.send(&json!({
        "type": "boot",
        "data": {
            "code": code,
            "namespaces": namespaces,
            "maxOutputBytes": max_output_bytes,
        },
    }));
    loop {
        let message = worker.receive();
        match message["type"].as_str().expect("a frame type") {
            "call" => {
                let mut reply = answer(&message);
                reply["type"] = json!("reply");
                reply["id"] = message["id"].clone();
                worker.send(&reply);
            }
            "done" => return (worker.frames.clone(), worker.logs.clone(), message),
            _ => {}
        }
    }
}

/// A namespace declaration with no error class.
fn namespace(global: &str, names: &[&str]) -> Value {
    json!([{ "global": global, "names": names }])
}

#[test]
fn returns_a_value() {
    let (_, _, done) = execute(
        "return 1 + 1",
        json!([]),
        1 << 20,
        |_| json!({ "ok": true }),
    );
    assert_eq!(done["value"], json!([2]));
    assert!(done.get("error").is_none());
}

#[test]
fn captures_console_output() {
    let (_, logs, done) = execute(
        "console.log(\"hi\", {a: 1, b: [1, 2]})",
        json!([]),
        1 << 20,
        |_| json!({ "ok": true }),
    );
    assert_eq!(logs, vec!["hi { a: 1, b: [ 1, 2 ] }"]);
    assert!(done.get("value").is_none());
}

#[test]
fn bridges_binding_calls() {
    let (frames, _, done) = execute(
        "return await tools.add({a: 1, b: 2})",
        namespace("tools", &["add"]),
        1 << 20,
        |call| {
            // The flat wire is a pre-order token stream: the object marker
            // first, then its values in key order.
            assert_eq!(call["args"][0]["kind"], "object");
            let sum = call["args"][1].as_i64().unwrap() + call["args"][2].as_i64().unwrap();
            json!({ "ok": true, "value": [sum] })
        },
    );
    assert_eq!(frames, vec!["ready", "call", "done"]);
    assert_eq!(done["value"], json!([3]));
}

#[test]
fn numbers_binding_calls_in_order() {
    let (_, _, done) = execute(
        "return await Promise.all([tools.echo(1), tools.echo(2), tools.echo(3)])",
        namespace("tools", &["echo"]),
        1 << 20,
        |call| json!({ "ok": true, "value": call["args"] }),
    );
    // Each answer is the flat wire for one number, so unflattening yields the
    // number itself and the completed array is three plain values.
    assert_eq!(
        done["value"],
        json!([{ "kind": "array", "length": 3 }, 1, 2, 3])
    );
}

#[test]
fn rejects_with_the_declared_error_class() {
    let (_, _, done) = execute(
        "try { await tools.fail({}); return 'no throw' } catch (e) { return [e instanceof ToolCallError, e.name, e.memberName, e.message] }",
        json!([{
            "global": "tools",
            "names": ["fail"],
            "errorClass": { "name": "ToolCallError", "memberNameProperty": "memberName" },
        }]),
        1 << 20,
        |_| json!({ "ok": false, "message": "remote refused" }),
    );
    assert_eq!(
        done["value"],
        json!([{ "kind": "array", "length": 4 }, true, "ToolCallError", "fail", "remote refused"]),
    );
}

#[test]
fn reports_a_thrown_program_as_an_exception() {
    let (_, _, done) = execute(
        "throw new Error(\"boom\")",
        json!([]),
        1 << 20,
        |_| json!({ "ok": true }),
    );
    assert_eq!(done["error"]["kind"], "exception");
    assert!(done["error"]["message"]
        .as_str()
        .unwrap()
        .starts_with("Error: boom"));
}

#[test]
fn reports_a_lossy_completion_as_invalid_output() {
    let (_, _, done) = execute(
        "return () => {}",
        json!([]),
        1 << 20,
        |_| json!({ "ok": true }),
    );
    assert_eq!(done["error"]["kind"], "invalid-output");
}

#[test]
fn reports_an_oversized_completion_as_output_limit() {
    let (_, _, done) = execute(
        "return 'x'.repeat(200)",
        json!([]),
        128,
        |_| json!({ "ok": true }),
    );
    assert_eq!(done["error"]["kind"], "output-limit");
}

#[test]
fn rejects_lossy_arguments_before_posting() {
    let (frames, _, done) = execute(
        "try { await tools.ping(); return 'no throw' } catch (e) { return e.message }",
        namespace("tools", &["ping"]),
        1 << 20,
        |_| json!({ "ok": true }),
    );
    assert_eq!(frames, vec!["ready", "done"]);
    assert_eq!(
        done["value"],
        json!(["binding arguments must be lossless JSON"])
    );
}

#[test]
fn exits_after_the_terminal_frame() {
    let mut worker = Worker::start();
    assert_eq!(worker.receive()["type"], "ready");
    worker.send(&json!({
        "type": "boot",
        "data": { "code": "return 1", "namespaces": [], "maxOutputBytes": 1 << 20 },
    }));
    loop {
        let message = worker.receive();
        match message["type"].as_str().unwrap() {
            "call" => panic!("a program with no bindings must not call one"),
            "done" => break,
            _ => {}
        }
    }
    assert_eq!(worker.wait_for_exit(Duration::from_secs(10)), Some(0));
}
