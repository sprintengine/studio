// Single source of truth for resolving the runtimes Multicode's own features
// run on:
//
//   * Python  — used by Sprint Engine, Switchboard, Multiloop and souls. We
//     ship a self-contained CPython (python-build-standalone) under
//     `resources/runtime/python` so these features work with no user Python.
//   * Node    — used to run our own JS tooling and to install agent CLIs
//     (Codex via npm). We reuse the Node runtime that Electron already embeds
//     (`process.execPath` + ELECTRON_RUN_AS_NODE) rather than bundling a second
//     copy, and ship npm's pure-JS CLI under `resources/runtime/npm` so npm
//     installs work without a user Node install.
//
// Historically every module duplicated a `.venv → system python3` lookup. That
// made the "bundled runtime" story impossible to land in one place and meant a
// user with no Python silently lost whole features. Everything now resolves
// through here, with a deterministic precedence and an explicit `source` so
// callers (and logs) can tell where the runtime came from.
//
// The core resolvers are pure (they take a RuntimeEnv) so they can be unit
// tested without Electron. `currentRuntimeEnv()` adapts the live process; it
// lazily reaches for `electron` so importing this module in a plain Node test
// never requires the Electron binary.

import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { delimiter, join } from 'path'

export type PythonSource = 'override' | 'bundled' | 'venv' | 'system'

export type ResolvedPython = {
  /** Absolute path or bare command (e.g. `python3`) to spawn. */
  command: string
  /** Where the interpreter came from, for diagnostics and telemetry. */
  source: PythonSource
}

export type RuntimeEnv = {
  platform: NodeJS.Platform
  /** electron `process.resourcesPath` (where extraResources land when packaged). */
  resourcesPath: string | undefined
  /** electron `app.isPackaged`. */
  isPackaged: boolean
  /** electron `process.execPath` — the Electron binary, usable as Node. */
  execPath: string
  /** Working directory / dev checkout root used to find `resources/` in dev. */
  cwd: string
  /** Explicit interpreter override (MULTICODE_PYTHON), if set. */
  pythonOverride?: string | undefined
  /** Predicate for path existence (injectable for tests). */
  exists: (path: string) => boolean
}

const PYTHON_OVERRIDE_ENV = 'MULTICODE_PYTHON'

// Where extraResources lands the vendored runtimes. Kept in one place so the
// fetch script (scripts/fetch-runtimes.mjs) and electron-builder config stay in
// sync with the resolver.
export const RUNTIME_RESOURCE_DIR = 'runtime'

function pythonRelativePath(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? join('python', 'python.exe')
    : join('python', 'bin', 'python3')
}

function venvRelativePath(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? join('.venv', 'Scripts', 'python.exe')
    : join('.venv', 'bin', 'python')
}

/**
 * Candidate roots that may contain a vendored `runtime/` directory. Packaged
 * builds only ever use `resourcesPath`; dev checkouts fall back to
 * `<cwd>/resources` so a locally fetched runtime is picked up by `npm run dev`.
 */
function runtimeResourceRoots(env: RuntimeEnv): string[] {
  const roots: string[] = []
  if (env.resourcesPath) roots.push(env.resourcesPath)
  if (!env.isPackaged) roots.push(join(env.cwd, 'resources'))
  return roots
}

/** Absolute path to the bundled CPython interpreter, or null if not vendored. */
export function bundledPythonPath(env: RuntimeEnv): string | null {
  const rel = pythonRelativePath(env.platform)
  for (const root of runtimeResourceRoots(env)) {
    const candidate = join(root, RUNTIME_RESOURCE_DIR, rel)
    if (env.exists(candidate)) return candidate
  }
  return null
}

/** Absolute path to the bundled npm CLI entrypoint, or null if not vendored. */
export function bundledNpmCliPath(env: RuntimeEnv): string | null {
  for (const root of runtimeResourceRoots(env)) {
    const candidate = join(root, RUNTIME_RESOURCE_DIR, 'npm', 'bin', 'npm-cli.js')
    if (env.exists(candidate)) return candidate
  }
  return null
}

