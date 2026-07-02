import { DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME } from '../../../../../shared/design-system/bundle-scaffold'
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

export type DesignArtifactGroupId =
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

export type DesignArtifactGroup = {
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
  statPath?: (path: string) => Promise<{ modifiedAt: string; modifiedAtMs: number }>
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
export function classifyDesignSystemBundleFile(name: string): DesignArtifactKind | null {
  const extension = extensionOf(name)
  if (extension === 'md' || extension === 'markdown') return 'notes'
  return EXTENSION_KIND[extension] ?? null
}

function typeLabelFor(name: string, kind: DesignArtifactKind): string {
  if (kind === 'notes') return 'Markdown'
  const ext = extensionOf(name)
  return ext ? ext.toUpperCase() : 'File'
}

async function metadataFor(
  absolutePath: string,
  ports: DesignArtifactFsPort,
): Promise<Pick<DesignArtifactEntry, 'modifiedAt' | 'modifiedAtMs'>> {
  if (!ports.statPath) return {}
  try {
    const stats = await ports.statPath(absolutePath)
    return { modifiedAt: stats.modifiedAt, modifiedAtMs: stats.modifiedAtMs }
  } catch {
    return {}
  }
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
   * Also index the `design-system/` bundle tree. Passed only by design-system
   * preset studios so full-brief / frontend-design workspaces keep their
   * existing index untouched.
   */
  includeDesignSystemBundle?: boolean
}

/**
 * Walk the real workspace for design artifacts and return a grouped index.
 * Covers `mockups/**` (classified by extension), `product/ui-direction.md`
 * (when present), `.guided-brief/inspiration/**` (any file), and — for
 * design-system preset studios — the `design-system/**` bundle tree. All
 * paths are read through the injected port so the collector is testable with
 * an in-memory filesystem and reuses `window.api` in the renderer.
 */
export async function collectDesignArtifacts(
  workspaceRoot: string,
  ports: DesignArtifactFsPort,
  options: CollectDesignArtifactsOptions = {},
): Promise<DesignArtifactIndex> {
  const entries: DesignArtifactEntry[] = []

  const mockupFiles = await collectFilesUnder(
    joinWorkspacePath(workspaceRoot, MOCKUPS_DIRECTORY_NAME),
    MOCKUPS_DIRECTORY_NAME,
    ports,
    0,
  )
  for (const file of mockupFiles) {
    const kind = classifyMockupFile(file.name)
    if (!kind) continue
    entries.push({
      ...file,
      kind,
      typeLabel: typeLabelFor(file.name, kind),
      ...(await metadataFor(file.absolutePath, ports)),
    })
  }

  const uiDirectionAbsolutePath = joinWorkspacePath(workspaceRoot, UI_DIRECTION_RELATIVE_PATH)
  const uiDirectionExists = await ports.pathExists(uiDirectionAbsolutePath).catch(() => false)
  if (uiDirectionExists) {
    entries.push({
      name: basename(UI_DIRECTION_RELATIVE_PATH),
      relativePath: UI_DIRECTION_RELATIVE_PATH,
      absolutePath: uiDirectionAbsolutePath,
      kind: 'notes',
      typeLabel: typeLabelFor(UI_DIRECTION_RELATIVE_PATH, 'notes'),
      ...(await metadataFor(uiDirectionAbsolutePath, ports)),
    })
  }

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
      ...(await metadataFor(file.absolutePath, ports)),
    })
  }

  if (options.includeDesignSystemBundle) {
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
        ...(await metadataFor(file.absolutePath, ports)),
      })
    }
  }

  return buildDesignArtifactIndex(entries)
}
