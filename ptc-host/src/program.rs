//! The V8 side of the program host: the isolate's one host function, the
//! bootstrap script, and the frame hand-off between the two.
//!
//! The bootstrap owns the protocol and the program; this module owns the engine
//! boundary. It installs the single callback the bootstrap writes through,
//! evaluates the bootstrap once, and from then on only polls the root promise
//! and hands inbound frames to the callback the bootstrap published.
//!
//! @module dsh-ptc-host/program

use v8::PinScope;

use crate::OUTBOUND;

/// The bootstrap script the isolate evaluates first.
const BOOTSTRAP: &str = include_str!("program.js");

/// The three globals `program.js` publishes, which are the whole of what this
/// side and that script have to agree on.
const ON_FRAME: &str = "__dsh_onFrame";
const ON_CLOSE: &str = "__dsh_onClose";
const ROOT: &str = "__dsh_root";

/// Install the send callback and evaluate the bootstrap.
pub fn start(scope: &mut PinScope) -> Result<(), String> {
    install(scope);
    v8::tc_scope!(let try_catch, scope);
    let source = v8::String::new(try_catch, BOOTSTRAP)
        .ok_or_else(|| "the program host source did not fit a V8 string".to_string())?;
    if let Some(script) = v8::Script::compile(try_catch, source, None) {
        script.run(try_catch);
    }
    if try_catch.has_caught() {
        let exception = try_catch.exception();
        return Err(format!(
            "the program host failed to load: {}",
            exception_text(try_catch, exception)
        ));
    }
    Ok(())
}

/// Whether the program is still waiting for a frame.
pub fn pending(scope: &mut PinScope) -> Result<bool, String> {
    let context = scope.get_current_context();
    let global = context.global(scope);
    let key = v8::String::new(scope, ROOT)
        .ok_or_else(|| format!("the name {ROOT} did not fit a V8 string"))?;
    let value = global
        .get(scope, key.into())
        .ok_or_else(|| "the program host left no root promise".to_string())?;
    let promise = v8::Local::<v8::Promise>::try_from(value)
        .map_err(|_| "the program host root is not a promise".to_string())?;
    Ok(promise.state() == v8::PromiseState::Pending)
}

pub fn deliver(scope: &mut PinScope, text: &str) -> Result<(), String> {
    call_handler(scope, ON_FRAME, Some(text))
}

/// Tell the bootstrap the channel closed before the program ended.
pub fn close(scope: &mut PinScope) -> Result<(), String> {
    call_handler(scope, ON_CLOSE, None)
}

fn call_handler(scope: &mut PinScope, name: &str, text: Option<&str>) -> Result<(), String> {
    v8::tc_scope!(let try_catch, scope);
    let handler = global_function(try_catch, name)?;
    let global = try_catch.get_current_context().global(try_catch);
    match text {
        Some(text) => {
            let argument = v8::String::new(try_catch, text)
                .ok_or_else(|| "an incoming control frame did not fit a V8 string".to_string())?;
            handler.call(try_catch, global.into(), &[argument.into()]);
        }
        None => {
            handler.call(try_catch, global.into(), &[]);
        }
    }
    if try_catch.has_caught() {
        let exception = try_catch.exception();
        return Err(format!(
            "the program host threw handling {name}: {}",
            exception_text(try_catch, exception)
        ));
    }
    Ok(())
}

/// The text of one caught exception, for a message the host can report.
fn exception_text(scope: &mut PinScope, exception: Option<v8::Local<v8::Value>>) -> String {
    match exception {
        Some(value) => value.to_rust_string_lossy(scope),
        None => "an exception with no value".to_string(),
    }
}

fn global_function<'s>(
    scope: &mut PinScope<'s, '_>,
    name: &str,
) -> Result<v8::Local<'s, v8::Function>, String> {
    let context = scope.get_current_context();
    let global = context.global(scope);
    let key = v8::String::new(scope, name)
        .ok_or_else(|| format!("the name {name} did not fit a V8 string"))?;
    let value = global
        .get(scope, key.into())
        .ok_or_else(|| format!("the program host left no {name}"))?;
    v8::Local::<v8::Function>::try_from(value).map_err(|_| format!("{name} is not a function"))
}

fn install(scope: &mut PinScope) {
    let template = v8::FunctionTemplate::new(scope, host_send);
    let function = template
        .get_function(scope)
        .expect("a function template yields a function");
    let name = v8::String::new(scope, "__dsh_send").expect("a short name interns");
    let global = scope.get_current_context().global(scope);
    global.set(scope, name.into(), function.into());
}

/**
 * Write one frame the program produced.
 *
 * The bootstrap hands whole JSON frames here because the channel, not the
 * program, is what knows how to frame them. A frame that cannot be written ends
 * the run: the host would otherwise wait for output that is not coming.
 */
fn host_send(
    scope: &mut PinScope,
    arguments: v8::FunctionCallbackArguments,
    _return: v8::ReturnValue,
) {
    let text = arguments.get(0).to_rust_string_lossy(scope);
    let written = OUTBOUND.with(|slot| {
        slot.borrow_mut()
            .as_mut()
            .expect("the control channel is installed before the bootstrap runs")
            .write_frame(text.as_bytes())
    });
    if let Err(error) = written {
        eprintln!("dsh-ptc-host: writing a control frame failed: {error}");
        std::process::exit(1);
    }
}
