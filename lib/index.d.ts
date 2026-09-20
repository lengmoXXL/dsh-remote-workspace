// dsh-remote-workspace host half
import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/index.d.ts
/** Plugin name used by the Loader and by diagnostics. */
export declare const name = "dsh-remote-workspace";
/**
 * Services this plugin needs before it activates. `sandboxPolicy` is required
 * by the composed local delegate, and declaring it here keeps provision of
 * `ctx.fs` behind that dependency rather than racing it. The Sidebar terminal
 * reads the session store and the terminal seam it serves, so it looks both up
 * dynamically rather than making them activation dependencies.
 */
export declare const inject: string[];
/** Deployment-varying choices for this plugin. */
export interface Config {
  /**
   * Directory holding the node registry. Defaults to
   * `$DSH_HOME/remote-worktrees`, which the anchor directory store also uses.
   */
  dataDir?: string;
  /**
   * Remote binary a host-resolved ripgrep is rewritten to. Defaults to `rg`.
   */
  remoteRipgrep?: string;
  /**
   * Root directory every managed worktree is cut under, on every machine.
   *
   * Defaults to `~/.dsh/worktrees`, resolved against the machine's own home; an
   * absolute path is used verbatim. A checkout lands at
   * `<root>/<repository>/<name>`, never inside the repository.
   */
  worktreeRoot?: string;
  /**
   * How long the SSH forward may take to start accepting connections, in
   * milliseconds. Defaults to {@link DEFAULT_FORWARD_TIMEOUT_MS}.
   *
   * A deployment across a slow link or through a bastion raises this; the
   * failure it prevents is a forward that was still negotiating when the
   * budget ran out.
   */
  sshForwardTimeoutMs?: number;
  /**
   * How long the daemon may take to answer the handshake once its forward is
   * up, in milliseconds. Defaults to {@link DEFAULT_HANDSHAKE_TIMEOUT_MS}.
   *
   * This is what turns "the daemon is not running" into a report instead of a
   * call that never returns, so a deployment should not raise it far.
   */
  daemonHandshakeTimeoutMs?: number;
  /**
   * Program the Sidebar terminal runs. Unset — the default — runs the machine's
   * own login shell, resolved on whichever machine owns the workspace, so one
   * deployment spanning a Mac and a Linux node starts zsh on one and bash on
   * the other.
   */
  shell?: string;
  /**
   * Arguments after {@link Config.shell}. Defaults to `['-l']`, a login shell,
   * which is what makes the user's own profile load. Ignored while `shell` is
   * unset.
   */
  shellArgs?: string[];
  /** TERM-to-KILL grace for one terminal session, in milliseconds. */
  graceMs?: number;
  /**
   * Safety valve: how long a terminal whose browser socket went away is kept,
   * in milliseconds. Unset or `0` — the default — keeps it for as long as its
   * process lives, because a browser's absence is not the shell's business.
   *
   * A positive value releases a terminal nobody has come back for that long
   * after the last socket left. A tab that is closed ends its terminal
   * immediately regardless, because the browser sends `close` first.
   */
  detachGraceMs?: number;
}
/** Validated plugin config. */
export declare const Config: z<Config>;
/**
 * Mount the plugin.
 *
 * @param ctx - the host context this plugin was mounted on.
 * @param config - the validated plugin config.
 */
export declare function apply(ctx: Context, config: Config): Promise<void>;
//#endregion
//# sourceMappingURL=index.d.ts.map