/**
 * The client bundle is a build artifact the web shell loads through a module
 * loader, so its two contracts are structural: the wrapper must call
 * `window.__ModuleLoader__.load` with this plugin's id, and the loaded module
 * must expose exactly the plugin surface cordis needs.
 *
 * This exercises the real built file — not the source — because the wrapper is
 * what the shell sees, and nothing else in the suite would notice it changing.
 *
 * The shared component library is stubbed rather than imported. Its published
 * artifact is browser-only: it imports CSS Modules, which Node cannot load. The
 * stub keeps this case about the bundle and the plugin surface, which is what
 * this file owns; the components' own behavior belongs to the browser.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createElement, type ReactNode } from 'react'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '../..', 'lib', 'client.js')

/**
 * Read a build output, naming the command that produces it.
 * @param path - absolute path of the artifact.
 * @returns the artifact's text.
 * @throws when the artifact is absent, with the command that creates it.
 */
async function readArtifact(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    throw new Error(`${path} is a build output and is absent; run \`npm run build\` first`)
  }
}


/** Icons the client imports; every one renders an empty svg. */
const ICON_NAMES = [
  'IconBranchOutline16', 'IconChevronDownOutline14', 'IconCloseOutline16', 'IconEllipsisOutline16',
  'IconFolderClose16', 'IconFolderOpen16', 'IconFolderOpenOutline16', 'IconGlobeOutline14',
  'IconLinkOutline16', 'IconPlusOutline16', 'IconProjectAddOutline16', 'IconRefreshOutline16',
  'IconWarningOutline16',
] as const

/**
 * A stand-in for the shared component library.
 *
 * Containers render their children so the section's own structure reaches the
 * markup; a modal renders nothing unless it is open, matching the real atom.
 * @returns the module the bundle's `require` resolves the library to.
 */
function primitivesStub(): Record<string, unknown> {
  const stub: Record<string, unknown> = {
    // An icon-only control carries its name as an attribute rather than as text,
    // which is what the section's own assertions read.
    Button: (props: { children?: ReactNode; title?: string; 'aria-label'?: string }) =>
      createElement('button', { title: props.title, 'aria-label': props['aria-label'] }, props.children),
    Input: () => createElement('input', null),
    StateDot: () => createElement('span', null),
    Menu: (props: { anchor?: ReactNode }) => createElement('span', null, props.anchor),
    Switch: () => createElement('span', null),
    Tag: (props: { children?: ReactNode }) => createElement('span', null, props.children),
    DisclosureRow: (props: { title: string; children?: ReactNode }) =>
      createElement('div', null, props.title, props.children),
    Modal: (props: { open: boolean; title: string; children?: ReactNode }) =>
      props.open ? createElement('div', null, props.title, props.children) : null,
  }
  for (const name of ICON_NAMES) stub[name] = () => createElement('svg', null)
  return stub
}

/** One loader entry the shell hands back. */
interface LoadedEntry {
  readonly id: string
  readonly exports: Record<string, unknown>
}

/** Evaluate the built bundle against a stub loader and return what it loaded. */
async function loadBundle(): Promise<LoadedEntry> {
  const source = await readArtifact(bundlePath)
  const nodeRequire = createRequire(import.meta.url)
  const library = primitivesStub()
  const require = (name: string): unknown =>
    name === '@deepseek-ai/dsh-client-ui-primitives' ? library : nodeRequire(name)
  let loaded: LoadedEntry | undefined
  const window = {
    __ModuleLoader__: {
      load(entry: { id: string; factory: (require: (name: string) => unknown) => Record<string, unknown> }) {
        loaded = { id: entry.id, exports: entry.factory(require) }
      },
    },
  }
  // The bundle is not a module: it is a script that registers itself.
  new Function('window', 'require', source)(window, require)
  assert.notEqual(loaded, undefined, 'the bundle never called window.__ModuleLoader__.load')
  return loaded!
}

/** One resource open the terminal panel asked the right Sidebar for. */
interface OpenedTab {
  readonly address: string
  readonly options: { readonly kind?: string; readonly revealIfOpened?: boolean } | undefined
}

