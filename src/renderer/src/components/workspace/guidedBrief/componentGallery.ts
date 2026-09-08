import {
  DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME,
  type DesignArtifactEntry,
  type DesignArtifactIndex,
} from './designArtifacts'

// Pure model for the live component gallery (MC-1509). No React here so the
// grid's grouping/counting/keying decisions are unit-tested in
// guidedBriefFlow.test.ts against the same DesignArtifactIndex the pane renders
// from. The gallery reads nothing new: it re-derives from the run-scoped index
// (`useDesignerSession`'s existing `design-system/` watch + 2.5s poll), so it
// re-collects on the same events with no new watchers or IPC.

const COMPONENTS_PREFIX = `${DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME}/components/`
const GLYPHS_PREFIX = `${DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME}/glyphs/`
const FOUNDATIONS_PREFIX = `${DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME}/foundations/`

// A component with a real `component.html` renders live; a component directory
// that exists (some file under it) but has no `component.html` yet is still
// being built — it shows a designed building card in place so the user watches
// the system grow rather than waiting for a whole-grid refresh.
type GalleryComponentState = 'ready' | 'building'

export type GalleryComponent = {
  /** Directory name under components/, e.g. `task-card`. */
  name: string
  /** Sentence-case fallback title; the pane upgrades it from component.md. */
  fallbackTitle: string
  /** `design-system/components/<name>` (workspace-root-relative). */
  dirRelativePath: string
  /** component.html relative path when it exists (ready state). */
  htmlRelativePath: string | null
  /** component.html absolute path for the sandboxed render. */
  htmlAbsolutePath: string | null
  /** component.md relative path when it exists (title source). */
  mdRelativePath: string | null
  /** component.md absolute path for the title read. */
  mdAbsolutePath: string | null
  /** Cache/remount key for the title read: `path::mtime`, or null when absent. */
  mdKey: string | null
  /**
   * Remount key for the live render: `path::mtime`. Changing it re-reads the
   * card so only components whose html actually changed re-render.
   */
  renderKey: string
  state: GalleryComponentState
}

export type GalleryGlyph = {
  /** File name without extension, e.g. `search`. */
  name: string
  relativePath: string
  absolutePath: string
  /** Cache key for the svg read: `path::mtime`. */
  key: string
}

type GalleryFoundationId = 'tokens' | 'principles'

export type GalleryFoundation = {
  id: GalleryFoundationId
  title: string
  /** Short mono meta — the file the card opens. */
  relativePath: string
  absolutePath: string
}

export type ComponentGalleryModel = {
  components: GalleryComponent[]
  glyphs: GalleryGlyph[]
  foundations: GalleryFoundation[]
  /** Count of components whose component.html exists (renderable). */
  builtCount: number
  /** Count of component directories still missing component.html. */
  buildingCount: number
  /** True when nothing in the bundle is worth showing yet (designed empty). */
  isEmpty: boolean
}

/** Sentence-case a kebab/snake component directory name: `task-card` → `Task card`. */
export function humanizeComponentName(name: string): string {
  const words = name.replace(/[-_]+/g, ' ').trim()
  if (!words) return name
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** First `# ` heading of a component.md, trimmed; null when there is none. */
export function componentTitleFromMarkdown(markdown: string): string | null {
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^#\s+(.+?)\s*$/.exec(line)
    if (match) return match[1].trim() || null
  }
  return null
}

/** The display title for a component: its component.md heading, else the dir name. */
export function galleryComponentTitle(
  component: GalleryComponent,
  markdown: string | undefined,
): string {
  const fromMarkdown = markdown ? componentTitleFromMarkdown(markdown) : null
  return fromMarkdown ?? component.fallbackTitle
}

function keyFor(entry: DesignArtifactEntry): string {
  return `${entry.relativePath}::${entry.modifiedAtMs ?? 0}`
}

function findEntry(index: DesignArtifactIndex, relativePath: string): DesignArtifactEntry | null {
  return index.entries.find((entry) => entry.relativePath === relativePath) ?? null
}

