import { mkdir, readdir, readFile, rename, stat, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join } from 'path'

import {
  DESIGN_SYSTEM_MANIFEST_FILENAME,
  parseDesignSystemManifest,
  type DesignSystemManifest,
} from '../../shared/design-system/manifest'
import {
  designSystemRegistrationId,
  normaliseRegistryPath,
  DESIGN_SYSTEM_REGISTRY_SCHEMA_VERSION,
  type DesignSystemLibraryEntry,
  type DesignSystemLibraryListResult,
  type DesignSystemLibraryReadResult,
  type DesignSystemRegisterResult,
  type DesignSystemRegistration,
  type DesignSystemRegistryFile,
  type DesignSystemSourceState,
} from '../../shared/design-system/library'
import { isRecord } from '../../shared/records'

// The user-global design-system library: a REGISTRY OF PATHS the user pointed
// at, read live from wherever they live. See library.ts for why it stopped being
// a store of copies.
//
// This module writes exactly one file — its own registry at
// `~/.multicode/design-systems.json`. It never writes inside a registered
// folder: those belong to the user's own repo, and the door is a viewer.

/** The registry file, beside the legacy copy directory so the two never collide. */
export function defaultDesignSystemRegistryPath(): string {
  return join(homedir(), '.multicode', 'design-systems.json')
}

