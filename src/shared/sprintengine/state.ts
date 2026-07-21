/**
 * Sprint Engine pure state helpers, shared by the renderer and the main
 * process.
 *
 * Relocated verbatim from `src/renderer/src/utils/sprintengine.ts`
 * (sprint-runtime-ownership Phase 2: the main process runs the auto-run
 * planner, which reads this module), following the established shim pattern
 * (`sprintengineAutomationLifecycle.ts`). The renderer file remains as a
 * re-export shim, so every existing import site and test keeps working
 * unchanged. Pure with respect to side effects: no DOM, React, `window.api`,
 * or store access may be added here.
 */
import type {
  AgentCli,
  AgentId,
  LifecycleState,
  SprintEngineAllowedRuntime,
  SprintEngineArtifact,
  SprintEngineArtifactApprovalMode,
  SprintEngineArtifactKind,
  SprintEngineArtifactReviewHistoryEntry,
  SprintEngineArtifactStatus,
  SprintEngineMockConfig,
  SprintEngineNeedsInputKind,
  SprintEngineNeedsInputReason,
  SprintEngineProjectionCreation,
  SprintEngineProjectionLockReport,
  SprintEngineProjectionLockWarning,
  SprintEngineProjectionLocks,
  SprintEngineProjectionSource,
  SprintEnginePullRequestState,
  SprintEngineRecordedArtifact,
  SprintEngineRole,
  SprintEngineRoleCounts,
  SprintEngineRoleId,
  SprintEngineRoleRegistry,
  SprintEngineRoleRegistryMetadata,
  SprintEngineRoleRegistrySourceLayer,
  SprintEngineRoleRegistryWarning,
  SprintEngineRoleRuntimes,
  SprintEngineRoleSettings,
  SprintEngineRosterSession,
  SprintEngineRosterSource,
  SprintEngineRunnerPolicy,
  SprintEngineRuntimeAgent,
  SprintEngineSkillMap,
  SprintEngineSource,
  SprintEngineSourceBundleStateItem,
  SprintEngineState,
  SprintEngineTask,
  SprintEngineTaskActivityEntry,
  SprintEngineTaskActivityType,
  SprintEngineTaskBoardColumn,
  SprintEngineTaskComment,
  SprintEngineTaskCommentType,
  SprintEngineTaskDiff,
  SprintEngineTaskDiffLine,
  SprintEngineTaskDiffSource,
  SprintEngineTaskDiffStatus,
  SprintEngineTaskEvidence,
  SprintEngineTaskFeedback,
  SprintEngineTaskFeedbackFinding,
  SprintEngineTaskFeedbackFindingArea,
  SprintEngineTaskFeedbackFindingKind,
  SprintEngineTaskFeedbackFindingSeverity,
  SprintEngineTaskFeedbackFindingStatus,
  SprintEngineTaskFeedbackIssue,
  SprintEngineTaskFeedbackIssueCategory,
  SprintEngineTaskFeedbackIssueSeverity,
  SprintEngineTaskFeedbackIssueStatus,
  SprintEngineTaskNeedsInput,
  SprintEngineTaskPhase,
  SprintEngineTaskSource,
  SprintEngineTaskSourceSyncStatus,
  SprintEngineTaskSourceType,
  SprintEngineTaskStatus,
  SprintEngineTaskTriage,
  SprintEngineVcs,
  SprintEngineVcsRepo,
  SprintEngineWorker,
} from './run-types'
import { DEFAULT_SPRINTENGINE_TASK_REPO } from './run-types'
import type { AgentState } from './agent-state'
import type {
  SprintEngineAutoState,
  SprintEngineAutomationRuntimeState,
} from './automation-types'
import {
  deriveSprintEngineAutomationDesiredMode,
  normalizeSprintEngineAutomationRuntimeState,
} from './automation-lifecycle'
import { agentCliSupportsConversationResume } from '../agent-cli-resume'
import type { ResumeCapabilities } from '../agent-cli-resume'

// Sprint Engine board column → the shared lifecycle vocabulary. The pipeline
// reads as a filling gauge: todo → ready → in_progress → review → done, with
// needs_input as the only off-pipeline lane (the task is waiting on a human or
// the architect rather than on its own owner).
export function taskBoardColumnToLifecycle(column: SprintEngineTaskBoardColumn): LifecycleState {
  switch (column) {
    case 'todo':
      return 'todo'
    case 'ready':
      return 'ready'
    case 'in_progress':
      return 'in_progress'
    case 'review':
      return 'review'
    case 'needs_input':
      return 'needs_input'
    case 'done':
      return 'done'
    case 'canceled':
      return 'archived'
  }
}

// The tasks in this run that are waiting on a *human* — a needs_input task whose
// kind is `user`. Architect-routed needs_input is excluded, because Sprint Engine
// can route those through automatic architect triage, so they are not the user's
// action. Single source of truth for the per-task human-input rule, shared by the
// needs-input glyph (`sprintEngineRunAwaitsHumanInput`) and the
// `sprint-engine.run-needs-input` automation trigger, so both judge a blocked
// task identically.
export function sprintEngineHumanInputTasks(
  sprintEngineState: Pick<SprintEngineState, 'tasks'>,
): SprintEngineTask[] {
  return sprintEngineState.tasks.filter(
    (task) =>
      task.status === 'needs_input'
      && task.needsInput?.kind === 'user',
  )
}

// True when at least one incomplete task is waiting on a *human*. Used to surface
// the needs-input glyph on the Backlog even while other tasks in the run keep
// progressing.
export function sprintEngineRunAwaitsHumanInput(
  sprintEngineState: Pick<SprintEngineState, 'tasks'>,
): boolean {
  return sprintEngineHumanInputTasks(sprintEngineState).length > 0
}

// Run-level lifecycle rollup shared by every surface that renders a Sprint
// Engine run as one LifecycleGlyph (Backlog rows, the workspace sidebar).
// `live` gates the spinner — only a genuinely running runner earns the one
// animated glyph.
export type SprintEngineRunGlyph = { state: LifecycleState; live: boolean; label: string }

// Live AutoRun runtime → glyph. `idle` is intentionally absent: an idle runner
// carries no live signal, so callers fall back to their own default rendering
// (item status on the Backlog, recency text in the sidebar).
const AUTOMATION_RUN_GLYPH: Partial<Record<SprintEngineAutomationRuntimeState, SprintEngineRunGlyph>> = {
  running: { state: 'in_progress', live: true, label: 'Running' },
  paused: { state: 'paused', live: false, label: 'Paused' },
  blocked: { state: 'needs_input', live: false, label: 'Blocked — needs input' },
  failed: { state: 'failed', live: false, label: 'Failed' },
  complete: { state: 'done', live: false, label: 'Completed' },
  // Canceled reads as a plain, decided terminal — the `archived` lifecycle mark
  // (a filed-away record), distinct from the green `done` completion tick.
  canceled: { state: 'archived', live: false, label: 'Canceled' },
}

// Board columns that mean work is genuinely in flight. `review` counts — under
// the single-owner lifecycle the task's own implementer is reviewing the diff it
// just published, in the same session.
// A `needs_input` task that is NOT user-routed also counts as active work (it
// fell through the user-needs_input check below, so it's blocked on the
// architect, not the user) and is handled inline rather than via this set.
const SPRINT_ENGINE_ACTIVE_TASK_STATUSES: ReadonlySet<SprintEngineTaskStatus> = new Set([
  'in_progress',
  'review',
])

// Canonical "this run is finished" signal: there is at least one task and every
// task is done. The single source of truth for run completion across the
// renderer — the auto-run supervisor's hard completion gate, the backlog run-link
// status, the board run-phase, and the run glyph all read it, so a completed run
// is judged identically everywhere. Lives in this leaf module (depended on by
// projectionRefresh and backlogLinks) so adopting it never reintroduces the
// projectionRefresh↔backlogLinks import cycle. Accepts any task-bearing shape.
export function isCompletedSprintEngineRun(state: Pick<SprintEngineState, 'tasks'>): boolean {
  return state.tasks.length > 0 && state.tasks.every((task) => task.status === 'done')
}

// Canonical "this run was canceled" signal, the sibling to
// `isCompletedSprintEngineRun`. Reads the stored run-level flag (run.yaml
// `sprintengine.canceled`, surfaced by the projection normalizer from
// `run.status === 'canceled'`) rather than deriving cancellation from task
// statuses: a canceled run's non-done tasks are all `canceled`, so a
// completeness rollup would misread it as done. Every consumer that needs a
// "decided, no more effort" read (run glyph, backlog link, inbox suppression)
// shares this one predicate so cancellation is judged identically everywhere.
export function isCanceledSprintEngineRun(state: Pick<SprintEngineState, 'canceled'>): boolean {
  return state.canceled === true
}

/**
 * Whether re-opening a roster agent from the board should resume its recorded
 * session (`sprintEngineRosterSessions[agentId]`) instead of spawning fresh.
 *
 * Two cases record a session and want resume-on-reopen:
 *  1. Whole-run completion teardown (`tearDownCompletedSprintRunAgents`).
 *  2. Mid-run departed-worker teardown (B4, `tearDownDepartedTaskScopedWorker`):
 *     a task-scoped worker whose own task is already `done` is permanently
 *     departed and torn down while the run still executes.
 *
 * The mid-run case is judged from THIS run's roster: the agent must be a current
 * runtime agent whose `lastOwnedTaskId` is a task that is `done` in the current
 * `tasks`. A stale recorded entry left by a *prior* run on the same workspace
 * fails that check (its id has not re-owned a done task this run), so it can
 * never hijack a fresh spawn — the guard the run-complete gate provided is kept.
 * On a cold reopen the projection may not be hydrated yet, so `runComplete`
 * falls back to the persisted lifecycle `runtimeState`.
 */
export function shouldResumeRecordedRosterSession(input: {
  sprintEngineState: SprintEngineState | null | undefined
  autoRuntimeState: SprintEngineAutomationRuntimeState | undefined
  agentId: AgentId
}): boolean {
  const { sprintEngineState, autoRuntimeState, agentId } = input
  const runComplete = sprintEngineState
    ? isCompletedSprintEngineRun(sprintEngineState)
    : autoRuntimeState === 'complete'
  if (runComplete) return true

  const ownedTaskId = sprintEngineState?.sprintEngineAgents?.[agentId]?.lastOwnedTaskId
  if (!ownedTaskId) return false
  return sprintEngineState?.tasks.some((task) => task.id === ownedTaskId && task.status === 'done') ?? false
}

/**
 * Whether re-opening a departed roster id would actually RESUME its recorded
 * conversation rather than start fresh. This is the single source of truth for
 * the roster's Resume-vs-Spawn label and MUST match spawnAgent's real resume
 * gate (`useSprintEngineBoardTerminalActions.ts`): the lifecycle wants resume
 * (`shouldResumeRecordedRosterSession`) AND a recorded session with a
 * `cliSessionId` exists for a CLI that supports conversation resume.
 *
 * The recorded-session gate is load-bearing: `shouldResumeRecordedRosterSession`
 * is broader — it returns true for EVERY non-live id once the run completes — so
 * without this gate an idle/never-recorded id or a resume-incapable CLI would
 * read 'Resume' yet spawn fresh (the inverse of the bug the label split fixes).
 */
export function willResumeRecordedRosterSession(input: {
  sprintEngineState: SprintEngineState | null | undefined
  autoRuntimeState: SprintEngineAutomationRuntimeState | undefined
  recorded: SprintEngineRosterSession | null | undefined
  agentId: AgentId
  // Resume capabilities for `recorded.cli`, resolved by the caller from the
  // plugin catalog (resumeCapabilitiesForCli). Keeps this util catalog-agnostic.
  resumeCapabilities: ResumeCapabilities | undefined
}): boolean {
  const { recorded } = input
  if (!recorded?.cliSessionId || !agentCliSupportsConversationResume(input.resumeCapabilities)) return false
  return shouldResumeRecordedRosterSession({
    sprintEngineState: input.sprintEngineState,
    autoRuntimeState: input.autoRuntimeState,
    agentId: input.agentId,
  })
}

// One run, one glyph, derived purely from sprint state — the task board plus the
// AutoRun runtime. Terminals are deliberately NOT consulted: an agent terminal
// sitting at (or stuck at) a prompt is ephemeral and must never make a whole
// sprint read as "needs input" when no task does. Priority, highest first:
//   1. needs_input — a task awaiting the *human* (kind user), or a blocked
//      runner. The actionable signal; wins even while other tasks run.
//   2. failed — a failed runner.
//   3. paused (runner) — an explicitly paused AutoRun reads as paused even
//      while a task is still mid-flight (e.g. a review in progress), so a
//      stopped run never shows a static (stuck-looking) in_progress spinner.
//      A paused run that has finished every task still falls through to `done`.
//   4. in_progress — any active-column task, or a running runner. `live`
//      (spinner) only when the runner is genuinely `running`; a manual run with
//      active tasks reads in-progress but static (no live runner is asserted).
//   5. done — every task finished, or a `complete` runner.
//   6. paused (rollup) — a started run (≥1 done) with nothing currently running.
//   7. null — not started / no observable run; the surface keeps its own
//      resting rendering (recency text, or the Backlog item's own status).
/**
 * How far a run's branches are through merging, counted across every repo it
 * declared (MC-1613). A run spanning projects delivers one branch per project,
 * so it is only merged when the last one lands — reading the flat
 * `vcs.pullRequestState` would call the whole run merged the moment the primary
 * project's pull request did, while a sibling's branch was still open.
 *
 * Null for a run with no branch to merge (no worktree), which is what separates
 * "Complete" from "Ready for review". A single-repo run reports `total: 1` and
 * rolls up to exactly what the flat field said.
 */
export type SprintEngineRepoMergeRollup = {
  /** Repos the run declared; always ≥ 1 for a worktree run. */
  total: number
  /** Declared repos whose pull request has merged. */
  merged: number
  /** Declared repos still waiting to merge — `total - merged`. */
  unmerged: number
  /** True only when every declared repo's pull request has merged. */
  allMerged: boolean
}

export function deriveSprintEngineRepoMergeRollup(
  vcs: SprintEngineVcs | null | undefined,
): SprintEngineRepoMergeRollup | null {
  if (!vcs) return null
  // The projection normalizes `repos` to a non-empty list, but this also reads a
  // `vcs` restored from persisted workspace state, which can predate the list and
  // carry only the flat fields until the next projection lands. That block IS the
  // one repo such a run has, so it rolls up as a one-entry list rather than
  // reporting "no branch to merge" and downgrading the glyph to plain Complete.
  const repos = Array.isArray(vcs.repos) && vcs.repos.length > 0
    ? vcs.repos
    : [{ pullRequestState: vcs.pullRequestState ?? null }]
  const merged = repos.filter((repo) => repo.pullRequestState === 'merged').length
  return { total: repos.length, merged, unmerged: repos.length - merged, allMerged: merged === repos.length }
}

/**
 * The completion label for a run whose branches have not all merged. A run in one
 * project says only "Ready for review" — there is no second project to count, and
 * a count there would be noise on every single-repo run. A run spanning projects
 * names how many are still out, because "Ready for review" alone hides that some
 * of its branches have already landed.
 */
function sprintEngineAwaitingMergeLabel(rollup: SprintEngineRepoMergeRollup): string {
  if (rollup.total <= 1) return 'Ready for review'
  const noun = rollup.unmerged === 1 ? 'project' : 'projects'
  return `Ready for review · ${rollup.unmerged} ${noun} left to merge`
}

export function deriveSprintEngineRunGlyph(input: {
  sprintEngineState: Pick<SprintEngineState, 'tasks' | 'vcs' | 'canceled'> | null | undefined
  autoState: Partial<SprintEngineAutoState> | null | undefined
}): SprintEngineRunGlyph | null {
  const tasks = input.sprintEngineState?.tasks ?? []
  const runtimeState = input.autoState
    ? normalizeSprintEngineAutomationRuntimeState(
        input.autoState.runtimeState,
        deriveSprintEngineAutomationDesiredMode(input.autoState),
      )
    : null

  // Cancellation is a decided terminal: it outranks needs_input, in-progress,
  // and completion. The stored run flag is authoritative; the terminal
  // `canceled` runtime state covers the window before the projection carries
  // the flag (e.g. a cold reopen reading persisted lifecycle only).
  if (input.sprintEngineState && isCanceledSprintEngineRun(input.sprintEngineState)) {
    return AUTOMATION_RUN_GLYPH.canceled ?? null
  }
  if (runtimeState === 'canceled') return AUTOMATION_RUN_GLYPH.canceled ?? null

  if (input.sprintEngineState && sprintEngineRunAwaitsHumanInput(input.sprintEngineState)) {
    return { state: 'needs_input', live: false, label: 'Needs input' }
  }
  if (runtimeState === 'blocked') return AUTOMATION_RUN_GLYPH.blocked ?? null
  if (runtimeState === 'failed') return AUTOMATION_RUN_GLYPH.failed ?? null

  const hasActiveWork = tasks.some(
    (task) => SPRINT_ENGINE_ACTIVE_TASK_STATUSES.has(task.status) || task.status === 'needs_input',
  )
  if (runtimeState === 'running') return { state: 'in_progress', live: true, label: 'Running' }
  // An explicitly paused runner reads as *paused* even while a task is still
  // mid-flight (e.g. a review in progress). Without this the active-work branch
  // below renders a static `in_progress` arc — a spinner that looks stuck —
  // instead of the pause glyph. A paused run that has actually finished every
  // task still falls through to `done`.
  if (runtimeState === 'paused' && !isCompletedSprintEngineRun({ tasks })) {
    return AUTOMATION_RUN_GLYPH.paused ?? null
  }
  if (hasActiveWork) return { state: 'in_progress', live: false, label: 'In progress' }

  const hasTasks = tasks.length > 0
  if (isCompletedSprintEngineRun({ tasks }) || runtimeState === 'complete') {
    // A worktree run distinguishes merged (filled) from not-yet-merged (outline).
    // A run with no worktree has no branch to merge, so it stays the plain filled
    // "Complete" — never a permanent "unmerged" badge.
    // Vocabulary matches the run-summary verdict: a worktree run is "Ready for
    // review" until its PR merges, then "Complete"; a non-worktree run is
    // "Complete" the moment work is done.
    //
    // Every declared repo counts (MC-1613): a run spanning projects has one branch
    // per project and stays "Ready for review" until the last one merges.
    const rollup = deriveSprintEngineRepoMergeRollup(input.sprintEngineState?.vcs)
    if (rollup && !rollup.allMerged) {
      return { state: 'done_unmerged', live: false, label: sprintEngineAwaitingMergeLabel(rollup) }
    }
    // A merged worktree run gets the git-merge mark in merged-purple (GitHub's
    // merged-PR idiom). A non-worktree run has no branch to merge, so it stays
    // the plain green `done` check.
    if (rollup) {
      return { state: 'done_merged', live: false, label: 'Merged' }
    }
    return { state: 'done', live: false, label: 'Complete' }
  }

  if (hasTasks && tasks.some((task) => task.status === 'done')) {
    return { state: 'paused', live: false, label: 'Paused' }
  }

  return null
}

