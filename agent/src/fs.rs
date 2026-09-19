//! The filesystem operations behind the daemon's `fs.*` wire methods.
//!
//! Every method addresses an absolute path. `resolve` canonicalizes a request —
//! through its deepest existing ancestor when the target does not exist yet —
//! and that canonical path is the only target identity the protocol has; the
//! daemon keeps no per-connection target state, so two connections naming the
//! same file agree on its path and on its version token.
//!
//! Guarded writes compare a version token and then publish separately. That
//! check-then-write window is not atomic, and a per-target lock would only
//! serialize this daemon's own connections, not the editors, build tools, and
//! shells that share the machine. The window is accepted because the token is
//! advisory: losing the race costs one rejected write and a re-read, never
//! silent corruption, since every write still publishes one complete file
//! through a single rename.
//!
//! @module dsh-remote-agent/fs

use base64::Engine;
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::failure::{Failure, Result};

/// Exclusive byte limit on the pre-write diff basis; larger files report `before: null`.
const DIFF_BASIS_MAX_BYTES: u64 = 10 * 1024 * 1024;

/// Bytes per read when an editing caller needs the whole file.
const READ_ALL_CHUNK_BYTES: usize = 1 << 20;

/// Ceiling on one read: a request larger than this is refused rather than
/// allocated, which keeps a hostile length from reserving the whole address
/// space before any bytes arrive.
const MAX_READ_BYTES: u64 = 1 << 31;

/// Monotonic suffix source for staging file names.
static STAGING_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// The filesystem methods the daemon serves, one per `fs.*` wire method.
pub struct FsBackend {
    root: Option<PathBuf>,
}

/// The text to edit, LF-normalized, plus the style to restore on write-back.
struct EditSource {
    text: String,
    crlf: bool,
}

impl FsBackend {
    /// Build the filesystem backend for one daemon process.
    /// @param root - absolute default base for relative paths, or `None` to
    ///   reject them; the daemon never falls back to its own working directory.
    /// @returns the backend bound to that base.
    pub fn new(root: Option<PathBuf>) -> Self {
        Self { root }
    }

    /// Canonicalize a requested path; the caller adopts the result as the target identity.
    pub fn resolve(&self, path: &str) -> Result<Value> {
        let absolute = absolute_path("resolve", path, self.root.as_deref())?;
        Ok(json!({ "canonicalPath": canonical_target("resolve", &absolute)?.to_string_lossy() }))
    }

    /// Read metadata with the final symlink followed.
    pub fn stat(&self, path: &str) -> Result<Value> {
        let target = absolute_path("stat", path, self.root.as_deref())?;
        match probe("stat", &target, true)? {
            None => Ok(Value::Null),
            Some(info) => Ok(json!({
                "version": version_of(&info),
                "type": file_type(&info),
                "size": info.size(),
            })),
        }
    }

    /// Read metadata without following the final symlink.
    pub fn lstat(&self, path: &str) -> Result<Value> {
        let target = absolute_path("lstat", path, self.root.as_deref())?;
        match probe("lstat", &target, false)? {
            None => Ok(Value::Null),
            Some(info) => Ok(json!({
                "version": version_of(&info),
                "type": path_type(&info),
                "size": info.size(),
            })),
        }
    }

