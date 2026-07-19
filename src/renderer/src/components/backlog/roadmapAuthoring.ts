// Pure, DOM-free authoring logic for the roadmap editor (T4). The editor panel
// (RoadmapEditorPanel.tsx) owns rendering and IPC; every structural transform —
// add/remove/move a step, split/merge a track, snapshot an epic, decide the save
// path — lives here so it is unit-testable without a DOM.
//
// This module consumes the T3 substrate (src/shared/backlog/roadmap.ts): the
// canonical body serializer (renderRoadmapBody), the frontmatter-only policy
// writer (setRoadmapPolicy), and the parse/validate/eligibility contract. It adds
// no orchestration behavior. It imports only node-safe modules (the shared roadmap
// module, the shared frontmatter helper, and the pure backlog read model), so it
// runs under the esbuild→node test harness like backlogEpics.test.ts.

import {
  parseBacklogFrontmatter,
} from '../../../../shared/backlog/frontmatter'
import {
  DEFAULT_ROADMAP_POLICY,
  ROADMAP_TYPE,
  renderRoadmapBody,
  roadmapEpicDrift,
  roadmapRefSlug,
  setRoadmapPolicy,
  type Roadmap,
  type RoadmapEntry,
  type RoadmapLane,
  type RoadmapPolicy,
} from '../../../../shared/backlog/roadmap'
import type { BacklogItemSearchOption } from './BacklogItemSearchPicker'
import { childrenOfEpic } from '../../utils/backlogEpics'
import { normalizeRelativePath, type BacklogItem } from '../../utils/backlog'

// The plain-human default name for the first track of a new roadmap. Track titles
// are the markdown `## ` headings the author edits; "Up next" reads as a person
// would say it (house rule: no "lane"/"eligibility" jargon in the UI).
export const DEFAULT_TRACK_TITLE = 'Up next'
const EPICS_DIR_PREFIX = 'backlog/epics/'

// The editable roadmap the panel holds while the author works. It is exactly the
// structural subset of a parsed Roadmap the editor can change — title, execution
// policy, and the ordered tracks — separated from the parse-only fields (issues,
// preserved body) so a draft round-trips through renderRoadmapBody cleanly.
export type RoadmapDraft = {
  title: string | undefined
  policy: RoadmapPolicy
  lanes: RoadmapLane[]
}

// A draft seeded from a freshly parsed roadmap. Lanes/entries are deep-copied so
// the editor's immutable transforms never mutate the parsed model behind it.
export function draftFromRoadmap(roadmap: Roadmap): RoadmapDraft {
  return {
    title: roadmap.title,
    policy: { ...roadmap.policy },
    lanes: cloneLanes(roadmap.lanes),
  }
}

function cloneLanes(lanes: ReadonlyArray<RoadmapLane>): RoadmapLane[] {
  return lanes.map((lane) => ({
    title: lane.title,
    entries: lane.entries.map((entry) => ({ ...entry, children: [...entry.children] })),
  }))
}

// ---------------------------------------------------------------------------
// Read-model adapters (BacklogItem -> the shared contract's structural subset)
// ---------------------------------------------------------------------------

// The minimal per-item state validateRoadmap/nextEligible read, adapted from the
// renderer scan model. `ref` is the project-relative backlog path (the entry ref
// axis); `dependsOn` is the prerequisite-slug list already parsed by the scan.
export function roadmapItemStates(
  items: ReadonlyArray<BacklogItem>,
): Array<{ ref: string; status: BacklogItem['status']; dependsOn?: string[] }> {
  return items.map((item) => ({
    ref: normalizeRelativePath(item.relativePath),
    status: item.status,
    dependsOn: item.dependsOn,
  }))
}

// Display identity for an entry/child ref: the referenced item's title + human id
// when the ref resolves, so a row can read "MC-240 · Title" instead of a raw path.
export type RoadmapRefDisplay = { title: string; displayId?: string; status?: BacklogItem['status'] }

export function refDisplayMap(items: ReadonlyArray<BacklogItem>): Map<string, RoadmapRefDisplay> {
  const map = new Map<string, RoadmapRefDisplay>()
  for (const item of items) {
    map.set(normalizeRelativePath(item.relativePath), {
      title: item.title,
      displayId: item.displayId,
      status: item.status,
    })
  }
  return map
}

