import { DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME } from '../../../../../shared/design-system/bundle-scaffold'
import type { GuidedBriefPreset } from '../../../types/workspace'
import { basename, joinWorkspacePath } from './paths'

// Deterministic, path-based index of the real design artifacts a Multicode
// Design (frontend-design preset) workspace produces on disk. The index is
// built only from files that actually exist — there are no sample or
// placeholder rows. Modified time comes from the narrow read-only stat IPC; when
// metadata is unavailable, the file still appears without a timestamp.

export type DesignArtifactKind =
  | 'page'
  | 'stylesheet'
  | 'script'
  | 'image'
  | 'notes'
  | 'inspiration'

type DesignArtifactGroupId =
  | 'pages'
  | 'stylesheets'
  | 'scripts'
  | 'assets'
  | 'notes'
  | 'inspiration'

export type DesignArtifactEntry = {
  /** File name, e.g. `app.html`. */
  name: string
  /** Workspace-root-relative path with forward slashes, e.g. `mockups/app.html`. */
  relativePath: string
  /** Absolute on-disk path used for reads/preview. */
  absolutePath: string
  kind: DesignArtifactKind
  /** Short human label for the row, e.g. `HTML`, `CSS`, `Markdown`. */
  typeLabel: string
  /** ISO modified time from the filesystem, when available. */
  modifiedAt?: string | null
  /** Millisecond modified time for sorting/future display, when available. */
  modifiedAtMs?: number | null
}

type DesignArtifactGroup = {
  id: DesignArtifactGroupId
  label: string
  entries: DesignArtifactEntry[]
}

export type DesignArtifactIndex = {
  /** Non-empty groups only, in canonical order. */
  groups: DesignArtifactGroup[]
  /** Flat entries in group order then path order — the keyboard nav order. */
  entries: DesignArtifactEntry[]
  count: number
}

// `loading` until the first index build resolves; `unavailable` when the
// workspace root cannot be read; `ready` once an index (possibly empty) is built.
export type DesignArtifactsStatus = 'loading' | 'ready' | 'unavailable'

export type DesignArtifactFsPort = {
  readdir: (path: string) => Promise<{ name: string; isDir: boolean }[]>
  pathExists: (path: string) => Promise<boolean>
  statPath?: (
    path: string,
  ) => Promise<{ modifiedAt: string; modifiedAtMs: number; sizeBytes: number }>
}

export const EMPTY_DESIGN_ARTIFACT_INDEX: DesignArtifactIndex = {
  groups: [],
  entries: [],
  count: 0,
}

export const MOCKUPS_DIRECTORY_NAME = 'mockups'
export const UI_DIRECTION_RELATIVE_PATH = 'product/ui-direction.md'
export const INSPIRATION_DIRECTORY_NAME = '.guided-brief/inspiration'
// Canonical definition lives on the shared main↔renderer boundary (the
// main-process scaffold writes it; this indexer watches it).
export { DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME }

// Which workspace roots a preset's studio indexes as run artifacts (MC-1502).
// A seeded/pre-existing repo may already contain files under the shared roots
// (`mockups/`, `product/ui-direction.md`), so each preset declares only the
// trees its wizard run actually owns.
export type DesignArtifactRoots = {
  mockups: boolean
  uiDirection: boolean
  inspiration: boolean
  designSystemBundle: boolean
}

// full-brief / frontend-design author `mockups/` + `product/ui-direction.md`;
// pre-existing files there are filtered by the scaffold baseline instead of
// dropping the roots (the run legitimately writes into them).
const SHARED_ROOT_DESIGN_ARTIFACT_ROOTS: DesignArtifactRoots = {
  mockups: true,
  uiDirection: true,
  inspiration: true,
  designSystemBundle: false,
}

