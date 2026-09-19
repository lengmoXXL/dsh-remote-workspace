//! Git worktree operations behind the daemon's `git.*` wire methods.
//!
//! Every command is an argv array handed to `git` directly, so a branch name or
//! a path can never be reinterpreted by a shell, and every command carries a
//! bounded timeout that kills the child. Failures are classified from git's own
//! output after the command ran rather than from a pre-flight guess, so a state
//! change between a check and the command cannot produce the wrong code.
//!
//! @module dsh-remote-agent/git

use serde_json::{json, Value};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;

use crate::failure::{Failure, Result};
use crate::fs::absolute_path;

/// Bound on one git invocation; the child is killed when it elapses.
const GIT_TIMEOUT: Duration = Duration::from_secs(120);

/// Bound on captured git output; porcelain listings are far smaller.
const GIT_MAX_BUFFER_BYTES: usize = 8 * 1024 * 1024;

/// How long a killed command's output capture is given to reach EOF.
///
/// A grandchild that inherited the pipes can hold them open past the kill, so
/// the capture is bounded: the request reports what it has rather than waiting
/// for a process this command does not own.
const GIT_CAPTURE_GRACE: Duration = Duration::from_secs(2);

/// Longest slice of git's own output repeated in a failure message.
const GIT_DETAIL_MAX_CHARS: usize = 2_000;

/// Identity and commit settings for a merge git has to create.
const MERGE_IDENTITY: [&str; 6] = [
    "-c",
    "user.name=dsh-remote-agent",
    "-c",
    "user.email=dsh-remote-agent@localhost",
    "-c",
    "commit.gpgsign=false",
];

/// One finished `git` invocation.
#[derive(Default)]
struct GitOutcome {
    ok: bool,
    stdout: String,
    stderr: String,
    status: Option<i32>,
    timed_out: bool,
    spawn_error: String,
}

/// The git worktree methods the daemon serves, one per `git.*` wire method.
pub struct GitBackend {
    root: Option<PathBuf>,
}

impl GitBackend {
    /// Build the git backend for one daemon process.
    /// @param root - absolute default base for relative paths, or `None` to
    ///   reject them; the daemon never falls back to its own working directory.
    /// @returns the backend bound to that base.
    pub fn new(root: Option<PathBuf>) -> Self {
        Self { root }
    }

    /// Create a worktree checkout on a new branch.
    pub async fn worktree_add(
        &self,
        repo_path: &str,
        worktree_path: &str,
        branch: &str,
        base_ref: Option<&str>,
    ) -> Result<Value> {
        let repo = absolute_path("add a worktree to", repo_path, self.root.as_deref())?;
        let target = absolute_path("add a worktree to", worktree_path, self.root.as_deref())?;
        require_repository(&repo).await?;
        let target_text = target.to_string_lossy().into_owned();
        let mut args: Vec<&str> = vec!["worktree", "add", "-b", branch, &target_text];
        if let Some(reference) = base_ref {
            args.push(reference);
        }
        let outcome = run(&repo, &args).await;
        if !outcome.ok {
            return Err(classify_add(&repo, &target, branch, &outcome));
        }
        describe_worktree(&target).await
    }

    /// List the repository's worktrees in git's own order.
    pub async fn worktree_list(&self, repo_path: &str) -> Result<Value> {
        let repo = absolute_path("list the worktrees of", repo_path, self.root.as_deref())?;
        require_repository(&repo).await?;
        let outcome = run(&repo, &["worktree", "list", "--porcelain"]).await;
        if !outcome.ok {
            return Err(command_failed(&repo, &outcome));
        }
        Ok(Value::Array(parse_worktree_list(&outcome.stdout)))
    }

    /// Remove a worktree checkout and prune its administrative entry.
    pub async fn worktree_remove(
        &self,
        repo_path: &str,
        worktree_path: &str,
        force: bool,
    ) -> Result<Value> {
        let repo = absolute_path("remove a worktree from", repo_path, self.root.as_deref())?;
        let target = absolute_path(
            "remove a worktree from",
            worktree_path,
            self.root.as_deref(),
        )?;
        require_repository(&repo).await?;
        let target_text = target.to_string_lossy().into_owned();
        let mut args: Vec<&str> = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push(&target_text);
        let outcome = run(&repo, &args).await;
        if !outcome.ok {
            if says(&outcome, "contains modified or untracked files") {
                return Err(Failure::new(
                    "GIT_DIRTY",
                    format!("cannot remove \"{target_text}\": it contains modified or untracked files; retry with force"),
                ));
            }
            return Err(command_failed(&repo, &outcome));
        }
        let prune = run(&repo, &["worktree", "prune"]).await;
        if !prune.ok {
            return Err(command_failed(&repo, &prune));
        }
        Ok(json!({}))
    }

