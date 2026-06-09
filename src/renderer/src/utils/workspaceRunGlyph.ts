import type { SprintEngineTask, Workspace } from '../types/workspace'
import { deriveSprintEngineRunGlyph, type SprintEngineRunGlyph } from './sprintengine'

// Mode-level status for a sidebar workspace row, expressed in the shared
// lifecycle vocabulary. This module is the per-mode dispatch point: a
// workspace's status is owned by the module that owns its mode, and the shell
// only consumes the derived glyph. Sprint Engine is the sole provider today;
// when workspace types become a module contribution (see
// future-plans/2026-05-28-feature-level-pluggable-architecture.md), modules
// register a status provider with this contract instead of branching here.
export type WorkspaceRunGlyph = SprintEngineRunGlyph

// Matches the shell's terminal-derived activity vocabulary
// (workspaceManagerHelpers.WorkspaceActivity) without importing across the
// utils → components boundary.
export type WorkspaceActivityKind = 'needs-input' | 'working' | 'failed' | 'idle'

type SprintEngineWorkspaceLike = Pick<
  Workspace,
  'mode' | 'sprintEngineState' | 'sprintEngineContext' | 'sprintEngineAutoState'
>

function isSprintEngineWorkspace(workspace: SprintEngineWorkspaceLike): boolean {
  return workspace.mode === 'sprintengine' || Boolean(workspace.sprintEngineContext)
}

function latestTaskCompletionAt(tasks: SprintEngineTask[]): number | null {
  let latest: number | null = null
  for (const task of tasks) {
    if (!task.completedAt) continue
    const at = Date.parse(task.completedAt)
    if (Number.isFinite(at) && (latest === null || at > latest)) latest = at
  }
  return latest
}

// AutoRun never reaches `complete` on a manual run, so a run whose tasks all
// finished by hand still reads as done.
function manualRunCompletedAt(workspace: SprintEngineWorkspaceLike): number | null {
  const tasks = workspace.sprintEngineState?.tasks ?? []
  if (tasks.length === 0 || !tasks.every((task) => task.status === 'done')) return null
  return latestTaskCompletionAt(tasks) ?? 0
}

// Completion is news once: the done glyph shows only until the user next has
// the workspace active while the run is complete (markSprintEngineRunCompletionSeen),
// then the row reverts to recency text. An undatable completion counts as
// unseen until any seen mark exists.
function completionSeen(workspace: SprintEngineWorkspaceLike, completedAt: number | null): boolean {
  const seenAt = workspace.sprintEngineAutoState?.completionSeenAt
  if (typeof seenAt !== 'number') return false
  return completedAt === null || seenAt >= completedAt
}

/** True when the run is complete and the user has not yet seen the completion.
 *  Drives both the sidebar done glyph and the acknowledgement effect that
 *  marks it seen once the workspace becomes active. */
export function isSprintEngineCompletionUnseen(workspace: SprintEngineWorkspaceLike): boolean {
  if (!isSprintEngineWorkspace(workspace)) return false
  const rollup = deriveSprintEngineRunGlyph({
    sprintEngineState: workspace.sprintEngineState,
    autoState: workspace.sprintEngineAutoState,
  })
  if (rollup && rollup.state !== 'done') return false
  const completedAt = rollup?.state === 'done'
    ? workspace.sprintEngineAutoState?.changedAt ?? manualRunCompletedAt(workspace)
    : manualRunCompletedAt(workspace)
  if (rollup?.state !== 'done' && completedAt === null) return false
  return !completionSeen(workspace, completedAt)
}

// The sidebar row's one status slot. Priority mirrors the attention order the
// dot system had, upgraded to the lifecycle vocabulary:
//   1. An agent terminal waiting on input (the old pulsing warn dot) — always
//      the actionable signal, even while the runner reports `running`.
//   2. The run rollup (human-routed needs_input, runner runtime states).
//      `done` is gated by the seen-rule so finished runs don't wear a
//      permanent check.
//   3. A manually-driven run whose tasks all finished → same gated `done`.
//   4. Terminal activity: busy terminals spin, a failed terminal reads as
//      failed — one idiom, no `now` text on Sprint Engine rows.
// Null means "no run signal": the caller falls back to recency text.
export function deriveWorkspaceRunGlyph(
  workspace: SprintEngineWorkspaceLike,
  activity: WorkspaceActivityKind,
): WorkspaceRunGlyph | null {
  if (!isSprintEngineWorkspace(workspace)) return null

  if (activity === 'needs-input') {
    return { state: 'needs_input', live: false, label: 'Needs input' }
  }

  const rollup = deriveSprintEngineRunGlyph({
    sprintEngineState: workspace.sprintEngineState,
    autoState: workspace.sprintEngineAutoState,
  })
  if (rollup && rollup.state !== 'done') return rollup
  if (
    (rollup?.state === 'done' || manualRunCompletedAt(workspace) !== null)
    && isSprintEngineCompletionUnseen(workspace)
  ) {
    return { state: 'done', live: false, label: 'Run completed' }
  }

  if (activity === 'working') {
    return { state: 'in_progress', live: true, label: 'Agents working' }
  }
  if (activity === 'failed') {
    return { state: 'failed', live: false, label: 'Agent failed' }
  }
  return null
}