export type SprintEngineAgentRosterItem = {
  id: AgentId
  label: string
  role: SprintEngineRoleId
}

// A roster role is "new to the run" only when no current member and no
// not-yet-reconciled pending spawn already covers it. Adding more members of a
// role the team already has is reinforcement for the existing task graph, so it
// should not trigger an architect plan-revision prompt — only a genuinely new
// specialist can change what work the plan needs. Pending roles are included so
// rapid repeat adds of the same role stay quiet before the projection refresh.
export function isNewSprintEngineRoleForRun(input: {
  role: SprintEngineRoleId
  roster: readonly SprintEngineAgentRosterItem[]
  pendingRoles?: readonly SprintEngineRoleId[]
}): boolean {
  const { role, roster, pendingRoles = [] } = input
  if (roster.some((member) => member.role === role)) return false
  if (pendingRoles.some((pending) => pending === role)) return false
  return true
}

export const sprintEngineTaskStateLabel: Record<SprintEngineTaskStatus, string> = {
  todo: 'Todo',
  in_progress: 'In Progress',
  review: 'In Review',
  needs_input: 'Needs Input',
  done: 'Done',
  canceled: 'Canceled',
}

export const sprintEngineTaskCommentTypeLabels: Record<SprintEngineTaskCommentType, string> = {
  implementation_summary: 'Implementation Summary',
  implementation_response: 'Implementation Response',
  review_feedback: 'Review Feedback',
  test_feedback: 'Test Feedback',
  product_feedback: 'Product Feedback',
  architect_feedback: 'Architect Feedback',
  needs_input: 'Needs Input',
  user_note: 'User Note',
  system_note: 'System Note',
}

// Bundled-role label table. Renderer surfaces must NEVER index this with a
// raw `SprintEngineRoleId` from projection or registry data — use
// `getSprintEngineRoleLabel(roleId, metadata?)` so custom and unknown
// configured roles fall back to a registry label or a safe humanized id.
export const sprintEngineRoleLabels: Record<SprintEngineRole, string> = {
  architect: 'Architect',
  product: 'Product Strategist',
  developer: 'Developer',
  frontend: 'Frontend Engineer',
  ui_ux_reviewer: 'UI/UX Reviewer',
  tester: 'Tester',
  security: 'Security Specialist',
  performance: 'Performance Engineer',
  production_readiness_reviewer: 'Production Readiness Reviewer',
  cross_platform: 'Cross-platform Specialist',
}

/**
 * Kanban column ordering and labels. Shared between the kanban view (orchestrator)
 * and the inspector's task-status icon so both surfaces use the same vocabulary.
 */
export const sprintEngineTaskBoardColumns: { key: SprintEngineTaskBoardColumn; label: string }[] = [
  { key: 'todo', label: 'Todo' },
  { key: 'ready', label: 'Ready' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'review', label: 'In Review' },
  { key: 'needs_input', label: 'Needs Input' },
  { key: 'done', label: 'Done' },
]

/**
 * Post-implementation phases a task's single owner walks after `task.publish`
 * (MC-1542). MIRRORS `VALID_TASK_PHASES` in sprintengine_core/store.py and
 * sprintengine_core/tool/constants.py — `tests/sprintengine_tool/test_phases.py`
 * pins all three equal, because status/phase enum drift across the TS/Python
 * boundary is this subsystem's known bug class.
 */
export const sprintEngineTaskPhases = ['review'] as const satisfies readonly SprintEngineTaskPhase[]

/** The run's phase list when `run.defaultPhases` is absent. */
export const sprintEngineDefaultRunPhases: readonly SprintEngineTaskPhase[] = ['review']

/** The phases a task actually walks: its own list when set, else the run's. */
export function resolveSprintEngineTaskPhases(
  task: Pick<SprintEngineTask, 'phases'>,
  run: Pick<SprintEngineState, 'defaultPhases'>
): readonly SprintEngineTaskPhase[] {
  if (task.phases) return task.phases
  return run.defaultPhases ?? sprintEngineDefaultRunPhases
}

function isSprintEngineTaskCommentType(value: unknown): value is SprintEngineTaskCommentType {
  return (
    value === 'implementation_summary'
    || value === 'implementation_response'
    || value === 'review_feedback'
    || value === 'test_feedback'
    || value === 'product_feedback'
    || value === 'architect_feedback'
    || value === 'needs_input'
    || value === 'user_note'
    || value === 'system_note'
  )
}

// Bundled-role accent table. Renderer surfaces must NEVER index this with a
// raw `SprintEngineRoleId` — use `getSprintEngineRoleAccent` so custom roles
// fall back to a neutral chrome tone.
export const sprintEngineRoleAccent: Record<SprintEngineRole, string> = {
  architect: '#d4a757',
  product: '#e879a7',
  developer: '#c7ccd4',
  frontend: '#39d7ff',
  ui_ux_reviewer: '#8bdbca',
  tester: '#3dff8f',
  security: '#ff6b6b',
  performance: '#a78bfa',
  production_readiness_reviewer: '#38bdf8',
  cross_platform: '#14b8a6',
}

// Neutral accent used when an extensible role has no registry icon/colour
// metadata. Pulled into a constant so safe accessors and primitives share
// the same fallback tone instead of inventing one per call site.
export const sprintEngineNeutralRoleAccent = '#7a8190'

// Maps a SpecialistAction.soulRole string to the canonical bundled
// SprintEngineRole so Watchtower (and any other panel showing specialists)
// can render the same icon disc + role accent + role label that Sprint
// Engine uses. This mapping is intentionally scoped to non-registry
// specialist compatibility: it converts a fixed-set Watchtower specialist
// identifier into a bundled Sprint Engine role for icon/accent reuse and
// must not be used to coerce registry-discovered role ids. Returns null
// for specialists with no bundled Sprint Engine equivalent (devops,
// blog_writer); callers should fall back to the specialist's own icon and
// short label.
const SOUL_ROLE_TO_SPRINT_ENGINE_ROLE: Record<string, SprintEngineRole> = {
  architect: 'architect',
  product: 'product',
  developer: 'developer',
  frontend: 'frontend',
  ui_ux_reviewer: 'ui_ux_reviewer',
  tester: 'tester',
  security: 'security',
  performance: 'performance',
  production_readiness_reviewer: 'production_readiness_reviewer',
  cross_platform: 'cross_platform',
}

export function soulRoleToSprintEngineRole(soulRole: string): SprintEngineRole | null {
  return SOUL_ROLE_TO_SPRINT_ENGINE_ROLE[soulRole] ?? null
}

export const sprintEngineArtifactKindLabels: Record<SprintEngineArtifactKind, string> = {
  architect_plan: 'Architect Plan',
  product_strategy: 'Product Strategy',
  requirements: 'Requirements',
  html_mockup: 'HTML Mockup',
  design_notes: 'Design Notes',
  branding: 'Branding',
  security_review: 'Security Review',
  code_review: 'Code Review',
  spec_review: 'Spec Review',
  performance_review: 'Performance Review',
  production_readiness_review: 'Production Readiness Review',
  cross_platform_review: 'Cross-platform Review',
  validation_report: 'Validation Report',
}

export function sprintEngineArtifactKindLabel(kind: string): string {
  return kind in sprintEngineArtifactKindLabels
    ? sprintEngineArtifactKindLabels[kind as SprintEngineArtifactKind]
    : kind
}

// Plain-human, sentence-case status vocabulary (no Title-Case chrome). Row and
// detail surfaces read from this one map so their words can't drift.
export const sprintEngineArtifactStatusLabels: Record<SprintEngineArtifactStatus, string> = {
  draft: 'Draft',
  recorded: 'Recorded',
  ready_for_review: 'Ready for review',
  approved: 'Approved',
  changes_requested: 'Changes requested',
  superseded: 'Superseded',
}

export const sprintEngineRoleOrder: SprintEngineRole[] = [
  'architect',
  'product',
  'frontend',
  'ui_ux_reviewer',
  'developer',
  'performance',
  'production_readiness_reviewer',
  'cross_platform',
  'tester',
  'security',
]

// Architect is the minimum role Sprint Engine planning depends on. Treat it
// as an always-enabled member of any roster so a stale or hostile user
// setting cannot strand a new workspace without a planner.
export const protectedSprintEngineRoleId: SprintEngineRoleId = 'architect'

// Settings.role enablement is a future-roster filter, never a runtime
// dispatch policy. Returns the role ids the user has explicitly turned off,
// excluding `architect` which cannot be disabled.
export function getUserDisabledSprintEngineRoleIds(
  settings: SprintEngineRoleSettings | null | undefined,
): ReadonlySet<SprintEngineRoleId> {
  const disabled = new Set<SprintEngineRoleId>()
  const entries = settings?.enabled
  if (!entries || typeof entries !== 'object') return disabled
  for (const [roleId, enabled] of Object.entries(entries)) {
    if (enabled !== false) continue
    if (roleId === protectedSprintEngineRoleId) continue
    if (!normalizeSprintEngineRoleId(roleId)) continue
    disabled.add(roleId)
  }
  return disabled
}

// Build the ordered, selectable Sprint Engine role list shared by the new
// workspace roster table and the guided-brief handoff roster. Bundled roles
// come first (in their canonical order), custom registry roles follow
// alphabetically. Manifest-disabled registry roles and user-disabled roles
// are filtered out; `architect` always remains.
export function orderSprintEngineRosterRoles(
  registry?: SprintEngineRoleRegistry | null,
  disabledRoleIds?: ReadonlySet<SprintEngineRoleId> | null,
): SprintEngineRoleId[] {
  const disabled = disabledRoleIds ?? new Set<SprintEngineRoleId>()
  const ids = new Set<SprintEngineRoleId>()
  for (const role of sprintEngineRoleOrder) {
    if (role !== protectedSprintEngineRoleId && disabled.has(role)) continue
    ids.add(role)
  }
  for (const role of Object.values(registry?.roles ?? {}) as SprintEngineRoleRegistryMetadata[]) {
    if (role.enabled === false) continue
    if (role.id !== protectedSprintEngineRoleId && disabled.has(role.id)) continue
    ids.add(role.id)
  }
  return [...ids].sort((a, b) => {
    const aBundled = sprintEngineRoleOrder.indexOf(a as SprintEngineRole)
    const bBundled = sprintEngineRoleOrder.indexOf(b as SprintEngineRole)
    const aRank = aBundled >= 0 ? aBundled : sprintEngineRoleOrder.length
    const bRank = bBundled >= 0 ? bBundled : sprintEngineRoleOrder.length
    if (aRank !== bRank) return aRank - bRank
    return getSprintEngineRoleLabel(a, registry).localeCompare(getSprintEngineRoleLabel(b, registry))
  })
}

// Zero out counts for user-disabled roles before workspace creation so a
// stale local count from a prior selection cannot leak a disabled role into
// the new roster. Architect is preserved.
export function applyUserDisabledSprintEngineRoleCounts(
  roleCounts: SprintEngineRoleCounts,
  disabledRoleIds: ReadonlySet<SprintEngineRoleId>,
): SprintEngineRoleCounts {
  if (!disabledRoleIds.size) return roleCounts
  let mutated = false
  let next: SprintEngineRoleCounts | null = null
  for (const roleId of disabledRoleIds) {
    if ((roleCounts[roleId] ?? 0) <= 0) continue
    if (!next) next = { ...roleCounts }
    next[roleId] = 0
    mutated = true
  }
  return mutated && next ? next : roleCounts
}

const sprintEngineArtifactStatuses: readonly SprintEngineArtifactStatus[] = [
  'draft',
  'recorded',
  'ready_for_review',
  'approved',
  'changes_requested',
  'superseded',
]

const sprintEngineArtifactApprovalModes: readonly SprintEngineArtifactApprovalMode[] = ['manual', 'policy']

function isSprintEngineArtifactApprovalMode(value: unknown): value is SprintEngineArtifactApprovalMode {
  return sprintEngineArtifactApprovalModes.includes(value as SprintEngineArtifactApprovalMode)
}

const feedbackIssueCategories: readonly SprintEngineTaskFeedbackIssueCategory[] = [
  'system_prompt',
  'role_prompt',
  'task_card',
  'acceptance_criteria',
  'context',
  'tooling',
  'coordination',
  'validation',
  'permissions',
  'ui',
  'other',
]

const feedbackIssueSeverities: readonly SprintEngineTaskFeedbackIssueSeverity[] = ['low', 'medium', 'high']
const feedbackIssueStatuses: readonly SprintEngineTaskFeedbackIssueStatus[] = ['new', 'reviewed', 'applied', 'rejected', 'deferred']
const feedbackFindingKinds: readonly SprintEngineTaskFeedbackFindingKind[] = [
  'code_bug',
  'security_issue',
  'product_requirement_violation',
  'test_gap',
  'accessibility_issue',
  'performance_issue',
  'reliability_issue',
  'documentation_gap',
  'other',
]
const feedbackFindingSeverities: readonly SprintEngineTaskFeedbackFindingSeverity[] = ['critical', 'high', 'medium', 'low']
const feedbackFindingAreas: readonly SprintEngineTaskFeedbackFindingArea[] = [
  'frontend',
  'backend',
  'database',
  'networking',
  'auth',
  'security',
  'filesystem',
  'cli',
  'ipc',
  'mobile',
  'testing',
  'performance',
  'docs',
  'product',
  'other',
]
const feedbackFindingStatuses: readonly SprintEngineTaskFeedbackFindingStatus[] = ['open', 'accepted', 'fixed', 'rejected', 'deferred']
const sprintEngineTaskSourceTypes: readonly SprintEngineTaskSourceType[] = ['local', 'github', 'jira', 'linear']
const sprintEngineTaskSourceSyncStatuses: readonly SprintEngineTaskSourceSyncStatus[] = ['clean', 'local_changed', 'remote_changed', 'conflict']
const sprintEngineNeedsInputKinds: readonly SprintEngineNeedsInputKind[] = ['architect', 'user']

const sprintEngineTaskActivityTypes: readonly SprintEngineTaskActivityType[] = [
  'comment',
  'status_change',
  'claim',
  'evidence',
  'feedback',
  'needs_input',
  'artifact',
  'system',
]

const sprintEngineTaskBoardColumnSet: readonly SprintEngineTaskBoardColumn[] = [
  'todo',
  'ready',
  'in_progress',
  'review',
  'needs_input',
  'done',
  'canceled',
]

export const sprintEngineTaskActivityLabels: Record<SprintEngineTaskActivityType, string> = {
  comment: 'Comment',
  status_change: 'Status',
  claim: 'Claim',
  evidence: 'Evidence',
  feedback: 'Feedback',
  needs_input: 'Needs Input',
  artifact: 'Artifact',
  system: 'System',
}

function isSprintEngineTaskActivityType(value: unknown): value is SprintEngineTaskActivityType {
  return sprintEngineTaskActivityTypes.includes(value as SprintEngineTaskActivityType)
}

function isSprintEngineTaskBoardColumn(value: unknown): value is SprintEngineTaskBoardColumn {
  return sprintEngineTaskBoardColumnSet.includes(value as SprintEngineTaskBoardColumn)
}

// Only the materialized ready queue is claimable. A task in `review` is owned by
// its implementer through `done`, so it is never free work.
export function isSprintEngineTaskClaimableColumn(column: SprintEngineTaskBoardColumn | null | undefined): boolean {
  return column === 'ready'
}

export function isSprintEngineTaskLaunchable(task: SprintEngineTask, sprintEngineState: SprintEngineState): boolean {
  return !task.ownerAgentId && isSprintEngineTaskClaimableColumn(getSprintEngineTaskBoardColumn(task, sprintEngineState.tasks))
}

// Typed against plain strings because artifact.kind tolerates unknown values
// from stores written by other Sprint Engine versions; unknown kinds are
// simply never review-gated or auto-approvable.
const reviewGateArtifactKinds: ReadonlySet<string> = new Set([
  'architect_plan',
  'product_strategy',
  'requirements',
  'html_mockup',
  'design_notes',
  'branding',
  'security_review',
  'code_review',
  'spec_review',
  'performance_review',
  'production_readiness_review',
  'cross_platform_review',
  'validation_report',
])

const sprintEngineTaskDiffStatuses = new Set<SprintEngineTaskDiffStatus>([
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'type_changed',
  'unmerged',
  'unknown',
])

const sprintEngineTaskDiffSources = new Set<SprintEngineTaskDiffSource>([
  'working_tree',
  'staged',
  'commit',
  'checkpoint',
])

export type SprintEngineArtifactDependencyBlocker = {
  taskId: string
  title: string
  artifacts: SprintEngineArtifact[]
}

export type SprintEngineArtifactAutoApprovalEligibility = {
  eligible: boolean
  label: string
  reason: string | null
}

function emptyEvidence(summary = ''): SprintEngineTaskEvidence {
  return { summary, touchedFiles: [], commandsRan: [], results: [] }
}

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => typeof item === 'string' && item.trim() ? [item.trim()] : [])
    : []
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function nullableLineNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null
}

function normalizeSprintEngineTaskDiffLines(value: unknown): SprintEngineTaskDiffLine[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 2500).flatMap((line): SprintEngineTaskDiffLine[] => {
    if (!line || typeof line !== 'object') return []
    const record = line as Record<string, unknown>
    const type = record.type === 'added' || record.type === 'removed' || record.type === 'context'
      ? record.type
      : null
    if (!type || typeof record.content !== 'string') return []
    return [{
      type,
      oldLine: nullableLineNumber(record.oldLine),
      newLine: nullableLineNumber(record.newLine),
      content: record.content,
    }]
  })
}

