//! Link fixes the prebuilt V8 archive needs on this crate's release targets.

/// One build-script entry point; the protocol itself lives in the crate.
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let target = std::env::var("TARGET").unwrap_or_default();
    // V8's arm64 instruction-cache flush calls __clear_cache, a libgcc routine
    // the prebuilt musl archive leaves undefined. Rust's musl link line carries
    // compiler_builtins and libc but not libgcc, so the reference has to be
    // satisfied by asking for it: without this, one release target fails to
    // link, and only once a release is already tagged.
    if target == "aarch64-unknown-linux-musl" {
        println!("cargo:rustc-link-arg-bins=-lgcc");
    }
}
