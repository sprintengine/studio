#!/usr/bin/env node
// Builds the Studio server (src/server/main.ts) into one CommonJS file that
// plain Node runs: `node out/server/server.cjs`.
//
// CommonJS, like the main process bundle the same source is built into, so the
// two run the same code the same way: `require` and `__dirname` are real, and a
// dependency is loaded exactly as main loads it. Dependencies stay in
// node_modules beside the checkout (or the app archive) rather than inlined; a
// bundle that carries its own for a host with no node_modules (a WSL
// distribution, an SSH host) is a later phase's packaging.
//
// The build fails if anything the server would load reaches Electron, the
// updater or the terminal's native module, naming the file that imported it:
// the import-graph guard (src/server/electron-boundary.test.ts) says the same
// in the test suite, this says it before a bundle that cannot start is written.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = 'src/server/main.ts'
export const DEFAULT_SERVER_OUTFILE = join(ROOT, 'out', 'server', 'server.cjs')

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
    absWorkingDir: ROOT,
    entryPoints: [ENTRY],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    // Electron's own Node is 24; the floor is what the repository supports.
    target: 'node22.12',
    packages: 'external',
    sourcemap,
    define: { __STUDIO_SERVER_BUILD__: JSON.stringify(buildIdentity()) },
    plugins: [shellOnlyGuard],
    logLevel: 'warning',
  })
  return outfile
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // `--outfile <path>` writes the bundle somewhere else (the smoke test's own copy).
  const at = process.argv.indexOf('--outfile')
  const outfile = await buildStudioServer(at > 0 ? { outfile: resolve(process.argv[at + 1]) } : {})
  process.stdout.write(`Built ${relative(process.cwd(), outfile)}\n`)
}
