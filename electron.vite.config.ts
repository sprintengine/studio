import { execFileSync } from 'node:child_process'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'
import type { BuildStamp } from './src/shared/build-stamp'
import { readStudioEnv } from './src/shared/studio-env'

const BUILD_STAMP_ID = 'virtual:multicode-build-stamp'
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

// Mints `virtual:multicode-build-stamp` (MC-2182). Rollup re-runs `load` on every
// watch rebuild, so main's stamp follows the bundle it is about to boot; the dev
// server caches its transform instead, so the module is invalidated on any hot
// update and re-minted the next time a document loads it. That makes a window's
// stamp the commit it loaded from, which is what main compares against.
// See src/shared/build-stamp.ts.
function buildStampPlugin(): Plugin {
  return {
    name: 'multicode-build-stamp',
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
    server: {
      port: rendererDevPort(),
      strictPort: readStudioEnv('SPRINTENGINE_RENDERER_STRICT_PORT') === '1',
    },
    build: {
      rollupOptions: {
        // Two HTML entries. `index` is the app; `splash` is the standalone
        // launch plate, which loads no bundle at all — without naming it here
        // the packaged build simply would not emit it, since electron-vite
        // otherwise infers the single implicit `src/renderer/index.html`.
        input: {
          index: resolve('src/renderer/index.html'),
          splash: resolve('src/renderer/splash.html'),
        },
      },
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
      },
    },
    plugins: [react(), tailwindcss(), buildStampPlugin()],
  },
})
