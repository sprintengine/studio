// The roadmap editor's read-model adapters: the renderer-scan-coupled half of the
// authoring engine. The pure, renderer-free structural transforms (add/remove/move a
// step, split/merge a track, decide the save path, construct an entry) were promoted
// to src/shared/backlog/roadmapAuthoring.ts (T6) so the human editor and the agent-
// facing `roadmap.*` automation tools share ONE transform engine; they are re-exported
// below so every consumer of this path keeps importing them unchanged.
//
// What stays here needs the renderer read model (BacklogItem, childrenOfEpic,
// normalizeRelativePath, BacklogItemSearchOption): the BacklogItem → shared-contract
// adapters, the cross-project library rail, epic-child snapshotting, and the two entry
// constructors that snapshot from a live scan. These cannot live in shared, which must
// not import renderer modules.

import {
  ROADMAP_TYPE,
  roadmapEpicDrift,
  roadmapRefSlug,
  type ProjectKey,
  type RoadmapEntry,
  type RoadmapLane,
} from '../../../../shared/backlog/roadmap'
import {
  addEntry,
  authoredRef,
  buildRoadmapEntry,
  draftContainsRef,
  insertEntry,
  isEpicRef,
  type RoadmapDraft,
} from '../../../../shared/backlog/roadmapAuthoring'
import type { BacklogItemSearchOption } from './BacklogItemSearchPicker'
import { childrenOfEpic } from '../../utils/backlogEpics'
import { normalizeRelativePath, type BacklogItem } from '../../utils/backlog'

// The pure transform engine, re-exported so the editor panel / planning view / tests
// keep importing add/remove/move/save from this path with no signature change.
export {
  DEFAULT_TRACK_TITLE,
  addEntry,
  addLane,
  authoredRef,
  buildRoadmapEntry,
  composeRoadmapSaveContent,
  draftContainsRef,
  draftFromRoadmap,
  insertEntry,
  isDraftDirty,
  isEpicRef,
  mergeLaneDown,
  moveEntry,
  newRoadmapFileContent,
  policyChanged,
  projectsChanged,
  removeEntry,
  removeLane,
  renameLane,
  roadmapProjectAlias,
  splitAuthoredRef,
  splitLane,
  structureChanged,
} from '../../../../shared/backlog/roadmapAuthoring'
export type { RoadmapDraft } from '../../../../shared/backlog/roadmapAuthoring'

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
// Cross-project planning (MC-1690): one plan, every project's backlog
// ---------------------------------------------------------------------------

// One project's backlog, tagged with the identity the roadmap file uses for it:
// `projectKey` is the D2 alias, or `null` for the HOME project (unqualified refs).
// `path` is the absolute project root recorded in the `projects:` frontmatter map
// when a cross-project entry is first added (home is never stored — its refs are
// unqualified). `items` is that project's live backlog scan.
export type RoadmapProjectItems = {
  projectKey: ProjectKey
  projectName: string
  path: string
  items: ReadonlyArray<BacklogItem>
}

// Display identity keyed by AUTHORED ref across every project the plan spans, so a
// step row resolves its title/id/status even when two projects hold a same-named
// file (their authored refs differ by the `alias:` prefix). The single-project
// refDisplayMap is the degenerate case (one home project).
export function refDisplayMapMulti(projects: ReadonlyArray<RoadmapProjectItems>): Map<string, RoadmapRefDisplay> {
  const map = new Map<string, RoadmapRefDisplay>()
  for (const project of projects) {
    for (const item of project.items) {
      map.set(authoredRef(project.projectKey, item.relativePath), {
        title: item.title,
        displayId: item.displayId,
        status: item.status,
      })
    }
  }
  return map
}

// The per-item state validate/eligibility read, tagged with each item's project so
// cross-project units never merge (the shared contract keys on `projectKey`). `ref`
// is the project-relative path; slugs and dependsOn resolve within the same project.
export function roadmapItemStatesMulti(
  projects: ReadonlyArray<RoadmapProjectItems>,
): Array<{ ref: string; status: BacklogItem['status']; dependsOn?: string[]; projectKey: ProjectKey }> {
  const states: Array<{ ref: string; status: BacklogItem['status']; dependsOn?: string[]; projectKey: ProjectKey }> = []
  for (const project of projects) {
    for (const item of project.items) {
      states.push({
        ref: normalizeRelativePath(item.relativePath),
        status: item.status,
        dependsOn: item.dependsOn,
        projectKey: project.projectKey,
      })
    }
  }
  return states
}

