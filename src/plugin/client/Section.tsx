/**
 * The Remote workspaces settings section.
 *
 * The section renders one tree: a machine, the repositories registered on it,
 * and the worktrees cut from each repository. Every level is a fold, so the
 * whole deployment is legible at once and any single branch can be worked on
 * without losing sight of the rest.
 *
 * @module dsh-remote-workspace/plugin/client/Section
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  DisclosureRow,
  IconBranchOutline16,
  IconEllipsisOutline16,
  IconFolderOpen16,
  IconGlobeOutline14,
  IconWarningOutline16,
  Menu,
  Modal,
  StateDot,
  Switch,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteWorktreesKey } from './locales.ts'
import { NS } from './locales.ts'
import { AddMachineDialog, AddRepoDialog, NewWorktreeDialog, reasonOf } from './dialogs.tsx'
import css from './Section.module.css'

/** The locale seat this section reads, including its template parameters. */
export type T = (key: RemoteWorktreesKey, params?: Record<string, unknown>) => string

/** How the host reaches a machine's daemon. */
type NodeTransport =
  | {
    readonly kind: 'ssh'
    readonly target: string
  }
  | {
    /** This host, which needs no daemon and no connection. */
    readonly kind: 'local'
  }

/** One machine as the host projects it. */
interface NodeView {
  readonly nodeId: NodeId
  readonly title: string
  readonly transport: NodeTransport
  readonly hasToken: boolean
}

/** The connection states a machine can report. */
type NodeState = 'idle' | 'connecting' | 'ready' | 'failed' | 'disconnected'

/** What the attempt is doing while it is not yet ready. */
interface AgentProgress {
  readonly phase: 'checking' | 'reusing' | 'fetching' | 'uploading' | 'starting'
  readonly version: string
  readonly asset?: string
  readonly source?: 'cache' | 'network'
}

/** One machine's connection state. */
interface NodeStatus {
  readonly nodeId: NodeId
  readonly state: NodeState
  /** The local port carrying this machine's traffic, once a forward is up. */
  readonly localPort?: number
  /** The step in flight, while the attempt is still running. */
  readonly progress?: AgentProgress
  /** Why the machine is not reachable, when the host reported a reason. */
  readonly error?: string
}

/**
 * The ids as they arrive from the host.
 *
 * Branded on the host, where they are minted and checked; over the wire they
 * are plain strings, so this half declares them the way it declares every other
 * record shape — it cannot share the host's modules, which import node builtins.
 */
export type NodeId = string
/** @see NodeId */
export type RepoId = string
/** @see NodeId */
export type AnchorId = string

/** One repository as the host records it. */
export interface RepoRecord {
  readonly repoId: RepoId
  readonly nodeId: NodeId
  readonly repoPath: string
  readonly name: string
}

/** One repository as the host reports it. */
interface RepoReport {
  readonly repo: RepoRecord
  /** Whether git owns that directory right now. */
  readonly git: boolean
  /** Where that machine cuts checkouts; absent until its home is known. */
  readonly worktreeRoot?: string
  /** Why that could not be answered, when it could not. */
  readonly error?: string
}

/** One local anchor. */
interface AnchorRecord {
  readonly anchorId: AnchorId
  readonly nodeId: NodeId
  /** A worktree's checkout, or the repository directory itself. */
  readonly kind: 'worktree' | 'directory'
  readonly repoPath: string
  readonly name: string
}

/** One anchor, with whether it is currently openable. */
interface WorktreeStatus {
  readonly anchor: AnchorRecord
  /** Whether the anchor holds a workspace registration right now. */
  readonly open: boolean
  /**
   * Whether the plugin cut this checkout itself. Both kinds are the operator's
   * to remove, so this only picks the confirmation's wording: one this plugin
   * cut with no work of anyone else's in it, or one it found on the machine.
   */
  readonly managed: boolean
  /**
   * Whether the plugin holds a record for the row. A checkout read straight
   * from a machine's git has none until it is opened, so release has nothing
   * to drop and the row offers only open and remove.
   */
  readonly held: boolean
  /** Why the host could not read the machine, when it could not. */
  readonly error?: string
}

/** One entry of a remote directory listing. */
interface DirEntry {
  readonly name: string
  readonly type: string
  readonly path: string
}

