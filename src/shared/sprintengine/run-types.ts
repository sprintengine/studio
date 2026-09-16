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

// `SprintEngineRole` is the historical first-party Sprint Engine role union.
// Those role skills now ship in `resources/studio-plugin/workflow-roles/skills/`
// and resolve from a workspace's installed harness skills, but the union is
// retained because it still types first-party config shapes such as default
// skill maps, default role counts, and CLI defaults — those are studio-owned
// settings, not pluggable role skills.
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
// tool. `label`, `description`, `icon`, and `source.layer` are the only fields
// the renderer currently uses for display; the rest is captured so future
// surfaces (settings tab, soul preview) can grow without re-plumbing the
// type.
export type SprintEngineRoleRegistryMetadata = {
  id: SprintEngineRoleId
  label: string
  aliases: string[]
  description?: string | null
  icon?: string | null
  source: { layer: SprintEngineRoleRegistrySourceLayer }
  shadowedSources?: { layer: SprintEngineRoleRegistrySourceLayer }[]
  warnings?: SprintEngineRoleRegistryWarning[]
  enabled?: boolean
}

// Read-only directory the renderer builds from a registry payload. Indexed
// by canonical role id and (via `aliases`) by alias. `warnings` carries any
// registry-level warnings the discovery emitted.
export type SprintEngineRoleRegistry = {
  roles: Record<SprintEngineRoleId, SprintEngineRoleRegistryMetadata>
  aliases: Record<string, SprintEngineRoleId>
  warnings: SprintEngineRoleRegistryWarning[]
}

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

/**
 * Task charter markers. MIRRORS `REVIEW_TASK_KINDS` in
 * sprintengine_core/tool/integration.py; a task with no marker is ordinary
 * work and carries no `kind` at all rather than a `'work'` value.
 */
export const SPRINTENGINE_TASK_KINDS = ['review', 'integration_review'] as const
export type SprintEngineTaskKind = (typeof SPRINTENGINE_TASK_KINDS)[number]

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

type SprintEngineCliWatchPolling = 'enabled' | 'disabled'