    /// List direct children with resolved targets, in stable name order.
    pub fn list_dir(&self, path: &str) -> Result<Value> {
        let verb = "list";
        let target = canonical_target(verb, &absolute_path(verb, path, self.root.as_deref())?)?;
        let info = probe(verb, &target, true)?.ok_or_else(|| not_found(verb, &target))?;
        if !info.is_dir() {
            return Err(Failure::new(
                "FS_NOT_DIRECTORY",
                format!("cannot {verb} \"{}\": not a directory", target.display()),
            ));
        }
        let listing = fs::read_dir(&target).map_err(|error| io_failure(verb, &target, &error))?;
        let mut names: Vec<std::ffi::OsString> = Vec::new();
        for entry in listing {
            let entry = entry.map_err(|error| io_failure(verb, &target, &error))?;
            names.push(entry.file_name());
        }
        names.sort();
        let mut entries = Vec::with_capacity(names.len());
        for name in names {
            let child_path = child_canonical(verb, &target, &name)?;
            let child_info = probe(verb, &child_path, true)?;
            let mut entry = json!({
                "name": name.to_string_lossy(),
                "type": child_info.as_ref().map_or("other", file_type),
                "target": { "canonicalPath": child_path.to_string_lossy() },
            });
            if let Some(info) = &child_info {
                entry["version"] = json!(version_of(info));
                if info.is_file() {
                    entry["size"] = json!(info.size());
                }
            }
            entries.push(entry);
        }
        Ok(Value::Array(entries))
    }

    /// Decode one UTF-8 text window, trimmed back to a code-point boundary.
    pub fn read_text_chunk(&self, path: &str, offset: u64, length: u64) -> Result<Value> {
        let verb = "read";
        let target = absolute_path(verb, path, self.root.as_deref())?;
        let info = probe(verb, &target, true)?.ok_or_else(|| not_found(verb, &target))?;
        if !info.is_file() {
            return Err(not_regular_file(verb, &target));
        }
        let size = info.size();
        if offset >= size {
            return Ok(text_chunk_json(String::new(), offset, true));
        }
        // Hold back a fragment smaller than one code point so the decoder always
        // sees whole sequences; widening to four bytes keeps a short window from
        // consisting of nothing but that fragment.
        let wanted = length.max(4).min(size - offset);
        let window = read_window(verb, &target, offset, wanted as usize)?;
        let fragment = trailing_fragment_length(&window);
        if fragment > 0 && offset + window.len() as u64 >= size {
            // The fragment runs into the end of the file, so no later window can
            // complete it: the file is not valid UTF-8.
            return Err(Failure::new(
                "FS_NOT_TEXT",
                format!("cannot {verb} \"{}\": invalid UTF-8 text", target.display()),
            ));
        }
        let usable = if fragment > 0 && fragment < window.len() {
            &window[..window.len() - fragment]
        } else {
            &window[..]
        };
        let next_offset = offset + usable.len() as u64;
        let text = decode_text(verb, &target, usable)?;
        Ok(text_chunk_json(text, next_offset, next_offset >= size))
    }

    /// Read a whole regular file as raw bytes.
    pub fn read_bytes(&self, path: &str, max_bytes: u64) -> Result<Value> {
        let verb = "read";
        let target = absolute_path(verb, path, self.root.as_deref())?;
        let info = probe(verb, &target, true)?.ok_or_else(|| not_found(verb, &target))?;
        if !info.is_file() {
            return Err(not_regular_file(verb, &target));
        }
        let size = info.size();
        if size > max_bytes {
            return Err(too_large(
                verb,
                &target,
                format!("{size} bytes exceeds the {max_bytes}-byte limit"),
            ));
        }
        // One byte past the cap detects growth after the stat without buffering
        // an unbounded amount of content.
        let bytes = read_window(
            verb,
            &target,
            0,
            size.saturating_add(1).min(max_bytes.saturating_add(1)) as usize,
        )?;
        if bytes.len() as u64 > max_bytes {
            return Err(too_large(
                verb,
                &target,
                format!("content exceeds the {max_bytes}-byte limit"),
            ));
        }
        Ok(bytes_json(&bytes))
    }

    /// Read the byte window `[offset, offset + length)`.
    pub fn read_byte_range(&self, path: &str, offset: u64, length: u64) -> Result<Value> {
        let verb = "read";
        let target = absolute_path(verb, path, self.root.as_deref())?;
        let info = probe(verb, &target, true)?.ok_or_else(|| not_found(verb, &target))?;
        if !info.is_file() {
            return Err(not_regular_file(verb, &target));
        }
        // A zero length, and an offset at or past the end, both read nothing.
        let wanted = length.min(info.size().saturating_sub(offset));
        if wanted == 0 {
            return Ok(bytes_json(&[]));
        }
        Ok(bytes_json(&read_window(
            verb,
            &target,
            offset,
            wanted as usize,
        )?))
    }