function normalizeSprintEngineTaskDiffHunks(value: unknown): SprintEngineTaskDiff['hunks'] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 100).flatMap((hunk): SprintEngineTaskDiff['hunks'] => {
    if (!hunk || typeof hunk !== 'object') return []
    const record = hunk as Record<string, unknown>
    return [{
      oldStart: nonNegativeInteger(record.oldStart),
      oldLines: nonNegativeInteger(record.oldLines),
      newStart: nonNegativeInteger(record.newStart),
      newLines: nonNegativeInteger(record.newLines),
      ...(optionalTrimmedString(record.section) ? { section: optionalTrimmedString(record.section)! } : {}),
      lines: normalizeSprintEngineTaskDiffLines(record.lines),
    }]
  })
}

function normalizeSprintEngineTaskDiffs(value: unknown): SprintEngineTaskDiff[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 50).flatMap((diff): SprintEngineTaskDiff[] => {
    if (!diff || typeof diff !== 'object') return []
    const record = diff as Record<string, unknown>
    const path = optionalTrimmedString(record.path)
    if (!path) return []
    const status = sprintEngineTaskDiffStatuses.has(record.status as SprintEngineTaskDiffStatus)
      ? record.status as SprintEngineTaskDiffStatus
      : 'unknown'
    const source = sprintEngineTaskDiffSources.has(record.source as SprintEngineTaskDiffSource)
      ? record.source as SprintEngineTaskDiffSource
      : 'working_tree'
    return [{
      path,
      ...(optionalTrimmedString(record.oldPath) ? { oldPath: optionalTrimmedString(record.oldPath)! } : {}),
      status,
      additions: nonNegativeInteger(record.additions),
      deletions: nonNegativeInteger(record.deletions),
      capturedAt: optionalTrimmedString(record.capturedAt) ?? '',
      capturedBy: optionalTrimmedString(record.capturedBy) ?? '',
      source,
      binary: record.binary === true,
      truncated: record.truncated === true,
      ...(optionalTrimmedString(record.skippedReason) ? { skippedReason: optionalTrimmedString(record.skippedReason)! } : {}),
      hunks: normalizeSprintEngineTaskDiffHunks(record.hunks),
    }]
  })
}

function normalizeSprintEngineTaskEvidence(value: unknown): SprintEngineTaskEvidence {
  if (!value || typeof value !== 'object') return emptyEvidence()
  const record = value as Record<string, unknown>
  const diffs = normalizeSprintEngineTaskDiffs(record.diffs)
  return {
    summary: typeof record.summary === 'string' ? record.summary : '',
    touchedFiles: normalizeStringList(record.touchedFiles),
    commandsRan: normalizeStringList(record.commandsRan),
    results: normalizeStringList(record.results),
    ...(diffs.length > 0 ? { diffs } : {}),
  }
}

function isSprintEngineRole(value: unknown): value is SprintEngineRole {
  return (
    value === 'architect'
    || value === 'product'
    || value === 'developer'
    || value === 'frontend'
    || value === 'ui_ux_reviewer'
    || value === 'tester'
    || value === 'security'
    || value === 'performance'
    || value === 'production_readiness_reviewer'
    || value === 'cross_platform'
  )
}

// Predicate for any registry-keyed role id. Preserves custom configured
// roles through projection normalization; bundled roles are still accepted.
export function isSprintEngineRoleId(value: unknown): value is SprintEngineRoleId {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeSprintEngineRoleId(value: unknown): SprintEngineRoleId | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function isBundledSprintEngineRole(value: SprintEngineRoleId | null | undefined): value is SprintEngineRole {
  return isSprintEngineRole(value)
}

// Convert a registry role id like `marketer` or `growth_engineer` to a safe
// display label when no registry metadata is available. Underscores and
// hyphens become spaces; segments are title-cased. Bundled roles always
// resolve via `sprintEngineRoleLabels`, so this only ever runs for unknown
// configured ids.
export function humanizeSprintEngineRoleId(roleId: SprintEngineRoleId): string {
  const cleaned = roleId.trim().replace(/[_-]+/g, ' ').trim()
  if (!cleaned) return roleId
  return cleaned
    .split(/\s+/)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

export function getSprintEngineRoleLabel(
  roleId: SprintEngineRoleId | null | undefined,
  metadata?: SprintEngineRoleRegistryMetadata | SprintEngineRoleRegistry | null,
): string {
  const normalized = normalizeSprintEngineRoleId(roleId)
  if (!normalized) return 'Unknown role'
  const fromRegistry = resolveRoleRegistryMetadata(normalized, metadata)
  if (fromRegistry?.label && fromRegistry.label.trim()) return fromRegistry.label.trim()
  if (isSprintEngineRole(normalized)) return sprintEngineRoleLabels[normalized]
  // Alias lookup: when the registry directory was passed and contains an
  // alias that resolves the id, prefer that label.
  return humanizeSprintEngineRoleId(normalized)
}

export function getSprintEngineRoleAccent(
  roleId: SprintEngineRoleId | null | undefined,
  metadata?: SprintEngineRoleRegistryMetadata | SprintEngineRoleRegistry | null,
): string {
  const normalized = normalizeSprintEngineRoleId(roleId)
  if (!normalized) return sprintEngineNeutralRoleAccent
  if (isSprintEngineRole(normalized)) return sprintEngineRoleAccent[normalized]
  // Registry metadata does not currently emit an accent colour; we keep the
  // neutral fallback until the registry contract grows that field rather
  // than fabricating tones per id.
  resolveRoleRegistryMetadata(normalized, metadata)
  return sprintEngineNeutralRoleAccent
}

// Bundled glyph kinds the renderer ships SVGs for. Extensible roles fall
// back to the neutral glyph below; registry metadata may eventually carry
// its own icon kind, but the renderer only ships a fixed sprite sheet today.
export type SprintEngineRoleGlyphKind =
  | 'architect'
  | 'product'
  | 'developer'
  | 'frontend'
  | 'ui_ux_reviewer'
  | 'tester'
  | 'security'
  | 'performance'
  | 'production_readiness_reviewer'
  | 'cross_platform'
  | 'unknown'

export function getSprintEngineRoleGlyphKind(
  roleId: SprintEngineRoleId | null | undefined,
  metadata?: SprintEngineRoleRegistryMetadata | SprintEngineRoleRegistry | null,
): SprintEngineRoleGlyphKind {
  const normalized = normalizeSprintEngineRoleId(roleId)
  if (!normalized) return 'unknown'
  if (isSprintEngineRole(normalized)) return normalized
  const fromRegistry = resolveRoleRegistryMetadata(normalized, metadata)
  const icon = fromRegistry?.icon?.trim()
  if (icon && isSprintEngineRole(icon)) return icon
  return 'unknown'
}

function resolveRoleRegistryMetadata(
  roleId: SprintEngineRoleId,
  source: SprintEngineRoleRegistryMetadata | SprintEngineRoleRegistry | null | undefined,
): SprintEngineRoleRegistryMetadata | undefined {
  if (!source) return undefined
  if (isSprintEngineRoleRegistry(source)) {
    const direct = source.roles[roleId]
    if (direct) return direct
    const aliasTarget = source.aliases?.[roleId]
    if (aliasTarget) return source.roles[aliasTarget]
    return undefined
  }
  if (source.id === roleId) return source
  return undefined
}

function isSprintEngineRoleRegistry(
  value: SprintEngineRoleRegistryMetadata | SprintEngineRoleRegistry,
): value is SprintEngineRoleRegistry {
  return Object.prototype.hasOwnProperty.call(value, 'roles')
}

function isSprintEngineRoleRegistrySourceLayer(value: unknown): value is SprintEngineRoleRegistrySourceLayer {
  return typeof value === 'string' && value.length > 0
}

function normalizeSprintEngineRoleRegistryWarning(raw: unknown): SprintEngineRoleRegistryWarning | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const code = optionalTrimmedString(record.code)
  const message = optionalTrimmedString(record.message)
  if (!code || !message) return undefined
  const roleId = optionalTrimmedString(record.roleId)
  const sourceLayer = optionalTrimmedString(record.sourceLayer)
  return {
    code,
    message,
    ...(roleId ? { roleId } : {}),
    ...(sourceLayer ? { sourceLayer } : {}),
  }
}

function normalizeSprintEngineRoleRegistryMetadata(raw: unknown): SprintEngineRoleRegistryMetadata | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const id = normalizeSprintEngineRoleId(record.id)
  if (!id) return undefined
  const label = optionalTrimmedString(record.label) ?? humanizeSprintEngineRoleId(id)
  const aliases = Array.isArray(record.aliases)
    ? record.aliases.flatMap((alias) => {
        const normalized = normalizeSprintEngineRoleId(alias)
        return normalized ? [normalized] : []
      })
    : []
  const summary = typeof record.summary === 'string' && record.summary.trim()
    ? record.summary.trim()
    : record.summary === null
      ? null
      : undefined
  const icon = typeof record.icon === 'string' && record.icon.trim()
    ? record.icon.trim()
    : record.icon === null
      ? null
      : undefined
  const sourceRecord = record.source && typeof record.source === 'object'
    ? record.source as Record<string, unknown>
    : null
  const layer = isSprintEngineRoleRegistrySourceLayer(sourceRecord?.layer)
    ? sourceRecord!.layer
    : 'bundled'
  const shadowedSources = Array.isArray(record.shadowedSources)
    ? record.shadowedSources.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return []
        const entryRecord = entry as Record<string, unknown>
        return isSprintEngineRoleRegistrySourceLayer(entryRecord.layer)
          ? [{ layer: entryRecord.layer }]
          : []
      })
    : []
  const warnings = Array.isArray(record.warnings)
    ? record.warnings.flatMap((entry) => {
        const normalized = normalizeSprintEngineRoleRegistryWarning(entry)
        return normalized ? [normalized] : []
      })
    : []
  const enabled = typeof record.enabled === 'boolean' ? record.enabled : undefined
  // A role is a sweep when its manifest carries a (non-null) `sweep` block.
  const isSweep = record.sweep != null && typeof record.sweep === 'object'
  return {
    id,
    label,
    aliases,
    ...(summary !== undefined ? { summary } : {}),
    ...(icon !== undefined ? { icon } : {}),
    source: { layer },
    ...(shadowedSources.length > 0 ? { shadowedSources } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(isSweep ? { isSweep } : {}),
  }
}

// Build a renderer-side role registry directory from the
// `sprintengine.roles.list` MCP response. Unknown or malformed entries are
// dropped; warnings the registry surfaced are preserved so the Settings
// Roles tab and inspector can show source-layer / shadowing diagnostics.
export function buildSprintEngineRoleRegistry(payload: unknown): SprintEngineRoleRegistry {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const rolesRaw = Array.isArray(record.roles) ? record.roles : []
  const roles: Record<SprintEngineRoleId, SprintEngineRoleRegistryMetadata> = {}
  for (const entry of rolesRaw) {
    const normalized = normalizeSprintEngineRoleRegistryMetadata(entry)
    if (!normalized) continue
    roles[normalized.id] = normalized
  }
  const aliasesRaw = record.aliases && typeof record.aliases === 'object'
    ? record.aliases as Record<string, unknown>
    : {}
  const aliases: Record<string, SprintEngineRoleId> = {}
  for (const [aliasKey, target] of Object.entries(aliasesRaw)) {
    const aliasId = normalizeSprintEngineRoleId(aliasKey)
    const targetId = normalizeSprintEngineRoleId(target)
    if (!aliasId || !targetId || !roles[targetId]) continue
    aliases[aliasId] = targetId
  }
  const warningsRaw = Array.isArray(record.warnings) ? record.warnings : []
  const warnings: SprintEngineRoleRegistryWarning[] = []
  for (const entry of warningsRaw) {
    const normalized = normalizeSprintEngineRoleRegistryWarning(entry)
    if (normalized) warnings.push(normalized)
  }
  return { roles, aliases, warnings }
}

function isSprintEngineArtifactStatus(value: unknown): value is SprintEngineArtifactStatus {
  return sprintEngineArtifactStatuses.includes(value as SprintEngineArtifactStatus)
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function percentOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100
    ? value
    : undefined
}

function normalizeSprintEngineTaskActivity(input: unknown): SprintEngineTaskActivityEntry[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((entry, index): SprintEngineTaskActivityEntry[] => {
    if (!entry || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    const type = record.type
    const timestamp = stringOrNull(record.timestamp)?.trim()
    if (!isSprintEngineTaskActivityType(type) || !timestamp) return []
    const message = typeof record.message === 'string' ? record.message : ''
    const id = stringOrNull(record.id)?.trim() || `activity-${index + 1}`
    const actor = stringOrNull(record.actor)?.trim() || 'unknown'
    const status = optionalTrimmedString(record.status)
    const artifactId = optionalTrimmedString(record.artifactId)
    const artifactStatus = optionalTrimmedString(record.artifactStatus)
    return [{
      id,
      timestamp,
      type,
      actor,
      message,
      ...(status ? { status } : {}),
      ...(artifactId ? { artifactId } : {}),
      ...(artifactStatus ? { artifactStatus } : {}),
    }]
  })
}

function normalizeSprintEngineTaskComments(input: unknown): SprintEngineTaskComment[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((comment, index): SprintEngineTaskComment[] => {
    if (!comment || typeof comment !== 'object') return []
    const record = comment as Record<string, unknown>
    const body = stringOrNull(record.body)?.trim()
    if (!body) return []
    const source = record.source === 'agent' || record.source === 'system' ? record.source : 'user'
    const type = isSprintEngineTaskCommentType(record.type) ? record.type : undefined
    const authorAgentId = optionalTrimmedString(record.authorAgentId)
    // Preserve any registry-keyed role id (bundled or custom) so comments
    // authored by a custom-role agent like `marketer` keep their attribution
    // through projection normalization. Empty strings are still dropped.
    const authorRole = normalizeSprintEngineRoleId(record.authorRole)
    const paths = stringArray(record.paths)
    const data = record.data && typeof record.data === 'object'
      ? (record.data as Record<string, unknown>)
      : undefined
    return [{
      id: stringOrNull(record.id) ?? `comment-${index + 1}`,
      actor: stringOrNull(record.actor) ?? 'user',
      source,
      body,
      createdAt: stringOrNull(record.createdAt) ?? '',
      ...(type ? { type } : {}),
      ...(authorAgentId ? { authorAgentId } : {}),
      ...(authorRole ? { authorRole } : {}),
      ...(paths.length > 0 ? { paths } : {}),
      ...(data ? { data } : {}),
    }]
  })
}

function normalizeSprintEngineRecordedArtifacts(input: unknown): SprintEngineRecordedArtifact[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((artifact, index): SprintEngineRecordedArtifact[] => {
    if (!artifact || typeof artifact !== 'object') return []
    const record = artifact as Record<string, unknown>
    const id = optionalTrimmedString(record.id) ?? `recorded-${index + 1}`
    return [{
      id,
      ...(optionalTrimmedString(record.kind) ? { kind: optionalTrimmedString(record.kind)! } : {}),
      ...(optionalTrimmedString(record.title) ? { title: optionalTrimmedString(record.title)! } : {}),
      ...(optionalTrimmedString(record.path) ? { path: optionalTrimmedString(record.path)! } : {}),
      ...(optionalTrimmedString(record.createdBy) ? { createdBy: optionalTrimmedString(record.createdBy)! } : {}),
      ...(optionalTrimmedString(record.createdAt) ? { createdAt: optionalTrimmedString(record.createdAt)! } : {}),
    }]
  })
}

function positiveNumberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : fallback
}

function normalizeSprintEngineRunnerPolicy(input: unknown): SprintEngineRunnerPolicy | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  // Field rename: legacy `runner.mode` (`auto|off`) → `runner.cliWatchPolling`
  // (`enabled|disabled`). Read both for backward compatibility; the Python
  // normalizer also accepts both shapes so projections from older state files
  // still resolve correctly.
  const explicit = record.cliWatchPolling
  const cliWatchPolling = explicit === 'enabled' || explicit === 'disabled'
    ? explicit
    : record.mode === 'auto'
      ? 'enabled'
      : 'disabled'
  return {
    cliWatchPolling,
    pollIntervalSeconds: positiveNumberOrDefault(record.pollIntervalSeconds, 10),
    idleBackoffSeconds: positiveNumberOrDefault(record.idleBackoffSeconds, 30),
    maxBackoffSeconds: positiveNumberOrDefault(record.maxBackoffSeconds, 120),
    stopWhenComplete: record.stopWhenComplete !== false,
  }
}

// Entry zero of `vcs.repos` is the primary repo: the workspace itself, hence `.`.
// Mirrors PRIMARY_REPO_ID / PRIMARY_REPO_ROOT in sprintengine_core/tool/shell.py.
const primaryRepoId = 'primary'
const primaryRepoRoot = '.'

function normalizeSprintEnginePullRequestState(value: unknown): SprintEnginePullRequestState {
  return value === 'open' || value === 'merged' || value === 'closed' ? value : null
}

function normalizeSprintEngineVcsRepo(input: unknown): SprintEngineVcsRepo | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  const id = optionalTrimmedString(record.id)
  const root = optionalTrimmedString(record.root)
  const worktreePath = optionalTrimmedString(record.worktreePath)
  const branchName = optionalTrimmedString(record.branchName)
  // A repo the app cannot resolve a tree for is worse than no entry: its scope would
  // silently point at the wrong worktree. Drop it and keep the repos it can resolve.
  if (!id || !root || !worktreePath || !branchName) return undefined
  return {
    id,
    root,
    worktreePath,
    branchName,
    ...(optionalTrimmedString(record.baseRef) ? { baseRef: optionalTrimmedString(record.baseRef) } : {}),
    ...(optionalTrimmedString(record.status) ? { status: optionalTrimmedString(record.status) } : {}),
    lastCommitSha: typeof record.lastCommitSha === 'string' ? record.lastCommitSha : null,
    pullRequestUrl: typeof record.pullRequestUrl === 'string' ? record.pullRequestUrl : null,
    pullRequestError: typeof record.pullRequestError === 'string' ? record.pullRequestError : null,
    pullRequestState: normalizeSprintEnginePullRequestState(record.pullRequestState),
  }
}

