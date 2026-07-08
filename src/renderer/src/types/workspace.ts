import type { IJsonModel } from 'flexlayout-react'
import type { OnboardingStep } from '../store/onboardingState'

export type WorkspaceId = string
export type WorkspaceWindowId = string
export type AgentId = string
export const STANDARD_WORKSPACE_MODE = 'standard'
export const SPRINT_ENGINE_WORKSPACE_MODE = 'sprintengine'
export const SWITCHBOARD_WORKSPACE_MODE = 'switchboard'
export const MULTILOOP_WORKSPACE_MODE = 'multiloop'
export const GUIDED_BRIEF_WORKSPACE_MODE = 'guided-brief'
// Background host workspace for per-project Automations. It is hidden from the
// normal workspace rail (see `utils/workspaceVisibility.ts`); its hidden-ness is
// derived from this mode, never a persisted flag, so no store migration exists.
export const AUTOMATIONS_HOST_WORKSPACE_MODE = 'automations-host'

export type BundledWorkspaceMode =
  | typeof STANDARD_WORKSPACE_MODE
  | typeof SPRINT_ENGINE_WORKSPACE_MODE
  | typeof SWITCHBOARD_WORKSPACE_MODE
  | typeof MULTILOOP_WORKSPACE_MODE
  | typeof GUIDED_BRIEF_WORKSPACE_MODE
  | typeof AUTOMATIONS_HOST_WORKSPACE_MODE

export type WorkspaceMode = typeof STANDARD_WORKSPACE_MODE | (string & {})

export type HighlightColor = 'red' | 'orange' | 'amber' | 'green' | 'blue' | 'purple' | 'pink'

export type WorkspaceHighlight = {
  starred: boolean
  color: HighlightColor | null
}

export type PreviewSlot = {
  x: number
  y: number
  w: number
  h: number
  type: 'agent' | 'editor' | 'explorer'
  label: string
}

export type LayoutTemplate = {
  id: string
  name: string
  description: string
  previewSlots: PreviewSlot[]
  layout: IJsonModel
}

// `SprintEngineRole` is the *bundled* Sprint Engine role union shipped under
// `resources/sprintengine/roles/`. It still types bundled config shapes such
// as default skill maps, default role counts, and CLI defaults — those are
// Multicode-owned settings, not pluggable role manifests.
//
// Pluggable/projection-facing surfaces (task.role, gate.role, agent.role,
// comment.authorRole, feedback.role, quality-policy gate.role, runtime agent
// role) must accept any registry-discovered role id, including custom ones
// defined under workspace / user / plugin layers. Those fields use
// `SprintEngineRoleId` below so unknown configured ids round-trip through
// normalization without being coerced or dropped.
export type SprintEngineRole = 'architect' | 'product' | 'developer' | 'frontend' | 'ui_ux_reviewer' | 'tester' | 'security' | 'performance' | 'production_readiness_reviewer' | 'cross_platform'

// Registry-keyed role identifier. Any non-empty string the role registry
// emitted (bundled, workspace, user, or plugin layer). UI/runtime surfaces
// must never index static label/accent maps with this — use the safe
// accessors in `utils/sprintengine.ts`.
export type SprintEngineRoleId = string

export type SprintEngineRoleRegistrySourceLayer =
  | 'bundled'
  | 'workspace'
  | 'user'
  | 'plugin'
  | string

export type SprintEngineRoleRegistryWarning = {
  code: string
  message: string
  roleId?: string
  sourceLayer?: string
}

// Registry-derived metadata for a single role. Mirrors the
// `sprintengine.roles.list` / `sprintengine.roles.get` payload shape. The
// renderer only reads from here; mutations go through the Sprint Engine
// tool. `label`, `summary`, `icon`, and `source.layer` are the only fields
// the renderer currently uses for display; the rest is captured so future
// surfaces (settings tab, soul preview) can grow without re-plumbing the
// type.
export type SprintEngineRoleRegistryMetadata = {
  id: SprintEngineRoleId
  label: string
  aliases: string[]
  summary?: string | null
  icon?: string | null
  source: { layer: SprintEngineRoleRegistrySourceLayer }
  shadowedSources?: { layer: SprintEngineRoleRegistrySourceLayer }[]
  warnings?: SprintEngineRoleRegistryWarning[]
  enabled?: boolean
  // True when the role manifest declares a `sweep` block — i.e. it audits the
  // finished work as its own late task (reviewers + QA), rather than building.
  // The wizard's "Final sweeps" panel enumerates these; derived from the
  // `sweep` field on the `sprintengine.roles.list` payload.
  isSweep?: boolean
}

// Read-only directory the renderer builds from a registry payload. Indexed
// by canonical role id and (via `aliases`) by alias. `warnings` carries any
// registry-level warnings the discovery emitted.
export type SprintEngineRoleRegistry = {
  roles: Record<SprintEngineRoleId, SprintEngineRoleRegistryMetadata>
  aliases: Record<string, SprintEngineRoleId>
  warnings: SprintEngineRoleRegistryWarning[]
}

export type SprintEngineSkillMap = Record<SprintEngineRole, string[]>
export type SprintEngineRoleCounts = Record<SprintEngineRoleId, number>

/**
 * Task lifecycle statuses (MC-1542 single-owner tasks). One agent owns a task
 * from claim to `done`; `review` means "the owner is reviewing the work it just
 * made, in the same session". `changes_requested`, `testing`, and `product` were
 * deleted outright — there is NO read-side tolerance for them (decision 8), and a
 * pre-MC-1542 run store is rejected before its tasks are ever normalized.
 * MIRRORS `VALID_TASK_STATUSES` in sprintengine_core/tool/constants.py.
 */
export type SprintEngineTaskStatus = 'todo' | 'in_progress' | 'review' | 'needs_input' | 'done' | 'canceled'

/** Board columns: todo -> ready -> in progress -> in review -> done, plus needs_input. */
export type SprintEngineTaskBoardColumn = 'todo' | 'ready' | 'in_progress' | 'review' | 'needs_input' | 'done' | 'canceled'

/**
 * Post-implementation phases a task's single owner walks after `task.publish`
 * (MC-1542). Mirrors `VALID_TASK_PHASES` in sprintengine_core/store.py; the
 * runtime list lives at `sprintEngineTaskPhases` in utils/sprintengine.ts and is
 * `satisfies`-bound to this union, so adding a phase in one place fails the build
 * in the other.
 */
export type SprintEngineTaskPhase = 'review'

export type SprintEngineCliWatchPolling = 'enabled' | 'disabled'

export type SprintEngineRunnerPolicy = {
  // `cliWatchPolling` controls whether `sprintengine join --watch` keeps
  // polling for ready work (`enabled`) or exits when nothing is ready
  // (`disabled`). It is a CLI-runtime concern only — Multicode's supervisor
  // ignores it and decides spawning from local renderer autoState alone.
  cliWatchPolling: SprintEngineCliWatchPolling
  pollIntervalSeconds: number
  idleBackoffSeconds: number
  maxBackoffSeconds: number
  stopWhenComplete: boolean
}

export type SprintEngineTaskCommentType =
  | 'implementation_summary'
  | 'implementation_response'
  | 'review_feedback'
  | 'test_feedback'
  | 'product_feedback'
  | 'architect_feedback'
  | 'needs_input'
  | 'user_note'
  | 'system_note'

export type SprintEngineRecordedArtifact = {
  id: string
  kind?: string
  title?: string
  path?: string
  createdBy?: string
  createdAt?: string
}

export type SprintEngineNeedsInputKind = 'architect' | 'user'
export type SprintEngineNeedsInputReason =
  | 'task_scope'
  | 'artifact_review'
  | 'tooling'
  | 'verification'
  | 'product_decision'
  | 'blocked_other'
  | string

export type SprintEngineArtifactKind =
  | 'architect_plan'
  | 'product_strategy'
  | 'requirements'
  | 'html_mockup'
  | 'design_notes'
  | 'branding'
  | 'security_review'
  | 'code_review'
  | 'spec_review'
  | 'performance_review'
  | 'production_readiness_review'
  | 'cross_platform_review'
  | 'validation_report'

export type SprintEngineArtifactStatus =
  | 'draft'
  // A gate/evidence record filed against a task (never a pending decision) — a
  // real Python status the projection emits; the renderer must keep it rather
  // than drop it as unknown.
  | 'recorded'
  | 'ready_for_review'
  | 'approved'
  | 'changes_requested'
  | 'superseded'

// Provenance of an approved artifact: `manual` = a human approved it, `policy` =
// the run's auto-approval policy approved it on the user's behalf. Optional and
// additive — an approval recorded before this field existed omits it and reads
// as a plain (manual) approval.
export type SprintEngineArtifactApprovalMode = 'manual' | 'policy'

export type SprintEngineEvent = {
  id: string
  timestamp: string
  type: string
  actor: string
  message: string
  targetAgentId?: string
  taskId?: string
  artifactId?: string
  notificationKind?: string
}

export type SprintEngineArtifactReviewHistoryEntry = {
  action: string
  actor: string
  timestamp: string
  note?: string
}

export type SprintEngineArtifact = {
  id: string
  // Known kinds get labels and auto-approval; stores written by other Sprint
  // Engine versions may carry kinds this build does not know, and those
  // artifacts must still surface for manual review instead of vanishing.
  kind: SprintEngineArtifactKind | (string & {})
  title: string
  path: string
  status: SprintEngineArtifactStatus
  createdBy: string
  taskId: string
  fingerprint: string | null
  reviewHistory: SprintEngineArtifactReviewHistoryEntry[]
  recommendedTasks: string[]
  createdAt: string | null
  updatedAt: string | null
  approvedBy?: string | null
  approvedAt?: string | null
  approvalMode?: SprintEngineArtifactApprovalMode
  changesRequestedBy?: string | null
  changesRequestedAt?: string | null
}

export type SprintEngineTaskDiffStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type_changed'
  | 'unmerged'
  | 'unknown'

export type SprintEngineTaskDiffSource =
  | 'working_tree'
  | 'staged'
  | 'commit'
  | 'checkpoint'

export type SprintEngineTaskDiffLine = {
  type: 'context' | 'added' | 'removed'
  oldLine: number | null
  newLine: number | null
  content: string
}

export type SprintEngineTaskDiffHunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  section?: string | null
  lines: SprintEngineTaskDiffLine[]
}

export type SprintEngineTaskDiff = {
  path: string
  oldPath?: string | null
  status: SprintEngineTaskDiffStatus
  additions: number
  deletions: number
  capturedAt: string
  capturedBy: string
  source: SprintEngineTaskDiffSource
  binary: boolean
  truncated: boolean
  skippedReason?: string | null
  hunks: SprintEngineTaskDiffHunk[]
}

export type SprintEngineTaskEvidence = {
  summary: string
  touchedFiles: string[]
  commandsRan: string[]
  results: string[]
  diffs?: SprintEngineTaskDiff[]
}

export type SprintEngineTaskComment = {
  id: string
  actor: string
  source: 'user' | 'agent' | 'system'
  body: string
  createdAt: string
  type?: SprintEngineTaskCommentType
  authorAgentId?: string
  authorRole?: SprintEngineRoleId
  paths?: string[]
  data?: Record<string, unknown>
}

export type SprintEngineTaskFeedbackScores = {
  directiveClarityPct?: number
  taskClarityPct?: number
  acceptanceCriteriaClarityPct?: number
  sprintEngineToolEffectivenessPct?: number
  promptOptimizationPct?: number
  contextFitPct?: number
  hallucinationRiskPct?: number
  roleFitPct?: number
  autonomyPct?: number
  confidencePct?: number
}

export type SprintEngineTaskFeedbackIssueCategory =
  | 'system_prompt'
  | 'role_prompt'
  | 'task_card'
  | 'acceptance_criteria'
  | 'context'
  | 'tooling'
  | 'coordination'
  | 'validation'
  | 'permissions'
  | 'ui'
  | 'other'

export type SprintEngineTaskFeedbackIssueSeverity = 'low' | 'medium' | 'high'
export type SprintEngineTaskFeedbackIssueStatus = 'new' | 'reviewed' | 'applied' | 'rejected' | 'deferred'

export type SprintEngineTaskFeedbackIssue = {
  id: string
  category: SprintEngineTaskFeedbackIssueCategory
  severity: SprintEngineTaskFeedbackIssueSeverity
  target?: string
  title: string
  detail: string
  evidence?: string
  suggestedPromptChange?: string
  suggestedProcessChange?: string
  status?: SprintEngineTaskFeedbackIssueStatus
}

export type SprintEngineTaskFeedbackFindingKind =
  | 'code_bug'
  | 'security_issue'
  | 'product_requirement_violation'
  | 'test_gap'
  | 'accessibility_issue'
  | 'performance_issue'
  | 'reliability_issue'
  | 'documentation_gap'
  | 'other'

export type SprintEngineTaskFeedbackFindingSeverity = 'critical' | 'high' | 'medium' | 'low'

export type SprintEngineTaskFeedbackFindingArea =
  | 'frontend'
  | 'backend'
  | 'database'
  | 'networking'
  | 'auth'
  | 'security'
  | 'filesystem'
  | 'cli'
  | 'ipc'
  | 'mobile'
  | 'testing'
  | 'performance'
  | 'docs'
  | 'product'
  | 'other'

export type SprintEngineTaskFeedbackFindingStatus = 'open' | 'accepted' | 'fixed' | 'rejected' | 'deferred'

export type SprintEngineTaskFeedbackFinding = {
  id: string
  kind: SprintEngineTaskFeedbackFindingKind
  severity: SprintEngineTaskFeedbackFindingSeverity
  area: SprintEngineTaskFeedbackFindingArea
  // `findingJson` is categorical-only (kind/area/severity); the actionable text
  // lives in the verdict's requiredAction. `title`/`detail` are optional prose
  // older records may still carry — render them only when present.
  title?: string
  detail?: string
  recommendation?: string
  requirementId?: string
  file?: string
  status?: SprintEngineTaskFeedbackFindingStatus
}

export type SprintEngineTaskFeedback = {
  schemaVersion: number
  capturedAt: string
  source: 'agent_self_report' | string
  agentId: string
  role: SprintEngineRoleId
  scores: SprintEngineTaskFeedbackScores
  topFriction?: string
  suggestedImprovement?: string
  issues?: SprintEngineTaskFeedbackIssue[]
  findings?: SprintEngineTaskFeedbackFinding[]
}

/** Per-agent feedback analysis returned by the `sprintengine.feedback.summarize`
 *  MCP tool (see sprintengine_core/analysis.py `aggregateByAgent`). Self-reported
 *  scores are the worker's own end-of-task scores; measured signals are attributed
 *  to the implementer being reviewed, not the reviewer who logged them. */
export type SprintEngineFeedbackScoreStat = {
  label: string
  averagePct: number
  sampleCount: number
}

export type SprintEngineAgentTaskCounts = {
  reviewSampleCount: number
  counts: Record<string, number>
}

export type SprintEngineAgentMeasuredMetrics = {
  reviewSampleCount: number
  scores: Record<string, SprintEngineFeedbackScoreStat>
  counts: Record<string, number>
  hallucinationRatePct?: number
  findingsAgainst?: { total: number; bySeverity: Record<string, number> }
  /** Per-task review detail for the drill-down, keyed by task id. */
  taskCounts?: Record<string, SprintEngineAgentTaskCounts>
}

/** Reviewer-side activity for an agent that performed reviews. */
/**
 * A fix-forward sweep's activity: the tasks it audited and what it did about what
 * it found. MC-1542 replaced the reviewer/gate-verdict tables with this — a sweep
 * fixes what it finds rather than sending work back.
 */
export type SprintEngineAgentSweepMetrics = {
  tasksAudited: number
  assessmentsRecorded: number
  passed: number
  fixedForward: number
  escalated: number
}

/** What an agent found (and fixed) reviewing its OWN diff, per `task.advance`. */
export type SprintEngineAgentSelfReviewMetrics = {
  phasesClosed: number
  passed: number
  fixedForward: number
  escalated: number
}

export type SprintEngineAgentMetrics = {
  role: SprintEngineRoleId
  selfReported: {
    sampleCount: number
    scores: Record<string, SprintEngineFeedbackScoreStat>
  }
  measured: SprintEngineAgentMeasuredMetrics
  findingsRaised: number
  sweep?: SprintEngineAgentSweepMetrics
  selfReview?: SprintEngineAgentSelfReviewMetrics
}

/** Architect difficulty-estimation accuracy (run-wide planning-quality signal). */
export type SprintEngineArchitectDifficulty = {
  sampleCount: number
  mean_absolute_error_pct: number
  bias_pct: number
}

/** The `summary` block of the feedback analysis. Only the fields the run summary
 *  consumes are typed; the analysis emits more (aggregateScoresByRole, etc.). */
export type SprintEngineFeedbackAnalysisSummary = {
  feedbackRecordCount: number
  aggregateByAgent: Record<string, SprintEngineAgentMetrics>
  difficultyAnalytics?: { architect?: SprintEngineArchitectDifficulty }
}

/** Shape of `data` returned by `window.api.summarizeSprintEngineFeedback`. */
export type SprintEngineFeedbackAnalysisData = {
  ok: boolean
  summary?: SprintEngineFeedbackAnalysisSummary
}

export type SprintEngineTaskTriage = {
  summary: string
  suggestedRole?: SprintEngineRoleId
  acceptanceCriteria: string[]
  likelyAffectedAreas: string[]
  missingInformation: string[]
  riskRating: 'low' | 'medium' | 'high'
  readyRecommendation: boolean
  triagedBy: 'architect'
  triagedAt: string
}

export type SprintEngineTaskSourceType = 'local' | 'github' | 'jira' | 'linear'
export type SprintEngineTaskSourceSyncStatus = 'clean' | 'local_changed' | 'remote_changed' | 'conflict'

export type SprintEngineTaskSource = {
  type: SprintEngineTaskSourceType
  externalId?: string
  externalUrl?: string
  repo?: string
  title?: string
  body?: string
  externalUpdatedAt?: string
  syncedAt?: string
  syncStatus?: SprintEngineTaskSourceSyncStatus
}

export type SprintEngineTaskNeedsInput = {
  kind: SprintEngineNeedsInputKind
  reason?: SprintEngineNeedsInputReason
  question: string
  artifactId?: string
  suggestedResolution?: string
  reportedBy?: string
  reportedAt?: string
  resolvedBy?: string
  resolvedAt?: string
  resolution?: string
  resumeRequestedAt?: string
}

// Mirrors the agent statuses the SprintEngine Python core writes into the run
// projection (sprintengine_core/tool/state.py). Agent liveness is DERIVED, not
// stored: Main is the single authority (T1). A departed agent — terminal torn
// down, e.g. idle retirement disposes it — ends as `idle` with its owned-task
// refs (`lastOwnedTaskId`) preserved, so revival keys off task ownership, not a
// status. There is no `left`/`dead` status; any legacy on-disk value is coerced
// to `idle` on load (normalizeProjectionRoster / normalizeSprintEngineState).
export type SprintEngineRuntimeAgentStatus =
  | 'idle'
  | 'running'
  | 'needs_input'
  | 'done'
  | 'retired'

