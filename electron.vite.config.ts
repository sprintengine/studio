import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'
import type { BuildStamp } from './src/shared/build-stamp'
import { readStudioEnv } from './src/shared/studio-env'

const BUILD_STAMP_ID = 'virtual:sprintengine-build-stamp'
const RESOLVED_BUILD_STAMP_ID = `\0${BUILD_STAMP_ID}`

// electron-vite sets this before it loads this config: `development` for
// `electron-vite dev`, `production` for `electron-vite build`.
const isDevBuild = process.env['NODE_ENV_ELECTRON_VITE'] === 'development'

// One stamp per production build, shared by main/preload/renderer — they are
// three rollup runs in one process, and a packaged app whose halves disagreed
// would nag forever. In dev the halves are built at different moments on
// purpose, so each one is stamped when it is actually generated.
let productionBuildStamp: BuildStamp | null = null

function mintBuildStamp(): BuildStamp {
  let commit: string | null = null
  try {
    commit =
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
  } catch {
    // No git, or not a checkout (a source tarball). The stamp says so rather
    // than inventing an identity — main skips the comparison instead of
    // comparing two unknowns and calling them equal.
    commit = null
  }
  return {
    commit,
    source: commit ? 'git' : 'unavailable',
    builtAt: new Date().toISOString(),
    mode: isDevBuild ? 'development' : 'production',
  }
}

// Mints `virtual:sprintengine-build-stamp`. Rollup re-runs `load` on every
// watch rebuild, so main's stamp follows the bundle it is about to boot; the dev
// server caches its transform instead, so the module is invalidated on any hot
// update and re-minted the next time a document loads it. That makes a window's
// stamp the commit it loaded from, which is what main compares against.
// See src/shared/build-stamp.ts.
function buildStampPlugin(): Plugin {
  return {
    name: 'sprintengine-build-stamp',
    resolveId(id) {
      return id === BUILD_STAMP_ID ? RESOLVED_BUILD_STAMP_ID : null
    },
    load(id) {
      if (id !== RESOLVED_BUILD_STAMP_ID) return null
      const stamp = isDevBuild ? mintBuildStamp() : (productionBuildStamp ??= mintBuildStamp())
      return `export const buildStamp = ${JSON.stringify(stamp)}\n`
    },
    handleHotUpdate({ server }) {
      const module = server.moduleGraph.getModuleById(RESOLVED_BUILD_STAMP_ID)
      // Invalidate only — deliberately not added to the update set, so a hot
      // update stays a hot update and the page is not reloaded to re-read a
      // diagnostic. The fresh stamp lands with the next document load.
      if (module) server.moduleGraph.invalidateModule(module)
      return undefined
    },
  }
}

// The canvas editor's scene fonts. `@excalidraw/excalidraw` does not import
// these files — it builds `<window.EXCALIDRAW_ASSET_PATH>fonts/<Family>/<file>`
// at runtime and hands it to the FontFace API, appending a public CDN as the
// last candidate for anything that misses (see src/renderer/src/canvasAssetPath.ts).
// Nothing in the module graph points at them, so the bundler never sees them,
// and an offline desktop app that leaned on the fallback would draw in the
// wrong face. They are therefore placed next to the renderer documents by hand.
//
// Read out of node_modules rather than copied into the tree: these are ~500 KB
// of binaries that belong to the dependency, and a checked-in copy is a second
// thing to remember on every upgrade. The one plugin covers dev and build, and
// every renderer HTML entry with them, because each document resolves the same
// `fonts/` directory beside itself.
const CANVAS_FONTS_DIR = resolve('node_modules/@excalidraw/excalidraw/dist/prod/fonts')

// The CJK family is ~12 MB — about twenty-five times the rest of that directory
// together — and covers scripts none of the hand-drawn families reach. Carrying
// it in every installer to make a rare board render without a system fallback is
// not a trade worth making.
const CANVAS_FONTS_SKIPPED_FAMILIES = new Set(['Xiaolai'])

