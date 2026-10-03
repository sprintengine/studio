import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib'
import { defineConfig, type Plugin, type UserConfig } from 'vite'
import { rendererViteConfig } from './renderer.vite.config'
import { WEB_BUILD_META } from './src/shared/web-client'

// The web client's build (phase 9 spec, 3.1): the renderer as a web app, which
// a Studio server serves to a browser. `npm run build:web` writes it to
// `out/web/`; the server bundle finds it beside itself (`out/server/`), and
// the desktop package leaves it out (package.json's electron-builder files).
//
// It is the desktop renderer's own config (renderer.vite.config.ts), with:
// - `base: './'`, so the app works from any path a proxy puts it under;
// - the app, the pairing page and the canvas worker's document, and not the
//   desktop's splash plate;
// - the two modules that are Electron's swapped for a browser's: `electron`
//   itself (the preload's api modules import `webUtils` from it), and the
//   preload's IPC router, which becomes the tab's router over its socket;
// - the two Node modules the portable canvas service imports, `node:crypto`
//   and `node:path`, swapped for browser stand-ins, for the canvas toolset a
//   tab runs in the page (src/renderer/src/web/canvas/);
// - the app page's `window.api`, installed by a module script of its own ahead
//   of the app's: module scripts run in document order, each graph whole, so
//   the tab's `window.api` is in place where a desktop window's preload puts
//   it, before any app module reads it while it loads (the workspace store's
//   sync client does);
// - every page marked with this build's id (`WEB_BUILD_META`), which the
//   server reads off the page it serves, so a tab can tell when the bundle
//   it was loaded from has been replaced and offer a reload;
// - every text file compressed with brotli and gzip at build time, which the
//   server picks by `Accept-Encoding` and never compresses per request.

// Rollup hands importers over with forward slashes on every OS, where
// `resolve` gives Windows backslashes, so both sides are compared in one form.
const posix = (path: string): string => path.replace(/\\/g, '/')
const ROOT = resolve('.')
const PRELOAD_DIR = posix(resolve('src/preload'))
const WEB_DIR = resolve('src/renderer/src/web')
const OUT_DIR = resolve('out/web')
const SRC_DIR = posix(resolve('src'))
const NODE_STAND_INS: Readonly<Record<string, string>> = {
  'node:crypto': join(WEB_DIR, 'canvas', 'nodeCryptoShim.ts'),
  'node:path': join(WEB_DIR, 'canvas', 'nodePathShim.ts'),
}

/** Electron's modules, as a browser tab has them. */
function browserShellModules(): Plugin {
  return {
    name: 'sprintengine-web-shell-modules',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === 'electron') return join(WEB_DIR, 'electronShim.ts')
      // The app's own modules only: a dependency that imports a Node module is not ours to stand in for.
      if (NODE_STAND_INS[source] && importer && posix(importer).startsWith(SRC_DIR)) return NODE_STAND_INS[source]
      if (source === '../ipc-router' && importer && posix(dirname(importer)).startsWith(PRELOAD_DIR)) {
        return join(WEB_DIR, 'webIpcRouter.ts')
      }
      return null
    },
  }
}

const WEB_API_ENTRY = 'web-api'

/**
 * The web `window.api`'s own module script, ahead of the app's. It is its own
 * entry, not an import of the app's: an import would be bundled into the app's
 * entry chunk, whose imports of other chunks (the workspace store among them)
 * are evaluated before its own code. Two module scripts run in document order,
 * each graph whole, so this one is done before the app's first module runs.
 */
function installWebApiFirst(): Plugin {
  return {
    name: 'sprintengine-web-install-api',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        if (!context.filename.endsWith('index.html') || !context.bundle) return html
        const chunk = Object.values(context.bundle).find(
          (output) => output.type === 'chunk' && output.isEntry && output.name === WEB_API_ENTRY,
        )
        const app = /<script type="module" crossorigin src="[^"]+"><\/script>/u.exec(html)
        if (!chunk || !app) throw new Error('The web build could not place window.api ahead of the app.')
        return html.replace(
          app[0],
          `<script type="module" crossorigin src="./${chunk.fileName}"></script>\n    ${app[0]}`,
        )
      },
    },
  }
}

/**
 * This build's id, in every page: the commit it was built from and a nonce,
 * so a rebuild of the same commit (whose chunk names may differ) is a new
 * build too.
 */
function markBuild(): Plugin {
  let commit = 'nogit'
  try {
    commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim() || commit
  } catch {
    // A source tarball: the nonce alone tells builds apart.
  }
  const id = `${commit}.${randomBytes(6).toString('hex')}`
  return {
    name: 'sprintengine-web-build-id',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { name: WEB_BUILD_META, content: id }, injectTo: 'head-prepend' }],
  }
}

const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg', '.webmanifest', '.txt', '.wasm', '.map'])
const MIN_COMPRESS_BYTES = 1024

function* filesUnder(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* filesUnder(path)
    else yield path
  }
}

/** Write `.br` and `.gz` beside each text file the bundle holds. */
function precompress(): Plugin {
  return {
    name: 'sprintengine-web-precompress',
    apply: 'build',
    closeBundle() {
      for (const file of filesUnder(OUT_DIR)) {
        if (!COMPRESSIBLE.has(extname(file)) || statSync(file).size < MIN_COMPRESS_BYTES) continue
        const bytes = readFileSync(file)
        writeFileSync(
          `${file}.br`,
          brotliCompressSync(bytes, {
            params: { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_SIZE_HINT]: bytes.length },
          }),
        )
        writeFileSync(`${file}.gz`, gzipSync(bytes, { level: 9 }))
      }
    },
  }
}

export default defineConfig((): UserConfig => {
  const base = rendererViteConfig({ client: 'web', devBuild: false })
  return {
    ...base,
    root: resolve('src/renderer'),
    base: './',
    envDir: ROOT,
    build: {
      ...base.build,
      rollupOptions: {
        ...base.build?.rollupOptions,
        input: {
          ...(base.build?.rollupOptions?.input as Record<string, string>),
          [WEB_API_ENTRY]: join(WEB_DIR, 'installWebApi.ts'),
        },
      },
      outDir: OUT_DIR,
      emptyOutDir: true,
      // The source maps stay out of what a server serves; a debug build can turn them on.
      sourcemap: false,
    },
    plugins: [browserShellModules(), installWebApiFirst(), markBuild(), ...(base.plugins ?? []), precompress()],
  }
})