/**
 * The run's declared repos, from either shape the store may carry. `repos` is
 * explicitly whitelisted here (and typed field-by-field) because sync drops what
 * this normalizer does not name — the `normalizeResponse` precedent — so an
 * unlisted field would vanish between the engine and the app.
 */
function normalizeSprintEngineVcsRepos(record: Record<string, unknown>, primary: SprintEngineVcsRepo): SprintEngineVcsRepo[] {
  const declared = Array.isArray(record.repos)
    ? record.repos.map(normalizeSprintEngineVcsRepo).filter((repo): repo is SprintEngineVcsRepo => Boolean(repo))
    : []
  // A run stored before `vcs.repos` existed (MC-1611) describes its one repo with
  // the flat fields; it reads back as the one-entry list it always semantically was.
  return declared.length > 0 ? declared : [primary]
}

function normalizeSprintEngineVcs(input: unknown): SprintEngineVcs | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  if (record.mode !== 'run_worktree') return undefined
  // The flat block IS the primary repo in the other shape: same key names, same
  // values, only `id`/`root` implied. Deriving entry zero from it means one field
  // mapping serves both shapes and they cannot drift apart as the entry grows.
  const primary = normalizeSprintEngineVcsRepo({ ...record, id: primaryRepoId, root: primaryRepoRoot })
  // No worktree path or branch: not a run this app can resolve a tree for.
  if (!primary) return undefined
  return {
    mode: 'run_worktree',
    worktreePath: primary.worktreePath,
    branchName: primary.branchName,
    ...(primary.baseRef ? { baseRef: primary.baseRef } : {}),
    ...(primary.status ? { status: primary.status } : {}),
    pullRequestUrl: primary.pullRequestUrl ?? null,
    pullRequestError: primary.pullRequestError ?? null,
    pullRequestState: primary.pullRequestState ?? null,
    lastCommitSha: primary.lastCommitSha,
    repos: normalizeSprintEngineVcsRepos(record, primary),
  }
}

function isFeedbackIssueCategory(value: unknown): value is SprintEngineTaskFeedbackIssueCategory {
  return feedbackIssueCategories.includes(value as SprintEngineTaskFeedbackIssueCategory)
}

function isFeedbackIssueSeverity(value: unknown): value is SprintEngineTaskFeedbackIssueSeverity {
  return feedbackIssueSeverities.includes(value as SprintEngineTaskFeedbackIssueSeverity)
}

function isFeedbackIssueStatus(value: unknown): value is SprintEngineTaskFeedbackIssueStatus {
  return feedbackIssueStatuses.includes(value as SprintEngineTaskFeedbackIssueStatus)
}

function isFeedbackFindingKind(value: unknown): value is SprintEngineTaskFeedbackFindingKind {
  return feedbackFindingKinds.includes(value as SprintEngineTaskFeedbackFindingKind)
}

function isFeedbackFindingSeverity(value: unknown): value is SprintEngineTaskFeedbackFindingSeverity {
  return feedbackFindingSeverities.includes(value as SprintEngineTaskFeedbackFindingSeverity)
}

function isFeedbackFindingArea(value: unknown): value is SprintEngineTaskFeedbackFindingArea {
  return feedbackFindingAreas.includes(value as SprintEngineTaskFeedbackFindingArea)
}

function isFeedbackFindingStatus(value: unknown): value is SprintEngineTaskFeedbackFindingStatus {
  return feedbackFindingStatuses.includes(value as SprintEngineTaskFeedbackFindingStatus)
}

function isSprintEngineTaskSourceType(value: unknown): value is SprintEngineTaskSourceType {
  return sprintEngineTaskSourceTypes.includes(value as SprintEngineTaskSourceType)
}

function isSprintEngineTaskSourceSyncStatus(value: unknown): value is SprintEngineTaskSourceSyncStatus {
  return sprintEngineTaskSourceSyncStatuses.includes(value as SprintEngineTaskSourceSyncStatus)
}

function isSprintEngineNeedsInputKind(value: unknown): value is SprintEngineNeedsInputKind {
  return sprintEngineNeedsInputKinds.includes(value as SprintEngineNeedsInputKind)
}

