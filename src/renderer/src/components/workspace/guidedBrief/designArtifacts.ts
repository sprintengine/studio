import { basename, joinWorkspacePath } from './paths'

// Deterministic, path-based index of the real design artifacts a Multicode
// Design (frontend-design preset) workspace produces on disk. The index is
// built only from files that actually exist — there are no sample or
// placeholder rows. Modified time is intentionally omitted: the renderer
// filesystem contract (`window.api.readdir`) exposes only name + isDir, and the
// task scope explicitly avoids overloading `readfile` or adding a metadata IPC
// for v1. A narrow stat contract can add it later.

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
}

export const EMPTY_DESIGN_ARTIFACT_INDEX: DesignArtifactIndex = {
  groups: [],
  entries: [],
  count: 0,
}

export const MOCKUPS_DIRECTORY_NAME = 'mockups'
export const UI_DIRECTION_RELATIVE_PATH = 'product/ui-direction.md'
export const INSPIRATION_DIRECTORY_NAME = '.guided-brief/inspiration'

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

function typeLabelFor(name: string, kind: DesignArtifactKind): string {
  if (kind === 'notes') return 'Markdown'
  const ext = extensionOf(name)
  return ext ? ext.toUpperCase() : 'File'
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

/**
 * Walk the real workspace for design artifacts and return a grouped index.
 * Covers `mockups/**` (classified by extension), `product/ui-direction.md`
 * (when present), and `.guided-brief/inspiration/**` (any file). All paths are
 * read through the injected port so the collector is testable with an in-memory
 * filesystem and reuses `window.api` in the renderer.
 */
export async function collectDesignArtifacts(
  workspaceRoot: string,
  ports: DesignArtifactFsPort,
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
    entries.push({ ...file, kind, typeLabel: typeLabelFor(file.name, kind) })
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
    })
  }

  const inspirationFiles = await collectFilesUnder(
    joinWorkspacePath(workspaceRoot, INSPIRATION_DIRECTORY_NAME),
    INSPIRATION_DIRECTORY_NAME,
    ports,
    0,
  )
  for (const file of inspirationFiles) {
    entries.push({ ...file, kind: 'inspiration', typeLabel: typeLabelFor(file.name, 'inspiration') })
  }

  return buildDesignArtifactIndex(entries)
}