// The design-system studio's product is the bundle: the seed repo's `mockups/`
// and `product/ui-direction.md` are the agent's source material, never run
// artifacts, so they are not roots at all for this preset.
const DESIGN_SYSTEM_DESIGN_ARTIFACT_ROOTS: DesignArtifactRoots = {
  mockups: false,
  uiDirection: false,
  inspiration: true,
  designSystemBundle: true,
}

export function designArtifactRootsForPreset(preset: GuidedBriefPreset): DesignArtifactRoots {
  return preset === 'design-system'
    ? DESIGN_SYSTEM_DESIGN_ARTIFACT_ROOTS
    : SHARED_ROOT_DESIGN_ARTIFACT_ROOTS
}

// --- Scaffold baseline (MC-1502) -------------------------------------------
//
// Written once by the guided-brief scaffold (full-brief / frontend-design)
// before the designer session starts: a manifest of every file that already
// existed under the shared roots. Discovery then shows only files that are new
// or modified since the baseline. A missing or unreadable baseline (runs
// created before this shipped) means no filtering — current behavior, no
// migration. mtime alone is not trusted (git checkout resets it); size is
// recorded alongside so either changing marks the file as run output.

export const SCAFFOLD_BASELINE_RELATIVE_PATH = '.guided-brief/scaffold-baseline.json'

type ScaffoldBaselineFile = {
  mtimeMs: number
  size: number
}

export type ScaffoldBaseline = {
  version: 1
  /** Workspace-root-relative path (forward slashes) → pre-existing file stats. */
  files: Record<string, ScaffoldBaselineFile>
}

/** A fs port that can stat — building an honest baseline requires real mtimes/sizes. */
export type ScaffoldBaselinePort = DesignArtifactFsPort & {
  statPath: NonNullable<DesignArtifactFsPort['statPath']>
}

export function serializeScaffoldBaseline(baseline: ScaffoldBaseline): string {
  return JSON.stringify(baseline, null, 2)
}

/** Strict parse: any shape drift yields null (= no filtering), never a crash. */
export function parseScaffoldBaseline(content: string): ScaffoldBaseline | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const candidate = parsed as { version?: unknown; files?: unknown }
  if (candidate.version !== 1) return null
  if (typeof candidate.files !== 'object' || candidate.files === null) return null
  const files: Record<string, ScaffoldBaselineFile> = {}
  for (const [path, value] of Object.entries(candidate.files as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) return null
    const record = value as { mtimeMs?: unknown; size?: unknown }
    if (typeof record.mtimeMs !== 'number' || typeof record.size !== 'number') return null
    files[path] = { mtimeMs: record.mtimeMs, size: record.size }
  }
  return { version: 1, files }
}

/**
 * True when a file under a baseline-covered root belongs to this run: it is
 * absent from the baseline (new) or its mtime/size differ (modified). A
 * baseline-listed file whose current stats are unavailable counts as
 * untouched — pre-existing files stay hidden unless demonstrably changed.
 */
export function isNewOrModifiedSinceBaseline(
  baseline: ScaffoldBaseline | null | undefined,
  relativePath: string,
  stats: { modifiedAtMs: number; sizeBytes: number } | null,
): boolean {
  if (!baseline) return true
  const recorded = baseline.files[relativePath]
  if (!recorded) return true
  if (!stats) return false
  return stats.modifiedAtMs !== recorded.mtimeMs || stats.sizeBytes !== recorded.size
}

/**
 * Record every file currently under the shared roots (`mockups/**`,
 * `product/ui-direction.md`) with its mtime + size. Called at scaffold time,
 * before the designer session writes anything, so the manifest is exactly the
 * seed repo's pre-existing files. Files that vanish mid-walk are skipped —
 * they no longer exist to leak into the index.
 */