export type SprintEngineRunnerPolicy = {
  // The CLI watch loop these fields configured was retired with the CLI-runner
  // era (MC-1827); nothing polls any more. `cliWatchPolling` survives as the
  // run.yaml hint main writes when the automation mode changes, which the
  // mobile snapshot reads back to derive that mode. The studio's supervisor
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

type SprintEngineTaskDiffHunk = {
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
type SprintEngineFeedbackScoreStat = {
  label: string
  averagePct: number
  sampleCount: number
}

type SprintEngineAgentTaskCounts = {
  reviewSampleCount: number
  counts: Record<string, number>
}

type SprintEngineAgentMeasuredMetrics = {
  reviewSampleCount: number
  scores: Record<string, SprintEngineFeedbackScoreStat>
  counts: Record<string, number>
  hallucinationRatePct?: number
  findingsAgainst?: { total: number; bySeverity: Record<string, number> }
  /** Per-task review detail for the drill-down, keyed by task id. */
  taskCounts?: Record<string, SprintEngineAgentTaskCounts>
}

/**
 * What an agent found (and fixed) reviewing ANOTHER agent's task: the tasks it
 * audited and what it did about what it found. Sourced from the analysis
 * `peerReview` block, which the engine builds from review assessments carrying
 * the `--review-target-*` trio. A reviewer fixes what it finds rather than
 * sending work back.
 */
type SprintEngineAgentPeerReviewMetrics = {
  tasksAudited: number
  assessmentsRecorded: number
  passed: number
  fixedForward: number
  escalated: number
}

/** What an agent found (and fixed) reviewing its OWN diff, per `task.advance`.
 *  Carries the self-attributed defect counts and findings — honest but not
 *  independent, so surfaces label them as self-reported, never as measured. */
type SprintEngineAgentSelfReviewMetrics = {
  phasesClosed: number
  passed: number
  fixedForward: number
  escalated: number
  /** Self-attributed defect counts (same camelCase keys as measured.counts). */
  counts?: Record<string, number>
  /** Findings the owner reported against its own work. */
  findingsReported?: { total: number; bySeverity: Record<string, number> }
  /** Per-own-task self-review detail for the drill-down, keyed by task id. */
  taskCounts?: Record<string, SprintEngineAgentTaskCounts>
}

export type SprintEngineAgentMetrics = {
  role: SprintEngineRoleId
  selfReported: {
    sampleCount: number
    scores: Record<string, SprintEngineFeedbackScoreStat>
  }
  measured: SprintEngineAgentMeasuredMetrics
  findingsRaised: number
  peerReview?: SprintEngineAgentPeerReviewMetrics
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
type SprintEngineFeedbackAnalysisSummary = {
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
  /** Absent on a roleless run's agents, which carry no role at all (MC-2057). */
  role?: SprintEngineRoleId
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
  /** Repo id recorded on the worker's active lease (MC-1611): the tree the
   *  worker is working in right now. Absent when it holds no active lease. */
  repo?: string
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

type SprintEngineProjectionStatus = {
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

/**
 * How a run gets its task graph (MC-2128).
 *
 * `direct` imports it from the source epic's child items at init — one task per
 * open child, ordered by the items' own `dependsOn`, with no planning agent and
 * no plan-approval gate. `planned` runs a planning agent behind the plan gate.
 *
 * The default is the engine's and depends on the source: `direct` for an epic
 * (its children are already a written, ordered plan), `planned` for everything
 * else (with no epic there is no authored order to import, so something must
 * plan). Fixed at run creation.
 */
export type SprintEngineIntake = 'direct' | 'planned'

/**
 * Does this source shape have an authored plan to import, rather than one an
 * agent must derive? The single place that answer lives, so the dialog's copy,
 * the creation path, and the automation surfaces cannot drift from the engine's
 * own default.
 */
export function sourcePlanKindSupportsDirectIntake(
  planKind: SprintEngineSourcePlanKind | undefined
): boolean {
  return planKind === 'epic'
}

export type SprintEngineSourcePlanKind =
  | 'unknown'
  | 'product_plan'
  | 'architect_plan'
  // A backlog epic launched as a reference-based sprint. Only ever a root plan
  // kind — the epic's children carry their own leaf kinds in the source bundle.
  | 'epic'
  // Several backlog items and/or epics launched as ONE sprint (MC-2060/2061):
  // the general shape of which the epic launch is the single-epic special case.
  // Only ever a root plan kind — the bundle carries the selection: selected
  // epics as `epic`-kind entries (membership scopes), work items marked
  // `selectedItem`/`epicChild`. A selection of exactly one epic stays `epic`.
  | 'selection'

type SprintEngineSourceBundleKind =
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
  /**
   * This entry IS one of the launched epic's child items — a unit of work the
   * planner mints exactly one task for — rather than supporting reading
   * material (an attached mockup, a design-system note) that happens to share
   * the bundle. Set on `epic` and `selection` launches; ignored elsewhere.
   */
  epicChild?: boolean
  /**
   * The `selection` counterpart of {@link epicChild}: this entry IS a
   * directly-selected backlog item — a unit of work, but not a child of any
   * selected epic. The engine re-classifies marked work entries from their own
   * `epic:` frontmatter at init (`normalize_selection_bundle`), so the two
   * markers only need to be honest, not perfect.
   */
  selectedItem?: boolean
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
  /** See {@link SprintEngineSourceBundleItem.epicChild}. */
  epicChild?: boolean
  /** See {@link SprintEngineSourceBundleItem.selectedItem}. */
  selectedItem?: boolean
}

/**
 * The repo a task targets when it names none: entry zero of the run's declared
 * `vcs.repos`, its primary repo (MC-1611). MIRRORED from `DEFAULT_TASK_REPO` in
 * sprintengine_core/store.py (and `PRIMARY_REPO_ID` in
 * sprintengine_core/tool/shell.py); a contract test pins them together.
 */
export const DEFAULT_SPRINTENGINE_TASK_REPO = 'primary'

/**
 * The one backlog item a task delivers. Single-valued and optional: it is the
 * identity the Epic tab's mapping column, the child→task link, and the task
 * header pointer all key on, and the engine rejects a second task pointing at
 * the same item. Distinct from {@link SprintEngineTask.sourceDocs} (a reading
 * list) and {@link SprintEngineTaskSource} (bidirectional tracker sync).
 */
export type SprintEngineTaskBacklogRef = {
  /** Project-root-relative, POSIX-separated path to the backlog item file. */
  projectRelativePath: string
  /** The item's human key when known, e.g. `MC-1843`. */
  displayKey?: string
}

export type SprintEngineTask = {
  id: string
  title: string
  description?: string | null
  /**
   * What KIND of agent should do this task — a role, and only that. Absent
   * means any agent may take it, which is what a roleless run writes on every
   * task (MC-2057). Whether this is the run's COORDINATION job is a separate
   * question, answered by `isSprintEngineCoordinationTask`; the two used to be
   * fused into this one field, and `general` existed only to smuggle "no role"
   * through it. Absent is not `''` — the engine's `worker_role` returns `''`
   * for "could not establish", which is a different statement.
   */
  role?: SprintEngineRoleId
  /**
   * Id of the declared repo this task works in — one task, one git tree, always.
   * `ownedPaths` and every evidence path stay relative to THAT repo's root, so a
   * sibling repo is only ever expressible as (repo id, relative path). The
   * projection always sets it; a run declaring one repo reads
   * {@link DEFAULT_SPRINTENGINE_TASK_REPO} on every task.
   */
  repo: string
  /**
   * Project-root-relative path to THIS task's own worktree, recorded by the
   * engine when it provisions one under per-task isolation (`vcs.taskIsolation`,
   * MC-2130/2136) and cleared when that tree is removed. Absent on every task of
   * a normal run, where the tree is the repo's shared run worktree.
   *
   * It is the projection half of the terminal-cwd contract: an agent working
   * this task must cwd HERE, or it would edit the run tree while the engine
   * commits from this one. `resolveSprintEngineSessionCwd` is the one reader.
   */
  worktreePath?: string
  status: SprintEngineTaskStatus
  /**
   * Charter marker, not machinery. `review` names a planned review of other
   * tasks' work; `integration_review` names the terminal task that proves the
   * pieces work together (build, run the app, exercise the seams). Both claim,
   * publish, and complete like any other task — the markers exist for
   * plan-approval coverage warnings and the board badge, because roles never
   * self-dispatch and an unplanned review is no review at all. Absent means
   * ordinary work.
   */
  kind?: SprintEngineTaskKind
  source?: SprintEngineTaskSource
  ownerAgentId: string | null
  /** Worker who last published an implementation pass. Retained after the task
   *  leaves the worker's hands (its `review` phase) so the owning worker stays
   *  visible while `ownerAgentId` is null. */
  lastImplementedByAgentId?: string | null
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
  /** Canonical source documents (reference-sourced runs): the worker's read-in-full brief. */
  sourceDocs?: string[]
  /** The backlog item this task delivers, when it delivers one. */
  backlogRef?: SprintEngineTaskBacklogRef
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
   * `defaultPhases`"; `[]` means publish routes straight to `done`.
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
   * The post-implementation phases every task on this run inherits (run.yaml
   * `defaultPhases`, projection-owned; the wizard forwards it as an init flag).
   * It is the DEFAULT and the CEILING — a task may trim its `phases`, never add
   * one outside this set, so `[]` ("agents on this run don't review their own
   * work") is an operator guarantee, not an architect preference. Absent means
   * the engine default, `['review']`.
   */
  defaultPhases?: SprintEngineTaskPhase[]
}

/**
 * One roster seat's execution runtime. `reasoning` is the seat's reasoning-effort
 * level (MC-1885), carried beside the CLI + model so a level picked for a role
 * reaches every spawn of that role. Absent/null means the CLI's own default
 * effort — no flag, exactly like an absent `model` means no `--model`.
 */
type SprintEngineRoleRuntime = {
  model?: string | null
  cli?: string | null
  reasoning?: string | null
}
export type SprintEngineRoleRuntimes = Partial<Record<SprintEngineRoleId, SprintEngineRoleRuntime>>

/**
 * Merge state of one branch's pull request: 'open' until the PR merges or the branch
 * lands in its base; 'merged' and 'closed' are terminal, and polling stops there.
 */
export type SprintEnginePullRequestState = 'open' | 'merged' | 'closed' | null

/**
 * One repo a run works in (MC-1611). Mirrors the entry shape the engine writes to
 * `sprintengine.vcs.repos` in run.yaml. `root` is workspace-relative — `.` for the
 * primary repo, a sibling project's directory for the rest — and `worktreePath` is
 * that repo's own run worktree.
 *
 * A run spanning projects delivers one branch per project, so each repo carries its
 * own pull request and its own merge state (MC-1612): one project's PR merges, and
 * only that project's worktree goes. The primary's copies of these fields are also
 * the flat `vcs.*` fields, which is what every surface that predates the list reads.
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
  pullRequestUrl?: string | null
  /** Reason this repo's last pull-request open failed, surfaced with Retry. */
  pullRequestError?: string | null
  /** Merge state of THIS repo's branch; 'merged'/'closed' are terminal. */
  pullRequestState?: SprintEnginePullRequestState
}

export type SprintEngineVcs = {
  mode: 'run_worktree'
  /**
   * Per-task isolation (MC-2130), chosen at run creation and immutable after
   * (MC-2136): every task gets its OWN worktree branched off the run branch,
   * merged back at publish, instead of sharing this run worktree. Absent/false
   * is the normal mode — one shared checkout per repo for the whole run.
   *
   * Where a task's agent terminal actually cwds is `task.worktreePath`, which
   * the engine records when it provisions that tree; this flag only says the
   * run works that way.
   */
  taskIsolation?: boolean
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
  pullRequestState?: SprintEnginePullRequestState
  lastCommitSha?: string | null
  /**
   * Every repo the run works in, entry zero first (the primary repo, `root: '.'`).
   * Always populated: a run stored before this list existed describes its one repo
   * with the flat fields above, and the normalizer reads that back as a one-entry
   * list, so readers only ever handle the list. The flat fields remain the primary
   * repo's live values until the surfaces that read them move onto `repos`.
   */
  repos: SprintEngineVcsRepo[]
  /**
   * How many repos the store DECLARED, counted before the normalizer dropped any
   * entry it could not resolve a tree for (MC-1613 / backlog 1722). The merge
   * rollup counts against this, not the survivor list, so a partially-provisioned
   * or hand-edited sibling that vanishes from `repos` still counts as unmerged —
   * `allMerged` can never flip true while a declared branch is unaccounted for.
   * Absent on a `vcs` restored from state written before this field existed; the
   * rollup falls back to the survivor count there.
   */
  declaredRepoCount?: number
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
  // Reasoning-effort level the session launched with (MC-1885). Recorded so a
  // re-opened seat reads back the level it ran at; the resume argv itself never
  // re-passes it (no manifest spreads reasoningArgs on resume).
  cliReasoning?: string
  // Display label captured for the roster/tab when the session is re-opened.
  name?: string
  recordedAt: number
}

export type SprintEngineRosterSessions = Record<AgentId, SprintEngineRosterSession>

// Explicit per-role model selection from the new-workspace roster. A string
// is an explicit model id; null or an absent role means "CLI default" (no
// model flag passed).
export type SprintEngineRoleModelOverrides = Partial<Record<SprintEngineRoleId, string | null>>

// Explicit per-role reasoning-effort selection from the new-workspace roster
// (MC-1885). A string is a level the role's CLI declares; null or an absent role
// means the CLI's own default effort, which passes no flag. Mirrors
// SprintEngineRoleModelOverrides, and lands in the same `roleRuntimes` entry.
export type SprintEngineRoleReasoningOverrides = Partial<Record<SprintEngineRoleId, string | null>>

export type SprintEngineSavedRoster = {
  roleCounts: SprintEngineRoleCounts
  roleCliDefaults: SprintEngineRoleCliDefaults
  // Per-role explicit launch model, saved alongside the CLI so a reused roster
  // restores the model too. Absent role = CLI default (no model flag). Only
  // explicit model ids are stored (a "CLI default" pick is dropped, since it is
  // indistinguishable from absent at launch).
  roleModelOverrides?: SprintEngineRoleModelOverrides
  // NO reasoning member, and that omission is a DECISION, not an oversight
  // (ruling 2026-07-28, MC-1885's wizard producer). A saved roster persists the
  // model but not the effort level, so a reused preset launches at its CLI's
  // own default effort. Adding one here is a store-schema change, and this
  // run's schema numbers are already pinned to MC-1865 (69) and MC-1870 (70) —
  // a third migration inside one run is how migration ordering goes wrong.
  // Effort diverging from model on presets is a known, accepted gap tracked as
  // its own remainder in
  // `backlog/2026-07-28-reasoning-effort-remaining-surfaces.md`; the wizard's
  // level stays session-local (`useRosterEditor.roleReasoningOverrides`) until
  // that item lands.
}

// A named, reusable roster preset. Lets users keep several rosters — e.g. a
// lightweight two-agent roster and a heavyweight full-review one — and pick one
// when creating a workspace instead of reconfiguring every time.
//
// NAMING (MC-1874): a ROSTER is agent CONFIGURATION — which roles, which CLIs,
// which models. It is NOT a "team". In this codebase `team` means the run
// directory slug (`.sprintengine/sprintengine/<team>/run.yaml`) and appears as
// `teamSlug` / `teamName` / `teamDirectoryPath`. The two used to share the word
// and met in the same signatures; keep them apart.
//
// A roster is a SET OF ROLES, nothing else (MC-2064, superseding MC-1875's
// `mode` formation axis). "No roles" is not a kind of roster — it is the
// alternative to having one, a level above rosters, represented only by the
// built-in reference below.

// The built-in "No roles" (non-)roster: no souls, no specialists, no architect
// — one plain agent per task up to the run's max-concurrency setting, with one
// of them doing the planning. It is the zero-configuration DEFAULT (MC-1876).
//
// SYNTHETIC, never a row in `savedRosters`: a seeded row could be deleted,
// renamed, or edited into something else, and then "the default" would mean
// different things on different machines. Choosing it means "no roster".
//
// Lives in shared rather than beside the wizard helpers because the settings
// store must recognise the id too (to let the selection stick without
// persisting a phantom roster) and the store must not import renderer
// components. `newWorkspace/savedRosters.ts` re-exports it.
export const NO_ROLES_ROSTER_ID = 'builtin:no-roles'
export const NO_ROLES_ROSTER_NAME = 'No roles'

// True for the built-in, by id OR by name — a plan file may name it either way
// (`roster: No roles` in frontmatter). Case- and space-insensitive on the name
// so hand-authored frontmatter resolves.
export function isNoRolesRosterRef(ref: string | null | undefined): boolean {
  if (!ref) return false
  const trimmed = ref.trim()
  return trimmed === NO_ROLES_ROSTER_ID || trimmed.toLowerCase() === NO_ROLES_ROSTER_NAME.toLowerCase()
}

export type SprintEngineRoster = {
  id: string
  name: string
  roleCounts: SprintEngineRoleCounts
  roleCliDefaults: SprintEngineRoleCliDefaults
  // Per-role explicit launch model (see SprintEngineSavedRoster). Absent on
  // rosters saved before model persistence — those fall back to CLI default.
  roleModelOverrides?: SprintEngineRoleModelOverrides
  createdAt: number
  updatedAt: number
}

export type SprintEngineRoleSettings = {
  enabled: Record<SprintEngineRoleId, boolean>
  // Legacy single-roster default, retained for migration and as the run-mount
  // CLI-default fallback. New saves go through `savedRosters`.
  savedRoster?: SprintEngineSavedRoster | null
  // Named roster presets the user can pick from.
  savedRosters?: SprintEngineRoster[]
  // The roster most recently selected/saved, used to seed the new-workspace wizard.
  lastSelectedRosterId?: string | null
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
  // Gated by unresolved prerequisites — would be ready, but a dependency is
  // still in flight. A held state (ring with a horizontal bar), calm neutral
  // ink: waiting on other work, never an error.
  | 'blocked'
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
