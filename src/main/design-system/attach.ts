import { cp, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'

import {
  DESIGN_SYSTEM_MANIFEST_FILENAME,
  parseDesignSystemManifest,
  type DesignSystemManifest,
} from '../../shared/design-system/manifest'
import type {
  DesignSystemAttachResult,
  DesignSystemAttachSource,
} from '../../shared/design-system/attach'
import { findEscapingSymlink } from './bundle-copy-confinement'
import { readDesignSystemLibraryEntry, type LibraryPaths } from './library-registry'

// Attach materializes a library bundle into a consuming workspace at
// <workspace>/design-system/ — a one-time copy exactly like knowledge/brand/,
// with provenance stamped into the copy (never the source). The workspace
// filesystem is the only dependency: no knowledge-graph root, no env vars.
// An existing design-system/ in the target is a typed refusal with nothing
// written — no overwrite, no merge in v1.

export const DESIGN_SYSTEM_ATTACH_DIRNAME = 'design-system'

const ATTACH_STAGING_DIRNAME = '.design-system-attach-staging'

async function statKind(path: string): Promise<'dir' | 'other' | 'missing'> {
  try {
    return (await stat(path)).isDirectory() ? 'dir' : 'other'
  } catch {
    return 'missing'
  }
}

interface ResolvedAttachSource {
  dir: string
  manifest: DesignSystemManifest
  /** Set for library sources: the coordinates the copy provably came from. */
  libraryCoords: { name: string; version: string } | null
}

async function resolveAttachSource(
  source: DesignSystemAttachSource,
  libraryPaths: LibraryPaths,
): Promise<ResolvedAttachSource | { failure: DesignSystemAttachResult & { ok: false } }> {
  if (source.kind === 'library') {
    // A library entry is now a REGISTERED PATH, addressed by id: two cloned
    // repos can hold the same name@version, which the old `<name>/<version>`
    // addressing could not express. Attach still COPIES what it finds there —
    // pointing at a folder is how the library learns a system exists; attaching
    // is how a project gets one, and agents read it out of the repo they work in.
    const read = await readDesignSystemLibraryEntry(libraryPaths, source.id)
    if (!read.ok) {
      return { failure: { ok: false, stage: 'source', message: read.message } }
    }
    return {
      dir: read.entry.path,
      manifest: read.manifest,
      // Provenance is stamped only when the source really has both coordinates;
      // a registered folder whose manifest we could read always does.
      libraryCoords:
        read.entry.name && read.entry.version
          ? { name: read.entry.name, version: read.entry.version }
          : null,
    }
  }

  if ((await statKind(source.path)) !== 'dir') {
    return {
      failure: {
        ok: false,
        stage: 'source',
        message: `Not a folder: ${source.path}`,
      },
    }
  }
  let manifest: DesignSystemManifest
  try {
    manifest = parseDesignSystemManifest(
      await readFile(join(source.path, DESIGN_SYSTEM_MANIFEST_FILENAME), 'utf8'),
    )
  } catch (error) {
    return {
      failure: {
        ok: false,
        stage: 'source',
        message: `The folder is not a design-system bundle (${DESIGN_SYSTEM_MANIFEST_FILENAME} is missing or invalid): ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    }
  }
  return { dir: source.path, manifest, libraryCoords: null }
}

/**
 * Attach a design-system bundle to a consuming workspace: validate the source
 * bundle, refuse an existing `design-system/` in the target, copy the full
 * bundle through a dot-prefixed staging dir + rename, and stamp `attachedAt`
 * (plus the library coordinates for library sources) into the copy's manifest
 * via the canonical parser round-trip — unknown fields preserved, the source
 * bundle never mutated. A browsed folder that already carries release
 * provenance keeps it verbatim.
 */
export async function attachDesignSystemBundle(
  source: DesignSystemAttachSource,
  workspaceRoot: string,
  libraryPaths: LibraryPaths,
): Promise<DesignSystemAttachResult> {
  const resolved = await resolveAttachSource(source, libraryPaths)
  if ('failure' in resolved) return resolved.failure
  const { dir: sourceDir, manifest, libraryCoords } = resolved

  // The copy preserves symlinks verbatim, so a bundle carrying a link that
  // resolves outside itself must never land in the workspace — a hostile
  // bundle could alias a component file to a local secret and the launch
  // prompt would direct an agent straight at it. Fail closed before any copy.
  const escapingLink = await findEscapingSymlink(sourceDir)
  if (escapingLink !== null) {
    return {
      ok: false,
      stage: 'source',
      message: `The bundle contains a symlink that points outside the bundle (${escapingLink}). Attach refuses bundles with escaping symlinks — nothing was copied.`,
    }
  }

  if ((await statKind(workspaceRoot)) !== 'dir') {
    return {
      ok: false,
      stage: 'target',
      message: `The target workspace folder does not exist: ${workspaceRoot}`,
    }
  }

  const targetDir = join(workspaceRoot, DESIGN_SYSTEM_ATTACH_DIRNAME)
  if ((await statKind(targetDir)) !== 'missing') {
    return {
      ok: false,
      stage: 'conflict',
      message: `${DESIGN_SYSTEM_ATTACH_DIRNAME}/ already exists in this project. Attach never overwrites or merges — move it aside first if you want to replace it.`,
    }
  }

  // Stamp attach provenance into the manifest object before the copy lands;
  // the parsed value is the object itself, so unknown fields survive, and the
  // self-check parse catches a stamp bug before it reaches disk.
  const attachedAt = new Date().toISOString()
  manifest.provenance = {
    ...manifest.provenance,
    ...(libraryCoords
      ? { sourceLibraryId: libraryCoords.name, sourceLibraryVersion: libraryCoords.version }
      : {}),
    attachedAt,
  }
  const stampedJson = `${JSON.stringify(manifest, null, 2)}\n`
  try {
    parseDesignSystemManifest(stampedJson)
  } catch (error) {
    return {
      ok: false,
      stage: 'source',
      message: `Could not stamp attach provenance: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  // Copy through a dot-prefixed staging dir + rename so a half-written attach
  // never appears at design-system/; the stamp goes into the staging copy,
  // never the source bundle.
  const stagingDir = join(workspaceRoot, ATTACH_STAGING_DIRNAME)
  try {
    await rm(stagingDir, { recursive: true, force: true })
    await cp(sourceDir, stagingDir, { recursive: true })
    await writeFile(join(stagingDir, DESIGN_SYSTEM_MANIFEST_FILENAME), stampedJson)
    await rename(stagingDir, targetDir)
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
    if ((await statKind(targetDir)) !== 'missing') {
      return {
        ok: false,
        stage: 'conflict',
        message: `${DESIGN_SYSTEM_ATTACH_DIRNAME}/ appeared in this project while attaching. Attach never overwrites or merges.`,
      }
    }
    return {
      ok: false,
      stage: 'copy',
      message: `Could not copy the bundle into the project: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  try {
    parseDesignSystemManifest(await readFile(join(targetDir, DESIGN_SYSTEM_MANIFEST_FILENAME), 'utf8'))
  } catch (error) {
    return {
      ok: false,
      stage: 'copy',
      message: `The attached copy failed read-back verification: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  return { ok: true, name: manifest.name, version: manifest.version, attachedAt, path: targetDir }
}