export type SprintEngineCurrentDispatch = {
  dispatchId: string | null
  targetKind: string | null
  role?: SprintEngineRoleId
  reason?: string
  taskId?: string
  artifactId?: string
  assignedAt?: string
}

export type SprintEngineRuntimeAgent = {
  role: SprintEngineRoleId
  status: SprintEngineRuntimeAgentStatus
  currentTaskId: string | null
  /**
   * Last task this agent was assigned (MC-1444). Unlike currentTaskId this is
   * never cleared on idle/leave, so the dispatch planner can distinguish a
   * worker that finished a task (task-scoped retirement + no cross-task reuse)
   * from one that never had one.
   */
  lastOwnedTaskId?: string | null
  lastDirectiveAt?: string | null
  currentDispatch?: SprintEngineCurrentDispatch | null
}

export type SprintEngineTaskActivityType =
  | 'comment'
  | 'status_change'
  | 'claim'
  | 'evidence'
  | 'feedback'
  | 'needs_input'
  | 'artifact'
  | 'system'

export type SprintEngineTaskActivityEntry = {
  id: string
  timestamp: string
  type: SprintEngineTaskActivityType
  actor: string
  message: string
  status?: string
  artifactId?: string
  artifactStatus?: string
}

export type SprintEngineProjectionSource = 'folder_store' | 'unavailable'

export type SprintEngineProjectionLockReport = {
  name: string
  exists: boolean
  stale: boolean
  ageSeconds: number | null
  owner: { pid?: number; createdAt?: string } | null
}

export type SprintEngineProjectionLockWarning = {
  name: string
  message: string
  ageSeconds: number | null
}

export type SprintEngineProjectionLocks = {
  locks: SprintEngineProjectionLockReport[]
  warnings: SprintEngineProjectionLockWarning[]
}

export type SprintEngineProjectionCreation = {
  source?: string
  createdAt?: string
  updatedAt?: string
}

export type SprintEngineProjectionStatus = {
  source: SprintEngineProjectionSource
  updatedAt: string | null
  generatedAt: string | null
  /** Set when the projection could not be loaded. */
  errorMessage?: string
}

export type SprintEngineAutoPendingSpawn = {
  taskId: string
  agentId: string
  startedAt?: number
}

export type SprintEngineCliPermissionPreset = 'default' | 'auto_workspace' | 'bypass_all'
export type SprintEngineAutomationMode = 'manual' | 'run_agents' | 'run_agents_and_approve_artifacts'
export type SprintEngineAutomationDesiredMode = SprintEngineAutomationMode
export type SprintEngineAutomationRuntimeState =
  | 'idle'
  | 'running'
  | 'paused'
  | 'blocked'
  | 'failed'
  | 'complete'

export type SprintEngineAutomationStopReason =
  | 'user_selected_manual'
  | 'folder_missing'
  | 'spawn_failed'
  | 'blocked_on_input'
  | 'all_tasks_done'
  | 'terminal_closed'
  | 'workspace_removed'
  | 'startup'

export type SprintEngineAutomationEvent =
  | { type: 'user_set_mode'; mode: SprintEngineAutomationDesiredMode }
  | { type: 'runner_started' }
  | {
    type: 'runner_paused'
    reason: SprintEngineAutomationStopReason
    message?: string
    taskId?: string
    agentId?: string
  }
  | { type: 'runner_blocked'; message: string; taskId?: string; agentId?: string }
  | {
    type: 'runner_failed'
    reason: SprintEngineAutomationStopReason
    message: string
    taskId?: string
    agentId?: string
  }
  | { type: 'runner_complete'; message?: string }
  | { type: 'pending_spawns_changed'; pendingSpawns: SprintEngineAutoPendingSpawn[] }

export type SprintEngineAutoState = {
  desiredMode?: SprintEngineAutomationDesiredMode
  runtimeState?: SprintEngineAutomationRuntimeState
  reason?: SprintEngineAutomationStopReason
  reasonMessage?: string
  reasonTaskId?: string
  reasonAgentId?: string
  changedAt?: number
  cliPermissionPreset: SprintEngineCliPermissionPreset
  maxConcurrentAgents: number
  pendingSpawns: SprintEngineAutoPendingSpawn[]
  deliveredAgentNotificationEventKeys: string[]
  // One-shot completion-teardown marker: set (to the teardown timestamp) after
  // `tearDownCompletedSprintRunAgents` finished for the current completion, so
  // the projection reconcile never re-fires teardown against panels the user
  // re-opened afterwards (board resume, recovery audit, manual spawn). Cleared
  // by the reconcile when the run's tasks are no longer all done (scope
  // expansion / a chained follow-up sprint), re-arming teardown for the next
  // completion. Persisted with the rest of the auto state.
  completionTeardownAt?: number
  // Optional free-text "Guidance for the architect" captured in the wizard for an
  // architect-roster run (rosterSource === 'architect'). Prompt-only: quoted
  // verbatim into the architect's startup prompt to shape team size/spend
  // posture, never persisted by the engine. Lives here (renderer-owned run
  // config) rather than on SprintEngineState so the ~4s projection rebuild never
  // clobbers it. Absent for user-mode runs.
  architectGuidance?: string
}

export type MultiloopAutoPendingSpawn = {
  // Accepts a fixed Multiloop role or any registry-keyed Sprint Engine role
  // id (bundled or custom) so spawn records survive projection ingestion
  // even when the active Sprint Engine team includes custom roles.
  role: MultiloopRole | SprintEngineRoleId
  taskId?: string | null
  agentId: string
  startedAt?: number
}

export type MultiloopAutoState = {
  enabled: boolean
  cliPermissionPreset: SprintEngineCliPermissionPreset
  maxConcurrentAgents: number
  coordinatorAutoSpawnKey?: string | null
  pendingSpawns: MultiloopAutoPendingSpawn[]
}

export type WatchtowerReviewSectorId =
  | 'code_review'
  | 'spec_review'
  | 'ai_slop'
  | 'architecture_quality'
  | 'frontend_design'
  | 'production_readiness'
  | 'cross_platform'
  | 'brand_alignment'
  | 'security'
  | 'performance'
  | 'qa_testing'
  | 'infrastructure'
  | 'product_strategy'
  | 'accessibility'
  | 'documentation'

export type SprintEngineWorkspaceContext = {
  teamName: string
  teamSlug: string
  teamDirectoryPath: string
  statePath: string
}

export type MultiloopWorkspaceContext = {
  loopName: string
  loopSlug: string
  loopDirectoryPath: string
  statePath: string
}

export type MultiloopLoopStatus = 'active' | 'blocked' | 'accepted'
export type MultiloopMilestoneStatus = 'planned' | 'active' | 'blocked' | 'accepted'
export type MultiloopTaskStatus = 'todo' | 'ready' | 'in_progress' | 'needs_input' | 'done' | 'blocked'
export type MultiloopAgentStatus = 'idle' | 'running' | 'blocked'
export type MultiloopBlockerStatus = 'active' | 'resolved'
export type MultiloopBlockerScope = 'loop' | 'milestone' | 'task'
export type MultiloopReviewVerdictValue = 'accepted' | 'needs_follow_up' | 'blocked' | 'revise_scope'

export type MultiloopLoop = {
  name: string
  displayName: string
  finalGoal: string
  iteration: number
  status: MultiloopLoopStatus
  currentMilestoneId: string | null
  createdAt: string
  updatedAt: string
}

export type MultiloopMilestoneReviewVerdict = {
  id: string
  role: string
  createdBy: string
  verdict: MultiloopReviewVerdictValue
  evidence: string[]
  blockers: string[]
  finalGoalImplications: string[]
  nextRecommendation: string
  createdAt: string
}

export type MultiloopLegacyMilestoneReviewVerdict = {
  id: string
  role: 'legacy'
  createdBy: 'legacy'
  verdict: 'legacy'
  evidence: string[]
  blockers: string[]
  finalGoalImplications: string[]
  nextRecommendation: string
  createdAt: null
}

export type MultiloopMilestoneRevision = {
  id: string
  rationale: string
  changes: string[]
  createdAt: string
  revisedBy?: string
}

export type MultiloopMilestoneSprintEngineLink = {
  teamSlug: string
  statePath: string
  planPath: string
}

export type MultiloopMilestone = {
  id: string
  title: string
  goal: string
  status: MultiloopMilestoneStatus
  entryCriteria: string[]
  acceptanceCriteria: string[]
  finalGoalContribution: string
  learnedFacts: string[]
  blockers: string[]
  reviewVerdicts: Array<MultiloopMilestoneReviewVerdict | MultiloopLegacyMilestoneReviewVerdict>
  revisions: MultiloopMilestoneRevision[]
  sprintEngine: MultiloopMilestoneSprintEngineLink | null
  createdAt: string | null
  updatedAt: string | null
}

export type MultiloopTaskEvidence = {
  summary: string
  touchedFiles: string[]
  commandsRan: string[]
  results: string[]
}

export type MultiloopTask = {
  id: string
  milestoneId: string
  role: string
  status: MultiloopTaskStatus
  title: string
  description: string
  ownerAgentId: string | null
  dependsOn: string[]
  ownedPaths: string[]
  acceptanceCriteria: string[]
  implementationNotes: string[]
  learnedFacts: string[]
  blockers: string[]
  evidence: MultiloopTaskEvidence
  feedback: Record<string, number | string>
  createdAt: string | null
  updatedAt: string | null
  startedAt: string | null
  completedAt: string | null
}

export type MultiloopArtifact = {
  id: string
  kind: string
  title: string
  path: string
  milestoneId: string | null
  taskId: string | null
  createdBy: string | null
  createdAt: string | null
  updatedAt: string | null
  raw: Record<string, unknown>
}

export type MultiloopAgent = {
  id: string
  role: string
  status: MultiloopAgentStatus
  currentTaskId: string | null
}