// Candidate options for the reused BacklogItemSearchPicker: every leaf item and
// epic the author can drop into a track. Roadmaps themselves, and archived items,
// are excluded — a roadmap never references another roadmap, and an archived item
// is not runnable work. `value` is the ref (the stored path); searchText widens
// matching to the slug so a typed slug finds the row.
export function entryPickerOptions(
  items: ReadonlyArray<BacklogItem>,
): BacklogItemSearchOption[] {
  const options: BacklogItemSearchOption[] = []
  for (const item of items) {
    if (item.status === 'archived') continue
    if (item.rawType === ROADMAP_TYPE) continue
    const ref = normalizeRelativePath(item.relativePath)
    options.push({
      id: ref,
      value: ref,
      title: item.title,
      displayId: item.displayId,
      searchText: roadmapRefSlug(ref),
    })
  }
  return options
}

// ---------------------------------------------------------------------------
// Entry construction + epic snapshotting
// ---------------------------------------------------------------------------

export function isEpicRef(ref: string): boolean {
  return normalizeRelativePath(ref).startsWith(EPICS_DIR_PREFIX)
}

// The child references an epic contributes, in a deterministic snapshot order.
// V1 plans are static: the children are captured EXPLICITLY at add time so the
// "gained N items" drift check is a set difference against this stored list (a
// bare epic ref could not reconstruct it). Membership is derived down from the
// live scan (childrenOfEpic); order is the scan's path-sorted order, which is
// stable across sessions. Runtime sequencing still honors dependsOn regardless of
// this order (nextEligible), so the snapshot is a starting sequence, not a
// constraint.
export function snapshotEpicChildren(
  items: ReadonlyArray<BacklogItem>,
  epicRef: string,
): string[] {
  const slug = roadmapRefSlug(epicRef)
  return childrenOfEpic([...items], slug).map((child) => normalizeRelativePath(child.relativePath))
}

// Build a lane entry for a picked ref. An epic ref snapshots its children now; an
// item ref carries none. A ref that resolves to no known item is still added as
// an entry (kind decided by path) — validateRoadmap surfaces it as dangling, so a
// stale pick is visible, never silently dropped (Fallback Discipline).
export function makeEntry(items: ReadonlyArray<BacklogItem>, ref: string): RoadmapEntry {
  const normalized = normalizeRelativePath(ref)
  // The authoring UI works within the home project today (MC-1688 cross-project
  // planning is T3), so a picked ref resolves to the home project: projectKey null,
  // relativePath = the ref itself.
  if (isEpicRef(normalized)) {
    return { kind: 'epic', ref: normalized, projectKey: null, relativePath: normalized, children: snapshotEpicChildren(items, normalized) }
  }
  return { kind: 'item', ref: normalized, projectKey: null, relativePath: normalized, children: [] }
}

// The gained/removed drift between an epic entry's stored snapshot and the epic's
// live membership, for the "this epic gained N items" affordance. Returns null for
// non-epic entries (nothing to reconcile).
export function epicEntryDrift(
  items: ReadonlyArray<BacklogItem>,
  entry: RoadmapEntry,
): { gained: string[]; removed: string[] } | null {
  if (entry.kind !== 'epic') return null
  const live = snapshotEpicChildren(items, entry.ref)
  const { gained, removed } = roadmapEpicDrift(entry, live)
  if (gained.length === 0 && removed.length === 0) return null
  return { gained, removed }
}

// Whether a ref already appears anywhere in the draft (as an entry ref). Used to
// keep the picker from adding the same item to a track twice.
export function draftContainsRef(lanes: ReadonlyArray<RoadmapLane>, ref: string): boolean {
  const normalized = normalizeRelativePath(ref)
  return lanes.some((lane) => lane.entries.some((entry) => entry.ref === normalized))
}

// ---------------------------------------------------------------------------
// Immutable track/step transforms (each returns a new lanes array)
// ---------------------------------------------------------------------------

export function addEntry(lanes: RoadmapLane[], laneIndex: number, entry: RoadmapEntry): RoadmapLane[] {
  return lanes.map((lane, index) =>
    index === laneIndex ? { ...lane, entries: [...lane.entries, entry] } : lane,
  )
}

