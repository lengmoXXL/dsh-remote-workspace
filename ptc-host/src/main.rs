//! dsh-ptc-host: the V8 program host of a remote workspace.
//!
//! The DeepSeek Harness PTC backend (dsh-ptc-runtime-node) spawns a fresh
//! interpreter per program, hands it a boot payload over an inherited control
//! channel, and answers the binding calls the program makes. On this host's own
//! machine that interpreter is Node. On a remote node it is this binary: the
//! same protocol over the same descriptor, evaluated by an embedded V8 instead
//! of by a Node runtime the machine would otherwise have to provide.
//!
//! The process is deliberately separate from the agent daemon. Model-written
//! code is the one thing here that can exhaust a heap or trip a fatal engine
//! check, and the daemon is the long-lived server for that machine's files,
//! processes, git and terminals; a crash model code can cause must not be able
//! to take those down with it.
//!
//! It is launched as `dsh-ptc-host [--max-old-space-size=<MiB>] <max-message-bytes>`
//! with the control socketpair on descriptor 7.
//!
//! @module dsh-ptc-host

mod channel;
mod program;

use std::cell::RefCell;
use std::process::ExitCode;

use channel::Channel;

thread_local! {
    /// The inherited control channel, shared with the V8 send callback.
    static OUTBOUND: RefCell<Option<Channel>> = const { RefCell::new(None) };
}

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let Some(max_message_bytes) = arguments
        .last()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
    else {
        eprintln!("usage: dsh-ptc-host [--max-old-space-size=<MiB>] <max-message-bytes>");
        return ExitCode::from(2);
    };
    // The host passes Node's own heap ceiling when it spawns the Node backend;
    // V8 takes the same flag, so a deployment's configured limit still applies.
    if let Some(mebibytes) = arguments
        .iter()
        .find_map(|argument| argument.strip_prefix("--max-old-space-size="))
    {
        v8::V8::set_flags_from_string(&format!("--max-old-space-size={mebibytes}"));
    }

    let channel = match Channel::inherit(max_message_bytes) {
        Ok(channel) => channel,
        Err(error) => {
            eprintln!("dsh-ptc-host: cannot adopt the control channel: {error}");
            return ExitCode::from(2);
        }
    };
    OUTBOUND.with(|slot| *slot.borrow_mut() = Some(channel));

    let platform = v8::new_default_platform(0, false).make_shared();
    v8::V8::initialize_platform(platform);
    v8::V8::initialize();

    let isolate = &mut v8::Isolate::new(v8::CreateParams::default());
    v8::scope!(let handle_scope, isolate);
    let context = v8::Context::new(handle_scope, Default::default());
    let scope = &mut v8::ContextScope::new(handle_scope, context);

    if let Err(error) = program::start(scope) {
        eprintln!("dsh-ptc-host: the program host failed to start: {error}");
        return ExitCode::from(1);
    }

    loop {
        // Everything the program can do without new input runs here: queued
        // microtasks and any platform task the engine scheduled.
        while v8::Platform::pump_message_loop(&v8::V8::get_current_platform(), scope, false) {}
        match program::pending(scope) {
            Ok(false) => break,
            Ok(true) => {}
            Err(error) => {
                eprintln!("dsh-ptc-host: {error}");
                return ExitCode::from(1);
            }
        }
        let frame = OUTBOUND.with(|slot| {
            slot.borrow_mut()
                .as_mut()
                .expect("the control channel is installed before the loop")
                .read_frame()
        });
        match frame {
            Ok(Some(bytes)) => {
                if let Err(error) = program::deliver(scope, &String::from_utf8_lossy(&bytes)) {
                    eprintln!("dsh-ptc-host: {error}");
                    return ExitCode::from(1);
                }
            }
            // The host closing the channel ends the run: whatever the program
            // was waiting for is no longer coming.
            Ok(None) => match program::close(scope) {
                Ok(()) => break,
                Err(error) => {
                    eprintln!("dsh-ptc-host: {error}");
                    return ExitCode::from(1);
                }
            },
            Err(error) => {
                eprintln!("dsh-ptc-host: reading a control frame failed: {error}");
                return ExitCode::from(1);
            }
        }
    }
    ExitCode::SUCCESS
}