export type MultiloopDecision = {
  id: string
  summary: string
  createdBy: string | null
  createdAt: string | null
  raw: Record<string, unknown>
}

export type MultiloopBlocker = {
  id: string
  summary: string
  scope: MultiloopBlockerScope
  status: MultiloopBlockerStatus
  milestoneId: string | null
  taskId: string | null
  detail: string | null
  createdBy: string | null
  createdAt: string | null
  resolvedAt: string | null
}

export type MultiloopState = {
  schemaVersion: number
  loop: MultiloopLoop
  roadmap: MultiloopMilestone[]
  tasks: MultiloopTask[]
  artifacts: MultiloopArtifact[]
  agents: Record<string, MultiloopAgent>
  decisions: MultiloopDecision[]
  blockers: MultiloopBlocker[]
}

export type MultiloopStateDisplayError = {
  title: string
  message: string
  path?: string
}

export type MultiloopStateReadResult =
  | { ok: true; state: MultiloopState }
  | { ok: false; error: MultiloopStateDisplayError }

export type FuturePlanWorkspaceSource = {
  folderPath: string
  sourcePath: string
  sourceRelativePath: string
  sourceContent: string
  sourcePlanKind: SprintEngineSourcePlanKind
  sourceBundle?: SprintEngineSourceBundleItem[]
  teamName: string
  goal: string
}

export type SprintEngineSourcePlanKind =
  | 'unknown'
  | 'product_plan'
  | 'architect_plan'
  // A backlog epic launched as a reference-based sprint. Only ever a root plan
  // kind — the epic's children carry their own leaf kinds in the source bundle.
  | 'epic'

export type SprintEngineSourceBundleKind =
  | SprintEngineSourcePlanKind
  | 'html_mockup'
  | 'design_notes'
  | 'plan_overview'
  | 'generic_context'

export type SprintEngineSourceBundleItem = {
  kind: SprintEngineSourceBundleKind
  sourcePath: string
  sourceRelativePath: string
  sourceContent: string
}

export type SprintEngineSource = {
  kind: 'markdown' | string
  origin: 'file' | 'stdin' | 'inline' | string
  planKind?: SprintEngineSourcePlanKind | string
  path: string
  originalPath?: string
  capturedAt?: string
}

export type SprintEngineSourceBundleStateItem = {
  kind: SprintEngineSourceBundleKind | string
  origin: 'file' | 'stdin' | 'inline' | string
  path: string
  originalPath?: string
  capturedAt?: string
}

export type SprintEngineTask = {
  id: string
  title: string
  description: string
  role: SprintEngineRoleId
  status: SprintEngineTaskStatus
  source?: SprintEngineTaskSource
  ownerAgentId: string | null
  /** Worker who last published an implementation pass. Retained after the task
   *  leaves the worker's hands (a `review` phase, or a bound phase session) so
   *  the owning worker stays visible while `ownerAgentId` is null. */
  lastImplementedByAgentId?: string | null
  /**
   * MC-1543 premium review: set when a phase's bound runtime differs from the
   * owner's, so the task is released (`ownerAgentId: null`) to await a fresh
   * session on `runtime`. The supervisor Birth-path spawns that session; it
   * claims the task through `task next` (`claim_phase_session`) without rewinding
   * the status. Absent for every task in a run with no `phaseRuntimes`.
   */
  awaitingPhaseSession?: { phase: SprintEngineTaskPhase; runtime: SprintEngineAllowedRuntime } | null
  /** CLI model that worked this task (e.g. `claude-fable-5`, `opus[1m]`),
   *  stamped at claim from the roster's per-role model selection. Retained
   *  through handoff for attribution and per-task usage metrics. Absent when
   *  the role runs on the CLI's default model. */
  model?: string | null
  /** CLI the recorded `model` belongs to (e.g. `claude-code`). */
  cli?: string | null
  dependsOn: string[]
  ownedPaths: string[]
  acceptanceCriteria: string[]
  implementationNotes: string[]
  evidence: SprintEngineTaskEvidence
  feedback?: SprintEngineTaskFeedback
  /** Reviewer assessments captured against this task (one per review pass). */
  feedbackAssessments?: SprintEngineTaskFeedback[]
  triage?: SprintEngineTaskTriage
  needsInput?: SprintEngineTaskNeedsInput
  notes: string[]
  comments: SprintEngineTaskComment[]
  startedAt: string | null
  completedAt: string | null
  /** Folder-store column the task is materialized in. Authoritative when set. */
  boardColumn?: SprintEngineTaskBoardColumn
  /** Folder-store directory name the task currently lives under (e.g. "in_progress", "ready"). */
  folderStatus?: string
  /** Semantic task lifecycle status embedded in the task file. */
  stateStatus?: SprintEngineTaskStatus
  /** Canonical handoff timeline, oldest first. */
  activity?: SprintEngineTaskActivityEntry[]
  /**
   * The ordered post-implementation phases this task's owner walks after
   * `task.publish` produces a diff (MC-1542). Absent means "inherit the run's
   * `defaultPhases`"; `[]` means publish routes straight to `done`. Use
   * `resolveSprintEngineTaskPhases` rather than reading this directly.
   */
  phases?: SprintEngineTaskPhase[]
  /** Newest-first short list of recent comments (any type). */
  latestComments?: SprintEngineTaskComment[]
  /** Newest-first list of feedback comments whose data.status is still open. */
  latestOpenFeedback?: SprintEngineTaskComment[]
  /** Review/validation artifacts the task's owner filed against it. */
  recordedArtifacts?: SprintEngineRecordedArtifact[]
}

export type SprintEngineState = {
  name: string
  goal: string
  rosterConfigured?: boolean
  source?: SprintEngineSource
  sourceBundle?: SprintEngineSourceBundleStateItem[]
  updatedAt?: string | null
  roleCounts: SprintEngineRoleCounts
  sprintEngineAgents: Record<string, SprintEngineRuntimeAgent>
  events: SprintEngineEvent[]
  tasks: SprintEngineTask[]
  artifacts: SprintEngineArtifact[]
  /** Present when the projection was loaded; describes load source / freshness / error. */
  projection?: SprintEngineProjectionStatus
  /** Folder-store lock reports + warnings (stale locks etc). */
  locks?: SprintEngineProjectionLocks
  /** Run creation metadata recorded by the folder store. */
  creation?: SprintEngineProjectionCreation
  /** Durable agent polling policy from run.yaml. */
  runner?: SprintEngineRunnerPolicy
  /**
   * Creation-time intent: run this team in one shared git worktree + branch so
   * every agent works and commits in the same isolated checkout. Persisted so
   * the (possibly deferred) `sprintengine.init` records the run worktree.
   */
  useWorktrees?: boolean
  /**
   * Shared run worktree metadata once worktree mode has been initialized
   * (mirrors run.yaml `sprintengine.vcs`). Agent terminals cwd into
   * `worktreePath` and per-task commits land on `branchName`.
   */
  vcs?: SprintEngineVcs | null
  /**
   * Per-role execution runtime map from run.yaml `roleRuntimes`
   * (projection-owned; the renderer reads it, never writes it). Written once
   * at init from the roster's per-role CLI/model picks; the single source of
   * truth for the CLI + model every roster spawn must use (MC-1450). Python
   * stamps `task.model` from the same map at claim (MC-1448), so renderer and
   * Python cannot drift. A `null`/absent model means "CLI default" — no
   * `--model` flag, deliberately not a fallback to any other model.
   */
  roleRuntimes?: SprintEngineRoleRuntimes
  /**
   * The run's configured (enabled) role set from run.yaml `configuredRoles`
   * (projection-owned; the renderer reads it, never writes it). Written once at
   * init from the roster the user turned on. Under the lazy roster only the
   * architect is seated at start, so this is the only honest source for "which
   * roles belong to this run" — the roster view groups by it so a configured
   * reviewer that has not spawned yet still shows as an empty role group.
   * Absent for legacy runs, which fall back to the seated-roster census
   * (`roleCounts`).
   */
  configuredRoles?: SprintEngineRoleId[]
  /**
   * How this run's roster was composed (run.yaml `rosterSource`, projection-owned;
   * the renderer reads it, never writes it onto state — the wizard forwards it as
   * an init flag). `'architect'` means the architect picks the team via
   * `sprintengine.roster.configure` within `allowedRuntimes`; `'user'` (and
   * absent/legacy) means the user composed the roster in the wizard. Drives the
   * architect startup-prompt branch and the board provenance chip.
   */
  rosterSource?: SprintEngineRosterSource
  /**
   * The sprint's allowed runtime palette (run.yaml `allowedRuntimes`,
   * projection-owned). The `{cli, model}` set the user ticked for an
   * architect-roster run; the engine hard-rejects any role assignment outside
   * it. Absent for user-mode/legacy runs. A `null` model means the CLI's own
   * default. Scores/notes for these entries live in the global model catalog,
   * not here — the prompt joins the two.
   */
  allowedRuntimes?: SprintEngineAllowedRuntime[]
  /**
   * The post-implementation phases every task on this run inherits (run.yaml
   * `defaultPhases`, projection-owned; the wizard forwards it as an init flag).
   * It is the DEFAULT and the CEILING — a task may trim its `phases`, never add
   * one outside this set, so `[]` ("agents on this run don't review their own
   * work") is an operator guarantee, not an architect preference. Absent means
   * the engine default, `['review']`.
   */
  defaultPhases?: SprintEngineTaskPhase[]
  /**
   * Sweep role ids the operator mandated for this run (run.yaml `requiredSweeps`,
   * projection-owned; the wizard forwards it as an init flag). The architect's
   * planning directive treats them as non-negotiable, and the engine refuses to
   * complete the run while a required sweep role has no planned task. Absent when
   * the operator mandated none.
   */
  requiredSweeps?: SprintEngineRoleId[]
  /**
   * Per-phase runtime bindings (MC-1543, run.yaml `phaseRuntimes`,
   * projection-owned). When a phase is bound to a runtime that differs from a
   * task's own, that phase runs as a FRESH, diff-seeded session on the bound
   * runtime — the operator explicitly paying for independent review. Absent means
   * every phase runs in-session on the owner's runtime and no extra sessions exist.
   */
  phaseRuntimes?: Record<SprintEngineTaskPhase, SprintEngineAllowedRuntime>
}