    /// Publish text atomically, honouring a guard when one is supplied.
    pub fn write_text(&self, path: &str, content: &str, expected: Option<&Value>) -> Result<Value> {
        let verb = "write";
        let target = absolute_path(verb, path, self.root.as_deref())?;
        let existing = probe(verb, &target, true)?;
        if let Some(info) = &existing {
            if !info.is_file() {
                return Err(not_regular_file(verb, &target));
            }
        }
        let intent = read_write_intent(expected)?;
        guard_write(verb, &target, existing.as_ref(), intent.as_ref())?;
        let before = match &existing {
            None => None,
            Some(info) => read_basis(verb, &target, info.size()),
        };
        let create_if_absent = matches!(intent, Some(WriteIntent::CreateIfAbsent));
        publish(
            verb,
            &target,
            content,
            create_if_absent,
            mode_of(existing.as_ref()),
        )?;
        let after = probe(verb, &target, true)?;
        Ok(json!({
            "operation": if existing.is_none() { "create" } else { "update" },
            "version": after.as_ref().map_or_else(|| missing_version(&target), version_of),
            "before": before,
            "after": normalize_line_endings(content),
        }))
    }

    /// Apply a literal replacement to the current text.
    pub fn edit_text(&self, path: &str, edit: &Value, expected: Option<&str>) -> Result<Value> {
        let verb = "edit";
        let target = absolute_path(verb, path, self.root.as_deref())?;
        let existing = probe(verb, &target, true)?
            .ok_or_else(|| stale_version(verb, &target, "file changed since it was read"))?;
        if !existing.is_file() {
            return Err(not_regular_file(verb, &target));
        }
        if let Some(version) = expected {
            if version_of(&existing) != version {
                return Err(stale_version(
                    verb,
                    &target,
                    "file changed since it was read",
                ));
            }
        }
        let old_string = edit
            .get("oldString")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                Failure::invalid_params("fs.editText", "\"edit.oldString\" must be a string")
            })?;
        let new_string = edit
            .get("newString")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                Failure::invalid_params("fs.editText", "\"edit.newString\" must be a string")
            })?;
        let replace_all = edit
            .get("replaceAll")
            .and_then(Value::as_bool)
            .ok_or_else(|| {
                Failure::invalid_params("fs.editText", "\"edit.replaceAll\" must be a boolean")
            })?;

        let current = read_for_edit(verb, &target)?;
        let edited =
            apply_literal_edit(&current.text, old_string, new_string, replace_all, &target)?;
        let restored = restore_line_endings(&edited, current.crlf);
        publish(verb, &target, &restored, false, mode_of(Some(&existing)))?;
        let after = probe(verb, &target, true)?;
        Ok(json!({
            "version": after.as_ref().map_or_else(|| missing_version(&target), version_of),
            "before": current.text,
            "after": normalize_line_endings(&edited),
        }))
    }
}

/// Render one decoded text window as the wire result.
fn text_chunk_json(text: String, next_offset: u64, eof: bool) -> Value {
    json!({ "text": text, "nextOffset": next_offset, "eof": eof })
}

/// Render a byte payload as the wire result.
fn bytes_json(bytes: &[u8]) -> Value {
    json!({ "data": base64::engine::general_purpose::STANDARD.encode(bytes) })
}

/// Place a requested path without ever consulting the daemon's working directory.
/// @param verb - the operation named in the failure.
/// @param path - the caller's path.
/// @param base - absolute base for a relative path.
/// @returns the normalized absolute path.
pub fn absolute_path(verb: &str, path: &str, base: Option<&Path>) -> Result<PathBuf> {
    let requested = Path::new(path);
    if requested.is_absolute() {
        return Ok(normalize(requested));
    }
    match base {
        Some(value) if value.is_absolute() => Ok(normalize(&value.join(requested))),
        _ => Err(Failure::new(
            "FS_IO_ERROR",
            format!(
                "cannot {verb} \"{path}\": path is relative and the daemon has no root to place it against"
            ),
        )),
    }
}