/** The stub context `apply` is driven with. */
function stubContext(): {
  ctx: unknown
  registrations: {
    name: string
    id?: string
    key?: string
    order?: number
    label?: (() => string) | undefined
    inject?: unknown
    component: unknown
  }[]
  tabs: { id: string; kind: string }[]
  locales: { ns: string; dictionaries: Record<string, unknown> }[]
  opened: OpenedTab[]
  focused: string[]
} {
  const registrations: {
    name: string
    id?: string
    key?: string
    order?: number
    label?: (() => string) | undefined
    inject?: unknown
    component: unknown
  }[] = []
  const tabs: { id: string; kind: string }[] = []
  const locales: { ns: string; dictionaries: Record<string, unknown> }[] = []
  const opened: OpenedTab[] = []
  const focused: string[] = []
  const ctx = {
    effect: (factory: () => unknown) => factory(),
    locale: {
      register: (ns: string, dictionaries: Record<string, unknown>) => {
        locales.push({ ns, dictionaries })
        return () => {}
      },
      bind: (ns: string) => (key: string) => `${ns}.${key}`,
    },
    slots: {
      inject: (_slot: string, callback: () => void) => callback(),
      register: (
        definition: { name: string; id?: string; key?: string; order?: number; label?: () => string },
        component: unknown,
      ) => {
        registrations.push({ ...definition, component })
        return () => {}
      },
    },
    sidebarRightTabs: {
      register: (definition: { id: string; kind: string }) => {
        tabs.push(definition)
        return () => {}
      },
    },
    sidebarRight: {
      openResource: (
        address: string,
        options?: { readonly kind?: string; readonly revealIfOpened?: boolean },
      ) => {
        opened.push({ address, options })
      },
      focus: (tabId: string) => {
        focused.push(tabId)
      },
    },
  }
  return { ctx, registrations, tabs, locales, opened, focused }
}

test('the built bundle registers itself under the plugin id', async () => {
  const entry = await loadBundle()
  assert.equal(entry.id, 'dsh-remote-workspace')
})