/**
 * Resolves the Python interpreter to spawn, in precedence order:
 *   1. MULTICODE_PYTHON override (operator escape hatch / CI).
 *   2. Bundled CPython under resources/runtime (the shipping default).
 *   3. A repo `.venv` at `repoRoot` (dev convenience for contributors).
 *   4. System `python3` (POSIX) / `python` (Windows) on PATH (last resort).
 */
export function resolveManagedPython(env: RuntimeEnv, repoRoot?: string): ResolvedPython {
  const override = env.pythonOverride?.trim()
  if (override) return { command: override, source: 'override' }

  const bundled = bundledPythonPath(env)
  if (bundled) return { command: bundled, source: 'bundled' }

  if (repoRoot) {
    const venv = join(repoRoot, venvRelativePath(env.platform))
    if (env.exists(venv)) return { command: venv, source: 'venv' }
  }

  return { command: env.platform === 'win32' ? 'python' : 'python3', source: 'system' }
}

/**
 * The Node binary to use for our own JS tooling and npm installs. Electron's
 * own executable runs as Node when ELECTRON_RUN_AS_NODE=1 is set (see
 * `managedNodeEnv`), so we never bundle a second Node.
 */
export function managedNodeBinary(env: RuntimeEnv): string {
  return env.execPath
}

/**
 * Environment that turns the Electron binary into a plain Node interpreter.
 * Always returns a fresh object so callers can spread it without mutating the
 * source env.
 */
export function managedNodeEnv(base: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...base, ELECTRON_RUN_AS_NODE: '1' }
}

const PATH_DELIMITER = delimiter

function pathKeyFor(env: Record<string, string>, platform: NodeJS.Platform): string {
  return (
    Object.keys(env).find((key) => key.toLowerCase() === 'path')
    ?? (platform === 'win32' ? 'Path' : 'PATH')
  )
}

/**
 * Prepends a shim directory onto PATH so spawned shells (CLI installers) resolve
 * `node`/`npm` to our managed runtime. Idempotent: a shim dir already present is
 * left in place.
 */
export function withManagedRuntimePath(
  env: Record<string, string>,
  shimDir: string,
  platform: NodeJS.Platform,
): Record<string, string> {
  const pathKey = pathKeyFor(env, platform)
  const current = env[pathKey] ?? ''
  const entries = current.split(PATH_DELIMITER).filter(Boolean)
  if (entries.includes(shimDir)) return env
  return { ...env, [pathKey]: [shimDir, ...entries].join(PATH_DELIMITER) }
}

/** Builds a RuntimeEnv from the live process, lazily consulting Electron. */
export function currentRuntimeEnv(overrides: Partial<RuntimeEnv> = {}): RuntimeEnv {
  let isPackaged = false
  try {
    // Lazy require keeps this module importable from node-only test bundles.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as typeof import('electron')
    isPackaged = Boolean(electron.app?.isPackaged)
  } catch {
    isPackaged = false
  }
  return {
    platform: process.platform,
    resourcesPath: process.resourcesPath,
    isPackaged,
    execPath: process.execPath,
    cwd: process.cwd(),
    pythonOverride: process.env[PYTHON_OVERRIDE_ENV],
    exists: existsSync,
    ...overrides,
  }
}

/** Convenience: resolve managed Python against the live process. */
export function getManagedPython(repoRoot?: string): ResolvedPython {
  return resolveManagedPython(currentRuntimeEnv(), repoRoot)
}

/**
 * Sanitizes a spawn environment for the bundled CPython. python-build-standalone
 * is relocatable and locates its stdlib relative to the executable, but a stray
 * `PYTHONHOME` (set by pyenv/conda/homebrew users) overrides that and points the
 * interpreter at a foreign stdlib — a hard startup failure. We strip it (and
 * `PYTHONSTARTUP`) only for the bundled interpreter; for venv/system Python the
 * user's environment is left untouched.
 */