function normalizeSprintEngineNeedsInputKind(value: unknown): {
  kind: SprintEngineNeedsInputKind
  legacyDefaultReason?: SprintEngineNeedsInputReason
} | null {
  if (isSprintEngineNeedsInputKind(value)) return { kind: value }
  if (value === 'external_validation') return { kind: 'user', legacyDefaultReason: 'verification' }
  if (value === 'owner') return { kind: 'architect', legacyDefaultReason: 'blocked_other' }
  return null
}

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeSprintEngineTaskSource(value: unknown): SprintEngineTaskSource | undefined {
  if (!value || typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>
  if (!isSprintEngineTaskSourceType(record.type)) return undefined

  const externalId = optionalTrimmedString(record.externalId)
  const externalUrl = optionalTrimmedString(record.externalUrl)
  const repo = optionalTrimmedString(record.repo)
  const title = optionalTrimmedString(record.title)
  const body = typeof record.body === 'string' ? record.body : undefined
  const externalUpdatedAt = optionalTrimmedString(record.externalUpdatedAt)
  const syncedAt = optionalTrimmedString(record.syncedAt)
  const syncStatus = isSprintEngineTaskSourceSyncStatus(record.syncStatus) ? record.syncStatus : undefined

  return {
    type: record.type,
    ...(externalId ? { externalId } : {}),
    ...(externalUrl ? { externalUrl } : {}),
    ...(repo ? { repo } : {}),
    ...(title ? { title } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(externalUpdatedAt ? { externalUpdatedAt } : {}),
    ...(syncedAt ? { syncedAt } : {}),
    ...(syncStatus ? { syncStatus } : {}),
  }
}

function normalizeSprintEngineTaskNeedsInput(value: unknown): SprintEngineTaskNeedsInput | undefined {
  if (!value || typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>
  const routedKind = normalizeSprintEngineNeedsInputKind(record.kind)
  if (!routedKind) return undefined
  const defaultReasonByKind: Record<SprintEngineNeedsInputKind, SprintEngineNeedsInputReason> = {
    architect: 'task_scope',
    user: 'product_decision',
  }
  const reason = optionalTrimmedString(record.reason)
    ? optionalTrimmedString(record.reason)!
    : routedKind.legacyDefaultReason ?? defaultReasonByKind[routedKind.kind]
  const artifactId = optionalTrimmedString(record.artifactId)
  const suggestedResolution = optionalTrimmedString(record.suggestedResolution)
  const reportedBy = optionalTrimmedString(record.reportedBy)
  const reportedAt = optionalTrimmedString(record.reportedAt)
  const resolvedBy = optionalTrimmedString(record.resolvedBy)
  const resolvedAt = optionalTrimmedString(record.resolvedAt)
  const resolution = optionalTrimmedString(record.resolution)
  const resumeRequestedAt = optionalTrimmedString(record.resumeRequestedAt)

  return {
    kind: routedKind.kind,
    reason,
    question: typeof record.question === 'string' ? record.question : '',
    ...(artifactId ? { artifactId } : {}),
    ...(suggestedResolution ? { suggestedResolution } : {}),
    ...(reportedBy ? { reportedBy } : {}),
    ...(reportedAt ? { reportedAt } : {}),
    ...(resolvedBy ? { resolvedBy } : {}),
    ...(resolvedAt ? { resolvedAt } : {}),
    ...(resolution ? { resolution } : {}),
    ...(resumeRequestedAt ? { resumeRequestedAt } : {}),
  }
}

function normalizeSprintEngineTaskFeedbackIssues(value: unknown): SprintEngineTaskFeedbackIssue[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((issue, index): SprintEngineTaskFeedbackIssue[] => {
    if (!issue || typeof issue !== 'object') return []
    const record = issue as Record<string, unknown>
    const category = record.category
    const severity = record.severity
    const title = optionalTrimmedString(record.title)
    const detail = optionalTrimmedString(record.detail)

    if (!isFeedbackIssueCategory(category) || !isFeedbackIssueSeverity(severity) || !title || !detail) {
      return []
    }

    const id = optionalTrimmedString(record.id) ?? `feedback-issue-${index + 1}`
    const status = isFeedbackIssueStatus(record.status) ? record.status : undefined
    const target = optionalTrimmedString(record.target)
    const evidence = optionalTrimmedString(record.evidence)
    const suggestedPromptChange = optionalTrimmedString(record.suggestedPromptChange)
    const suggestedProcessChange = optionalTrimmedString(record.suggestedProcessChange)

    return [{
      id,
      category,
      severity,
      title,
      detail,
      ...(status ? { status } : {}),
      ...(target ? { target } : {}),
      ...(evidence ? { evidence } : {}),
      ...(suggestedPromptChange ? { suggestedPromptChange } : {}),
      ...(suggestedProcessChange ? { suggestedProcessChange } : {}),
    }]
  })
}

function normalizeSprintEngineTaskFeedbackFindings(value: unknown): SprintEngineTaskFeedbackFinding[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((finding, index): SprintEngineTaskFeedbackFinding[] => {
    if (!finding || typeof finding !== 'object') return []
    const record = finding as Record<string, unknown>
    const kind = record.kind
    const severity = record.severity
    const area = record.area
    const title = optionalTrimmedString(record.title)
    const detail = optionalTrimmedString(record.detail)

    // `findingJson` is categorical-only telemetry (kind/severity/area); `title`
    // and `detail` are optional prose — a finding without them is still real.
    if (
      !isFeedbackFindingKind(kind)
      || !isFeedbackFindingSeverity(severity)
      || !isFeedbackFindingArea(area)
    ) {
      return []
    }

    const id = optionalTrimmedString(record.id) ?? `feedback-finding-${index + 1}`
    const status = isFeedbackFindingStatus(record.status) ? record.status : undefined
    const recommendation = optionalTrimmedString(record.recommendation)
    const requirementId = optionalTrimmedString(record.requirementId)
    const file = optionalTrimmedString(record.file)

    return [{
      id,
      kind,
      severity,
      area,
      ...(title ? { title } : {}),
      ...(detail ? { detail } : {}),
      ...(status ? { status } : {}),
      ...(recommendation ? { recommendation } : {}),
      ...(requirementId ? { requirementId } : {}),
      ...(file ? { file } : {}),
    }]
  })
}

function normalizeSprintEngineTaskFeedback(value: unknown): SprintEngineTaskFeedback | undefined {
  if (!value || typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>
  const scoresRecord = record.scores && typeof record.scores === 'object'
    ? record.scores as Record<string, unknown>
    : {}
  const scores = {
    directiveClarityPct: percentOrUndefined(scoresRecord.directiveClarityPct),
    taskClarityPct: percentOrUndefined(scoresRecord.taskClarityPct),
    acceptanceCriteriaClarityPct: percentOrUndefined(scoresRecord.acceptanceCriteriaClarityPct),
    sprintEngineToolEffectivenessPct: percentOrUndefined(scoresRecord.sprintEngineToolEffectivenessPct),
    promptOptimizationPct: percentOrUndefined(scoresRecord.promptOptimizationPct),
    contextFitPct: percentOrUndefined(scoresRecord.contextFitPct),
    hallucinationRiskPct: percentOrUndefined(scoresRecord.hallucinationRiskPct),
    roleFitPct: percentOrUndefined(scoresRecord.roleFitPct),
    autonomyPct: percentOrUndefined(scoresRecord.autonomyPct),
    confidencePct: percentOrUndefined(scoresRecord.confidencePct),
  }
  const hasScore = Object.values(scores).some((score) => score !== undefined)
  const topFriction = typeof record.topFriction === 'string' && record.topFriction.trim()
    ? record.topFriction
    : undefined
  const suggestedImprovement = typeof record.suggestedImprovement === 'string' && record.suggestedImprovement.trim()
    ? record.suggestedImprovement
    : undefined
  const issues = normalizeSprintEngineTaskFeedbackIssues(record.issues)
  const findings = normalizeSprintEngineTaskFeedbackFindings(record.findings)

  const feedbackRole = normalizeSprintEngineRoleId(record.role)
  if (
    typeof record.schemaVersion !== 'number'
    || typeof record.capturedAt !== 'string'
    || typeof record.source !== 'string'
    || typeof record.agentId !== 'string'
    || !feedbackRole
    || (!hasScore && !topFriction && !suggestedImprovement && issues.length === 0 && findings.length === 0)
  ) {
    return undefined
  }

  return {
    schemaVersion: record.schemaVersion,
    capturedAt: record.capturedAt,
    source: record.source,
    agentId: record.agentId,
    role: feedbackRole,
    scores,
    ...(topFriction ? { topFriction } : {}),
    ...(suggestedImprovement ? { suggestedImprovement } : {}),
    ...(issues.length > 0 ? { issues } : {}),
    ...(findings.length > 0 ? { findings } : {}),
  }
}

function normalizeSprintEngineTaskTriage(value: unknown): SprintEngineTaskTriage | undefined {
  if (!value || typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>
  const summary = optionalTrimmedString(record.summary)
  const riskRating = record.riskRating
  if (
    !summary
    || (riskRating !== 'low' && riskRating !== 'medium' && riskRating !== 'high')
    || typeof record.readyRecommendation !== 'boolean'
    || record.triagedBy !== 'architect'
    || typeof record.triagedAt !== 'string'
  ) {
    return undefined
  }

  const suggestedRole = normalizeSprintEngineRoleId(record.suggestedRole)
  return {
    summary,
    ...(suggestedRole ? { suggestedRole } : {}),
    acceptanceCriteria: stringArray(record.acceptanceCriteria),
    likelyAffectedAreas: stringArray(record.likelyAffectedAreas),
    missingInformation: stringArray(record.missingInformation),
    riskRating,
    readyRecommendation: record.readyRecommendation,
    triagedBy: 'architect',
    triagedAt: record.triagedAt,
  }
}

function normalizeSprintEngineArtifactReviewHistory(value: unknown): SprintEngineArtifactReviewHistoryEntry[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    if (
      typeof record.action !== 'string'
      || typeof record.actor !== 'string'
      || typeof record.timestamp !== 'string'
    ) {
      return []
    }

    return [{
      action: record.action,
      actor: record.actor,
      timestamp: record.timestamp,
      ...(typeof record.note === 'string' ? { note: record.note } : {}),
    }]
  })
}

function normalizeSprintEngineArtifacts(value: unknown): SprintEngineArtifact[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((artifact, index) => {
    if (!artifact || typeof artifact !== 'object') return []
    const record = artifact as Record<string, unknown>
    // Unknown kinds are kept: dropping them here made artifacts referenced by
    // needs_input tasks invisible, so the inspector claimed no artifact was
    // attached and auto-approval never saw the review request. Kind validity
    // is enforced where artifacts are created (sprintengine artifact add).
    if (
      typeof record.id !== 'string'
      || typeof record.kind !== 'string'
      || !record.kind.trim()
      || !isSprintEngineArtifactStatus(record.status)
    ) {
      return []
    }

    const fallbackTitle = typeof record.path === 'string' && record.path.trim()
      ? record.path
      : `Artifact ${index + 1}`

    return [{
      id: record.id,
      kind: record.kind,
      title: typeof record.title === 'string' && record.title.trim() ? record.title : fallbackTitle,
      path: typeof record.path === 'string' ? record.path : '',
      status: record.status,
      createdBy: typeof record.createdBy === 'string' ? record.createdBy : '',
      taskId: typeof record.taskId === 'string' ? record.taskId : '',
      fingerprint: stringOrNull(record.fingerprint),
      reviewHistory: normalizeSprintEngineArtifactReviewHistory(record.reviewHistory),
      recommendedTasks: stringArray(record.recommendedTasks),
      createdAt: stringOrNull(record.createdAt),
      updatedAt: stringOrNull(record.updatedAt),
      ...(record.approvedBy === undefined ? {} : { approvedBy: stringOrNull(record.approvedBy) }),
      ...(record.approvedAt === undefined ? {} : { approvedAt: stringOrNull(record.approvedAt) }),
      ...(isSprintEngineArtifactApprovalMode(record.approvalMode) ? { approvalMode: record.approvalMode } : {}),
      ...(record.changesRequestedBy === undefined ? {} : { changesRequestedBy: stringOrNull(record.changesRequestedBy) }),
      ...(record.changesRequestedAt === undefined ? {} : { changesRequestedAt: stringOrNull(record.changesRequestedAt) }),
    }]
  })
}

// The zero roster: nobody staffed but the architect, which every run needs to
// plan at all. There is deliberately NO "starter team" here. A staffed role is
// a user decision (the wizard's "Work types & models" rows and "Final sweeps"
// toggles); anything this module seeds on its own is a role the user never
// chose, and the architect will plan work for it. See the regression note on
// `normalizeSprintEngineRoleCounts`.
export function createEmptySprintEngineRoleCounts(): SprintEngineRoleCounts {
  return {
    architect: 1,
    product: 0,
    developer: 0,
    frontend: 0,
    ui_ux_reviewer: 0,
    tester: 0,
    security: 0,
    performance: 0,
    cross_platform: 0,
  }
}

export function createDefaultSprintEngineSkills(): SprintEngineSkillMap {
  return {
    architect: ['Deep repo analysis', 'Planning', 'Task decomposition', 'Dependency mapping'],
    product: ['Market research', 'Competitor analysis', 'Audience fit', 'Product positioning'],
    developer: ['Implementation', 'Refactoring', 'Integration work', 'Testing'],
    frontend: ['Interface design', 'Interaction design', 'Responsive layouts', 'UI implementation'],
    ui_ux_reviewer: ['UI/UX review', 'Brand alignment', 'Responsive QA', 'Visual artifact checks'],
    tester: ['Regression checks', 'Acceptance review', 'Validation'],
    security: ['Threat modeling', 'Security review', 'Hardening', 'Abuse-case analysis'],
    performance: ['Latency review', 'Memory and CPU analysis', 'Bundle/runtime cost', 'Measurement quality'],
    production_readiness_reviewer: ['Release readiness', 'Deployment config', 'Data safety', 'Rollback and observability'],
    cross_platform: ['OS compatibility', 'Browser/device coverage', 'Path and shell portability', 'Packaging checks'],
  }
}

export function countSprintEngineAgents(roleCounts: SprintEngineRoleCounts): number {
  return Object.values(roleCounts).reduce((total, count) => total + Math.max(0, count), 0)
}

// MC-1450 retired per-role quantities: `roleCounts` is now the persisted
// encoding of an enabled-role SET — every value normalizes to 0 or 1 (legacy
// presets/workspaces with counts > 1 collapse to "enabled"). Under MC-1444's
// one-session-per-task model a role's parallel throughput comes from
// mint-on-demand plus the workspace-level max-parallel-agents knob, never
// from a configured headcount. The count-shaped encoding is kept so old and
// new presets stay mutually readable.
// The caller's map is the whole truth: a role it does not mention is OFF, not
// "unspecified, fall back to a default". This used to seed the result from a
// built-in starter team (architect + product + developer) and only overwrite the
// keys the input mentioned — so a role the wizard deliberately REMOVED (it
// deletes sweep roles like `product` from the counts, since sweeps are opt-in via
// "Final sweeps") was indistinguishable from a role nobody had an opinion about,
// and silently came back staffed at the starter-team value. It then rode into
// `configuredRoles` and the architect planned a sweep task for a role the user
// never configured. Absent means off.
export function normalizeSprintEngineRoleCounts(
  roleCounts?: Partial<SprintEngineRoleCounts> | null
): SprintEngineRoleCounts {
  const result = createEmptySprintEngineRoleCounts()
  if (!roleCounts || typeof roleCounts !== 'object') return result
  for (const [role, rawCount] of Object.entries(roleCounts)) {
    if (!normalizeSprintEngineRoleId(role)) continue
    result[role] = Math.floor(Number(rawCount ?? 0) || 0) > 0 ? 1 : 0
  }
  // Architect is no longer force-seated. A general-default run plans with its
  // `general` seat, so honor the selection: architect stays enabled only when
  // the user picked it, or as the planner floor when nothing else can plan. A
  // run that staffs neither still normalizes to a lone architect, matching the
  // pre-general contract for every existing preset (none of which carry general).
  const architectSelected = Math.floor(Number(roleCounts.architect ?? 0) || 0) > 0
  result.architect = architectSelected || !(result.general > 0) ? 1 : 0
  return result
}

// A bare `<role>` id (no positional suffix) counts as index 1. Creation seeds the
// architect under its bare id, and older runs also seated bare reviewer ids, so
// the allocator must step past one rather than collide with it.
function roleAgentIndex(agentId: string, role: SprintEngineRoleId): number {
  const base = role
  if (agentId === base) return 1
  // Escape the role id for use in a RegExp — custom registry ids may
  // contain characters the regex syntax would otherwise interpret.
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = agentId.match(new RegExp(`^${escaped}-(\\d+)$`))
  if (!match) return Number.MAX_SAFE_INTEGER
  return Number(match[1])
}

export function getNextSprintEngineAgentId(
  role: SprintEngineRoleId,
  sprintEngineAgents: Record<AgentId, SprintEngineRuntimeAgent>
): AgentId {
  // Task-scoped workers are always suffixed: the first minted worker of a role
  // is `<role>-1`. MC-1542 removed the reviewer carve-out (a reserved bare
  // `<role>` id), but a bare id — the seeded architect, or a reviewer id from an
  // older run — still counts as index 1 so a mint never collides with it.
  // The spawner is the sole id authority under MC-1591 leases: there is no Python
  // allocator to mirror or drift against — the engine treats a minted id as an
  // opaque actor label and binds it to a task only at claim.
  const usedIds = new Set(Object.keys(sprintEngineAgents))

  let nextIndex = 1
  for (const [agentId, agent] of Object.entries(sprintEngineAgents)) {
    if (agent.role !== role) continue
    const index = roleAgentIndex(agentId, role)
    if (Number.isFinite(index)) nextIndex = Math.max(nextIndex, index + 1)
  }

  let candidate = `${role}-${nextIndex}`
  while (usedIds.has(candidate)) {
    nextIndex += 1
    candidate = `${role}-${nextIndex}`
  }
  return candidate
}

// The single planning seat a fresh run seeds, and the run's guaranteed planner.
// Planner-ness is a property of the seat, not one fixed role: a general-default
// run plans with a bare `general` seat; a specialist run plans with the
// `architect`. Architect wins when a selection somehow staffs both (the two
// wizard modes are mutually exclusive, so this only matters as a tie-break), and
// it is the floor when the selection named no planner at all — every run needs one.
export function sprintEnginePlannerRole(roleCounts: SprintEngineRoleCounts): SprintEngineRoleId {
  if ((roleCounts.architect ?? 0) > 0) return 'architect'
  if ((roleCounts.general ?? 0) > 0) return 'general'
  return 'architect'
}

export function buildSprintEngineAgentRoster(
  roleCounts: SprintEngineRoleCounts,
  registry?: SprintEngineRoleRegistry | null,
): SprintEngineAgentRosterItem[] {
  // Lazy roster: creation seeds ONLY the single planning seat. Worker ids are
  // minted task-scoped on demand by the Python assignment op, so no worker
  // record exists at creation. Which planner is seated follows the staffed
  // selection: a general-default run seeds a bare `general` seat, a specialist
  // run seeds the `architect`. enabledRoles/roleCounts still gate which roles
  // participate (forwarded to Python init as `configuredRoles`) but only the
  // planner materializes a seat here.
  const planner = sprintEnginePlannerRole(roleCounts)
  return [{ id: planner, label: getSprintEngineRoleLabel(planner, registry), role: planner }]
}

// The enabled role set the roster staffs — exactly the user's selection.
// Forwarded to Python init as `configuredRoles` (the run's legal role set that
// `plan.add_task` and seat creation enforce), even though the lazy roster seeds
// only the planner. Architect is NOT unconditional: it enters only when the
// selection staffs it, or as the planner floor below. A general-default run's
// configuredRoles is `['general']`; claiming an architect the run never staffed
// would be a lie about its legal role set. `additionalRoles` admits roles the
// wizard enables outside the role table: the sweep roles the operator turned ON
// in the "Final sweeps" panel. The roster is the user's configuration — an
// unselected sweep must not become plannable, or the architect will schedule
// audits nobody asked for (the design-wizard-premium regression).
export function sprintEngineEnabledRoles(
  roleCounts: SprintEngineRoleCounts,
  additionalRoles?: readonly SprintEngineRoleId[],
): SprintEngineRoleId[] {
  const roles = new Set<SprintEngineRoleId>()
  for (const [role, count] of Object.entries(roleCounts)) {
    if ((count ?? 0) > 0 && normalizeSprintEngineRoleId(role)) roles.add(role as SprintEngineRoleId)
  }
  for (const role of additionalRoles ?? []) {
    const normalized = normalizeSprintEngineRoleId(role)
    if (normalized) roles.add(normalized)
  }
  // Enforce >= 1 planner: a run with neither architect nor general has nobody
  // who can plan. The wizard's roster floor already guarantees a planner at the
  // UI layer, so this only ever fires on a malformed selection.
  if (!roles.has('architect') && !roles.has('general')) {
    roles.add(sprintEnginePlannerRole(roleCounts))
  }
  return [...roles]
}

export function buildSprintEngineAgentRosterFromRuntimeAgents(
  sprintEngineAgents: Record<AgentId, SprintEngineRuntimeAgent>,
  registry?: SprintEngineRoleRegistry | null,
): SprintEngineAgentRosterItem[] {
  // Tally how many agents each registry-keyed role has so we can decide
  // whether to append a positional suffix to labels. Bundled and custom
  // roles share the same Map; unknown ids do not silently collapse into a
  // bundled bucket.
  const roleTotals = new Map<SprintEngineRoleId, number>()
  for (const agent of Object.values(sprintEngineAgents)) {
    const role = agent?.role
    if (!role) continue
    roleTotals.set(role, (roleTotals.get(role) ?? 0) + 1)
  }

  const seenByRole = new Map<SprintEngineRoleId, number>()
  const rolePriority = (role: SprintEngineRoleId): number => {
    const bundled = sprintEngineRoleOrder.indexOf(role as SprintEngineRole)
    // Bundled order first, then unknown/custom roles sorted alphabetically
    // after the bundled block so the roster has a stable layout regardless
    // of registry source layer.
    return bundled >= 0 ? bundled : sprintEngineRoleOrder.length
  }

  return Object.entries(sprintEngineAgents)
    .filter((entry): entry is [AgentId, SprintEngineRuntimeAgent] => Boolean(entry[1]?.role))
    .sort(([aId, a], [bId, b]) => {
      const roleDelta = rolePriority(a.role) - rolePriority(b.role)
      if (roleDelta !== 0) return roleDelta
      const roleNameDelta = a.role.localeCompare(b.role)
      if (roleNameDelta !== 0) return roleNameDelta
      return roleAgentIndex(aId, a.role) - roleAgentIndex(bId, b.role)
    })
    .map(([id, agent]) => {
      const seen = (seenByRole.get(agent.role) ?? 0) + 1
      seenByRole.set(agent.role, seen)
      const total = roleTotals.get(agent.role) ?? 1
      const suffix = total > 1 ? ` ${seen}` : ''
      const baseLabel = getSprintEngineRoleLabel(agent.role, registry)
      return { id, label: `${baseLabel}${suffix}`, role: agent.role }
    })
}

export function buildSprintEngineAgentRosterForState(
  sprintEngineState: Pick<SprintEngineState, 'roleCounts' | 'sprintEngineAgents' | 'workers'> | null | undefined
): SprintEngineAgentRosterItem[] {
  // Canonical source: the lease-derived workers view (MC-1591). A worker is a
  // superset of a runtime agent, so the same row builder applies.
  const workers = sprintEngineState?.workers
  if (workers && Object.keys(workers).length > 0) {
    return buildSprintEngineAgentRosterFromRuntimeAgents(workers)
  }
  // Fallback for states built outside the projection normalizer (no workers
  // view) and the pre-seat lazy placeholder that only populates sprintEngineAgents.
  if (sprintEngineState?.sprintEngineAgents && Object.keys(sprintEngineState.sprintEngineAgents).length > 0) {
    return buildSprintEngineAgentRosterFromRuntimeAgents(sprintEngineState.sprintEngineAgents)
  }
  return buildSprintEngineAgentRoster(sprintEngineState?.roleCounts ?? createEmptySprintEngineRoleCounts())
}

// Bundled worker roles that surface their own role-task launch button on
// the Sprint Engine panel. When one of these has an active or ready task,
// the role-task launch supersedes a generic focus-agent action for the same
// role. Extensible/custom roles do not yet ship dedicated role-task launch
// buttons; they always defer to the generic focus-agent action.
const SPRINT_ENGINE_FOCUS_WORKER_ROLES: SprintEngineRole[] = [
  'developer',
  'frontend',
  'ui_ux_reviewer',
  'product',
  'performance',
  'cross_platform',
  'tester',
  'security',
]

export type SprintEngineRuntimeAgentEffectiveStatus =
  | SprintEngineRuntimeAgent['status']
  | 'idle'
  | 'exited'

export type SprintEngineFocusAgent = {
  agentId: AgentId
  role: SprintEngineRoleId
  status: SprintEngineRuntimeAgentEffectiveStatus
  currentTaskId: string | null
}

export type SprintEngineFocusAgentAvailability = {
  /** The first needs_input or running agent after the local-exit override. */
  focusAgent: SprintEngineFocusAgent | null
  /** True only when the panel would surface the generic focus-agent action.
   *  Mirrors SprintEngineBoardPanel: hidden when the focus agent's role has a
   *  dedicated role-task launch (which supersedes the generic action). */
  showFocusAgentAction: boolean
}

/** Subset of the renderer's AgentState used to compute the localExited override
 *  without coupling this utility to the full AgentState type. */
export type SprintEngineLocalAgentLike = {
  kind?: string
  cliLastExitedAt?: number | null
  cliStartRequested?: boolean
  cliHasLaunched?: boolean
}

/**
 * Compute the effective focus-agent availability used by both the Sprint
 * Engine panel and the command palette. Applies the same three filters the
 * panel applies:
 *   1. Roster-derived runtime agents only (orphan sprintEngineAgents entries
 *      that are not on the roster are ignored).
 *   2. localExited override: if the renderer agent state shows the CLI has
 *      exited and no fresh start has been requested, treat the agent as
 *      exited regardless of the projected run-store agent state.
 *   3. showFocusAgentAction: hidden when the focus agent's role already has a
 *      dedicated role-task launch surfaced by the panel.
 */
export function computeSprintEngineFocusAgentAvailability(
  sprintEngineState: SprintEngineState | null | undefined,
  agents: Record<string, SprintEngineLocalAgentLike | undefined>
): SprintEngineFocusAgentAvailability {
  if (!sprintEngineState) return { focusAgent: null, showFocusAgentAction: false }

  const roster = buildSprintEngineAgentRosterForState(sprintEngineState)
  const rosterById = new Map(roster.map((agent) => [agent.id, agent]))

  const runtimeAgents: SprintEngineFocusAgent[] = roster.map((agent) => {
    const runtime = sprintEngineState.sprintEngineAgents[agent.id]
    const local = agents[agent.id]
    const localExited = Boolean(
      local?.kind === 'sprintengine'
      && local.cliLastExitedAt
      && !local.cliStartRequested
      && !local.cliHasLaunched
    )
    const status: SprintEngineRuntimeAgentEffectiveStatus = localExited
      ? 'exited'
      : (runtime?.status ?? 'idle')
    return {
      agentId: agent.id,
      role: runtime?.role ?? agent.role,
      status,
      currentTaskId: runtime?.currentTaskId ?? null,
    }
  })

  const needsInput = runtimeAgents.find((agent) => agent.status === 'needs_input')
  const running = runtimeAgents.find((agent) => agent.status === 'running')
  const focusAgent = needsInput ?? running ?? null

  if (!focusAgent) return { focusAgent: null, showFocusAgentAction: false }

  const readyTasks = sprintEngineState.tasks.filter((task) =>
    isSprintEngineTaskLaunchable(task, sprintEngineState)
  )
  const roleTaskLaunchSet = new Set<SprintEngineRoleId>()
  for (const role of SPRINT_ENGINE_FOCUS_WORKER_ROLES) {
    const activeTask = sprintEngineState.tasks.find(
      (task) =>
        task.role === role
        && (task.status === 'in_progress' || task.status === 'needs_input')
    )
    const readyTask = readyTasks.find((task) => task.role === role && !task.ownerAgentId)
    if (activeTask ?? readyTask) roleTaskLaunchSet.add(role)
  }

  const focusAgentRosterRole = rosterById.get(focusAgent.agentId)?.role
  const focusAgentRole: SprintEngineRoleId | undefined = focusAgentRosterRole ?? focusAgent.role
  const showFocusAgentAction =
    !focusAgentRole
    || focusAgentRole === 'architect'
    || !roleTaskLaunchSet.has(focusAgentRole)

  return { focusAgent, showFocusAgentAction }
}

function isSprintEngineStateRosterInput(
  input: Pick<SprintEngineState, 'roleCounts' | 'sprintEngineAgents' | 'rosterConfigured'> | SprintEngineRoleCounts | null | undefined
): input is Pick<SprintEngineState, 'roleCounts' | 'sprintEngineAgents' | 'rosterConfigured'> {
  return Boolean(input && typeof input === 'object' && 'sprintEngineAgents' in input)
}

export function buildSprintEngineRosterCommandArgs(
  sprintEngineState: Pick<SprintEngineState, 'roleCounts' | 'sprintEngineAgents' | 'rosterConfigured'> | SprintEngineRoleCounts | null | undefined
): string[] {
  const stateInput = isSprintEngineStateRosterInput(sprintEngineState) ? sprintEngineState : null
  if (stateInput && !stateInput.rosterConfigured) return []
  const roster = stateInput
    ? buildSprintEngineAgentRosterForState(stateInput)
    : buildSprintEngineAgentRoster(normalizeSprintEngineRoleCounts(sprintEngineState as Partial<SprintEngineRoleCounts> | null | undefined))
  return roster.map((agent) => `${agent.role}:${agent.id}`)
}

export function createInitialSprintEngineState(config: SprintEngineMockConfig): SprintEngineState {
  const roleCounts = normalizeSprintEngineRoleCounts(config.roleCounts)
  const roster = buildSprintEngineAgentRoster(roleCounts)
  return {
    name: config.name?.trim() || 'Sprint Roster',
    goal: config.goal,
    rosterConfigured: true,
    roleCounts,
    sprintEngineAgents: Object.fromEntries(
      roster.map((agent) => [
        agent.id,
        { role: agent.role, status: 'idle' as const, currentTaskId: null },
      ])
    ),
    events: [],
    tasks: [],
    artifacts: [],
  }
}

export function getSprintEngineTaskBoardColumn(
  task: SprintEngineTask,
  tasks: SprintEngineTask[]
): SprintEngineTaskBoardColumn {
  // Folder-store projection: when the task carries an authoritative board column
  // (or it lives in an in_progress/needs_input/done folder), trust that value.
  if (task.boardColumn && isSprintEngineTaskBoardColumn(task.boardColumn)) {
    return task.boardColumn
  }
  if (
    task.status === 'in_progress'
    || task.status === 'review'
    || task.status === 'needs_input'
    || task.status === 'done'
    || task.status === 'canceled'
  ) {
    return task.status
  }
  const dependenciesDone = task.dependsOn.every((depId) =>
    tasks.some((t) => t.id === depId && t.status === 'done')
  )
  if (!dependenciesDone) return 'todo'
  return 'ready'
}

export function orderSprintEngineBoardColumnTasks(
  column: SprintEngineTaskBoardColumn,
  tasks: SprintEngineTask[]
): SprintEngineTask[] {
  if (column !== 'done') return tasks

  return tasks
    .map((task, index) => ({ task, index }))
    .sort((a, b) => {
      const aCompletedAt = Date.parse(a.task.completedAt ?? '')
      const bCompletedAt = Date.parse(b.task.completedAt ?? '')
      const aHasCompletedAt = Number.isFinite(aCompletedAt)
      const bHasCompletedAt = Number.isFinite(bCompletedAt)
      if (aHasCompletedAt && bHasCompletedAt && aCompletedAt !== bCompletedAt) {
        return bCompletedAt - aCompletedAt
      }
      if (aHasCompletedAt !== bHasCompletedAt) return aHasCompletedAt ? -1 : 1
      return a.index - b.index
    })
    .map(({ task }) => task)
}

export function getSprintEngineTaskSourceType(task: Pick<SprintEngineTask, 'source'>): SprintEngineTaskSourceType {
  return task.source?.type ?? 'local'
}

export function getReviewableSprintEngineArtifacts(artifacts: SprintEngineArtifact[]): SprintEngineArtifact[] {
  // Unknown kinds stay reviewable: the user must be able to see and manually
  // approve an artifact a task's needs_input points at even when this build
  // does not recognize the kind. Only superseded artifacts leave the surface.
  return artifacts.filter((artifact) => artifact.status !== 'superseded')
}

export function isSprintEngineArtifactAutoApprovableKind(kind: string): boolean {
  return reviewGateArtifactKinds.has(kind)
}

// Stored artifact paths are project-relative but recorded in two equivalent
// forms that resolve to the same file: a bare team-relative path (`plan.md`)
// and a full-prefix path (`.multi-code/sprintengine/<team>/plan.md`). This
// mirrors the Python `artifact_absolute_path` resolution (which lands both
// forms at `<teamDir>/<rest>`) without filesystem access, so renderer and
// main-process gates agree on which artifacts point at the same file.
export function normalizeSprintEngineArtifactFileKey(path: string): string {
  const segments = path
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
  if (
    segments[0] === '.multi-code'
    && segments[1] === 'sprintengine'
    && segments.length > 3
  ) {
    return segments.slice(3).join('/')
  }
  return segments.join('/')
}

export function isSameSprintEngineArtifactFile(left: string, right: string): boolean {
  const leftKey = normalizeSprintEngineArtifactFileKey(left)
  return leftKey !== '' && leftKey === normalizeSprintEngineArtifactFileKey(right)
}

// Blocking review siblings of an auto-approval candidate, mirroring the
// main-process gate (getArtifactAutoApprovalBlocker): same task, not already
// approved/superseded, of an auto-approvable kind. A stale same-file duplicate
// of the candidate is excluded — it is not an independent review gate, so it
// must not veto approval of its real sibling. The candidate itself stays in the
// set, keeping the "no blocking artifact waiting" guard meaningful.
export function getSprintEngineAutoApprovalBlockingSiblings(
  artifact: SprintEngineArtifact,
  artifactsForTask: SprintEngineArtifact[]
): SprintEngineArtifact[] {
  return artifactsForTask.filter((candidate) =>
    candidate.status !== 'approved'
    && candidate.status !== 'superseded'
    && isSprintEngineArtifactAutoApprovableKind(candidate.kind)
    && !(candidate.id !== artifact.id && isSameSprintEngineArtifactFile(candidate.path, artifact.path))
  )
}

// Review statuses the main-process gate treats as approvable for a blocking
// sibling (getArtifactAutoApprovalBlocker). Kept local to avoid a circular
// import with sprintengineAutoRun.ts, which re-exports the same set.
const sprintEngineApprovableReviewStatuses: ReadonlySet<string> = new Set([
  'ready_for_review',
  'changes_requested',
])

export function sprintEngineAutoApprovalBlockingSiblingsAllReviewable(
  artifact: SprintEngineArtifact,
  artifactsForTask: SprintEngineArtifact[]
): boolean {
  const blockingArtifacts = getSprintEngineAutoApprovalBlockingSiblings(artifact, artifactsForTask)
  if (blockingArtifacts.length === 0) return false
  return blockingArtifacts.every((candidate) =>
    sprintEngineApprovableReviewStatuses.has(candidate.status) && Boolean(candidate.path.trim())
  )
}

export function getSprintEngineArtifactAutoApprovalEligibility(
  artifact: SprintEngineArtifact
): SprintEngineArtifactAutoApprovalEligibility {
  if (artifact.status !== 'ready_for_review') {
    return {
      eligible: false,
      label: '',
      reason: 'Only artifacts ready for review can be auto-approved.',
    }
  }

  if (!artifact.path.trim()) {
    return {
      eligible: false,
      label: 'Cannot auto-approve: file unavailable',
      reason: 'Artifact file path is missing.',
    }
  }

  if (isSprintEngineArtifactAutoApprovableKind(artifact.kind)) {
    return {
      eligible: true,
      label: 'Auto-approval ready',
      reason: null,
    }
  }

  return {
    eligible: false,
    label: '',
    reason: 'Unknown artifact type.',
  }
}

export function getAutoApprovableReadySprintEngineArtifacts(
  sprintEngineState: Pick<SprintEngineState, 'tasks' | 'artifacts'>
): SprintEngineArtifact[] {
  const reviewArtifacts = getReviewableSprintEngineArtifacts(sprintEngineState.artifacts)
  const reviewArtifactsByTaskId = getSprintEngineArtifactsByTaskId(reviewArtifacts)
  const tasksById = new Map(sprintEngineState.tasks.map((task) => [task.id, task]))

  return reviewArtifacts.filter((artifact) => {
    if (!getSprintEngineArtifactAutoApprovalEligibility(artifact).eligible) return false

    const task = tasksById.get(artifact.taskId)
    if (!task || task.status !== 'needs_input') return false

    // Mirrors the main-process auto-approval gate: only auto-approvable kinds
    // count as blockers (an unknown-kind sibling awaiting manual review does not
    // veto), and a stale same-file duplicate of this artifact is excluded so it
    // cannot deadlock approval of its real sibling.
    return sprintEngineAutoApprovalBlockingSiblingsAllReviewable(
      artifact,
      reviewArtifactsByTaskId[task.id] ?? []
    )
  })
}

export function getSprintEngineArtifactsByTaskId(
  artifacts: SprintEngineArtifact[]
): Record<string, SprintEngineArtifact[]> {
  return artifacts.reduce<Record<string, SprintEngineArtifact[]>>((byTaskId, artifact) => {
    if (!artifact.taskId) return byTaskId
    byTaskId[artifact.taskId] = [...(byTaskId[artifact.taskId] ?? []), artifact]
    return byTaskId
  }, {})
}

export function getSprintEngineArtifactDependencyBlockers(
  task: SprintEngineTask,
  tasks: SprintEngineTask[],
  artifacts: SprintEngineArtifact[]
): SprintEngineArtifactDependencyBlocker[] {
  const artifactsByTaskId = getSprintEngineArtifactsByTaskId(getReviewableSprintEngineArtifacts(artifacts))
  const tasksById = new Map(tasks.map((candidate) => [candidate.id, candidate]))

  return task.dependsOn.flatMap((dependencyId) => {
    const dependency = tasksById.get(dependencyId)
    if (!dependency || dependency.status === 'done') return []

    const waitingArtifacts = (artifactsByTaskId[dependencyId] ?? []).filter((artifact) =>
      artifact.status !== 'approved'
    )
    if (waitingArtifacts.length === 0) return []

    return [{
      taskId: dependency.id,
      title: dependency.title,
      artifacts: waitingArtifacts,
    }]
  })
}

// Tolerant read of the run.yaml/projection `roleRuntimes` map. Keeps only
// registry-valid roles with an object value; trims cli/model and drops empty
// strings (absent and null both mean "CLI default" — no `--model` flag).
// Returns null when nothing valid remains so callers can omit the field.
export function normalizeSprintEngineRoleRuntimes(value: unknown): SprintEngineRoleRuntimes | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result: SprintEngineRoleRuntimes = {}
  for (const [rawRole, runtime] of Object.entries(value as Record<string, unknown>)) {
    const role = normalizeSprintEngineRoleId(rawRole)
    if (!role || !runtime || typeof runtime !== 'object') continue
    const record = runtime as Record<string, unknown>
    const cli = typeof record.cli === 'string' && record.cli.trim() ? record.cli.trim() : undefined
    const model = typeof record.model === 'string' && record.model.trim() ? record.model.trim() : undefined
    if (!cli && !model) continue
    result[role] = { ...(model ? { model } : {}), ...(cli ? { cli } : {}) }
  }
  return Object.keys(result).length > 0 ? result : null
}

// Tolerant read of the run.yaml/projection `configuredRoles` list — the run's
// enabled role set. Keeps registry-valid role ids, de-duped and order-stable.
// Returns null when the field is absent or empty so callers can omit it and the
// roster view falls back to the seated-roster census (legacy runs).
export function normalizeSprintEngineConfiguredRoles(value: unknown): SprintEngineRoleId[] | null {
  if (!Array.isArray(value)) return null
  const seen = new Set<SprintEngineRoleId>()
  const result: SprintEngineRoleId[] = []
  for (const rawRole of value) {
    const role = normalizeSprintEngineRoleId(typeof rawRole === 'string' ? rawRole : '')
    if (!role || seen.has(role)) continue
    seen.add(role)
    result.push(role)
  }
  return result.length > 0 ? result : null
}

// Tolerant read of run.yaml/projection `rosterSource`. Only the two known modes
// survive; anything else (including absent/legacy) returns null so callers omit
// the field and 'user' semantics apply everywhere.
export function normalizeSprintEngineRosterSource(value: unknown): SprintEngineRosterSource | null {
  return value === 'architect' || value === 'user' ? value : null
}

// Tolerant read of run.yaml/projection `defaultPhases` — the run's phase list
// (MC-1542). Unlike every other optional run key, an EMPTY array is meaningful
// ("agents on this run don't review their own work") and must survive, so this
// returns null only when the key is absent or not an array. Unknown phase names
// are dropped; the engine is the authority and rejects them at write time.
export function normalizeSprintEngineDefaultPhases(value: unknown): SprintEngineTaskPhase[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((phase): phase is SprintEngineTaskPhase =>
    sprintEngineTaskPhases.includes(phase as SprintEngineTaskPhase)
  )
}

// Tolerant read of run.yaml/projection `allowedRuntimes` — the architect-roster
// run's ticked model palette. Drops entries with no usable cli; a missing/blank
// model becomes null (the CLI's own default). Returns null when absent/empty so
// user-mode runs stay clean.
export function normalizeSprintEngineAllowedRuntimes(value: unknown): SprintEngineAllowedRuntime[] | null {
  if (!Array.isArray(value)) return null
  const result: SprintEngineAllowedRuntime[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    const cli = typeof record.cli === 'string' && record.cli.trim() ? record.cli.trim() : ''
    if (!cli) continue
    const model = typeof record.model === 'string' && record.model.trim() ? record.model.trim() : null
    result.push({ cli, model })
  }
  return result.length > 0 ? result : null
}

// MC-1543: a task's `awaitingPhaseSession` marker (a released phase awaiting a
// fresh session on a bound runtime). Dropped unless it names a valid phase and a
// runtime with a usable cli — a half-formed marker must not strand a task in the
// Birth-path with no runtime to spawn on. Returns null when absent.
export function normalizeSprintEngineAwaitingPhaseSession(
  value: unknown,
): { phase: SprintEngineTaskPhase; runtime: SprintEngineAllowedRuntime; agentId?: string; role?: SprintEngineRoleId } | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const phase = record.phase
  if (!sprintEngineTaskPhases.includes(phase as SprintEngineTaskPhase)) return null
  const rawRuntime = record.runtime
  if (!rawRuntime || typeof rawRuntime !== 'object') return null
  const runtimeRecord = rawRuntime as Record<string, unknown>
  const cli = typeof runtimeRecord.cli === 'string' && runtimeRecord.cli.trim() ? runtimeRecord.cli.trim() : ''
  if (!cli) return null
  const model =
    typeof runtimeRecord.model === 'string' && runtimeRecord.model.trim() ? runtimeRecord.model.trim() : null
  const agentId = optionalTrimmedString(record.agentId)
  const role = normalizeSprintEngineRoleId(record.role)
  return {
    phase: phase as SprintEngineTaskPhase,
    runtime: { cli, model },
    ...(agentId ? { agentId } : {}),
    ...(role ? { role } : {}),
  }
}

export function normalizeSprintEngineOpenReviewRequest(
  value: unknown,
): SprintEngineTask['openReviewRequest'] {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = optionalTrimmedString(record.id)
  const requestedByAgentId = optionalTrimmedString(record.requestedByAgentId)
  const requestedByRole = normalizeSprintEngineRoleId(record.requestedByRole)
  const sourceTaskId = optionalTrimmedString(record.sourceTaskId)
  const requestedAt = optionalTrimmedString(record.requestedAt)
  const status = record.status
  const cycle = typeof record.cycle === 'number' && Number.isInteger(record.cycle) && record.cycle > 0
    ? record.cycle
    : null
  if (
    !id || !requestedByAgentId || !requestedByRole || !sourceTaskId || !requestedAt || !cycle
    || !['rework', 'awaiting_reapproval', 'escalated'].includes(String(status))
  ) return null
  const runtime = normalizeSprintEngineAllowedRuntimes(
    record.reviewerRuntime ? [record.reviewerRuntime] : [],
  )?.[0]
  const implementationAgentId = optionalTrimmedString(record.implementationAgentId)
  const reworkedAt = optionalTrimmedString(record.reworkedAt)
  return {
    id,
    status: status as 'rework' | 'awaiting_reapproval' | 'escalated',
    requestedByAgentId,
    requestedByRole,
    sourceTaskId,
    cycle,
    requestedAt,
    feedbackCommentIds: stringArray(record.feedbackCommentIds),
    ...(implementationAgentId ? { implementationAgentId } : {}),
    ...(reworkedAt ? { reworkedAt } : {}),
    ...(runtime ? { reviewerRuntime: runtime } : {}),
  }
}

export function normalizeSprintEngineState(input: SprintEngineState | null | undefined): SprintEngineState | null {
  if (!input) return null

  const tasks = (Array.isArray(input.tasks) ? input.tasks : []).map((task, index) => {
    const feedback = normalizeSprintEngineTaskFeedback(task.feedback)
    const feedbackAssessments = Array.isArray((task as { feedbackAssessments?: unknown }).feedbackAssessments)
      ? ((task as { feedbackAssessments?: unknown[] }).feedbackAssessments ?? [])
        .map((entry) => normalizeSprintEngineTaskFeedback(entry))
        .filter((entry): entry is SprintEngineTaskFeedback => Boolean(entry))
      : []
    const triage = normalizeSprintEngineTaskTriage(task.triage)
    const source = normalizeSprintEngineTaskSource(task.source)
    const needsInput = normalizeSprintEngineTaskNeedsInput(task.needsInput)
    const activity = normalizeSprintEngineTaskActivity(task.activity)
    // A pre-MC-1542 store carrying a retired status never reaches here: the
    // projection guard rejects it first (describeUnsupportedSprintEngineStore).
    const taskStatusValues = ['todo', 'in_progress', 'review', 'needs_input', 'done', 'canceled'] as const satisfies readonly SprintEngineTaskStatus[]
    const semanticStatus = taskStatusValues.includes(task.stateStatus as SprintEngineTaskStatus)
      ? task.stateStatus as SprintEngineTaskStatus
      : null
    const status: SprintEngineTaskStatus = semanticStatus
      ?? (taskStatusValues.includes(task.status as SprintEngineTaskStatus)
        ? task.status as SprintEngineTaskStatus
        : 'todo' as const)
    const boardColumn = isSprintEngineTaskBoardColumn(task.boardColumn) ? task.boardColumn : undefined
    const folderStatus = optionalTrimmedString(task.folderStatus)
    const taskRecord = task as unknown as Record<string, unknown>
    const awaitingPhaseSession = normalizeSprintEngineAwaitingPhaseSession(taskRecord.awaitingPhaseSession)
    const openReviewRequest = normalizeSprintEngineOpenReviewRequest(taskRecord.openReviewRequest)
    const phases = normalizeSprintEngineDefaultPhases(taskRecord.phases)
    const latestComments = normalizeSprintEngineTaskComments(taskRecord.latestComments)
    const latestOpenFeedback = normalizeSprintEngineTaskComments(taskRecord.latestOpenFeedback)
    const recordedArtifacts = normalizeSprintEngineRecordedArtifacts(taskRecord.recordedArtifacts)
    // Preserve any registry-keyed role id (bundled or custom) so projection
    // normalization never drops a custom-role task into `developer`.
    const taskRole = normalizeSprintEngineRoleId(task.role) ?? 'developer'
    return {
      id: task.id ?? `task-${index + 1}`,
      title: task.title ?? `Task ${index + 1}`,
      description: task.description ?? '',
      role: taskRole,
      repo: optionalTrimmedString(task.repo) ?? DEFAULT_SPRINTENGINE_TASK_REPO,
      status,
      ...(semanticStatus ? { stateStatus: semanticStatus } : {}),
      ...(boardColumn ? { boardColumn } : {}),
      ...(folderStatus ? { folderStatus } : {}),
      ...(source ? { source } : {}),
      ownerAgentId: task.ownerAgentId ?? null,
      ...(task.lastImplementedByAgentId ? { lastImplementedByAgentId: task.lastImplementedByAgentId } : {}),
      ...(awaitingPhaseSession ? { awaitingPhaseSession } : {}),
      ...(openReviewRequest ? { openReviewRequest } : {}),
      ...(optionalTrimmedString(taskRecord.preferredOwnerAgentId)
        ? { preferredOwnerAgentId: optionalTrimmedString(taskRecord.preferredOwnerAgentId) }
        : {}),
      ...(typeof task.model === 'string' && task.model.trim() ? { model: task.model.trim() } : {}),
      ...(typeof task.cli === 'string' && task.cli.trim() ? { cli: task.cli.trim() } : {}),
      dependsOn: stringArray(task.dependsOn),
      ownedPaths: stringArray(task.ownedPaths),
      acceptanceCriteria: stringArray(task.acceptanceCriteria),
      implementationNotes: stringArray(task.implementationNotes),
      evidence: normalizeSprintEngineTaskEvidence(task.evidence),
      ...(feedback ? { feedback } : {}),
      ...(feedbackAssessments.length > 0 ? { feedbackAssessments } : {}),
      ...(triage ? { triage } : {}),
      ...(needsInput ? { needsInput } : {}),
      notes: stringArray(task.notes),
      comments: normalizeSprintEngineTaskComments(task.comments),
      startedAt: task.startedAt ?? null,
      completedAt: task.completedAt ?? null,
      ...(activity.length > 0 ? { activity } : {}),
      // `phases` is null when the task inherits the run default and `[]` when the
      // architect explicitly trimmed every phase — the two must not collapse.
      ...(phases ? { phases } : {}),
      ...(latestComments.length > 0 ? { latestComments } : {}),
      ...(latestOpenFeedback.length > 0 ? { latestOpenFeedback } : {}),
      ...(recordedArtifacts.length > 0 ? { recordedArtifacts } : {}),
    }
  })

  const roleCounts = normalizeSprintEngineRoleCounts(input.roleCounts)

  return {
    name: input.name?.trim() || 'Sprint Roster',
    goal: input.goal ?? '',
    rosterConfigured: Boolean(input.rosterConfigured),
    // Preserve the stored cancel flag through both the projection normalizer and
    // the renderer persist/HMR round-trip, so a canceled run reloads canceled.
    ...(input.canceled ? { canceled: true as const } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.sourceBundle ? { sourceBundle: input.sourceBundle } : {}),
    updatedAt: input.updatedAt ?? null,
    roleCounts,
    sprintEngineAgents: input.sprintEngineAgents && Object.keys(input.sprintEngineAgents).length > 0
      // Persisted renderer state can carry a legacy `left`/`dead` status from
      // before liveness was derived; coerce each to `idle` so it loads clean.
      ? Object.fromEntries(
          Object.entries(input.sprintEngineAgents).map(([id, agent]) => [
            id,
            { ...agent, status: coerceSprintEngineRuntimeAgentStatus(agent.status) },
          ])
        )
      : Object.fromEntries(buildSprintEngineAgentRoster(roleCounts).map((a) => [a.id, { role: a.role, status: 'idle' as const, currentTaskId: null }])),
    events: input.events ?? [],
    tasks,
    artifacts: normalizeSprintEngineArtifacts(input.artifacts),
    ...(input.projection ? { projection: input.projection } : {}),
    ...(input.locks ? { locks: input.locks } : {}),
    ...(input.creation ? { creation: input.creation } : {}),
    ...(input.runner ? { runner: input.runner } : {}),
    ...(input.useWorktrees ? { useWorktrees: true } : {}),
    ...(input.vcs ? { vcs: input.vcs } : {}),
    ...((): Partial<Pick<SprintEngineState, 'workers'>> => {
      // Re-normalize the workers view so persisted renderer state carrying a
      // legacy status coerces clean, mirroring sprintEngineAgents above. Empty
      // is omitted; consumers fall back to sprintEngineAgents / roleCounts.
      if (!input.workers) return {}
      const workers = normalizeProjectionWorkers(input.workers)
      return Object.keys(workers).length > 0 ? { workers } : {}
    })(),
    ...((): Partial<Pick<SprintEngineState, 'roleRuntimes'>> => {
      const roleRuntimes = normalizeSprintEngineRoleRuntimes(input.roleRuntimes)
      return roleRuntimes ? { roleRuntimes } : {}
    })(),
    ...((): Partial<Pick<SprintEngineState, 'configuredRoles'>> => {
      const configuredRoles = normalizeSprintEngineConfiguredRoles(input.configuredRoles)
      return configuredRoles ? { configuredRoles } : {}
    })(),
    ...((): Partial<Pick<SprintEngineState, 'rosterSource'>> => {
      const rosterSource = normalizeSprintEngineRosterSource(input.rosterSource)
      return rosterSource ? { rosterSource } : {}
    })(),
    ...((): Partial<Pick<SprintEngineState, 'allowedRuntimes'>> => {
      const allowedRuntimes = normalizeSprintEngineAllowedRuntimes(input.allowedRuntimes)
      return allowedRuntimes ? { allowedRuntimes } : {}
    })(),
    ...((): Partial<Pick<SprintEngineState, 'defaultPhases'>> => {
      // An empty array is truthy, so an explicit no-review run survives here.
      const defaultPhases = normalizeSprintEngineDefaultPhases(input.defaultPhases)
      return defaultPhases ? { defaultPhases } : {}
    })(),
  }
}

function normalizeProjectionLockReports(value: unknown): SprintEngineProjectionLockReport[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): SprintEngineProjectionLockReport[] => {
    if (!entry || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    const name = optionalTrimmedString(record.name)
    if (!name) return []
    const age = typeof record.ageSeconds === 'number' ? record.ageSeconds : null
    const ownerRecord = record.owner && typeof record.owner === 'object' ? record.owner as Record<string, unknown> : null
    const owner = ownerRecord
      ? {
          ...(typeof ownerRecord.pid === 'number' ? { pid: ownerRecord.pid } : {}),
          ...(typeof ownerRecord.createdAt === 'string' ? { createdAt: ownerRecord.createdAt } : {}),
        }
      : null
    return [{
      name,
      exists: Boolean(record.exists),
      stale: Boolean(record.stale),
      ageSeconds: age,
      owner,
    }]
  })
}

