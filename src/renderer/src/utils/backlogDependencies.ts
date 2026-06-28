// Pure, DOM-free dependency derivation for the Backlog, the analog of
// backlogEpics.ts for the `dependsOn:` axis. Like epic grouping, nothing here is
// persisted: the only stored relationship is each dependent's comma-separated
// `dependsOn:` frontmatter slugs (parsed into BacklogItem.dependsOn by the read
// model). Reverse "blocks" edges, the per-item "waiting" signal, cycle
// membership, and the topological order are all recomputed on every call, so the
// view can never desync from the files.
//
// Identifier = item slug = filename stem (backlogItemSlugFromPath), the same key
// the `epic:` pointer uses. Two items sharing a stem collide last-wins and are
// flagged (mirrors the epic-stem tolerance); referencing by full path is
// deferred (plan D7).
//
// No DOM/IPC imports: only the read model.

import {
  type BacklogItem,
  type BacklogItemStatus,
  backlogItemSlugFromPath,
} from './backlog'

// Active = still in flight, so a prerequisite pointing here is unresolved and a
// dependent of it is "waiting". Mirror of the BacklogItemStatus union split.
const ACTIVE_STATUSES: ReadonlySet<BacklogItemStatus> = new Set<BacklogItemStatus>([
  'idea',
  'ready',
  'in_progress',
  'needs_input',
])

// A prerequisite is resolved once its target leaves active work: `completed`
// (done) or `archived` (removed from active work, no longer blocking). Plan D3.
const RESOLVED_STATUSES: ReadonlySet<BacklogItemStatus> = new Set<BacklogItemStatus>([
  'completed',
  'archived',
])

// One prerequisite edge as the detail pane needs to render it: the declaring
// item depends on `slug`. `target` is the resolved item, or null when the slug
// is dangling (no matching file) — surfaced distinctly as an "unknown"
// prerequisite (status `'unknown'`) rather than silently dropped, so the author
// can clear the stale entry instead of the item reading ready (Fallback
// Discipline, plan D3).
export type BacklogPrerequisite = {
  slug: string
  target: BacklogItem | null
  // True iff the target exists and is completed or archived.
  resolved: boolean
  // The target's lifecycle status word for display, or 'unknown' when dangling.
  status: BacklogItemStatus | 'unknown'
}

// The full derived record for one item, everything the UI (T4) renders without
// re-deriving: its prerequisites, the items it blocks (reverse edges), whether
// it is waiting, and whether it sits on a dependency cycle.
export type BacklogDependencyNode = {
  item: BacklogItem
  // The item's own slug (filename stem).
  slug: string
  // Prerequisites this item declares, in `dependsOn` order.
  prerequisites: BacklogPrerequisite[]
  // Items that declare this item as a prerequisite (derived reverse edges),
  // sorted by path for stable rendering.
  blocks: BacklogItem[]
  // Active item with >=1 unresolved prerequisite. Completed/archived items are
  // never waiting (plan D2).
  isWaiting: boolean
  // Member of at least one dependency cycle (author error). Items merely
  // downstream of a cycle are not flagged here (they are honestly "waiting").
  inCycle: boolean
}

export type BacklogDependencyGraph = {
  // One node per input item, in input order.
  nodes: BacklogDependencyNode[]
  byItemId: Map<string, BacklogDependencyNode>
  // Resolved slug -> item (last-wins on duplicate stems).
  bySlug: Map<string, BacklogItem>
  // Topological order: prerequisites before dependents, unblocked frontier first
  // (recency desc then path), with any cycle/unorderable members appended in
  // stable path order. Always contains every input item exactly once.
  order: BacklogItem[]
  // Item ids that sit on at least one dependency cycle.
  cycleItemIds: Set<string>
  // Stems shared by more than one item (collision, last-wins), sorted.
  duplicateSlugs: string[]
  hasCycle: boolean
}

function isPrerequisiteResolved(target: BacklogItem | null): boolean {
  return target != null && RESOLVED_STATUSES.has(target.status)
}

function comparePath(a: BacklogItem, b: BacklogItem): number {
  return a.relativePath.localeCompare(b.relativePath)
}

// Frontier ordering: most-recently-updated first (matching the recently-updated
// sort), path ascending as a deterministic tiebreak.
function compareFrontier(a: BacklogItem, b: BacklogItem): number {
  if (a.modifiedAt !== b.modifiedAt) return b.modifiedAt - a.modifiedAt
  return comparePath(a, b)
}

