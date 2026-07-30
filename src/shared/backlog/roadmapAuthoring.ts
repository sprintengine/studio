// Pure, DOM-free and renderer-free authoring transforms for the roadmap (T6). The
// structural edits an author makes with drags — add/remove/move a step, split/merge
// a track, decide the save path — and the constructor that turns a picked reference
// into a lane entry live here so ONE transform engine serves both the human editor
// (src/renderer/src/components/backlog/roadmapAuthoring.ts, which re-exports these)
// and the agent-facing `horizon.*` automation tools (src/main).
//
// It consumes only the T3 substrate (src/shared/backlog/roadmap): the canonical body
// serializer (renderRoadmapBody), the frontmatter-only policy/projects writers, and
// the parse contract — plus the shared frontmatter helper. It imports NO renderer
// module, so it is tsconfig.web-safe AND node-safe, and runs under the esbuild→node
// test harness. The renderer's read-model adapters (BacklogItem → the shared
// contract, the library rail) stay in the renderer file because they depend on the
// renderer scan model; they call buildRoadmapEntry here, so the entry shape is
// defined once.

import { parseBacklogFrontmatter } from './frontmatter'
import {
  DEFAULT_ROADMAP_POLICY,
  ROADMAP_TYPE,
  renderRoadmapBody,
  setRoadmapPolicy,
  setRoadmapProjects,
  type ProjectKey,
  type Roadmap,
  type RoadmapEntry,
  type RoadmapLane,
  type RoadmapPolicy,
  type RoadmapProjectAlias,
} from './roadmap'

// The plain-human default name for the first track of a new roadmap. Track titles
// are the markdown `## ` headings the author edits; "Up next" reads as a person
// would say it (house rule: no "lane"/"eligibility" jargon in the UI).
export const DEFAULT_TRACK_TITLE = 'Up next'
const EPICS_DIR_PREFIX = 'backlog/epics/'

// A project-relative path normalized the way the roadmap file stores it: forward
// slashes, no leading slash, collapsed separators. Mirrors normalizeRelativePath
// (src/renderer/src/utils/backlog.ts) and the substrate's private normalizeRef, kept
// local so this module never reaches into renderer code.
export function normalizeRoadmapPath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')
}

// The editable roadmap the panel holds while the author works. It is exactly the
// structural subset of a parsed Roadmap the editor can change — title, execution
// policy, the `projects:` alias map, and the ordered tracks — separated from the
// parse-only fields (issues, preserved body) so a draft round-trips through
// renderRoadmapBody (body) + setRoadmapProjects (frontmatter) cleanly. `projects`
// is the D2 alias→root map: dragging in the first item from a non-home project
// registers its alias here so a cross-project ref resolves on save.
export type RoadmapDraft = {
  title: string | undefined
  policy: RoadmapPolicy
  projects: RoadmapProjectAlias[]
  lanes: RoadmapLane[]
}

// A draft seeded from a freshly parsed roadmap. Lanes/entries and the projects map
// are deep-copied so the editor's immutable transforms never mutate the parsed
// model behind it.
export function draftFromRoadmap(roadmap: Roadmap): RoadmapDraft {
  return {
    title: roadmap.title,
    policy: { ...roadmap.policy },
    projects: roadmap.projects.map((project) => ({ ...project })),
    lanes: cloneLanes(roadmap.lanes),
  }
}

function cloneLanes(lanes: ReadonlyArray<RoadmapLane>): RoadmapLane[] {
  return lanes.map((lane) => ({
    title: lane.title,
    entries: lane.entries.map((entry) => ({ ...entry })),
  }))
}

// ---------------------------------------------------------------------------
// Cross-project refs
// ---------------------------------------------------------------------------

// The authored reference the roadmap file stores for a (project, path) pair: the
// project-relative path for the home project, or `alias:relative/path` for an
// aliased project. This is `entry.ref` — the byte-stable render key — and is
// distinct from `qualifiedRef` (which always carries a `:` prefix): a home ref is
// unqualified so every existing single-project roadmap stays valid (D2).
export function authoredRef(projectKey: ProjectKey, relativePath: string): string {
  const normalized = normalizeRoadmapPath(relativePath)
  return projectKey ? `${projectKey}:${normalized}` : normalized
}

