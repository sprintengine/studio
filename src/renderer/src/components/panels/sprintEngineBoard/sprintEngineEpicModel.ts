// The Epic tab's read model (item 2028): the backlog epic a sprint was seeded
// from, its children, and which task delivers each one. Pure and DOM-free so the
// whole surface — membership, the mapping column, ordering, and the unavailable
// states — is node-testable without a renderer.
//
// This module DERIVES NOTHING of its own about lifecycle: a child's status is
// the status the backlog scan reports (kept in step with its task by
// `2026-07-30-child-item-status-propagation`), and the mapping is read from the
// task's own `backlogRef` (`2026-07-30-task-backlog-pointer`). The only things
// computed here are set membership and row order.

import { backlogEpicSlugFromPath, epicProgressBySlug, isBacklogEpicPath } from '../../../utils/backlogEpics'
import { isSprintEngineBacklogPath } from './sprintEngineStartedFrom'
import type { BacklogEpicProgress } from '../../../utils/backlogEpics'
import type { BacklogItem, BacklogScanError } from '../../../utils/backlog'
import type {
  SprintEngineSource,
  SprintEngineSourceBundleStateItem,
  SprintEngineTask,
} from '../../../types/workspace'
import { SIDECAR_DIR_NAMES } from '../../../../../shared/workspace-sidecar'

/** The epic a run was seeded from: its project-relative file, the slug its
 *  children point up at, and the member files the run itself recorded at
 *  launch (the second source used to name a child whose file has since moved). */
export type SprintEngineEpicSeed = {
  relativePath: string
  slug: string
  recordedChildPaths: string[]
}

/** The one column this surface adds to a backlog row: the task delivering the
 *  item, and who is working it. */
export type SprintEngineEpicMapping = {
  taskId: string
  /** Human ordinal for the mapping cell, e.g. `task 4`. */
  label: string
  /** The agent that owns the task, or last implemented it; null when nobody
   *  has claimed it yet. */
  agentId: string | null
}

export type SprintEngineEpicChildRow =
  | {
      kind: 'item'
      key: string
      relativePath: string
      item: BacklogItem
      mapping: SprintEngineEpicMapping | null
    }
  | {
      kind: 'unavailable'
      key: string
      relativePath: string
      /** Why the file could not be shown — the scan's own error when it
       *  reported one, else that it is no longer in `backlog/`. */
      reason: string
      mapping: SprintEngineEpicMapping | null
    }

export type SprintEngineEpicModel = {
  seed: SprintEngineEpicSeed
  /** The epic concept item from the scan; null when its file cannot be read. */
  epic: BacklogItem | null
  /** Set with `epic: null` — why the heading has no item behind it. */
  epicUnavailableReason: string | null
  rows: SprintEngineEpicChildRow[]
  /** The shared full-scan rollup for this slug (`epicProgressBySlug`), so the
   *  meter here and the one on the Backlog door cannot disagree. Children the
   *  scan cannot see are listed as unavailable rows rather than counted. */
  progress: BacklogEpicProgress
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase()
}

/**
 * The epic seed, or null when this run was not started from one — which is what
 * keeps the Epic section absent (and a goal-seeded sprint's chrome unchanged).
 *
 * Two signals, because only one of them is reliable. The wizard stamps
 * `planKind: 'epic'` on an epic launch, but a run created from the backlog
 * surface or the MCP tool records `planKind: 'unknown'` while pointing straight
 * at `backlog/epics/<slug>.md` — reading the flag alone would hide the section
 * on exactly the runs this exists for. The file's location is the second signal,
 * and it is the same one the store-only reconcile trusts (`isBacklogEpicPath`).
 *
 * A seed copied into the run store with no recorded original cannot be located
 * in the project's backlog/ at all, so it yields no section rather than one
 * opening on nothing.
 */
