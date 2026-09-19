/**
 * The editors the section opens, and the bits they share with it.
 *
 * Each editor is a form over an injected callback: it collects input, reports
 * its own failure text, and never talks to the host itself. The form field, the
 * in-dialog failure line, the parent-directory helper, and the failure-text
 * helper live here because only these editors and the section that opens them
 * render with them.
 *
 * @module dsh-remote-workspace/plugin/client/dialogs
 */

import { useEffect, useState, type ReactNode } from 'react'
import {
  Button,
  IconFolderClose16,
  IconWarningOutline16,
  Input,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { reasonOf } from './api.ts'
import type { DirListing, NodeId, RepoId, RepoRecord, T } from './Section.tsx'
import type { RemoteWorktreesKey } from './locales.ts'
import css from './Section.module.css'

/** A labelled form field. */
function Field({ label, hint, children }: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className={css.field}>
      <span className={css.label}>{label}</span>
      {children}
      {hint === undefined ? null : <span className={css.hint}>{hint}</span>}
    </div>
  )
}

/** One field's label, marked when the form does not require it. */
function optionalLabel(t: T, key: RemoteWorktreesKey): string {
  return `${t(key)} · ${t('optional')}`
}

/** A failure shown inside a dialog, where the global banner is out of view. */
function DialogError({ message }: { message: string | undefined }) {
  if (message === undefined) return null
  return (
    <div className={css.alert}>
      <IconWarningOutline16 />
      <span>{message}</span>
    </div>
  )
}

/**
 * Add a machine by its SSH destination.
 *
 * The host installs and starts the agent itself, so the operator picks no port
 * and never runs `ssh -L` by hand. The token is the shared secret the plugin
 * gives that agent.
 */
