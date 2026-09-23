/**
 * The routing bash executor the plugin registers as `ctx.shell`.
 *
 * A plain object, like the other two routers. It composes **two** factory
 * executors rather than one: the sandboxed executor for local work, and the
 * bare one for remote work.
 *
 * The bare delegate is not redundant. `bash-sandbox` resolves its argv through
 * `ctx.sandbox`, which wraps a process for **this host's** kernel; handing that
 * argv to a remote cwd would ship a bwrap invocation to the node. On the node
 * the machine itself is the boundary, so the remote branch must take the path
 * that never asks the host sandbox anything.
 *
 * The request/spec split stays the delegate's: whichever executor owns the
 * workdir does both the resolving and the running, so timeout, output caps, and
 * managed-environment handling keep their shipped behavior on both sides.
 *
 * @module dsh-remote-workspace/plugin/routing/shell
 */

import type {
  ShellExecRequest,
  ShellExecSpec,
  ShellExecution,
  ShellExecutor,
} from '@deepseek-ai/dsh-shell'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { AnchorRoute } from '../../storage/anchors.ts'
import { classifyPath } from '../../models/routing.ts'

/**
 * The members this provider implements, narrowed from the seam class so the
 * object literal is checkable without inheriting `Service`.
 */
export type ShellExecutorContract = Pick<
  ShellExecutor,
  'resolve' | 'execute' | 'sandboxMode'
>

/** What the routing executor needs from its owner. */
export interface RoutingShellDeps {
  /** The composed sandboxed executor serving every local workdir. */
  readonly localShell: ShellExecutor
  /** The composed bare executor serving every remote workdir. */
  readonly remoteShell: ShellExecutor
  /** Every anchor this plugin currently owns. */
  readonly anchors: () => readonly AnchorRoute[]
}

/**
 * Build the routing bash executor.
 * @param deps - the two composed delegates and the live anchors.
 * @returns an object satisfying the shell seam, ready for `ctx.provide`.
 */
export function createRoutingShellExecutor(deps: RoutingShellDeps): ShellExecutorContract {
  /**
   * The delegate that owns one workdir.
   * @param workdir - the resolved working directory of the request or spec.
   * @returns the machine's executor for a remote path, this host's otherwise.
   */
  const delegateFor = (workdir: string): ShellExecutor =>
    classifyPath(workdir, undefined, deps.anchors()).kind === 'remote' ? deps.remoteShell : deps.localShell

  return {
    // The fact is "the mode this executor confines at by default", and the
    // executor genuinely confines every LOCAL command at the deployment's mode
    // through the sandboxed delegate. Reporting `undefined` instead would make
    // the plugin uncomposable with `dsh-base`: `permission-presets` refuses to
    // mount over an executor that claims not to confine at all. The remote
    // branch is bounded by the machine.
    get sandboxMode(): SandboxMode | undefined {
      return deps.localShell.sandboxMode
    },

    resolve(request: ShellExecRequest): ShellExecSpec {
      return delegateFor(request.workdir ?? '').resolve(request)
    },

    execute(spec: ShellExecSpec): Promise<ShellExecution> {
      return delegateFor(spec.workdir).execute(spec)
    },
  }
}