/** One remote directory level. */
export interface DirListing {
  readonly path: string
  readonly entries: readonly DirEntry[]
}

/** Everything the section reads in one refresh. */
export interface Snapshot {
  readonly nodes: readonly NodeView[]
  readonly statuses: readonly NodeStatus[]
  readonly repos: readonly RepoReport[]
  readonly worktrees: readonly WorktreeStatus[]
}

/** The callbacks the section drives. */
export interface RemoteWorktreesFace {
  /** Read machines, repositories, and worktrees with their live state. */
  load(): Promise<Snapshot>
  addNode(draft: {
    ssh: { target: string; port?: number; identityFile?: string }
    token: string
    title?: string
  }): Promise<void>
  /** Remove a machine and its repository registrations. */
  removeNode(nodeId: NodeId): Promise<void>
  connectNode(nodeId: NodeId): Promise<void>
  disconnectNode(nodeId: NodeId): Promise<void>
  addRepo(draft: { nodeId: NodeId; repoPath: string; name?: string }): Promise<void>
  /** Drop a repository registration and close the directory it was opened as. */
  removeRepo(repoId: RepoId): Promise<void>
  /** Open a repository directory itself as a workspace; git is not required. */
  openDirectory(repoId: RepoId): Promise<void>
  /** Close a directory's own workspace, dropping its anchor. */
  closeDirectory(repoId: RepoId): Promise<void>
  listDirs(nodeId: NodeId, path: string): Promise<DirListing>
  /** Cut a worktree from a registered repository; `path` overrides the default. */
  createWorktree(draft: { repoId: RepoId; name: string; path?: string }): Promise<void>
  /** Remove a worktree; `deleteBranch` also drops the branch it was cut on. */
  removeWorktree(anchorId: AnchorId, deleteBranch: boolean): Promise<void>
  /** Stop managing a checkout, leaving it on the machine untouched. */
  releaseWorktree(anchorId: AnchorId): Promise<void>
  /** Register a worktree as a workspace, so a session can open on it. */
  openWorktree(anchorId: AnchorId): Promise<void>
  /** Drop a worktree's workspace registration, leaving the machine untouched. */
  closeWorktree(anchorId: AnchorId): Promise<void>
}

/** Props the shell composes for this section. */
type SectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<typeof NS>
  & InjectFace<RemoteWorktreesFace>

/** A pending destructive action the user must confirm. */
interface Confirmation {
  readonly titleKey: RemoteWorktreesKey
  readonly bodyKey: RemoteWorktreesKey
  /** Label of an opt-in the dialog offers, when the action has one. */
  readonly optionKey?: RemoteWorktreesKey
  /** What the confirming button does; defaults to removing. */
  readonly confirmKey?: RemoteWorktreesKey
  readonly run: (option: boolean) => Promise<void>
}

/** Which dialog is open, if any. */
type Dialog =
  | { readonly kind: 'machine' }
  | { readonly kind: 'repo'; readonly nodeId: NodeId }
  | { readonly kind: 'worktree'; readonly repo: RepoRecord }
  | undefined

/** The state dot and label one connection state renders as. */
function statusOf(state: NodeState): {
  dot: 'done' | 'ongoing' | 'error' | 'idle'
  key: RemoteWorktreesKey
} {
  if (state === 'ready') return { dot: 'done', key: 'status.ready' }
  if (state === 'connecting') return { dot: 'ongoing', key: 'status.connecting' }
  if (state === 'failed') return { dot: 'error', key: 'status.failed' }
  if (state === 'disconnected') return { dot: 'idle', key: 'status.disconnected' }
  return { dot: 'idle', key: 'status.idle' }
}

/**
 * What a step in flight reads as.
 *
 * Installing or updating the agent is the slow part of a connection and the
 * only part with anything to say, so a machine that is mid-install reports the
 * step rather than a bare "connecting".
 * @param progress - the step the host published.
 * @returns the locale key and its parameters.
 */
function progressText(progress: AgentProgress): {
  key: RemoteWorktreesKey
  params?: Record<string, unknown>
} {
  if (progress.phase === 'reusing') {
    return { key: 'progress.reusing', params: { version: progress.version } }
  }
  if (progress.phase === 'fetching') {
    if (progress.source === 'cache') {
      return { key: 'progress.cached', params: { version: progress.version } }
    }
    if (progress.source === 'network') {
      return { key: 'progress.downloading', params: { asset: progress.asset ?? progress.version } }
    }
    return { key: 'progress.fetching', params: { version: progress.version } }
  }
  if (progress.phase === 'uploading') return { key: 'progress.uploading' }
  if (progress.phase === 'starting') return { key: 'progress.starting' }
  return { key: 'progress.checking' }
}

