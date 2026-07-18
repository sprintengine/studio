// The roadmap object: the data/logic substrate an orchestrator (MC-1619) walks.
// A roadmap is a `backlog/roadmaps/<name>.md` file — frontmatter policies plus a
// human-readable body whose markdown sections are lanes and whose list entries
// reference backlog files (`backlog/foo.md`) or epics (`backlog/epics/bar.md`).
// This module is the orchestrator's CONTRACT: format, discovery, parse/validate,
// and the pure eligibility function. It adds NO orchestration behavior — it is
// inert until MC-1619 consumes it.
//
// Node-free by construction (tsconfig.web-safe): it must never import from
// src/main, and — because src/shared cannot import renderer types either — it
// re-uses only the shared status payload union (BacklogItemStatusPayload) and the
// shared frontmatter helper. The renderer read model
// (BacklogItem, backlogDependencies.ts) and the MC-1617 epic roll-up
// (backlogLinks.ts nextBacklogItemStatusFromLinks) live in src/renderer and
// cannot be imported here; the two contracts this module mirrors are called out
// where they are re-implemented so the pair stays aligned:
//   - dependency resolution === backlogDependencies.ts RESOLVED_STATUSES
//     (a prerequisite is resolved once completed or archived);
//   - an epic entry derives from its children (MC-1617): the entry is terminal
//     only when every child is terminal, and it contributes its children as the
//     units the lane actually runs.

import {
  parseBacklogFrontmatter,
  serializeBacklogFrontmatterFields,
  type BacklogFrontmatterUpdates,
} from './frontmatter'
import type { BacklogItemStatusPayload } from '../electron-api'

// The frontmatter `type:` value that marks a file as a roadmap. Deliberately NOT
// added to the closed `BacklogTypePayload`/`BacklogType` unions: the renderer read
// model keeps roadmap an OKF-tolerated leaf (`rawType`), and the main-process
// listing tags it with an `isRoadmap` flag rather than the closed type field
// (src/main/backlog-service.ts). Roadmaps live only under `ROADMAPS_DIR_PREFIX`.
export const ROADMAP_TYPE = 'roadmap'
export const ROADMAPS_DIR_PREFIX = 'backlog/roadmaps/'
const EPICS_DIR_PREFIX = 'backlog/epics/'
const BACKLOG_DIR_PREFIX = 'backlog/'

// A roadmap's execution policy, all frontmatter scalars with V1 defaults.
export type RoadmapAdvancePolicy = 'approve' | 'auto'
export type RoadmapMergePolicy = 'manual' | 'auto'
export type RoadmapPolicy = {
  // Whether advancing to the next lane entry waits on human approval or proceeds
  // automatically. Default 'approve' — the conservative gate.
  advance: RoadmapAdvancePolicy
  // Whether a delivered entry's PR is merged by a human or automatically. Default
  // 'manual' — merging is a human call (see sprint-engine-pull-requests).
  merge: RoadmapMergePolicy
  // How many lanes may be actively executing per repo at once. Default 1.
  concurrency: number
}

export const DEFAULT_ROADMAP_POLICY: RoadmapPolicy = {
  advance: 'approve',
  merge: 'manual',
  concurrency: 1,
}

// One list entry in a lane. `item` and `epic` are decided by the reference path
// shape at parse time; `unknown` is assigned by validateRoadmap when the ref
// names no known backlog file (surfaced, never silently dropped — Fallback
// Discipline). An epic entry carries the child references SNAPSHOTTED beneath it
// (V1 plans are static): a bare epic ref cannot reconstruct what was captured, so
// the "gained N items" drift check (roadmapEpicDrift) is a set difference against
// this stored list.
export type RoadmapEntryKind = 'item' | 'epic' | 'unknown'

export type RoadmapEntry = {
  kind: RoadmapEntryKind
  // Project-relative backlog reference, e.g. 'backlog/foo.md' or
  // 'backlog/epics/auth.md'. Normalized (forward slashes, no leading slash).
  ref: string
  // Snapshotted child references for an epic entry, in the stored order. Empty
  // for item/unknown entries. Each child is itself a plain backlog ref.
  children: string[]
}

export type RoadmapLane = {
  // The lane heading text (the `## ` line), verbatim.
  title: string
  entries: RoadmapEntry[]
}

