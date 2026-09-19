//! The filesystem backend's observable contract.

mod common;

use common::TempDir;
use dsh_remote_agent::failure::{Failure, INVALID_PARAMS};
use dsh_remote_agent::fs::FsBackend;
use serde_json::{json, Value};
use std::path::Path;

/// A backend rooted at one directory.
fn backend(root: &Path) -> FsBackend {
    FsBackend::new(Some(root.to_path_buf()))
}

/// The `canonicalPath` of a resolve result.
fn canonical(value: &Value) -> String {
    value["canonicalPath"]
        .as_str()
        .expect("canonicalPath")
        .to_string()
}

/// The names in a listDir result, in the order they were reported.
fn names(entries: &Value) -> Vec<String> {
    entries
        .as_array()
        .expect("array")
        .iter()
        .map(|entry| entry["name"].as_str().expect("name").to_string())
        .collect()
}

/// The failure code of an expected error.
fn code(result: Result<Value, Failure>) -> &'static str {
    result.expect_err("expected a failure").code
}

#[test]
fn resolves_through_a_symlink_and_refuses_a_relative_path_without_a_root() {
    let dir = TempDir::new("drw-fs-resolve");
    std::fs::create_dir(dir.join("real")).unwrap();
    std::os::unix::fs::symlink(dir.join("real"), dir.join("link")).unwrap();

    let fs = backend(dir.path());
    let resolved = fs.resolve(dir.join("link").to_str().unwrap()).unwrap();
    assert_eq!(canonical(&resolved), dir.join("real").to_string_lossy());

    // Without a root there is nothing to place a relative path against, and the
    // daemon never falls back to its own working directory.
    let rootless = FsBackend::new(None);
    assert_eq!(code(rootless.resolve("relative.txt")), "FS_IO_ERROR");
}

#[test]
fn resolves_a_missing_target_through_its_deepest_existing_ancestor() {
    let dir = TempDir::new("drw-fs-missing");
    std::fs::create_dir(dir.join("sub")).unwrap();
    let fs = backend(dir.path());
    let resolved = fs
        .resolve(dir.join("sub/deep/file.txt").to_str().unwrap())
        .unwrap();
    assert_eq!(
        canonical(&resolved),
        dir.join("sub/deep/file.txt").to_string_lossy()
    );
}

#[test]
fn reports_an_absent_target_as_null_rather_than_failing() {
    let dir = TempDir::new("drw-fs-absent");
    let fs = backend(dir.path());
    let missing = dir.join("nope").to_string_lossy().into_owned();
    assert!(fs.stat(&missing).unwrap().is_null());
    assert!(fs.lstat(&missing).unwrap().is_null());
}

#[test]
fn lists_direct_children_in_name_order_with_resolved_targets() {
    let dir = TempDir::new("drw-fs-list");
    std::fs::write(dir.join("b.txt"), "bee").unwrap();
    std::fs::create_dir(dir.join("a")).unwrap();
    std::os::unix::fs::symlink(dir.join("a"), dir.join("c-link")).unwrap();

    let entries = backend(dir.path())
        .list_dir(dir.path().to_str().unwrap())
        .unwrap();
    assert_eq!(names(&entries), ["a", "b.txt", "c-link"]);
    let file = &entries.as_array().unwrap()[1];
    assert_eq!(file["type"], "file");
    assert_eq!(file["size"], 3);
    assert_eq!(
        canonical(&file["target"]),
        dir.join("b.txt").to_string_lossy()
    );
    // A directory carries no size, and a symlink is not followed by lstat.
    assert!(entries.as_array().unwrap()[0].get("size").is_none());
}

