import type { IJsonModel } from 'flexlayout-react'

export type WorkspaceId = string
export type AgentId = string

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

export type SwarmRole = 'architect' | 'product' | 'developer' | 'frontend' | 'tester' | 'security' | 'code_reviewer' | 'performance'

export type SwarmSkillMap = Record<SwarmRole, string[]>
export type SwarmRoleCounts = Record<SwarmRole, number>

export type SwarmTaskStatus = 'todo' | 'in_progress' | 'needs_input' | 'done'

export type SwarmTaskBoardColumn = 'todo' | 'ready' | 'in_progress' | 'needs_input' | 'done'

export type SwarmArtifactKind =
  | 'architect_plan'
  | 'product_strategy'
  | 'requirements'
  | 'html_mockup'
  | 'design_notes'
  | 'branding'
  | 'security_review'
  | 'code_review'
  | 'performance_review'
  | 'validation_report'

export type SwarmArtifactStatus =
  | 'draft'
  | 'ready_for_review'
  | 'approved'
  | 'changes_requested'
  | 'superseded'

export type SwarmEvent = {
  id: string
  timestamp: string
  type: string
  actor: string
  message: string
}

export type SwarmArtifactReviewHistoryEntry = {
  action: string
  actor: string
  timestamp: string
  note?: string
}

export type SwarmArtifact = {
  id: string
  kind: SwarmArtifactKind
  title: string
  path: string
  status: SwarmArtifactStatus
  createdBy: string
  taskId: string
  fingerprint: string | null
  reviewHistory: SwarmArtifactReviewHistoryEntry[]
  recommendedTasks: string[]
  createdAt: string | null
  updatedAt: string | null
  approvedBy?: string | null
  approvedAt?: string | null
  changesRequestedBy?: string | null
  changesRequestedAt?: string | null
}

export type SwarmTaskEvidence = {
  summary: string
  touchedFiles: string[]
  commandsRan: string[]
  results: string[]
}

export type SwarmTaskFeedbackScores = {
  directiveClarityPct?: number
  taskClarityPct?: number
  acceptanceCriteriaClarityPct?: number
  swarmToolEffectivenessPct?: number
  promptOptimizationPct?: number
  contextFitPct?: number
  hallucinationRiskPct?: number
  roleFitPct?: number
  autonomyPct?: number
  confidencePct?: number
}

export type SwarmTaskFeedbackIssueCategory =
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

export type SwarmTaskFeedbackIssueSeverity = 'low' | 'medium' | 'high'
export type SwarmTaskFeedbackIssueStatus = 'new' | 'reviewed' | 'applied' | 'rejected' | 'deferred'

export type SwarmTaskFeedbackIssue = {
  id: string
  category: SwarmTaskFeedbackIssueCategory
  severity: SwarmTaskFeedbackIssueSeverity
  target?: string
  title: string
  detail: string
  evidence?: string
  suggestedPromptChange?: string
  suggestedProcessChange?: string
  status?: SwarmTaskFeedbackIssueStatus
}

export type SwarmTaskFeedbackFindingKind =
  | 'code_bug'
  | 'security_issue'
  | 'product_requirement_violation'
  | 'test_gap'
  | 'accessibility_issue'
  | 'performance_issue'
  | 'reliability_issue'
  | 'documentation_gap'
  | 'other'

export type SwarmTaskFeedbackFindingSeverity = 'critical' | 'high' | 'medium' | 'low'

export type SwarmTaskFeedbackFindingArea =
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

export type SwarmTaskFeedbackFindingStatus = 'open' | 'accepted' | 'fixed' | 'rejected' | 'deferred'

export type SwarmTaskFeedbackFinding = {
  id: string
  kind: SwarmTaskFeedbackFindingKind
  severity: SwarmTaskFeedbackFindingSeverity
  area: SwarmTaskFeedbackFindingArea
  title: string
  detail: string
  recommendation?: string
  requirementId?: string
  file?: string
  status?: SwarmTaskFeedbackFindingStatus
}

export type SwarmTaskFeedback = {
  schemaVersion: number
  capturedAt: string
  source: 'agent_self_report' | string
  agentId: string
  role: SwarmRole
  scores: SwarmTaskFeedbackScores
  topFriction?: string
  suggestedImprovement?: string
  issues?: SwarmTaskFeedbackIssue[]
  findings?: SwarmTaskFeedbackFinding[]
}

export type SwarmRuntimeAgentStatus = 'idle' | 'running' | 'needs_input' | 'done'

export type SwarmRuntimeAgent = {
  role: SwarmRole
  status: SwarmRuntimeAgentStatus
  currentTaskId: string | null
}

export type SwarmAutoPendingSpawn = {
  taskId: string
  agentId: string
  startedAt?: number
}

export type SwarmCliPermissionPreset = 'default' | 'auto_workspace' | 'bypass_all'

