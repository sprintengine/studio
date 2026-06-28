// Pure, DOM-free epic grouping for the Backlog. Grouping is derived down and
// stored up (see docs/backlog-item-schema.md): the only stored relationship is a
// child's `epic:` frontmatter slug; an epic's children are recomputed here on
// every call as `items.filter(i => i.epic === slug)` and never persisted, so the
// view can never desync. Epic concept files (`type: epic`) are surfaced only as
// group headers and removed from the leaf list.
//
// No DOM/IPC imports: only the read model and the shared frontmatter parser.

import { parseBacklogFrontmatter } from '../../../shared/backlog/frontmatter'
import {
  type BacklogDifficulty,
  type BacklogHighlightColor,
  type BacklogItem,
  isBacklogHighlightColor,
  normalizeRelativePath,
} from './backlog'

export const NO_EPIC_TITLE = 'No epic'
export const UNKNOWN_EPIC_TITLE = 'Unknown epic'

export type BacklogEpicGroupKind = 'epic' | 'unknown' | 'none'

export type BacklogEpicGroup = {
  // 'epic' = a real epic concept file; 'unknown' = a dangling `epic:` slug with no
  // concept file; 'none' = items with no `epic:` at all.
  kind: BacklogEpicGroupKind
  // The epic concept item for `kind: 'epic'`, otherwise null.
  epic: BacklogItem | null
  // The epic slug for 'epic'/'unknown' groups; null for the 'none' group.
  slug: string | null
  // Epic `# Heading` title, or the 'No epic' / 'Unknown epic' label.
  title: string
  children: BacklogItem[]
  progress: { done: number; total: number }
  // Rollup of child difficulty as size points (xs=1 … xl=5); children without a
  // difficulty contribute 0. A calm at-a-glance total for the group header.
  aggregateSize: number
  // The epic file's `color:` frontmatter (one of the 7 highlight colors) when set,
  // else null so the panel can fall back to its own styling.
  color: BacklogHighlightColor | null
}

const SIZE_POINTS: Record<BacklogDifficulty, number> = { xs: 1, s: 2, m: 3, l: 4, xl: 5 }

// The leaf children of one epic slug: every non-epic item pointing up at it.
export function childrenOfEpic(items: BacklogItem[], slug: string): BacklogItem[] {
  return items.filter((item) => !item.isEpic && item.epic === slug)
}

// Partition items into ordered epic groups. Order: real epics by their `order:`
// then title, then `Unknown epic` groups (by slug), then the `No epic` group last.
// Items are never dropped — a dangling `epic:` slug becomes an Unknown group.
export function groupItemsByEpic(items: BacklogItem[]): BacklogEpicGroup[] {
  const epicItems = items.filter((item) => item.isEpic)
  const leaves = items.filter((item) => !item.isEpic)

  // slug -> epic concept item. Filename stem is the slug; on the rare duplicate
  // stem, the last epic wins (deterministic, and stems are unique in practice).
  const epicBySlug = new Map<string, BacklogItem>()
  for (const epic of epicItems) epicBySlug.set(epicSlug(epic), epic)

  const noEpic: BacklogItem[] = []
  const danglingBySlug = new Map<string, BacklogItem[]>()
  for (const leaf of leaves) {
    if (!leaf.epic) {
      noEpic.push(leaf)
      continue
    }
    if (!epicBySlug.has(leaf.epic)) {
      const bucket = danglingBySlug.get(leaf.epic)
      if (bucket) bucket.push(leaf)
      else danglingBySlug.set(leaf.epic, [leaf])
    }
  }

  const epicGroups = Array.from(epicBySlug, ([slug, epic]) => {
    const meta = parseEpicMeta(epic)
    return { group: buildGroup('epic', epic, slug, epic.title, childrenOfEpic(items, slug), meta.color), order: meta.order }
  })
  epicGroups.sort((a, b) => a.order - b.order || a.group.title.localeCompare(b.group.title))

  const unknownGroups = Array.from(danglingBySlug, ([slug, children]) =>
    buildGroup('unknown', null, slug, UNKNOWN_EPIC_TITLE, children, null),
  ).sort((a, b) => (a.slug ?? '').localeCompare(b.slug ?? ''))

  const groups: BacklogEpicGroup[] = [...epicGroups.map((entry) => entry.group), ...unknownGroups]
  if (noEpic.length > 0) groups.push(buildGroup('none', null, null, NO_EPIC_TITLE, noEpic, null))
  return groups
}

function buildGroup(
  kind: BacklogEpicGroupKind,
  epic: BacklogItem | null,
  slug: string | null,
  title: string,
  children: BacklogItem[],
  color: BacklogHighlightColor | null,
): BacklogEpicGroup {
  const done = children.reduce((count, child) => (child.status === 'completed' ? count + 1 : count), 0)
  const aggregateSize = children.reduce((sum, child) => sum + (child.difficulty ? SIZE_POINTS[child.difficulty] : 0), 0)
  return { kind, epic, slug, title, children, progress: { done, total: children.length }, aggregateSize, color }
}

// Slug = the epic file's filename stem (e.g. `backlog/epics/auth-revamp.md` ->
// `auth-revamp`), independent of its directory.
function epicSlug(epic: BacklogItem): string {
  const name = normalizeRelativePath(epic.relativePath).split('/').filter(Boolean).at(-1) ?? epic.relativePath
  return name.replace(/\.md$/i, '')
}

// Epic header styling lives in the epic file's frontmatter: optional `color:`
// (one of the 7 highlight colors) and `order:` (sort key among epic groups).
function parseEpicMeta(epic: BacklogItem): { color: BacklogHighlightColor | null; order: number } {
  const { fields } = parseBacklogFrontmatter(epic.sourceContent)
  const color = isBacklogHighlightColor(fields.color) ? fields.color : null
  const parsedOrder = Number.parseInt(fields.order ?? '', 10)
  return { color, order: Number.isNaN(parsedOrder) ? Number.POSITIVE_INFINITY : parsedOrder }
}
