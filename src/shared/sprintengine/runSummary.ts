// The compact, node-free read-model for one sprint run as the run index (T1)
// surfaces it — enough to render a rail row, a state chip, and a merge rollup
// without a resident workspace. Every lifecycle judgement reuses the canonical
// shared predicates (completion, cancellation, human-input, repo-merge rollup);
// this module never re-derives them. Consumed by the Sprints door rail (T3), the
// canvas rollup/waiting strip (T4), and the creation project picker (T5).
import type { SprintEngineState, SprintEngineTaskStatus } from './run-types'
import {
  deriveSprintEngineRepoMergeRollup,
  isCanceledSprintEngineRun,
  isCompletedSprintEngineRun,
  sprintEngineHumanInputTasks,
} from './state'

// Renderer broadcast channel: main pushes one of these whenever a run's
// projection changes so an open Sprints door can refetch without polling.
export const SPRINT_RUNS_CHANGED_CHANNEL = 'sprintengine:runs:changed'

export type SprintRunsChangedEvent = { statePath: string }

/**
 * A run's lifecycle as read from disk, with no live automation runtime to
 * consult. `running` = work is in flight (a task in an active column); `idle` =
 * the run exists but nothing is currently running and it is neither complete nor
 * canceled (freshly created, or started-and-quiet); `unknown` = the projection
 * could not be read (see {@link SprintRunSummary.unknownReason}). The finer
 * paused/blocked/failed distinctions the resident board glyph draws need the live
 * runner and are intentionally absent here.
 */
export type SprintRunRuntimeState =
  | 'running'
  | 'needs_input'
  | 'completed'
  | 'canceled'
  | 'idle'
  | 'unknown'

export type SprintRunSummary = {
  /** Absolute path to the run's `run.yaml`; the run's stable identity. */
  statePath: string
  /** Team directory name (the folder holding run.yaml). */
  teamSlug: string
  /** Human run name from the projection, falling back to the team slug. */
  teamName: string
  /** Absolute project root holding this run's `.multi-code/sprintengine/` tree. */
  projectRoot: string
  /** Last path segment of {@link projectRoot} (the `projectDisplayName` rule). */
  projectName: string
  runtimeState: SprintRunRuntimeState
  taskCounts: {
    total: number
    done: number
    inProgress: number
    waiting: number
  }
  /**
   * Cross-repo merge rollup (MC-1613), counted across every declared repo. All
   * zeros for a run with no worktree branch to merge (never `null`, so callers
   * render one shape).
   */
  repoRollup: {
    declared: number
    merged: number
    open: number
  }
  /** Tasks awaiting the human operator (user-routed needs_input). */
  needsInputCount: number
  /** ISO run-creation instant, or null when the projection records none. */
  startedAt: string | null
  /** ISO last-update instant, or null when neither projection nor mtime supplies one. */
  updatedAt: string | null
  /** Short "Started from" descriptor (Epic / Backlog item / Product plan …), or null. */
  sourceLabel: string | null
  /** Present only when {@link runtimeState} is `unknown`: why the projection could not be read. */
  unknownReason?: string
}

// Board columns that mean a task is genuinely in flight, mirroring
// SPRINT_ENGINE_ACTIVE_TASK_STATUSES in state.ts (review counts — the single
// owner is reviewing the diff it just published).
const ACTIVE_TASK_STATUSES: ReadonlySet<SprintEngineTaskStatus> = new Set(['in_progress', 'review'])
// Tasks that have not started or are parked waiting on someone.
const WAITING_TASK_STATUSES: ReadonlySet<SprintEngineTaskStatus> = new Set(['todo', 'needs_input'])

const BACKLOG_EPICS_PATH = /^backlog[\\/]epics[\\/]/i
const BACKLOG_PATH = /^backlog[\\/]/i

// Mirrors the mobile snapshot's STARTED_FROM_KIND_LABELS so both surfaces name a
// seed source identically.
const SOURCE_KIND_LABELS: Record<string, string> = {
  epic: 'Epic',
  selection: 'Selection',
  product_plan: 'Product plan',
  architect_plan: 'Architect plan',
  markdown: 'Markdown',
  html: 'HTML',
  text: 'Text',
  backlog_item: 'Backlog item',
}

