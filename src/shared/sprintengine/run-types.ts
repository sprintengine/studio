/**
 * Sprint Engine run-domain types, shared by the renderer and the main process.
 *
 * Relocated verbatim from `src/renderer/src/types/workspace.ts`
 * (sprint-runtime-ownership Phase 2: the main process runs the auto-run
 * planner, so the run/task/artifact/roster type family it reads must live in
 * `src/shared`), following the established shim pattern
 * (`automation-types.ts` / `sprintengineAutomationLifecycle.ts`).
 * `workspace.ts` re-exports every name here, so existing renderer import
 * sites keep working unchanged. Pure data shapes only — no DOM, React, or
 * flexlayout imports may be added here.
 */
import type { SprintEngineAutoState, SprintEngineCliPermissionPreset } from './automation-types'
import type { AgentState } from './agent-state'

export type AgentId = string

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

/**
 * Lease-derived "who is doing what" record from the v3 projection
 * (`projection.workers`, MC-1591). The Python engine reconstructs it from task
 * leases — there is no `agents` map — so it is a superset of
 * {@link SprintEngineRuntimeAgent}, additionally carrying the session recorded
 * on the worker's active lease and the set of tasks it has owned this run.
 * Keyed by worker id in {@link SprintEngineState.workers}. The `projection.roster`
 * bridge is a subset projection of the same view, so a worker and its roster
 * entry never disagree on role/status/currentTaskId.
 */
export type SprintEngineWorker = SprintEngineRuntimeAgent & {
  /** Session id recorded on the worker's active lease, when it holds one. */
  sessionId?: string
  /** Every task id this worker has owned across the run (active lease +
   *  last-implemented), oldest-first. */
  ownedTaskIds?: string[]
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

export type SprintEngineWorkspaceContext = {
  teamName: string
  teamSlug: string
  teamDirectoryPath: string
  statePath: string
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
  /**
   * Whether the run was canceled by the user (MC-1604). A stored run-level
   * lifecycle flag from run.yaml `sprintengine.canceled`, surfaced via the
   * projection's `run.status === 'canceled'`; the projection normalizer sets it.
   * Read through {@link isCanceledSprintEngineRun}, never derived from task
   * statuses — a canceled run's non-done tasks are all `canceled`, which would
   * otherwise read as completion. Absent/false for every other run.
   */
  canceled?: boolean
  source?: SprintEngineSource
  sourceBundle?: SprintEngineSourceBundleStateItem[]
  updatedAt?: string | null
  roleCounts: SprintEngineRoleCounts
  sprintEngineAgents: Record<string, SprintEngineRuntimeAgent>
  /**
   * Canonical lease-derived worker view from the v3 projection
   * (`projection.workers`, MC-1591), keyed by worker id. Populated by
   * {@link normalizeSprintEngineProjection} from `projection.workers` when
   * present, falling back to the `projection.roster` bridge when it is absent.
   * `buildSprintEngineAgentRosterForState` derives its rows from this so board,
   * tabs, and layout read "who is doing what" from leases, not the seat ledger.
   * `sprintEngineAgents` stays populated in parallel for consumers that have not
   * yet migrated. Absent for states built outside the projection normalizer.
   */
  workers?: Record<string, SprintEngineWorker>
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

/**
 * One repo a run works in (MC-1611). Mirrors the entry shape the engine writes to
 * `sprintengine.vcs.repos` in run.yaml. `root` is workspace-relative — `.` for the
 * primary repo, a sibling project's directory for the rest — and `worktreePath` is
 * that repo's own run worktree. Pull-request fields are not here yet; they stay on
 * the run's flat `vcs` block until per-repo pull requests land (MC-1612).
 */
export type SprintEngineVcsRepo = {
  id: string
  root: string
  /** Project-root-relative path to this repo's run worktree directory. */
  worktreePath: string
  branchName: string
  baseRef?: string | null
  status?: string
  lastCommitSha?: string | null
}

export type SprintEngineVcs = {
  mode: 'run_worktree'
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
  /**
   * Every repo the run works in, entry zero first (the primary repo, `root: '.'`).
   * Always populated: a run stored before this list existed describes its one repo
   * with the flat fields above, and the normalizer reads that back as a one-entry
   * list, so readers only ever handle the list. The flat fields remain the primary
   * repo's live values until the surfaces that read them move onto `repos`.
   */
  repos: SprintEngineVcsRepo[]
}

export type SprintEngineMockConfig = Pick<SprintEngineState, 'name' | 'goal' | 'roleCounts'>

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

export type SprintEngineRunSettings = {
  cliPermissionPreset?: SprintEngineCliPermissionPreset
  maxConcurrentAgents?: number
}
// One shape-coded lifecycle vocabulary shared by Backlog readiness and Sprint
// Engine task state. State reads by shape (ring / dashed / spinner / inner-dot /
// "!" / check / slash / "×"), never by color alone — color only reinforces. The
// 6 px StatusDot stays the app's "live right now" idiom; this glyph carries the
// richer lifecycle that a worklist needs, replacing per-row status dots there.
// Domain-agnostic: callers map their own status enum to a LifecycleState.
// Declared here (not in `components/ui/LifecycleGlyph.tsx`, which re-exports
// it) so the shared Sprint Engine state module can map board columns to it.
export type LifecycleState =
  | 'todo'
  | 'idea'
  | 'ready'
  | 'in_progress'
  | 'paused'
  | 'review'
  | 'testing'
  | 'product'
  | 'changes_requested'
  | 'needs_input'
  // A filed evidence/gate record — a document mark with a tick. Read-only,
  // never a pending decision and never a spinner. Neutral ink (Sprint Engine
  // recorded artifacts map here).
  | 'recorded'
  | 'done'
  // Approved by automated policy rather than a human hand — the same green tick
  // as `done` but drawn as an outline ring, so "approved on your behalf" reads a
  // shade lighter than a manual approval's filled disc.
  | 'approved_auto'
  // Complete but not yet merged — a green git-branch fork, signalling "work is
  // sitting on a branch / PR" (GitHub's iconography), distinct by shape from the
  // filled `done` disc used for on-main completions.
  | 'done_unmerged'
  // Complete AND merged — the same git-branch fork in merged-purple
  // (--tone-merged), distinct by color from the green `done_unmerged` branch.
  // Used by Sprint Engine worktree runs once their pull request merges.
  | 'done_merged'
  | 'archived'
  | 'failed'

/**
 * Structural view of the one renderer `Workspace` shape the shared Sprint
 * Engine planner/state helpers actually read. Full renderer `Workspace`
 * objects remain assignable (every field below mirrors the corresponding
 * `workspace.ts` field's type), so call sites did not change when the pure
 * modules moved to `src/shared`.
 */
export type SprintEngineWorkspaceView = {
  id: string
  name?: string
  folderPath?: string | null
  folderMissing?: boolean
  agents: Record<string, AgentState>
  sprintEngineState?: SprintEngineState | null
  sprintEngineAutoState?: SprintEngineAutoState
  sprintEngineContext?: SprintEngineWorkspaceContext | null
  memory?: { relativeRoot?: string | null } | null
}
