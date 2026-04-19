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

export type SwarmRole = 'architect' | 'developer' | 'frontend' | 'tester' | 'security'

export type SwarmSkillMap = Record<SwarmRole, string[]>
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
  goal: string
  agentCount: number
  roleCounts: SwarmRoleCounts
  skills: SwarmSkillMap
  phase: SwarmPhase
  planApproved: boolean
  artifacts: SwarmArtifact[]
  events: SwarmEvent[]
  tasks: SwarmTask[]
}

export type SwarmMockConfig = Pick<SwarmState, 'goal' | 'agentCount' | 'roleCounts' | 'skills'>

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