export type SprintEngineRosterSource = 'user' | 'architect'

// One ticked entry in an architect-roster run's per-sprint model palette. Mirrors
// the `{cli, model}` shape the engine stores in run.yaml `allowedRuntimes`
// (`model: null` = the CLI's own default). Descriptive scores/notes are NOT here;
// they live in the global model catalog and are matched by cli+model when needed.
export type SprintEngineAllowedRuntime = { cli: AgentCli; model: string | null }

export type SprintEngineRoleRuntime = { model?: string | null; cli?: string | null }
export type SprintEngineRoleRuntimes = Partial<Record<SprintEngineRoleId, SprintEngineRoleRuntime>>

export type SprintEngineVcs = {
  mode: 'run_worktree'
  repoRoot?: string
  /** Project-root-relative path to the shared run worktree directory. */
  worktreePath: string
  branchName: string
  baseRef?: string
  status?: string
  pullRequestUrl?: string | null
  /** Reason the last pull-request open failed, surfaced in the summary with Retry. */
  pullRequestError?: string | null
  /** Merge state of the run branch: 'open' until the PR merges or the branch lands
   *  in its base; 'merged'/'closed' are terminal (polling stops). */
  pullRequestState?: 'open' | 'merged' | 'closed' | null
  lastCommitSha?: string | null
}

export type SprintEngineMockConfig = Pick<SprintEngineState, 'name' | 'goal' | 'roleCounts'>

export type AgentMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
}

export type AgentStatus = 'idle' | 'running' | 'streaming' | 'error' | 'complete'
// Runtime CLI identity is a plugin id. Bundled choices include `codex` and
// `claude-code`.
export type AgentCli = string
export type SprintEngineRoleCliDefaults = Partial<Record<SprintEngineRoleId, AgentCli>>

// A resumable record of a sprint agent's last live CLI session, kept on the
// workspace so it outlives the agent panel. Completion teardown removes the
// agent panels but records this first, so the board can later re-open a role and
// resume its exact conversation (claude-code: `--resume cliSessionId`; codex:
// its `harnessSessionId`) rather than starting fresh.
export type SprintEngineRosterSession = {
  role?: SprintEngineRoleId
  cli: AgentCli
  // Stable terminal id minted for the session; claude-code's `--resume` token.
  cliSessionId: string
  // CLI/harness conversation id learned after launch; codex's resume token.
  harnessSessionId?: string
  cliModel?: string
  // Display label captured for the roster/tab when the session is re-opened.
  name?: string
  recordedAt: number
}

export type SprintEngineRosterSessions = Record<AgentId, SprintEngineRosterSession>

// Explicit per-role model selection from the new-workspace roster. A string
// is an explicit model id; null or an absent role means "CLI default" (no
// model flag passed).
export type SprintEngineRoleModelOverrides = Partial<Record<SprintEngineRoleId, string | null>>

export type SprintEngineSavedRoster = {
  roleCounts: SprintEngineRoleCounts
  roleCliDefaults: SprintEngineRoleCliDefaults
  // Per-role explicit launch model, saved alongside the CLI so a reused roster
  // restores the model too. Absent role = CLI default (no model flag). Only
  // explicit model ids are stored (a "CLI default" pick is dropped, since it is
  // indistinguishable from absent at launch).
  roleModelOverrides?: SprintEngineRoleModelOverrides
}

// A named, reusable roster preset ("team"). Lets users keep several rosters —
// e.g. a lightweight two-agent team and a heavyweight full-review team — and
// pick one when creating a workspace instead of reconfiguring every time.
export type SprintEngineRosterTeam = {
  id: string
  name: string
  roleCounts: SprintEngineRoleCounts
  roleCliDefaults: SprintEngineRoleCliDefaults
  // Per-role explicit launch model (see SprintEngineSavedRoster). Absent on
  // teams saved before model persistence — those fall back to CLI default.
  roleModelOverrides?: SprintEngineRoleModelOverrides
  createdAt: number
  updatedAt: number
}

export type SprintEngineRoleSettings = {
  enabled: Record<SprintEngineRoleId, boolean>
  // Legacy single-roster default, retained for migration and as the run-mount
  // CLI-default fallback. New saves go through `savedTeams`.
  savedRoster?: SprintEngineSavedRoster | null
  // Named roster presets the user can pick from.
  savedTeams?: SprintEngineRosterTeam[]
  // The team most recently selected/saved, used to seed the new-workspace wizard.
  lastSelectedTeamId?: string | null
}
export type MultiloopRole =
  | 'coordinator'
  | 'architect'
  | 'product'
  | 'developer'
  | 'frontend'
  | 'tester'
  | 'security'
  | 'performance'
  | 'cross_platform'

export type AgentKind = 'general' | 'specialist' | 'watchtower' | 'sprintengine' | 'multiloop'
export type AgentExecutionMode = 'current_workspace' | 'worktree'
export type WorktreeEntryStatus = 'available' | 'assigned' | 'missing' | 'removing' | 'error'
// Ids of the built-in specialist actions shipped in SPECIALIST_ACTIONS.
export type BundledSpecialistActionId =
  | 'architect'
  | 'product-strategist'
  | 'developer'
  | 'devops-infra'
  | 'performance'
  | 'production-readiness-review'
  | 'cross-platform'
  | 'blog-writer'
  | 'qa-test'
  | 'security-review'
  | 'frontend-design-review'
  | 'ui-ux-review'

// A specialist id is either a bundled action id or a registry-discovered role id
// (from a workspace / user / plugin specialist pack). The `(string & {})` arm
// keeps editor autocomplete for the bundled ids while accepting any registry
// role id, so dropped-in specialist packs round-trip through prefs and spawns.
export type SpecialistActionId = BundledSpecialistActionId | (string & {})

export type CliRuntimeSettings = {
  command: string
  useWsl: boolean
  // User-added model ids for this CLI, merged with the plugin manifest's seed
  // options in pickers. Mirrors the shared electron-api type.
  models?: string[]
}

// A global Sprint Engine "model catalog" entry: user-entered facts about one
// CLI+model pairing, entered once in Settings and stable across sprints. It
// holds facts (scores, cost, note, an offered-by-default toggle), NOT which
// models a given sprint may use — that is the wizard's per-sprint selection.
// Enforcement is structural elsewhere (the ticked selection becomes a run's
// allowed runtimes); scores and the note are descriptive guidance only.
export type SprintEngineModelCatalogEntry = {
  cli: AgentCli // plugin id, e.g. 'claude-code', 'codex', 'zai'
  model: string | null // model id; null = the CLI's own default (no --model flag)
  offeredByDefault: boolean // seeds the wizard's per-sprint checkbox
  intelligence: number // 1–10 — reasoning/planning/review rigor
  frontendDesign: number // 1–10 — UI/UX design and frontend taste
  mobile: number // 1–10 — mobile app development
  speed: number // 1–10 — throughput/latency
  cost: number // relative multiplier, positive; ratios are the meaning
  note?: string // free-text descriptive guidance only, never enforcement
}

// Whether an agent CLI's binary is actually installed/runnable on this machine,
// distinct from whether its plugin manifest is registered. Mirrors the shared
// electron-api type. Keyed by plugin id in AgentCliAvailabilityMap.
export type CliAvailability = {
  cli: AgentCli
  installed: boolean
  resolvedPath: string | null
  version: string | null
}

export type AgentCliAvailabilityMap = Record<AgentCli, CliAvailability>

export type McpClientTarget = AgentCli
export type McpTransport = 'stdio' | 'http' | 'sse'
export type McpScope = 'workspace' | 'user'
export type McpServerSource = 'bundled' | 'custom'
export type McpRiskLevel = 'low' | 'network' | 'local-command' | 'secrets'

export type McpServerConfig = {
  id: string
  name: string
  category?: string
  description?: string
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  envVarNames?: string[]
  headers?: Record<string, string>
  enabled: boolean
  required?: boolean
  clients: McpClientTarget[]
  scope: McpScope
  source: McpServerSource
  riskLevel: McpRiskLevel
  auth?: string
  capabilities?: string[]
  sourceUrl?: string
}

export type McpSettings = {
  syncEnabled: boolean
  servers: Record<string, McpServerConfig>
}

export type McpCatalogServer = Omit<McpServerConfig, 'enabled' | 'scope' | 'source'> & {
  defaultClients?: McpClientTarget[]
  recommendedScope?: McpScope
  setupNotes?: string
  skill?: string
  icon?: string
}

export type SkillPackHarness = 'claude' | 'codex' | 'cursor' | 'gemini' | 'opencode' | 'agents'
export type SkillPackSource = 'bundled' | 'custom'

export type SkillPackEntry = {
  id: string
  slug: string
  name: string
  category?: string
  description?: string
  version?: string
  sourceUrl?: string
  installedDirName?: string
  harnesses: SkillPackHarness[]
  source: SkillPackSource
  installedAt?: string
}

export type SkillPackCatalogEntry = Omit<SkillPackEntry, 'source' | 'installedAt'> & {
  recommended?: boolean
  setupNotes?: string
}

export type SkillPackSettings = {
  installed: Record<string, SkillPackEntry>
}

