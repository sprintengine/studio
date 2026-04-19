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
export type SwarmPromptMap = Record<SwarmRole, string>
export type SwarmRoleCounts = Record<SwarmRole, number>

export type SwarmPhase = 'planning' | 'awaiting_approval' | 'executing' | 'completed'

export type SwarmTaskStatus = 'todo' | 'in_progress' | 'needs_input' | 'done'

export type SwarmTaskBoardColumn = 'todo' | 'ready' | 'in_progress' | 'needs_input' | 'done'

export type SwarmArtifact = {
  id: string
  type: string
  title: string
  path?: string
  content?: string
}

export type SwarmEvent = {
  id: string
  timestamp: number
  type: string
  actor: string
  message: string
}

export type SwarmTaskEvidence = {
  summary: string
  touchedFiles: string[]
  commandsRan: string[]
  results: string[]
}

export type SwarmTaskValidation = {
  ok: boolean
  checkedAt: number | null
  errors: string[]
  warnings: string[]
}

export type SwarmRuntimeAgentStatus =
  | 'idle'
  | 'planning'
  | 'running'
  | 'needs_input'
  | 'complete'
  | 'error'

export type SwarmRuntimeAgent = {
  role: SwarmRole
  status: SwarmRuntimeAgentStatus
  currentTaskId: string | null
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
  questionsForUser: string[]
  notes: string[]
  artifacts: SwarmArtifact[]
  startedAt: number | null
  completedAt: number | null
}

export type SwarmState = {
  name: string
  goal: string
  agentCount: number
  roleCounts: SwarmRoleCounts
  skills: SwarmSkillMap
  rolePrompts: SwarmPromptMap
  swarmAgents: Record<string, SwarmRuntimeAgent>
  phase: SwarmPhase
  planApproved: boolean
  planReady: boolean
  planReadyAt: number | null
  planReadyBy: string | null
  taskGraphReplacedAt: number | null
  taskValidation: SwarmTaskValidation | null
  artifacts: SwarmArtifact[]
  events: SwarmEvent[]
  tasks: SwarmTask[]
}

export type SwarmMockConfig = Pick<
  SwarmState,
  'name' | 'goal' | 'agentCount' | 'roleCounts' | 'skills' | 'rolePrompts'
>

export type AgentMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
}

export type AgentStatus = 'idle' | 'running' | 'streaming' | 'error' | 'complete'

export type AgentState = {
  id: AgentId
  name: string
  status: AgentStatus
  messages: AgentMessage[]
  streamBuffer: string
  cliSessionId?: string
  cliHasLaunched?: boolean
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
  templateId: string
  layoutModel: IJsonModel
  agents: Record<AgentId, AgentState>
  editorState: EditorState
  swarmState: SwarmState | null
  createdAt: number
}
