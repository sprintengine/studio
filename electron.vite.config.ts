import { execFileSync } from 'node:child_process'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'
import type { BuildStamp } from './src/shared/build-stamp'

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
  const value = process.env['MULTICODE_RENDERER_PORT']?.trim()
  if (!value) return 5173

  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 5173
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), buildStampPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    server: {
      port: rendererDevPort(),
      strictPort: process.env['MULTICODE_RENDERER_STRICT_PORT'] === '1',
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