export async function buildScaffoldBaseline(
  workspaceRoot: string,
  ports: ScaffoldBaselinePort,
): Promise<ScaffoldBaseline> {
  const files: Record<string, ScaffoldBaselineFile> = {}
  const record = async (absolutePath: string, relativePath: string): Promise<void> => {
    try {
      const stats = await ports.statPath(absolutePath)
      files[relativePath] = { mtimeMs: stats.modifiedAtMs, size: stats.sizeBytes }
    } catch {
      // Deleted between readdir and stat — nothing to baseline.
    }
  }

  const mockupFiles = await collectFilesUnder(
    joinWorkspacePath(workspaceRoot, MOCKUPS_DIRECTORY_NAME),
    MOCKUPS_DIRECTORY_NAME,
    ports,
    0,
  )
  for (const file of mockupFiles) {
    await record(file.absolutePath, file.relativePath)
  }

  const uiDirectionAbsolutePath = joinWorkspacePath(workspaceRoot, UI_DIRECTION_RELATIVE_PATH)
  const uiDirectionExists = await ports.pathExists(uiDirectionAbsolutePath).catch(() => false)
  if (uiDirectionExists) {
    await record(uiDirectionAbsolutePath, UI_DIRECTION_RELATIVE_PATH)
  }

  return { version: 1, files }
}

// Recursion is shallow-bounded so a runaway tree can't lock the renderer —
// matches the existing mockup walker in useDesignerSession.
const MAX_DEPTH = 4

const EXTENSION_KIND: Record<string, Exclude<DesignArtifactKind, 'notes' | 'inspiration'>> = {
  html: 'page',
  htm: 'page',
  css: 'stylesheet',
  js: 'script',
  json: 'script',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  svg: 'image',
}

const GROUP_DEFINITIONS: ReadonlyArray<{
  id: DesignArtifactGroupId
  label: string
  kinds: DesignArtifactKind[]
}> = [
  { id: 'pages', label: 'Pages', kinds: ['page'] },
  { id: 'stylesheets', label: 'Stylesheets', kinds: ['stylesheet'] },
  { id: 'scripts', label: 'Scripts & data', kinds: ['script'] },
  { id: 'assets', label: 'Assets', kinds: ['image'] },
  { id: 'notes', label: 'Notes', kinds: ['notes'] },
  { id: 'inspiration', label: 'Inspiration', kinds: ['inspiration'] },
]

function extensionOf(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name)
  return match ? match[1].toLowerCase() : ''
}

/** Classify a `mockups/**` file by extension. Returns null for unsupported types. */
export function classifyMockupFile(
  name: string,
): Exclude<DesignArtifactKind, 'notes' | 'inspiration'> | null {
  return EXTENSION_KIND[extensionOf(name)] ?? null
}

/**
 * Classify a `design-system/**` bundle file. Same extension map as mockups,
 * plus markdown (USAGE.md, principles.md, component.md) as notes. Generator
 * sources (`scripts/*.mjs`) stay unclassified — they are plumbing, not design
 * artifacts.
 */
function classifyDesignSystemBundleFile(name: string): DesignArtifactKind | null {
  const extension = extensionOf(name)
  if (extension === 'md' || extension === 'markdown') return 'notes'
  return EXTENSION_KIND[extension] ?? null
}

function typeLabelFor(name: string, kind: DesignArtifactKind): string {
  if (kind === 'notes') return 'Markdown'
  const ext = extensionOf(name)
  return ext ? ext.toUpperCase() : 'File'
}

async function statFor(
  absolutePath: string,
  ports: DesignArtifactFsPort,
): Promise<{ modifiedAt: string; modifiedAtMs: number; sizeBytes: number } | null> {
  if (!ports.statPath) return null
  try {
    return await ports.statPath(absolutePath)
  } catch {
    return null
  }
}

function metadataFrom(
  stats: { modifiedAt: string; modifiedAtMs: number } | null,
): Pick<DesignArtifactEntry, 'modifiedAt' | 'modifiedAtMs'> {
  return stats ? { modifiedAt: stats.modifiedAt, modifiedAtMs: stats.modifiedAtMs } : {}
}