export type AgentExecution = {
  mode: AgentExecutionMode
  worktreeId: string | null
  cwd: string | null
}

export type WorktreeEntry = {
  id: string
  path: string
  branch: string | null
  ownerAgentId: AgentId | null
  status: WorktreeEntryStatus
  createdAt: number
  updatedAt: number
  missingAt?: number | null
}

export type WorkspaceWorktreeState = {
  containerPath: string | null
  entries: Record<string, WorktreeEntry>
  updatedAt: number | null
}

export type MemoryGraphColorRule = {
  id: string
  pattern: string
  color: string
}

export type MemoryGraphFiltersConfig = {
  hideOrphans: boolean
  hideAttachments: boolean
  hideUnresolved: boolean
  depthFromSelection: number | null
  disabledGroups: string[]
}

export type MemoryGraphDisplayConfig = {
  nodeSizeScale: number
  lineThicknessScale: number
  labelFadeThreshold: number
  labelFontSize: number
  showArrows: boolean
  curvedEdges: boolean
  glowHalos: boolean
  starfield: boolean
}

export type MemoryGraphForcesConfig = {
  centerForce: number
  repelForce: number
  linkForce: number
  linkDistance: number
}

export type MemoryGraphSettings = {
  /** Bumped when default tuning changes so the renderer can migrate stored values. */
  version?: number
  sidebarOpen: boolean
  activeTab: 'filters' | 'groups' | 'display' | 'forces'
  filters: MemoryGraphFiltersConfig
  colorRules: MemoryGraphColorRule[]
  display: MemoryGraphDisplayConfig
  forces: MemoryGraphForcesConfig
}

export type WorkspaceMemoryConfig = {
  relativeRoot: string | null
  graphSettings?: MemoryGraphSettings
}

// Records why a persisted workspace registry intentionally has zero workspaces.
// Hydration failure, parse failure, migration failure, and unknown startup
// empties all remain distinct (they are classifications of the persisted shape,
// not states of the registry). This record only exists for user-initiated wipes
// so the model unambiguously distinguishes intent from failure.
export type WorkspaceRegistryEmptyState = {
  reason: 'user_removed_all'
  updatedAt: string
}

export type WorkspaceWindowState = {
  id: WorkspaceWindowId
  kind: 'primary' | 'detached'
  workspaceIds: WorkspaceId[]
  activeWorkspaceId: WorkspaceId | null
  bounds: { x: number; y: number; width: number; height: number } | null
  isMaximized: boolean
  displayId: number | null
  createdAt: number
  lastFocusedAt: number
}

export type UsageTelemetrySettings = {
  sendUsageData: boolean
  localDevExportEnabled: boolean
  lastExportAt: string | null
  exportDiagnostics: boolean
}

export type LearningSettings = {
  showTipsOnStartup: boolean
  lastShownTipId: string | null
  seenTipIds: string[]
  completedLessonIds: string[]
  dismissedVersion?: string
}

// Whisper model ids understood by a Multivoice transcription host (the lowercase
// WhisperModel enum from multivoice-tauri). The host loads/downloads the model.
export type VoiceDictationModel =
  | 'tiny'
  | 'base'
  | 'small'
  | 'medium'
  | 'large-v2'
  | 'large-v3'
  | 'large-v3-turbo'

export type VoiceDictationSettings = {
  /** Base URL of the Multivoice transcription host (remote, LAN, or localhost). */
  serverUrl: string
  /** Optional bearer token sent as `Authorization: Bearer …`. */
  authToken: string
  /** Whisper model the host should use. */
  model: VoiceDictationModel
  /** ISO language code, or 'auto' to let the model detect it. */
  language: string
}

// Theme system source of truth lives in `src/renderer/src/types/appTheme.ts`.
// AppearanceSettings is imported here so AppSettings (below) can reference it;
// every other theme symbol (AppTheme, ResolvedAppTheme, the picker option list,
// the normalizer) imports directly from appTheme.ts.
import type { AppearanceSettings } from './appTheme'
import type { ModuleEnablementOverrides } from '../../../shared/modules/manifest'
import type { PluginRegistryListEntry } from '../../../shared/plugin-manifest'

export type PluginCatalogStatus = 'loading' | 'ready' | 'error'

export type PluginCatalogEntry = PluginRegistryListEntry

export type KeybindingSettings = {
  /**
   * User-defined command shortcut overrides. Empty or missing arrays mean
   * "use the command registry defaults"; dispatch must also check `disabled`.
   */
  overrides: Record<string, string[]>
  /**
   * Persisted command disablement flags. Only `true` values are meaningful;
   * missing/false means the command remains enabled.
   */
  disabled: Record<string, boolean>
}

// A model choice scoped to the CLI it was made for. Model ids are only
// meaningful per-CLI; pairing them prevents cross-CLI leakage.
export type AgentCliModelSelection = {
  cli: AgentCli
  model: string
}

// The agent the sidebar's "New chat in project" item spawns on a plain click,
// remembered from the last pick in the agent picker. Only the kind (and which
// specialist) is stored — the CLI/model still resolves from lastSelectedCli and
// the per-specialist defaults at spawn time, so a later CLI switch is honored.
export type NewChatAgentChoice =
  | { kind: 'general' }
  | { kind: 'terminal' }
  | { kind: 'specialist'; specialistId: SpecialistActionId }

export type AppSettings = {
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>
  keybindings: KeybindingSettings
  mcp: McpSettings
  skillPacks: SkillPackSettings
  /**
   * The user's global default CLI — the fallback shown for any specialist,
   * multiloop role, Sprint Engine role, or automation with no per-agent default,
   * and settable directly in Settings. The General agent, like every specialist,
   * carries its own entry in `specialistCliDefaults` / `specialistModelDefaults`
   * (keyed by `GENERAL_AGENT_ENGINE_KEY`), so its engine is isolated from this.
   */
  lastSelectedCli: AgentCli
  /**
   * Last provider/model pair spawned as a conversation agent, so a new
   * Conversation agent reopens with it. `null` until the user spawns one; a
   * remembered pair that is no longer installed falls back to the first
   * available option at spawn time.
   */
  lastSelectedConversationModel: AgentConversationRuntime | null
  lastSelectedSpecialist: SpecialistActionId
  /**
   * Agent the sidebar's "New chat in project" item spawns on a plain click.
   * Updated whenever the user picks an agent from the new-chat picker, so the
   * next plain click repeats that choice and the menu can show what will spawn.
   */
  lastNewChatAgent: NewChatAgentChoice
  lastSelectedMultiloopRole: MultiloopRole
  lastAgentSpawnPermissionPreset: SprintEngineCliPermissionPreset
  specialistCliDefaults: Partial<Record<SpecialistActionId, AgentCli>>
  multiloopRoleCliDefaults: Partial<Record<MultiloopRole, AgentCli>>
  /**
   * Per-specialist model override, stored with the CLI it was picked for so a
   * later CLI switch cannot leak a stale model across CLIs. Honored only when
   * the row's effective CLI matches; otherwise no model flag is passed.
   */
  specialistModelDefaults: Partial<Record<SpecialistActionId, AgentCliModelSelection>>
  /** Per-Multiloop-role model override; same matching rules as specialists. */
  multiloopRoleModelDefaults: Partial<Record<MultiloopRole, AgentCliModelSelection>>
  /**
   * User-defined display order for the spawn-agent specialist menu. Holds the
   * specialist ids in the sequence the user dragged them into; ids absent here
   * fall back to the canonical roster order. Empty means "use canonical order".
   */
  specialistOrder: SpecialistActionId[]
  /**
   * Specialist-pack enablement. Holds the ids of packs the user has switched
   * off; a pack absent here is enabled. Deselecting the built-in pack removes
   * its agents from the spawn dropdown (the quick rows always remain).
   */
  specialistPacks: { disabled: string[] }
  sprintEngineRoleSettings: SprintEngineRoleSettings
  /**
   * Global Sprint Engine model catalog: user-entered facts about CLI+model
   * pairings (scores, cost, note, offered-by-default). Default `[]`; the app
   * ships no seeded entries. Read through `getAvailableModelCatalogEntries`
   * downstream so uninstalled-CLI entries are never offered for a sprint.
   */
  sprintEngineModelCatalog: SprintEngineModelCatalogEntry[]
  /**
   * Local operator preferences for an existing Sprint Engine run, keyed by the
   * normalized absolute `run.yaml` path. These intentionally stay in app-local
   * settings instead of the portable run store because permission bypass is a
   * machine/user trust decision.
   */
  sprintEngineRunSettings: Record<string, SprintEngineRunSettings>
  searchExcludes: string[]
  projectKnowledgeRoots: Record<string, string | null>
  recentWorkspaceFolders: string[]
  usageTelemetry: UsageTelemetrySettings
  learning: LearningSettings
  appearance: AppearanceSettings
  /** Voice dictation transcription server + model configuration. */
  voiceDictation: VoiceDictationSettings
  /** Capability-module enablement overrides, keyed by module id. */
  modules: ModuleEnablementOverrides
  /**
   * Values persisted by module-contributed settings sections, keyed by
   * `module:<moduleId>` namespace so module keys can never collide with shell
   * settings. Disabling a module hides its section but leaves this namespace
   * intact, so values survive a disable/enable cycle. Values must be
   * JSON-serializable.
   */
  moduleSettings: Record<string, Record<string, unknown>>
  /**
   * Whether the user has made a first-run capability-module choice. Until then
   * the module chooser is shown. Existing installs (with workspaces) are treated
   * as already-chosen so an upgrade never interrupts them.
   */
  modulesChosen: boolean
  /**
   * Current step of the first-run onboarding flow (welcome → modules → workspace
   * → complete). Fresh installs start at 'welcome'; existing installs resolve to
   * 'complete'. See store/onboardingState.ts.
   */
  onboardingStep: OnboardingStep
  /**
   * Deferred first-run config-adoption selection captured on the essentials
   * onboarding step (Cursor-style "we found N — adopt them?"). Holds the keys of
   * the detected MCP servers / skills the user opted into. Persisted so the
   * choice survives a mid-onboarding reload, and consumed (cleared) when the
   * first workspace is created and the real adoptAgentConfig IPC runs against
   * its root. `null` means nothing selected / nothing detected. See
   * components/onboarding/AdoptConfigCard.tsx.
   */
  pendingAgentConfigAdoption: PendingAgentConfigAdoption | null
  /**
   * How long an idle agent terminal sits before it is paused (its CLI process is
   * killed to reclaim memory, with the painted view frozen and resumed on click
   * or keystroke). In MINUTES; default 15. Never applies to agents waiting on the
   * user or mid-work. Synced to the main reap policy, which clamps it to
   * [1 minute, 24 hours]. See terminal-reap-policy.ts.
   */
  terminalIdleSuspendMinutes: number
  /**
   * Design Wizard specialists on Claude run as conversation sessions
   * (structured question cards, streamed chat) instead of raw terminals.
   * Turning this off restores the terminal transport for every role.
   */
  guidedBriefConversationSessions: boolean
}