function normalizeProjectionLockWarnings(value: unknown): SprintEngineProjectionLockWarning[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): SprintEngineProjectionLockWarning[] => {
    if (!entry || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    const name = optionalTrimmedString(record.name)
    const message = optionalTrimmedString(record.message)
    if (!name || !message) return []
    const age = typeof record.ageSeconds === 'number' ? record.ageSeconds : null
    return [{ name, message, ageSeconds: age }]
  })
}

function normalizeProjectionLocks(value: unknown): SprintEngineProjectionLocks | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const locks = normalizeProjectionLockReports(record.locks)
  const warnings = normalizeProjectionLockWarnings(record.warnings)
  if (locks.length === 0 && warnings.length === 0) return undefined
  return { locks, warnings }
}

// Seed docs recorded at run creation, carried on the projected run payload:
// `source` is the root plan doc, `sourceBundle` the attached reference docs.
// A valid item always carries kind/origin/path (see run.py); drop anything
// missing them rather than fabricating, so the "Started from" UI never shows a
// half-formed seed doc.
function normalizeSprintEngineSource(value: unknown): SprintEngineSource | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const kind = optionalTrimmedString(record.kind)
  const origin = optionalTrimmedString(record.origin)
  const path = optionalTrimmedString(record.path)
  if (!kind || !origin || !path) return undefined
  const planKind = optionalTrimmedString(record.planKind)
  const originalPath = optionalTrimmedString(record.originalPath)
  const capturedAt = optionalTrimmedString(record.capturedAt)
  return {
    kind,
    origin,
    path,
    ...(planKind ? { planKind } : {}),
    ...(originalPath ? { originalPath } : {}),
    ...(capturedAt ? { capturedAt } : {}),
  }
}

