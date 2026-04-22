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
  EditorState,
  SwarmState,
  SwarmRole,
  AgentCli,
  AppSettings,
  CliRuntimeSettings,
} from '../types/workspace'
import { detectLanguage } from '../utils/files'
import {
  buildSwarmAgentRoster,
  buildSwarmAgentRosterForState,
  createDefaultSwarmRoleCounts,
  createInitialSwarmState,
  getNextSwarmAgentId,
  normalizeSwarmState,
} from '../utils/swarm'

interface WorkspaceStore {
  workspaces: Workspace[]
  activeWorkspaceId: WorkspaceId | null
  appSettings: AppSettings
  setCliRuntime: (cli: AgentCli, update: Partial<CliRuntimeSettings>) => void
  setLastSelectedCli: (cli: AgentCli) => void
  addWorkspace: (
    template: LayoutTemplate,
    options?: { name?: string; folderPath?: string | null; swarmState?: SwarmState | null }
  ) => void
  removeWorkspace: (id: WorkspaceId) => void
  renameWorkspace: (id: WorkspaceId, name: string) => void
  setActiveWorkspace: (id: WorkspaceId) => void
  updateLayout: (id: WorkspaceId, model: IJsonModel) => void
  setFolderPath: (id: WorkspaceId, folderPath: string | null) => void
  updateAgent: (workspaceId: WorkspaceId, agentId: AgentId, update: Partial<AgentState>) => void
  setSwarmState: (workspaceId: WorkspaceId, swarmState: SwarmState | null) => void
  addSwarmMember: (
    workspaceId: WorkspaceId,
    role: SwarmRole
  ) => { id: AgentId; label: string } | null
  appendStream: (workspaceId: WorkspaceId, agentId: AgentId, chunk: string) => void
  commitStream: (workspaceId: WorkspaceId, agentId: AgentId) => void
  importWorkspace: (ws: Workspace) => void

  // Per-workspace editor actions
  openFile: (workspaceId: WorkspaceId, path: string, name: string, content: string) => void
  closeFile: (workspaceId: WorkspaceId, path: string) => void
  setActiveFile: (workspaceId: WorkspaceId, path: string) => void
  updateFileContent: (workspaceId: WorkspaceId, path: string, content: string) => void
  markFileClean: (workspaceId: WorkspaceId, path: string) => void
  remapOpenFiles: (workspaceId: WorkspaceId, fromPath: string, toPath: string) => void
  removeOpenFilesForPath: (workspaceId: WorkspaceId, path: string) => void
}

const defaultAppSettings = (): AppSettings => ({
  cliRuntimes: {
    codex: { command: 'codex', useWsl: false },
    claude: {
      command: 'claude',
      useWsl: typeof window !== 'undefined' && window.api?.platform === 'win32',
    },
  },
  lastSelectedCli: 'claude',
})

const defaultAgent = (id: AgentId, name = id): AgentState => ({
  id,
  name,
  status: 'idle',
  messages: [],
  streamBuffer: '',
  cliSessionId: undefined,
  cliStartRequested: false,
  cliRestartNonce: 0,
  cliHasLaunched: false,
  cliOnboardingPromptSent: false,
  cli: 'codex' as AgentCli,
  cliStartupPrompt: undefined,
})

const defaultEditorState = (): EditorState => ({
  openFiles: [],
  activeFilePath: null,
})

const swarmAgentTab = (id: string, name: string) => ({
  type: 'tab',
  name,
  component: 'agent',
  config: { agentId: id },
})

const swarmTabsLayoutModel = (swarmState: SwarmState | null): IJsonModel => ({
  global: { tabSetEnableDrop: true, tabEnableClose: true },
  borders: [],
  layout: {
    type: 'row',
    children: [
      {
        type: 'tabset',
        weight: 58,
        children: [
          { type: 'tab', name: 'Swarm Map', component: 'swarm-map' },
          { type: 'tab', name: 'Kanban', component: 'swarm-kanban' },
        ],
      },
      {
        type: 'tabset',
        weight: 42,
        children: buildSwarmAgentRosterForState(swarmState).map((agent) =>
          swarmAgentTab(agent.id, agent.label)
        ),
      },
    ],
  },
})

function isLegacySwarmLayout(model: IJsonModel): boolean {
  const serialized = JSON.stringify(model)
  if (serialized.includes('"component":"swarm"') && !serialized.includes('"component":"swarm-map"')) return true
  if (serialized.includes('"component":"swarm-terminals"')) return true

  return false
}