export type PendingAgentConfigAdoption = {
  mcpServerKeys: string[]
  skillKeys: string[]
}

/**
 * Live outcome of the deferred first-run config adoption, surfaced on the
 * first-run overlay after the workspace is created. Transient app state (not
 * persisted): set when adoption runs at workspace creation, never resumed.
 */
export type AgentConfigAdoptionResult =
  | { status: 'adopting' }
  | { status: 'adopted'; mcpServerCount: number; skillCount: number; warnings: string[] }
  | { status: 'failed'; message: string }

export type SprintEngineRunSettings = {
  cliPermissionPreset?: SprintEngineCliPermissionPreset
  maxConcurrentAgents?: number
}

export type GuidedBriefHasUi = 'yes' | 'no'

// Guided Brief ships three presets. `full-brief` is the classic strategist →
// architect → designer → handoff flow. `frontend-design` is surfaced to users
// as "Design only": a design-only studio that forces the UI path, skips
// the product and architecture discussions, and starts on the designer stage.
// `design-system` reuses that design-only studio but authors a portable
// design-system bundle (see knowledge/multicode/design-system-bundle.md)
// instead of one app's mockups. All presets stay inside the `guided-brief`
// workspace mode rather than becoming their own `WorkspaceMode`.
export type GuidedBriefPreset = 'full-brief' | 'frontend-design' | 'design-system'

// The last successful library release from a design-system studio. Drives the
// re-release loop: the version input prefills this version for the user to
// bump, and the released confirmation names the real library copy.
export type DesignSystemStudioRelease = {
  name: string
  version: string
  /** Absolute path of the immutable released copy in the user-global library. */
  path: string
  releasedAt: string
}

// Where a design-system studio starts. `null`/absent is the blank scaffold;
// otherwise the designer agent's opening move is extracting the de-facto
// design language from the named source (a user-picked product folder, or the
// built-in Multicode brand reference resolved by the main process). The path
// is machine-local by design — it is read live by the designer session on this
// machine and never travels inside the portable bundle.
export type DesignSystemSeedSource = {
  kind: 'source-folder' | 'brand-demo'
  path: string
}

export type GuidedBriefRoleCliDefaults = {
  product: AgentCli
  architect: AgentCli
  frontend: AgentCli
}

// Explicit per-role launch model for the guided-brief discussions. A string is
// an explicit model id; null or an absent role means "CLI default" (no model
// flag passed). Mirrors SprintEngineRoleModelOverrides for the guided roles.
export type GuidedBriefRoleModelOverrides = Partial<Record<keyof GuidedBriefRoleCliDefaults, string | null>>

export type GuidedBriefStage =
  | 'strategist-working'
  | 'strategist-ready'
  | 'architect-working'
  | 'architect-ready'
  | 'designer-working'
  | 'designer-ready'
  | 'handoff'

export type GuidedBriefAcceptedArtifact = {
  kind: 'product' | 'mockup'
  title: string
  hash: string
  path: string
}

// One interview decision the user resolved during a guided-brief stage,
// recorded from the specialist's structured GUIDED_DECISION stream so the
// build handoff can carry the real decision record.
export type GuidedBriefRecordedDecision = {
  role: 'product' | 'architect' | 'frontend'
  id: string
  question?: string
  label: string
}

export type GuidedBriefRuntimeState = {
  workspaceRoot: string
  workspaceName: string
  idea: string
  hasUi: GuidedBriefHasUi
  // Which Guided Brief preset this runtime was created from. Absent on legacy
  // states; normalization defaults it to `full-brief`.
  preset?: GuidedBriefPreset
  wantsProductDiscussion: boolean
  wantsArchitectureDiscussion: boolean
  wantsFrontendDiscussion: boolean
  guidedRoleCliDefaults: GuidedBriefRoleCliDefaults
  // Explicit per-role launch models for the guided discussions. Absent on
  // legacy states; normalization defaults it to {} (all roles use CLI default).
  guidedRoleModelOverrides?: GuidedBriefRoleModelOverrides
  buildRoleCounts: SprintEngineRoleCounts
  buildRoleCliDefaults: Required<SprintEngineRoleCliDefaults>
  buildCliPermissionPreset: SprintEngineCliPermissionPreset
  buildStartRunner: boolean
  buildAutoApproveArtifacts: boolean
  stage: GuidedBriefStage
  acceptedProductBrief: GuidedBriefAcceptedArtifact | null
  acceptedArchitecturePlan: GuidedBriefAcceptedArtifact | null
  acceptedUiDirection: GuidedBriefAcceptedArtifact | null
  acceptedMockups: GuidedBriefAcceptedArtifact[]
  // Optional agent-produced HTML overviews of the brief/plan (a view of the
  // markdown, never a second source of truth). Absent on legacy states.
  acceptedProductOverview?: GuidedBriefAcceptedArtifact | null
  acceptedArchitectureOverview?: GuidedBriefAcceptedArtifact | null
  activeMockupPath: string | null
  // Path of the design artifact currently selected in the Multicode Design
  // studio preview, relative to the workspace root. Absent on legacy states;
  // normalization defaults it to `null`.
  activeDesignArtifactPath?: string | null
  // Interview decisions resolved across all specialist stages, deduped by
  // role + question id. Absent on legacy states; normalization defaults it
  // to an empty array.
  guidedDecisions?: GuidedBriefRecordedDecision[]
  // Design-system preset only: the source the studio was seeded from, carried
  // into the designer session's opening prompt. Absent/null on legacy states
  // and on blank-start studios; always null for the other presets.
  designSystemSeedSource?: DesignSystemSeedSource | null
  // Design-system preset only: the last successful library release from this
  // studio. Absent/null before the first release and on other presets.
  designSystemLastRelease?: DesignSystemStudioRelease | null
  // Persisted so the renderer reattaches to the same PTY across HMR / refresh
  // instead of spawning a fresh strategist, architect, or designer.
  strategistSessionId: string | null
  architectSessionId: string | null
  designerSessionId: string | null
}

export type DiagnosticLevel = 'info' | 'warning' | 'error'
export type DiagnosticSource =
  | 'auth'
  | 'automations'
  | 'filesystem'
  | 'git'
  | 'sprintengine'
  | 'terminal'
  | 'update'
  | 'voice'
  | 'workspace'

// A typed, serializable deep-focus target for a notification's Open action. The
// shell treats it as opaque (it only knows how to reveal the workspace); the
// owning module interprets `kind`/`ref` (e.g. Sprint Engine resolves
// `{ kind: 'task', ref: <taskId> }` to its board selection). Must stay plain
// data — notifications persist to localStorage, so this never carries a
// callback.
export type NotificationNavigationTarget = {
  kind: string
  ref: string
}

export type DiagnosticLogInput = {
  level: DiagnosticLevel
  source: DiagnosticSource
  title: string
  message: string
  details?: string
  workspaceId?: string
  workspaceName?: string
  agentId?: string
  taskId?: string
  sessionId?: string
  navigationTarget?: NotificationNavigationTarget
}

export type DiagnosticLogEntry = DiagnosticLogInput & {
  id: string
  timestamp: string
  logPath?: string
}

export type AppNotification = DiagnosticLogEntry & {
  read: boolean
}

// Standard workspace agents run through one of two runtimes. `terminal` is the
// default CLI/PTY path (and the only runtime for Sprint Engine and Multiloop
// agents). `conversation` is the plugin-driven conversation runtime backed by a
// provider/model selection. Older persisted agents have no `runtimeKind` and
// must be treated as `terminal`.
export type AgentRuntimeKind = 'terminal' | 'conversation'

// Conversation runtime selection for a standard workspace agent. `providerId`
// and `modelId` reference an installed conversation provider plugin (see
// `conversation:providers:list`). Absent for terminal agents.
export type AgentConversationRuntime = {
  providerId: string
  modelId: string
}

