// The roadmap steering surface's read model (MC-1620 / T7): the pure projection the
// board renders and the pure merge-order derivation the pull-request surface gates
// on. Node-free by construction (tsconfig.web-safe) — it imports only the T3
// roadmap substrate, the shared run types, and the T6 orchestrator's park vocabulary,
// never `src/main` or renderer. Keeping the board's "done / running / up next /
// paused" split and the "merges after <project>" rule here makes both exhaustively
// unit-testable without a running app, and keeps the board reconciling against the
// same unit model the orchestrator schedules rather than a parallel re-derivation.

import {
  flattenLaneUnits,
  nextEligible,
  roadmapRefSlug,
  type Roadmap,
  type RoadmapEntryKind,
  type RoadmapItemState,
  type RoadmapLaneReason,
  type RoadmapRunState,
} from '../backlog/roadmap'
import type { BacklogItemStatusPayload } from '../electron-api'
import type { RoadmapParkReason } from './roadmap-orchestrator'
import type { SprintEngineTask, SprintEngineVcsRepo } from './run-types'

// ---------------------------------------------------------------------------
// Wire types: what `roadmap:states:read` returns (the orchestrator's driver
// populates these). Defined here, in shared, so the main driver and the renderer
// board read ONE definition and cannot drift — the main `RoadmapView` is an alias.
// ---------------------------------------------------------------------------

// A lane's persisted runtime, as the surface renders it. `activeStatePath` is the
// running sprint's run-state file: the board reads that run's projection (vcs +
// tasks) to build the pull-request surface, so it must ride the view.
export type RoadmapLaneStateView = {
  lane: string
  activeItemRef?: string
  activeTeamSlug?: string
  activeStatePath?: string
  parked?: { reason: RoadmapParkReason; itemRef: string; at: string; detail?: string }
  pendingApprovalRef?: string
}

export type RoadmapStateView = {
  roadmapRef: string
  title?: string
  lanes: RoadmapLaneStateView[]
}

// ---------------------------------------------------------------------------
// Board model: one roadmap's lanes, each classified into the four states the
// board shows.
// ---------------------------------------------------------------------------

// How a single unit reads on the board. Derived from the lane frontier (the
// orchestrator's own "first non-merged unit") plus the persisted runtime overlay:
// - done: a unit before the frontier — its predecessor advanced, so it is delivered.
// - running: the unit whose sprint is currently executing (runtime `activeItemRef`),
//   or the frontier when it is actively being worked.
// - up_next: the frontier the lane will dispatch next (eligible, or gated on you).
// - queued: a later unit waiting its turn.
// - paused: the frontier of a parked lane — nothing advances until you resume.
// - unknown: the frontier names no known backlog item (an authoring contradiction).
export type RoadmapUnitState =
  | 'done'
  | 'running'
  | 'up_next'
  | 'queued'
  | 'paused'
  | 'unknown'

export type RoadmapBoardUnit = {
  ref: string
  slug: string
  kind: RoadmapEntryKind
  title: string
  state: RoadmapUnitState
  itemStatus?: BacklogItemStatusPayload
  // The epic entry this unit was snapshotted under, if any (for a grouping badge).
  epicRef?: string
  // The delivering pull request, when the item recorded one (done units link out).
  prUrl?: string
}

// Whether the lane is waiting on the human, and for what — the single signal the
// "Waiting on you" inbox reads. `approval` and `merge` are actionable from the
// board; `paused` needs a resume; `none` means the lane runs itself.
export type RoadmapLaneAttention = 'none' | 'approval' | 'merge' | 'paused'

export type RoadmapBoardLane = {
  lane: string
  units: RoadmapBoardUnit[]
  doneCount: number
  total: number
  reason: RoadmapLaneReason
  attention: RoadmapLaneAttention
  // The running/next refs, lifted for the board's summary chips.
  runningRef?: string
  upNextRef?: string
  activeStatePath?: string
  activeItemRef?: string
  parked?: { reason: RoadmapParkReason; itemRef: string; at: string; detail?: string }
  pendingApprovalRef?: string
}

// The per-item facts the board looks up by backlog ref: its human title, its
// backlog status, and the delivering PR url when one was recorded. A ref missing
// from the map is a dangling reference (surfaced as an "unknown" unit, never
// silently dropped — Fallback Discipline).
export type RoadmapBoardItemInfo = {
  title: string
  status: BacklogItemStatusPayload
  prUrl?: string
}

const TERMINAL_STATUSES: ReadonlySet<BacklogItemStatusPayload> = new Set<BacklogItemStatusPayload>([
  'completed',
  'archived',
])