function normalizeSprintEngineSourceBundle(value: unknown): SprintEngineSourceBundleStateItem[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.flatMap((entry): SprintEngineSourceBundleStateItem[] => {
    if (!entry || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    const kind = optionalTrimmedString(record.kind)
    const origin = optionalTrimmedString(record.origin)
    const path = optionalTrimmedString(record.path)
    if (!kind || !origin || !path) return []
    const originalPath = optionalTrimmedString(record.originalPath)
    const capturedAt = optionalTrimmedString(record.capturedAt)
    return [{
      kind,
      origin,
      path,
      ...(originalPath ? { originalPath } : {}),
      ...(capturedAt ? { capturedAt } : {}),
    }]
  })
  return items.length > 0 ? items : undefined
}

function normalizeProjectionCreation(value: unknown): SprintEngineProjectionCreation | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const source = optionalTrimmedString(record.source)
  const createdAt = optionalTrimmedString(record.createdAt)
  const updatedAt = optionalTrimmedString(record.updatedAt)
  if (!source && !createdAt && !updatedAt) return undefined
  return {
    ...(source ? { source } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  }
}

function normalizeCurrentDispatch(value: unknown): SprintEngineRuntimeAgent['currentDispatch'] {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const dispatchId = optionalTrimmedString(record.dispatchId) ?? optionalTrimmedString(record.id) ?? null
  const targetKind = optionalTrimmedString(record.targetKind) ?? null
  const role = normalizeSprintEngineRoleId(record.role)
  return {
    dispatchId,
    targetKind,
    ...(role ? { role } : {}),
    ...(optionalTrimmedString(record.reason) ? { reason: optionalTrimmedString(record.reason) } : {}),
    ...(optionalTrimmedString(record.taskId) ? { taskId: optionalTrimmedString(record.taskId) } : {}),
    ...(optionalTrimmedString(record.artifactId) ? { artifactId: optionalTrimmedString(record.artifactId) } : {}),
    ...(optionalTrimmedString(record.assignedAt) ? { assignedAt: optionalTrimmedString(record.assignedAt) } : {}),
  }
}

function projectionSourceValue(value: unknown): SprintEngineProjectionSource {
  return value === 'folder_store' || value === 'unavailable'
    ? value
    : 'folder_store'
}

// Agent liveness is derived, not stored (T1): a departed agent persists as
// `idle`, and the core never writes a terminal `left`/`dead` status. Any value
// outside the modelled set — including legacy on-disk `left`/`dead` from before
// the unification — coerces to `idle` so a stale payload loads without a type
// violation and reads as idle.
const SPRINT_ENGINE_RUNTIME_AGENT_STATUSES: ReadonlySet<SprintEngineRuntimeAgent['status']> = new Set([
  'idle',
  'running',
  'needs_input',
  'done',
  'retired',
])

function coerceSprintEngineRuntimeAgentStatus(value: unknown): SprintEngineRuntimeAgent['status'] {
  return typeof value === 'string' && SPRINT_ENGINE_RUNTIME_AGENT_STATUSES.has(value as SprintEngineRuntimeAgent['status'])
    ? (value as SprintEngineRuntimeAgent['status'])
    : 'idle'
}

// Shared base for the roster bridge and the canonical workers view: both carry
// the runtime-agent fields the board reads. Accepts any registry-keyed role id
// (bundled or custom); an entry with a fully missing/empty role is dropped.
function normalizeRuntimeAgentRecord(record: Record<string, unknown>): SprintEngineRuntimeAgent | null {
  const roleId = normalizeSprintEngineRoleId(record.role)
  if (!roleId) return null
  return {
    role: roleId,
    status: coerceSprintEngineRuntimeAgentStatus(record.status),
    currentTaskId: typeof record.currentTaskId === 'string' ? record.currentTaskId : null,
    ...(typeof record.lastOwnedTaskId === 'string' && record.lastOwnedTaskId
      ? { lastOwnedTaskId: record.lastOwnedTaskId }
      : {}),
    currentDispatch: normalizeCurrentDispatch(record.currentDispatch),
  }
}

function normalizeProjectionRoster(value: unknown): Record<string, SprintEngineRuntimeAgent> {
  if (!value || typeof value !== 'object') return {}
  const result: Record<string, SprintEngineRuntimeAgent> = {}
  for (const [agentId, agent] of Object.entries(value as Record<string, unknown>)) {
    if (!agent || typeof agent !== 'object') continue
    const base = normalizeRuntimeAgentRecord(agent as Record<string, unknown>)
    if (base) result[agentId] = base
  }
  return result
}

// Canonical v3 worker view (`projection.workers`, MC-1591). A superset of the
// roster bridge: same runtime-agent fields plus the recorded lease session and
// the tasks the worker has owned. The roster bridge (`projection.roster`) shares
// the runtime-agent fields, so this same parser accepts either shape — the
// fallback path feeds it the roster when a projection predates `workers`.
function normalizeProjectionWorkers(value: unknown): Record<string, SprintEngineWorker> {
  if (!value || typeof value !== 'object') return {}
  const result: Record<string, SprintEngineWorker> = {}
  for (const [workerId, worker] of Object.entries(value as Record<string, unknown>)) {
    if (!worker || typeof worker !== 'object') continue
    const record = worker as Record<string, unknown>
    const base = normalizeRuntimeAgentRecord(record)
    if (!base) continue
    const sessionId = optionalTrimmedString(record.sessionId)
    const repo = optionalTrimmedString(record.repo)
    const ownedTaskIds = Array.isArray(record.ownedTaskIds)
      ? record.ownedTaskIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : []
    result[workerId] = {
      ...base,
      ...(sessionId ? { sessionId } : {}),
      ...(repo ? { repo } : {}),
      ...(ownedTaskIds.length > 0 ? { ownedTaskIds } : {}),
    }
  }
  return result
}

/**
 * Convert a folder-store `projection.json` payload into the SprintEngineState
 * shape the renderer panels consume. The projection is the single source of
 * truth for board columns, activity, lock warnings, and run metadata.
 */
export function normalizeSprintEngineProjection(
  input: unknown,
  fallbackName?: string,
): SprintEngineState | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const runRecord = record.run && typeof record.run === 'object' ? record.run as Record<string, unknown> : {}

  const roster = normalizeProjectionRoster(record.roster)
  // Canonical lease-derived workers view (MC-1591): read `projection.workers`
  // when the field is present, and fall back to the `projection.roster` bridge
  // only when it is absent (pre-v3 projections carry no `workers`).
  const workers = normalizeProjectionWorkers(
    record.workers !== undefined ? record.workers : record.roster,
  )
  const rawTasks = Array.isArray(record.tasks) ? record.tasks : []
  const rawArtifacts = Array.isArray(record.artifacts) ? record.artifacts : []
  const rawActivity = Array.isArray(record.activity) ? record.activity : []

  const events = rawActivity.flatMap((event): SprintEngineState['events'] => {
    if (!event || typeof event !== 'object') return []
    const e = event as Record<string, unknown>
    if (typeof e.id !== 'string' || typeof e.timestamp !== 'string' || typeof e.type !== 'string' || typeof e.actor !== 'string') {
      return []
    }
    return [{
      id: e.id,
      timestamp: e.timestamp,
      type: e.type,
      actor: e.actor,
      message: typeof e.message === 'string' ? e.message : '',
      ...(typeof e.targetAgentId === 'string' ? { targetAgentId: e.targetAgentId } : {}),
      ...(typeof e.taskId === 'string' ? { taskId: e.taskId } : {}),
      ...(typeof e.artifactId === 'string' ? { artifactId: e.artifactId } : {}),
      ...(typeof e.notificationKind === 'string' ? { notificationKind: e.notificationKind } : {}),
    }]
  })

  // Counts are derived from the run's ACTUAL seated roster. An empty roster
  // yields the zero roster, never a starter team — a run with nobody on it must
  // not read back as "product + developer are staffed".
  const fallbackRoleCounts = createEmptySprintEngineRoleCounts()
  for (const role of Object.keys(fallbackRoleCounts) as SprintEngineRole[]) fallbackRoleCounts[role] = 0
  for (const agent of Object.values(roster)) {
    const role = normalizeSprintEngineRoleId(agent.role)
    if (role) fallbackRoleCounts[role] = (fallbackRoleCounts[role] ?? 0) + 1
  }
  const hasRosterCounts = Object.values(fallbackRoleCounts).some((count) => count > 0)
  const roleCounts = hasRosterCounts ? fallbackRoleCounts : createEmptySprintEngineRoleCounts()

  const candidate: SprintEngineState = {
    name: optionalTrimmedString(runRecord.name) ?? fallbackName ?? 'Sprint Roster',
    goal: typeof runRecord.goal === 'string' ? runRecord.goal : '',
    rosterConfigured: Boolean(runRecord.rosterConfigured),
    // Stored run-level cancel flag, surfaced from the projection's run status
    // (`sprintengine.canceled` drives `run.status === 'canceled'`). Only set when
    // true so a normal run's state object stays unchanged. Read via
    // `isCanceledSprintEngineRun`, never derived from task-completeness.
    ...(runRecord.status === 'canceled' ? { canceled: true as const } : {}),
    updatedAt: optionalTrimmedString(runRecord.updatedAt) ?? optionalTrimmedString(record.updatedAt) ?? null,
    roleCounts,
    sprintEngineAgents: Object.keys(roster).length > 0
      ? roster
      : Object.fromEntries(buildSprintEngineAgentRoster(roleCounts).map((a) => [a.id, { role: a.role, status: 'idle' as const, currentTaskId: null }])),
    workers,
    events,
    tasks: rawTasks as SprintEngineState['tasks'],
    artifacts: rawArtifacts as SprintEngineState['artifacts'],
    projection: {
      source: projectionSourceValue(record.source),
      updatedAt: optionalTrimmedString(record.updatedAt) ?? null,
      generatedAt: optionalTrimmedString(record.generatedAt) ?? null,
    },
    ...(normalizeProjectionLocks(record.locks) ? { locks: normalizeProjectionLocks(record.locks) } : {}),
    ...(normalizeProjectionCreation(runRecord.creation) ? { creation: normalizeProjectionCreation(runRecord.creation) } : {}),
    ...(normalizeSprintEngineRunnerPolicy(runRecord.runner)
      ? { runner: normalizeSprintEngineRunnerPolicy(runRecord.runner) }
      : {}),
    ...(normalizeSprintEngineVcs(runRecord.vcs) ? { vcs: normalizeSprintEngineVcs(runRecord.vcs), useWorktrees: true } : {}),
    ...((): Partial<Pick<SprintEngineState, 'roleRuntimes'>> => {
      const roleRuntimes = normalizeSprintEngineRoleRuntimes(runRecord.roleRuntimes)
      return roleRuntimes ? { roleRuntimes } : {}
    })(),
    ...((): Partial<Pick<SprintEngineState, 'configuredRoles'>> => {
      const configuredRoles = normalizeSprintEngineConfiguredRoles(runRecord.configuredRoles)
      return configuredRoles ? { configuredRoles } : {}
    })(),
    ...((): Partial<Pick<SprintEngineState, 'rosterSource'>> => {
      const rosterSource = normalizeSprintEngineRosterSource(runRecord.rosterSource)
      return rosterSource ? { rosterSource } : {}
    })(),
    ...((): Partial<Pick<SprintEngineState, 'allowedRuntimes'>> => {
      const allowedRuntimes = normalizeSprintEngineAllowedRuntimes(runRecord.allowedRuntimes)
      return allowedRuntimes ? { allowedRuntimes } : {}
    })(),
    ...((): Partial<Pick<SprintEngineState, 'defaultPhases'>> => {
      const defaultPhases = normalizeSprintEngineDefaultPhases(runRecord.defaultPhases)
      return defaultPhases ? { defaultPhases } : {}
    })(),
    ...((): Partial<Pick<SprintEngineState, 'source'>> => {
      const source = normalizeSprintEngineSource(runRecord.source)
      return source ? { source } : {}
    })(),
    ...((): Partial<Pick<SprintEngineState, 'sourceBundle'>> => {
      const sourceBundle = normalizeSprintEngineSourceBundle(runRecord.sourceBundle)
      return sourceBundle ? { sourceBundle } : {}
    })(),
  }

  return normalizeSprintEngineState(candidate)
}