export function sprintEngineEpicSeed(
  source: SprintEngineSource | undefined,
  sourceBundle: SprintEngineSourceBundleStateItem[] | undefined,
): SprintEngineEpicSeed | null {
  if (!source?.path) return null
  // A `selection` launch (MC-2060) has no single epic root — its anchor item is
  // the recorded source and the selected epics ride the bundle as `epic`-kind
  // entries. The tab keys on the first of those, so a selection containing an
  // epic keeps its Epic tab; a selection of plain items alone has no epic to
  // anchor a membership view on and yields none.
  const epicPath =
    source.planKind === 'selection' && !isBacklogEpicPath(backlogPathOf(source.originalPath, source.path) ?? '')
      ? firstBundleEpicPath(sourceBundle)
      : backlogPathOf(source.originalPath, source.path)
  if (!epicPath) return null
  if (source.planKind !== 'epic' && source.planKind !== 'selection' && !isBacklogEpicPath(epicPath)) return null
  // The members the run recorded at launch: the bundle's backlog items. The epic
  // file itself is the root, never one of its own children, and supporting
  // reading material (mockups, design notes) is not a member at all.
  const recordedChildPaths: string[] = []
  for (const entry of sourceBundle ?? []) {
    const path = backlogPathOf(entry.originalPath, entry.path)
    if (path && !isBacklogEpicPath(path)) recordedChildPaths.push(path)
  }
  return { relativePath: epicPath, slug: backlogEpicSlugFromPath(epicPath), recordedChildPaths }
}

// The first selected epic a `selection` bundle carries (kind `epic`, or any
// entry living under backlog/epics/ — a pre-marker store is honest by location).
function firstBundleEpicPath(
  sourceBundle: SprintEngineSourceBundleStateItem[] | undefined,
): string | null {
  for (const entry of sourceBundle ?? []) {
    const path = backlogPathOf(entry.originalPath, entry.path)
    if (path && isBacklogEpicPath(path)) return path
  }
  return null
}

// The project-relative `backlog/…` path a seed entry points at: the recorded
// original wins over a copy in the run store, and anything outside backlog/ is
// not a backlog item.
function backlogPathOf(originalPath: string | undefined, path: string): string | null {
  const candidate = originalPath ?? path
  return isSprintEngineBacklogPath(candidate) ? candidate : null
}

/**
 * A run's project root, read from where its store sits:
 * `<root>/<sidecar>/sprintengine/<team>/run.yaml` — the same derivation the
 * main-process run index makes (`resolveRunIdentity`).
 *
 * The board reads its project from the workspace's folder status, which a DOOR
 * mount does not have: the Sprints door opens a run by state path with no
 * workspace behind it. Without this the Epic tab would have no backlog to read
 * on exactly the surface that lists every run. Null for a path that is not a run
 * store, rather than a guessed directory.
 */
export function sprintEngineProjectRootFromStatePath(statePath: string | null | undefined): string | null {
  if (!statePath) return null
  // Length-preserving, so the index maps straight back onto the original.
  const normalized = statePath.replace(/\\/g, '/').toLowerCase()
  const marker = SIDECAR_DIR_NAMES
    .map((dirName) => normalized.lastIndexOf(`/${dirName}/sprintengine/`))
    .reduce((furthest, index) => Math.max(furthest, index), -1)
  if (marker <= 0) return null
  return statePath.slice(0, marker)
}

/**
 * `T4` → `task 4`. Task ids are the engine's own `T<n>`; anything else (a
 * renamed or hand-authored id) is shown verbatim rather than renumbered.
 */
export function sprintEngineTaskMappingLabel(taskId: string): string {
  const trimmed = taskId.trim()
  const ordinal = /^T(\d+)$/i.exec(trimmed)
  return ordinal ? `task ${Number(ordinal[1])}` : trimmed
}

