import { readdir, readFile, stat } from 'fs/promises'
import { isAbsolute, join } from 'path'

import {
  DESIGN_SYSTEM_MANIFEST_FILENAME,
  parseDesignSystemManifest,
} from '../../shared/design-system/manifest'
import type {
  BundleRegenResult,
  DerivedScriptRun,
  DesignSystemRegenResult,
} from '../../shared/design-system/derived-files'

// Regenerates a design-system bundle's derived files (tokens.css,
// catalog/index.html) by forking the bundle's own generator scripts — the
// manifest `derived` map names them. One implementation that travels with the
// bundle: the app never re-implements the transform natively, so in-app and
// in-consuming-repo regeneration cannot drift.
//
// The fork implementation is injected: production passes the Electron
// utilityProcess binding (utility-process-fork.ts) so bundle scripts run in a
// forked utility process — the same trust boundary as the bypass designer
// session that authored them — never in the main process itself. Tests inject
// a plain child_process-backed fork.

export type { BundleRegenResult, DesignSystemRegenResult }

export interface BundleScriptExit {
  /** Null when the process could not be spawned or was killed on timeout. */
  exitCode: number | null
  stdout: string
  stderr: string
}

export type BundleScriptFork = (
  scriptPath: string,
  args: string[],
  options: { cwd: string },
) => Promise<BundleScriptExit>

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// Manifest `derived` values are untrusted input: a `../`-prefixed value would
// resolve (and fork) outside the bundle. A generator must be a bundle-relative
// `.mjs` path with no empty or dot segments — anything else is refused before
// the fork.
function isConfinedBundleScript(script: string): boolean {
  if (isAbsolute(script) || !script.endsWith('.mjs')) return false
  const segments = script.split(/[\\/]/)
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/** Regenerate one bundle's derived files by running its generator scripts. */
export async function regenerateBundleDerivedFiles(
  bundleDir: string,
  fork: BundleScriptFork,
): Promise<BundleRegenResult> {
  let manifestJson: string
  try {
    manifestJson = await readFile(join(bundleDir, DESIGN_SYSTEM_MANIFEST_FILENAME), 'utf8')
  } catch (error) {
    return {
      bundleDir,
      ok: false,
      message: `unreadable ${DESIGN_SYSTEM_MANIFEST_FILENAME}: ${error instanceof Error ? error.message : String(error)}`,
      runs: [],
    }
  }

  let derived: Record<string, string>
  try {
    derived = parseDesignSystemManifest(manifestJson).derived
  } catch (error) {
    return {
      bundleDir,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      runs: [],
    }
  }

  // The derived map is file → generator; several files may share a generator.
  // Run each generator once, in manifest declaration order: the map is
  // authored dependency-first (build-tokens before build-catalog, which
  // inlines the tokens.css that build-tokens just wrote).
  const scripts = [...new Set(Object.values(derived))]
  const runs: DerivedScriptRun[] = []
  const refusedScripts = new Set<string>()
  for (const script of scripts) {
    if (!isConfinedBundleScript(script)) {
      refusedScripts.add(script)
      runs.push({
        script,
        status: 'failed',
        exitCode: null,
        stdout: '',
        stderr: `refused to run "${script}": a manifest derived script must be a bundle-relative .mjs path with no ".." segments`,
      })
      continue
    }
    const scriptPath = join(bundleDir, script)
    if (!(await pathExists(scriptPath))) {
      // Authoring-time state: the manifest already names the generator but the
      // template has not been stamped yet. Observable, but not a failure.
      runs.push({ script, status: 'missing', exitCode: null, stdout: '', stderr: '' })
      continue
    }
    const exit = await fork(scriptPath, [bundleDir], { cwd: bundleDir })
    runs.push({
      script,
      status: exit.exitCode === 0 ? 'ok' : 'failed',
      exitCode: exit.exitCode,
      stdout: exit.stdout,
      stderr: exit.stderr,
    })
  }

  const failed = runs.filter((run) => run.status === 'failed')
  return {
    bundleDir,
    ok: failed.length === 0,
    message:
      failed.length > 0
        ? failed
            .map((run) =>
              refusedScripts.has(run.script)
                ? `${run.script} refused: escapes the bundle`
                : `${run.script} exited ${run.exitCode ?? 'without a code'}`,
            )
            .join('; ')
        : undefined,
    runs,
  }
}

/**
 * Find design-system bundles under a root: the root itself when it carries a
 * manifest, otherwise its direct child directories that do. This covers both
 * an explicit bundle dir (the attach caller) and a designer workspace
 * whose bundle lives one level down.
 */
export async function discoverBundleDirs(rootDir: string): Promise<string[]> {
  if (await pathExists(join(rootDir, DESIGN_SYSTEM_MANIFEST_FILENAME))) return [rootDir]
  let entries: import('fs').Dirent[]
  try {
    entries = await readdir(rootDir, { withFileTypes: true })
  } catch {
    return []
  }
  const bundles: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(rootDir, entry.name)
    if (await pathExists(join(candidate, DESIGN_SYSTEM_MANIFEST_FILENAME))) bundles.push(candidate)
  }
  return bundles.sort()
}

/**
 * Regenerate derived files for every bundle under a root. A readable root
 * with no bundle is a successful no-op, so non-design-system workspaces
 * (full-brief, frontend-design) are untouched — but a missing or unreadable
 * root is an observable failure, never a silent ok.
 */
export async function regenerateDesignSystemDerivedFiles(
  rootDir: string,
  fork: BundleScriptFork,
): Promise<DesignSystemRegenResult> {
  let rootStat: import('fs').Stats
  try {
    rootStat = await stat(rootDir)
  } catch (error) {
    return {
      ok: false,
      bundles: [],
      message: `root directory is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (!rootStat.isDirectory()) {
    return { ok: false, bundles: [], message: `root path is not a directory: ${rootDir}` }
  }
  const bundleDirs = await discoverBundleDirs(rootDir)
  const bundles: BundleRegenResult[] = []
  for (const bundleDir of bundleDirs) {
    bundles.push(await regenerateBundleDerivedFiles(bundleDir, fork))
  }
  return { ok: bundles.every((bundle) => bundle.ok), bundles }
}