/**
 * How often a running mutation re-reads the host, in milliseconds.
 *
 * A step can last one SSH round trip — the cache check, the upload of a small
 * binary — so the interval is short enough to catch most of them without
 * turning one connect into a request storm.
 */
const PROGRESS_POLL_MS = 250

/** One action one object's menu offers. */
interface RowAction {
  readonly id: string
  readonly label: ReactNode
  /** Destructive: the menu paints it as such. */
  readonly danger?: boolean
  readonly disabled?: boolean
  readonly run: () => void
}

/**
 * One object's actions, folded into a menu so the object keeps one row.
 *
 * Every row's trigger reads the same, so the accessible name carries the
 * object it opens for. The list is portaled, because the settings column
 * scrolls and would otherwise crop it.
 */
function ActionsMenu({ name, busy, actions, t }: {
  name: string
  busy: boolean
  actions: readonly RowAction[]
  t: T
}) {
  const [open, setOpen] = useState(false)
  const label = `${t('actions')}: ${name}`
  return (
    <Menu
      open={open}
      align="end"
      portal
      compact
      items={actions.map(action => ({
        id: action.id,
        label: action.label,
        disabled: busy || action.disabled === true,
        ...action.danger === undefined ? {} : { danger: action.danger },
      }))}
      onSelect={(id) => {
        setOpen(false)
        actions.find(action => action.id === id)?.run()
      }}
      onClose={() => setOpen(false)}
      anchor={(
        <Button
          size="sm"
          disabled={busy}
          icon={<IconEllipsisOutline16 />}
          aria-label={label}
          title={label}
          onClick={(event) => {
            // The row itself toggles on a click, and the trigger sits in its
            // header: without this, opening the menu would fold the row.
            event.stopPropagation()
            setOpen(current => !current)
          }}
        />
      )}
    />
  )
}

/**
 * One worktree row inside an expanded repository.
 *
 * The row names the checkout and whether it is open as a workspace, and folds
 * its actions into the menu every other row in the tree carries. The branch the
 * checkout sits on belongs to the worktree, so nothing here repeats the
 * repository's own state from the row above.
 *
 * Opening and closing share one seat, named for what a click does, so the row
 * reads as a state rather than as a pair of verbs. Closing the worktree drops
 * the plugin's record and leaves the checkout; removing deletes the checkout.
 * Both are on every row, and the confirmation behind removing says whether the
 * checkout is one this plugin cut or one it found.
 */
function WorktreeRow({ entry, busy, onRemove, onRelease, onToggleOpen, t }: {
  entry: WorktreeStatus
  busy: boolean
  onRemove: () => void
  onRelease: () => void
  onToggleOpen: () => void
  t: T
}) {
  return (
    <div className={css.worktree}>
      <IconBranchOutline16 />
      <span className={css.worktreeMain}>
        <span className={css.worktreeName}>{entry.anchor.name}</span>
        {entry.error === undefined ? null : <span className={css.dim}>{entry.error}</span>}
      </span>
      <span className={css.trailing}>
        <ActionsMenu
          name={entry.anchor.name}
          busy={busy}
          t={t}
          actions={[
            {
              id: 'toggleOpen',
              label: entry.open ? t('closeWorktree') : t('openWorktree'),
              run: onToggleOpen,
            },
            // A checkout read straight from git has no record to release.
            ...entry.held ? [{ id: 'release', label: t('releaseWorktree'), run: onRelease }] : [],
            { id: 'remove', label: t('removeWorktree'), danger: true, run: onRemove },
          ]}
        />
      </span>
    </div>
  )
}