// The three families the agent format can ask for, by the directory name the
// package gives them (src/renderer/src/canvasWorker/skeletonMap.ts maps the
// file format's numeric ids onto their CSS names). The worker waits for these
// and only these before it answers, so a rename in the dependency has to fail
// the build rather than ship a worker that measures every label in a fallback
// face — the one degradation nothing on screen shows.
const CANVAS_FONTS_REQUIRED_FAMILIES = ['Excalifont', 'Nunito', 'ComicShanns']

// No family we ship is anywhere near this; the skipped CJK set is twenty-five
// times it. So this catches the case the skip list cannot: a family renamed in
// the dependency, which would fall through the skip list and quietly put twelve
// megabytes in every installer.
const CANVAS_FONTS_MAX_FAMILY_BYTES = 3 * 1024 * 1024

function canvasSceneFontFiles(): Array<{ urlPath: string; filePath: string }> {
  const families = readdirSync(CANVAS_FONTS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  const present = new Set(families.map((family) => family.name))
  const missing = CANVAS_FONTS_REQUIRED_FAMILIES.filter((family) => !present.has(family))
  if (missing.length > 0) {
    throw new Error(
      `The canvas scene fonts are missing ${missing.join(', ')} in ${CANVAS_FONTS_DIR}. ` +
        `The editor package's font directories have been renamed; update CANVAS_FONTS_REQUIRED_FAMILIES ` +
        `and the family names in src/renderer/src/canvasWorker/skeletonMap.ts together.`,
    )
  }

  const files: Array<{ urlPath: string; filePath: string }> = []
  for (const family of families) {
    if (CANVAS_FONTS_SKIPPED_FAMILIES.has(family.name)) continue
    let familyBytes = 0
    const inFamily: Array<{ urlPath: string; filePath: string }> = []
    for (const file of readdirSync(join(CANVAS_FONTS_DIR, family.name))) {
      if (!file.endsWith('.woff2')) continue
      const filePath = join(CANVAS_FONTS_DIR, family.name, file)
      familyBytes += statSync(filePath).size
      inFamily.push({ urlPath: `fonts/${family.name}/${file}`, filePath })
    }
    if (familyBytes > CANVAS_FONTS_MAX_FAMILY_BYTES) {
      throw new Error(
        `The canvas scene font family ${family.name} is ${Math.round(familyBytes / (1024 * 1024))} MB, ` +
          `over the ${CANVAS_FONTS_MAX_FAMILY_BYTES / (1024 * 1024)} MB one family may be. ` +
          `A large family belongs in CANVAS_FONTS_SKIPPED_FAMILIES, not in every installer.`,
      )
    }
    files.push(...inFamily)
  }
  return files
}

function canvasSceneFontsPlugin(): Plugin {
  return {
    name: 'sprintengine-canvas-scene-fonts',
    // Dev: the renderer root is src/renderer, which has no fonts directory, so
    // the requests are answered from node_modules. The table doubles as the
    // allowlist — a request that is not one of the files the build emits falls
    // through to the rest of the dev server rather than reaching the disk.
    configureServer(server) {
      const byUrlPath = new Map(canvasSceneFontFiles().map((f) => [`/${f.urlPath}`, f.filePath]))
      server.middlewares.use((req, res, next) => {
        const filePath = byUrlPath.get((req.url ?? '').split('?')[0])
        if (!filePath) {
          next()
          return
        }
        res.setHeader('Content-Type', 'font/woff2')
        res.end(readFileSync(filePath))
      })
    },
    // Build: emitted at the bundle root, not under `assets/`, and unhashed —
    // the URL the editor builds names the family and file itself, so these two
    // are the parts of the layout that are not ours to choose.
    generateBundle() {
      for (const { urlPath, filePath } of canvasSceneFontFiles()) {
        this.emitFile({ type: 'asset', fileName: urlPath, source: readFileSync(filePath) })
      }
    },
  }
}

function rendererDevPort(): number {
  const value = readStudioEnv('SPRINTENGINE_RENDERER_PORT')?.trim()
  if (!value) return 5173

  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 5173
}

// Build-time defaults for the two services main talks to (src/main/service-endpoints.ts).
// Set MULTIAUTH_BASE_URL / SPRINTENGINE_MOBILE_RELAY_URL in the build environment to bake a
// fork's own deployments in; unset, the shipped defaults are used. Both stay overridable
// at runtime by the same env names, so this only moves where the fallback comes from.
function serviceEndpointDefines(): Record<string, string> {
  const defines: Record<string, string> = {}
  const accountService = process.env['MULTIAUTH_BASE_URL']?.trim()
  const relay = readStudioEnv('SPRINTENGINE_MOBILE_RELAY_URL')?.trim()
  if (accountService) defines['__MULTIAUTH_BASE_URL__'] = JSON.stringify(accountService)
  if (relay) defines['__MOBILE_RELAY_URL__'] = JSON.stringify(relay)
  return defines
}

// `build.publish` in package.json is what electron-builder turns into
// app-update.yml, and app-update.yml is what electron-updater follows. The app
// also shows a "releases" link, which has to point at the same repository or it
// sends people somewhere the updater is not looking — a wrong value there is
// invisible at runtime, which is how builds up to 0.1.7 shipped pointing at a
// private repo and silently never updated. So the constant the app links to is
// checked against the manifest here, and a disagreement fails the build.
function assertReleasesRepoMatchesManifest(): void {
  const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf-8')) as {
    build?: { publish?: { owner?: string; repo?: string } }
  }
  const publish = manifest.build?.publish
  if (!publish?.owner || !publish?.repo) {
    throw new Error('package.json build.publish must name an owner and a repo.')
  }
  const fromManifest = `${publish.owner}/${publish.repo}`
  const source = readFileSync(resolve('src/shared/releases-repo.ts'), 'utf-8')
  const declared = /export const RELEASES_REPO = '([^']+)'/u.exec(source)?.[1]
  if (declared !== fromManifest) {
    throw new Error(
      `RELEASES_REPO is '${declared}' but package.json build.publish names '${fromManifest}'. ` +
        'Update src/shared/releases-repo.ts so the in-app link and the updater follow the same repository.',
    )
  }
}