/** Where release-era copies live. Read for adoption; never written, never removed. */
export function defaultDesignSystemLibraryRoot(): string {
  return join(homedir(), '.multicode', 'design-systems')
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function emptyRegistry(): DesignSystemRegistryFile {
  return { schemaVersion: DESIGN_SYSTEM_REGISTRY_SCHEMA_VERSION, entries: [] }
}

/**
 * Read the registry file, tolerating every way it can be absent or damaged.
 *
 * A missing file is an empty library — the ordinary first-run state. A file that
 * will not parse is ALSO treated as empty rather than throwing, because the
 * alternative is a door that cannot open at all; the next write rebuilds it.
 * Individual malformed entries are dropped, not the whole file.
 */
export async function readDesignSystemRegistry(
  registryPath: string,
): Promise<DesignSystemRegistryFile> {
  let raw: string
  try {
    raw = await readFile(registryPath, 'utf8')
  } catch {
    return emptyRegistry()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyRegistry()
  }
  if (!isRecord(parsed)) return emptyRegistry()
  const rawEntries = Array.isArray(parsed.entries) ? parsed.entries : []
  const entries: DesignSystemRegistration[] = []
  const seen = new Set<string>()
  for (const candidate of rawEntries) {
    if (!isRecord(candidate)) continue
    const path = text(candidate.path)
    if (!path) continue
    const id = text(candidate.id) ?? designSystemRegistrationId(path)
    // One row per folder: a registry hand-edited into duplicates collapses
    // rather than rendering the same system twice.
    if (seen.has(id)) continue
    seen.add(id)
    entries.push({
      id,
      path,
      name: text(candidate.name),
      version: text(candidate.version),
      addedAt: text(candidate.addedAt) ?? new Date(0).toISOString(),
    })
  }
  return {
    schemaVersion:
      typeof parsed.schemaVersion === 'number'
        ? parsed.schemaVersion
        : DESIGN_SYSTEM_REGISTRY_SCHEMA_VERSION,
    entries,
    adoptedLegacyCopies: parsed.adoptedLegacyCopies === true,
  }
}

/**
 * Write the registry through a temp file + rename.
 *
 * The rename is atomic on every platform we ship, so a crash mid-write leaves
 * the previous registry intact rather than a truncated one — losing the list of
 * folders a user pointed at is not recoverable from anywhere else.
 */
async function writeDesignSystemRegistry(
  registryPath: string,
  registry: DesignSystemRegistryFile,
): Promise<void> {
  await mkdir(dirname(registryPath), { recursive: true })
  const temporary = `${registryPath}.tmp`
  await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
  await rename(temporary, registryPath)
}

async function statKind(path: string): Promise<'dir' | 'file' | 'missing' | 'unreadable'> {
  try {
    const stats = await stat(path)
    return stats.isDirectory() ? 'dir' : 'file'
  } catch (error) {
    const code =
      error !== null && typeof error === 'object' && 'code' in error
        ? String((error as { code: unknown }).code)
        : null
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable'
  }
}

interface ProbeResult {
  sourceState: DesignSystemSourceState
  manifest: DesignSystemManifest | null
  message: string | null
}

/**
 * Probe one registered folder: is it there, is it a bundle, does it parse?
 *
 * READ ONLY. This is the whole of what the library does to a user's folder.
 */
async function probe(path: string): Promise<ProbeResult> {
  const kind = await statKind(path)
  if (kind === 'missing' || kind === 'file') {
    return {
      sourceState: 'missing',
      manifest: null,
      message: `That folder is no longer there: ${path}`,
    }
  }
  if (kind === 'unreadable') {
    return { sourceState: 'unreadable', manifest: null, message: `Could not open ${path}` }
  }
  let contents: string
  try {
    contents = await readFile(join(path, DESIGN_SYSTEM_MANIFEST_FILENAME), 'utf8')
  } catch (error) {
    const code =
      error !== null && typeof error === 'object' && 'code' in error
        ? String((error as { code: unknown }).code)
        : null
    if (code === 'ENOENT') {
      return {
        sourceState: 'no-manifest',
        manifest: null,
        message: `That folder has no ${DESIGN_SYSTEM_MANIFEST_FILENAME}, so it is not a design system.`,
      }
    }
    return {
      sourceState: 'unreadable',
      manifest: null,
      message: `Could not read ${DESIGN_SYSTEM_MANIFEST_FILENAME} in ${path}`,
    }
  }
  try {
    return { sourceState: 'ok', manifest: parseDesignSystemManifest(contents), message: null }
  } catch (error) {
    return {
      sourceState: 'invalid-manifest',
      manifest: null,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

function toEntry(
  registration: DesignSystemRegistration,
  probed: ProbeResult,
): DesignSystemLibraryEntry {
  const manifest = probed.manifest
  const releasedAt = manifest?.provenance.releasedAt
  return {
    id: registration.id,
    path: registration.path,
    // The manifest when we could read it; otherwise the cached display value, so
    // a folder that moved still shows what it used to be instead of going blank.
    name: manifest?.name ?? registration.name,
    version: manifest?.version ?? registration.version,
    summary: manifest?.summary ?? '',
    releasedAt: typeof releasedAt === 'string' ? releasedAt : null,
    sourceState: probed.sourceState,
    addedAt: registration.addedAt,
  }
}

/**
 * Adopt release-era copies as registered paths, once.
 *
 * A user's machine may hold `<root>/<name>/<version>/` copies written before the
 * release pipeline was deleted (item 2001). Leaving them unregistered would make
 * their systems silently vanish from the app; deleting them is never an option.
 * So they are registered IN PLACE, pointing at themselves, and the adoption is
 * recorded so a deliberate Forget sticks.
 */
async function adoptLegacyCopies(
  legacyRoot: string,
  existing: readonly DesignSystemRegistration[],
): Promise<DesignSystemRegistration[]> {
  const known = new Set(existing.map((entry) => normaliseRegistryPath(entry.path)))
  const adopted: DesignSystemRegistration[] = []
  let nameDirs: string[]
  try {
    nameDirs = (await readdir(legacyRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    return adopted
  }
  for (const name of nameDirs.sort((a, b) => a.localeCompare(b))) {
    let versionDirs: string[]
    try {
      versionDirs = (await readdir(join(legacyRoot, name), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
    } catch {
      continue
    }
    for (const version of versionDirs.sort((a, b) => a.localeCompare(b))) {
      const path = join(legacyRoot, name, version)
      if (known.has(normaliseRegistryPath(path))) continue
      const probed = await probe(path)
      // Only adopt what really is a bundle: a stray directory under the old root
      // is not a design system and must not become a permanent broken row.
      if (probed.sourceState !== 'ok' || !probed.manifest) continue
      known.add(normaliseRegistryPath(path))
      adopted.push({
        id: designSystemRegistrationId(path),
        path,
        name: probed.manifest.name,
        version: probed.manifest.version,
        addedAt: new Date().toISOString(),
      })
    }
  }
  return adopted
}

export interface LibraryPaths {
  registryPath: string
  /** The release-era copy root, read once for adoption. */
  legacyRoot: string
}

/**
 * Read the registry, adopting release-era copies the first time.
 *
 * Shared by list and read because either can be the first thing that happens on
 * a machine that predates the registry. After the first pass the flag short
 * circuits it, so the steady-state cost is the registry read either would do.
 */
async function ensureAdopted(paths: LibraryPaths): Promise<DesignSystemRegistryFile> {
  const registry = await readDesignSystemRegistry(paths.registryPath)
  if (registry.adoptedLegacyCopies) return registry
  const adopted = await adoptLegacyCopies(paths.legacyRoot, registry.entries)
  registry.entries = [...registry.entries, ...adopted]
  registry.adoptedLegacyCopies = true
  await writeDesignSystemRegistry(paths.registryPath, registry)
  return registry
}

/**
 * List the library: every registered folder, probed live.
 *
 * A folder that cannot be read stays in the list as a row carrying its own
 * failure state — dropping it would hide the fact that anything is wrong, and
 * the user needs the row in order to re-point or forget it.
 */
export async function listDesignSystemLibrary(
  paths: LibraryPaths,
): Promise<DesignSystemLibraryListResult> {
  const registry = await ensureAdopted(paths)

  const entries: DesignSystemLibraryEntry[] = []
  const refreshed: DesignSystemRegistration[] = []
  for (const registration of registry.entries) {
    const probed = await probe(registration.path)
    entries.push(toEntry(registration, probed))
    refreshed.push({
      ...registration,
      // Refresh the display cache from what we just read; keep the old values
      // when the read failed, so a missing folder keeps its identity.
      name: probed.manifest?.name ?? registration.name,
      version: probed.manifest?.version ?? registration.version,
    })
  }
  if (JSON.stringify(refreshed) !== JSON.stringify(registry.entries)) {
    await writeDesignSystemRegistry(paths.registryPath, { ...registry, entries: refreshed })
  }

  entries.sort(
    (a, b) => (a.name ?? a.path).localeCompare(b.name ?? b.path) || a.path.localeCompare(b.path),
  )
  return { entries }
}

/** Read one registered design system by id. */
export async function readDesignSystemLibraryEntry(
  paths: LibraryPaths,
  id: string,
): Promise<DesignSystemLibraryReadResult> {
  // Adoption runs here too, not only on list: attach resolves an id directly, so
  // a machine carrying release-era copies that attaches before it ever lists
  // would otherwise find nothing registered.
  const registry = await ensureAdopted(paths)
  const registration = registry.entries.find((entry) => entry.id === id)
  if (!registration) {
    return {
      ok: false,
      message: `No design system is registered under ${id}.`,
      sourceState: 'missing',
    }
  }
  const probed = await probe(registration.path)
  if (probed.sourceState !== 'ok' || !probed.manifest) {
    return {
      ok: false,
      message: probed.message ?? `Could not read ${registration.path}.`,
      sourceState: probed.sourceState,
    }
  }
  return { ok: true, entry: toEntry(registration, probed), manifest: probed.manifest }
}

/**
 * Register a folder. Nothing is copied — the library learns the path, and the
 * folder stays exactly where the user's repo put it.
 *
 * Registering a folder already in the library is not an error: it refreshes the
 * cached display values and returns the existing entry, because "point at the
 * one I already have" is a reasonable thing for a person to do twice.
 */
export async function registerDesignSystemFolder(
  paths: LibraryPaths,
  folderPath: string,
): Promise<DesignSystemRegisterResult> {
  if (typeof folderPath !== 'string' || folderPath.trim().length === 0) {
    return { ok: false, message: 'No folder provided.' }
  }
  const probed = await probe(folderPath)
  if (probed.sourceState !== 'ok' || !probed.manifest) {
    // An explicit refusal naming the folder, never a row quietly added and then
    // shown as broken: the user picked this folder a moment ago and needs to
    // know it is not a design system.
    return { ok: false, message: probed.message ?? `Could not read ${folderPath}.` }
  }

  const registry = await readDesignSystemRegistry(paths.registryPath)
  const id = designSystemRegistrationId(folderPath)
  const existing = registry.entries.find((entry) => entry.id === id)
  const registration: DesignSystemRegistration = {
    id,
    path: folderPath,
    name: probed.manifest.name,
    version: probed.manifest.version,
    addedAt: existing?.addedAt ?? new Date().toISOString(),
  }
  registry.entries = existing
    ? registry.entries.map((entry) => (entry.id === id ? registration : entry))
    : [...registry.entries, registration]
  await writeDesignSystemRegistry(paths.registryPath, registry)
  return { ok: true, entry: toEntry(registration, probed) }
}

/**
 * Forget a registration.
 *
 * Removes the reference and NOTHING else — the folder on disk is the user's, and
 * this app has never owned it. Forgetting an id that is not registered succeeds:
 * the desired end state is already true.
 */
export async function forgetDesignSystemFolder(
  paths: LibraryPaths,
  id: string,
): Promise<{ ok: true; forgotten: boolean }> {
  const registry = await readDesignSystemRegistry(paths.registryPath)
  const remaining = registry.entries.filter((entry) => entry.id !== id)
  const forgotten = remaining.length !== registry.entries.length
  if (forgotten) {
    await writeDesignSystemRegistry(paths.registryPath, { ...registry, entries: remaining })
  }
  return { ok: true, forgotten }
}