test('the loaded module exposes exactly the plugin surface', async () => {
  const { exports } = await loadBundle()
  assert.deepEqual(Object.keys(exports).sort(), ['apply', 'inject', 'name'])
  assert.equal(exports['name'], 'dsh-remote-workspace-ui')
  assert.deepEqual(exports['inject'], ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'])
})

test('apply registers the settings section and the terminal tab', async () => {
  const { exports } = await loadBundle()
  const { ctx, registrations, tabs } = stubContext()

  ;(exports['apply'] as (ctx: unknown) => void)(ctx)

  const section = registrations.find(entry => entry.name === 'settings.section')
  assert.equal(section?.id, 'dsh-remote-workspace')
  assert.equal(typeof section?.component, 'function')
  const body = registrations.find(entry => entry.name === 'sidebar.right.pane.tab')
  assert.equal(body?.key, 'dsh-terminal')
  assert.equal(typeof body?.component, 'function')
  assert.deepEqual(tabs.map(tab => [tab.id, tab.kind]), [['dsh-terminal', 'terminal']])
})

test('the terminal panel opens a sibling tab as a duplicate the Sidebar permits', async () => {
  const { exports } = await loadBundle()
  const { ctx, registrations, opened } = stubContext()

  ;(exports['apply'] as (ctx: unknown) => void)(ctx)

  const body = registrations.find(entry => entry.name === 'sidebar.right.pane.tab')
  const face = (body?.inject as (() => { openAnother(): void }) | undefined)?.()
  assert.notEqual(face, undefined, 'the terminal body carries an injected face')
  face?.openAnother()
  face?.openAnother()

  // A page kind deduplicates inside its pane, so the sibling is a resource tab
  // at an address of its own with `revealIfOpened: false` — the option that
  // permits the duplicate.
  assert.equal(opened.length, 2)
  assert.equal(new Set(opened.map(entry => entry.address)).size, 2, 'each sibling gets its own address')
  for (const entry of opened) {
    assert.match(entry.address, /^dsh-resource:\/\/terminal\/tab\/[^/]+$/)
    assert.deepEqual(entry.options, { kind: 'terminal', revealIfOpened: false })
  }
})

test('the terminal panel brings forward the tab already showing a shell', async () => {
  const { exports } = await loadBundle()
  const { ctx, registrations, focused } = stubContext()

  ;(exports['apply'] as (ctx: unknown) => void)(ctx)

  const body = registrations.find(entry => entry.name === 'sidebar.right.pane.tab')
  const face = (body?.inject as (() => { showTab(tabId: string): void }) | undefined)?.()
  face?.showTab('tab-7')
  face?.showTab('tab-9')

  assert.deepEqual(focused, ['tab-7', 'tab-9'], 'the picker focuses the tab that owns the shell')
})

test('the section carries a nav label read from its own dictionary', async () => {
  const { exports } = await loadBundle()
  const { ctx, registrations } = stubContext()

  ;(exports['apply'] as (ctx: unknown) => void)(ctx)

  // Without a label the settings nav renders an empty entry.
  const label = registrations.find(entry => entry.name === 'settings.section')?.label
  assert.equal(typeof label, 'function')
  assert.equal(label?.(), 'dsh-remote-workspace.title')
})

test('apply registers both namespaces, each with both dictionaries', async () => {
  const { exports } = await loadBundle()
  const { ctx, locales } = stubContext()

  ;(exports['apply'] as (ctx: unknown) => void)(ctx)

  assert.deepEqual(locales.map(entry => entry.ns).sort(), ['dsh-remote-workspace', 'dsh-terminal'])
  for (const entry of locales) {
    assert.deepEqual(Object.keys(entry.dictionaries).sort(), ['en', 'zh'])
  }
})

test('the two dictionaries carry the same keys', async () => {
  const { exports } = await loadBundle()
  const { ctx, locales } = stubContext()
  ;(exports['apply'] as (ctx: unknown) => void)(ctx)

  for (const { ns, dictionaries } of locales) {
    assert.deepEqual(
      Object.keys(dictionaries['en'] as object).sort(),
      Object.keys(dictionaries['zh'] as object).sort(),
      `${ns} dictionaries disagree`,
    )
  }
})

test('the section renders its frame with the injected face threaded through', async () => {
  const { exports } = await loadBundle()
  const { ctx, registrations } = stubContext()
  ;(exports['apply'] as (ctx: unknown) => void)(ctx)
  const component = registrations.find(entry => entry.name === 'settings.section')?.component as (props: Record<string, unknown>) => unknown

  // Returning the key makes the assertion independent of either dictionary.
  const face = {
    load: () => Promise.resolve({ nodes: [], statuses: [], repos: [], worktrees: [] }),
    addNode: () => Promise.resolve(),
    removeNode: () => Promise.resolve(),
    connectNode: () => Promise.resolve(),
    disconnectNode: () => Promise.resolve(),
    addRepo: () => Promise.resolve(),
    removeRepo: () => Promise.resolve(),
    openDirectory: () => Promise.resolve(),
    closeDirectory: () => Promise.resolve(),
    listDirs: () => Promise.resolve({ path: '/', entries: [] }),
    createWorktree: () => Promise.resolve(),
    removeWorktree: () => Promise.resolve(),
    openWorktree: () => Promise.resolve(),
    closeWorktree: () => Promise.resolve(),
  }
  // React's server renderer runs the component body without a DOM, which is
  // exactly enough to prove the seats are wired. Effects do not run, so the
  // section is still in its loading state.
  const { renderToStaticMarkup } = await import('react-dom/server')
  const markup = renderToStaticMarkup(
    createElement(component as never, { close: () => {}, t: (key: string) => key, ...face }),
  )

  assert.match(markup, /title/)
  assert.match(markup, /addMachine/)
  assert.match(markup, /refresh/)
  assert.match(markup, /loading/)
})

test('the bundle carries its stylesheet inlined under hashed local names', async () => {
  const source = await readArtifact(bundlePath)

  // A dynamic bundle has no stylesheet channel, so the build compiles the CSS
  // Module into the artifact and attaches one tagged <style> at factory time.
  assert.match(source, /data-plugin-css/)
  // Local names, so nothing this section renders can collide with the shell or
  // another plugin: `drw-section` must not survive into the artifact.
  assert.equal(source.includes('drw-section'), false)
  // The component's truth is the class map it renders from: read the compiled
  // name out of it and require the rule to use the same one. What the hash
  // spells is the compiler's business — it varies with the machine that ran the
  // build — so nothing here names a length or an alphabet.
  const mapped = /"section":\s*"([^"]+)"/.exec(source)
  assert.notEqual(mapped, null, 'the class map carries the section class')
  const name = String(mapped?.[1])
  assert.match(name, /_section$/, 'the local name survives only as a suffix of the compiled one')
  assert.ok(
    source.replace(/\s+/g, '').includes(`.${name}{`),
    `the stylesheet rule uses ${name}`,
  )
})

test('the bundle inlines every dependency the shell does not provide', async () => {
  const source = await readArtifact(bundlePath)
  const required = [...source.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1]).sort()

  // The module table supplies React and the client stack; everything else is
  // inlined, so a bundled helper must not appear as a request.
  for (const name of required) {
    assert.match(String(name), /^(react($|\/)|@deepseek-ai\/)/, `unexpected request "${String(name)}"`)
  }
})