#[test]
fn refuses_to_list_something_that_is_not_a_directory() {
    let dir = TempDir::new("drw-fs-list-file");
    std::fs::write(dir.join("file.txt"), "x").unwrap();
    let fs = backend(dir.path());
    assert_eq!(
        code(fs.list_dir(dir.join("file.txt").to_str().unwrap())),
        "FS_NOT_DIRECTORY"
    );
    assert_eq!(
        code(fs.list_dir(dir.join("gone").to_str().unwrap())),
        "FS_NOT_FOUND"
    );
}

#[test]
fn pages_a_multibyte_file_and_reassembles_it_byte_identically() {
    let dir = TempDir::new("drw-fs-pages");
    let content = "αβγ δεινοσαυρος\n".repeat(64);
    std::fs::write(dir.join("text.txt"), &content).unwrap();

    let fs = backend(dir.path());
    let path = dir.join("text.txt").to_string_lossy().into_owned();
    let mut offset = 0u64;
    let mut assembled = String::new();
    loop {
        let chunk = fs.read_text_chunk(&path, offset, 4).unwrap();
        assembled.push_str(chunk["text"].as_str().unwrap());
        offset = chunk["nextOffset"].as_u64().unwrap();
        if chunk["eof"].as_bool().unwrap() {
            break;
        }
        assert!(offset > 0);
    }
    assert_eq!(assembled, content);
}

#[test]
fn rejects_nul_bytes_and_invalid_utf8_as_not_text() {
    let dir = TempDir::new("drw-fs-binary");
    std::fs::write(dir.join("nul.bin"), b"a\0b").unwrap();
    std::fs::write(dir.join("bad.bin"), [b'o', b'k', 0xff, 0xfe]).unwrap();
    let fs = backend(dir.path());
    for name in ["nul.bin", "bad.bin"] {
        let path = dir.join(name).to_string_lossy().into_owned();
        assert_eq!(code(fs.read_text_chunk(&path, 0, 4096)), "FS_NOT_TEXT");
    }
}

#[test]
fn reads_raw_byte_windows_and_refuses_a_whole_file_beyond_the_cap() {
    let dir = TempDir::new("drw-fs-bytes");
    std::fs::write(dir.join("raw.bin"), [0u8, 1, 2, 3, 4, 5]).unwrap();
    let fs = backend(dir.path());
    let path = dir.join("raw.bin").to_string_lossy().into_owned();

    assert_eq!(
        fs.read_byte_range(&path, 2, 3).unwrap()["data"],
        base64_of(&[2, 3, 4])
    );
    assert_eq!(fs.read_byte_range(&path, 99, 3).unwrap()["data"], "");
    assert_eq!(
        code(fs.read_bytes(&path, 5)),
        "FS_TOO_LARGE",
        "a file larger than maxBytes is refused from metadata alone"
    );
    assert_eq!(
        fs.read_bytes(&path, 6).unwrap()["data"],
        base64_of(&[0, 1, 2, 3, 4, 5])
    );
}

#[test]
fn a_guarded_create_reports_existing_targets_and_an_update_reports_a_pre_image() {
    let dir = TempDir::new("drw-fs-write");
    let fs = backend(dir.path());
    let path = dir.join("note.txt").to_string_lossy().into_owned();

    let created = fs
        .write_text(&path, "first\n", Some(&json!({ "kind": "createIfAbsent" })))
        .unwrap();
    assert_eq!(created["operation"], "create");
    assert!(created["before"].is_null());
    assert_eq!(created["after"], "first\n");

    assert_eq!(
        code(fs.write_text(&path, "again\n", Some(&json!({ "kind": "createIfAbsent" })))),
        "FS_NOT_OBSERVED"
    );

    let update = fs.write_text(&path, "second\n", None).unwrap();
    assert_eq!(update["operation"], "update");
    assert_eq!(update["before"], "first\n");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "second\n");
}

