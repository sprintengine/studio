import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

import {
  DESIGN_SYSTEM_MANIFEST_FILENAME,
  DESIGN_SYSTEM_NAME_PATTERN,
  DESIGN_SYSTEM_VERSION_PATTERN,
  parseDesignSystemManifest,
  type DesignSystemManifest,
} from '../../shared/design-system/manifest'
import type {
  DesignSystemLibraryEntry,
  DesignSystemLibraryListResult,
  DesignSystemLibraryReadResult,
  DesignSystemLibraryRejection,
  DesignSystemReleaseResult,
} from '../../shared/design-system/library'
import { findEscapingSymlink } from './bundle-copy-confinement'
import { regenerateBundleDerivedFiles, type BundleScriptFork } from './derived-file-runner'
import { runDesignSystemBundleLint } from './bundle-lint-run'

// User-global design-system library: immutable, versioned copies of authored
// bundles at <root>/<name>/<version>/, following the ~/.multicode registry
// precedent of layout-template-registry.ts. The release pipeline is the
// gatekeeper: the bundle's own lint must pass, the version + provenance are
// stamped into the manifest, derived files are force-regenerated from the
// stamped manifest (the catalog embeds the version), and only then is the
// bundle copied in. Every failure surfaces as a typed result — nothing is
// copied on failure, and re-releasing an existing name+version refuses.

export function defaultDesignSystemLibraryRoot(): string {
  return join(homedir(), '.multicode', 'design-systems')
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function readDirSafe(dir: string): Promise<import('fs').Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function toLibraryEntry(manifest: DesignSystemManifest, path: string): DesignSystemLibraryEntry {
  const releasedAt = manifest.provenance.releasedAt
  return {
    name: manifest.name,
    version: manifest.version,
    summary: manifest.summary,
    releasedAt: typeof releasedAt === 'string' ? releasedAt : null,
    path,
  }
}

// Newest release first within a name: numeric major.minor.patch, a release
// above its own prereleases, prereleases lexicographic (good enough for v1).
function compareVersionsDesc(a: string, b: string): number {
  const [aCore, aPre = ''] = a.split('-', 2)
  const [bCore, bPre = ''] = b.split('-', 2)
  const aParts = aCore.split('.').map(Number)
  const bParts = bCore.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (aParts[i] !== bParts[i]) return bParts[i] - aParts[i]
  }
  if (aPre === bPre) return 0
  if (aPre === '') return -1
  if (bPre === '') return 1
  return bPre.localeCompare(aPre)
}

/**
 * Release ("Save as design system") an authored bundle into the library as an
 * immutable copy at `<root>/<name>/<version>/`. Pipeline: refuse an existing
 * name+version → bundle lint gate → stamp version + provenance into the
 * authoring manifest (unknown fields preserved by the canonical parser) →
 * force-regenerate derived files from the stamped manifest → copy. The copy
 * excludes nothing: the bundle is self-contained by design.
 */