    /// Delete a branch.
    pub async fn branch_delete(&self, repo_path: &str, branch: &str, force: bool) -> Result<Value> {
        let repo = absolute_path("delete a branch of", repo_path, self.root.as_deref())?;
        require_repository(&repo).await?;
        let outcome = run(&repo, &["branch", if force { "-D" } else { "-d" }, branch]).await;
        if !outcome.ok {
            if says(&outcome, "not fully merged") {
                return Err(Failure::new(
                    "GIT_DIRTY",
                    format!("cannot delete branch \"{branch}\": it is not fully merged; retry with force"),
                ));
            }
            if branch_not_found(&outcome) || is_missing_ref(&outcome) {
                return Err(Failure::new(
                    "GIT_REF_NOT_FOUND",
                    format!("cannot delete branch \"{branch}\": {}", detail(&outcome)),
                ));
            }
            return Err(command_failed(&repo, &outcome));
        }
        Ok(json!({}))
    }

    /// Report the repository's current branch and whether its tree is clean.
    pub async fn repo_state(&self, repo_path: &str) -> Result<Value> {
        let repo = absolute_path("read the state of", repo_path, self.root.as_deref())?;
        require_repository(&repo).await?;
        let status = run(&repo, &["status", "--porcelain"]).await;
        if !status.ok {
            return Err(command_failed(&repo, &status));
        }
        // `--abbrev-ref HEAD` answers `HEAD` for a detached checkout and fails on
        // an unborn one; neither names a branch, so both report null.
        let head = run(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]).await;
        Ok(json!({
            "branch": if head.ok { short_branch(head.stdout.trim()) } else { Value::Null },
            "clean": status.stdout.trim().is_empty(),
        }))
    }

    /// Merge a branch into the repository's current branch.
    pub async fn merge_branch(&self, repo_path: &str, branch: &str) -> Result<Value> {
        let repo = absolute_path("merge into", repo_path, self.root.as_deref())?;
        require_repository(&repo).await?;

        let ancestor = run(&repo, &["merge-base", "--is-ancestor", branch, "HEAD"]).await;
        if ancestor.ok {
            return Ok(json!({ "head": head_of(&repo).await?, "alreadyMerged": true }));
        }
        if ancestor.status != Some(1) {
            if is_missing_ref(&ancestor) {
                return Err(merge_ref_not_found(&repo, branch, &ancestor));
            }
            return Err(command_failed(&repo, &ancestor));
        }

        let mut args: Vec<&str> = MERGE_IDENTITY.to_vec();
        args.extend(["merge", "--no-edit", branch]);
        let outcome = run(&repo, &args).await;
        if outcome.ok {
            return Ok(json!({ "head": head_of(&repo).await?, "alreadyMerged": false }));
        }

        // Collect the conflicted paths and unwind before answering: a caller that
        // receives a failure must not inherit a repository stuck mid-merge.
        let conflicts = conflicted_paths(&repo).await;
        run(&repo, &["merge", "--abort"]).await;
        if !conflicts.is_empty() {
            return Err(Failure::new(
                "GIT_DIRTY",
                format!(
                    "merge of \"{branch}\" into \"{}\" stopped on conflicts: {}",
                    repo.display(),
                    conflicts.join(", ")
                ),
            ));
        }
        if says_any(&outcome, &["would be overwritten", "local changes"]) {
            return Err(Failure::new(
                "GIT_DIRTY",
                format!(
                    "merge of \"{branch}\" into \"{}\" stopped: {}",
                    repo.display(),
                    detail(&outcome)
                ),
            ));
        }
        if is_missing_ref(&outcome) {
            return Err(merge_ref_not_found(&repo, branch, &outcome));
        }
        Err(command_failed(&repo, &outcome))
    }
}

/// The refusal for a merge that names a ref git cannot find.
fn merge_ref_not_found(repo: &Path, branch: &str, outcome: &GitOutcome) -> Failure {
    Failure::new(
        "GIT_REF_NOT_FOUND",
        format!(
            "cannot merge \"{branch}\" into \"{}\": {}",
            repo.display(),
            detail(outcome)
        ),
    )
}