export function RemoteWorktreesSection(props: SectionProps) {
  const { t } = props
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(undefined)
  const [confirmation, setConfirmation] = useState<Confirmation | undefined>(undefined)
  const [confirmedOption, setConfirmedOption] = useState(false)
  const [openMachines, setOpenMachines] = useState<readonly string[]>([])
  const [openRepos, setOpenRepos] = useState<readonly string[]>([])

  // Reads are in flight together while a mutation polls, and a remote read can
  // answer after a newer one: only the newest answer may be published.
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    const mine = (generation.current += 1)
    try {
      const next = await props.load()
      if (mine !== generation.current) return
      setSnapshot(next)
      setError(undefined)
    } catch (failure) {
      if (mine === generation.current) setError(reasonOf(failure))
    }
  }, [props])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /**
   * Run one mutation, then re-read; a failure lands in the banner.
   *
   * A connect spends its time installing or updating the agent on the machine,
   * so the host is re-read while the request runs — otherwise the row would
   * show whatever it showed before the click for the whole download.
   */
  const mutate = useCallback(async (action: () => Promise<void>) => {
    setBusy(true)
    const poll = setInterval(() => { void refresh() }, PROGRESS_POLL_MS)
    try {
      await action()
      setError(undefined)
      await refresh()
    } catch (failure) {
      setError(reasonOf(failure))
    } finally {
      clearInterval(poll)
      setBusy(false)
    }
  }, [refresh])

  /** Run a dialog's mutation; the dialog shows the failure itself. */
  const submit = useCallback(async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const toggle = (
    list: readonly string[],
    set: (next: readonly string[]) => void,
    id: string,
  ): void => {
    set(list.includes(id) ? list.filter(entry => entry !== id) : [...list, id])
  }

  const statusFor = (nodeId: NodeId): NodeStatus | undefined =>
    snapshot?.statuses.find(status => status.nodeId === nodeId)
  const reposOf = (nodeId: NodeId): readonly RepoReport[] =>
    (snapshot?.repos ?? []).filter(entry => entry.repo.nodeId === nodeId)
  const anchorsOf = (repo: RepoRecord): readonly WorktreeStatus[] =>
    (snapshot?.worktrees ?? []).filter(entry =>
      entry.anchor.nodeId === repo.nodeId && entry.anchor.repoPath === repo.repoPath)
  const worktreesOf = (repo: RepoRecord): readonly WorktreeStatus[] =>
    anchorsOf(repo).filter(entry => entry.anchor.kind === 'worktree')
  /** The directory's own workspace, when one is open or was opened before. */
  const directoryOf = (repo: RepoRecord): WorktreeStatus | undefined =>
    anchorsOf(repo).find(entry => entry.anchor.kind === 'directory')

  const confirm = (next: Confirmation): void => {
    setConfirmedOption(false)
    setConfirmation(next)
  }

  const nodes = snapshot?.nodes ?? []

  return (
    <div className={css.section}>
      <div className={css.head}>
        <h3 className={css.title}>{t('title')}</h3>
        <p className={css.subtitle}>{t('subtitle')}</p>
      </div>

      <div className={css.toolbar}>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => setDialog({ kind: 'machine' })}
        >
          {t('addMachine')}
        </Button>
        <Button disabled={busy} onClick={() => void refresh()}>
          {t('refresh')}
        </Button>
      </div>

      {error === undefined ? null : (
        <div className={css.alert} role="alert">
          <IconWarningOutline16 />
          <span>{error}</span>
        </div>
      )}

      {snapshot === undefined ? (
        <div className={css.empty}>{t('loading')}</div>
      ) : nodes.length === 0 ? (
        <div className={css.empty}>{t('machinesEmpty')}</div>
      ) : (
        <div className={css.tree}>
          {nodes.map(node => {
            const status = statusFor(node.nodeId)
            const state = status?.state ?? 'idle'
            const badge = statusOf(state)
            const step = status?.progress === undefined ? undefined : progressText(status.progress)
            const machineOpen = openMachines.includes(node.nodeId)
            const repos = reposOf(node.nodeId)
            // This host has no destination, no tunnel, no token, and no
            // connection to make or break: it is where the harness already is.
            const here = node.transport.kind === 'local'
            // What the row says in words, when it says anything: the step in
            // flight, or the state of a machine that is not simply connected.
            const note = status?.error ?? (step === undefined
              ? badge.dot === 'done' ? undefined : t(badge.key)
              : t(step.key, step.params))
            return (
              <div key={node.nodeId} className={css.card}>
                <DisclosureRow
                  icon={<IconGlobeOutline14 />}
                  title={node.title}
                  open={machineOpen}
                  expandable
                  expandOnRowClick
                  keepContentWhenOpen
                  rowClassName={css.row}
                  leadingClassName={css.leading}
                  onToggle={() => toggle(openMachines, setOpenMachines, node.nodeId)}
                  collapsedContent={(
                    <span className={css.trailing}>
                      {node.transport.kind === 'ssh'
                        ? <span className={css.meta}>{node.transport.target}</span>
                        : null}
                      {status?.localPort === undefined
                        ? null
                        : <Tag tone="neutral">{t('forwarding', { port: status.localPort })}</Tag>}
                      {here || node.hasToken ? null : <Tag tone="warning">{t('noToken')}</Tag>}
                      <StateDot state={badge.dot} />
                      {/* A settled machine says what its dot already says, so
                          it says nothing: this host is always available and a
                          connected machine is connected. The words stay for
                          assistive technology, which cannot read a colour, and
                          they are shown while a step is in flight or a state is
                          one a dot cannot tell apart — a red dot names no
                          reason by itself. */}
                      {note === undefined
                        ? <span className={css.srOnly}>{t(here ? 'status.local' : badge.key)}</span>
                        : <span className={css.meta}>{note}</span>}
                      <ActionsMenu
                        name={node.title}
                        busy={busy}
                        t={t}
                        actions={[
                          ...here ? [] : [state === 'ready'
                            ? {
                              id: 'disconnect',
                              label: t('disconnect'),
                              run: () => void mutate(() => props.disconnectNode(node.nodeId)),
                            }
                            : {
                              id: 'connect',
                              label: t('connect'),
                              run: () => void mutate(() => props.connectNode(node.nodeId)),
                            }],
                          {
                            id: 'addRepository',
                            label: t('addRepository'),
                            run: () => setDialog({ kind: 'repo', nodeId: node.nodeId }),
                          },
                          ...here ? [] : [{
                            id: 'removeMachine',
                            label: t('removeMachine'),
                            danger: true,
                            run: () => confirm({
                              titleKey: 'removeMachineTitle',
                              bodyKey: 'removeMachineBody',
                              run: () => props.removeNode(node.nodeId),
                            }),
                          }],
                        ]}
                      />
                    </span>
                  )}
                >
                  <div className={css.repos}>
                    {repos.length === 0
                      ? <div className={css.empty}>{t('repositoriesEmpty')}</div>
                      : repos.map(entry => {
                        const repo = entry.repo
                        const repoOpen = openRepos.includes(repo.repoId)
                        const worktrees = worktreesOf(repo)
                        const directory = directoryOf(repo)
                        // Cutting a worktree needs git, and whether git owns the
                        // directory is a live fact: a plain directory can be
                        // worked in, and initialized on the machine later. The
                        // menu carries that reason beside the control it
                        // refuses, so the row itself stays silent.
                        const why = entry.error ?? t('notARepository')
                        // Opening a directory the section has never resolved
                        // needs the machine to spell the path; an anchor that
                        // already exists is registered locally, so changing its
                        // state keeps working while the machine is away.
                        const cannotOpen = entry.error !== undefined && directory === undefined
                        return (
                          <div key={repo.repoId} className={css.repoCard}>
                            <DisclosureRow
                              icon={<IconFolderOpen16 />}
                              title={repo.name}
                              open={repoOpen}
                              expandable
                              expandOnRowClick
                              keepContentWhenOpen
                              rowClassName={css.row}
                              leadingClassName={css.leading}
                              onToggle={() => toggle(openRepos, setOpenRepos, repo.repoId)}
                              collapsedContent={(
                                <span className={css.trailing}>
                                  <ActionsMenu
                                    name={repo.name}
                                    busy={busy}
                                    t={t}
                                    actions={[
                                      {
                                        id: 'newWorktree',
                                        label: entry.git
                                          ? t('newWorktree')
                                          : <>{t('newWorktree')} <span className={css.dim}>{why}</span></>,
                                        disabled: !entry.git,
                                        run: () => setDialog({ kind: 'worktree', repo }),
                                      },
                                      {
                                        id: 'directory',
                                        // Nothing is open when the machine
                                        // cannot be asked, so the label is the
                                        // one that would open it, with the
                                        // reason it cannot.
                                        label: cannotOpen
                                          ? (
                                            <>
                                              {t('openWorktree')}{' '}
                                              <span className={css.dim}>{entry.error}</span>
                                            </>
                                          )
                                          : directory?.open === true ? t('closeWorktree') : t('openWorktree'),
                                        disabled: cannotOpen,
                                        run: () => void mutate(() => (
                                          directory?.open === true
                                            ? props.closeDirectory(repo.repoId)
                                            : props.openDirectory(repo.repoId)
                                        )),
                                      },
                                      {
                                        id: 'forgetRepository',
                                        label: t('forgetRepository'),
                                        danger: true,
                                        run: () => confirm({
                                          titleKey: 'removeRepositoryTitle',
                                          bodyKey: 'removeRepositoryBody',
                                          run: () => props.removeRepo(repo.repoId),
                                        }),
                                      },
                                    ]}
                                  />
                                </span>
                              )}
                            >
                              {worktrees.length === 0 && !entry.git ? null : (
                                <div className={css.worktrees}>
                                  {worktrees.length === 0
                                    ? <div className={css.empty}>{t('worktreesEmpty')}</div>
                                    : worktrees.map(item => (
                                      <WorktreeRow
                                        key={item.anchor.anchorId}
                                        entry={item}
                                        busy={busy}
                                        t={t}
                                        onToggleOpen={() => void mutate(() => (
                                          item.open
                                            ? props.closeWorktree(item.anchor.anchorId)
                                            : props.openWorktree(item.anchor.anchorId)
                                        ))}
                                        onRemove={() => confirm({
                                          titleKey: 'removeWorktreeTitle',
                                          bodyKey: item.managed
                                            ? 'removeWorktreeBody'
                                            : 'removeAdoptedWorktreeBody',
                                          optionKey: 'removeWorktreeBranch',
                                          run: deleteBranch => props.removeWorktree(item.anchor.anchorId, deleteBranch),
                                        })}
                                        onRelease={() => confirm({
                                          titleKey: 'releaseWorktreeTitle',
                                          bodyKey: 'releaseWorktreeBody',
                                          confirmKey: 'releaseWorktree',
                                          run: () => props.releaseWorktree(item.anchor.anchorId),
                                        })}
                                      />
                                    ))}
                                </div>
                              )}
                            </DisclosureRow>
                          </div>
                        )
                      })}
                  </div>
                </DisclosureRow>
              </div>
            )
          })}
        </div>
      )}

      {dialog?.kind === 'machine' ? (
        <AddMachineDialog
          busy={busy}
          onClose={() => setDialog(undefined)}
          onSubmit={draft => submit(() => props.addNode(draft))}
          t={t}
        />
      ) : null}

      {dialog?.kind === 'repo' ? (
        <AddRepoDialog
          nodeId={dialog.nodeId}
          busy={busy}
          onClose={() => setDialog(undefined)}
          onSubmit={draft => submit(() => props.addRepo(draft))}
          listDirs={props.listDirs}
          t={t}
        />
      ) : null}

      {dialog?.kind === 'worktree' ? (
        <NewWorktreeDialog
          repo={dialog.repo}
          root={reposOf(dialog.repo.nodeId)
            .find(entry => entry.repo.repoId === dialog.repo.repoId)?.worktreeRoot}
          busy={busy}
          onClose={() => setDialog(undefined)}
          onSubmit={draft => submit(() => props.createWorktree(draft))}
          t={t}
        />
      ) : null}

      {confirmation === undefined ? null : (
        <Modal
          open
          onClose={() => setConfirmation(undefined)}
          title={t(confirmation.titleKey)}
          closeLabel={t('close')}
          footer={(
            <>
              <Button onClick={() => setConfirmation(undefined)}>{t('cancel')}</Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => {
                  const pending = confirmation
                  const option = confirmedOption
                  setConfirmation(undefined)
                  void mutate(() => pending.run(option))
                }}
              >
                {t(confirmation.confirmKey ?? 'remove')}
              </Button>
            </>
          )}
        >
          <div className={css.confirm}>
            <p className={css.subtitle}>{t(confirmation.bodyKey)}</p>
            {confirmation.optionKey === undefined ? null : (
              <Switch
                checked={confirmedOption}
                onChange={setConfirmedOption}
                label={t(confirmation.optionKey)}
                disabled={busy}
              />
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}
