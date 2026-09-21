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

/// The bootstrap script the isolate evaluates first.
const BOOTSTRAP: &str = include_str!("program.js");

/// The global the bootstrap publishes its frame handler as.
const ON_FRAME: &str = "__dsh_onFrame";

/// The global the bootstrap publishes its close handler as.
const ON_CLOSE: &str = "__dsh_onClose";

/// The global the bootstrap parks its root promise on.
const ROOT: &str = "__dsh_root";

/**
 * Install the send callback and evaluate the bootstrap.
 * @param scope - the isolate's context scope.
 * @returns the failure text when the bootstrap could not start.
 */
pub fn start(scope: &mut PinScope) -> Result<(), String> {
    install(scope);
    v8::tc_scope!(let try_catch, scope);
    let source = v8::String::new(try_catch, BOOTSTRAP)
        .ok_or_else(|| "the program host source did not fit a V8 string".to_string())?;
    if let Some(script) = v8::Script::compile(try_catch, source, None) {
        script.run(try_catch);
    }
    if try_catch.has_caught() {
        let detail = match try_catch.exception() {
            Some(value) => value.to_rust_string_lossy(try_catch),
            None => "an exception with no value".to_string(),
        };
        return Err(format!("the program host failed to load: {detail}"));
    }
    Ok(())
}

/**
 * Whether the program is still waiting for a frame.
 * @param scope - the isolate's context scope.
 * @returns true while the root promise is unsettled.
 */
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

/**
 * Hand one inbound frame to the bootstrap.
 * @param scope - the isolate's context scope.
 * @param text - the frame's UTF-8 body.
 * @returns the failure text when the handler threw.
 */
pub fn deliver(scope: &mut PinScope, text: &str) -> Result<(), String> {
    call_handler(scope, ON_FRAME, Some(text))
}

/**
 * Tell the bootstrap the channel closed before the program ended.
 * @param scope - the isolate's context scope.
 * @returns the failure text when the handler threw.
 */
pub fn close(scope: &mut PinScope) -> Result<(), String> {
    call_handler(scope, ON_CLOSE, None)
}

/// Call one published bootstrap handler, with an optional frame argument.
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
        let detail = match try_catch.exception() {
            Some(value) => value.to_rust_string_lossy(try_catch),
            None => "an exception with no value".to_string(),
        };
        return Err(format!("the program host threw handling {name}: {detail}"));
    }
    Ok(())
}

/// Read one global the bootstrap published, as a function.
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

/// Install the one host function the bootstrap writes frames through.
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
 * program, is what knows how to frame them. A frame that cannot be written
 * ends the run: the host would otherwise wait for output that is not coming.
 * @param scope - the isolate's scope.
 * @param arguments - the frame as its only argument.
 * @param _return - unused; the frame carries no result back to the program.
 */
fn host_send(
    scope: &mut PinScope,
    arguments: v8::FunctionCallbackArguments,
    _return: v8::ReturnValue,
) {
    let text = arguments.get(0).to_rust_string_lossy(scope);
    let written = OUTBOUND.with(|slot| {
        let mut borrowed = slot.borrow_mut();
        match borrowed.as_mut() {
            Some(channel) => channel.write_frame(text.as_bytes()),
            None => Err(std::io::Error::other("the control channel is gone")),
        }
    });
    if let Err(error) = written {
        eprintln!("dsh-ptc-host: writing a control frame failed: {error}");
        std::process::exit(1);
    }
}

use crate::OUTBOUND;