// A structural problem found while parsing the body, surfaced rather than thrown
// so a malformed roadmap still parses into the best-effort model the UI can show.
export type RoadmapParseIssue = {
  // 1-based line number within the body (frontmatter excluded).
  line: number
  kind: 'entry_before_lane' | 'child_before_entry' | 'child_under_non_epic' | 'unparseable_entry'
  message: string
}

export type Roadmap = {
  // Parsed frontmatter policy scalars.
  policy: RoadmapPolicy
  // Frontmatter `status:` when a valid lifecycle status, else undefined.
  status?: BacklogItemStatusPayload
  // Frontmatter `id:` integer when present and parseable.
  numericId?: number
  // The roadmap title: the first body `# Heading`, else undefined.
  title?: string
  lanes: RoadmapLane[]
  // The markdown body with frontmatter stripped, preserved byte-for-byte. The
  // canonical write path only ever edits frontmatter scalars through
  // serializeBacklogFrontmatterFields, so a policy change leaves this untouched
  // (backlog-service precedent). renderRoadmapBody re-emits an equivalent body
  // for the authoring UI (T4), which owns structural body edits.
  body: string
  issues: RoadmapParseIssue[]
}

export function isRoadmapRelativePath(pathValue: string): boolean {
  return normalizeRef(pathValue).startsWith(ROADMAPS_DIR_PREFIX)
}

// True when a parsed backlog file is a roadmap: either it lives in the roadmaps
// directory or it declares `type: roadmap`. Mirrors the epic dual-signal test in
// backlog-service.ts (path prefix OR frontmatter type).
export function isRoadmapContent(relativePath: string, frontmatterType: string | undefined): boolean {
  return isRoadmapRelativePath(relativePath) || frontmatterType === ROADMAP_TYPE
}

// The stable per-item slug = the file's name stem, independent of its directory.
// Mirrors backlogItemSlugFromPath (src/renderer/src/utils/backlog.ts) — the key
// the `dependsOn:` and `epic:` pointers reference — re-spelled here to stay
// node-free and renderer-free.
export function roadmapRefSlug(ref: string): string {
  const name = normalizeRef(ref).split('/').filter(Boolean).at(-1) ?? ref
  return name.replace(/\.(md|html?)$/i, '')
}

function normalizeRef(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').trim()
}

// A backlog reference is one that points into the backlog tree at a source file.
function looksLikeBacklogRef(value: string): boolean {
  const normalized = normalizeRef(value)
  return normalized.startsWith(BACKLOG_DIR_PREFIX) && /\.(md|html?)$/i.test(normalized)
}

function entryKindForRef(ref: string): Exclude<RoadmapEntryKind, 'unknown'> {
  return normalizeRef(ref).startsWith(EPICS_DIR_PREFIX) ? 'epic' : 'item'
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

// Parse a roadmap file into its policy, lanes, and preserved body. Never throws:
// a body that breaks the entry/lane grammar still yields the best-effort lanes it
// could recover plus a structured issue per offending line.
export function parseRoadmap(content: string): Roadmap {
  const { fields, body } = parseBacklogFrontmatter(content)
  const policy = parseRoadmapPolicy(fields)
  const status = isBacklogStatus(fields.status) ? fields.status : undefined
  const numericId = parseNumericId(fields.id)

  const lanes: RoadmapLane[] = []
  const issues: RoadmapParseIssue[] = []
  let title: string | undefined
  let currentLane: RoadmapLane | null = null
  let currentEntry: RoadmapEntry | null = null

  const lines = body.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]
    const lineNumber = index + 1

    const heading = /^(#{1,6})\s+(.*)$/.exec(rawLine)
    if (heading) {
      const level = heading[1].length
      const text = heading[2].trim()
      if (level === 1) {
        if (title === undefined) title = text
      } else if (level === 2) {
        // Only `##` starts a lane. Deeper headings (`###` notes) are left as
        // opaque body prose so a hand-authored subsection is not a spurious lane.
        currentLane = { title: text, entries: [] }
        currentEntry = null
        lanes.push(currentLane)
      }
      continue
    }

    const listItem = /^(\s*)-\s+(.*\S)\s*$/.exec(rawLine)
    if (!listItem) continue
    const indent = listItem[1].replace(/\t/g, '  ').length
    const ref = normalizeRef(listItem[2].split(/\s+/)[0])

    if (indent >= 2) {
      // An indented list item is a snapshotted child of the entry above it.
      if (!currentEntry) {
        issues.push({ line: lineNumber, kind: 'child_before_entry', message: `Child "${ref}" has no parent entry.` })
        continue
      }
      if (currentEntry.kind !== 'epic') {
        issues.push({ line: lineNumber, kind: 'child_under_non_epic', message: `Child "${ref}" listed under a non-epic entry "${currentEntry.ref}".` })
        continue
      }
      currentEntry.children.push(ref)
      continue
    }

    // A top-level list item is a lane entry.
    if (!currentLane) {
      issues.push({ line: lineNumber, kind: 'entry_before_lane', message: `Entry "${ref}" appears before any lane heading.` })
      continue
    }
    if (!looksLikeBacklogRef(ref)) {
      issues.push({ line: lineNumber, kind: 'unparseable_entry', message: `List item "${listItem[2]}" is not a backlog reference.` })
      continue
    }
    currentEntry = { kind: entryKindForRef(ref), ref, children: [] }
    currentLane.entries.push(currentEntry)
  }

  return { policy, status, numericId, title, lanes, body, issues }
}