// How a selected artifact should be previewed. Drives DesignArtifactPreviewPane:
// html → sandboxed iframe, markdown → rendered markdown, image → <img>, source →
// read-only text, unsupported → explicit unsupported state.
export type DesignArtifactPreviewKind = 'html' | 'markdown' | 'image' | 'source' | 'unsupported'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'])
const SOURCE_EXTENSIONS = new Set(['css', 'js', 'json', 'txt'])

export function previewKindForArtifact(entry: DesignArtifactEntry): DesignArtifactPreviewKind {
  if (entry.kind === 'notes') return 'markdown'
  const ext = extensionOf(entry.name)
  if (ext === 'html' || ext === 'htm') return 'html'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (SOURCE_EXTENSIONS.has(ext)) return 'source'
  return 'unsupported'
}

export function isHtmlDesignArtifact(entry: DesignArtifactEntry): boolean {
  return entry.kind === 'page'
}

export function findDesignArtifact(
  index: DesignArtifactIndex,
  relativePath: string | null | undefined,
): DesignArtifactEntry | null {
  if (!relativePath) return null
  return index.entries.find((entry) => entry.relativePath === relativePath) ?? null
}

/**
 * Persist a design-file selection onto guided-brief runtime state: the selected
 * relative path goes to `activeDesignArtifactPath`, and HTML pages also mirror
 * to `activeMockupPath` so the existing mockup preview stays in sync. Generic
 * over the two fields so it stays decoupled from the full runtime-state type.
 */
export function applyDesignArtifactSelection<
  T extends { activeDesignArtifactPath?: string | null; activeMockupPath?: string | null },
>(state: T, entry: DesignArtifactEntry): T {
  const next: T = { ...state, activeDesignArtifactPath: entry.relativePath }
  if (isHtmlDesignArtifact(entry)) {
    next.activeMockupPath = entry.relativePath
  }
  return next
}

/** Group + sort raw entries deterministically. Empty groups are dropped. */
export function buildDesignArtifactIndex(entries: DesignArtifactEntry[]): DesignArtifactIndex {
  const groups: DesignArtifactGroup[] = []
  const flat: DesignArtifactEntry[] = []
  for (const definition of GROUP_DEFINITIONS) {
    const groupEntries = entries
      .filter((entry) => definition.kinds.includes(entry.kind))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    if (groupEntries.length === 0) continue
    groups.push({ id: definition.id, label: definition.label, entries: groupEntries })
    flat.push(...groupEntries)
  }
  return { groups, entries: flat, count: flat.length }
}

async function collectFilesUnder(
  absoluteRoot: string,
  relativeRoot: string,
  ports: DesignArtifactFsPort,
  depth: number,
): Promise<Array<{ name: string; absolutePath: string; relativePath: string }>> {
  if (depth > MAX_DEPTH) return []
  const entries = await ports.readdir(absoluteRoot).catch(() => [])
  const files: Array<{ name: string; absolutePath: string; relativePath: string }> = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const absolutePath = joinWorkspacePath(absoluteRoot, entry.name)
    const relativePath = `${relativeRoot}/${entry.name}`
    if (entry.isDir) {
      files.push(...(await collectFilesUnder(absolutePath, relativePath, ports, depth + 1)))
      continue
    }
    files.push({ name: entry.name, absolutePath, relativePath })
  }
  return files
}

export type CollectDesignArtifactsOptions = {
  /**
   * Which workspace roots to index. Defaults to the shared roots
   * (`mockups/**`, `product/ui-direction.md`, inspiration) used by the
   * full-brief / frontend-design presets; design-system studios pass
   * `designArtifactRootsForPreset('design-system')`.
   */
  roots?: DesignArtifactRoots
  /**
   * Scaffold-time manifest of files that pre-existed under the shared roots.
   * When present, `mockups/**` and `product/ui-direction.md` are filtered to
   * files new or modified since the baseline. Absent (runs created before the
   * baseline shipped) → no filtering.
   */
  baseline?: ScaffoldBaseline | null
}