export function removeEntry(lanes: RoadmapLane[], laneIndex: number, entryIndex: number): RoadmapLane[] {
  return lanes.map((lane, index) =>
    index === laneIndex
      ? { ...lane, entries: lane.entries.filter((_, i) => i !== entryIndex) }
      : lane,
  )
}

// Move a step to a new position, within its track or across tracks. `toIndex` is
// the insert index in the destination track BEFORE removal, interpreted against
// the post-removal list when the move stays in the same track — the standard
// splice-reorder adjustment — so dropping a step just after its old slot is a
// no-op rather than an off-by-one.
export function moveEntry(
  lanes: RoadmapLane[],
  from: { lane: number; index: number },
  to: { lane: number; index: number },
): RoadmapLane[] {
  const source = lanes[from.lane]
  if (!source) return lanes
  const moved = source.entries[from.index]
  if (!moved) return lanes

  const next = lanes.map((lane) => ({ ...lane, entries: [...lane.entries] }))
  next[from.lane].entries.splice(from.index, 1)
  let insertAt = to.index
  if (from.lane === to.lane && from.index < to.index) insertAt -= 1
  insertAt = Math.max(0, Math.min(insertAt, next[to.lane].entries.length))
  next[to.lane].entries.splice(insertAt, 0, moved)
  return next
}

export function addLane(lanes: RoadmapLane[], title = DEFAULT_TRACK_TITLE): RoadmapLane[] {
  return [...lanes, { title: uniqueLaneTitle(lanes, title), entries: [] }]
}

export function renameLane(lanes: RoadmapLane[], laneIndex: number, title: string): RoadmapLane[] {
  return lanes.map((lane, index) => (index === laneIndex ? { ...lane, title } : lane))
}

export function removeLane(lanes: RoadmapLane[], laneIndex: number): RoadmapLane[] {
  return lanes.filter((_, index) => index !== laneIndex)
}

// Split a track at a step boundary: steps from `entryIndex` onward move to a new
// track inserted directly after. A split at 0 or past the end is a no-op (nothing
// to peel off). The new track borrows the source title with a "cont." suffix so
// the author can see which half is which and rename it.
export function splitLane(lanes: RoadmapLane[], laneIndex: number, entryIndex: number): RoadmapLane[] {
  const lane = lanes[laneIndex]
  if (!lane) return lanes
  if (entryIndex <= 0 || entryIndex >= lane.entries.length) return lanes
  const head: RoadmapLane = { title: lane.title, entries: lane.entries.slice(0, entryIndex) }
  const tail: RoadmapLane = {
    title: uniqueLaneTitle(lanes, `${lane.title} (cont.)`),
    entries: lane.entries.slice(entryIndex),
  }
  const next = [...lanes]
  next.splice(laneIndex, 1, head, tail)
  return next
}

// Merge a track into the one directly below it, appending this track's steps to
// the next track's and keeping the next track's title. A no-op on the last track.
export function mergeLaneDown(lanes: RoadmapLane[], laneIndex: number): RoadmapLane[] {
  if (laneIndex < 0 || laneIndex >= lanes.length - 1) return lanes
  const upper = lanes[laneIndex]
  const lower = lanes[laneIndex + 1]
  const merged: RoadmapLane = { title: lower.title, entries: [...upper.entries, ...lower.entries] }
  const next = [...lanes]
  next.splice(laneIndex, 2, merged)
  return next
}

// Re-sync an epic entry's snapshot to the epic's live membership (the one-click
// action behind the "gained N items" affordance). Replaces the stored children
// with the current snapshot in canonical order.
export function resyncEpicEntry(
  items: ReadonlyArray<BacklogItem>,
  lanes: RoadmapLane[],
  laneIndex: number,
  entryIndex: number,
): RoadmapLane[] {
  return lanes.map((lane, li) => {
    if (li !== laneIndex) return lane
    return {
      ...lane,
      entries: lane.entries.map((entry, ei) => {
        if (ei !== entryIndex || entry.kind !== 'epic') return entry
        return { ...entry, children: snapshotEpicChildren(items, entry.ref) }
      }),
    }
  })
}