export function AddMachineDialog({ busy, onClose, onSubmit, t }: {
  busy: boolean
  onClose: () => void
  onSubmit: (draft: {
    ssh: { target: string; port?: number; identityFile?: string }
    token: string
    title?: string
  }) => Promise<void>
  t: T
}) {
  const [target, setTarget] = useState('')
  const [sshPort, setSshPort] = useState('')
  const [identityFile, setIdentityFile] = useState('')
  const [token, setToken] = useState('')
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)

  const submit = async (): Promise<void> => {
    setError(undefined)
    try {
      await onSubmit({
        ssh: {
          target: target.trim(),
          ...sshPort.trim() === '' ? {} : { port: Number(sshPort) },
          ...identityFile.trim() === '' ? {} : { identityFile: identityFile.trim() },
        },
        token,
        ...title.trim() === '' ? {} : { title: title.trim() },
      })
      onClose()
    } catch (failure) {
      setError(reasonOf(failure))
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('addMachine')}
      closeLabel={t('close')}
      footer={(
        <>
          <Button onClick={onClose}>{t('cancel')}</Button>
          <Button
            variant="primary"
            disabled={busy || target.trim() === '' || token.trim() === ''}
            onClick={() => void submit()}
          >
            {t('create')}
          </Button>
        </>
      )}
    >
      <div className={css.fields}>
        <DialogError message={error} />
        <Field label={t('fieldTarget')} hint={t('hintTarget')}>
          <Input value={target} placeholder={t('placeholderTarget')} onChange={e => setTarget(e.target.value)} />
        </Field>
        <Field label={optionalLabel(t, 'fieldSshPort')} hint={t('hintSshPort')}>
          <Input value={sshPort} inputMode="numeric" onChange={e => setSshPort(e.target.value)} />
        </Field>
        <Field label={optionalLabel(t, 'fieldIdentityFile')} hint={t('hintIdentityFile')}>
          <Input value={identityFile} placeholder={t('placeholderIdentityFile')} onChange={e => setIdentityFile(e.target.value)} />
        </Field>
        <Field label={t('fieldToken')} hint={t('hintToken')}>
          <Input type="password" value={token} onChange={e => setToken(e.target.value)} />
        </Field>
        <Field label={optionalLabel(t, 'fieldName')}>
          <Input value={title} onChange={e => setTitle(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

/**
 * Browse one machine's directories and pick a repository root.
 *
 * The listing comes from the same remote filesystem the agent's tools use, so
 * what the picker shows is what a session opened on the result would see.
 */
function DirectoryPicker({ nodeId, value, onChange, listDirs, t }: {
  nodeId: NodeId
  value: string
  onChange: (path: string) => void
  listDirs: (nodeId: NodeId, path: string) => Promise<DirListing>
  t: T
}) {
  /** The loaded listing and the directory it answers, so a late reply about an
      abandoned directory is never shown under the current one. */
  const [listing, setListing] = useState<{ readonly dir: string; readonly value: DirListing } | undefined>(
    undefined,
  )
  const [error, setError] = useState<string | undefined>(undefined)
  /** A path the picker itself navigated to. While the text still reads as the
      text it was chosen from, that path is the directory to list rather than a
      name to filter its parent by. */
  const [entered, setEntered] = useState<string | undefined>(undefined)

  const text = value.trim()
  const { dir, prefix } = browseTarget(text, entered)

  useEffect(() => {
    let live = true
    // The previous directory's failure is not this one's; it clears as soon as
    // the text moves on, rather than lingering until the answer arrives.
    setError(undefined)
    // Keyed on the directory rather than the text: a keystroke inside one
    // directory only narrows what is already loaded, so asking the machine
    // again would be a round trip for an answer the picker holds.
    listDirs(nodeId, dir).then(
      next => { if (live) setListing({ dir, value: next }) },
      (failure: unknown) => { if (live) setError(reasonOf(failure)) },
    )
    return () => { live = false }
  }, [dir, listDirs, nodeId])

  // What the picker can show right now, or undefined while it is still asking.
  const current = listing !== undefined && listing.dir === dir ? listing.value : undefined
  const entries = (current?.entries ?? []).filter(
    entry => entry.type === 'directory' && matchesName(entry.name, prefix),
  )
  const parent = current === undefined ? undefined : parentOf(current.path)
  // The bar names what is listed. Until the machine answers, an unspelled
  // request is the home directory, which `~` is the readable name for.
  const place = current?.path ?? (dir === '' ? '~' : dir)

  /** Descend: the text follows the path and the list shows what it holds. */
  const navigate = (path: string): void => {
    setEntered(path)
    onChange(path)
  }

  return (
    <div className={css.picker}>
      <div className={css.pickerBar}>
        <Button
          size="sm"
          disabled={parent === undefined}
          onClick={() => { if (parent !== undefined) navigate(parent) }}
        >
          {t('pickerUp')}
        </Button>
        <span className={css.pickerPath} title={place}>{place}</span>
        <Button
          size="sm"
          disabled={text === '' && current === undefined}
          onClick={() => onChange(text === '' ? current?.path ?? dir : text)}
        >
          {t('pickerUse')}
        </Button>
      </div>
      <DialogError message={error} />
      <div className={css.pickerList}>
        {error !== undefined ? null : current === undefined ? (
          <div className={css.pickerEmpty}>{t('loading')}</div>
        ) : entries.length === 0 ? (
          <div className={css.pickerEmpty}>{t(prefix === '' ? 'pickerEmpty' : 'pickerNoMatch')}</div>
        ) : (
          entries.map(entry => (
            <button
              key={entry.path}
              type="button"
              className={css.pickerItem}
              onClick={() => navigate(entry.path)}
            >
              <IconFolderClose16 />
              <span>{entry.name}</span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

/** The parent of an absolute POSIX directory, or undefined at the root. */
function parentOf(path: string): string | undefined {
  if (path === '/' || path === '') return undefined
  const cut = path.replace(/\/+$/, '').lastIndexOf('/')
  if (cut < 0) return undefined
  return cut === 0 ? '/' : path.slice(0, cut)
}

/** Whether one directory name answers the segment being typed. */
function matchesName(name: string, prefix: string): boolean {
  // A dotted directory is furniture on this machine, not a suggestion, unless
  // it is what is being typed.
  if (name.startsWith('.') && !prefix.startsWith('.')) return false
  return prefix === '' || name.toLowerCase().startsWith(prefix.toLowerCase())
}

/**
 * Read a typed path the way a completion list should: the directory to list,
 * and the name segment to keep from it.
 *
 * A trailing separator names a directory to list; any other text names a child
 * of its parent, so its last segment is the filter. A path the picker itself
 * navigated to is read the same way as a trailing separator, which is what
 * makes a clicked row descend into itself instead of collapsing to its own
 * name. Text with no separator at all is a name under the machine's home, which
 * is where browsing starts; an empty path asks for that home itself.
 * @param text - the path as typed, trimmed.
 * @param entered - the path the picker last navigated to, when it did.
 * @returns the directory to list and the prefix to filter it by.
 */
function browseTarget(text: string, entered: string | undefined): { dir: string; prefix: string } {
  if (text === entered) return { dir: text, prefix: '' }
  if (text === '') return { dir: '', prefix: '' }
  if (text.endsWith('/')) return { dir: withoutTail(text) || '/', prefix: '' }
  const cut = text.lastIndexOf('/')
  if (cut < 0) return { dir: '', prefix: text }
  const dir = text.slice(0, cut)
  return { dir: dir.endsWith('/') ? withoutTail(dir) || '/' : dir, prefix: text.slice(cut + 1) }
}

/** A path without its trailing separators. */
function withoutTail(path: string): string {
  return path.replace(/\/+$/, '')
}

/**
 * The path a new checkout gets when the caller names none.
 *
 * The name is what completes the path, so an empty name still shows the
 * directory the checkout will be created in: the field is filled from the
 * moment the dialog opens, and the name simply finishes it.
 * @param root - the machine's checkout root, when the host could name it.
 * @param repoPath - absolute path of the repository on that machine.
 * @param name - the worktree name as it is being typed.
 * @returns the default path, or nothing while it cannot be spelled yet.
 */
function defaultWorktreePath(root: string | undefined, repoPath: string, name: string): string {
  if (root === undefined) return ''
  const repo = withoutTail(repoPath).split('/').pop() ?? repoPath
  const base = `${withoutTail(root)}/${repo}`
  const trimmed = name.trim()
  return trimmed === '' ? `${base}/` : `${base}/${trimmed}`
}
export function AddRepoDialog({ nodeId, busy, onClose, onSubmit, listDirs, t }: {
  nodeId: NodeId
  busy: boolean
  onClose: () => void
  onSubmit: (draft: { nodeId: NodeId; repoPath: string; name?: string }) => Promise<void>
  listDirs: (nodeId: NodeId, path: string) => Promise<DirListing>
  t: T
}) {
  const [repoPath, setRepoPath] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)

  const submit = async (): Promise<void> => {
    setError(undefined)
    try {
      await onSubmit({
        nodeId,
        repoPath: repoPath.trim(),
        ...name.trim() === '' ? {} : { name: name.trim() },
      })
      onClose()
    } catch (failure) {
      setError(reasonOf(failure))
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('addRepository')}
      closeLabel={t('close')}
      footer={(
        <>
          <Button onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" disabled={busy || repoPath.trim() === ''} onClick={() => void submit()}>
            {t('create')}
          </Button>
        </>
      )}
    >
      <div className={css.fields}>
        <DialogError message={error} />
        <Field label={t('fieldRepository')} hint={t('hintRepository')}>
          <Input value={repoPath} onChange={e => setRepoPath(e.target.value)} placeholder={t('placeholderRepoPath')} />
        </Field>
        <DirectoryPicker
          nodeId={nodeId}
          value={repoPath}
          onChange={setRepoPath}
          listDirs={listDirs}
          t={t}
        />
        <Field label={optionalLabel(t, 'fieldName')}>
          <Input value={name} onChange={e => setName(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

/**
 * Cut a worktree from one repository.
 *
 * The path field carries the default the host would use — the machine's
 * checkout root, the repository, and the name — and follows the name while
 * nobody has touched it. Once edited it is the caller's to keep, and clearing
 * it hands it back to the default rather than leaving the host a blank path it
 * would have to guess at. An untouched field sends no path at all, so the
 * machine's own root stays the one source of the default.
 */
export function NewWorktreeDialog({ repo, root, busy, onClose, onSubmit, t }: {
  repo: RepoRecord
  /** The machine's checkout root, when the host could name it. */
  root?: string | undefined
  busy: boolean
  onClose: () => void
  onSubmit: (draft: { repoId: RepoId; name: string; path?: string }) => Promise<void>
  t: T
}) {
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [touched, setTouched] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const fallback = defaultWorktreePath(root, repo.repoPath, name)
  const value = touched ? path : fallback

  const submit = async (): Promise<void> => {
    setError(undefined)
    try {
      await onSubmit({
        repoId: repo.repoId,
        name: name.trim(),
        ...touched && value.trim() !== '' ? { path: value.trim() } : {},
      })
      onClose()
    } catch (failure) {
      setError(reasonOf(failure))
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('newWorktree')}
      description={repo.repoPath}
      closeLabel={t('close')}
      footer={(
        <>
          <Button onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" disabled={busy || name.trim() === ''} onClick={() => void submit()}>
            {t('create')}
          </Button>
        </>
      )}
    >
      <div className={css.fields}>
        <DialogError message={error} />
        <Field label={t('fieldWorktreeName')} hint={t('hintWorktreeName')}>
          <Input value={name} placeholder={t('placeholderWorktreeName')} onChange={e => setName(e.target.value)} />
        </Field>
        <Field label={t('fieldWorktreePath')} hint={t('hintWorktreePath')}>
          <Input
            value={value}
            onChange={(event) => {
              if (event.target.value === '') {
                setTouched(false)
                setPath('')
                return
              }
              setTouched(true)
              setPath(event.target.value)
            }}
          />
        </Field>
      </div>
    </Modal>
  )
}