// Build the board model for one roadmap. `itemInfo` resolves each ref to its live
// backlog facts; `laneRuntime` overlays the orchestrator's persisted per-lane
// state. The frontier and reason come from `nextEligible` over backlog status
// alone (no run links) — the same authoring-time frontier the editor shows — and
// the runtime overlay supplies the live "running / paused / waiting on you" truth.
export function buildRoadmapBoardModel(
  roadmap: Roadmap,
  itemInfo: (ref: string) => RoadmapBoardItemInfo | undefined,
  laneRuntimeByLane: ReadonlyMap<string, RoadmapLaneStateView>,
): RoadmapBoardLane[] {
  const itemStates: RoadmapItemState[] = []
  const seenRefs = new Set<string>()
  const collectRef = (ref: string): void => {
    if (seenRefs.has(ref)) return
    seenRefs.add(ref)
    const info = itemInfo(ref)
    if (info) itemStates.push({ ref, status: info.status })
  }
  for (const lane of roadmap.lanes) {
    for (const unit of flattenLaneUnits(lane)) collectRef(unit.ref)
  }

  const noRunLinks: ReadonlyMap<string, RoadmapRunState> = new Map()
  const eligibilityByLane = new Map<string, ReturnType<typeof nextEligible>[number]>()
  for (const eligibility of nextEligible(roadmap, itemStates, noRunLinks)) {
    eligibilityByLane.set(eligibility.lane, eligibility)
  }

  return roadmap.lanes.map((lane) => {
    const units = flattenLaneUnits(lane)
    const eligibility = eligibilityByLane.get(lane.title)
    const runtime = laneRuntimeByLane.get(lane.title)
    const frontierRef = eligibility?.frontierRef ?? null
    const frontierIndex = frontierRef ? units.findIndex((unit) => unit.ref === frontierRef) : -1
    // Units before the frontier are delivered; the frontier is the live edge.
    const doneCount = frontierIndex === -1 ? units.length : frontierIndex

    const parkedRef = runtime?.parked?.itemRef
    const runningRef = runtime?.activeItemRef
    const pendingRef = runtime?.pendingApprovalRef

    const boardUnits: RoadmapBoardUnit[] = units.map((unit, index) => {
      const info = itemInfo(unit.ref)
      const slug = roadmapRefSlug(unit.ref)
      const kind: RoadmapEntryKind = unit.epic ? 'item' : info ? 'item' : 'unknown'
      const state = classifyUnit({
        ref: unit.ref,
        index,
        frontierIndex,
        info,
        runningRef,
        parkedRef,
        laneParked: Boolean(runtime?.parked),
      })
      return {
        ref: unit.ref,
        slug,
        kind: info ? kind : 'unknown',
        title: info?.title ?? slug,
        state,
        ...(info ? { itemStatus: info.status } : {}),
        ...(unit.epic ? { epicRef: unit.epic } : {}),
        ...(info?.prUrl ? { prUrl: info.prUrl } : {}),
      }
    })

    const attention = laneAttention({
      reason: eligibility?.reason ?? 'empty',
      runtime,
      // A lane still holding an active item whose backlog status is terminal has
      // DELIVERED but not advanced — the orchestrator keeps the handle while a
      // worktree run waits on a human merge (manual policy). That is the board's
      // truthful "waiting to merge" signal (its own status-only eligibility, built
      // with no run links, reads a terminal item as merged and never reports
      // awaiting_merge).
      activeItemTerminal: runningRef ? isTerminalRoadmapStatus(itemInfo(runningRef)?.status) : false,
    })

    return {
      lane: lane.title,
      units: boardUnits,
      doneCount,
      total: units.length,
      reason: eligibility?.reason ?? 'empty',
      attention,
      ...(runningRef ? { runningRef } : {}),
      ...(eligibility?.eligibleRef || frontierRef
        ? { upNextRef: eligibility?.eligibleRef ?? frontierRef ?? undefined }
        : {}),
      ...(runtime?.activeStatePath ? { activeStatePath: runtime.activeStatePath } : {}),
      ...(runningRef ? { activeItemRef: runningRef } : {}),
      ...(runtime?.parked ? { parked: runtime.parked } : {}),
      ...(pendingRef ? { pendingApprovalRef: pendingRef } : {}),
    }
  })
}