/// Run one git command with a bounded capture and a killing timeout.
async fn run<S: AsRef<OsStr>>(repo: &Path, args: &[S]) -> GitOutcome {
    let mut command = tokio::process::Command::new("git");
    command
        .arg("-C")
        .arg(repo)
        .args(args)
        // A daemon has no terminal: a prompt for credentials or an editor would
        // hold the invocation until the timeout kills it.
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return GitOutcome {
                spawn_error: error.to_string(),
                ..GitOutcome::default()
            };
        }
    };
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let mut stdout_task = tokio::spawn(read_bounded(stdout_pipe));
    let mut stderr_task = tokio::spawn(read_bounded(stderr_pipe));
    let waited = tokio::time::timeout(GIT_TIMEOUT, child.wait()).await;
    if waited.is_err() {
        let _ = child.kill().await;
    }
    // The kill ends the direct child, not the pipe: a grandchild that inherited
    // stdout or stderr holds it open, and reading until EOF would then wait for a
    // process this command does not own. The capture is bounded, and a capture
    // that outlives the bound is abandoned rather than awaited.
    let captured = tokio::time::timeout(GIT_CAPTURE_GRACE, async {
        let out = (&mut stdout_task).await.unwrap_or_default();
        let err = (&mut stderr_task).await.unwrap_or_default();
        (out, err)
    })
    .await;
    let (stdout, stderr) = match captured {
        Ok(captured) => captured,
        Err(_) => {
            stdout_task.abort();
            stderr_task.abort();
            (Vec::new(), Vec::new())
        }
    };
    let text = |bytes: Vec<u8>| String::from_utf8_lossy(&bytes).into_owned();
    match waited {
        Ok(Ok(status)) => GitOutcome {
            ok: status.success(),
            stdout: text(stdout),
            stderr: text(stderr),
            status: status.code(),
            timed_out: false,
            spawn_error: String::new(),
        },
        Ok(Err(error)) => GitOutcome {
            spawn_error: error.to_string(),
            ..GitOutcome::default()
        },
        Err(_) => GitOutcome {
            stdout: text(stdout),
            stderr: text(stderr),
            timed_out: true,
            ..GitOutcome::default()
        },
    }
}

/// Read one captured stream, stopping at the capture cap.
async fn read_bounded<R: tokio::io::AsyncRead + Unpin>(pipe: Option<R>) -> Vec<u8> {
    let Some(pipe) = pipe else { return Vec::new() };
    let mut buffer = Vec::new();
    let _ = pipe
        .take(GIT_MAX_BUFFER_BYTES as u64)
        .read_to_end(&mut buffer)
        .await;
    buffer
}

/// Fail unless `repo` is inside a git repository.
async fn require_repository(repo: &Path) -> Result<()> {
    let outcome = run(repo, &["rev-parse", "--git-dir"]).await;
    if !outcome.ok {
        return Err(Failure::new(
            "GIT_NOT_A_REPOSITORY",
            format!("not a git repository: {}", detail(&outcome)),
        ));
    }
    Ok(())
}

/// Classify a failed `git worktree add` from git's own output.
fn classify_add(repo: &Path, target: &Path, branch: &str, outcome: &GitOutcome) -> Failure {
    // The branch message also says "already exists", so it is matched first.
    if says(outcome, "a branch named") && says(outcome, "already exists") {
        return Failure::new(
            "GIT_BRANCH_EXISTS",
            format!(
                "cannot add a worktree to \"{}\": branch \"{branch}\" already exists",
                repo.display()
            ),
        );
    }
    if says_any(
        outcome,
        &[
            "already exists",
            "already registered",
            "is a main working tree",
        ],
    ) {
        return Failure::new(
            "GIT_WORKTREE_EXISTS",
            format!(
                "cannot add a worktree to \"{}\": \"{}\" already exists",
                repo.display(),
                target.display()
            ),
        );
    }
    if is_missing_ref(outcome) {
        return Failure::new(
            "GIT_REF_NOT_FOUND",
            format!(
                "cannot add a worktree to \"{}\": {}",
                repo.display(),
                detail(outcome)
            ),
        );
    }
    command_failed(repo, outcome)
}

/// Read back the worktree a successful `worktree add` created.
async fn describe_worktree(path: &Path) -> Result<Value> {
    let head = head_of(path).await?;
    let branch = run(path, &["rev-parse", "--abbrev-ref", "HEAD"]).await;
    if !branch.ok {
        return Err(command_failed(path, &branch));
    }
    Ok(json!({
        "path": path.to_string_lossy(),
        "branch": short_branch(branch.stdout.trim()),
        "head": head,
        "main": false,
    }))
}

