import type { IJsonModel } from 'flexlayout-react'

export type WorkspaceId = string
export type AgentId = string
export type WorkspaceMode = 'standard' | 'sprintengine' | 'switchboard' | 'multiloop'

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

export type SprintEngineRole = 'architect' | 'product' | 'developer' | 'frontend' | 'tester' | 'security' | 'code_reviewer' | 'spec_reviewer' | 'performance'

export type SprintEngineSkillMap = Record<SprintEngineRole, string[]>
export type SprintEngineRoleCounts = Record<SprintEngineRole, number>

export type SprintEngineTaskStatus = 'todo' | 'in_progress' | 'needs_input' | 'done'

export type SprintEngineTaskBoardColumn = 'todo' | 'ready' | 'in_progress' | 'needs_input' | 'done'

export type SprintEngineNeedsInputKind = 'architect' | 'user' | 'artifact' | 'tooling' | 'verification' | 'other'

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

export type SprintEngineTaskEvidence = {
  summary: string
  touchedFiles: string[]
  commandsRan: string[]
  results: string[]
}

export type SprintEngineTaskComment = {
  id: string
  actor: string
  source: 'user' | 'agent' | 'system'
  body: string
  createdAt: string
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
  role: SprintEngineRole
  scores: SprintEngineTaskFeedbackScores
  topFriction?: string
  suggestedImprovement?: string
  issues?: SprintEngineTaskFeedbackIssue[]
  findings?: SprintEngineTaskFeedbackFinding[]
}

export type SprintEngineTaskTriage = {
  summary: string
  suggestedRole?: SprintEngineRole
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
  question: string
  suggestedResolution?: string
  reportedBy?: string
  reportedAt?: string
}

export type SprintEngineRuntimeAgentStatus = 'idle' | 'running' | 'needs_input' | 'done'

export type SprintEngineRuntimeAgent = {
  role: SprintEngineRole
  status: SprintEngineRuntimeAgentStatus
  currentTaskId: string | null
}

export type SprintEngineAutoPendingSpawn = {
  taskId: string
  agentId: string
  startedAt?: number
}

export type SprintEngineCliPermissionPreset = 'default' | 'auto_workspace' | 'bypass_all'

export type SprintEngineAutoState = {
  enabled: boolean
  autoApproveArtifacts: boolean
  keepDoneAgentTerminals: boolean
  cliPermissionPreset: SprintEngineCliPermissionPreset
  maxConcurrentAgents: number
  pendingSpawns: SprintEngineAutoPendingSpawn[]
}

export type MultiloopAutoPendingSpawn = {
  role: MultiloopRole | SprintEngineRole
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
  teamName: string
  goal: string
}

export type SprintEngineSource = {
  kind: 'markdown' | string
  origin: 'file' | 'stdin' | 'inline' | string
  path: string
  originalPath?: string
  capturedAt?: string
}

export type SprintEngineTask = {
  id: string
  title: string
  description: string
  role: SprintEngineRole
  status: SprintEngineTaskStatus
  source?: SprintEngineTaskSource
  dispatch?: SprintEngineTaskDispatch
  ownerAgentId: string | null
  dependsOn: string[]
  ownedPaths: string[]
  acceptanceCriteria: string[]
  implementationNotes: string[]
  evidence: SprintEngineTaskEvidence
  feedback?: SprintEngineTaskFeedback
  triage?: SprintEngineTaskTriage
  needsInput?: SprintEngineTaskNeedsInput
  notes: string[]
  comments: SprintEngineTaskComment[]
  startedAt: string | null
  completedAt: string | null
}

export type SprintEngineState = {
  name: string
  goal: string
  rosterConfigured?: boolean
  source?: SprintEngineSource
  updatedAt?: string | null
  roleCounts: SprintEngineRoleCounts
  sprintEngineAgents: Record<string, SprintEngineRuntimeAgent>
  events: SprintEngineEvent[]
  tasks: SprintEngineTask[]
  artifacts: SprintEngineArtifact[]
}

export type SprintEngineMockConfig = Pick<SprintEngineState, 'name' | 'goal' | 'roleCounts'>

export type AgentMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
}

export type AgentStatus = 'idle' | 'running' | 'streaming' | 'error' | 'complete'
export type AgentCli = 'codex' | 'claude'
export type SprintEngineRoleCliDefaults = Partial<Record<SprintEngineRole, AgentCli>>
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

export type AgentKind = 'general' | 'specialist' | 'watchtower' | 'sprintengine' | 'multiloop'
export type AgentExecutionMode = 'current_workspace' | 'worktree'
export type WorktreeEntryStatus = 'available' | 'assigned' | 'missing' | 'removing' | 'error'
export type SpecialistActionId =
  | 'architect'
  | 'product-strategist'
  | 'developer'
  | 'devops-infra'
  | 'performance'
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

export type AppSettings = {
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>
  mcp: McpSettings
  lastSelectedCli: AgentCli
  lastSelectedSpecialist: SpecialistActionId
  lastSelectedMultiloopRole: MultiloopRole
  lastAgentSpawnPermissionPreset: SprintEngineCliPermissionPreset
  specialistCliDefaults: Partial<Record<SpecialistActionId, AgentCli>>
  multiloopRoleCliDefaults: Partial<Record<MultiloopRole, AgentCli>>
  searchExcludes: string[]
  projectKnowledgeRoots: Record<string, string | null>
  recentWorkspaceFolders: string[]
  usageTelemetry: UsageTelemetrySettings
  learning: LearningSettings
}

export type DiagnosticLevel = 'info' | 'warning' | 'error'
export type DiagnosticSource =
  | 'auth'
  | 'filesystem'
  | 'git'
  | 'sprintengine'
  | 'terminal'
  | 'update'
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
  highlight?: WorkspaceHighlight
  createdAt: number
  lastTerminalActivityAt?: number | null
}