/// Remove `.` and `..` segments lexically.
///
/// Every caller hands it an absolute path — the plugin's own join produces one
/// — so a leading `..` that has nothing to pop never arises; a `..` above the
/// root resolves to the root, as it does for every other layer here.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(Component::RootDir.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(segment) => out.push(segment),
        }
    }
    out
}

/// Canonicalize a requested path through its deepest existing ancestor.
fn canonical_target(verb: &str, path: &Path) -> Result<PathBuf> {
    match fs::canonicalize(path) {
        Ok(canonical) => return Ok(canonical),
        Err(error) => {
            // A regular file where a directory is required means the target can
            // never exist, whatever its final segment names.
            if is_errno(&error, &[libc::ENOTDIR]) {
                return Err(not_found(verb, path));
            }
            if !is_errno(&error, &[libc::ENOENT]) {
                return Err(io_failure(verb, path, &error));
            }
        }
    }
    let mut missing: Vec<std::ffi::OsString> = vec![file_name(path)];
    let mut ancestor = parent_of(path);
    loop {
        match fs::canonicalize(&ancestor) {
            Ok(mut canonical) => {
                for segment in &missing {
                    canonical.push(segment);
                }
                return Ok(canonical);
            }
            Err(error) => {
                if !is_errno(&error, &[libc::ENOENT, libc::ENOTDIR]) {
                    return Err(io_failure(verb, &ancestor, &error));
                }
                let parent = parent_of(&ancestor);
                if parent == ancestor {
                    return Ok(path.to_path_buf());
                }
                missing.insert(0, file_name(&ancestor));
                ancestor = parent;
            }
        }
    }
}

/// Resolve a listed child, falling back to the parent's canonical name for an absent one.
fn child_canonical(verb: &str, parent: &Path, name: &std::ffi::OsStr) -> Result<PathBuf> {
    let candidate = parent.join(name);
    match fs::canonicalize(&candidate) {
        Ok(canonical) => Ok(canonical),
        Err(error) => {
            if is_errno(&error, &[libc::ENOENT, libc::ENOTDIR]) {
                Ok(candidate)
            } else {
                Err(io_failure(verb, &candidate, &error))
            }
        }
    }
}

/// The last segment of a path, or the path itself when it has none.
fn file_name(path: &Path) -> std::ffi::OsString {
    path.file_name().map_or_else(
        || path.as_os_str().to_os_string(),
        std::ffi::OsStr::to_os_string,
    )
}

/// The parent of a path, or the path itself at the filesystem root.
fn parent_of(path: &Path) -> PathBuf {
    path.parent()
        .map_or_else(|| path.to_path_buf(), Path::to_path_buf)
}

/// Metadata for `path`, or `None` when the path (or a parent segment) is absent.
fn probe(verb: &str, path: &Path, follow: bool) -> Result<Option<fs::Metadata>> {
    let outcome = if follow {
        fs::metadata(path)
    } else {
        fs::symlink_metadata(path)
    };
    match outcome {
        Ok(info) => Ok(Some(info)),
        Err(error) => {
            if is_errno(&error, &[libc::ENOENT, libc::ENOTDIR]) {
                Ok(None)
            } else {
                Err(io_failure(verb, path, &error))
            }
        }
    }
}

/// Whether an io error carries one of the given `errno` values.
fn is_errno(error: &std::io::Error, codes: &[i32]) -> bool {
    error
        .raw_os_error()
        .is_some_and(|code| codes.contains(&code))
}

