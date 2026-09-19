/**
 * The client half of dsh-remote-workspace.
 *
 * It owns two surfaces: a settings section that manages the machines this
 * deployment can reach, the repositories registered on them, and the remote
 * worktrees cut from those repositories — everything it renders comes from the
 * host's management routes under `/dsh-remote-workspace`, which the host half
 * registers — and the right Sidebar's terminal tab, whose body talks to the
 * terminal socket the host half serves.
 *
 * The module is the plugin body: it registers the locale dictionaries and
 * contributes one component. The section's stylesheet travels inside
 * `Section`, which attaches it to the document when it is first evaluated. The
 * component itself receives all data and callbacks through its prop shares.
 *
 * @module dsh-remote-workspace/plugin/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { DirListing, RemoteWorktreesFace, Snapshot, T as Translate } from './Section.tsx'
import { RemoteWorktreesSection } from './Section.tsx'
import { request } from './api.ts'
import type { RemoteWorktreesKey } from './locales.ts'
import { en, NS, zh } from './locales.ts'
import { mountTerminal } from './terminal/index.ts'
import { NS as TERMINAL_NS } from './terminal/locales.ts'
import { TerminalSettingsSection } from './terminal/TerminalSettingsSection.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Remote machine, repository, and worktree management copy. */
    'dsh-remote-workspace': RemoteWorktreesKey
  }
}

/**
 * One JSON request against the management API, with this namespace's copy for
 * a failure the host did not describe.
 * @param t - the locale seat the fallback message is read through.
 * @param path - the route below the plugin's prefix.
 * @returns the parsed body.
 * @throws when the host answered with a non-2xx status.
 */
async function call<T>(t: Translate, path: string, init?: RequestInit): Promise<T> {
  return await request<T>(status => t('requestFailed', { status }), path, init)
}

/**
 * Build the injected face over the host routes.
 * @param t - the locale seat every request failure is reported through.
 * @returns the face the section drives.
 */
function sectionFace(t: Translate): RemoteWorktreesFace {
  return {
    async load(): Promise<Snapshot> {
      const [listing, repos, worktrees] = await Promise.all([
        call<{ nodes: Snapshot['nodes']; statuses: Snapshot['statuses'] }>(t, '/nodes'),
        call<{ repos: Snapshot['repos'] }>(t, '/repos'),
        call<{ worktrees: Snapshot['worktrees'] }>(t, '/worktrees'),
      ])
      return { nodes: listing.nodes, statuses: listing.statuses, repos: repos.repos, worktrees: worktrees.worktrees }
    },
    async addNode(draft) {
      await call(t, '/nodes', { method: 'POST', body: JSON.stringify(draft) })
    },
    async removeNode(nodeId) {
      await call(t, `/nodes/${encodeURIComponent(nodeId)}`, { method: 'DELETE' })
    },
    async connectNode(nodeId) {
      await call(t, `/nodes/${encodeURIComponent(nodeId)}/connect`, { method: 'POST' })
    },
    async disconnectNode(nodeId) {
      await call(t, `/nodes/${encodeURIComponent(nodeId)}/disconnect`, { method: 'POST' })
    },
    async addRepo(draft) {
      await call(t, '/repos', { method: 'POST', body: JSON.stringify(draft) })
    },
    async removeRepo(repoId) {
      await call(t, `/repos/${encodeURIComponent(repoId)}`, { method: 'DELETE' })
    },
    async openDirectory(repoId) {
      await call(t, `/repos/${encodeURIComponent(repoId)}/open`, { method: 'POST' })
    },
    async closeDirectory(repoId) {
      await call(t, `/repos/${encodeURIComponent(repoId)}/close`, { method: 'POST' })
    },
    async listDirs(nodeId, path): Promise<DirListing> {
      const query = new URLSearchParams({ path })
      return await call<DirListing>(t, `/nodes/${encodeURIComponent(nodeId)}/dirs?${query.toString()}`)
    },
    async createWorktree(draft) {
      await call(t, '/worktrees', { method: 'POST', body: JSON.stringify(draft) })
    },
    async removeWorktree(anchorId, deleteBranch) {
      const query = new URLSearchParams({ force: 'true', deleteBranch: String(deleteBranch) })
      await call(t, `/worktrees/${encodeURIComponent(anchorId)}?${query.toString()}`, { method: 'DELETE' })
    },
    async openWorktree(anchorId) {
      await call(t, `/worktrees/${encodeURIComponent(anchorId)}/open`, { method: 'POST' })
    },
    async closeWorktree(anchorId) {
      await call(t, `/worktrees/${encodeURIComponent(anchorId)}/close`, { method: 'POST' })
    },
  }
}

/** Plugin name used by the client loader and by diagnostics. */
export const name = 'dsh-remote-workspace-ui'

/** Client services this plugin needs before it activates. */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight']

/**
 * Mount the client half.
 * @param ctx - the client context this plugin was mounted on.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-remote-workspace: dictionaries')
  // Bound, not called: the seat reads the current language on every use, so a
  // request that fails after a language change is reported in the new one.
  const face = sectionFace(ctx.locale.bind(NS))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-remote-workspace',
    order: 30,
    // The nav label is read at render time, so it follows a language change
    // without the shell subscribing to locale state.
    label: () => ctx.locale.bind(NS)('title'),
    locale: NS,
    inject: () => face,
  }, RemoteWorktreesSection))
  // The terminal's own page: its display preferences belong to the terminal,
  // not to the machines and worktrees the section above manages.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-terminal',
    order: 40,
    label: () => ctx.locale.bind(TERMINAL_NS)('settings.label'),
    locale: TERMINAL_NS,
  }, TerminalSettingsSection))
  // The sections register first: the terminal half owns the same plugin, and a
  // failure there must not take the settings surfaces with it.
  mountTerminal(ctx)
}