/**
 * Walk the real workspace for design artifacts and return a grouped index.
 * Roots are preset-scoped (MC-1502): `mockups/**` (classified by extension)
 * and `product/ui-direction.md` for the shared-root presets — filtered by the
 * scaffold baseline when one exists — `.guided-brief/inspiration/**` (any
 * file), and the `design-system/**` bundle tree for design-system studios.
 * All paths are read through the injected port so the collector is testable
 * with an in-memory filesystem and reuses `window.api` in the renderer.
 */
export async function collectDesignArtifacts(
  workspaceRoot: string,
  ports: DesignArtifactFsPort,
  options: CollectDesignArtifactsOptions = {},
): Promise<DesignArtifactIndex> {
  const roots = options.roots ?? SHARED_ROOT_DESIGN_ARTIFACT_ROOTS
  const baseline = options.baseline ?? null
  const entries: DesignArtifactEntry[] = []

  if (roots.mockups) {
    const mockupFiles = await collectFilesUnder(
      joinWorkspacePath(workspaceRoot, MOCKUPS_DIRECTORY_NAME),
      MOCKUPS_DIRECTORY_NAME,
      ports,
      0,
    )
    for (const file of mockupFiles) {
      const kind = classifyMockupFile(file.name)
      if (!kind) continue
      const stats = await statFor(file.absolutePath, ports)
      if (!isNewOrModifiedSinceBaseline(baseline, file.relativePath, stats)) continue
      entries.push({
        ...file,
        kind,
        typeLabel: typeLabelFor(file.name, kind),
        ...metadataFrom(stats),
      })
    }
  }

  if (roots.uiDirection) {
    const uiDirectionAbsolutePath = joinWorkspacePath(workspaceRoot, UI_DIRECTION_RELATIVE_PATH)
    const uiDirectionExists = await ports.pathExists(uiDirectionAbsolutePath).catch(() => false)
    if (uiDirectionExists) {
      const stats = await statFor(uiDirectionAbsolutePath, ports)
      if (isNewOrModifiedSinceBaseline(baseline, UI_DIRECTION_RELATIVE_PATH, stats)) {
        entries.push({
          name: basename(UI_DIRECTION_RELATIVE_PATH),
          relativePath: UI_DIRECTION_RELATIVE_PATH,
          absolutePath: uiDirectionAbsolutePath,
          kind: 'notes',
          typeLabel: typeLabelFor(UI_DIRECTION_RELATIVE_PATH, 'notes'),
          ...metadataFrom(stats),
        })
      }
    }
  }

  if (roots.inspiration) {
    const inspirationFiles = await collectFilesUnder(
      joinWorkspacePath(workspaceRoot, INSPIRATION_DIRECTORY_NAME),
      INSPIRATION_DIRECTORY_NAME,
      ports,
      0,
    )
    for (const file of inspirationFiles) {
      entries.push({
        ...file,
        kind: 'inspiration',
        typeLabel: typeLabelFor(file.name, 'inspiration'),
        ...metadataFrom(await statFor(file.absolutePath, ports)),
      })
    }
  }

  if (roots.designSystemBundle) {
    const bundleFiles = await collectFilesUnder(
      joinWorkspacePath(workspaceRoot, DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME),
      DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME,
      ports,
      0,
    )
    for (const file of bundleFiles) {
      const kind = classifyDesignSystemBundleFile(file.name)
      if (!kind) continue
      entries.push({
        ...file,
        kind,
        typeLabel: typeLabelFor(file.name, kind),
        ...metadataFrom(await statFor(file.absolutePath, ports)),
      })
    }
  }

  return buildDesignArtifactIndex(entries)
}

/** Count only files under `design-system/` — the honest "in the bundle" count. */
export function designSystemBundleFileCount(index: DesignArtifactIndex): number {
  const bundlePrefix = `${DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME}/`
  return index.entries.filter((entry) => entry.relativePath.startsWith(bundlePrefix)).length
}