/**
 * Newest-first activity for inspector display. The projection stores activity
 * oldest-first; the inspector prioritizes the most recent handoff signal.
 */
export function getSprintEngineTaskActivityDescending(
  task: Pick<SprintEngineTask, 'activity'>,
): SprintEngineTaskActivityEntry[] {
  const activity = task.activity ?? []
  return [...activity].sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''))
}

export type SprintEngineAgentWorkedOnTask = {
  task: SprintEngineTask
  latestActivityAt: string | null
}

/**
 * Tasks the agent has any recorded activity on. Most useful as the "did /
 * completed / in-flight" view in the agent inspector, since ownerAgentId is
 * cleared the moment a task moves out of in_progress so it can't survive as
 * a historical record.
 *
 * Returned newest-first by the agent's latest activity timestamp.
 */
export function getSprintEngineTasksWorkedOnByAgent(
  agentId: string,
  tasks: ReadonlyArray<SprintEngineTask>,
): SprintEngineAgentWorkedOnTask[] {
  const out: SprintEngineAgentWorkedOnTask[] = []
  for (const task of tasks) {
    let latest: string | null = null
    let matched = false
    for (const entry of task.activity ?? []) {
      if (entry.actor !== agentId) continue
      matched = true
      const stamp = entry.timestamp || null
      if (stamp && (!latest || stamp > latest)) latest = stamp
    }
    if (!matched) continue
    out.push({ task, latestActivityAt: latest })
  }
  out.sort((a, b) => (b.latestActivityAt ?? '').localeCompare(a.latestActivityAt ?? ''))
  return out
}

export type SprintEngineAgentActivityEntry = {
  entry: SprintEngineTaskActivityEntry
  taskId: string
  taskTitle: string
  taskStatus: SprintEngineTask['status']
}

/**
 * Newest-first activity entries authored by `agentId` across every task,
 * decorated with the task context the agent view needs to render them.
 */
export function getSprintEngineAgentActivityDescending(
  agentId: string,
  tasks: ReadonlyArray<SprintEngineTask>,
): SprintEngineAgentActivityEntry[] {
  const out: SprintEngineAgentActivityEntry[] = []
  for (const task of tasks) {
    for (const entry of task.activity ?? []) {
      if (entry.actor !== agentId) continue
      out.push({ entry, taskId: task.id, taskTitle: task.title, taskStatus: task.status })
    }
  }
  out.sort((a, b) => (b.entry.timestamp ?? '').localeCompare(a.entry.timestamp ?? ''))
  return out
}

/**
 * Open feedback items the inspector should surface above secondary metadata —
 * issues and findings whose status is still active (not applied/rejected/fixed).
 */
export function getOpenSprintEngineFeedbackIssues(
  feedback: SprintEngineTaskFeedback | undefined,
): SprintEngineTaskFeedbackIssue[] {
  if (!feedback?.issues) return []
  return feedback.issues.filter((issue) => {
    const status = issue.status ?? 'new'
    return status !== 'applied' && status !== 'rejected'
  })
}

export function getOpenSprintEngineFeedbackFindings(
  feedback: SprintEngineTaskFeedback | undefined,
): SprintEngineTaskFeedbackFinding[] {
  if (!feedback?.findings) return []
  return feedback.findings.filter((finding) => {
    const status = finding.status ?? 'open'
    return status !== 'fixed' && status !== 'rejected'
  })
}

export function hasOpenSprintEngineFeedback(
  feedback: SprintEngineTaskFeedback | undefined,
): boolean {
  if (!feedback) return false
  return getOpenSprintEngineFeedbackIssues(feedback).length > 0
    || getOpenSprintEngineFeedbackFindings(feedback).length > 0
}

/**
 * Convert a folder-store lock age (seconds) into a compact human label, e.g.
 * `12s`, `4m`, `2h`. Used by the lock warning surface to communicate how long
 * the stale lock has been held without leaking absolute timestamps.
 */
export function formatSprintEngineLockAge(ageSeconds: number | null | undefined): string {
  if (typeof ageSeconds !== 'number' || !Number.isFinite(ageSeconds) || ageSeconds < 0) return 'unknown age'
  if (ageSeconds < 60) return `${Math.round(ageSeconds)}s`
  const minutes = ageSeconds / 60
  if (minutes < 60) return `${Math.round(minutes)}m`
  const hours = minutes / 60
  if (hours < 24) return `${Math.round(hours * 10) / 10}h`
  const days = hours / 24
  return `${Math.round(days * 10) / 10}d`
}

export function getLatestSprintEngineTaskComment(
  task: Pick<SprintEngineTask, 'comments' | 'latestComments'>,
  type: SprintEngineTaskCommentType
): SprintEngineTaskComment | undefined {
  const pool: SprintEngineTaskComment[] = [
    ...(task.latestComments ?? []),
    ...(task.comments ?? []),
  ]
  let latest: SprintEngineTaskComment | undefined
  for (const comment of pool) {
    if (comment.type !== type) continue
    if (!latest || (comment.createdAt ?? '').localeCompare(latest.createdAt ?? '') > 0) {
      latest = comment
    }
  }
  return latest
}

export function getOpenSprintEngineFeedbackComments(
  task: Pick<SprintEngineTask, 'latestOpenFeedback'>
): SprintEngineTaskComment[] {
  return [...(task.latestOpenFeedback ?? [])].sort((a, b) =>
    (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
  )
}

/**
 * Convert a `#rrggbb` hex string to an `rgba(...)` string with the given alpha.
 * Colocated here because every caller pairs it with `sprintEngineRoleAccent`
 * to render the role-tinted avatar / backplate documented in
 * knowledge/brand/panel-design-system.md.
 */
export function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  const red = parseInt(value.slice(0, 2), 16)
  const green = parseInt(value.slice(2, 4), 16)
  const blue = parseInt(value.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

// Sprint Engine board view-model helpers — pure derivations consumed by the
// board shell, model hook, and sub-views. Kept testable so the board panel can
// stay a thin composition over them.

export type SprintEngineBoardRuntimeAgentView = {
  agentId: string
  role: SprintEngineRoleId
  status: string
}

export type SprintEngineBoardRunPhase = 'Planning' | 'Tasked' | 'Running' | 'Complete'

/**
 * Resolve the high-level run-phase label rendered in the board hero. Driven by
 * task completion + active runtime agent states, not by surface chrome.
 */
export function getSprintEngineBoardRunPhase(
  sprintEngineState: Pick<SprintEngineState, 'tasks'>,
  runtimeAgents: SprintEngineBoardRuntimeAgentView[],
): SprintEngineBoardRunPhase {
  if (isCompletedSprintEngineRun(sprintEngineState)) {
    return 'Complete'
  }
  if (runtimeAgents.some((agent) => agent.status === 'running' || agent.status === 'needs_input')) {
    return 'Running'
  }
  if (sprintEngineState.tasks.length > 0) {
    return 'Tasked'
  }
  return 'Planning'
}

/**
 * Resolve the per-task owner label shown in the inspector and kanban detail.
 * Resolution order: the active owner, then the worker who last published an
 * implementation pass (the task carries this through its `review` phase),
 * then the role label for `done` tasks, and finally the explicit
 * "No active worker" copy for tasks that were never implemented.
 */
export function getSprintEngineTaskOwnerLabel(
  task: Pick<SprintEngineTask, 'ownerAgentId' | 'lastImplementedByAgentId' | 'role' | 'status'>,
  rosterById: Record<string, { label: string } | undefined>,
): string {
  const ownerId = task.ownerAgentId ?? task.lastImplementedByAgentId ?? null
  if (ownerId) {
    return rosterById[ownerId]?.label ?? ownerId
  }
  return task.status === 'done' ? getSprintEngineRoleLabel(task.role) : 'No active worker'
}

/** One row in the task inspector's implementer timeline. */
export type SprintEngineTaskImplementerEntry = {
  agentId: string
  label: string
  role: SprintEngineRoleId | null
  /** This worker's own completed rounds (their implementation comments). */
  passCount: number
  /** ISO timestamp of this worker's latest implementation pass, if any. */
  lastActivityAt: string | null
  /** True when this worker currently holds the active claim (`ownerAgentId`). */
  isActive: boolean
  /** Runtime status (running/needs_input/error/exited/…) — only resolved for
   *  the active worker; null for historical rows. */
  runtimeStatus: string | null
}

/** Minimal runtime-agent shape the timeline needs to resolve labels/roles. */
export type SprintEngineImplementerRuntimeAgent = {
  agentId: string
  label: string
  role: SprintEngineRoleId
  status: string
}

/**
 * Build the per-worker implementer timeline for a task. Each hand-off to review
 * records an `implementation_summary` (first pass) or `implementation_response`
 * (rework pass) comment, so passes group by author into one row per worker.
 * The active claim (`ownerAgentId`) sorts first; remaining workers follow by
 * most-recent activity. Reassignment therefore surfaces the new owner on top
 * while each worker keeps their own tick count.
 */
export function getSprintEngineTaskImplementerTimeline(
  task: Pick<SprintEngineTask, 'comments' | 'ownerAgentId' | 'lastImplementedByAgentId' | 'role'>,
  runtimeAgents: readonly SprintEngineImplementerRuntimeAgent[],
): SprintEngineTaskImplementerEntry[] {
  const runtimeById = new Map(runtimeAgents.map((agent) => [agent.agentId, agent]))
  const ownerId = task.ownerAgentId ?? null

  type Accumulator = {
    agentId: string
    passCount: number
    lastActivityAt: string | null
    role: SprintEngineRoleId | null
  }
  const byAgent = new Map<string, Accumulator>()

  const comments = Array.isArray(task.comments) ? task.comments : []
  for (const comment of comments) {
    if (comment.type !== 'implementation_summary' && comment.type !== 'implementation_response') {
      continue
    }
    const agentId = (comment.authorAgentId ?? comment.actor ?? '').trim()
    if (!agentId) continue
    const entry = byAgent.get(agentId) ?? {
      agentId,
      passCount: 0,
      lastActivityAt: null,
      role: normalizeSprintEngineRoleId(comment.authorRole) ?? null,
    }
    entry.passCount += 1
    const createdAt = (comment.createdAt ?? '').trim()
    if (createdAt && (!entry.lastActivityAt || createdAt > entry.lastActivityAt)) {
      entry.lastActivityAt = createdAt
    }
    if (!entry.role) entry.role = normalizeSprintEngineRoleId(comment.authorRole) ?? null
    byAgent.set(agentId, entry)
  }

  // Ensure the active owner appears even before they publish their first pass,
  // and guard against trimmed comments by seeding the recorded last implementer.
  for (const seedId of [ownerId, task.lastImplementedByAgentId ?? null]) {
    if (seedId && !byAgent.has(seedId)) {
      byAgent.set(seedId, { agentId: seedId, passCount: 0, lastActivityAt: null, role: null })
    }
  }

  const entries: SprintEngineTaskImplementerEntry[] = Array.from(byAgent.values()).map((acc) => {
    const runtime = runtimeById.get(acc.agentId)
    const isActive = acc.agentId === ownerId
    return {
      agentId: acc.agentId,
      label: runtime?.label ?? acc.agentId,
      role: acc.role ?? runtime?.role ?? task.role ?? null,
      passCount: acc.passCount,
      lastActivityAt: acc.lastActivityAt,
      isActive,
      runtimeStatus: isActive ? runtime?.status ?? null : null,
    }
  })

  entries.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1
    const aTime = a.lastActivityAt ?? ''
    const bTime = b.lastActivityAt ?? ''
    if (aTime !== bTime) return aTime > bTime ? -1 : 1
    return a.label.localeCompare(b.label)
  })

  return entries
}

/**
 * Per-column empty-state copy for the kanban layout. Each column maps to a
 * single sentence; the board panel renders the result as the column's empty
 * placeholder line.
 */
export function getSprintEngineKanbanEmptyMessage(column: SprintEngineTaskBoardColumn): string {
  switch (column) {
    case 'ready':
      return 'No ready work. Waiting on dependencies or active agents.'
    case 'in_progress':
      return 'No agents are actively claiming tasks.'
    case 'review':
      return 'No one is reviewing their own work right now.'
    case 'needs_input':
      return 'No blocked tasks or agent questions.'
    case 'done':
      return 'Completed work will collect here.'
    case 'todo':
      return 'Planned tasks that are waiting on dependencies appear here.'
    case 'canceled':
      return 'Canceled tasks are not shown on the board.'
  }
}

/**
 * Wrap text in xterm bracketed-paste markers so multi-line agent prompts are
 * pasted as a single block when written to a live terminal session.
 */
export function bracketedTerminalPaste(text: string): string {
  return `\x1b[200~${text.replace(/\r?\n/g, '\n')}\x1b[201~\r`
}

function normalizeComparableArtifactPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized
}

/**
 * True when `targetPath` equals `parentDir` or is nested under it, after
 * normalizing slashes and Windows drive-letter casing. Path containment check
 * used by the artifact path resolver.
 */
export function isPathInsideOrEqual(parentDir: string, targetPath: string): boolean {
  const parent = normalizeComparableArtifactPath(parentDir)
  const target = normalizeComparableArtifactPath(targetPath)
  return target === parent || target.startsWith(`${parent}/`)
}

/**
 * Resolve a Sprint Engine artifact path (as written into the projection) to an
 * absolute file path safe to open in the editor. Rejects remote URLs,
 * parent-relative traversal, and paths that resolve outside the Sprint Engine
 * team directory. The {@link parentPath} and {@link joinFilePath} helpers are
 * passed in so this util stays decoupled from any specific filesystem adapter.
 */
export function resolveSprintEngineArtifactEditorPath(
  statePath: string,
  artifactPathInput: string,
  helpers: {
    parentPath: (path: string) => string
    joinFilePath: (a: string, b: string) => string
    isAbsoluteFilePath: (path: string) => boolean
  },
): string {
  const { parentPath, joinFilePath, isAbsoluteFilePath } = helpers
  const artifactPath = artifactPathInput.trim()
  if (!artifactPath) throw new Error('Artifact path is required.')
  if (/^https?:\/\//i.test(artifactPath)) {
    throw new Error('Remote artifact links cannot be opened in the editor.')
  }
  if (artifactPath.split(/[\\/]+/).includes('..')) {
    throw new Error('Artifact path must stay inside the sprint team directory.')
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/i.test(artifactPath) && !isAbsoluteFilePath(artifactPath)) {
    throw new Error('Only workspace artifact file paths can be opened.')
  }

  const teamDirectory = parentPath(statePath)
  const workspaceRoot = parentPath(parentPath(parentPath(teamDirectory)))
  const targetPath = isAbsoluteFilePath(artifactPath)
    ? artifactPath
    : [
        joinFilePath(workspaceRoot, artifactPath),
        joinFilePath(teamDirectory, artifactPath),
      ].find((candidate) => isPathInsideOrEqual(teamDirectory, candidate))
      ?? joinFilePath(workspaceRoot, artifactPath)

  if (!isPathInsideOrEqual(teamDirectory, targetPath)) {
    throw new Error('Artifact path must stay inside the sprint team directory.')
  }

  return targetPath
}

/**
 * Resolve a roster role's CLI + model from the run's `roleRuntimes` map
 * (run.yaml via the projection — the single source of truth for what every
 * spawn of that role must launch with, MC-1450). Returns null when the role
 * is not in the map (legacy runs mid-flight, pre-first-projection window):
 * callers must then preserve what they already have — never substitute.
 * An entry without a model resolves `cliModel: undefined` = no `--model`
 * flag (the CLI's own default, deliberately).
 *
 * Moved verbatim from `store/slices/runStateSlice.ts` (which re-exports it)
 * so the shared auto-run planner path can resolve runtimes without the store.
 */
export function resolveSprintEngineRoleRuntime(
  roleRuntimes: SprintEngineRoleRuntimes | undefined,
  role: SprintEngineRoleId
): { cli?: AgentCli; cliModel?: string } | null {
  const runtime = roleRuntimes?.[role]
  if (!runtime) return null
  return {
    cli: typeof runtime.cli === 'string' && runtime.cli.trim() ? runtime.cli.trim() : undefined,
    cliModel: typeof runtime.model === 'string' && runtime.model.trim() ? runtime.model.trim() : undefined,
  }
}

/**
 * Effective launch runtime for one roster agent, layering the full MC-1450
 * hierarchy: explicit per-agent override (`cliRuntimeOverride` — the board's
 * mid-run picker / creation-time per-agent CLI override) > per-role
 * `roleRuntimes` config > the existing record's values (legacy runs whose
 * projection predates `roleRuntimes`). An override `model: null` pins the
 * CLI's own default even when the role configures a model; a role config with
 * no model resolves `cliModel: undefined` = no `--model` flag.
 *
 * Moved verbatim from `store/slices/runStateSlice.ts` (which re-exports it)
 * so the shared auto-run planner path can resolve runtimes without the store.
 */
export function resolveSprintEngineAgentRuntime(
  roleRuntimes: SprintEngineRoleRuntimes | undefined,
  role: SprintEngineRoleId,
  current: Pick<AgentState, 'cli' | 'cliModel' | 'cliRuntimeOverride'> | undefined,
): { cli?: AgentCli; cliModel?: string } {
  const config = resolveSprintEngineRoleRuntime(roleRuntimes, role)
  const override = current?.cliRuntimeOverride
  const overrideCli = typeof override?.cli === 'string' && override.cli.trim() ? override.cli.trim() : undefined
  const cli = overrideCli ?? config?.cli ?? current?.cli
  const cliModel = override !== undefined && override.model !== undefined
    // `model: null` = explicitly the CLI default; tolerate junk in persisted
    // records by treating any non-string as the CLI default too.
    ? (typeof override.model === 'string' && override.model.trim() ? override.model.trim() : undefined)
    : config
      ? config.cliModel
      : current?.cliModel
  return { cli, cliModel }
}