// Derive the whole dependency graph from the items' `dependsOn` slugs. Pure and
// recomputed on every call (no persistence). Edges connect existing items only:
// a dangling slug becomes an unknown prerequisite but adds no node/edge, and an
// item's own slug is already dropped upstream so it can never block itself.
export function deriveBacklogDependencies(items: BacklogItem[]): BacklogDependencyGraph {
  // slug -> item, last-wins on duplicate stems (deterministic; stems are unique
  // in practice). Collisions are flagged so the UI can warn.
  const bySlug = new Map<string, BacklogItem>()
  const seenSlugs = new Set<string>()
  const duplicateSlugs = new Set<string>()
  for (const item of items) {
    const slug = backlogItemSlugFromPath(item.relativePath)
    if (seenSlugs.has(slug)) duplicateSlugs.add(slug)
    seenSlugs.add(slug)
    bySlug.set(slug, item)
  }

  // Forward edges (prerequisite target -> dependent) as reverse "blocks" lists,
  // per-item prerequisite records, and indegree (count of existing-item
  // prerequisites) for the topological sort.
  const prerequisitesByItemId = new Map<string, BacklogPrerequisite[]>()
  const blocksByItemId = new Map<string, BacklogItem[]>()
  const indegree = new Map<string, number>()
  for (const item of items) indegree.set(item.id, 0)

  for (const item of items) {
    const prerequisites: BacklogPrerequisite[] = []
    for (const slug of item.dependsOn ?? []) {
      const target = bySlug.get(slug) ?? null
      // Defensive: a duplicate-stem map could in theory resolve a slug back to
      // the declaring item; never let an item block itself or count as its own
      // prerequisite.
      if (target && target.id === item.id) continue
      prerequisites.push({
        slug,
        target,
        resolved: isPrerequisiteResolved(target),
        status: target ? target.status : 'unknown',
      })
      if (target) {
        const blocks = blocksByItemId.get(target.id)
        if (blocks) blocks.push(item)
        else blocksByItemId.set(target.id, [item])
        indegree.set(item.id, (indegree.get(item.id) ?? 0) + 1)
      }
    }
    prerequisitesByItemId.set(item.id, prerequisites)
  }

  const cycleItemIds = detectCycleItemIds(items, blocksByItemId, prerequisitesByItemId, indegree)
  const order = topologicalOrder(items, blocksByItemId, indegree)

  const nodes: BacklogDependencyNode[] = items.map((item) => {
    const prerequisites = prerequisitesByItemId.get(item.id) ?? []
    const blocks = [...(blocksByItemId.get(item.id) ?? [])].sort(comparePath)
    const isWaiting =
      ACTIVE_STATUSES.has(item.status) && prerequisites.some((prerequisite) => !prerequisite.resolved)
    return {
      item,
      slug: backlogItemSlugFromPath(item.relativePath),
      prerequisites,
      blocks,
      isWaiting,
      inCycle: cycleItemIds.has(item.id),
    }
  })

  const byItemId = new Map(nodes.map((node) => [node.item.id, node]))
  return {
    nodes,
    byItemId,
    bySlug,
    order,
    cycleItemIds,
    duplicateSlugs: [...duplicateSlugs].sort(),
    hasCycle: cycleItemIds.size > 0,
  }
}

// Kahn's algorithm. The ready frontier (indegree 0) is emitted best-first
// (compareFrontier); each emission frees its dependents. Whatever cannot drain
// — cycle members and everything downstream of a cycle — is appended in stable
// path order so the result is always finite and never drops an item.
function topologicalOrder(
  items: BacklogItem[],
  blocksByItemId: Map<string, BacklogItem[]>,
  indegree: Map<string, number>,
): BacklogItem[] {
  const remaining = new Map(indegree)
  const emitted: BacklogItem[] = []
  const emittedIds = new Set<string>()
  const frontier = items.filter((item) => (remaining.get(item.id) ?? 0) === 0)

  while (frontier.length > 0) {
    frontier.sort(compareFrontier)
    const next = frontier.shift() as BacklogItem
    emitted.push(next)
    emittedIds.add(next.id)
    for (const dependent of blocksByItemId.get(next.id) ?? []) {
      const left = (remaining.get(dependent.id) ?? 0) - 1
      remaining.set(dependent.id, left)
      if (left === 0) frontier.push(dependent)
    }
  }

  const leftovers = items.filter((item) => !emittedIds.has(item.id)).sort(comparePath)
  return [...emitted, ...leftovers]
}

// Item ids on at least one dependency cycle. Kahn's leftovers also include nodes
// merely downstream of a cycle, so cycle membership is computed separately by
// iteratively pruning sources (no remaining prerequisite) and sinks (blocks
// nothing remaining): a node can only sit on a cycle if it keeps both an
// incoming and an outgoing edge within the surviving set. Whatever survives is
// exactly the union of all cycles. Self-references are dropped upstream, so a
// surviving singleton never occurs.
function detectCycleItemIds(
  items: BacklogItem[],
  blocksByItemId: Map<string, BacklogItem[]>,
  prerequisitesByItemId: Map<string, BacklogPrerequisite[]>,
  indegree: Map<string, number>,
): Set<string> {
  const alive = new Set(items.map((item) => item.id))
  const indeg = new Map(indegree)
  const outdeg = new Map<string, number>()
  for (const item of items) outdeg.set(item.id, (blocksByItemId.get(item.id) ?? []).length)

  let changed = true
  while (changed) {
    changed = false
    for (const id of [...alive]) {
      if ((indeg.get(id) ?? 0) > 0 && (outdeg.get(id) ?? 0) > 0) continue
      alive.delete(id)
      changed = true
      // Drop this node's outgoing edges (it blocks these dependents).
      for (const dependent of blocksByItemId.get(id) ?? []) {
        if (alive.has(dependent.id)) indeg.set(dependent.id, (indeg.get(dependent.id) ?? 0) - 1)
      }
      // Drop this node's incoming edges (its prerequisite targets block it).
      for (const prerequisite of prerequisitesByItemId.get(id) ?? []) {
        const target = prerequisite.target
        if (target && alive.has(target.id)) outdeg.set(target.id, (outdeg.get(target.id) ?? 0) - 1)
      }
    }
  }
  return alive
}

// Topological order of the items by their dependency edges (plan D4, the
// "Dependency order" sort): prerequisites before dependents, unblocked frontier
// first. Cycle/unorderable members are appended, never dropped. Thin wrapper so
// the panel can branch to it in place of `[...].sort(compareBacklogItems)`.
export function orderItemsByDependencies(items: BacklogItem[]): BacklogItem[] {
  return deriveBacklogDependencies(items).order
}
