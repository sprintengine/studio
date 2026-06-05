import type { IJsonModel } from 'flexlayout-react'
import type { OnboardingStep } from '../store/onboardingState'

export type WorkspaceId = string
export type WorkspaceWindowId = string
export type AgentId = string
export type WorkspaceMode = 'standard' | 'sprintengine' | 'switchboard' | 'multiloop' | 'guided-brief'

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
export type SprintEngineRole = 'architect' | 'product' | 'developer' | 'frontend' | 'tester' | 'security' | 'code_reviewer' | 'spec_reviewer' | 'performance' | 'cross_platform'

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

export type SprintEngineTaskStatus = 'todo' | 'changes_requested' | 'in_progress' | 'review' | 'testing' | 'product' | 'needs_input' | 'done'

export type SprintEngineTaskBoardColumn = 'todo' | 'ready' | 'changes_requested' | 'in_progress' | 'review' | 'testing' | 'product' | 'needs_input' | 'done'

export type SprintEngineQualityGatePhase = 'review' | 'testing' | 'product'

export type SprintEngineQualityGateStatus =
  | 'pending'
  | 'in_progress'
  | 'approved'
  | 'changes_requested'
  | 'blocked'
  | 'skipped'

export type SprintEngineQualityGateAttempt = {
  id?: string
  status?: SprintEngineQualityGateStatus
  actor?: string
  role?: SprintEngineRoleId
  claimedBy?: string
  startedAt?: string
  completedAt?: string
  verdict?: string
  note?: string
  /** Reviewer prose attached on gate verdict (the review itself). */
  summary?: string
}

export type SprintEngineQualityGate = {
  id: string
  phase: SprintEngineQualityGatePhase
  role: SprintEngineRoleId
  status: SprintEngineQualityGateStatus
  required: boolean
  allowSelfReview: boolean
  focus?: string
  attempts: SprintEngineQualityGateAttempt[]
}

export type SprintEngineQualityGateSummary = {
  total: number
  required: number
  openRequired: number
  byPhase: Record<string, number>
  byStatus: Record<string, number>
}

export type SprintEngineQualityPolicyGate = {
  phase: SprintEngineQualityGatePhase
  role: SprintEngineRoleId
  required: boolean
  focus?: string
}

export type SprintEngineQualityPolicy = {
  enabled: boolean
  rosterDriven: boolean
  lifecyclePhases: SprintEngineQualityGatePhase[]
  gates: Record<string, SprintEngineQualityPolicyGate>
}

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
  gateId?: string
  createdBy?: string
  createdAt?: string
}

export type SprintEngineNeedsInputKind = 'architect' | 'user' | 'owner' | 'external_validation'
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
  | 'cross_platform_review'
  | 'validation_report'

export type SprintEngineArtifactStatus =
  | 'draft'
  | 'ready_for_review'
  | 'approved'
  | 'changes_requested'
  | 'superseded'

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
  kind: SprintEngineArtifactKind
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
  title: string
  detail: string
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
export type SprintEngineAgentReviewerMetrics = {
  reviewsPerformed: number
  tasksReviewed: number
  approved: number
  changesRequested: number
  blocked: number
}

