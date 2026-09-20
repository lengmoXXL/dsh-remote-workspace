/**
 * Build configuration for both halves of the plugin.
 *
 * The host half is one Node program the Harness Loader mounts by package name,
 * so the shared wire contracts and the terminal seam travel inside it and every
 * Harness package stays external — the profile already has exactly one copy of
 * each, and a second would break service identity. `ws` is a real dependency
 * and stays external too; `node-pty` is reached through the terminal provider
 * this bundle inlines.
 *
 * The client half is the bundle below. The web shell loads a plugin's client
 * bundle through a module loader it installs on `window`, so the artifact must
 * be one CommonJS factory call rather than an ES module: `react` and every
 * `@deepseek-ai/*` package are resolved through the `require` the loader hands
 * the factory, and everything else — xterm.js included — is inlined.
 *
 * A dynamic bundle has no stylesheet channel, so CSS is compiled here instead
 * of being emitted as a file. Two shapes arrive: `*.module.css`, whose local
 * names Lightning CSS hashes into a class map, and plain stylesheets such as
 * xterm's own, which are injected as written. Both become a module that
 * attaches one tagged `<style>` to the document the first time the factory
 * runs, which keeps the components on the same CSS Modules contract the in-repo
 * client packages use — local names, semantic `--dsw-*` tokens, no global
 * leakage.
 *
 * @module dsh-remote-workspace/build
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'

/** The id the client module system keys this bundle by: the package name. */
const ID = '@lengmoxxl/dsh-remote-workspace'

/**
 * Virtual-id wrapper keeping CSS away from tsdown's own css pipeline. The
 * suffix matters: tsdown's guard matches ids ending in `.css`, so the virtual
 * id must not. The mark after the prefix records whether the file is a CSS
 * Module.
 */
const CSS_VIRTUAL_PREFIX = '\0drw-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const MODULE_MARK = 'module:'
const PLAIN_MARK = 'plain:'

const require = createRequire(import.meta.url)

/**
 * Emit one plugin-owned style injector, plus the compiled class map for a CSS
 * Module.
 * @param fileId - the absolute path of the stylesheet.
 * @param css - the compiled CSS text.
 * @param classMap - local-to-hashed names, or null for a plain stylesheet.
 * @returns the generated module's source.
 */
function styleInjectionModule(
  fileId: string,
  css: string,
  classMap: Readonly<Record<string, string>> | null,
): string {
  const tagId = `${ID}/${basename(fileId)}`
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    'if (typeof document !== \'undefined\') {',
    '  const selector = \'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\';',
    '  const existing = document.querySelector(selector);',
    '  if (existing === null) {',
    '    const tag = document.createElement(\'style\');',
    `    tag.dataset.plugin = ${JSON.stringify(ID)};`,
    '    tag.dataset.pluginCss = tagId;',
    '    tag.textContent = css;',
    '    document.head.appendChild(tag);',
    '  } else {',
    // A hot-swapped bundle runs in a document that still holds the tag an
    // earlier build injected. Keyed by module name alone, that tag would leave
    // the page styled by the build it was loaded with while running the newest
    // code — so the stylesheet is replaced in place.
    '    existing.textContent = css;',
    '  }',
    '}',
    classMap === null ? '' : `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
}

/**
 * Resolve every stylesheet import to this plugin's virtual module.
 *
 * A bare specifier is resolved the way the runtime would resolve it, so
 * xterm's packaged stylesheet is found without this plugin restating the path.
 */
function cssInline() {
  return {
    name: 'drw-css-inline',
    resolveId(source: string, importer: string | undefined): string | null {
      if (!source.endsWith('.css')) return null
      const fileId = isAbsolute(source) || source.startsWith('.')
        ? resolvePath(dirname(importer ?? '.'), source)
        : require.resolve(source)
      const mark = source.endsWith('.module.css') ? MODULE_MARK : PLAIN_MARK
      return `${CSS_VIRTUAL_PREFIX}${mark}${fileId}${CSS_VIRTUAL_SUFFIX}`
    },
    async load(virtualId: string): Promise<string | null> {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const rest = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      const modules = rest.startsWith(MODULE_MARK)
      const fileId = rest.slice((modules ? MODULE_MARK : PLAIN_MARK).length)
      // A virtual id otherwise hides the physical stylesheet from the watcher.
      this.addWatchFile(fileId)
      const { code, exports } = transform({
        filename: fileId,
        code: await readFile(fileId),
        ...modules ? { cssModules: { pattern: '[hash]_[local]' } } : {},
        minify: true,
      })
      if (!modules) return styleInjectionModule(fileId, code.toString(), null)
      const classMap: Record<string, string> = {}
      // Lightning CSS hands the map back in an unstable order, and lib/ is
      // committed: sorting keeps a rebuild byte-identical to the last one.
      const locals = Object.entries(exports ?? {}).sort(([left], [right]) => left.localeCompare(right))
      for (const [local, exported] of locals) classMap[local] = exported.name
      return styleInjectionModule(fileId, code.toString(), classMap)
    },
  }
}

const host = defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // `package.json` names `lib/index.d.ts`, so the declaration must exist.
  dts: true,
  sourcemap: true,
  // The host half owns `clean` for the shared output directory; the client half
  // below must not wipe what this one wrote.
  clean: true,
  // `package.json` names `lib/index.js`, which is the convention a profile
  // install expects; the package is `type: module`, so `.js` is already ESM.
  outExtensions: () => ({ js: '.js' }),
  // `node-pty` carries a native binding and stays external: inlining a `.node`
  // binary is not a thing a bundler does, and its own loader resolves prebuilds
  // relative to the package directory.
  deps: { neverBundle: [/^@deepseek-ai\//, /^node-pty$/] },
  outputOptions: {
    banner: '// dsh-remote-workspace host half',
  },
})

const client = defineConfig({
  entry: { client: 'src/plugin/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  // The web shell fetches this artifact by the `exports["./client"]` path, so
  // it keeps the `.js` spelling the profile manifest names.
  outExtensions: () => ({ js: '.js' }),
  deps: {
    // React and the client stack are the shell's, not ours: a second copy would
    // break hooks and duplicate the renderer. xterm.js is nobody else's, so it
    // travels inside this bundle.
    neverBundle: [/^react($|\/)/, /^@deepseek-ai\//],
    alwaysBundle: [/^@xterm\//],
    onlyBundle: [/^@xterm\//],
  },
  plugins: [cssInline()],
  outputOptions: {
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
    footer: 'return module.exports; } });',
  },
})

export default [host, client]