export type AgentState = {
  id: AgentId
  name: string
  status: AgentStatus
  execution: AgentExecution
  messages: AgentMessage[]
  streamBuffer: string
  // Runtime routing. Undefined is treated as `terminal` for back-compat; the
  // conversation runtime additionally requires a valid `conversation` pair.
  runtimeKind?: AgentRuntimeKind
  conversation?: AgentConversationRuntime
  cliSessionId?: string
  // The agent's session id within its CLI/harness, captured from lifecycle hooks
  // (the snapshot's `cliSessionId`). Distinct from `cliSessionId` above, which is
  // our terminal-tracking key. Used as the resume token so non-Claude CLIs (e.g.
  // Codex, which mints its own id) resume the right conversation. For Claude it
  // coincides with the terminal key. Persisted so resume survives a restart.
  harnessSessionId?: string
  cliStartRequested?: boolean
  cliRestartNonce?: number
  cliHasLaunched?: boolean
  cliOnboardingPromptSent?: boolean
  cliResumeAvailable?: boolean
  // Whether this agent's CLI resumes with the session id WE mint (Claude-family)
  // vs. minting its own (Codex). Stamped from the plugin manifest capability
  // (`sessionIdFromCaller`) at session assign, the sibling of cliResumeAvailable;
  // consumers use it to decide the resume token. See agent-cli-resume.ts.
  cliUsesStableSessionId?: boolean
  // Explicit "resume this conversation on next launch" intent. Sprint agents are
  // otherwise always spawned fresh (auto-run re-dispatches roles); this flag is
  // set only by an explicit board re-open of a completed run's recorded session
  // (see sprintEngineRosterSessions) so TerminalView resumes rather than starting
  // a new conversation.
  cliResumeRequested?: boolean
  cliLastExitCode?: number | null
  cliLastExitedAt?: number | null
  cli?: AgentCli
  // Model id passed at CLI launch when the plugin declares modelSelection.
  // Undefined means the CLI's own default; persisted so relaunch/resume and
  // Sprint Engine auto-run keep the model the agent was created with.
  cliModel?: string
  cliPermissionPreset?: SprintEngineCliPermissionPreset
  // Explicit per-agent runtime override (MC-1450). Wins over the run's
  // per-role `roleRuntimes` config on every reconcile and spawn — set by the
  // board's per-agent CLI/model picker and by creation-time per-agent CLI
  // overrides. `model: null` means "explicitly the CLI default" (suppresses a
  // role-configured model); an absent field falls through to the role config.
  // Without this marker the reconcile could not tell a user's mid-run pick
  // from a stale snapshot and would revert the pick on the next projection.
  cliRuntimeOverride?: { cli?: AgentCli; model?: string | null }
  // The runtime the live terminal was actually launched with, stamped at spawn
  // success (TerminalView). The record's `cli`/`cliModel` are re-stamped from
  // the run's `roleRuntimes` on every reconcile, so after a mid-run role edit
  // they reflect the NEW config while the running session still uses the old
  // one; this stamp preserves what the session is really on, powering the
  // roster's "on <old model>" divergence label and restart offer. Never
  // cleared on exit — consumers must gate on terminal liveness.
  cliLaunchedRuntime?: { cli?: AgentCli; model?: string | null }
  // Orthogonal Debug Mode toggle (the agent picker). Set per-spawn from the
  // transient spawn-UI state; the launch boundary prepends the debug directive
  // to the initial prompt when true. Not persisted-by-default UI: defaults off
  // each spawn, but recorded on the agent so the launch path can read it.
  debugMode?: boolean
  cliStartupPrompt?: string
  // Connector chat (Railway, etc.): a worktree-isolated solo chat scoped to one
  // MCP connector plus its driving skill. `connectorMcpSettings` is the
  // connector-only MCP config the spawn forwards *instead of* the global
  // appSettings.mcp, so the connector server is written into this worktree's
  // .mcp.json and nowhere else; `connectorSkillId` is the builtin skill the spawn
  // installs into the worktree so the seeded invocation resolves. Both are seeded
  // at creation by launchConnectorChat and read by the TerminalView launch path.
  connectorMcpSettings?: McpSettings
  connectorSkillId?: string
  kind?: AgentKind
  specialistId?: SpecialistActionId
  multiloopRole?: MultiloopRole
  // The Backlog item this agent was last handed (drag-drop or send-to-agent).
  // Powers the top-right glyph on the agent terminal that navigates back to the
  // item. Latest-wins: one ref per agent, mirroring the most-recent-wins
  // fixed link id on the Backlog item side. Undefined when no item was handed.
  backlogItemRef?: AgentBacklogItemRef
}

export type AgentBacklogItemRef = {
  // Project-root-relative `backlog/...` path; the select key for reverse nav.
  relativePath: string
  // Item title, kept so the glyph's tooltip/accessible name needs no file read.
  title: string
  linkedAt: number
}

export type AgentConfig = {
  model: string
  systemPrompt: string
  temperature: number
  maxTokens: number
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You are a helpful AI assistant.',
  temperature: 1,
  maxTokens: 8096,
}

export type OpenFile = {
  path: string
  name: string
  content?: string
  language: string
  isDirty: boolean
}

export type EditorState = {
  openFiles: OpenFile[]
  activeFilePath: string | null
}

export type WorkspaceFileExplorerState = {
  expandedPaths: string[]
  // The file the user last clicked in the tree, restored as the highlighted row
  // after a reload/restart. Only the focused/lead path is persisted, never the
  // whole multi-select set. Best-effort: it highlights only when the row is
  // visible, which works because expandedPaths restores its ancestor folders.
  selectedPath?: string | null
}

// Backlog triage lens + sort. Canonically defined here (the shared workspace
// types module, also visible to the main/preload tsconfig project) so the
// persisted WorkspaceBacklogState can reference them without dragging the
// renderer-only triage util into the node project. `utils/backlogTriage.ts`
// re-exports these and owns their behavior (matchesBacklogView/compareBacklogItems).
export type BacklogView =
  | 'active'
  | 'all'
  | 'epics'
  | 'quick_wins'
  | 'strategic_bets'
  | 'defer'
  | 'unestimated'
  | 'completed'
  | 'archived'

// `dependency` is "Dependency order": a whole-list topological transform
// (prerequisites before dependents, unblocked frontier first) the panel applies
// via orderItemsByDependencies, branching around the pairwise compareBacklogItems
// the other sorts use.
export type BacklogSort = 'best' | 'recent' | 'created' | 'status' | 'priority' | 'largest' | 'smallest' | 'dependency'

// Backlog grouping axis, orthogonal to view/sort. `none` is the flat list;
// `by_epic` renders collapsible epic headers with their children nested.
export type BacklogGroup = 'none' | 'by_epic'

// The Backlog panel's per-workspace navigation/view state, persisted so a
// reload/restart restores the item the user was reading plus the lens, sort, and
// search they left it in. Selection is keyed by project-root-relative
// `backlog/...` path (the durable identity) and resolved to the live scan's item
// id on restore — a deleted item degrades to no selection via the panel's
// existing scan-validity guard. The list/detail split is intentionally NOT
// persisted: it is derived from panel width by a ResizeObserver, not a user
// choice.
export type WorkspaceBacklogState = {
  selectedRelativePath: string | null
  view: BacklogView
  sort: BacklogSort
  group: BacklogGroup
  search: string
}

export type GitPanelView = 'changes' | 'worktrees' | 'log' | 'terminal'

// The Git panel's per-workspace view state. Commit-message drafts are keyed by
// scope id (per worktree/main checkout) so a half-written message can never
// bleed across worktrees and is cleared once that scope commits.
export type WorkspaceGitPanelState = {
  activeView: GitPanelView
  activeScopeId: string
  commitDraftsByScopeId: Record<string, string>
}

/**
 * Marks a standard workspace as living in a git worktree — set when a worktree
 * is opened as a workspace from the Worktree manager. The workspace's
 * `folderPath` already points at the worktree in this case, so this only carries
 * display info (branch/base) and flags the workspace as worktree-backed. Sprint
 * runs instead carry their worktree on `sprintEngineState.vcs`; both are
 * normalized by `resolveWorkspaceWorktree` (utils/workspaceWorktree.ts).
 */
export type WorkspaceWorktree = {
  branch?: string
  baseRef?: string
}

export type Workspace = {
  id: WorkspaceId
  name: string
  mode: WorkspaceMode
  folderPath: string | null
  folderMissing?: boolean
  worktree?: WorkspaceWorktree | null
  sprintEngineContext?: SprintEngineWorkspaceContext | null
  multiloopContext?: MultiloopWorkspaceContext | null
  templateId: string
  layoutModel: IJsonModel
  agents: Record<AgentId, AgentState>
  worktreeState: WorkspaceWorktreeState
  memory: WorkspaceMemoryConfig
  editorState: EditorState
  fileExplorerState?: WorkspaceFileExplorerState
  backlogState?: WorkspaceBacklogState
  gitPanelState?: WorkspaceGitPanelState
  sprintEngineState: SprintEngineState | null
  multiloopState?: MultiloopState | null
  sprintEngineRoleCliDefaults?: SprintEngineRoleCliDefaults
  // Durable per-agent CLI session records, keyed by roster agent id. Populated
  // when a sprint agent gets a live session and just before completion teardown
  // removes its panel, so a role can be re-opened later and resumed. Survives
  // panel removal and app restart (persisted alongside sprintEngineRoleCliDefaults).
  sprintEngineRosterSessions?: SprintEngineRosterSessions
  // Roster agents the user explicitly asked to start when the workspace
  // opens (new-workspace "Start now" intent). Session-only launch intent:
  // consumed by the Sprint Engine board on first ready render and stripped
  // at persist so an app restart never replays the spawns.
  sprintEngineInitialSpawnAgentIds?: AgentId[]
  sprintEngineAutoState: SprintEngineAutoState
  multiloopAutoState: MultiloopAutoState
  guidedBriefState?: GuidedBriefRuntimeState | null
  highlight?: WorkspaceHighlight
  createdAt: number
  lastTerminalActivityAt?: number | null
  // When set, the workspace is archived: hidden from the sidebar rail and the
  // Sprints aside's default lenses, but fully intact on disk and in the store —
  // visible under the aside's Archived lens and still findable in search.
  // Presentation-level only; archiving never touches agents or run state.
  archivedAt?: number | null
}
