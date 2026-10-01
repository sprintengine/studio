import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { build, type Metafile } from 'esbuild'
import { test } from 'vitest'

// The server-bound code must run under plain Node, so none of it may reach
// Electron: not by a static import, a lazy `require('electron')`, or an
// `await import('electron')`, and not through a module it imports. This walks
// the real import graph, the way the app's bundler sees it (imports used only
// as types are erased, as they are in the build), from every server-bound file
// and fails with the path that reaches Electron or a package built on it. A
// load the walk cannot follow, because its target is computed, fails too
// unless it is listed with the reason it cannot reach Electron.
//
// "Server-bound" is what the Studio server design (docs/design/studio-server.md,
// sections 3.1 and 13) says the server owns: the conversation runtime and its
// stores, the providers and the agent launch, checkpoints, the thread index,
// git for chat, the MCP gateway and the tailnet lane, the canvas board store,
// the module host's main halves, settings and credentials, the bundled resource
// lookups, and file search for mentions. The list grows each phase; a file
// moved into src/server/ is covered by its glob.
//
// What stays Electron-bound on purpose is the shell (windows, menus, dialogs,
// the browser pane, terminals, auto-update), the IPC registration in
// src/main/ipc/, the composition root (app-services.ts, until it is split) and
// the entry, which installs the Electron platform the code below reads.

const ROOT = join(__dirname, '..', '..')

/** A path, or a directory ending in `/**` for every source file under it. */
const SERVER_BOUND: readonly string[] = [
  'src/server/**',
  // The conversation runtime, its session API and stores, and its commands.
  'src/main/conversation-runtime.ts',
  'src/main/conversation-session-api.ts',
  'src/main/conversation-event-log.ts',
  'src/main/conversation-transcript-reader.ts',
  'src/main/conversation-persistence.ts',
  'src/main/conversation-attachment-store.ts',
  'src/main/conversation-plan-store.ts',
  'src/main/conversation-approval-rules.ts',
  'src/main/conversation-tool-details.ts',
  'src/main/conversation-model-catalog.ts',
  'src/main/conversation-skills.ts',
  'src/main/conversation-sign-in.ts',
  'src/main/conversation-commands/**',
  // Providers and the agent CLIs they run.
  'src/main/providers/**',
  'src/main/model-discovery/service.ts',
  // Launch.
  'src/main/conversation-launch-service.ts',
  'src/main/agent-launch-service.ts',
  'src/main/terminal-launch.ts',
  'src/main/managed-runtime.ts',
  // Checkpoints, the thread index, git for chat.
  'src/main/conversation-checkpoints.ts',
  'src/main/checkpoint-sweep.ts',
  'src/main/conversation-index.ts',
  'src/main/git-run.ts',
  'src/main/git.ts',
  // The MCP gateway, its tools and audit, and the tailnet lane.
  'src/main/automation/automation-service.ts',
  'src/main/automation/mcp-socket-server.ts',
  'src/main/automation/mcp-dispatch.ts',
  'src/main/automation/studio-gateway-tools.ts',
  'src/main/automation/gateway-audit.ts',
  'src/main/automation/conversation-tools.ts',
  'src/main/automation/canvas-tools.ts',
  'src/main/automation/tailnet/**',
  'src/main/mcp-config-service.ts',
  // The canvas board store and service.
  'src/main/canvas/canvas-service.ts',
  'src/main/canvas/canvas-board-store.ts',
  // The module host's main halves and the bundled modules on it.
  'src/main/module-host/main-host.ts',
  'src/main/module-host/load-modules.ts',
  'src/main/module-host/module-conversation-service.ts',
  'src/main/module-host/module-storage.ts',
  'src/main/module-host/module-secrets.ts',
  'src/main/module-host/enablement-store.ts',
  'src/main/modules/agent-runtime-module.ts',
  'src/main/modules/scheduled-agents-module.ts',
  'src/main/modules/third-party-main-loader.ts',
  // Settings and credentials.
  'src/main/launch-settings-store.ts',
  'src/main/workspace-registry-store.ts',
  'src/main/secret-store.ts',
  'src/main/github-token-store.ts',
  'src/main/diagnostics-service.ts',
  // Bundled resources.
  'src/main/plugin-registry-instance.ts',
  'src/main/builtin-skills.ts',
  'src/main/ripgrep-binary.ts',
  'src/main/marketplace/resources.ts',
  'src/main/marketplace/trusted-publishers.ts',
  // File search for @-mentions.
  'src/main/conversation-mentions.ts',
  'src/main/filesystem-search.ts',
]

// Electron itself and the packages built on it: `electron/main`, `@electron/*`,
// `electron-updater` and the other `electron-*` helpers.
const ELECTRON = (specifier: string): boolean =>
  specifier === 'electron' ||
  specifier.startsWith('electron/') ||
  specifier.startsWith('electron-') ||
  specifier.startsWith('@electron/')