function parseRoadmapPolicy(fields: Record<string, string>): RoadmapPolicy {
  const advance = fields.advance === 'auto' ? 'auto' : 'approve'
  const merge = fields.merge === 'auto' ? 'auto' : 'manual'
  const concurrency = parsePositiveInt(fields.concurrency) ?? DEFAULT_ROADMAP_POLICY.concurrency
  return { advance, merge, concurrency }
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value.trim(), 10)
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined
}

function parseNumericId(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value.trim(), 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}

const BACKLOG_STATUSES: ReadonlySet<string> = new Set<BacklogItemStatusPayload>([
  'idea',
  'ready',
  'in_progress',
  'needs_input',
  'completed',
  'archived',
])

function isBacklogStatus(value: string | undefined): value is BacklogItemStatusPayload {
  return value !== undefined && BACKLOG_STATUSES.has(value)
}

// ---------------------------------------------------------------------------
// Frontmatter edits (canonical write path — body byte-stable)
// ---------------------------------------------------------------------------

// Edit a roadmap's policy scalars in place, preserving the body byte-for-byte.
// A thin, validating wrapper over serializeBacklogFrontmatterFields (the same
// serializer the Backlog service writes through), so a policy toggle never
// perturbs the lanes. Only the fields present in `updates` are touched.
export function setRoadmapPolicy(content: string, updates: Partial<RoadmapPolicy>): string {
  const frontmatterUpdates: BacklogFrontmatterUpdates = {}
  if (updates.advance !== undefined) frontmatterUpdates.advance = updates.advance
  if (updates.merge !== undefined) frontmatterUpdates.merge = updates.merge
  if (updates.concurrency !== undefined) {
    if (!Number.isInteger(updates.concurrency) || updates.concurrency < 1) {
      throw new Error(`Roadmap concurrency must be a positive integer, got ${updates.concurrency}.`)
    }
    frontmatterUpdates.concurrency = String(updates.concurrency)
  }
  return serializeBacklogFrontmatterFields(content, frontmatterUpdates)
}

// ---------------------------------------------------------------------------
// Render (canonical body serializer — for the authoring UI, T4)
// ---------------------------------------------------------------------------