/// Parse `git worktree list --porcelain`, preserving git's order.
fn parse_worktree_list(porcelain: &str) -> Vec<Value> {
    let mut worktrees: Vec<Value> = Vec::new();
    let mut path: Option<String> = None;
    let mut head = String::new();
    let mut branch: Value = Value::Null;
    let flush = |path: &mut Option<String>,
                 head: &mut String,
                 branch: &mut Value,
                 list: &mut Vec<Value>| {
        if let Some(current) = path.take() {
            list.push(json!({
                "path": current,
                "branch": branch.take(),
                "head": head.clone(),
                "main": list.is_empty(),
            }));
            *head = String::new();
            *branch = Value::Null;
        }
    };
    for line in porcelain.split('\n') {
        if let Some(rest) = line.strip_prefix("worktree ") {
            flush(&mut path, &mut head, &mut branch, &mut worktrees);
            path = Some(rest.trim().to_string());
            continue;
        }
        if path.is_none() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("HEAD ") {
            head = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("branch ") {
            branch = short_branch(rest.trim());
        } else if line == "detached" || line == "bare" {
            branch = Value::Null;
        }
    }
    flush(&mut path, &mut head, &mut branch, &mut worktrees);
    worktrees
}

/// The short name a ref spelling names, or `null` for a detached or bare checkout.
fn short_branch(reference: &str) -> Value {
    if reference.is_empty() || reference == "HEAD" {
        return Value::Null;
    }
    let short = reference.strip_prefix("refs/heads/").unwrap_or(reference);
    Value::String(short.to_string())
}

/// The revision HEAD points at.
async fn head_of(repo: &Path) -> Result<String> {
    let outcome = run(repo, &["rev-parse", "HEAD"]).await;
    if !outcome.ok {
        return Err(command_failed(repo, &outcome));
    }
    Ok(outcome.stdout.trim().to_string())
}

/// Unmerged paths of an in-progress merge, in git's order.
async fn conflicted_paths(repo: &Path) -> Vec<String> {
    let outcome = run(repo, &["diff", "--name-only", "--diff-filter=U"]).await;
    if !outcome.ok {
        return Vec::new();
    }
    outcome
        .stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

/// Whether git's output says the named revision does not exist.
fn is_missing_ref(outcome: &GitOutcome) -> bool {
    says_any(
        outcome,
        &[
            "not a valid object name",
            "unknown revision",
            "ambiguous argument",
            "did not match any",
            "invalid reference",
            "not something we can merge",
        ],
    )
}

/// Whether git's output says the named branch does not exist.
fn branch_not_found(outcome: &GitOutcome) -> bool {
    says(outcome, "branch") && says(outcome, "not found")
}

/// Whether git's output contains one needle, ignoring case.
fn says(outcome: &GitOutcome, needle: &str) -> bool {
    contains_ci(&outcome.stderr, needle) || contains_ci(&outcome.stdout, needle)
}

/// Whether git's output contains any of the needles, ignoring case.
fn says_any(outcome: &GitOutcome, needles: &[&str]) -> bool {
    needles.iter().any(|needle| says(outcome, needle))
}

/// Whether `haystack` contains `needle`, ignoring case.
fn contains_ci(haystack: &str, needle: &str) -> bool {
    haystack.to_lowercase().contains(&needle.to_lowercase())
}

/// Git's own words for a failure, trimmed and bounded, for a caller-facing message.
fn detail(outcome: &GitOutcome) -> String {
    if outcome.timed_out {
        return format!("git timed out after {}ms", GIT_TIMEOUT.as_millis());
    }
    if !outcome.spawn_error.is_empty() {
        return outcome.spawn_error.clone();
    }
    let text = if !outcome.stderr.trim().is_empty() {
        outcome.stderr.trim()
    } else if !outcome.stdout.trim().is_empty() {
        outcome.stdout.trim()
    } else {
        return format!(
            "git exited with status {}",
            outcome
                .status
                .map_or("unknown".to_string(), |code| code.to_string())
        );
    };
    if text.chars().count() > GIT_DETAIL_MAX_CHARS {
        return format!(
            "{}...",
            text.chars().take(GIT_DETAIL_MAX_CHARS).collect::<String>()
        );
    }
    text.to_string()
}

/// The failure a git command that ran and refused produces.
fn command_failed(repo: &Path, outcome: &GitOutcome) -> Failure {
    Failure::new(
        "GIT_COMMAND_FAILED",
        format!(
            "cannot operate on \"{}\": {}",
            repo.display(),
            detail(outcome)
        ),
    )
}
