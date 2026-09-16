# dsh-remote-workspace

A DSH plugin for working on another machine. It manages that machine's repositories and worktrees, routes the
harness's file, shell, and terminal tools to the directory you opened, and adds terminal tabs to the right Sidebar.
The model sees ordinary local paths.

English | [中文](README.zh.md)

![A session running tools inside a remote worktree](docs/screenshots/en/08-session.png)

| Machines | Connected | A worktree |
| --- | --- | --- |
| ![The machine list](docs/screenshots/en/01-section.png) | ![A connected machine and its repository](docs/screenshots/en/03-connected.png) | ![A created worktree](docs/screenshots/en/06-worktree-created.png) |

## Requirements

- Node 22.19+ or 24+, with `ssh` configured as usual.
- DSH `0.1.5-rc.2`. Other releases are untested.

## Install

```sh
dsh plugin --profile web add https://github.com/lengmoXXL/dsh-remote-workspace/releases/download/plugin-v0.1.7/dsh-remote-workspace-0.1.7.tgz
```

The plugin takes over services the base profile provides, and the host plane holds one implementation per service. Add
these four lines to `$DSH_HOME/profiles/web/cordis.patch.yml`. Without them the plugin still loads, does not route, and
says so on stderr.

```yaml
- id: subprocess
  disabled: true
- id: fs-sandbox
  disabled: true
- id: bash-sandbox
  disabled: true
- id: pwsh-sandbox
  disabled: true
```

Then start the profile with `dsh --profile web`. The tarball contains the built `lib/`, so nothing is compiled on this
machine. To work on the plugin itself, clone the repository, run `npm install && npm run build`, and add the checkout
path instead.

## What it does

- Adds machines over SSH, and a built-in `Local` machine for this host. The agent is downloaded from this repository's
  Releases, checked against `SHA256SUMS`, and reached over `ssh -L`, so nothing has to be installed on the machines.
- Registers any directory as a repository. Git is not required, and a plain directory can become a repository later.
- Cuts worktrees from a repository, adopts worktrees that already exist, or opens the repository directory itself.
  Removing a worktree can delete its branch as well.
- Opens a directory as a workspace; the file, shell, and terminal tools then run on the machine that owns it.
- Opens terminal tabs in the right Sidebar, one per Session. The **Terminal** entry first lists that Session's live
  shells — including one a page reload or a closed tab detached — so one can be reattached or ended.
- Lets the agent work in a terminal that has a tab open. It lists them, reads output, writes text and keys (including
  `ctrl+c`), and waits for output to appear. It does not create or close terminals.

## Usage

**Settings → Remote workspaces.** Add a machine with an SSH destination and a token — any string; it is the daemon's
shared secret. `Local` needs neither. Machines connect on their own, and one that stays unreachable shows a **Connect**
button. Register a repository, then use a row's menu to open, close, or remove what it holds.

**Terminal.** The right Sidebar's add control has a **Terminal** button: it lists the Session's live terminals and
offers a new one. Closing a tab leaves that shell running — it shows up in the chooser as detached — and **End
terminal** in the panel, or a row's close control in the chooser, is what ends it. Hiding the tab, switching Session,
or collapsing the sidebar also leaves a shell running.

## Config

| Field | Default | Meaning |
|---|---|---|
| `worktreeRoot` | `~/.dsh/worktrees` | Root every managed checkout is cut under, on every machine. |
| `shell` | unset | Program the Sidebar terminal runs; unset uses the machine's own login shell. |
| `shellArgs` | `['-l']` | Arguments after `shell`; ignored while `shell` is unset. |
| `graceMs` | `3000` | How long a closing terminal is given to exit, in milliseconds. |
| `detachGraceMs` | `0` | Safety valve: how long a terminal whose socket went away (a reload, a dropped connection) is kept for a reattach, in milliseconds. `0` — the default — keeps it for as long as its process lives. |

MIT
