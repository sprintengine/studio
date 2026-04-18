import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import type { IJsonModel } from 'flexlayout-react'
import { nanoid } from 'nanoid'
import type {
  Workspace,
  WorkspaceId,
  LayoutTemplate,
  AgentState,
  AgentId,
  SwarmConfig,
} from '../types/workspace'
import { extractAgentIds } from '../utils/layout'

interface WorkspaceStore {
  workspaces: Workspace[]
  activeWorkspaceId: WorkspaceId | null
  addWorkspace: (template: LayoutTemplate, options?: { name?: string; folderPath?: string | null }) => void
  removeWorkspace: (id: WorkspaceId) => void
  renameWorkspace: (id: WorkspaceId, name: string) => void
  setActiveWorkspace: (id: WorkspaceId) => void
  updateLayout: (id: WorkspaceId, model: IJsonModel) => void
  updateAgent: (workspaceId: WorkspaceId, agentId: AgentId, update: Partial<AgentState>) => void
  appendStream: (workspaceId: WorkspaceId, agentId: AgentId, chunk: string) => void
  commitStream: (workspaceId: WorkspaceId, agentId: AgentId) => void
  updateSwarm: (workspaceId: WorkspaceId, config: Partial<SwarmConfig>) => void
  importWorkspace: (ws: Workspace) => void
}

const defaultAgent = (id: AgentId): AgentState => ({
  id,
  name: id,
  status: 'idle',
  messages: [],
  streamBuffer: '',
})

const defaultSwarmConfig = (agentIds: string[]): SwarmConfig => ({
  enabled: false,
  agents: agentIds.map((id) => ({ agentId: id, role: 'standalone' })),
  orchestratorId: null,
})

export const useWorkspaceStore = create<WorkspaceStore>()(
  persist(
    immer((set) => ({
      workspaces: [],
      activeWorkspaceId: null,

      addWorkspace: (template, options) =>
        set((state) => {
          const id = nanoid()
          const agentIds = extractAgentIds(template.layout)
          const fallbackName = `${template.name} ${state.workspaces.length + 1}`
          state.workspaces.push({
            id,
            name: options?.name?.trim() || fallbackName,
            folderPath: options?.folderPath ?? null,
            templateId: template.id,
            layoutModel: template.layout,
            agents: {},
            swarmConfig: defaultSwarmConfig(agentIds),
            createdAt: Date.now(),
          })
          state.activeWorkspaceId = id
        }),

      removeWorkspace: (id) =>
        set((state) => {
          const idx = state.workspaces.findIndex((w) => w.id === id)
          if (idx === -1) return
          state.workspaces.splice(idx, 1)
          if (state.activeWorkspaceId === id) {
            state.activeWorkspaceId = state.workspaces.at(-1)?.id ?? null
          }
        }),

      renameWorkspace: (id, name) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === id)
          if (ws) ws.name = name.trim() || ws.name
        }),

      setActiveWorkspace: (id) =>
        set((state) => { state.activeWorkspaceId = id }),

      updateLayout: (id, model) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === id)
          if (ws) ws.layoutModel = model
        }),

      updateAgent: (workspaceId, agentId, update) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          if (!ws.agents[agentId]) ws.agents[agentId] = defaultAgent(agentId)
          Object.assign(ws.agents[agentId], update)
        }),

      appendStream: (workspaceId, agentId, chunk) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          if (!ws.agents[agentId]) ws.agents[agentId] = defaultAgent(agentId)
          ws.agents[agentId].streamBuffer += chunk
          ws.agents[agentId].status = 'streaming'
        }),

      commitStream: (workspaceId, agentId) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          const agent = ws?.agents[agentId]
          if (!agent) return

          if (agent.streamBuffer) {
            agent.messages.push({
              role: 'assistant',
              content: agent.streamBuffer,
              timestamp: Date.now(),
            })
            agent.streamBuffer = ''
          }

          if (agent.status !== 'error') {
            agent.status = 'complete'
          }
        }),

      updateSwarm: (workspaceId, config) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          Object.assign(ws.swarmConfig, config)
          // Keep orchestratorId in sync with agents array
          const orchAgent = ws.swarmConfig.agents.find((a) => a.role === 'orchestrator')
          ws.swarmConfig.orchestratorId = orchAgent?.agentId ?? null
        }),

      importWorkspace: (ws) =>
        set((state) => {
          const id = nanoid()
          state.workspaces.push({
            ...ws,
            id,
            name: `${ws.name} (imported)`,
            folderPath: ws.folderPath ?? null,
            agents: Object.fromEntries(
              Object.entries(ws.agents).map(([k, v]) => [
                k,
                { ...v, streamBuffer: '', status: 'idle' as const },
              ])
            ),
          })
          state.activeWorkspaceId = id
        }),
    })),
    {
      name: 'free-ai-ide-workspaces',
      partialize: (s) => ({
        workspaces: s.workspaces.map((ws) => ({
          ...ws,
          agents: Object.fromEntries(
            Object.entries(ws.agents).map(([id, a]) => [
              id,
              { ...a, streamBuffer: '', status: 'idle' as const },
            ])
          ),
        })),
        activeWorkspaceId: s.activeWorkspaceId,
      }),
    }
  )
)