#[test]
fn a_version_guard_rejects_a_stale_write_and_accepts_the_observed_one() {
    let dir = TempDir::new("drw-fs-version");
    let fs = backend(dir.path());
    let path = dir.join("note.txt").to_string_lossy().into_owned();
    std::fs::write(&path, "one\n").unwrap();

    let observed = fs.stat(&path).unwrap()["version"]
        .as_str()
        .unwrap()
        .to_string();
    fs.write_text(
        &path,
        "two\n",
        Some(&json!({ "kind": "replaceIfVersion", "version": observed })),
    )
    .unwrap();

    assert_eq!(
        code(fs.write_text(
            &path,
            "three\n",
            Some(&json!({ "kind": "replaceIfVersion", "version": observed }))
        )),
        "FS_STALE_VERSION"
    );
}

#[test]
fn literal_edits_report_not_found_ambiguity_and_replace_all() {
    let dir = TempDir::new("drw-fs-edit");
    let fs = backend(dir.path());
    let path = dir.join("code.txt").to_string_lossy().into_owned();
    std::fs::write(&path, "let a = 1;\nlet b = a;\n").unwrap();

    let missing = json!({ "oldString": "nothing", "newString": "x", "replaceAll": false });
    assert_eq!(
        code(fs.edit_text(&path, &missing, None)),
        "FS_EDIT_NOT_FOUND"
    );

    let ambiguous = json!({ "oldString": "let", "newString": "const", "replaceAll": false });
    assert_eq!(
        code(fs.edit_text(&path, &ambiguous, None)),
        "FS_AMBIGUOUS_EDIT"
    );

    let all = json!({ "oldString": "let", "newString": "const", "replaceAll": true });
    let edited = fs.edit_text(&path, &all, None).unwrap();
    assert_eq!(edited["after"], "const a = 1;\nconst b = a;\n");
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "const a = 1;\nconst b = a;\n"
    );
}

#[test]
fn an_edit_preserves_the_file_line_ending_style_and_reports_normalized_text() {
    let dir = TempDir::new("drw-fs-crlf");
    let fs = backend(dir.path());
    let path = dir.join("win.txt").to_string_lossy().into_owned();
    std::fs::write(&path, "one\r\ntwo\r\nthree\r\n").unwrap();

    let edit = json!({ "oldString": "two", "newString": "TWO", "replaceAll": false });
    let edited = fs.edit_text(&path, &edit, None).unwrap();
    assert_eq!(edited["before"], "one\ntwo\nthree\n");
    assert_eq!(edited["after"], "one\nTWO\nthree\n");
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "one\r\nTWO\r\nthree\r\n"
    );
}

#[test]
fn a_malformed_edit_is_refused_as_invalid_params_naming_the_field() {
    let dir = TempDir::new("drw-fs-bad-edit");
    let fs = backend(dir.path());
    let path = dir.join("code.txt").to_string_lossy().into_owned();
    std::fs::write(&path, "let a = 1;\n").unwrap();

    // The wire layer validates that "edit" is an object; its fields are read
    // here, and each one refuses with the same code the layer above uses.
    for bad in [
        json!({ "oldString": 7, "newString": "x", "replaceAll": false }),
        json!({ "oldString": "a", "newString": null, "replaceAll": false }),
        json!({ "oldString": "a", "newString": "x", "replaceAll": "yes" }),
    ] {
        let failure = fs.edit_text(&path, &bad, None).unwrap_err();
        assert_eq!(failure.rpc_code, INVALID_PARAMS);
        assert!(
            failure.message.contains("edit."),
            "the refusal names the field: {}",
            failure.message
        );
    }
}

#[test]
fn publication_leaves_no_staging_file_behind() {
    let dir = TempDir::new("drw-fs-staging");
    let fs = backend(dir.path());
    let path = dir.join("nested/deep.txt").to_string_lossy().into_owned();
    fs.write_text(&path, "hello\n", None).unwrap();

    let entries: Vec<String> = std::fs::read_dir(dir.join("nested"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(entries, ["deep.txt"]);
}

/// Base64-encode bytes the way the wire carries them.
fn base64_of(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