// The inverse of authoredRef: split an authored ref back into its project key
// (home = null for an unqualified ref) and its project-relative path. A backlog
// path never contains a colon, so a leading `alias:` before the first slash is
// unambiguous; a colon inside the path (none in practice) reads as home.
export function splitAuthoredRef(ref: string): { projectKey: ProjectKey; relativePath: string } {
  const normalized = ref.replace(/\\/g, '/').replace(/^\/+/, '').trim()
  const colon = normalized.indexOf(':')
  const slash = normalized.indexOf('/')
  if (colon > 0 && (slash === -1 || colon < slash)) {
    return { projectKey: normalized.slice(0, colon), relativePath: normalizeRoadmapPath(normalized.slice(colon + 1)) }
  }
  return { projectKey: null, relativePath: normalizeRoadmapPath(normalized) }
}

// A stable, filesystem-free alias slug for a project name, unique against the
// aliases already taken. Aliases are the short `projects:` keys an author never
// sees literally (the UI shows project names); kept lowercase-kebab so a
// hand-edited file reads cleanly. The home project has no alias.
export function roadmapProjectAlias(projectName: string, taken: ReadonlySet<string>): string {
  const base =
    projectName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'project'
  if (!taken.has(base)) return base
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

// ---------------------------------------------------------------------------
// Entry construction
// ---------------------------------------------------------------------------

export function isEpicRef(ref: string): boolean {
  return normalizeRoadmapPath(ref).startsWith(EPICS_DIR_PREFIX)
}

// Build a lane entry for a ref resolved to a specific project. An epic entry is a
// BARE reference (MC-2031) — its members resolve live from `epic:` membership on
// every read, so nothing is captured here. The stored `entry.ref` is the AUTHORED
// ref, so a home entry stays unqualified and an aliased entry keeps its `alias:`
// prefix, round-tripping through renderRoadmapBody unchanged. `roster` is the
// optional per-step staffing override (MC-1881); omitted or blank means the step
// inherits the roadmap's policy roster.
export function buildRoadmapEntry(
  projectKey: ProjectKey,
  relativePath: string,
  roster?: string,
): RoadmapEntry {
  const normalized = normalizeRoadmapPath(relativePath)
  return {
    kind: isEpicRef(normalized) ? 'epic' : 'item',
    ref: authoredRef(projectKey, normalized),
    projectKey,
    relativePath: normalized,
    ...(roster?.trim() ? { roster: roster.trim() } : {}),
  }
}

// Set (or clear) one step's roster override. A blank/undefined roster REMOVES the
// key rather than storing an empty string, so clearing an override renders the
// entry line byte-identically to a step that never had one. Pure and immutable
// like every transform here, so the human editor (MC-1882) and the agent-facing
// horizon tools (MC-1901) share one engine and cannot drift on what a "cleared"
// override serializes to.
export function setEntryRoster(
  lanes: RoadmapLane[],
  laneIndex: number,
  entryIndex: number,
  roster: string | undefined,
): RoadmapLane[] {
  const trimmed = roster?.trim()
  return lanes.map((lane, index) => {
    if (index !== laneIndex) return lane
    return {
      ...lane,
      entries: lane.entries.map((entry, i) => {
        if (i !== entryIndex) return entry
        const { roster: _dropped, ...rest } = entry
        return trimmed ? { ...rest, roster: trimmed } : rest
      }),
    }
  })
}

// Whether a ref already appears anywhere in the draft (as an entry ref). Used to
// keep a picker/tool from adding the same item to a track twice.
export function draftContainsRef(lanes: ReadonlyArray<RoadmapLane>, ref: string): boolean {
  const normalized = normalizeRoadmapPath(ref)
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

// Insert a step at a specific position within a track (a drag drop between rows).
// The index is clamped, so a drop past the end appends and a negative index heads.
export function insertEntry(lanes: RoadmapLane[], laneIndex: number, index: number, entry: RoadmapEntry): RoadmapLane[] {
  return lanes.map((lane, i) => {
    if (i !== laneIndex) return lane
    const at = Math.max(0, Math.min(index, lane.entries.length))
    return { ...lane, entries: [...lane.entries.slice(0, at), entry, ...lane.entries.slice(at)] }
  })
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

// A track TITLE is an identity, not a label: the board joins runtime to plan by
// it, eligibility is keyed by it, and the orchestrator stores one runtime per
// title. Two tracks sharing a name collapse all three onto one.  and
//  always went through ; renaming did not, so it was
// the one way to mint a duplicate.
export function renameLane(lanes: RoadmapLane[], laneIndex: number, title: string): RoadmapLane[] {
  const others = lanes.filter((_, index) => index !== laneIndex)
  const unique = uniqueLaneTitle(others, title)
  return lanes.map((lane, index) => (index === laneIndex ? { ...lane, title: unique } : lane))
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

// True when the draft's structure (title, tracks, steps) differs from
// the baseline — i.e. anything renderRoadmapBody would emit differently. Policy is
// a separate axis (policyChanged), because a policy-only edit takes the
// frontmatter-only write path that preserves the body byte-for-byte.
export function structureChanged(baseline: RoadmapDraft, draft: RoadmapDraft): boolean {
  return renderRoadmapBody(baseline) !== renderRoadmapBody(draft)
}

export function policyChanged(baseline: RoadmapDraft, draft: RoadmapDraft): boolean {
  return policyDiff(baseline.policy, draft.policy) !== null
}

// True when the draft's `projects:` alias map differs from the baseline — a new
// project contributed its first step (aliases are only ever added while planning,
// never reordered), so a serialized compare is exact and order-insensitive churn
// cannot register a false positive.
export function projectsChanged(baseline: RoadmapDraft, draft: RoadmapDraft): boolean {
  return serializeProjects(baseline.projects) !== serializeProjects(draft.projects)
}

function serializeProjects(projects: ReadonlyArray<RoadmapProjectAlias>): string {
  return projects
    .map((project) => `${project.alias} ${project.path}`)
    .sort()
    .join('\n')
}

export function isDraftDirty(baseline: RoadmapDraft, draft: RoadmapDraft): boolean {
  return structureChanged(baseline, draft) || policyChanged(baseline, draft) || projectsChanged(baseline, draft)
}

// The subset of policy fields the draft changed, or null when identical. Only
// changed fields are written, so setRoadmapPolicy touches the minimum frontmatter.
function policyDiff(baseline: RoadmapPolicy, next: RoadmapPolicy): Partial<RoadmapPolicy> | null {
  const diff: Partial<RoadmapPolicy> = {}
  if (baseline.advance !== next.advance) diff.advance = next.advance
  if (baseline.merge !== next.merge) diff.merge = next.merge
  if (baseline.concurrency !== next.concurrency) diff.concurrency = next.concurrency
  // A cleared roster must ride the diff as an explicitly-present undefined key —
  // setRoadmapPolicy keys the frontmatter REMOVAL off `'roster' in updates`.
  if (baseline.roster !== next.roster) diff.roster = next.roster
  // Same key-presence rule as roster: a cleared permission preset must ride the
  // diff as a present-but-undefined key so setRoadmapPolicy REMOVES the scalar.
  if (baseline.permissions !== next.permissions) diff.permissions = next.permissions
  return Object.keys(diff).length > 0 ? diff : null
}

// Compose the file content to write for a save, given the ORIGINAL on-disk content
// and the current baseline/draft. Frontmatter edits (policy scalars, the projects
// map) are applied first, each preserving the body byte-for-byte; the body is
// re-emitted only when the structure changed.
//   - Policy edit: setRoadmapPolicy rewrites just the changed frontmatter scalars
//     (the frontmatter-discipline guarantee inherited from backlog-service).
//   - Projects edit: setRoadmapProjects rewrites the `projects:` block, preserving
//     every other frontmatter key — so a cross-project drag records the new alias
//     without perturbing the body or policy.
//   - Structural edit: renderRoadmapBody re-emits the canonical body, spliced onto
//     the (frontmatter-updated) block.
// Returns the original content unchanged when nothing is dirty.
export function composeRoadmapSaveContent(
  originalContent: string,
  baseline: RoadmapDraft,
  draft: RoadmapDraft,
): string {
  const diff = policyDiff(baseline.policy, draft.policy)
  let content = diff ? setRoadmapPolicy(originalContent, diff) : originalContent
  if (projectsChanged(baseline, draft)) content = setRoadmapProjects(content, draft.projects)
  if (!structureChanged(baseline, draft)) return content
  return replaceBody(content, renderRoadmapBody(draft))
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