export type SwarmAutoState = {
  enabled: boolean
  autoApproveArtifacts: boolean
  keepDoneAgentTerminals: boolean
  cliPermissionPreset: SwarmCliPermissionPreset
  useWorktreesForSwarms: boolean
  isolateWorkersInWorktrees?: boolean
  architectMergeAutoTriggeredKey?: string | null
  pendingSpawns: SwarmAutoPendingSpawn[]
}

export type MultiloopAutoPendingSpawn = {
  role: MultiloopAgentSoulRole
  taskId?: string | null
  agentId: string
  startedAt?: number
}

export type MultiloopAutoState = {
  enabled: boolean
  cliPermissionPreset: SwarmCliPermissionPreset
  maxConcurrentAgents: number
  coordinatorAutoSpawnKey?: string | null
  pendingSpawns: MultiloopAutoPendingSpawn[]
}

export type SwarmWorkspaceContext = {
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
  teamName: string
  goal: string
}

export type SwarmSource = {
  kind: 'markdown' | string
  origin: 'file' | 'stdin' | 'inline' | string
  path: string
  originalPath?: string
  capturedAt?: string
}

export type SwarmTask = {
  id: string
  title: string
  description: string
  role: SwarmRole
  status: SwarmTaskStatus
  ownerAgentId: string | null
  dependsOn: string[]
  ownedPaths: string[]
  acceptanceCriteria: string[]
  implementationNotes: string[]
  evidence: SwarmTaskEvidence
  feedback?: SwarmTaskFeedback
  notes: string[]
  startedAt: string | null
  completedAt: string | null
}

export type SwarmState = {
  name: string
  goal: string
  source?: SwarmSource
  updatedAt?: string | null
  roleCounts: SwarmRoleCounts
  swarmAgents: Record<string, SwarmRuntimeAgent>
  events: SwarmEvent[]
  tasks: SwarmTask[]
  artifacts: SwarmArtifact[]
}

export type SwarmMockConfig = Pick<SwarmState, 'name' | 'goal' | 'roleCounts'>

export type AgentMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
}

export type AgentStatus = 'idle' | 'running' | 'streaming' | 'error' | 'complete'
export type AgentCli = 'codex' | 'claude'
export type SwarmRoleCliDefaults = Partial<Record<SwarmRole, AgentCli>>
export type MultiloopAgentSoulRole =
  | 'coordinator'
  | 'architect'
  | 'product'
  | 'developer'
  | 'frontend'
  | 'tester'
  | 'security'
  | 'code_reviewer'
  | 'performance'

export type AgentKind = 'general' | 'specialist' | 'swarm' | 'multiloop'
export type AgentExecutionMode = 'current_workspace' | 'worktree'
export type WorktreeEntryStatus = 'available' | 'assigned' | 'missing' | 'removing' | 'error'
export type SpecialistActionId =
  | 'architect'
  | 'product-strategist'
  | 'developer'
  | 'devops-infra'
  | 'performance'
  | 'qa-test'
  | 'security-review'
  | 'frontend-design-review'
  | 'code-review'

export type CliRuntimeSettings = {
  command: string
  useWsl: boolean
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

export type UsageTelemetrySettings = {
  sendUsageData: boolean
  localDevExportEnabled: boolean
  lastExportAt: string | null
  exportDiagnostics: boolean
}

export type AppSettings = {
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>
  lastSelectedCli: AgentCli
  lastSelectedSpecialist: SpecialistActionId
  lastSelectedMultiloopRole: MultiloopAgentSoulRole
  lastAgentSpawnPermissionPreset: SwarmCliPermissionPreset
  searchExcludes: string[]
  recentWorkspaceFolders: string[]
  usageTelemetry: UsageTelemetrySettings
}

export type DiagnosticLevel = 'info' | 'warning' | 'error'
export type DiagnosticSource =
  | 'auth'
  | 'filesystem'
  | 'git'
  | 'swarm'
  | 'terminal'
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

export type AgentState = {
  id: AgentId
  name: string
  status: AgentStatus
  execution: AgentExecution
  messages: AgentMessage[]
  streamBuffer: string
  cliSessionId?: string
  cliStartRequested?: boolean
  cliRestartNonce?: number
  cliHasLaunched?: boolean
  cliOnboardingPromptSent?: boolean
  cli?: AgentCli
  cliPermissionPreset?: SwarmCliPermissionPreset
  cliStartupPrompt?: string
  kind?: AgentKind
  specialistId?: SpecialistActionId
  multiloopRole?: MultiloopAgentSoulRole
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
  mode: 'standard' | 'swarm' | 'multiloop'
  folderPath: string | null
  folderMissing?: boolean
  swarmContext?: SwarmWorkspaceContext | null
  multiloopContext?: MultiloopWorkspaceContext | null
  templateId: string
  layoutModel: IJsonModel
  agents: Record<AgentId, AgentState>
  worktreeState: WorkspaceWorktreeState
  editorState: EditorState
  swarmState: SwarmState | null
  multiloopState?: MultiloopState | null
  swarmRoleCliDefaults?: SwarmRoleCliDefaults
  swarmAutoState: SwarmAutoState
  multiloopAutoState: MultiloopAutoState
  createdAt: number
}