// Re-emit a roadmap's body in canonical form from its lane model. Structural
// edits (reorder, lane split/merge, add/remove entries) round-trip through this;
// parse(renderRoadmapBody(...)) reproduces the same lanes/entries. The stored
// file's body is preserved verbatim on frontmatter-only edits (setRoadmapPolicy);
// this serializer is what T4 writes when the STRUCTURE changes.
export function renderRoadmapBody(roadmap: Pick<Roadmap, 'title' | 'lanes'>): string {
  const out: string[] = []
  if (roadmap.title) {
    out.push(`# ${roadmap.title}`, '')
  }
  roadmap.lanes.forEach((lane, laneIndex) => {
    if (laneIndex > 0) out.push('')
    out.push(`## ${lane.title}`)
    for (const entry of lane.entries) {
      out.push(`- ${entry.ref}`)
      for (const child of entry.children) out.push(`  - ${child}`)
    }
  })
  return out.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

export type RoadmapValidation = {
  // Entry/child references that name no known backlog file, in first-seen order.
  // Surfaced as "unknown", never dropped, so the author can clear a stale entry
  // instead of the roadmap silently reading complete.
  danglingRefs: string[]
  // Refs that sit on at least one cycle across roadmap-order edges and dependsOn
  // edges combined — an author error (something must run before itself).
  cycleRefs: string[]
  // Parse issues carried through from parseRoadmap, plus any validation notes.
  issues: RoadmapParseIssue[]
  hasCycle: boolean
}

// The minimal item state validate/eligibility read off each referenced backlog
// item — a structural subset both the renderer read model (BacklogItem) and the
// main-process listing satisfy, so callers adapt without importing this module's
// internals. `dependsOn` are prerequisite slugs (filename stems), matching the
// frontmatter axis.
export type RoadmapItemState = {
  ref: string
  status: BacklogItemStatusPayload
  dependsOn?: string[]
}

// Validate a parsed roadmap against the known backlog universe. `items` supplies
// dependsOn edges (keyed by ref) for cycle detection; without a dependsOn axis a
// roadmap's lane order is linear and cannot cycle. Dangling detection needs only
// the set of known refs.
export function validateRoadmap(
  roadmap: Roadmap,
  items: ReadonlyArray<RoadmapItemState>,
): RoadmapValidation {
  const knownRefs = new Set<string>()
  const slugToRef = new Map<string, string>()
  for (const item of items) {
    const ref = normalizeRef(item.ref)
    knownRefs.add(ref)
    slugToRef.set(roadmapRefSlug(ref), ref)
  }

  const danglingRefs: string[] = []
  const seenDangling = new Set<string>()
  const markDangling = (ref: string): void => {
    if (knownRefs.has(ref) || seenDangling.has(ref)) return
    seenDangling.add(ref)
    danglingRefs.push(ref)
  }

  // Order edges: predecessor unit -> successor unit within each lane. Units are
  // the flattened runnable references (an epic contributes its children).
  const edges = new Map<string, Set<string>>()
  const addEdge = (from: string, to: string): void => {
    if (from === to) return
    const set = edges.get(from) ?? new Set<string>()
    set.add(to)
    edges.set(from, set)
  }

  for (const lane of roadmap.lanes) {
    // Dangling is checked over every reference an author wrote — item and epic
    // entry refs plus each snapshotted child — so a stale epic file or child is
    // surfaced, not just the runnable units.
    for (const entry of lane.entries) {
      markDangling(entry.ref)
      for (const child of entry.children) markDangling(child)
    }
    // Order edges sequence the runnable units (an epic contributes its children).
    const units = flattenLaneUnits(lane)
    for (let index = 1; index < units.length; index += 1) {
      addEdge(units[index - 1].ref, units[index].ref)
    }
  }

  // Dependency edges: a prerequisite must run before its dependent, so an item
  // that dependsOn slug S gets an edge ref(S) -> item.ref. Only edges between
  // refs that both appear in the graph matter for cycle detection; a dependency
  // on an item outside the roadmap cannot close a cycle inside it.
  for (const item of items) {
    const dependentRef = normalizeRef(item.ref)
    for (const slug of item.dependsOn ?? []) {
      const prerequisiteRef = slugToRef.get(slug)
      if (prerequisiteRef) addEdge(prerequisiteRef, dependentRef)
    }
  }

  const cycleRefs = detectCycleRefs(edges)
  return {
    danglingRefs,
    cycleRefs,
    issues: roadmap.issues,
    hasCycle: cycleRefs.length > 0,
  }
}

// Tarjan's SCC over the "before" edge graph: every strongly-connected component
// of size >= 2 is exactly a set of refs that must each run before another in the
// same component — a cycle. Iterative (explicit stack) so a deep chain cannot
// overflow. Mirrors detectCycleItemIds in backlogDependencies.ts.
function detectCycleRefs(edges: Map<string, Set<string>>): string[] {
  const nodes = new Set<string>()
  for (const [from, tos] of edges) {
    nodes.add(from)
    for (const to of tos) nodes.add(to)
  }

  const index = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const sccStack: string[] = []
  const cycleRefs: string[] = []
  const seenCycle = new Set<string>()
  let counter = 0
  const neighbors = (id: string): string[] => [...(edges.get(id) ?? [])]

  for (const root of nodes) {
    if (index.has(root)) continue
    const work: Array<{ id: string; next: number; adj: string[] }> = []
    const enter = (id: string): void => {
      index.set(id, counter)
      lowlink.set(id, counter)
      counter += 1
      sccStack.push(id)
      onStack.add(id)
      work.push({ id, next: 0, adj: neighbors(id) })
    }
    enter(root)

    while (work.length > 0) {
      const frame = work[work.length - 1]
      if (frame.next < frame.adj.length) {
        const w = frame.adj[frame.next]
        frame.next += 1
        if (!index.has(w)) {
          enter(w)
        } else if (onStack.has(w)) {
          lowlink.set(frame.id, Math.min(lowlink.get(frame.id) ?? 0, index.get(w) ?? 0))
        }
        continue
      }
      if (lowlink.get(frame.id) === index.get(frame.id)) {
        const component: string[] = []
        for (;;) {
          const w = sccStack.pop() as string
          onStack.delete(w)
          component.push(w)
          if (w === frame.id) break
        }
        if (component.length > 1) {
          for (const id of component) {
            if (!seenCycle.has(id)) {
              seenCycle.add(id)
              cycleRefs.push(id)
            }
          }
        }
      }
      work.pop()
      const parent = work[work.length - 1]
      if (parent) lowlink.set(parent.id, Math.min(lowlink.get(parent.id) ?? 0, lowlink.get(frame.id) ?? 0))
    }
  }
  return cycleRefs
}

// ---------------------------------------------------------------------------
// Eligibility (the orchestrator's contract — pure, no IO)
// ---------------------------------------------------------------------------

// Per-item run state the orchestrator supplies. A lane predecessor is "merged"
// per the MC-1439 decision of record: a worktree run delivers via a pull request
// and is merged only when that PR is merged; a non-worktree ('shared') run has no
// PR, so its terminal signal is the item reaching a terminal status. Absence of a
// link means the item was never run under a tracked run — it is treated as a
// shared/manual item whose terminal signal is its status.
export type RoadmapRunState = {
  mode: 'worktree' | 'shared'
  // Worktree runs only: whether the delivering PR has merged. Ignored otherwise.
  prMerged?: boolean
}

// Why a lane has (or has not) a dispatchable entry.
// - eligible: `eligibleRef` is the concrete backlog item to dispatch next.
// - lane_complete: every unit is terminal (merged).
// - in_progress: the frontier is actively being worked (in_progress/needs_input).
// - awaiting_merge: the frontier finished but its worktree PR is not yet merged
//   (MC-1439 — a completed-but-unmerged worktree item holds the lane).
// - blocked: the frontier is not ready, or ready with unresolved prerequisites.
// - dangling: the frontier references no known backlog item.
// - empty: the lane has no entries.
export type RoadmapLaneReason =
  | 'eligible'
  | 'lane_complete'
  | 'in_progress'
  | 'awaiting_merge'
  | 'blocked'
  | 'dangling'
  | 'empty'

export type RoadmapLaneEligibility = {
  lane: string
  // The backlog ref the orchestrator should dispatch next, or null.
  eligibleRef: string | null
  reason: RoadmapLaneReason
  // The frontier unit under consideration (first non-terminal unit), for
  // diagnostics — null when the lane is complete or empty.
  frontierRef: string | null
}

export type LaneUnit = { ref: string; epic?: string }

// The runnable units of a lane: an item entry is one unit; an epic entry expands
// to its snapshotted children in order (the epic derives from children, MC-1617);
// an unknown entry still contributes its ref so a dangling frontier is visible.
// Exported so the steering surface (MC-1620) renders and counts exactly the units
// the orchestrator schedules — the board's "done vs up next" split is the frontier
// index over this same flattening, never a parallel re-derivation.
export function flattenLaneUnits(lane: RoadmapLane): LaneUnit[] {
  const units: LaneUnit[] = []
  for (const entry of lane.entries) {
    if (entry.kind === 'epic') {
      if (entry.children.length === 0) {
        // A snapshot with no children can never advance on its own; carry the
        // epic ref so the lane reports it rather than silently skipping.
        units.push({ ref: entry.ref, epic: entry.ref })
      } else {
        for (const child of entry.children) units.push({ ref: child, epic: entry.ref })
      }
      continue
    }
    units.push({ ref: entry.ref })
  }
  return units
}

const TERMINAL_STATUSES: ReadonlySet<BacklogItemStatusPayload> = new Set<BacklogItemStatusPayload>([
  'completed',
  'archived',
])

// The next eligible entry per lane. For each lane the frontier is the first unit
// that is not yet MERGED (its predecessor, by construction, is merged); the lane
// is eligible when that frontier is `ready` with every prerequisite resolved.
// Epic entries derive from their children — the children ARE the units, so an
// epic entry is terminal only when all its children are, and an epic frontier
// resolves to its first non-merged child.
export function nextEligible(
  roadmap: Roadmap,
  items: ReadonlyArray<RoadmapItemState>,
  runLinks: ReadonlyMap<string, RoadmapRunState>,
): RoadmapLaneEligibility[] {
  const byRef = new Map<string, RoadmapItemState>()
  const bySlug = new Map<string, RoadmapItemState>()
  for (const item of items) {
    const ref = normalizeRef(item.ref)
    byRef.set(ref, item)
    bySlug.set(roadmapRefSlug(ref), item)
  }

  const isMerged = (ref: string): boolean => {
    const link = runLinks.get(ref)
    if (link?.mode === 'worktree') return link.prMerged === true
    // Shared runs and manual/untracked items: terminal status is the signal.
    const state = byRef.get(ref)
    return state !== undefined && TERMINAL_STATUSES.has(state.status)
  }

  const dependsOnResolved = (state: RoadmapItemState): boolean => {
    for (const slug of state.dependsOn ?? []) {
      const target = bySlug.get(slug)
      // A dangling prerequisite is unresolved: an unknown blocker must not read
      // as satisfied (Fallback Discipline). A prerequisite is resolved once its
      // target is terminal — the backlogDependencies.ts RESOLVED_STATUSES rule.
      if (!target || !TERMINAL_STATUSES.has(target.status)) return false
    }
    return true
  }

  return roadmap.lanes.map((lane) => {
    const units = flattenLaneUnits(lane)
    if (units.length === 0) {
      return { lane: lane.title, eligibleRef: null, reason: 'empty', frontierRef: null }
    }

    const frontier = units.find((unit) => !isMerged(unit.ref))
    if (!frontier) {
      return { lane: lane.title, eligibleRef: null, reason: 'lane_complete', frontierRef: null }
    }

    const state = byRef.get(frontier.ref)
    if (!state) {
      return { lane: lane.title, eligibleRef: null, reason: 'dangling', frontierRef: frontier.ref }
    }
    if (state.status === 'ready' && dependsOnResolved(state)) {
      return { lane: lane.title, eligibleRef: frontier.ref, reason: 'eligible', frontierRef: frontier.ref }
    }
    if (state.status === 'in_progress' || state.status === 'needs_input') {
      return { lane: lane.title, eligibleRef: null, reason: 'in_progress', frontierRef: frontier.ref }
    }
    // Terminal status but not merged — only reachable for a worktree run whose PR
    // has not merged (a shared/manual terminal item is `isMerged`, so it would
    // have been skipped). The lane waits on the merge.
    if (TERMINAL_STATUSES.has(state.status)) {
      return { lane: lane.title, eligibleRef: null, reason: 'awaiting_merge', frontierRef: frontier.ref }
    }
    return { lane: lane.title, eligibleRef: null, reason: 'blocked', frontierRef: frontier.ref }
  })
}

// ---------------------------------------------------------------------------
// Static-plan drift ("this epic gained N items since you planned")
// ---------------------------------------------------------------------------

// The set difference between an epic's live `epic:` membership and the child list
// snapshotted into the roadmap at add time. V1 plans are static, so mid-epic
// children a sprint mints do NOT auto-join; this surfaces them for the one-click
// re-sync affordance (T4). `gained` are live children absent from the snapshot;
// `removed` are snapshotted children no longer live members.
export type RoadmapEpicDrift = {
  epicRef: string
  gained: string[]
  removed: string[]
}

export function roadmapEpicDrift(
  entry: RoadmapEntry,
  liveChildRefs: ReadonlyArray<string>,
): RoadmapEpicDrift {
  const snapshot = new Set(entry.children.map(normalizeRef))
  const live = new Set(liveChildRefs.map(normalizeRef))
  const gained = [...live].filter((ref) => !snapshot.has(ref))
  const removed = [...snapshot].filter((ref) => !live.has(ref))
  return { epicRef: entry.ref, gained, removed }
}