function migrateSwarmLayout(ws: Workspace): Workspace {
  if (ws.mode !== 'swarm' && !ws.swarmState) return ws
  if (!isLegacySwarmLayout(ws.layoutModel)) return ws

  return {
    ...ws,
    layoutModel: swarmTabsLayoutModel(ws.swarmState),
  }
}

function isPathOrChild(path: string, parentPath: string): boolean {
  if (path === parentPath) return true
  const separator = parentPath.includes('\\') && !parentPath.includes('/') ? '\\' : '/'
  return path.startsWith(`${parentPath}${separator}`)
}

function reconcileSwarmAgents(
  currentAgents: Workspace['agents'],
  swarmState: SwarmState | null
): Workspace['agents'] {
  if (!swarmState) return {}

  return Object.fromEntries(
    buildSwarmAgentRosterForState(swarmState).map((agent) => [
      agent.id,
      currentAgents[agent.id]
        ? { ...currentAgents[agent.id], name: agent.label }
        : defaultAgent(agent.id, agent.label),
    ])
  )
}

export const useWorkspaceStore = create<WorkspaceStore>()(
  persist(
    immer((set) => ({
      workspaces: [],
      activeWorkspaceId: null,
      appSettings: defaultAppSettings(),

      setCliRuntime: (cli, update) =>
        set((state) => {
          const defaults = defaultAppSettings()
          state.appSettings.cliRuntimes ??= defaults.cliRuntimes
          state.appSettings.cliRuntimes[cli] = {
            ...defaults.cliRuntimes[cli],
            ...state.appSettings.cliRuntimes[cli],
            ...update,
          }
        }),

      setLastSelectedCli: (cli) =>
        set((state) => {
          state.appSettings.lastSelectedCli = cli
        }),

      addWorkspace: (template, options) =>
        set((state) => {
          const id = nanoid()
          const fallbackName = `${template.name} ${state.workspaces.length + 1}`
          const isSwarm = template.id === 'swarm-mode' || Boolean(options?.swarmState)
          const swarmState = isSwarm
            ? normalizeSwarmState(options?.swarmState)
              ?? createInitialSwarmState({
                goal: options?.swarmState?.goal ?? 'Launch swarm mode',
                name: options?.swarmState?.name ?? options?.name ?? 'Swarm Team',
                roleCounts: options?.swarmState?.roleCounts ?? createDefaultSwarmRoleCounts(),
              })
            : null
          const agents = swarmState
            ? Object.fromEntries(
                buildSwarmAgentRoster(swarmState.roleCounts).map((agent) => [
                  agent.id,
                  defaultAgent(agent.id, agent.label),
                ])
              )
            : {}

          state.workspaces.push({
            id,
            name: options?.name?.trim() || fallbackName,
            mode: swarmState ? 'swarm' : 'standard',
            folderPath: options?.folderPath ?? null,
            templateId: template.id,
            layoutModel: template.layout,
            agents,
            editorState: defaultEditorState(),
            swarmState,
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

      setFolderPath: (id, folderPath) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === id)
          if (ws) ws.folderPath = folderPath
        }),

      updateAgent: (workspaceId, agentId, update) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          if (!ws.agents[agentId]) ws.agents[agentId] = defaultAgent(agentId)
          Object.assign(ws.agents[agentId], update)
        }),

      setSwarmState: (workspaceId, swarmState) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          const normalized = normalizeSwarmState(swarmState)
          ws.swarmState = normalized
          ws.mode = normalized ? 'swarm' : 'standard'
          ws.agents = reconcileSwarmAgents(ws.agents, normalized)
        }),

      addSwarmMember: (workspaceId, role) => {
        let addedAgent: { id: AgentId; label: string } | null = null

        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws?.swarmState) return

          const existingArchitect = Object.values(ws.swarmState.swarmAgents).some(
            (agent) => agent.role === 'architect'
          )
          if (role === 'architect' && existingArchitect) return

          const agentId = getNextSwarmAgentId(role, ws.swarmState.swarmAgents)
          ws.swarmState.swarmAgents[agentId] = {
            role,
            status: 'idle',
            currentTaskId: null,
          }
          ws.swarmState.roleCounts[role] += 1

          const rosterAgent = buildSwarmAgentRosterForState(ws.swarmState).find(
            (agent) => agent.id === agentId
          )
          const agentLabel = rosterAgent?.label ?? agentId
          ws.agents[agentId] = defaultAgent(agentId, agentLabel)
          ws.agents = reconcileSwarmAgents(ws.agents, ws.swarmState)
          ws.swarmState.events.push({
            id: `EVT-${String(ws.swarmState.events.length + 1).padStart(3, '0')}`,
            timestamp: new Date().toISOString(),
            type: 'member_added',
            actor: 'user',
            message: `${agentLabel} joined the swarm.`,
          })

          addedAgent = { id: agentId, label: agentLabel }
        })

        return addedAgent
      },

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

      importWorkspace: (ws) =>
        set((state) => {
          const id = nanoid()
          state.workspaces.push({
            ...ws,
            id,
            name: `${ws.name} (imported)`,
            mode: ws.mode ?? (ws.swarmState ? 'swarm' : 'standard'),
            folderPath: ws.folderPath ?? null,
            agents: Object.fromEntries(
              Object.entries(ws.agents).map(([k, v]) => [
                k,
                { ...v, streamBuffer: '', status: 'idle' as const, cliStartupPrompt: undefined },
              ])
            ),
            editorState: ws.editorState ?? defaultEditorState(),
            swarmState: normalizeSwarmState(ws.swarmState),
          } satisfies Workspace)
          const imported = state.workspaces.at(-1)
          if (imported) {
            Object.assign(imported, migrateSwarmLayout(imported))
          }
          state.activeWorkspaceId = id
        }),

      openFile: (workspaceId, path, name, content) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          if (!ws.editorState) ws.editorState = defaultEditorState()
          const existing = ws.editorState.openFiles.find((f) => f.path === path)
          if (existing) {
            existing.content = content
            existing.isDirty = false
          } else {
            ws.editorState.openFiles.push({
              path,
              name,
              content,
              language: detectLanguage(name),
              isDirty: false,
            })
          }
          ws.editorState.activeFilePath = path
        }),

      closeFile: (workspaceId, path) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws?.editorState) return
          const idx = ws.editorState.openFiles.findIndex((f) => f.path === path)
          if (idx === -1) return
          ws.editorState.openFiles.splice(idx, 1)
          if (ws.editorState.activeFilePath === path) {
            ws.editorState.activeFilePath = ws.editorState.openFiles.at(-1)?.path ?? null
          }
        }),

      setActiveFile: (workspaceId, path) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (ws?.editorState) ws.editorState.activeFilePath = path
        }),

      updateFileContent: (workspaceId, path, content) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          const file = ws?.editorState?.openFiles.find((f) => f.path === path)
          if (file) {
            file.content = content
            file.isDirty = true
          }
        }),

      markFileClean: (workspaceId, path) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          const file = ws?.editorState?.openFiles.find((f) => f.path === path)
          if (file) file.isDirty = false
        }),

      remapOpenFiles: (workspaceId, fromPath, toPath) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          const openFiles = ws?.editorState?.openFiles
          if (!ws?.editorState || !openFiles?.length) return

          const separator = fromPath.includes('\\') && !fromPath.includes('/') ? '\\' : '/'
          const fromPrefix = `${fromPath}${separator}`

          openFiles.forEach((file) => {
            if (file.path !== fromPath && !file.path.startsWith(fromPrefix)) return

            const suffix = file.path === fromPath ? '' : file.path.slice(fromPath.length)
            file.path = `${toPath}${suffix}`
            file.name = file.path.split(/[/\\]/).filter(Boolean).pop() ?? file.name
          })

          if (ws.editorState.activeFilePath === fromPath) {
            ws.editorState.activeFilePath = toPath
          } else if (ws.editorState.activeFilePath?.startsWith(fromPrefix)) {
            ws.editorState.activeFilePath = `${toPath}${ws.editorState.activeFilePath.slice(fromPath.length)}`
          }
        }),

      removeOpenFilesForPath: (workspaceId, path) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          const openFiles = ws?.editorState?.openFiles
          if (!ws?.editorState || !openFiles?.length) return

          const activeFileDeleted = ws.editorState.activeFilePath
            ? isPathOrChild(ws.editorState.activeFilePath, path)
            : false

          ws.editorState.openFiles = openFiles.filter((file) => !isPathOrChild(file.path, path))

          if (activeFileDeleted) {
            ws.editorState.activeFilePath = ws.editorState.openFiles.at(-1)?.path ?? null
          }
        }),
    })),
    {
      name: 'free-ai-ide-workspaces',
      version: 11,
      // Migrate older persisted state that lacks editorState / folderPath / swarmState
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as { workspaces?: Workspace[]; activeWorkspaceId?: WorkspaceId | null } | undefined
        if (!state) return state as never
        state.workspaces = state.workspaces ?? []
        if (version < 1) {
          state.workspaces = state.workspaces.map((ws) => ({
            ...ws,
            folderPath: ws.folderPath ?? null,
            editorState: ws.editorState ?? defaultEditorState(),
          }))
        }
        if (version < 2) {
          state.workspaces = state.workspaces.map((ws) => ({
            ...ws,
            mode: ws.mode ?? (ws.swarmState ? 'swarm' : 'standard'),
            swarmState: normalizeSwarmState(ws.swarmState),
          }))
        }
        if (version < 3) {
          state.workspaces = state.workspaces.map((ws) => ({
            ...ws,
            swarmState: normalizeSwarmState(ws.swarmState),
          }))
        }
        if (version < 4) {
          state.workspaces = state.workspaces.map((ws) => migrateSwarmLayout(ws))
        }
        if (version < 5) {
          state.workspaces = state.workspaces.map((ws) => migrateSwarmLayout(ws))
        }
        if (version < 6) {
          state.workspaces = state.workspaces.map((ws) => migrateSwarmLayout(ws))
        }
        if (version < 7) {
          state.workspaces = state.workspaces.map((ws) =>
            ws.mode === 'swarm' || ws.swarmState
              ? { ...ws, layoutModel: swarmTabsLayoutModel(ws.swarmState) }
              : ws
          )
        }
        if (version < 8) {
          state.workspaces = state.workspaces.map((ws) => {
            const swarmState = normalizeSwarmState(ws.swarmState)
            if (ws.mode !== 'swarm' && !swarmState) return ws

            return {
              ...ws,
              swarmState,
              agents: reconcileSwarmAgents(ws.agents, swarmState),
            }
          })
        }
        if (version < 10) {
          type LegacyAppSettings = Partial<AppSettings> & {
            cliCommands?: Partial<Record<AgentCli, string>>
          }
          const current = state as typeof state & { appSettings?: LegacyAppSettings }
          const defaults = defaultAppSettings()
          const existing = current.appSettings ?? {}
          current.appSettings = {
            cliRuntimes: {
              codex: {
                ...defaults.cliRuntimes.codex,
                ...(existing.cliRuntimes?.codex ?? {}),
                command:
                  existing.cliRuntimes?.codex?.command
                  ?? existing.cliCommands?.codex
                  ?? defaults.cliRuntimes.codex.command,
              },
              claude: {
                ...defaults.cliRuntimes.claude,
                ...(existing.cliRuntimes?.claude ?? {}),
                command:
                  existing.cliRuntimes?.claude?.command
                  ?? existing.cliCommands?.claude
                  ?? defaults.cliRuntimes.claude.command,
              },
            },
            lastSelectedCli: defaults.lastSelectedCli,
          }
        }
        if (version < 11) {
          const current = state as typeof state & { appSettings?: Partial<AppSettings> }
          const defaults = defaultAppSettings()
          current.appSettings = {
            ...defaults,
            ...(current.appSettings ?? {}),
            cliRuntimes: {
              ...defaults.cliRuntimes,
              ...(current.appSettings?.cliRuntimes ?? {}),
            },
            lastSelectedCli: current.appSettings?.lastSelectedCli ?? defaults.lastSelectedCli,
          }
        }
        return state as never
      },
      partialize: (s) => ({
        appSettings: s.appSettings,
        workspaces: s.workspaces.map((ws) => ({
          ...ws,
          agents: Object.fromEntries(
            Object.entries(ws.agents).map(([id, a]) => [
              id,
              { ...a, streamBuffer: '', status: 'idle' as const, cliStartupPrompt: undefined },
            ])
          ),
          // Keep file list + active file, drop content so we don't resurrect stale edits
          editorState: {
            openFiles: (ws.editorState?.openFiles ?? []).map((f) => ({
              ...f,
              content: '',
              isDirty: false,
            })),
            activeFilePath: ws.editorState?.activeFilePath ?? null,
          },
        })),
        activeWorkspaceId: s.activeWorkspaceId,
      }),
    }
  )
)