/** The task delivering one backlog item, bound by its `backlogRef`. */
export function sprintEngineEpicMappingFor(
  tasks: ReadonlyArray<SprintEngineTask>,
  relativePath: string,
): SprintEngineEpicMapping | null {
  const wanted = normalizePath(relativePath)
  const task = tasks.find(
    (candidate) =>
      candidate.backlogRef && normalizePath(candidate.backlogRef.projectRelativePath) === wanted,
  )
  if (!task) return null
  return {
    taskId: task.id,
    label: sprintEngineTaskMappingLabel(task.id),
    // The worker who last published stays visible through the task's own
    // review phase, where `ownerAgentId` is null.
    agentId: task.ownerAgentId ?? task.lastImplementedByAgentId ?? null,
  }
}

const MISSING_FILE_REASON = 'Not in this project’s backlog folder — it may have been moved or deleted.'

/**
 * The epic, its children, and their mappings.
 *
 * Membership is the SCAN (`epic:` frontmatter pointing up at the slug — stored
 * up, derived down), widened by the paths this run recorded as members and the
 * paths its tasks point at. A recorded member the scan cannot show is rendered
 * as unavailable with its path rather than dropped, so a moved or unreadable
 * file is visible instead of silently shrinking the epic.
 *
 * Rows are ordered by the task delivering them — the sequence the coordinator
 * planned — with children that have no task last, alphabetically by path.
 */
export function buildSprintEngineEpicModel(input: {
  seed: SprintEngineEpicSeed
  items: ReadonlyArray<BacklogItem>
  scanErrors: ReadonlyArray<BacklogScanError>
  tasks: ReadonlyArray<SprintEngineTask>
}): SprintEngineEpicModel {
  const { seed, items, scanErrors, tasks } = input
  const itemByPath = new Map<string, BacklogItem>()
  for (const item of items) itemByPath.set(normalizePath(item.relativePath), item)
  const errorByPath = new Map<string, string>()
  for (const error of scanErrors) errorByPath.set(normalizePath(error.relativePath), error.message)

  const epicKey = normalizePath(seed.relativePath)
  const epic = itemByPath.get(epicKey) ?? null
  const epicUnavailableReason = epic
    ? null
    : errorByPath.get(epicKey) ?? MISSING_FILE_REASON

  const rows: SprintEngineEpicChildRow[] = []
  const seen = new Set<string>([epicKey])
  for (const item of items) {
    if (item.isEpic || item.epic !== seed.slug) continue
    const key = normalizePath(item.relativePath)
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({
      kind: 'item',
      key,
      relativePath: item.relativePath,
      item,
      mapping: sprintEngineEpicMappingFor(tasks, item.relativePath),
    })
  }

  // Paths the run itself claims are part of this epic: the members captured at
  // launch, and anything a task points at. Present in the scan → already listed
  // above (or a member of another epic, which is not this view's business);
  // absent → an unavailable row, because a pointer at nothing is a defect worth
  // seeing rather than a shorter list.
  const referenced = [
    ...seed.recordedChildPaths,
    ...tasks.map((task) => task.backlogRef?.projectRelativePath).filter((path): path is string => Boolean(path)),
  ]
  for (const path of referenced) {
    const key = normalizePath(path)
    if (seen.has(key) || itemByPath.has(key)) continue
    seen.add(key)
    rows.push({
      kind: 'unavailable',
      key,
      relativePath: path,
      reason: errorByPath.get(key) ?? MISSING_FILE_REASON,
      mapping: sprintEngineEpicMappingFor(tasks, path),
    })
  }

  const taskOrder = new Map(tasks.map((task, index) => [task.id, index]))
  rows.sort((left, right) => {
    const leftOrder = left.mapping ? taskOrder.get(left.mapping.taskId) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER
    const rightOrder = right.mapping ? taskOrder.get(right.mapping.taskId) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER
    if (leftOrder !== rightOrder) return leftOrder - rightOrder
    return left.key.localeCompare(right.key)
  })

  return {
    seed,
    epic,
    epicUnavailableReason,
    rows,
    progress: epicProgressBySlug([...items]).get(seed.slug) ?? { done: 0, total: 0 },
  }
}