assertReleasesRepoMatchesManifest()

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), buildStampPlugin()],
    define: serviceEndpointDefines(),
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // Two preloads: the app's, and the browser guest's element picker
        // (browser-pane epic), which main hands to the <webview> as a file
        // URL and pins in `will-attach-webview`.
        input: {
          index: resolve('src/preload/index.ts'),
          'browser-guest': resolve('src/preload/browser-guest.ts'),
        },
      },
    },
  },
  renderer: {
    esbuild: { keepNames: true },
    server: {
      port: rendererDevPort(),
      strictPort: readStudioEnv('SPRINTENGINE_RENDERER_STRICT_PORT') === '1',
    },
    build: {
      // React 19 publishes unminified production builds and leaves minifying to
      // the bundler; React 18's pre-minified files had hidden that this build
      // never minified. `keepNames` keeps `fn.name` and class names intact for
      // anything that reads them at runtime.
      minify: 'esbuild',
      rollupOptions: {
        // The HTML entries. `index` is the app; `splash` is the standalone
        // launch plate, which loads no bundle at all — without naming it here
        // the packaged build simply would not emit it, since electron-vite
        // otherwise infers the single implicit `src/renderer/index.html`.
        // The hidden canvas worker document joins this list as a third entry;
        // it needs nothing else from this config, since the scene fonts sit
        // beside every document and the asset-path bootstrap is a module it
        // imports for itself.
        input: {
          index: resolve('src/renderer/index.html'),
          splash: resolve('src/renderer/splash.html'),
          'canvas-worker': resolve('src/renderer/canvas-worker.html'),
        },
      },
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
      },
    },
    optimizeDeps: {
      // Pre-bundled up front rather than on the first Canvas tab: the editor's
      // graph is large enough (it carries its own diagram importer) that
      // discovering it mid-session costs a full dev-server reload.
      include: ['@excalidraw/excalidraw'],
      esbuildOptions: {
        // The dep optimizer pre-bundles against Vite's browser matrix
        // (es2020 + chrome87/safari14/firefox78/edge88), which is well below
        // what Electron 41 runs and makes esbuild down-level a graph this size
        // on every cold start. The renderer has exactly one browser, so the
        // transform buys nothing here.
        target: 'es2022',
      },
    },
    plugins: [react(), tailwindcss(), buildStampPlugin(), canvasSceneFontsPlugin()],
  },
})