function classifyUnit(input: {
  ref: string
  index: number
  frontierIndex: number
  info: RoadmapBoardItemInfo | undefined
  runningRef: string | undefined
  parkedRef: string | undefined
  laneParked: boolean
}): RoadmapUnitState {
  const { ref, index, frontierIndex, info, runningRef, parkedRef, laneParked } = input
  if (runningRef && ref === runningRef) return 'running'
  if (laneParked && parkedRef && ref === parkedRef) return 'paused'
  if (frontierIndex === -1) return 'done' // lane complete — every unit delivered.
  if (index < frontierIndex) return 'done'
  if (index === frontierIndex) {
    if (!info) return 'unknown'
    // The frontier being worked already reads as running above; otherwise it is
    // the next thing to start.
    if (info.status === 'in_progress' || info.status === 'needs_input') return 'running'
    return 'up_next'
  }
  return 'queued'
}

function laneAttention(input: {
  reason: RoadmapLaneReason
  runtime: RoadmapLaneStateView | undefined
  activeItemTerminal: boolean
}): RoadmapLaneAttention {
  if (input.runtime?.parked) return 'paused'
  if (input.runtime?.pendingApprovalRef) return 'approval'
  // A completed-but-unmerged worktree frontier is waiting on a human merge —
  // either the active item has delivered (terminal but still held) or the
  // status-derived eligibility says so.
  if (input.activeItemTerminal || input.reason === 'awaiting_merge') return 'merge'
  return 'none'
}

// True when a unit's backlog status is terminal (delivered/removed). Exposed for
// the board's done-item styling, kept in sync with the substrate's own set.
export function isTerminalRoadmapStatus(status: BacklogItemStatusPayload | undefined): boolean {
  return status !== undefined && TERMINAL_STATUSES.has(status)
}

// ---------------------------------------------------------------------------
// Merge order: which projects a repo's pull request must wait for.
// ---------------------------------------------------------------------------

// The board's pull-request surface disables a Merge button and shows "Merges after
// <project>" while any producer project is unmerged. This mirrors the engine's own
// authority (`_repos_that_must_merge_first` / `cross_repo_merge_edges` in
// sprintengine_core/tool/shell.py): a repo merges AFTER every repo it transitively
// depends on through a cross-repo task dependency; a repo that delivered nothing
// (no PR and no commit on its branch) blocks nobody. The engine's `pr-merge`
// primitive is still the final authority — it re-refuses at merge time and returns
// its own `blockedBy` — but deriving the same order here lets the surface PRE-disable
// rather than only reacting to a refused click. Documented mirror, not an import,
// because that logic is Python; a contract note keeps the pair aligned.
export type RepoMergeBlockers = {
  // Per repo id: the producer repo ids (unmerged) it must merge after, or [] when
  // it is free to merge. Absent keys mean "not blocked".
  blockedBy: Map<string, string[]>
}

// ---------------------------------------------------------------------------
// Skip: remove a lane entry from the roadmap file (the source-of-truth edit).
// ---------------------------------------------------------------------------

// Skipping an item removes it from the lane so the frontier moves on — a real edit
// to the roadmap markdown the orchestrator reconciles against on its next tick, NOT
// an imperative side-channel. It must not archive the backlog item: an archived ref
// vanishes from the backlog listing, so the lane's frontier would read it as
// dangling and PARK (eligibility_contradiction) instead of advancing. The reason is
// preserved as an inert HTML comment appended to the body — invisible to
// `parseRoadmap` (not a heading or list item) so it never becomes a spurious lane,
// and the entry line (plus its snapshotted children) is removed in place, leaving
// the rest of the file byte-stable. Skipping a single snapshotted epic child (an
// indented ref) removes just that one line, keeping its epic and sibling children.
// `date` is injected so the transform stays pure.
export function skipRoadmapEntry(content: string, ref: string, reason: string, date: string): string {
  const { head, body } = splitFrontmatter(content)
  const normalizedRef = ref.replace(/\\/g, '/').replace(/^\/+/, '').trim()
  const lines = body.split('\n')
  const out: string[] = []
  let removed = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!removed && isTopLevelEntryLine(line, normalizedRef)) {
      removed = true
      // Skip this entry line and any indented child lines beneath it.
      while (index + 1 < lines.length && /^\s+-\s+/.test(lines[index + 1])) index += 1
      continue
    }
    if (!removed && isChildEntryLine(line, normalizedRef)) {
      // A snapshotted epic child: drop just this indented line, leaving its epic
      // entry and sibling children intact so the frontier moves past it.
      removed = true
      continue
    }
    out.push(line)
  }
  if (!removed) return content // Nothing matched — leave the file untouched.

  // Trim a trailing blank run the removal may have left, then append the audit line.
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  const safeReason = reason.replace(/--+/g, '—').replace(/[\r\n]+/g, ' ').trim()
  out.push('', `<!-- skipped ${date}: ${normalizedRef}${safeReason ? ` — ${safeReason}` : ''} -->`, '')
  return head + out.join('\n')
}