// The run's launch provenance as a short chip label, from `run.source` (the
// projected launch seed). Path-based epic/backlog detection wins over the raw
// `kind` so an epic launched as a markdown seed still reads "Epic", matching the
// mockup §2 "Started from" chip. Null when the run records no source.
function deriveSourceLabel(state: SprintEngineState | null): string | null {
  const source = state?.source
  const path = source?.path
  if (!source || !path) return null
  const planKind = typeof source.planKind === 'string' ? source.planKind : undefined
  // A selection's root is its anchor backlog item (MC-2060) — the plan kind is
  // the honest provenance, so it wins over the path-based single-item read.
  if (planKind === 'selection') return 'Selection'
  if (BACKLOG_EPICS_PATH.test(path)) return 'Epic'
  if (BACKLOG_PATH.test(path)) return 'Backlog item'
  return (
    (planKind && SOURCE_KIND_LABELS[planKind])
    ?? SOURCE_KIND_LABELS[source.kind]
    ?? 'Seed document'
  )
}

function deriveRuntimeState(state: SprintEngineState): SprintRunRuntimeState {
  // Cancellation is a decided terminal and outranks completion / in-flight work,
  // mirroring deriveSprintEngineRunGlyph's priority order.
  if (isCanceledSprintEngineRun(state)) return 'canceled'
  if (sprintEngineHumanInputTasks(state).length > 0) return 'needs_input'
  if (isCompletedSprintEngineRun(state)) return 'completed'
  if (state.tasks.some((task) => ACTIVE_TASK_STATUSES.has(task.status))) return 'running'
  return 'idle'
}

function deriveTaskCounts(state: SprintEngineState): SprintRunSummary['taskCounts'] {
  let done = 0
  let inProgress = 0
  let waiting = 0
  for (const task of state.tasks) {
    if (task.status === 'done') done += 1
    else if (ACTIVE_TASK_STATUSES.has(task.status)) inProgress += 1
    else if (WAITING_TASK_STATUSES.has(task.status)) waiting += 1
    // `canceled` is terminal-but-not-done and counts toward none of these.
  }
  return { total: state.tasks.length, done, inProgress, waiting }
}

function deriveRepoRollup(state: SprintEngineState): SprintRunSummary['repoRollup'] {
  const rollup = deriveSprintEngineRepoMergeRollup(state.vcs)
  // A run with no worktree branch to merge reports all zeros (one rendered shape),
  // distinct from a merged run where declared === merged.
  if (!rollup) return { declared: 0, merged: 0, open: 0 }
  return { declared: rollup.total, merged: rollup.merged, open: rollup.unmerged }
}

/**
 * Build one {@link SprintRunSummary} from a normalized projection (or an
 * `unknownReason` when the projection could not be read). Pure: identity fields
 * are resolved by the caller from the state path, so this module stays node-free
 * and unit-testable. When `unknownReason` is set (or `state` is null), the row is
 * an `unknown` placeholder that still carries its identity — never a dropped row.
 */
export function deriveSprintRunSummary(input: {
  statePath: string
  teamSlug: string
  projectRoot: string
  projectName: string
  state: SprintEngineState | null
  /** Fallback ISO updatedAt (e.g. the projection file mtime) when the state carries none. */
  updatedAtFallback?: string | null
  unknownReason?: string
}): SprintRunSummary {
  const { statePath, teamSlug, projectRoot, projectName, state } = input

  if (!state || input.unknownReason) {
    return {
      statePath,
      teamSlug,
      teamName: teamSlug,
      projectRoot,
      projectName,
      runtimeState: 'unknown',
      taskCounts: { total: 0, done: 0, inProgress: 0, waiting: 0 },
      repoRollup: { declared: 0, merged: 0, open: 0 },
      needsInputCount: 0,
      startedAt: null,
      updatedAt: input.updatedAtFallback ?? null,
      sourceLabel: null,
      unknownReason: input.unknownReason ?? 'Run projection could not be read.',
    }
  }

  return {
    statePath,
    teamSlug,
    teamName: state.name?.trim() || teamSlug,
    projectRoot,
    projectName,
    runtimeState: deriveRuntimeState(state),
    taskCounts: deriveTaskCounts(state),
    repoRollup: deriveRepoRollup(state),
    needsInputCount: sprintEngineHumanInputTasks(state).length,
    startedAt: state.creation?.createdAt ?? state.source?.capturedAt ?? null,
    updatedAt: state.updatedAt ?? state.creation?.updatedAt ?? input.updatedAtFallback ?? null,
    sourceLabel: deriveSourceLabel(state),
  }
}