export async function releaseDesignSystemBundle(
  bundleDir: string,
  version: string,
  root: string,
  fork: BundleScriptFork,
): Promise<DesignSystemReleaseResult> {
  const manifestPath = join(bundleDir, DESIGN_SYSTEM_MANIFEST_FILENAME)
  let manifest: DesignSystemManifest
  try {
    manifest = parseDesignSystemManifest(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    return {
      ok: false,
      stage: 'manifest',
      message: `Could not read the bundle manifest: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  if (!DESIGN_SYSTEM_VERSION_PATTERN.test(version)) {
    return {
      ok: false,
      stage: 'manifest',
      message: `Release version must be a semver string (got "${version}").`,
    }
  }

  const releaseDir = join(root, manifest.name, version)
  if (await pathExists(releaseDir)) {
    return {
      ok: false,
      stage: 'conflict',
      message: `${manifest.name}@${version} is already in the library. Releases are immutable — bump the version to release again.`,
    }
  }

  // The library copy preserves symlinks verbatim, so a bundle tree carrying a
  // link that resolves outside itself must never become a release — every
  // later attach of that release would materialize the escaping link into a
  // consuming repo. Fail closed before running any bundle script or mutating
  // anything.
  const escapingLink = await findEscapingSymlink(bundleDir)
  if (escapingLink !== null) {
    return {
      ok: false,
      stage: 'source',
      message: `The bundle contains a symlink that points outside the bundle (${escapingLink}). Releases refuse bundles with escaping symlinks — nothing was copied.`,
    }
  }

  // Lint gate before anything is mutated. One implementation of the lint
  // fork + exit contract (bundle-lint-run.ts) serves both the studio's
  // validating preview and this release gate, so the two can never drift —
  // only the release-specific copy lives in this mapping.
  const lint = await runDesignSystemBundleLint(bundleDir, fork)
  if (!lint.ok) {
    if (lint.kind === 'findings') {
      return {
        ok: false,
        stage: 'lint',
        message: 'The design-system lint found violations. Fix them and release again.',
        lintFindings: lint.findings,
      }
    }
    return { ok: false, stage: 'lint', message: lint.message }
  }

  // Stamp version + release provenance. The manifest object is the parsed
  // value itself, so unknown top-level and provenance fields survive the
  // read → stamp → write cycle; the parser self-check catches a stamp bug
  // before it reaches disk.
  const releasedAt = new Date().toISOString()
  manifest.version = version
  manifest.provenance = {
    ...manifest.provenance,
    sourceLibraryId: manifest.name,
    sourceLibraryVersion: version,
    releasedAt,
  }
  const stampedJson = `${JSON.stringify(manifest, null, 2)}\n`
  try {
    parseDesignSystemManifest(stampedJson)
    await writeFile(manifestPath, stampedJson)
  } catch (error) {
    return {
      ok: false,
      stage: 'manifest',
      message: `Could not stamp the bundle manifest: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  // Force-regenerate derived files from the stamped manifest (tokens before
  // the catalog that inlines them; the catalog also embeds the version), so a
  // release can never ship stale derived output. Unlike authoring-time
  // regeneration, a generator that is merely 'missing' fails the release: a
  // released bundle must contain every derived file.
  const regen = await regenerateBundleDerivedFiles(bundleDir, fork)
  const incomplete = regen.runs.filter((run) => run.status !== 'ok')
  if (!regen.ok || incomplete.length > 0) {
    return {
      ok: false,
      stage: 'regenerate',
      message:
        regen.message ??
        incomplete.map((run) => `${run.script}: ${run.status}`).join('; '),
    }
  }
  for (const derivedFile of Object.keys(manifest.derived)) {
    if (!(await pathExists(join(bundleDir, derivedFile)))) {
      return {
        ok: false,
        stage: 'regenerate',
        message: `Derived file was not produced by its generator: ${derivedFile}`,
      }
    }
  }

  // Copy through a dot-prefixed staging dir + rename so a half-written
  // release can never be listed (list skips dot-dirs), then verify the copy
  // parses before reporting success.
  const stagingDir = join(root, manifest.name, `.staging-${version}`)
  try {
    await mkdir(join(root, manifest.name), { recursive: true })
    await rm(stagingDir, { recursive: true, force: true })
    await cp(bundleDir, stagingDir, { recursive: true })
    await rename(stagingDir, releaseDir)
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
    if (await pathExists(releaseDir)) {
      return {
        ok: false,
        stage: 'conflict',
        message: `${manifest.name}@${version} appeared in the library while releasing. Releases are immutable — bump the version to release again.`,
      }
    }
    return {
      ok: false,
      stage: 'copy',
      message: `Could not copy the bundle into the library: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  try {
    parseDesignSystemManifest(await readFile(join(releaseDir, DESIGN_SYSTEM_MANIFEST_FILENAME), 'utf8'))
  } catch (error) {
    return {
      ok: false,
      stage: 'copy',
      message: `The released copy failed read-back verification: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  return { ok: true, name: manifest.name, version, releasedAt, path: releaseDir }
}

/**
 * List every released design system under the library root. A missing root
 * is an empty library (nothing has been released yet); a release that does
 * not parse, or whose manifest disagrees with its directory, is surfaced in
 * `rejected` rather than silently skipped.
 */
export async function listDesignSystemLibrary(root: string): Promise<DesignSystemLibraryListResult> {
  const entries: DesignSystemLibraryEntry[] = []
  const rejected: DesignSystemLibraryRejection[] = []

  for (const nameEntry of await readDirSafe(root)) {
    if (!nameEntry.isDirectory() || nameEntry.name.startsWith('.')) continue
    const nameDir = join(root, nameEntry.name)
    for (const versionEntry of await readDirSafe(nameDir)) {
      if (!versionEntry.isDirectory() || versionEntry.name.startsWith('.')) continue
      const releaseDir = join(nameDir, versionEntry.name)
      let manifest: DesignSystemManifest
      try {
        manifest = parseDesignSystemManifest(
          await readFile(join(releaseDir, DESIGN_SYSTEM_MANIFEST_FILENAME), 'utf8'),
        )
      } catch (error) {
        rejected.push({
          path: releaseDir,
          message: error instanceof Error ? error.message : String(error),
        })
        continue
      }
      if (manifest.name !== nameEntry.name || manifest.version !== versionEntry.name) {
        rejected.push({
          path: releaseDir,
          message: `Manifest identifies ${manifest.name}@${manifest.version}, which does not match its library directory.`,
        })
        continue
      }
      entries.push(toLibraryEntry(manifest, releaseDir))
    }
  }

  entries.sort(
    (a, b) => a.name.localeCompare(b.name) || compareVersionsDesc(a.version, b.version),
  )
  return { entries, rejected }
}

/** Read one released design system's manifest for picker/completion UI. */
export async function readDesignSystemLibraryEntry(
  root: string,
  name: string,
  version: string,
): Promise<DesignSystemLibraryReadResult> {
  // name/version compose a filesystem path from renderer input; the manifest
  // patterns exclude path separators and dot-segments.
  if (!DESIGN_SYSTEM_NAME_PATTERN.test(name)) {
    return { ok: false, message: `Not a valid design-system name: "${name}".` }
  }
  if (!DESIGN_SYSTEM_VERSION_PATTERN.test(version)) {
    return { ok: false, message: `Not a valid design-system version: "${version}".` }
  }

  const releaseDir = join(root, name, version)
  let manifest: DesignSystemManifest
  try {
    manifest = parseDesignSystemManifest(
      await readFile(join(releaseDir, DESIGN_SYSTEM_MANIFEST_FILENAME), 'utf8'),
    )
  } catch (error) {
    return {
      ok: false,
      message: `Could not read ${name}@${version} from the library: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (manifest.name !== name || manifest.version !== version) {
    return {
      ok: false,
      message: `Library copy at ${name}/${version} identifies itself as ${manifest.name}@${manifest.version}.`,
    }
  }
  return { ok: true, entry: toLibraryEntry(manifest, releaseDir), manifest }
}