// Picker candidates across every project: the reused keyboard-first alternate to
// dragging. `value` is the authored ref (project-qualified for non-home), so adding
// via the picker and dragging from the library produce the identical entry.
// searchText widens matching to the project name + slug.
export function entryPickerOptionsMulti(
  projects: ReadonlyArray<RoadmapProjectItems>,
): BacklogItemSearchOption[] {
  const options: BacklogItemSearchOption[] = []
  for (const project of projects) {
    for (const item of project.items) {
      if (item.status === 'archived') continue
      if (item.rawType === ROADMAP_TYPE) continue
      const ref = authoredRef(project.projectKey, item.relativePath)
      options.push({
        id: ref,
        value: ref,
        title: item.title,
        displayId: item.displayId,
        searchText: `${project.projectName} ${roadmapRefSlug(item.relativePath)}`,
      })
    }
  }
  return options
}

// ---------------------------------------------------------------------------
// The cross-project library feed (the planning rail's source of truth)
// ---------------------------------------------------------------------------

// A snapshotted child preview shown under an expanded epic in the library rail.
export type RoadmapLibraryChild = { ref: string; title: string; displayId?: string }

// One draggable row in the library rail: a loose backlog item, or an epic that
// drops in as a single step carrying its snapshotted children. `ref` is the
// authored ref (what lands in the plan); `planned` dims (never hides) a row already
// in the draft, so the author sees what is placed without losing it from the list.
export type RoadmapLibraryEntry = {
  kind: 'item' | 'epic'
  ref: string
  projectKey: ProjectKey
  relativePath: string
  title: string
  displayId?: string
  children: RoadmapLibraryChild[]
  planned: boolean
}

// A project's section in the library rail: its name and its draggable rows.
export type RoadmapLibraryGroup = {
  projectKey: ProjectKey
  projectName: string
  entries: RoadmapLibraryEntry[]
}

// The authored refs already placed in the draft: every entry ref, plus each
// snapshotted epic child (resolved to its authored ref, inheriting the epic's
// project). A library item is "planned" when its ref is in this set; an epic is
// planned when its own entry ref is (its children dim individually via this set).
function plannedRefSet(lanes: ReadonlyArray<RoadmapLane>): Set<string> {
  const placed = new Set<string>()
  for (const lane of lanes) {
    for (const entry of lane.entries) {
      placed.add(entry.ref)
      if (entry.kind === 'epic') {
        for (const child of entry.children) {
          // A child carries its own `alias:` only if authored that way; otherwise
          // it inherits the epic entry's project.
          placed.add(child.includes(':') ? normalizeRelativePath(child) : authoredRef(entry.projectKey, child))
        }
      }
    }
  }
  return placed
}

function matchesQuery(query: string, ...fields: Array<string | undefined>): boolean {
  if (query === '') return true
  const needle = query.toLowerCase()
  return fields.some((field) => field !== undefined && field.toLowerCase().includes(needle))
}