function collectComponents(index: DesignArtifactIndex): GalleryComponent[] {
  // A component contributes several files (component.html / .css / .md); collect
  // the distinct directory names, then resolve each one's html + md.
  const names = new Set<string>()
  for (const entry of index.entries) {
    if (!entry.relativePath.startsWith(COMPONENTS_PREFIX)) continue
    const rest = entry.relativePath.slice(COMPONENTS_PREFIX.length)
    const name = rest.split('/')[0]
    if (name) names.add(name)
  }

  return Array.from(names)
    .sort((a, b) => a.localeCompare(b))
    .map((name): GalleryComponent => {
      const dirRelativePath = `${COMPONENTS_PREFIX}${name}`
      const htmlEntry = findEntry(index, `${dirRelativePath}/component.html`)
      const mdEntry = findEntry(index, `${dirRelativePath}/component.md`)
      return {
        name,
        fallbackTitle: humanizeComponentName(name),
        dirRelativePath,
        htmlRelativePath: htmlEntry?.relativePath ?? null,
        htmlAbsolutePath: htmlEntry?.absolutePath ?? null,
        mdRelativePath: mdEntry?.relativePath ?? null,
        mdAbsolutePath: mdEntry?.absolutePath ?? null,
        mdKey: mdEntry ? keyFor(mdEntry) : null,
        renderKey: htmlEntry ? keyFor(htmlEntry) : `${dirRelativePath}::building`,
        state: htmlEntry ? 'ready' : 'building',
      }
    })
}

function collectGlyphs(index: DesignArtifactIndex): GalleryGlyph[] {
  return index.entries
    .filter(
      (entry) =>
        entry.relativePath.startsWith(GLYPHS_PREFIX) && entry.relativePath.endsWith('.svg'),
    )
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    .map((entry) => ({
      name: entry.name.replace(/\.svg$/i, ''),
      relativePath: entry.relativePath,
      absolutePath: entry.absolutePath,
      key: keyFor(entry),
    }))
}

function collectFoundations(index: DesignArtifactIndex): GalleryFoundation[] {
  const foundations: GalleryFoundation[] = []
  // Tokens: the human-editable source is preferred (tokens.tokens.json); fall
  // back to the derived tokens.css. Either opens the foundations file in View.
  const tokensEntry =
    findEntry(index, `${FOUNDATIONS_PREFIX}tokens.tokens.json`) ??
    findEntry(index, `${FOUNDATIONS_PREFIX}tokens.css`)
  if (tokensEntry) {
    foundations.push({
      id: 'tokens',
      title: 'Design tokens',
      relativePath: tokensEntry.relativePath,
      absolutePath: tokensEntry.absolutePath,
    })
  }
  const principlesEntry = findEntry(index, `${FOUNDATIONS_PREFIX}principles.md`)
  if (principlesEntry) {
    foundations.push({
      id: 'principles',
      title: 'Principles',
      relativePath: principlesEntry.relativePath,
      absolutePath: principlesEntry.absolutePath,
    })
  }
  return foundations
}

/**
 * Derive the gallery's sections from the run-scoped design artifact index. The
 * index already carries every bundle file with its path + mtime and re-collects
 * on the existing watch/poll, so the gallery needs no watcher or IPC of its own —
 * it re-renders when the index changes and keys each card by path + mtime.
 */
export function buildComponentGalleryModel(index: DesignArtifactIndex): ComponentGalleryModel {
  const components = collectComponents(index)
  const glyphs = collectGlyphs(index)
  const foundations = collectFoundations(index)
  const builtCount = components.filter((component) => component.state === 'ready').length
  const buildingCount = components.length - builtCount
  return {
    components,
    glyphs,
    foundations,
    builtCount,
    buildingCount,
    isEmpty: components.length === 0 && glyphs.length === 0 && foundations.length === 0,
  }
}

/** Honest right-aligned count for the Components section header. */
export function componentSectionCountLabel(model: ComponentGalleryModel): string {
  if (model.buildingCount > 0) {
    return `${model.builtCount} built · ${model.buildingCount} building`
  }
  return `${model.components.length}`
}
