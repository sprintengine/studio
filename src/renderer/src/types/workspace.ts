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

export type SwarmRole = 'architect' | 'product' | 'developer' | 'frontend' | 'tester' | 'security'

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

export type SwarmRuntimeAgentStatus = 'idle' | 'running' | 'needs_input' | 'done'

export type SwarmRuntimeAgent = {
  role: SwarmRole
  status: SwarmRuntimeAgentStatus
  currentTaskId: string | null
}

export type SwarmAutoPendingSpawn = {
  taskId: string
  agentId: string
}

export type SwarmAutoState = {
  enabled: boolean
  pending: SwarmAutoPendingSpawn | null
}

export type SwarmWorkspaceContext = {
  teamName: string
  teamSlug: string
  teamDirectoryPath: string
  statePath: string
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
  notes: string[]
  startedAt: string | null
  completedAt: string | null
}

export type SwarmState = {
  name: string
  goal: string
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
export type AgentKind = 'general' | 'specialist' | 'swarm'
export type SpecialistActionId =
  | 'architect'
  | 'developer'
  | 'devops-infra'
  | 'qa-test'
  | 'security-review'
  | 'frontend-design-review'
  | 'code-review'

export type CliRuntimeSettings = {
  command: string
  useWsl: boolean
}

export type AppSettings = {
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>
  lastSelectedCli: AgentCli
  lastSelectedSpecialist: SpecialistActionId
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
  messages: AgentMessage[]
  streamBuffer: string
  cliSessionId?: string
  cliStartRequested?: boolean
  cliRestartNonce?: number
  cliHasLaunched?: boolean
  cliOnboardingPromptSent?: boolean
  cli?: AgentCli
  cliStartupPrompt?: string
  kind?: AgentKind
  specialistId?: SpecialistActionId
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
  content: string
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
  mode: 'standard' | 'swarm'
  folderPath: string | null
  folderMissing?: boolean
  swarmContext?: SwarmWorkspaceContext | null
  templateId: string
  layoutModel: IJsonModel
  agents: Record<AgentId, AgentState>
  editorState: EditorState
  swarmState: SwarmState | null
  swarmAutoState: SwarmAutoState
  createdAt: number
}