export function managedPythonSpawnEnv<T extends NodeJS.ProcessEnv>(base: T, source: PythonSource): T {
  if (source !== 'bundled') return base
  const next = { ...base }
  delete next.PYTHONHOME
  delete next.PYTHONSTARTUP
  return next
}

// --- managed Node / npm for CLI installs -----------------------------------
//
// Agent CLIs such as Codex install via `npm install -g`. We run npm on
// Electron's embedded Node (ELECTRON_RUN_AS_NODE) using the vendored npm CLI, so
// a user with no Node can still install them. Two things make that work:
//
//   1. A shim directory (node + npm) prepended to the install shell's PATH.
//   2. A user-writable npm prefix — the vendored npm lives in read-only app
//      resources, so global installs must land somewhere the user owns and that
//      survives app updates.

/** User-writable directory that npm global installs are redirected into. */
export function getManagedNpmPrefixDir(platform: NodeJS.Platform = process.platform): string {
  const override = process.env['MULTICODE_NODE_PREFIX']
  if (override && override.trim()) return override.trim()
  if (platform === 'win32') {
    return join(process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), 'Multicode', 'node')
  }
  return join(homedir(), '.multicode', 'node')
}

/** Directory holding the managed `node`/`npm` shims. */
export function getManagedRuntimeShimDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return join(process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), 'Multicode', 'runtime-bin')
  }
  return join(homedir(), '.multicode', 'runtime-bin')
}

/**
 * Writes `node`/`npm` shims that run the Electron binary as Node, plus a `bin`
 * directory under the writable npm prefix. Returns the shim dir, or null when
 * npm is not vendored (e.g. dev builds before `runtimes:fetch`).
 */
export function ensureManagedRuntimeShims(env: RuntimeEnv = currentRuntimeEnv()): {
  shimDir: string
  prefixBinDir: string
} | null {
  const npmCli = bundledNpmCliPath(env)
  if (!npmCli) return null

  // Never let shim-writing failures (read-only home, AV lock, quota) bubble:
  // this runs on the terminal-launch hot path, mirroring the try/catch in the
  // Sprint Engine shim writers.
  try {
    const node = managedNodeBinary(env)
    const shimDir = getManagedRuntimeShimDir(env.platform)
    const prefixDir = getManagedNpmPrefixDir(env.platform)
    // npm places global bins directly under <prefix> on Windows and <prefix>/bin
    // on POSIX — mirror that so callers can put the right dir on PATH.
    const prefixBinDir = env.platform === 'win32' ? prefixDir : join(prefixDir, 'bin')

    mkdirSync(shimDir, { recursive: true })
    mkdirSync(prefixBinDir, { recursive: true })

    if (env.platform === 'win32') {
      writeFileSync(
        join(shimDir, 'node.cmd'),
        ['@echo off', 'set ELECTRON_RUN_AS_NODE=1', `"${node}" %*`, ''].join('\r\n'),
        'utf8',
      )
      writeFileSync(
        join(shimDir, 'npm.cmd'),
        [
          '@echo off',
          'set ELECTRON_RUN_AS_NODE=1',
          `"${node}" "${npmCli}" --prefix "${prefixDir}" %*`,
          '',
        ].join('\r\n'),
        'utf8',
      )
    } else {
      const nodeShim = join(shimDir, 'node')
      writeFileSync(
        nodeShim,
        ['#!/usr/bin/env bash', `exec env ELECTRON_RUN_AS_NODE=1 ${shellQuote(node)} "$@"`, ''].join('\n'),
        { encoding: 'utf8', mode: 0o755 },
      )
      chmodSync(nodeShim, 0o755)
      const npmShim = join(shimDir, 'npm')
      writeFileSync(
        npmShim,
        [
          '#!/usr/bin/env bash',
          `exec env ELECTRON_RUN_AS_NODE=1 ${shellQuote(node)} ${shellQuote(npmCli)} --prefix ${shellQuote(prefixDir)} "$@"`,
          '',
        ].join('\n'),
        { encoding: 'utf8', mode: 0o755 },
      )
      chmodSync(npmShim, 0o755)
    }

    return { shimDir, prefixBinDir }
  } catch {
    return null
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
