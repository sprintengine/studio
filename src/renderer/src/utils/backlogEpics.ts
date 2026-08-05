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
  type BacklogItemStatus,
  backlogItemSlugFromPath,
  isBacklogHighlightColor,
  nextArchiveRelativePath,
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

/**
 * Child statuses that are not work, and so are not imported as tasks.
 *
 * MIRRORS `CLOSED_CHILD_STATUSES` in `sprintengine_core/tool/plans.py` — the
 * engine's direct import skips exactly these, and the dialog's count of what
 * goes in has to be the same count, because with no plan gate there is no later
 * stop where a disagreement would surface (MC-2129).
 */
export const CLOSED_EPIC_CHILD_STATUSES: ReadonlySet<BacklogItemStatus> = new Set<BacklogItemStatus>([
  'completed',
  'archived',
  'idea',
])

/** What an epic contributes to a sprint: the tasks it mints, and what stays out. */
export type EpicImportCounts = { open: number; closed: number }

export function epicImportCounts(items: BacklogItem[], slug: string): EpicImportCounts {
  const children = childrenOfEpic(items, slug)
  const open = children.filter((child) => !CLOSED_EPIC_CHILD_STATUSES.has(child.status)).length
  return { open, closed: children.length - open }
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

// Stable per-group key for collapse state and synthetic header ids. Epic and
// unknown groups key off their slug; the single 'none' bucket uses a sentinel.
export function epicGroupKey(group: Pick<BacklogEpicGroup, 'kind' | 'slug'>): string {
  if (group.kind === 'none') return '__none__'
  return `${group.kind}:${group.slug ?? ''}`
}

// A flattened, collapse-aware render row: a group header followed (when expanded)
// by its children, in group order. The panel maps each row to one `role="option"`
// `<li>`; `navId` is the row's stable identity for selection + `aria-activedescendant`.
// An epic header borrows the epic item's id (so cursoring it opens the epic's
// detail); unknown/no-epic headers carry no item, so they get a synthetic id.
export type BacklogGroupedRow =
  | { kind: 'header'; group: BacklogEpicGroup; navId: string; collapsed: boolean }
  | { kind: 'item'; item: BacklogItem; navId: string }

const HEADER_NAV_PREFIX = '__hdr__:'

export function backlogHeaderNavId(group: BacklogEpicGroup): string {
  if (group.kind === 'epic' && group.epic) return group.epic.id
  return `${HEADER_NAV_PREFIX}${epicGroupKey(group)}`
}

export function isBacklogHeaderNavId(navId: string): boolean {
  return navId.startsWith(HEADER_NAV_PREFIX)
}

export function groupedBacklogRows(
  groups: BacklogEpicGroup[],
  isCollapsed: (group: BacklogEpicGroup) => boolean,
): BacklogGroupedRow[] {
  const rows: BacklogGroupedRow[] = []
  for (const group of groups) {
    const collapsed = isCollapsed(group)
    rows.push({ kind: 'header', group, navId: backlogHeaderNavId(group), collapsed })
    if (!collapsed) {
      for (const item of group.children) rows.push({ kind: 'item', item, navId: item.id })
    }
  }
  return rows
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
// `auth-revamp`), independent of its directory. The membership contract keys on
// this stem (a child's `epic:` frontmatter), so anything that *moves* an epic
// file (the archive rollup) must keep the stem and the children's pointers in
// sync — see planEpicArchive. Delegates to the generalized item-slug helper so
// epics and the new `dependsOn:` axis share one definition of "the slug".
export function backlogEpicSlugFromPath(relativePath: string): string {
  return backlogItemSlugFromPath(relativePath)
}

// Exported so callers that hold an epic item (e.g. the archive-epic rollup) can
// resolve its children via `childrenOfEpic(items, epicSlug(epic))`.
export function epicSlug(epic: BacklogItem): string {
  return backlogEpicSlugFromPath(epic.relativePath)
}

// The canonical directory every epic concept file lives in.
const EPIC_DIRECTORY_PREFIX = 'backlog/epics/'

// True when a path is an active epic concept file. Frontmatter `type: epic` is the
// real definition of an epic (BacklogItem.isEpic), and scan-model consumers must
// use that. This path predicate exists for the ONE consumer that has no scan
// model: the backlog object store persists neither `type:` nor `epic:` (both live
// in frontmatter and win on every scan), so the store-only Sprint Engine run-link
// reconcile identifies an epic by its location. Every epic authored through the
// app lives at `backlog/epics/<slug>.md`; an archived epic (`backlog/archived/`)
// is deliberately excluded so a store tick never reopens a retired epic.
export function isBacklogEpicPath(relativePath: string): boolean {
  return relativePath.replace(/\\/g, '/').toLowerCase().startsWith(EPIC_DIRECTORY_PREFIX)
}

// One planned file move in an archive-epic rollup.
export type EpicArchiveMove = {
  item: BacklogItem
  // Collision-safe `backlog/archived/<name>.md` target for this item.
  archivedRel: string
  // The epic slug to write into this child's `epic:` frontmatter *before* moving
  // it, or null to leave it unchanged. Non-null only when a name collision
  // renamed the archived epic, so the child stays grouped under the new stem.
  repointEpic: string | null
}

export type EpicArchivePlan = {
  epicArchivedRel: string
  epicArchivedSlug: string
  // True when the archived epic's stem differs from its active slug (a
  // `backlog/archived/<stem>.md` name collision forced a `-N` rename).
  slugChanged: boolean
  children: EpicArchiveMove[]
}

// Pure plan for archiving an epic and its children: resolve every collision-safe
// archived target and decide which children must be re-pointed. The epic's
// target is reserved first (so a child can never steal its name and so its final
// slug is known up front); each child then gets the next free archived name. The
// membership key is the epic's filename stem, so when a collision renames the
// archived epic (`<stem>-2.md`) every child is re-pointed to the new stem —
// otherwise the archived epic would become an empty group and its children would
// scatter into "Unknown epic", breaking the single-unit rollup. The panel
// executes this plan over the real IPC; keeping it pure makes the collision
// branch unit-testable.
export function planEpicArchive(
  epic: BacklogItem,
  children: BacklogItem[],
  existingArchivedPaths: string[],
): EpicArchivePlan {
  const reserved = [...existingArchivedPaths]
  const epicArchivedRel = nextArchiveRelativePath(epic.relativePath, reserved)
  reserved.push(epicArchivedRel)
  const epicArchivedSlug = backlogEpicSlugFromPath(epicArchivedRel)
  const slugChanged = epicArchivedSlug !== epicSlug(epic)

  const moves = children.map((child): EpicArchiveMove => {
    const archivedRel = nextArchiveRelativePath(child.relativePath, reserved)
    reserved.push(archivedRel)
    return { item: child, archivedRel, repointEpic: slugChanged ? epicArchivedSlug : null }
  })
  return { epicArchivedRel, epicArchivedSlug, slugChanged, children: moves }
}

// One epic's display identity for the surfaces that render a member without the
// group header in view: its title, its optional `color:` (null when unset), and
// its human-facing display id (`MC-240`) when the scan has allocated one — the
// flat-list member chip labels itself with that id.
export type BacklogEpicMeta = { title: string; color: BacklogHighlightColor | null; displayId?: string }

// slug -> { title, color, displayId } for every epic concept file in the scan.
// The flat list (member epic chip), the option-C row tint, the child detail
// crumb, and the epic detail colour picker all resolve an epic's identity
// through this one map, so they can never disagree about a slug's colour, title,
// or id. Like groupItemsByEpic this derives down from the live scan and stores
// nothing.
export function epicMetaBySlug(items: BacklogItem[]): Map<string, BacklogEpicMeta> {
  const map = new Map<string, BacklogEpicMeta>()
  for (const item of items) {
    if (!item.isEpic) continue
    map.set(epicSlug(item), {
      title: item.title,
      color: parseEpicMeta(item).color,
      // Omit the key entirely when unallocated, so consumers/tests see a clean
      // {title, color} rather than an explicit displayId: undefined.
      ...(item.displayId ? { displayId: item.displayId } : {}),
    })
  }
  return map
}

// True completion rollup per epic slug, derived from the FULL scan — never a
// filtered view. `done` = completed children, `total` = all children. Group
// headers and flat epic rows both read this map, so a lens that hides children
// (Epics shows only the containers; Active hides completed members) can no
// longer zero the fraction the way the view-relative group progress did.
// Dangling slugs (children whose epic file is missing) roll up too, so an
// Unknown-epic header stays accurate.
export type BacklogEpicProgress = { done: number; total: number }

export function epicProgressBySlug(items: BacklogItem[]): Map<string, BacklogEpicProgress> {
  const map = new Map<string, BacklogEpicProgress>()
  const entryFor = (slug: string): BacklogEpicProgress => {
    const existing = map.get(slug)
    if (existing) return existing
    const created = { done: 0, total: 0 }
    map.set(slug, created)
    return created
  }
  for (const item of items) {
    if (item.isEpic) {
      // Ensure a childless epic still resolves to an accurate 0/0.
      entryFor(epicSlug(item))
      continue
    }
    if (!item.epic) continue
    const entry = entryFor(item.epic)
    entry.total += 1
    if (item.status === 'completed') entry.done += 1
  }
  return map
}

// Epic header styling lives in the epic file's frontmatter: optional `color:`
// (one of the 7 highlight colors) and `order:` (sort key among epic groups).
function parseEpicMeta(epic: BacklogItem): { color: BacklogHighlightColor | null; order: number } {
  const { fields } = parseBacklogFrontmatter(epic.sourceContent)
  const color = isBacklogHighlightColor(fields.color) ? fields.color : null
  const parsedOrder = Number.parseInt(fields.order ?? '', 10)
  return { color, order: Number.isNaN(parsedOrder) ? Number.POSITIVE_INFINITY : parsedOrder }
}
