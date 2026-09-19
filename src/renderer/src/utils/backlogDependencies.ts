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

import { type BacklogItem, type BacklogItemStatus, backlogItemSlugFromPath } from './backlog'

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
const RESOLVED_STATUSES: ReadonlySet<BacklogItemStatus> = new Set<BacklogItemStatus>(['completed', 'archived'])

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
  // Derived effective readiness (never persisted): the stored `ready` status
  // claims "can start now", and an unresolved prerequisite falsifies that
  // claim, so the item presents as Blocked instead of Ready. Only `ready`
  // flips — an `idea` makes no readiness claim (it keeps the softer "waiting"
  // marker), and in_progress / needs_input describe work already underway.
  isBlocked: boolean
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

  const cycleItemIds = detectCycleItemIds(items, blocksByItemId)
  const order = topologicalOrder(items, blocksByItemId, indegree)

  const nodes: BacklogDependencyNode[] = items.map((item) => {
    const prerequisites = prerequisitesByItemId.get(item.id) ?? []
    const blocks = [...(blocksByItemId.get(item.id) ?? [])].sort(comparePath)
    const isWaiting = ACTIVE_STATUSES.has(item.status) && prerequisites.some((prerequisite) => !prerequisite.resolved)
    return {
      item,
      slug: backlogItemSlugFromPath(item.relativePath),
      prerequisites,
      blocks,
      isWaiting,
      isBlocked: item.status === 'ready' && isWaiting,
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

// Item ids on at least one dependency cycle = the members of every strongly
// connected component of size >= 2. Computed with Tarjan's SCC over the edge
// graph (node -> the items it blocks). This is *exactly* the union of all cycles:
// it excludes nodes merely downstream of a cycle and, unlike source/sink pruning,
// a connector that bridges two disjoint cycles (reachable-from one, able-to-reach
// the other, but on neither) — it lands in its own singleton SCC. Self-references
// are dropped upstream, so a size-1 SCC never carries a self-loop and is never a
// cycle. Iterative (explicit stack) so a deep dependency chain cannot overflow.
function detectCycleItemIds(items: BacklogItem[], blocksByItemId: Map<string, BacklogItem[]>): Set<string> {
  const cycleIds = new Set<string>()
  const index = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const sccStack: string[] = []
  const neighbors = (id: string): string[] => (blocksByItemId.get(id) ?? []).map((item) => item.id)
  let counter = 0

  for (const root of items) {
    if (index.has(root.id)) continue
    // Each frame holds a node and its next-neighbor cursor; a real call stack
    // would recurse per edge, so we drive the same DFS explicitly.
    const work: Array<{ id: string; next: number; adj: string[] }> = []
    const enter = (id: string): void => {
      index.set(id, counter)
      lowlink.set(id, counter)
      counter += 1
      sccStack.push(id)
      onStack.add(id)
      work.push({ id, next: 0, adj: neighbors(id) })
    }
    enter(root.id)

    while (work.length > 0) {
      const frame = work[work.length - 1]
      if (frame.next < frame.adj.length) {
        const w = frame.adj[frame.next]
        frame.next += 1
        if (!index.has(w)) {
          enter(w)
        } else if (onStack.has(w)) {
          // Back/forward edge into the current SCC: tighten with w's index.
          lowlink.set(frame.id, Math.min(lowlink.get(frame.id) ?? 0, index.get(w) ?? 0))
        }
        continue
      }
      // Finished frame.id: if it roots an SCC, pop the whole component.
      if (lowlink.get(frame.id) === index.get(frame.id)) {
        const component: string[] = []
        for (;;) {
          const w = sccStack.pop() as string
          onStack.delete(w)
          component.push(w)
          if (w === frame.id) break
        }
        if (component.length > 1) for (const id of component) cycleIds.add(id)
      }
      work.pop()
      const parent = work[work.length - 1]
      if (parent) lowlink.set(parent.id, Math.min(lowlink.get(parent.id) ?? 0, lowlink.get(frame.id) ?? 0))
    }
  }
  return cycleIds
}

// Topological order of the items by their dependency edges (plan D4, the
// "Dependency order" sort): prerequisites before dependents, unblocked frontier
// first. Cycle/unorderable members are appended, never dropped. Thin wrapper so
// the panel can branch to it in place of `[...].sort(compareBacklogItems)`.
export function orderItemsByDependencies(items: BacklogItem[]): BacklogItem[] {
  return deriveBacklogDependencies(items).order
}

// Granular epic dependency rollup, derived down like everything else here. An
// epic's children carry the dependencies, so the container reflects them
// proportionally: `blocked` of `remaining` (non-terminal) children are gated.
// One blocked child must not freeze the whole epic — the container reads fully
// blocked only when EVERY remaining child is (isEpicFullyBlocked); anything
// less surfaces as a count beside the epic's progress meter.
export type BacklogEpicBlockedRollup = {
  // Children not yet completed/archived.
  remaining: number
  // Remaining children whose derived state is blocked (isBlocked).
  blocked: number
}

// slug -> rollup for every epic slug in the graph, keyed like epicProgressBySlug
// (an epic concept file's own slug, plus any dangling slug children point at, so
// an Unknown-epic header stays accurate). Childless epics resolve to 0/0.
export function epicBlockedRollupBySlug(graph: BacklogDependencyGraph): Map<string, BacklogEpicBlockedRollup> {
  const map = new Map<string, BacklogEpicBlockedRollup>()
  const entryFor = (slug: string): BacklogEpicBlockedRollup => {
    const existing = map.get(slug)
    if (existing) return existing
    const created = { remaining: 0, blocked: 0 }
    map.set(slug, created)
    return created
  }
  for (const node of graph.nodes) {
    if (node.item.isEpic) {
      entryFor(node.slug)
      continue
    }
    if (!node.item.epic) continue
    const entry = entryFor(node.item.epic)
    if (RESOLVED_STATUSES.has(node.item.status)) continue
    entry.remaining += 1
    if (node.isBlocked) entry.blocked += 1
  }
  return map
}

// A container is only as blocked as its least-blocked member: every remaining
// child gated (and at least one child remaining) is the sole state in which the
// epic itself has nothing startable and earns the Blocked presentation.
export function isEpicFullyBlocked(rollup: BacklogEpicBlockedRollup | undefined): boolean {
  return rollup != null && rollup.remaining > 0 && rollup.blocked === rollup.remaining
}

// The row-facing dependency marker for one item, shared by every surface that
// renders it (list rows, group headers, hover card, detail) so they can't
// disagree. 'blocked' replaces the Ready presentation outright; 'waiting' is
// the softer badge beside an unchanged status glyph. For an epic the children's
// rollup substitutes for own prerequisites: a fully gated membership blocks the
// container (only while the epic itself is still active), a partial one only
// surfaces the count.
export type BacklogDependencyState = 'waiting' | 'blocked'

export function backlogDependencyState(
  node: BacklogDependencyNode,
  epicRollup?: BacklogEpicBlockedRollup,
): BacklogDependencyState | null {
  if (node.isBlocked) return 'blocked'
  if (node.item.isEpic && ACTIVE_STATUSES.has(node.item.status) && isEpicFullyBlocked(epicRollup)) {
    return 'blocked'
  }
  if (node.isWaiting) return 'waiting'
  return null
}