// Build the grouped library feed from every project's live scan. Epics list first
// (each expandable to its snapshotted children), then the loose items that are not
// members of any epic — a member is dragged in via its epic, never twice. Roadmaps
// and archived items are excluded (a roadmap never references another; an archived
// item is not runnable work). A non-empty `query` filters rows by title, id, or
// slug (an epic is kept if it or any child matches); empty groups are dropped so
// the rail shows only projects with matching work.
export function buildRoadmapLibrary(
  projects: ReadonlyArray<RoadmapProjectItems>,
  lanes: ReadonlyArray<RoadmapLane>,
  query = '',
): RoadmapLibraryGroup[] {
  const placed = plannedRefSet(lanes)
  const trimmedQuery = query.trim()
  const groups: RoadmapLibraryGroup[] = []

  for (const project of projects) {
    const usable = project.items.filter((item) => item.status !== 'archived' && item.rawType !== ROADMAP_TYPE)
    const entries: RoadmapLibraryEntry[] = []

    for (const epic of usable) {
      if (!epic.isEpic) continue
      const slug = roadmapRefSlug(epic.relativePath)
      const children = childrenOfEpic([...project.items], slug)
        .filter((child) => child.status !== 'archived')
        .map<RoadmapLibraryChild>((child) => ({
          ref: normalizeRelativePath(child.relativePath),
          title: child.title,
          displayId: child.displayId,
        }))
      const ref = authoredRef(project.projectKey, epic.relativePath)
      if (
        trimmedQuery !== '' &&
        !matchesQuery(trimmedQuery, epic.title, epic.displayId, slug) &&
        !children.some((child) => matchesQuery(trimmedQuery, child.title, child.displayId))
      ) {
        continue
      }
      entries.push({
        kind: 'epic',
        ref,
        projectKey: project.projectKey,
        relativePath: normalizeRelativePath(epic.relativePath),
        title: epic.title,
        displayId: epic.displayId,
        children,
        planned: placed.has(ref),
      })
    }

    for (const item of usable) {
      if (item.isEpic || item.epic) continue
      const slug = roadmapRefSlug(item.relativePath)
      if (trimmedQuery !== '' && !matchesQuery(trimmedQuery, item.title, item.displayId, slug)) continue
      const ref = authoredRef(project.projectKey, item.relativePath)
      entries.push({
        kind: 'item',
        ref,
        projectKey: project.projectKey,
        relativePath: normalizeRelativePath(item.relativePath),
        title: item.title,
        displayId: item.displayId,
        children: [],
        planned: placed.has(ref),
      })
    }

    if (entries.length > 0) {
      groups.push({ projectKey: project.projectKey, projectName: project.projectName, entries })
    }
  }
  return groups
}

// ---------------------------------------------------------------------------
// Entry construction + epic snapshotting (scan-coupled)
// ---------------------------------------------------------------------------

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

// Build a lane entry for a picked home-project ref (the keyboard picker and the
// single-project Backlog editor). An epic ref snapshots its children now; an item
// ref carries none. A ref that resolves to no known item is still added as an entry
// (kind decided by path) — validateRoadmap surfaces it as dangling, so a stale pick
// is visible, never silently dropped (Fallback Discipline).
export function makeEntry(items: ReadonlyArray<BacklogItem>, ref: string): RoadmapEntry {
  const normalized = normalizeRelativePath(ref)
  const children = isEpicRef(normalized) ? snapshotEpicChildren(items, normalized) : []
  return buildRoadmapEntry(null, normalized, children)
}

// Build a lane entry for a ref in a specific project. An epic snapshots its
// children from THAT project's scan (stored unqualified — they inherit the epic
// entry's project on read); an item carries none. The stored `entry.ref` is the
// authored ref, so a home entry stays unqualified and an aliased entry keeps its
// `alias:` prefix — round-tripping through renderRoadmapBody unchanged.
export function makeProjectEntry(project: RoadmapProjectItems, relativePath: string): RoadmapEntry {
  const normalized = normalizeRelativePath(relativePath)
  const children = isEpicRef(normalized) ? snapshotEpicChildren(project.items, normalized) : []
  return buildRoadmapEntry(project.projectKey, normalized, children)
}

// Add a library row to a track, registering the source project's alias in the
// draft's `projects:` map the first time a non-home project contributes a step (so
// its refs resolve on save, D2). A ref already present anywhere in the draft is a
// no-op (no duplicate steps). Home-project rows add no alias — their refs stay
// unqualified. Returns a new draft; the caller replaces state with it.
export function addLibraryEntry(
  draft: RoadmapDraft,
  laneIndex: number,
  project: RoadmapProjectItems,
  relativePath: string,
  index?: number,
): RoadmapDraft {
  const entry = makeProjectEntry(project, relativePath)
  if (draftContainsRef(draft.lanes, entry.ref)) return draft
  const projects =
    project.projectKey && !draft.projects.some((existing) => existing.alias === project.projectKey)
      ? [...draft.projects, { alias: project.projectKey, path: project.path }]
      : draft.projects
  const lanes =
    index === undefined ? addEntry(draft.lanes, laneIndex, entry) : insertEntry(draft.lanes, laneIndex, index, entry)
  return { ...draft, projects, lanes }
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