function uniqueLaneTitle(lanes: ReadonlyArray<RoadmapLane>, base: string): string {
  const taken = new Set(lanes.map((lane) => lane.title))
  if (!taken.has(base)) return base
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`
    if (!taken.has(candidate)) return candidate
  }
}

// ---------------------------------------------------------------------------
// Dirty tracking + save composition
// ---------------------------------------------------------------------------

// True when the draft's structure (title, tracks, steps, snapshots) differs from
// the baseline — i.e. anything renderRoadmapBody would emit differently. Policy is
// a separate axis (policyChanged), because a policy-only edit takes the
// frontmatter-only write path that preserves the body byte-for-byte.
export function structureChanged(baseline: RoadmapDraft, draft: RoadmapDraft): boolean {
  return renderRoadmapBody(baseline) !== renderRoadmapBody(draft)
}

export function policyChanged(baseline: RoadmapDraft, draft: RoadmapDraft): boolean {
  return policyDiff(baseline.policy, draft.policy) !== null
}

export function isDraftDirty(baseline: RoadmapDraft, draft: RoadmapDraft): boolean {
  return structureChanged(baseline, draft) || policyChanged(baseline, draft)
}

// The subset of policy fields the draft changed, or null when identical. Only
// changed fields are written, so setRoadmapPolicy touches the minimum frontmatter.
function policyDiff(baseline: RoadmapPolicy, next: RoadmapPolicy): Partial<RoadmapPolicy> | null {
  const diff: Partial<RoadmapPolicy> = {}
  if (baseline.advance !== next.advance) diff.advance = next.advance
  if (baseline.merge !== next.merge) diff.merge = next.merge
  if (baseline.concurrency !== next.concurrency) diff.concurrency = next.concurrency
  return Object.keys(diff).length > 0 ? diff : null
}

// Compose the file content to write for a save, given the ORIGINAL on-disk content
// and the current baseline/draft.
//   - Policy-only edit: setRoadmapPolicy rewrites just the changed frontmatter
//     scalars and preserves the body byte-for-byte (the frontmatter-discipline
//     guarantee inherited from backlog-service).
//   - Structural edit: the body is re-emitted in canonical form by
//     renderRoadmapBody, spliced onto the (policy-updated) frontmatter block. The
//     frontmatter block itself is preserved exactly.
// Returns the original content unchanged when nothing is dirty.
export function composeRoadmapSaveContent(
  originalContent: string,
  baseline: RoadmapDraft,
  draft: RoadmapDraft,
): string {
  const diff = policyDiff(baseline.policy, draft.policy)
  const withPolicy = diff ? setRoadmapPolicy(originalContent, diff) : originalContent
  if (!structureChanged(baseline, draft)) return withPolicy
  return replaceBody(withPolicy, renderRoadmapBody(draft))
}

// Swap a file's markdown body while preserving its frontmatter block byte-for-byte.
// parseBacklogFrontmatter returns the body as the suffix after the frontmatter
// block, so the block is exactly the prefix before it. The blank line that
// customarily separates frontmatter from body lives at the head of `body`, so its
// leading blank-line run is carried over — a structural save keeps the same
// separator the file was authored with (renderRoadmapBody emits none of its own).
function replaceBody(content: string, newBody: string): string {
  const { body } = parseBacklogFrontmatter(content)
  const frontmatterBlock = content.slice(0, content.length - body.length)
  const leadingBlankLines = /^(?:[ \t]*\r?\n)+/.exec(body)?.[0] ?? ''
  return frontmatterBlock + leadingBlankLines + newBody
}

// The full file content for a brand-new roadmap: a minimal frontmatter block
// (type + a calm default status + the V1 default policy) over a canonical body
// with one empty track. The scan's id-allocation pass mints the `id:` on first
// discovery, so it is intentionally omitted here.
export function newRoadmapFileContent(title: string, policy: RoadmapPolicy = DEFAULT_ROADMAP_POLICY): string {
  const frontmatter = [
    '---',
    `type: ${ROADMAP_TYPE}`,
    'status: idea',
    `advance: ${policy.advance}`,
    `merge: ${policy.merge}`,
    `concurrency: ${policy.concurrency}`,
    '---',
    '',
  ].join('\n')
  const body = renderRoadmapBody({ title, lanes: [{ title: DEFAULT_TRACK_TITLE, entries: [] }] })
  return frontmatter + body
}
