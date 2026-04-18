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

export type SwarmRole = 'orchestrator' | 'worker' | 'reviewer' | 'standalone'

export type SwarmAgent = {
  agentId: AgentId
  role: SwarmRole
  config?: AgentConfig
}

export type SwarmConfig = {
  enabled: boolean
  agents: SwarmAgent[]
  orchestratorId: AgentId | null
}

export type Workspace = {
  id: WorkspaceId
  name: string
  templateId: string
  layoutModel: IJsonModel
  agents: Record<AgentId, AgentState>
  swarmConfig: SwarmConfig
  createdAt: number
}