/// Map a filesystem rejection onto the code the plugin rethrows.
fn io_failure(verb: &str, path: &Path, error: &std::io::Error) -> Failure {
    if is_errno(error, &[libc::ENOENT, libc::ENOTDIR]) {
        return not_found(verb, path);
    }
    if is_errno(error, &[libc::EACCES, libc::EPERM]) {
        return Failure::new(
            "FS_PERMISSION_DENIED",
            format!("cannot {verb} \"{}\": permission denied", path.display()),
        );
    }
    Failure::new(
        "FS_IO_ERROR",
        format!("cannot {verb} \"{}\": {error}", path.display()),
    )
}

fn not_found(verb: &str, path: &Path) -> Failure {
    Failure::new(
        "FS_NOT_FOUND",
        format!("cannot {verb} \"{}\": not found", path.display()),
    )
}

fn not_regular_file(verb: &str, path: &Path) -> Failure {
    Failure::new(
        "FS_NOT_REGULAR_FILE",
        format!("cannot {verb} \"{}\": not a regular file", path.display()),
    )
}

fn stale_version(verb: &str, path: &Path, detail: &str) -> Failure {
    Failure::new(
        "FS_STALE_VERSION",
        format!("cannot {verb} \"{}\": {detail}", path.display()),
    )
}

fn too_large(verb: &str, path: &Path, detail: String) -> Failure {
    Failure::new(
        "FS_TOO_LARGE",
        format!("cannot {verb} \"{}\": {detail}", path.display()),
    )
}

/// Whether a target is a regular file, a directory, or something else.
fn file_type(info: &fs::Metadata) -> &'static str {
    if info.is_file() {
        "file"
    } else if info.is_dir() {
        "directory"
    } else {
        "other"
    }
}

/// Whether a path entry is a regular file, a directory, a symlink, or something else.
fn path_type(info: &fs::Metadata) -> &'static str {
    if info.file_type().is_symlink() {
        "symlink"
    } else {
        file_type(info)
    }
}

/// The POSIX permission bits to preserve for a replaced file.
fn mode_of(info: Option<&fs::Metadata>) -> Option<u32> {
    info.map(|metadata| metadata.mode() & 0o777)
}

/// Derive a target's freshness token from its metadata.
fn version_of(info: &fs::Metadata) -> String {
    let nanoseconds = i128::from(info.mtime()) * 1_000_000_000 + i128::from(info.mtime_nsec());
    format!("{nanoseconds}:{}:{}", info.size(), info.ino())
}

/// Token for a target that disappeared between publication and the post-write probe.
fn missing_version(path: &Path) -> String {
    format!("missing:{}", path.display())
}

/// A guarded write's intent, read from the wire.
enum WriteIntent {
    CreateIfAbsent,
    ReplaceIfVersion(String),
}

/// Read and validate a write intent.
fn read_write_intent(value: Option<&Value>) -> Result<Option<WriteIntent>> {
    let Some(value) = value else { return Ok(None) };
    match value.get("kind").and_then(Value::as_str) {
        Some("createIfAbsent") => Ok(Some(WriteIntent::CreateIfAbsent)),
        Some("replaceIfVersion") => {
            let version = value
                .get("version")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    Failure::invalid_params("fs.writeText", "\"expected.version\" must be a string")
                })?;
            Ok(Some(WriteIntent::ReplaceIfVersion(version.to_string())))
        }
        _ => Err(Failure::invalid_params(
            "fs.writeText",
            "\"expected.kind\" must be \"createIfAbsent\" or \"replaceIfVersion\"",
        )),
    }
}

/// Reject a guarded write whose precondition no longer holds.
fn guard_write(
    verb: &str,
    target: &Path,
    existing: Option<&fs::Metadata>,
    expected: Option<&WriteIntent>,
) -> Result<()> {
    match expected {
        Some(WriteIntent::ReplaceIfVersion(wanted)) => {
            let Some(info) = existing else {
                return Err(stale_version(verb, target, "file no longer exists"));
            };
            if version_of(info) != *wanted {
                return Err(stale_version(
                    verb,
                    target,
                    "file changed since it was read",
                ));
            }
            Ok(())
        }
        Some(WriteIntent::CreateIfAbsent) if existing.is_some() => Err(Failure::new(
            "FS_NOT_OBSERVED",
            format!(
                "cannot overwrite existing \"{}\" without reading it first",
                target.display()
            ),
        )),
        _ => Ok(()),
    }
}

