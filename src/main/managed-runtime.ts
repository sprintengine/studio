// Single source of truth for resolving the Node runtime the studio's own
// features run on. Node is used to run our own JS tooling and to install agent
// CLIs (Codex via npm). We reuse the Node runtime that Electron already embeds
// (`process.execPath` + ELECTRON_RUN_AS_NODE) rather than bundling a second
// copy, and ship npm's pure-JS CLI under `resources/runtime/npm` so npm
// installs work without a user Node install.
//
// The core resolvers are pure (they take a RuntimeEnv) so they can be unit
// tested without Electron. `currentRuntimeEnv()` adapts the live process and
// the installed platform; with no platform installed (a plain Node test) it
// answers as a source checkout.

import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { delimiter, join } from 'path'
import { readStudioEnv } from '../shared/studio-env'
import { installedStudioPlatform } from '../server/platform/platform'

export type RuntimeEnv = {
  platform: NodeJS.Platform
  /** The platform's resources root (`process.resourcesPath`, where extraResources land, in the desktop). */
  resourcesPath: string | undefined
  /** The platform's `isPackaged` (`app.isPackaged` in the desktop). */
  isPackaged: boolean
  /** `process.execPath`: the Electron binary in the desktop, usable as Node; Node itself in a standalone server. */
  execPath: string
  /**
   * Whether `execPath` is Electron, which runs as Node only with
   * `ELECTRON_RUN_AS_NODE=1`. Absent means it is. A server on plain Node writes
   * shims without the flag, so nothing an install starts inherits it.
   */
  execPathIsElectron?: boolean
  /** Working directory / dev checkout root used to find `resources/` in dev. */
  cwd: string
  /** Predicate for path existence (injectable for tests). */
  exists: (path: string) => boolean
}

// Where extraResources lands the vendored runtimes. Kept in one place so the
// fetch script (scripts/fetch-runtimes.mjs) and electron-builder config stay in
// sync with the resolver.
const RUNTIME_RESOURCE_DIR = 'runtime'

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

/** Absolute path to the bundled npm CLI entrypoint, or null if not vendored. */
export function bundledNpmCliPath(env: RuntimeEnv): string | null {
  for (const root of runtimeResourceRoots(env)) {
    const candidate = join(root, RUNTIME_RESOURCE_DIR, 'npm', 'bin', 'npm-cli.js')
    if (env.exists(candidate)) return candidate
  }
  return null
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
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? (platform === 'win32' ? 'Path' : 'PATH')
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

/** Builds a RuntimeEnv from the live process and the installed platform. */
export function currentRuntimeEnv(overrides: Partial<RuntimeEnv> = {}): RuntimeEnv {
  const paths = installedStudioPlatform()?.paths
  return {
    platform: process.platform,
    resourcesPath: paths?.resourcesDir() ?? undefined,
    isPackaged: paths?.isPackaged() ?? false,
    execPath: process.execPath,
    execPathIsElectron: Boolean(process.versions.electron),
    // A server's working directory is wherever it was started from; its app
    // root is the checkout it runs from. In the desktop the two are the same.
    cwd: paths?.appRoot() ?? process.cwd(),
    exists: existsSync,
    ...overrides,
  }
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
function getManagedNpmPrefixDir(platform: NodeJS.Platform = process.platform): string {
  const override = readStudioEnv('SPRINTENGINE_NODE_PREFIX')
  if (override && override.trim()) return override.trim()
  if (platform === 'win32') {
    return join(process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), 'SprintEngine', 'node')
  }
  return join(homedir(), '.sprintengine', 'node')
}

/** Directory holding the managed `node`/`npm` shims. */
export function getManagedRuntimeShimDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return join(process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), 'SprintEngine', 'runtime-bin')
  }
  return join(homedir(), '.sprintengine', 'runtime-bin')
}

/**
 * Shim sets already on disk in this run, keyed by everything their content is
 * made from. The writes below are synchronous and on the main thread, and they
 * used to run on every terminal launch and on every CLI probe, of which a
 * single availability refresh starts about ten. On Windows each rewrite of a
 * `.cmd` is also a fresh file for the virus scanner to open, so the same two
 * files were written and scanned again and again with identical bytes, while
 * the keyboard waited behind them.
 */
const writtenShims = new Map<string, { shimDir: string; prefixBinDir: string }>()

/**
 * Writes `node`/`npm` shims that run this process's Node (the Electron binary
 * as Node, in the desktop), plus a `bin`
 * directory under the writable npm prefix. Returns the shim dir, or null when
 * npm is not vendored (e.g. dev builds before `runtimes:fetch`).
 *
 * Writes once per run for a given set of inputs; later calls answer from memory.
 */
export function ensureManagedRuntimeShims(env: RuntimeEnv = currentRuntimeEnv()): {
  shimDir: string
  prefixBinDir: string
} | null {
  const npmCli = bundledNpmCliPath(env)
  if (!npmCli) return null

  const runAsNode = env.execPathIsElectron !== false
  const writtenKey = [
    env.platform,
    managedNodeBinary(env),
    runAsNode ? 'electron' : 'node',
    npmCli,
    getManagedRuntimeShimDir(env.platform),
    getManagedNpmPrefixDir(env.platform),
  ].join('\n')
  const written = writtenShims.get(writtenKey)
  if (written) return { ...written }

  // Never let shim-writing failures (read-only home, AV lock, quota) bubble:
  // this runs on the terminal-launch hot path, mirroring the try/catch in the
  // shim writers.
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
        ['@echo off', ...(runAsNode ? ['set ELECTRON_RUN_AS_NODE=1'] : []), `"${node}" %*`, ''].join('\r\n'),
        'utf8',
      )
      writeFileSync(
        join(shimDir, 'npm.cmd'),
        [
          '@echo off',
          ...(runAsNode ? ['set ELECTRON_RUN_AS_NODE=1'] : []),
          `"${node}" "${npmCli}" --prefix "${prefixDir}" %*`,
          '',
        ].join('\r\n'),
        'utf8',
      )
    } else {
      const exec = runAsNode ? 'exec env ELECTRON_RUN_AS_NODE=1' : 'exec'
      const nodeShim = join(shimDir, 'node')
      writeFileSync(nodeShim, ['#!/usr/bin/env bash', `${exec} ${shellQuote(node)} "$@"`, ''].join('\n'), {
        encoding: 'utf8',
        mode: 0o755,
      })
      chmodSync(nodeShim, 0o755)
      const npmShim = join(shimDir, 'npm')
      writeFileSync(
        npmShim,
        [
          '#!/usr/bin/env bash',
          `${exec} ${shellQuote(node)} ${shellQuote(npmCli)} --prefix ${shellQuote(prefixDir)} "$@"`,
          '',
        ].join('\n'),
        { encoding: 'utf8', mode: 0o755 },
      )
      chmodSync(npmShim, 0o755)
    }

    // Only a complete write is remembered: a failure (AV lock, quota) is tried
    // again by the next caller, as it always was.
    writtenShims.set(writtenKey, { shimDir, prefixBinDir })
    return { shimDir, prefixBinDir }
  } catch {
    return null
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