function isTopLevelEntryLine(line: string, ref: string): boolean {
  const match = /^-\s+(\S+)/.exec(line)
  if (!match) return false
  return match[1].replace(/\\/g, '/').replace(/^\/+/, '') === ref
}

// An indented list item — a snapshotted epic child under a top-level entry.
function isChildEntryLine(line: string, ref: string): boolean {
  const match = /^\s+-\s+(\S+)/.exec(line)
  if (!match) return false
  return match[1].replace(/\\/g, '/').replace(/^\/+/, '') === ref
}

// Split a backlog markdown file into its frontmatter block (kept verbatim, trailing
// newline included) and the body. A file with no frontmatter has an empty head.
function splitFrontmatter(content: string): { head: string; body: string } {
  if (!content.startsWith('---')) return { head: '', body: content }
  const firstBreak = content.indexOf('\n')
  if (firstBreak === -1) return { head: '', body: content }
  const closing = content.indexOf('\n---', firstBreak)
  if (closing === -1) return { head: '', body: content }
  const afterClosing = content.indexOf('\n', closing + 1)
  if (afterClosing === -1) return { head: content, body: '' }
  return { head: content.slice(0, afterClosing + 1), body: content.slice(afterClosing + 1) }
}

// A repo's own merge state, as the surface reads it off `vcs.repos`.
type RepoMergeFacts = {
  id: string
  merged: boolean
  // Delivered something worth merging (has a PR or a commit on its branch).
  delivers: boolean
}

export function deriveRepoMergeBlockers(
  tasks: ReadonlyArray<Pick<SprintEngineTask, 'id' | 'repo' | 'dependsOn'>>,
  repos: ReadonlyArray<SprintEngineVcsRepo>,
): RepoMergeBlockers {
  const factsById = new Map<string, RepoMergeFacts>()
  for (const repo of repos) {
    factsById.set(repo.id, {
      id: repo.id,
      merged: repo.pullRequestState === 'merged',
      delivers: Boolean(repo.pullRequestUrl) || Boolean(repo.lastCommitSha),
    })
  }

  // Repo → repo edges: a task's repo consumes from its dependency's repo when they
  // differ (a cross-repo dependency). Producer must merge before consumer.
  const repoByTaskId = new Map<string, string>()
  for (const task of tasks) repoByTaskId.set(task.id, task.repo)
  const producersOf = new Map<string, Set<string>>() // consumer repo -> producer repos
  for (const task of tasks) {
    const consumerRepo = task.repo
    for (const depId of task.dependsOn) {
      const producerRepo = repoByTaskId.get(depId)
      if (!producerRepo || producerRepo === consumerRepo) continue
      const set = producersOf.get(consumerRepo) ?? new Set<string>()
      set.add(producerRepo)
      producersOf.set(consumerRepo, set)
    }
  }

  const blockedBy = new Map<string, string[]>()
  for (const repo of repos) {
    const facts = factsById.get(repo.id)
    if (!facts || facts.merged || !facts.delivers) continue
    const blockers = transitiveUnmergedProducers(repo.id, producersOf, factsById)
    if (blockers.length > 0) blockedBy.set(repo.id, blockers)
  }
  return { blockedBy }
}

// Every transitive producer of `repoId` that has delivered something and has not
// merged — the projects that must land first. Iterative BFS; a producer that
// delivered nothing is transparent (we recurse through it but never list it), so a
// no-op repo in the chain never blocks.
function transitiveUnmergedProducers(
  repoId: string,
  producersOf: ReadonlyMap<string, Set<string>>,
  factsById: ReadonlyMap<string, RepoMergeFacts>,
): string[] {
  const blockers: string[] = []
  const seen = new Set<string>([repoId])
  const queue = [...(producersOf.get(repoId) ?? [])]
  while (queue.length > 0) {
    const producer = queue.shift() as string
    if (seen.has(producer)) continue
    seen.add(producer)
    const facts = factsById.get(producer)
    if (facts?.delivers && !facts.merged && !blockers.includes(producer)) {
      blockers.push(producer)
    }
    for (const upstream of producersOf.get(producer) ?? []) {
      if (!seen.has(upstream)) queue.push(upstream)
    }
  }
  return blockers
}
