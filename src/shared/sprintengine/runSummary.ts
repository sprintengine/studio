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
  sprintEngineCoordinatorSeat,
  sprintEngineHumanInputTasks,
  type SprintEngineCoordinatorSeat,
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
  /**
   * The run branch, for the rail row's branch chip. Null when the run has no
   * worktree yet, records an empty name, or its projection could not be read.
   */
  branchName: string | null
  /**
   * The PRIMARY repo's run worktree, project-root-RELATIVE exactly as the
   * projection records it — this module stays node-free, so a caller that wants
   * an absolute path joins it to {@link projectRoot} itself. Null when the run
   * has no worktree, records an empty path, or could not be read.
   */
  worktreePath: string | null
  /** ISO run-creation instant, or null when the projection records none. */
  startedAt: string | null
  /** ISO last-update instant, or null when neither projection nor mtime supplies one. */
  updatedAt: string | null
  /**
   * ISO instant the run STOPPED, for the rail row's "since it finished" clock.
   * Set only for a decided run — the last task to complete for a completed run,
   * the last update for a canceled one — and null for every run still in play
   * (running, needs_input, idle) or unreadable.
   */
  finishedAt: string | null
  /** Short "Started from" descriptor (Epic / Backlog item / Product plan …), or null. */
  sourceLabel: string | null
  /**
   * Who coordinates this run, as {@link sprintEngineCoordinatorSeat} resolves it
   * from the run's own `configuredRoles` — a SEAT, never a role-name comparison
   * (epic 2058). It rides the index summary because the run partition that sorts
   * runs into the Workflows and Sprints doors (item 2470) reads the rail's
   * summaries and never the full projection: a run whose coordinator's seat is
   * NAMED is one an architect plans, and a run whose coordinator has no role is
   * one whose work was already written down.
   *
   * `null` when the projection could not be read, and absent from a payload an
   * older build produced. Both mean "this run does not state its kind", which the
   * partition answers for rather than guessing at — see `runDoors.ts`.
   */
  coordinatorSeat?: SprintEngineCoordinatorSeat | null
  /** Present only when {@link runtimeState} is `unknown`: why the projection could not be read. */
  unknownReason?: string
  /**
   * Present only when {@link runtimeState} is `unknown`: whether the read failure
   * is PERMANENT. `unsupported_store` = the store predates what this build reads
   * and is never migrated, so retrying can only fail again and the remedy is to
   * delete the team directory. Absent means the ordinary case — a projection not
   * written yet, mid-write, or unreadable just now — which a retry may fix. The
   * surfaces that render the failure need the distinction to avoid calling a
   * permanent rejection temporary (MC-2063).
   */
  unknownKind?: 'unsupported_store'
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

// The primary repo's record: entry zero of `vcs.repos` (always the primary,
// `root: '.'`), falling back to the flat `vcs.*` fields only for a store whose
// list is empty — the same preference `resolveWorkspaceWorktrees` applies, so
// the rail names the tree every other surface opens.
function primaryRepo(state: SprintEngineState): { branchName?: string; worktreePath?: string } | null {
  const vcs = state.vcs
  if (!vcs) return null
  return vcs.repos?.[0] ?? vcs
}

function trimmedOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

// The run branch as the projection records it, trimmed. Null for a run with no
// vcs block (never provisioned a worktree) or an empty name.
function deriveBranchName(state: SprintEngineState): string | null {
  const repo = primaryRepo(state)
  return trimmedOrNull(repo?.branchName) ?? trimmedOrNull(state.vcs?.branchName)
}

// The PRIMARY repo's run worktree, kept project-root-RELATIVE exactly as the
// projection stores it — joining it to a root is a node concern and this module
// is node-free (the renderer resolves it with `resolveDeclaredPath`). Null for
// a run with no vcs block or an empty path.
function deriveWorktreePath(state: SprintEngineState): string | null {
  const repo = primaryRepo(state)
  return trimmedOrNull(repo?.worktreePath) ?? trimmedOrNull(state.vcs?.worktreePath)
}

/**
 * When a decided run stopped. A completed run finished when its LAST task did,
 * so this takes the newest parseable `task.completedAt` and falls back to the
 * run's `updatedAt` when no task carries one. A canceled run has no cancellation
 * instant to read — `SprintEngineState.canceled` is a bare boolean flag (see
 * run-types.ts), and the projection records no `canceledAt` — so its last update
 * IS when it stopped. Every undecided state (running, needs_input, idle) is still
 * in play and reports null rather than a clock that would tick against nothing.
 */
function deriveFinishedAt(
  state: SprintEngineState,
  runtimeState: SprintRunRuntimeState,
  updatedAt: string | null,
): string | null {
  if (runtimeState === 'canceled') return updatedAt
  if (runtimeState !== 'completed') return null
  let latest: string | null = null
  let latestMs = Number.NEGATIVE_INFINITY
  for (const task of state.tasks) {
    const completedAt = task.completedAt
    if (typeof completedAt !== 'string' || !completedAt.trim()) continue
    const ms = Date.parse(completedAt)
    // An unparseable stamp is skipped rather than allowed to win by string order.
    if (Number.isNaN(ms) || ms <= latestMs) continue
    latestMs = ms
    latest = completedAt
  }
  return latest ?? updatedAt
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
  unknownKind?: 'unsupported_store'
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
      branchName: null,
      worktreePath: null,
      startedAt: null,
      updatedAt: input.updatedAtFallback ?? null,
      finishedAt: null,
      sourceLabel: null,
      // An unreadable projection has no `configuredRoles` to resolve a seat from,
      // and `sprintEngineCoordinatorSeat` answers "architect" for a state it
      // cannot read. Saying null instead keeps "we do not know" distinct from
      // "this run is architect-coordinated".
      coordinatorSeat: null,
      unknownReason: input.unknownReason ?? 'Run projection could not be read.',
      ...(input.unknownKind ? { unknownKind: input.unknownKind } : {}),
    }
  }

  const runtimeState = deriveRuntimeState(state)
  const updatedAt = state.updatedAt ?? state.creation?.updatedAt ?? input.updatedAtFallback ?? null

  return {
    statePath,
    teamSlug,
    teamName: state.name?.trim() || teamSlug,
    projectRoot,
    projectName,
    runtimeState,
    taskCounts: deriveTaskCounts(state),
    repoRollup: deriveRepoRollup(state),
    needsInputCount: sprintEngineHumanInputTasks(state).length,
    branchName: deriveBranchName(state),
    worktreePath: deriveWorktreePath(state),
    coordinatorSeat: sprintEngineCoordinatorSeat(state),
    startedAt: state.creation?.createdAt ?? state.source?.capturedAt ?? null,
    updatedAt,
    finishedAt: deriveFinishedAt(state, runtimeState, updatedAt),
    sourceLabel: deriveSourceLabel(state),
  }
}
