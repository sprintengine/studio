#!/usr/bin/env node
// Builds the Studio server (src/server/main.ts) into one CommonJS file that
// plain Node runs: `node out/server/server.cjs`.
//
// CommonJS, like the main process bundle the same source is built into, so the
// two run the same code the same way: `require` and `__dirname` are real, and a
// dependency is loaded exactly as main loads it. Dependencies stay in
// node_modules beside the checkout (or the app archive) rather than inlined.
//
// `--wsl` builds the other shape: the tree a WSL distribution runs
// (`out/wsl-server/`, phase 7), and an SSH machine too (phase 8), which has
// no node_modules to load from. There
// every dependency is inlined, the two runtime packages a chat loads on first
// use included, and the tree carries the resources the core reads from an
// installed build's resources directory, the stdio bridge's relay, and its
// build identity (`build.json`). The
// app streams it into each distribution once per version.
//
// The build fails if anything the server would load reaches Electron, the
// updater or the terminal's native module, naming the file that imported it:
// the import-graph guard (src/server/electron-boundary.test.ts) says the same
// in the test suite, this says it before a bundle that cannot start is written.

import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = 'src/server/main.ts'
export const DEFAULT_SERVER_OUTFILE = join(ROOT, 'out', 'server', 'server.cjs')
export const DEFAULT_WSL_SERVER_DIR = join(ROOT, 'out', 'wsl-server')

// What the WSL tree carries from resources/, laid out as an installed build's
// resources directory: the MCP bridge agents run to reach the gateway, the
// hook reporters and the Claude plugin a chat is launched with, the CLI
// manifests the providers read, and the skills a launch can deliver.
const WSL_RESOURCES = ['automation', 'hooks', 'plugins', 'studio-plugin', 'builtin-skills']

// What only the desktop shell may load. Reaching one of them from the server
// is a wiring bug, not a missing dependency.
const SHELL_ONLY = /^(electron|electron-updater|node-pty)(\/|$)/

function buildIdentity() {
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  let commit = null
  try {
    commit =
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
  } catch {
    // Not a checkout (a source tarball): the identity says so.
  }
  return { version, commit, builtAt: new Date().toISOString() }
}

const shellOnlyGuard = {
  name: 'studio-server-shell-only',
  setup(context) {
    context.onResolve({ filter: SHELL_ONLY }, (args) => ({
      errors: [
        {
          text: `${relative(ROOT, args.importer) || args.importer} imports ${args.path}, which only the desktop shell can load.`,
        },
      ],
    }))
  },
}

/** Build the server bundle; resolves to the file written. */
export async function buildStudioServer({ outfile = DEFAULT_SERVER_OUTFILE, sourcemap = true } = {}) {
  await build({
    ...common(),
    outfile,
    packages: 'external',
    sourcemap,
    define: { __STUDIO_SERVER_BUILD__: JSON.stringify(buildIdentity()), __STUDIO_SERVER_SELF_CONTAINED__: 'false' },
  })
  return outfile
}

/**
 * Build the tree a WSL distribution runs: `server.cjs` with every dependency
 * inlined, the stdio bridge's relay, and `resources/`. Resolves to the
 * directory, which is replaced whole.
 */
export async function buildWslServerTree({ outDir = DEFAULT_WSL_SERVER_DIR } = {}) {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  // One identity for the bundle and the file beside it: the Windows side
  // reads `build.json` from the tree it ships, and the server says the same
  // identity in its `boot` frame, so a server that is not this exact build
  // (another copy of the app replaced the tree between the launch script's
  // check and its exec) is told apart before it is handed anything.
  const identity = buildIdentity()
  await build({
    ...common(),
    outfile: join(outDir, 'server.cjs'),
    // Inlined, so the tree runs with no node_modules beside it. The ESM
    // runtime packages read `import.meta.url` (to make a `require`), which a
    // CommonJS bundle answers with this file's own URL.
    external: ['electron', 'electron-updater', 'node-pty'],
    sourcemap: false,
    define: {
      __STUDIO_SERVER_BUILD__: JSON.stringify(identity),
      __STUDIO_SERVER_SELF_CONTAINED__: 'true',
      'import.meta.url': '__studioImportMetaUrl',
    },
    banner: { js: "const __studioImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  })
  writeFileSync(join(outDir, 'build.json'), `${JSON.stringify(identity, null, 2)}\n`)
  // The relay: WSL's stdio bridge, and an SSH machine's multiplexing relay
  // (`bridge.mjs --mux`, phase 8), which imports its codec from beside it.
  for (const name of ['bridge.mjs', 'relay-mux.mjs'])
    cpSync(join(ROOT, 'resources', 'wsl-server', name), join(outDir, name))
  for (const name of WSL_RESOURCES) {
    cpSync(join(ROOT, 'resources', name), join(outDir, 'resources', name), { recursive: true })
  }
  return outDir
}

function common() {
  return {
    absWorkingDir: ROOT,
    entryPoints: [ENTRY],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    // Electron's own Node is 24; the floor is what the repository supports.
    target: 'node22.12',
    plugins: [shellOnlyGuard],
    logLevel: 'warning',
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // `--outfile <path>` writes the bundle somewhere else (the smoke test's own copy);
  // `--wsl [--out-dir <dir>]` builds the WSL tree instead.
  if (process.argv.includes('--wsl')) {
    const at = process.argv.indexOf('--out-dir')
    const outDir = await buildWslServerTree(at > 0 ? { outDir: resolve(process.argv[at + 1]) } : {})
    process.stdout.write(`Built ${relative(process.cwd(), outDir) || outDir}\n`)
  } else {
    const at = process.argv.indexOf('--outfile')
    const outfile = await buildStudioServer(at > 0 ? { outfile: resolve(process.argv[at + 1]) } : {})
    process.stdout.write(`Built ${relative(process.cwd(), outfile)}\n`)
  }
}
