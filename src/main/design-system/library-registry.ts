import { readdir, readFile } from 'fs/promises'
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
} from '../../shared/design-system/library'

// User-global design-system library: bundles at <root>/<name>/<version>/,
// following the ~/.multicode registry precedent of layout-template-registry.ts.
// This module READS the library — it never writes into it. An app-local release
// pipeline was removed 2026-07-30 (owner correction: a design system lives in a
// Git repo, and versioning it is something its owner does there, not here), so
// entries arrive by import rather than by release. Every failure surfaces as a
// typed result; a malformed entry is reported, never silently skipped.

export function defaultDesignSystemLibraryRoot(): string {
  return join(homedir(), '.multicode', 'design-systems')
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

// Newest version first within a name: numeric major.minor.patch, a version
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
 * List every design system under the library root. A missing root is an empty
 * library; an entry that does not parse, or whose manifest disagrees with its
 * directory, is surfaced in `rejected` rather than silently skipped.
 */
export async function listDesignSystemLibrary(root: string): Promise<DesignSystemLibraryListResult> {
  const entries: DesignSystemLibraryEntry[] = []
  const rejected: DesignSystemLibraryRejection[] = []

  for (const nameEntry of await readDirSafe(root)) {
    if (!nameEntry.isDirectory() || nameEntry.name.startsWith('.')) continue
    const nameDir = join(root, nameEntry.name)
    for (const versionEntry of await readDirSafe(nameDir)) {
      if (!versionEntry.isDirectory() || versionEntry.name.startsWith('.')) continue
      const entryDir = join(nameDir, versionEntry.name)
      let manifest: DesignSystemManifest
      try {
        manifest = parseDesignSystemManifest(
          await readFile(join(entryDir, DESIGN_SYSTEM_MANIFEST_FILENAME), 'utf8'),
        )
      } catch (error) {
        rejected.push({
          path: entryDir,
          message: error instanceof Error ? error.message : String(error),
        })
        continue
      }
      if (manifest.name !== nameEntry.name || manifest.version !== versionEntry.name) {
        rejected.push({
          path: entryDir,
          message: `Manifest identifies ${manifest.name}@${manifest.version}, which does not match its library directory.`,
        })
        continue
      }
      entries.push(toLibraryEntry(manifest, entryDir))
    }
  }

  entries.sort(
    (a, b) => a.name.localeCompare(b.name) || compareVersionsDesc(a.version, b.version),
  )
  return { entries, rejected }
}

/** Read one design system's manifest for picker/completion UI. */
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

  const entryDir = join(root, name, version)
  let manifest: DesignSystemManifest
  try {
    manifest = parseDesignSystemManifest(
      await readFile(join(entryDir, DESIGN_SYSTEM_MANIFEST_FILENAME), 'utf8'),
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
      message: `Library entry at ${name}/${version} identifies itself as ${manifest.name}@${manifest.version}.`,
    }
  }
  return { ok: true, entry: toLibraryEntry(manifest, entryDir), manifest }
}
