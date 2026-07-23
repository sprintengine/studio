import type { BacklogItem } from '../../../../utils/backlog'
import type { BacklogSort, BacklogView } from '../../../../utils/backlogTriage'
import { compareBacklogItems, matchesBacklogView } from '../../../../utils/backlogTriage'
import { deriveBacklogDependencies } from '../../../../utils/backlogDependencies'
import { isRoadmapContent } from '../../../../../../shared/backlog/roadmap'
import type { BacklogProjectFeed, BacklogProjectItem } from '../../../../hooks/useAllProjectsBacklog'

// The pure ordering + filtering model for the Backlog door (T9). It composes the
// SAME lens/sort logic the per-project BacklogPanel already extracts
// (`matchesBacklogView`, `compareBacklogItems`, the dependency-graph topo order)
// over the cross-project feed, so that filtering the door to ONE project produces
// exactly that project's panel list — same visible set, same order — and "All
// projects" is a project-independent merge of those same per-project lists.
//
// Kept node-free and DOM-free so the golden acceptance (single-project filter ==
// panel `filtered`) is a plain unit test. The door component owns the feeds,
// selection, and mutations; this module owns only the meaning of the toolbar.

// The project filter: a project's normalized scan key (its feed `rootKey`), or
// the sentinel `all` for the cross-project firehose.
export const ALL_PROJECTS = 'all' as const
export type BacklogProjectFilter = string | typeof ALL_PROJECTS

// The item-level exclusions the panel applies before the lens (BacklogPanel
// `filtered`): roadmap objects live in backlog/roadmaps/ but are not work items,
// and files under backlog/mockups/ are attachments, not rows. Replicated here so
// the door hides exactly what the panel hides.
function isListableBacklogItem(item: BacklogItem): boolean {
  if (isRoadmapContent(item.relativePath, item.rawType)) return false
  if (item.relativePath.startsWith('backlog/mockups/')) return false
  return true
}

// The panel's free-text match (BacklogPanel.matchesQuery), replicated so the
// door's aggregate search narrows a project's rows identically. `query` is
// expected pre-lowercased and trimmed (matching the panel's call site).
export function matchesBacklogQuery(item: BacklogItem, query: string): boolean {
  return (
    item.title.toLowerCase().includes(query) ||
    item.relativePath.toLowerCase().includes(query) ||
    item.excerpt.toLowerCase().includes(query) ||
    (item.displayId?.toLowerCase().includes(query) ?? false) ||
    (typeof item.numericId === 'number' && String(item.numericId).includes(query))
  )
}

// The visible, UNORDERED rows of one project feed under a lens + search: the
// panel's `matched` set, tagged with the project. Roadmap/mockup exclusions and
// the lens gate run here, exactly as in the panel.
function matchedProjectItems(
  feed: BacklogProjectFeed,
  view: BacklogView,
  query: string,
): BacklogProjectItem[] {
  return feed.items.filter(({ item }) => {
    if (!isListableBacklogItem(item)) return false
    if (!matchesBacklogView(item, view)) return false
    if (query && !matchesBacklogQuery(item, query)) return false
    return true
  })
}

// One project feed's ordered visible rows — byte-for-byte the panel's `filtered`
// for that project under the same lens/sort/search. Dependency order is the
// whole-list topological transform (prerequisites first) restricted to the
// visible rows; every other sort is the stable pairwise comparator, with the
// dependency-derived blocked set demoting gated items under the status/best sorts
// (the same signal the panel passes from its graph).
export function orderProjectFeed(
  feed: BacklogProjectFeed,
  view: BacklogView,
  sort: BacklogSort,
  query: string,
): BacklogProjectItem[] {
  const matched = matchedProjectItems(feed, view, query)
  if (sort === 'dependency') {
    // Topo order is derived over the FULL feed (not the filtered view) so a
    // prerequisite hidden by the lens still orders its dependents correctly, then
    // restricted to the visible rows — mirroring the panel exactly.
    const graph = deriveBacklogDependencies(feed.items.map((entry) => entry.item))
    const visibleByItemId = new Map(matched.map((entry) => [entry.item.id, entry]))
    return graph.order
      .map((item) => visibleByItemId.get(item.id))
      .filter((entry): entry is BacklogProjectItem => entry !== undefined)
  }
  const blockedPaths = feed.derived.blockedPaths
  return [...matched].sort((a, b) =>
    compareBacklogItems(a.item, b.item, sort, (entry) => blockedPaths.has(entry.relativePath)),
  )
}

export type BacklogDoorList = {
  // The ordered, project-tagged rows to render.
  rows: BacklogProjectItem[]
  // rootKey -> count of that project's visible rows under the active lens/search,
  // for the toolbar chip counts. Includes every non-errored project (0 when a
  // lens hides all of its items), so a chip never disappears mid-session.
  countsByProject: Map<string, number>
  // Total visible rows across the active filter — the bar's item count.
  total: number
}

// The door's rows for the active toolbar state. A single-project filter is that
// project's ordered feed (== its panel). "All projects" merges every project's
// matched rows and orders them with the SAME comparator across projects — the
// sort axes are project-independent (status precedence, recency, priority, size)
// — EXCEPT "Dependency order", which has no cross-project meaning (a slug never
// crosses projects), so it stays per-project and the projects are concatenated in
// feed order (T8 sorts feeds by rootKey), grouping each project's dependency
// chain as one block.
export function buildBacklogDoorList(
  feeds: ReadonlyArray<BacklogProjectFeed>,
  filter: BacklogProjectFilter,
  view: BacklogView,
  sort: BacklogSort,
  rawQuery: string,
): BacklogDoorList {
  const query = rawQuery.trim().toLowerCase()

  const countsByProject = new Map<string, number>()
  const orderedByProject = feeds.map((feed) => {
    const ordered = orderProjectFeed(feed, view, sort, query)
    countsByProject.set(feed.rootKey, ordered.length)
    return { feed, ordered }
  })

  if (filter !== ALL_PROJECTS) {
    const match = orderedByProject.find(({ feed }) => feed.rootKey === filter)
    const rows = match ? match.ordered : []
    return { rows, countsByProject, total: rows.length }
  }

  // Dependency order has no cross-project topology: keep each project's chain
  // intact and concatenate in feed order.
  if (sort === 'dependency') {
    const rows = orderedByProject.flatMap(({ ordered }) => ordered)
    return { rows, countsByProject, total: rows.length }
  }

  // Every other sort is project-independent: merge the matched rows and order
  // once. Blocked demotion keys on the row's OWN feed (relativePaths can collide
  // across projects), resolved through per-item object identity so the merged
  // comparator matches each project's own blocked signal.
  const blockedItems = new Set<BacklogItem>()
  const merged: BacklogProjectItem[] = []
  for (const feed of feeds) {
    for (const entry of matchedProjectItems(feed, view, query)) {
      merged.push(entry)
      if (feed.derived.blockedPaths.has(entry.item.relativePath)) blockedItems.add(entry.item)
    }
  }
  merged.sort((a, b) => compareBacklogItems(a.item, b.item, sort, (item) => blockedItems.has(item as BacklogItem)))
  return { rows: merged, countsByProject, total: merged.length }
}

// True when any project has an item awaiting a human decision — the signal for
// the sidebar door dot ("needs_input anywhere"), computed over the aggregate feed
// with the same precedence a row uses. Errored/loading feeds contribute nothing.
export function anyProjectNeedsInput(feeds: ReadonlyArray<BacklogProjectFeed>): boolean {
  return feeds.some((feed) => feed.items.some(({ item }) => item.status === 'needs_input'))
}