// A load whose target is computed (`require(name)`, `import(path)`, a
// `createRequire` loader) is invisible to the walk, so each one in server-bound
// code is either refused or listed here with why it cannot reach Electron.
const COMPUTED_LOADS_ALLOWED: Readonly<Record<string, string>> = {
  // Loads a third-party module's `entry.main` from its install folder, after
  // the containment and signature checks. What that module imports is decided
  // at load time by a host capability (owner default 2026-10-01: a server skips
  // the main half of a module that needs Electron), not by this walk.
  'src/main/modules/third-party-main-loader.ts': 'a third-party entry.main, loaded by path',
}

function sourceFilesUnder(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name !== '__fixtures__') files.push(...sourceFilesUnder(path))
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|test-helper|d)\.tsx?$/.test(entry.name)) {
      files.push(path)
    }
  }
  return files
}

function expand(patterns: readonly string[]): string[] {
  return patterns.flatMap((pattern) => {
    if (pattern.endsWith('/**')) {
      const directory = pattern.slice(0, -'/**'.length)
      assert.ok(statSync(join(ROOT, directory)).isDirectory(), `${pattern}: no such directory`)
      return sourceFilesUnder(directory)
    }
    assert.ok(existsSync(join(ROOT, pattern)), `${pattern} is listed as server-bound but does not exist`)
    return [pattern]
  })
}

async function importGraph(entryPoints: string[]): Promise<Metafile['inputs']> {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints,
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    // A package is a leaf: only its name matters, and `electron` is one.
    packages: 'external',
    // Minted by a build plugin; there is nothing on disk to resolve.
    external: ['virtual:*'],
    outdir: 'electron-boundary',
    logLevel: 'silent',
  })
  return result.metafile.inputs
}

// `require(`, `import(` or `createRequire(` followed by anything but a quote:
// the target is computed (a template literal counts, interpolated or not). A
// `createRequire` loader is matched by its maker, since it can be called anything.
const COMPUTED_LOAD = /\b(?:require|import)\s*\(\s*(?!['"])|\bcreateRequire\s*\(/

/** Source text with comments blanked, so prose that says "require()" is not a load. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

/**
 * Every load in the walked files whose target is not a string the walk can
 * follow. The bundler leaves these alone without a word when it targets Node,
 * so the walked sources are read for them.
 */
function computedLoads(inputs: Metafile['inputs']): string[] {
  const found: string[] = []
  for (const file of Object.keys(inputs)) {
    if (!/\.tsx?$/.test(file) || Object.hasOwn(COMPUTED_LOADS_ALLOWED, file)) continue
    withoutComments(readFileSync(join(ROOT, file), 'utf8'))
      .split('\n')
      .forEach((line, index) => {
        if (COMPUTED_LOAD.test(line)) found.push(`${file}:${index + 1}: ${line.trim()}`)
      })
  }
  return found
}

/** The import chain from `entry` to Electron, or null when there is none. */
function pathToElectron(inputs: Metafile['inputs'], entry: string): string[] | null {
  const via = new Map<string, string | null>([[entry, null]])
  const queue = [entry]
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const imported of inputs[file]?.imports ?? []) {
      if (imported.external) {
        if (!ELECTRON(imported.path)) continue
        const chain = [`${imported.path} (${imported.kind})`]
        for (let step: string | null | undefined = file; step; step = via.get(step)) chain.unshift(step)
        return chain
      }
      if (!via.has(imported.path)) {
        via.set(imported.path, file)
        queue.push(imported.path)
      }
    }
  }
  return null
}

test('no server-bound file reaches electron, directly or through what it imports', async () => {
  const files = expand(SERVER_BOUND)
  const inputs = await importGraph(files)
  const reached = files.flatMap((file) => {
    const chain = pathToElectron(inputs, file)
    return chain ? [`${file}:\n    ${chain.join('\n      -> ')}`] : []
  })
  assert.deepEqual(
    reached,
    [],
    `Server-bound code must not import electron. Take what it needs from the Studio platform ` +
      `(src/server/platform/) instead:\n  ${reached.join('\n  ')}`,
  )
})

test('the walk does find electron where it is', async () => {
  // So the guard above cannot pass because the walk saw nothing: the
  // composition root is still Electron's, by a static import.
  const inputs = await importGraph(['src/main/app-services.ts'])
  assert.deepEqual(pathToElectron(inputs, 'src/main/app-services.ts')?.at(-1), 'electron (import-statement)')
})

test('no server-bound file loads something the walk cannot follow, unless it is listed with a reason', async () => {
  const inputs = await importGraph(expand(SERVER_BOUND))
  assert.deepEqual(
    computedLoads(inputs),
    [],
    'A require() or import() with a computed argument, or a createRequire loader, could reach electron without ' +
      'the walk seeing it. Load by a string literal, or list the file in COMPUTED_LOADS_ALLOWED with why it cannot.',
  )
  for (const file of Object.keys(COMPUTED_LOADS_ALLOWED)) {
    assert.ok(inputs[file], `${file} is allowed a computed load but is not server-bound any more`)
  }
})