/// Publish `content` at `target` in one atomic step.
fn publish(
    verb: &str,
    target: &Path,
    content: &str,
    create_if_absent: bool,
    mode: Option<u32>,
) -> Result<()> {
    match publish_text(target, content, create_if_absent, mode) {
        Ok(()) => Ok(()),
        Err(error) if is_errno(&error, &[libc::EEXIST]) => Err(Failure::new(
            "FS_NOT_OBSERVED",
            format!(
                "cannot overwrite existing \"{}\" without reading it first",
                target.display()
            ),
        )),
        Err(error) => Err(io_failure(verb, target, &error)),
    }
}

/// Stage the complete content in a sibling and publish it with one filesystem call.
fn publish_text(
    target: &Path,
    content: &str,
    create_if_absent: bool,
    mode: Option<u32>,
) -> std::io::Result<()> {
    let directory = parent_of(target);
    fs::create_dir_all(&directory)?;
    let staging = directory.join(format!(
        ".{}.{}.{}.tmp",
        file_name(target).to_string_lossy(),
        std::process::id(),
        STAGING_SEQUENCE.fetch_add(1, Ordering::Relaxed),
    ));
    let outcome = (|| -> std::io::Result<()> {
        let mut handle = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o666)
            .open(&staging)?;
        handle.write_all(content.as_bytes())?;
        handle.sync_all()?;
        if let Some(bits) = mode {
            handle.set_permissions(fs::Permissions::from_mode(bits))?;
        }
        drop(handle);
        if create_if_absent {
            fs::hard_link(&staging, target)
        } else {
            fs::rename(&staging, target)
        }
    })();
    // A leftover staging file is the lesser failure: the primary error is already
    // unwinding, the name is unique per call, and the file is inert.
    let _ = fs::remove_file(&staging);
    outcome
}

/// Best-effort LF-normalized pre-image for a write's diff basis.
fn read_basis(verb: &str, path: &Path, size: u64) -> Option<String> {
    if size >= DIFF_BASIS_MAX_BYTES {
        return None;
    }
    let bytes = read_window(verb, path, 0, size as usize).ok()?;
    if bytes.contains(&0) {
        return None;
    }
    let text = std::str::from_utf8(&bytes).ok()?;
    Some(normalize_line_endings(text))
}

/// Read a whole file for editing, rejecting binary content.
fn read_for_edit(verb: &str, path: &Path) -> Result<EditSource> {
    let bytes = read_all_bytes(verb, path)?;
    if bytes.contains(&0) {
        return Err(Failure::new(
            "FS_NOT_TEXT",
            format!("cannot {verb} \"{}\": binary file", path.display()),
        ));
    }
    let raw = decode_text(verb, path, &bytes)?;
    let crlf = detect_crlf(&raw);
    Ok(EditSource {
        text: normalize_line_endings(&raw),
        crlf,
    })
}

/// Apply one literal replacement to LF-normalized content.
fn apply_literal_edit(
    content: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
    path: &Path,
) -> Result<String> {
    let old_text = normalize_line_endings(old_string);
    if old_text.is_empty() {
        return Err(Failure::new(
            "FS_EDIT_NOT_FOUND",
            "old_string must be a non-empty string",
        ));
    }
    let new_text = normalize_line_endings(new_string);
    let matches = content.matches(&old_text).count();
    if matches == 0 {
        return Err(Failure::new(
            "FS_EDIT_NOT_FOUND",
            format!("old_string was not found in \"{}\"", path.display()),
        ));
    }
    if !replace_all && matches > 1 {
        return Err(Failure::new(
            "FS_AMBIGUOUS_EDIT",
            format!(
                "old_string matched {matches} times in \"{}\"; provide a more specific old_string or set replace_all to true",
                path.display()
            ),
        ));
    }
    Ok(content.replace(&old_text, &new_text))
}