export type SprintEngineAgentMetrics = {
  role: SprintEngineRoleId
  selfReported: {
    sampleCount: number
    scores: Record<string, SprintEngineFeedbackScoreStat>
  }
  measured: SprintEngineAgentMeasuredMetrics
  findingsRaised: number
  reviewer?: SprintEngineAgentReviewerMetrics
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

export type SprintEngineTaskDispatchMode = 'dependency' | 'manual'
export type SprintEngineTaskDispatchStatus = 'todo' | 'ready'
export type SprintEngineTaskDispatchTriagedBy = 'none' | 'user' | 'architect'

export type SprintEngineTaskDispatch = {
  mode: SprintEngineTaskDispatchMode
  status?: SprintEngineTaskDispatchStatus
  triagedBy?: SprintEngineTaskDispatchTriagedBy
  readyAt?: string
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

export type SprintEngineRuntimeAgentStatus = 'idle' | 'running' | 'needs_input' | 'done' | 'retired'

export type SprintEngineCurrentDispatch = {
  dispatchId: string | null
  targetKind: string | null
  role?: SprintEngineRoleId
  reason?: string
  taskId?: string
  gateId?: string
  artifactId?: string
  attemptId?: string
  assignedAt?: string
}

export type SprintEngineRuntimeAgent = {
  role: SprintEngineRoleId
  status: SprintEngineRuntimeAgentStatus
  currentTaskId: string | null
  currentGateId?: string | null
  currentGate?: {
    taskId?: string
    gateId?: string
    attemptId?: string
  } | null
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
  gateId?: string
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
  keepDoneAgentTerminals: boolean
  cliPermissionPreset: SprintEngineCliPermissionPreset
  maxConcurrentAgents: number
  pendingSpawns: SprintEngineAutoPendingSpawn[]
  deliveredAgentNotificationEventKeys: string[]
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

export type SprintEngineSourceBundleKind =
  | SprintEngineSourcePlanKind
  | 'html_mockup'
  | 'design_notes'
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
  dispatch?: SprintEngineTaskDispatch
  ownerAgentId: string | null
  /** Worker who last published an implementation pass. Retained after the task
   *  leaves the worker's hands (review/testing/product) so the owning worker
   *  stays visible while `ownerAgentId` is null. */
  lastImplementedByAgentId?: string | null
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
  /** Configured quality gates derived from policy + roster. */
  qualityGates?: SprintEngineQualityGate[]
  /** Backend-computed aggregate of gate counts by phase/status. */
  qualityGateSummary?: SprintEngineQualityGateSummary
  /** Newest-first short list of recent comments (any type). */
  latestComments?: SprintEngineTaskComment[]
  /** Newest-first list of feedback comments whose data.status is still open. */
  latestOpenFeedback?: SprintEngineTaskComment[]
  /** Recorded review/test/product artifacts attached to gate attempts. */
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
  /** Roster-driven quality policy from run.yaml; drives lifecycle column visibility. */
  qualityPolicy?: SprintEngineQualityPolicy
  /** Durable agent polling policy from run.yaml. */
  runner?: SprintEngineRunnerPolicy
}

export type SprintEngineMockConfig = Pick<SprintEngineState, 'name' | 'goal' | 'roleCounts'>

export type AgentMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
}

export type AgentStatus = 'idle' | 'running' | 'streaming' | 'error' | 'complete'
// Runtime CLI identity is a plugin id. Legacy stored values `codex` and
// `claude` remain the default bundled choices while plugin-scoped settings
// can round-trip other manifest ids.
export type AgentCli = string
export type SprintEngineRoleCliDefaults = Partial<Record<SprintEngineRoleId, AgentCli>>

export type SprintEngineRoleSettings = {
  enabled: Record<SprintEngineRoleId, boolean>
}
export type MultiloopRole =
  | 'coordinator'
  | 'architect'
  | 'product'
  | 'developer'
  | 'frontend'
  | 'tester'
  | 'security'
  | 'code_reviewer'
  | 'performance'
  | 'cross_platform'

export type AgentKind = 'general' | 'specialist' | 'watchtower' | 'sprintengine' | 'multiloop'
export type AgentExecutionMode = 'current_workspace' | 'worktree'
export type WorktreeEntryStatus = 'available' | 'assigned' | 'missing' | 'removing' | 'error'
export type SpecialistActionId =
  | 'architect'
  | 'product-strategist'
  | 'developer'
  | 'devops-infra'
  | 'performance'
  | 'cross-platform'
  | 'blog-writer'
  | 'qa-test'
  | 'security-review'
  | 'frontend-design-review'
  | 'code-review'
  | 'spec-review'

export type CliRuntimeSettings = {
  command: string
  useWsl: boolean
}

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

export type AppSettings = {
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>
  mcp: McpSettings
  skillPacks: SkillPackSettings
  lastSelectedCli: AgentCli
  lastSelectedSpecialist: SpecialistActionId
  lastSelectedMultiloopRole: MultiloopRole
  lastAgentSpawnPermissionPreset: SprintEngineCliPermissionPreset
  specialistCliDefaults: Partial<Record<SpecialistActionId, AgentCli>>
  multiloopRoleCliDefaults: Partial<Record<MultiloopRole, AgentCli>>
  /**
   * User-defined display order for the spawn-agent specialist menu. Holds the
   * specialist ids in the sequence the user dragged them into; ids absent here
   * fall back to the canonical roster order. Empty means "use canonical order".
   */
  specialistOrder: SpecialistActionId[]
  sprintEngineRoleSettings: SprintEngineRoleSettings
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
}

export type GuidedBriefHasUi = 'yes' | 'no'

export type GuidedBriefRoleCliDefaults = {
  product: AgentCli
  architect: AgentCli
  frontend: AgentCli
}

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

export type GuidedBriefRuntimeState = {
  workspaceRoot: string
  workspaceName: string
  idea: string
  hasUi: GuidedBriefHasUi
  wantsProductDiscussion: boolean
  wantsArchitectureDiscussion: boolean
  wantsFrontendDiscussion: boolean
  guidedRoleCliDefaults: GuidedBriefRoleCliDefaults
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
  activeMockupPath: string | null
  // Persisted so the renderer reattaches to the same PTY across HMR / refresh
  // instead of spawning a fresh strategist, architect, or designer.
  strategistSessionId: string | null
  architectSessionId: string | null
  designerSessionId: string | null
}

export type DiagnosticLevel = 'info' | 'warning' | 'error'
export type DiagnosticSource =
  | 'auth'
  | 'filesystem'
  | 'git'
  | 'sprintengine'
  | 'terminal'
  | 'update'
  | 'voice'
  | 'workspace'

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
  cliStartRequested?: boolean
  cliRestartNonce?: number
  cliHasLaunched?: boolean
  cliOnboardingPromptSent?: boolean
  cliResumeAvailable?: boolean
  cliLastExitCode?: number | null
  cliLastExitedAt?: number | null
  cli?: AgentCli
  cliPermissionPreset?: SprintEngineCliPermissionPreset
  cliStartupPrompt?: string
  kind?: AgentKind
  specialistId?: SpecialistActionId
  multiloopRole?: MultiloopRole
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

export type Workspace = {
  id: WorkspaceId
  name: string
  mode: WorkspaceMode
  folderPath: string | null
  folderMissing?: boolean
  sprintEngineContext?: SprintEngineWorkspaceContext | null
  multiloopContext?: MultiloopWorkspaceContext | null
  templateId: string
  layoutModel: IJsonModel
  agents: Record<AgentId, AgentState>
  worktreeState: WorkspaceWorktreeState
  memory: WorkspaceMemoryConfig
  editorState: EditorState
  sprintEngineState: SprintEngineState | null
  multiloopState?: MultiloopState | null
  sprintEngineRoleCliDefaults?: SprintEngineRoleCliDefaults
  sprintEngineAutoState: SprintEngineAutoState
  multiloopAutoState: MultiloopAutoState
  guidedBriefState?: GuidedBriefRuntimeState | null
  highlight?: WorkspaceHighlight
  createdAt: number
  lastTerminalActivityAt?: number | null
}