/// Collapse `\r\n` to `\n`; a lone `\r` is left alone.
fn normalize_line_endings(content: &str) -> String {
    content.replace("\r\n", "\n")
}

/// Whether the dominant line-ending style in the first 4096 characters is CRLF.
fn detect_crlf(raw: &str) -> bool {
    let sample: String = raw.chars().take(4096).collect();
    let crlf = sample.matches("\r\n").count();
    let lf = sample.matches('\n').count() - crlf;
    crlf > lf
}

/// Convert LF-normalized content back to the file's own line-ending style.
fn restore_line_endings(content: &str, crlf: bool) -> String {
    if crlf {
        content.replace('\n', "\r\n")
    } else {
        content.to_string()
    }
}

/// Length of the trailing fragment that belongs to a code point continued after
/// the window.
fn trailing_fragment_length(bytes: &[u8]) -> usize {
    let limit = bytes.len().min(3);
    for back in 1..=limit {
        let byte = bytes[bytes.len() - back];
        if byte & 0xc0 == 0x80 {
            continue;
        }
        if byte & 0x80 == 0x00 {
            return back - 1;
        }
        let width = if byte >= 0xf0 {
            4
        } else if byte >= 0xe0 {
            3
        } else {
            2
        };
        return if width > back { back } else { 0 };
    }
    0
}

/// Decode a boundary-aligned window as UTF-8 text.
fn decode_text(verb: &str, path: &Path, bytes: &[u8]) -> Result<String> {
    if bytes.contains(&0) {
        return Err(Failure::new(
            "FS_NOT_TEXT",
            format!("cannot {verb} \"{}\": binary file", path.display()),
        ));
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => Ok(text.to_string()),
        Err(_) => Err(Failure::new(
            "FS_NOT_TEXT",
            format!("cannot {verb} \"{}\": invalid UTF-8 text", path.display()),
        )),
    }
}

/// Read exactly `length` bytes at `offset`, or fewer at end of file.
fn read_window(verb: &str, path: &Path, offset: u64, length: usize) -> Result<Vec<u8>> {
    if length as u64 > MAX_READ_BYTES {
        return Err(too_large(
            verb,
            path,
            format!("{length} bytes exceeds the {MAX_READ_BYTES}-byte read limit"),
        ));
    }
    if length == 0 {
        return Ok(Vec::new());
    }
    let mut handle = File::open(path).map_err(|error| io_failure(verb, path, &error))?;
    handle
        .seek(SeekFrom::Start(offset))
        .map_err(|error| io_failure(verb, path, &error))?;
    let mut buffer = vec![0u8; length];
    let mut total = 0;
    while total < length {
        match handle.read(&mut buffer[total..]) {
            Ok(0) => break,
            Ok(read) => total += read,
            Err(error) => return Err(io_failure(verb, path, &error)),
        }
    }
    buffer.truncate(total);
    Ok(buffer)
}

/// Read a whole file through to end of file.
fn read_all_bytes(verb: &str, path: &Path) -> Result<Vec<u8>> {
    let mut handle = File::open(path).map_err(|error| io_failure(verb, path, &error))?;
    let mut collected: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; READ_ALL_CHUNK_BYTES];
    loop {
        match handle.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                collected.extend_from_slice(&chunk[..read]);
                if collected.len() as u64 > MAX_READ_BYTES {
                    return Err(too_large(
                        verb,
                        path,
                        format!("content exceeds the {MAX_READ_BYTES}-byte read limit"),
                    ));
                }
            }
            Err(error) => return Err(io_failure(verb, path, &error)),
        }
    }
    Ok(collected)
}
