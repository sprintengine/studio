import type { IJsonModel } from 'flexlayout-react'
import { nanoid } from 'nanoid'
import {
  buildSprintEngineAgentRosterForState,
  createDefaultSprintEngineRoleCounts,
  createInitialSprintEngineState,
  normalizeSprintEngineState,
} from '../../utils/sprintengine'
import {
  deleteEditorBuffer,
  moveEditorBuffer,
  remapEditorBuffers,
  removeEditorBuffersForPath,
  setEditorBuffer,
} from '../../utils/editorBuffers'
import { detectLanguage } from '../../utils/files'
import { normalizeProjectRootKey } from '../../utils/projectKnowledge'
import {
  guidedBriefLayoutModel,
  normalizeGuidedBriefState,
} from './guidedBriefSlice'
import { normalizeRecentWorkspaceFolders } from './settingsSlice'
import type {
  AgentCli,
  AgentExecution,
  AgentId,
  AgentKind,
  AgentState,
  AppSettings,
  EditorState,
  LayoutTemplate,
  MemoryGraphSettings,
  MultiloopAutoState,
  MultiloopState,
  MultiloopWorkspaceContext,
  SprintEngineAutoPendingSpawn,
  SprintEngineAutoState,
  SprintEngineState,
  SprintEngineRole,
  SprintEngineRoleCliDefaults,
  SprintEngineWorkspaceContext,
  Workspace,
  WorkspaceHighlight,
  WorkspaceId,
  WorkspaceMemoryConfig,
  WorkspaceMode,
  WorkspaceWorktreeState,
  WorktreeEntry,
} from '../../types/workspace'
// TerminalSessionSnapshot is a global ambient type from src/renderer/src/env.d.ts.

export function workspaceFolderKey(value: string | null | undefined): string | null {
  const normalized = normalizeProjectRootKey(value)
  return normalized ? normalized.toLowerCase() : null
}

export function normalizeWorkspaceMode(
  input: unknown,
  sprintEngineState?: SprintEngineState | null,
  multiloopState?: MultiloopState | null
): WorkspaceMode {
  if (multiloopState) return 'multiloop'
  if (sprintEngineState) return 'sprintengine'
  if (
    input === 'standard'
    || input === 'sprintengine'
    || input === 'switchboard'
    || input === 'multiloop'
    || input === 'guided-brief'
  ) {
    return input
  }
  return 'standard'
}

export interface WorkspacesSliceState {
  workspaces: Workspace[]
  activeWorkspaceId: WorkspaceId | null
  // Explicit intent record set by removeWorkspace when the splice leaves
  // workspaces=[] and cleared by addWorkspace/importWorkspace. Persisted into
  // the workspace-registry storage key so cold-load distinguishes user-removed-
  // all from hydration failure.
  workspaceRegistryEmptyState: import('../../types/workspace').WorkspaceRegistryEmptyState | null
}

export interface WorkspacesSliceActions {
  reorderWorkspaces: (orderedIds: WorkspaceId[]) => void
  setWorkspaceHighlight: (id: WorkspaceId, highlight: Partial<WorkspaceHighlight>) => void
  clearWorkspaceHighlight: (id: WorkspaceId) => void
  recordWorkspaceTerminalActivity: (id: WorkspaceId, lastOutputAt: number) => void
  forgetFolder: (folderPath: string) => void
  addWorkspace: (
    template: LayoutTemplate,
    options?: {
      name?: string
      folderPath?: string | null
      sprintEngineState?: SprintEngineState | null
      sprintEngineContext?: SprintEngineWorkspaceContext | null
      multiloopState?: MultiloopState | null
      multiloopContext?: MultiloopWorkspaceContext | null
      sprintEngineRoleCliDefaults?: SprintEngineRoleCliDefaults | null
      sprintEngineAutoState?: Partial<SprintEngineAutoState> | null
      multiloopAutoState?: Partial<MultiloopAutoState> | null
      guidedBriefState?: import('../../types/workspace').GuidedBriefRuntimeState | null
      mode?: Workspace['mode']
    }
  ) => WorkspaceId
  removeWorkspace: (id: WorkspaceId) => void
  renameWorkspace: (id: WorkspaceId, name: string) => void
  setActiveWorkspace: (id: WorkspaceId) => void
  setFolderPath: (id: WorkspaceId, folderPath: string | null) => void
  setFolderMissing: (id: WorkspaceId, folderMissing: boolean) => void
  importWorkspace: (ws: Workspace) => void
  moveAgentToWorkspace: (
    sourceWorkspaceId: WorkspaceId,
    destWorkspaceId: WorkspaceId,
    agentId: AgentId
  ) => void
  moveOpenFileToWorkspace: (
    sourceWorkspaceId: WorkspaceId,
    destWorkspaceId: WorkspaceId,
    path: string
  ) => void
}

export type WorkspacesSlice = WorkspacesSliceState & WorkspacesSliceActions

// Cross-slice helpers passed in by workspaceStore.ts. Each is the same module-
// scope function used inline today; deferring its move to the matching slice
// (agents/layout/run-state/worktrees/memory). When those slices land, the deps
// shrink. This explicit DI keeps workspacesSlice import-cycle-free.
export interface WorkspacesSliceDependencies {
  defaultAgent: (id: AgentId, name?: string, kind?: AgentKind) => AgentState
  defaultEditorState: () => EditorState
  defaultWorkspaceMemoryConfig: () => WorkspaceMemoryConfig
  defaultWorkspaceWorktreeState: () => WorkspaceWorktreeState
  normalizeAgentState: (agent: AgentState) => AgentState
  normalizeWorkspaceWorktreeState: (
    input: Partial<WorkspaceWorktreeState> | null | undefined
  ) => WorkspaceWorktreeState
  normalizeSprintEngineWorkspaceContext: (
    input: Partial<SprintEngineWorkspaceContext> | null | undefined,
    folderPath: string | null | undefined,
    sprintEngineState: SprintEngineState | null
  ) => SprintEngineWorkspaceContext | null
  normalizeMultiloopWorkspaceContext: (
    input: Partial<MultiloopWorkspaceContext> | null | undefined,
    folderPath: string | null | undefined,
    multiloopState: MultiloopState | null
  ) => MultiloopWorkspaceContext | null
  normalizeSprintEngineAutoState: (
    input:
      | (Partial<SprintEngineAutoState> & {
        pending?: SprintEngineAutoPendingSpawn | null
        deliveredAgentNotificationEventIds?: string[]
      })
      | null
      | undefined
  ) => SprintEngineAutoState
  normalizeMultiloopAutoState: (
    input: Partial<MultiloopAutoState> | null | undefined
  ) => MultiloopAutoState
  normalizeSprintEngineRoleCliDefaults: (
    input: SprintEngineRoleCliDefaults | null | undefined
  ) => Required<SprintEngineRoleCliDefaults>
  multiloopTabsLayoutModel: () => IJsonModel
  sprintEngineTabsLayoutModel: (
    sprintEngineState: SprintEngineState,
    agents: Workspace['agents'],
    options?: { includeAgentTabs?: boolean }
  ) => IJsonModel
  ensureMultiloopLayoutModel: (model: IJsonModel | null | undefined) => IJsonModel
  migrateSprintEngineLayout: (ws: Workspace) => Workspace
  pickWorkspaceAgentName: (agents: Workspace['agents']) => string
  isPathOrChild: (path: string, parentPath: string) => boolean
}

type WorkspacesSliceCarrier = WorkspacesSliceState & { appSettings: AppSettings }
type WorkspacesSliceSet = (mutator: (state: WorkspacesSliceCarrier) => void) => void

export function createWorkspacesSlice(
  set: WorkspacesSliceSet,
  deps: WorkspacesSliceDependencies
): WorkspacesSlice {
  return {
    workspaces: [],
    activeWorkspaceId: null,
    workspaceRegistryEmptyState: null,

    reorderWorkspaces: (orderedIds) =>
      set((state) => {
        const byId = new Map(state.workspaces.map((ws) => [ws.id, ws] as const))
        const next: Workspace[] = []
        for (const id of orderedIds) {
          const ws = byId.get(id)
          if (ws) {
            next.push(ws)
            byId.delete(id)
          }
        }
        for (const remaining of byId.values()) next.push(remaining)
        state.workspaces = next
      }),

    setWorkspaceHighlight: (id, highlight) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        const current: WorkspaceHighlight = ws.highlight ?? { starred: false, color: null }
        ws.highlight = {
          starred: highlight.starred ?? current.starred,
          color: highlight.color === undefined ? current.color : highlight.color,
        }
      }),

    clearWorkspaceHighlight: (id) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (ws) ws.highlight = undefined
      }),

    recordWorkspaceTerminalActivity: (id, lastOutputAt) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        if (
          typeof ws.lastTerminalActivityAt !== 'number'
          || ws.lastTerminalActivityAt < lastOutputAt
        ) {
          ws.lastTerminalActivityAt = lastOutputAt
        }
      }),

    forgetFolder: (folderPath) =>
      set((state) => {
        if (!folderPath) return
        const normalize = (value: string) =>
          value.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
        const key = normalize(folderPath)
        state.workspaces = state.workspaces.filter((ws) => {
          if (!ws.folderPath) return true
          return normalize(ws.folderPath) !== key
        })
        if (
          state.activeWorkspaceId
          && !state.workspaces.find((w) => w.id === state.activeWorkspaceId)
        ) {
          state.activeWorkspaceId = state.workspaces.at(-1)?.id ?? null
        }
        state.appSettings.recentWorkspaceFolders = state.appSettings.recentWorkspaceFolders.filter(
          (folder) => normalize(folder) !== key
        )
        if (state.workspaces.length === 0) {
          // forgetFolder is the second explicit removal path that can leave
          // workspaces=[]. Mirror removeWorkspace's intent record so the
          // empty-snapshot guard treats this as a valid intentional empty
          // rather than a dangerous wipe.
          state.workspaceRegistryEmptyState = {
            reason: 'user_removed_all',
            updatedAt: new Date().toISOString(),
          }
        }
      }),

    addWorkspace: (template, options) => {
      let id = nanoid()

      set((state) => {
        const folderPath = options?.folderPath ?? null
        const fallbackName = `${template.name} ${state.workspaces.length + 1}`
        const explicitMode = options?.mode
        const isSwitchboard = explicitMode === 'switchboard' || template.id === 'switchboard-mode'
        const isSprintEngine = !isSwitchboard && (template.id === 'sprintengine-mode' || Boolean(options?.sprintEngineState))
        const isMultiloop = template.id === 'multiloop-mode' || Boolean(options?.multiloopState)
        const guidedBriefState = normalizeGuidedBriefState(options?.guidedBriefState)
        const isGuidedBrief = explicitMode === 'guided-brief' || template.id === 'guided-brief-mode' || Boolean(guidedBriefState)
        const switchboardFolderKey = isSwitchboard ? workspaceFolderKey(folderPath) : null
        const existingSwitchboard = switchboardFolderKey
          ? state.workspaces.find((workspace) =>
            workspace.mode === 'switchboard'
            && workspaceFolderKey(workspace.folderPath) === switchboardFolderKey
          )
          : null
        if (existingSwitchboard) {
          if (folderPath) {
            state.appSettings.recentWorkspaceFolders = normalizeRecentWorkspaceFolders(
              [folderPath],
              state.appSettings.recentWorkspaceFolders
            )
          }
          id = existingSwitchboard.id
          existingSwitchboard.folderMissing = false
          state.activeWorkspaceId = existingSwitchboard.id
          return
        }
        const sprintEngineState = isSprintEngine
          ? normalizeSprintEngineState(options?.sprintEngineState)
            ?? createInitialSprintEngineState({
              goal: options?.sprintEngineState?.goal ?? 'Launch Sprint Engine mode',
              name: options?.sprintEngineState?.name ?? options?.name ?? 'Sprint Engine Team',
              roleCounts: options?.sprintEngineState?.roleCounts ?? createDefaultSprintEngineRoleCounts(),
            })
          : null
        const multiloopState = isMultiloop ? options?.multiloopState ?? null : null
        const workspaceName = sprintEngineState
          ? sprintEngineState.name
          : options?.name?.trim() || fallbackName
        const agents: Workspace['agents'] = {}
        const sprintEngineRoleCliDefaults = sprintEngineState
          ? deps.normalizeSprintEngineRoleCliDefaults(options?.sprintEngineRoleCliDefaults)
          : undefined
        if (sprintEngineState) {
          buildSprintEngineAgentRosterForState(sprintEngineState).forEach((agent) => {
            agents[agent.id] = {
              ...deps.defaultAgent(
                agent.id,
                deps.pickWorkspaceAgentName(agents),
                'sprintengine'
              ),
              cli: sprintEngineRoleCliDefaults?.[agent.role] ?? 'codex',
            }
          })
        }
        state.workspaces.push({
          id,
          name: workspaceName,
          mode: multiloopState || isMultiloop
            ? 'multiloop'
            : isSwitchboard
              ? 'switchboard'
              : isGuidedBrief
                ? 'guided-brief'
                : sprintEngineState
                  ? 'sprintengine'
                  : 'standard',
          folderPath,
          folderMissing: false,
          sprintEngineContext: deps.normalizeSprintEngineWorkspaceContext(
            options?.sprintEngineContext,
            folderPath,
            sprintEngineState
          ),
          multiloopContext: deps.normalizeMultiloopWorkspaceContext(
            options?.multiloopContext,
            folderPath,
            multiloopState
          ),
          templateId: template.id,
          layoutModel: isMultiloop
            ? deps.multiloopTabsLayoutModel()
            : isGuidedBrief
              ? guidedBriefLayoutModel()
            : sprintEngineState
            ? deps.sprintEngineTabsLayoutModel(sprintEngineState, agents, { includeAgentTabs: false })
            : template.layout,
          agents,
          worktreeState: deps.defaultWorkspaceWorktreeState(),
          memory: deps.defaultWorkspaceMemoryConfig(),
          editorState: deps.defaultEditorState(),
          sprintEngineState,
          multiloopState,
          guidedBriefState,
          sprintEngineRoleCliDefaults,
          sprintEngineAutoState: deps.normalizeSprintEngineAutoState(options?.sprintEngineAutoState),
          multiloopAutoState: deps.normalizeMultiloopAutoState(options?.multiloopAutoState),
          createdAt: Date.now(),
        })
        if (folderPath) {
          state.appSettings.recentWorkspaceFolders = normalizeRecentWorkspaceFolders(
            [folderPath],
            state.appSettings.recentWorkspaceFolders
          )
        }
        state.activeWorkspaceId = id
        state.workspaceRegistryEmptyState = null
      })

      return id
    },

    removeWorkspace: (id) =>
      set((state) => {
        const idx = state.workspaces.findIndex((w) => w.id === id)
        if (idx === -1) return
        state.workspaces.splice(idx, 1)
        if (state.activeWorkspaceId === id) {
          state.activeWorkspaceId = state.workspaces.at(-1)?.id ?? null
        }
        if (state.workspaces.length === 0) {
          // Explicit registry empty-state record. Persisted into the
          // workspace-registry storage key so cold-load can distinguish this
          // from hydration failure. addWorkspace + importWorkspace clear it.
          state.workspaceRegistryEmptyState = {
            reason: 'user_removed_all',
            updatedAt: new Date().toISOString(),
          }
        }
      }),

    renameWorkspace: (id, name) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (ws) ws.name = name.trim() || ws.name
      }),

    setActiveWorkspace: (id) =>
      set((state) => { state.activeWorkspaceId = id }),

    setFolderPath: (id, folderPath) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (ws) {
          ws.folderPath = folderPath
          ws.folderMissing = false
          if (folderPath) {
            state.appSettings.recentWorkspaceFolders = normalizeRecentWorkspaceFolders(
              [folderPath],
              state.appSettings.recentWorkspaceFolders
            )
          }
          ws.sprintEngineContext = deps.normalizeSprintEngineWorkspaceContext(
            ws.sprintEngineContext,
            folderPath,
            normalizeSprintEngineState(ws.sprintEngineState)
          )
          ws.multiloopContext = deps.normalizeMultiloopWorkspaceContext(
            ws.multiloopContext,
            folderPath,
            ws.multiloopState ?? null
          )
        }
      }),

    setFolderMissing: (id, folderMissing) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (ws) ws.folderMissing = folderMissing
      }),

    importWorkspace: (ws) =>
      set((state) => {
        const id = nanoid()
        const sprintEngineState = normalizeSprintEngineState(ws.sprintEngineState)
        const multiloopState = ws.multiloopState ?? null
        const mode = multiloopState
          ? 'multiloop'
            : sprintEngineState
              ? 'sprintengine'
              : ws.mode ?? 'standard'
        const agents = Object.fromEntries(
          Object.entries(ws.agents).map(([k, v]) => [
            k,
            deps.normalizeAgentState({
              ...v,
              streamBuffer: '',
              status: 'idle' as const,
              cliStartupPrompt: undefined,
            }),
          ])
        )
        state.workspaces.push({
          ...ws,
          id,
          name: `${ws.name} (imported)`,
          mode,
          folderPath: ws.folderPath ?? null,
          folderMissing: false,
          agents,
          worktreeState: deps.normalizeWorkspaceWorktreeState(ws.worktreeState),
          editorState: ws.editorState ?? deps.defaultEditorState(),
          sprintEngineState,
          sprintEngineContext: deps.normalizeSprintEngineWorkspaceContext(ws.sprintEngineContext, ws.folderPath, sprintEngineState),
          multiloopState,
          multiloopContext: deps.normalizeMultiloopWorkspaceContext(
            ws.multiloopContext,
            ws.folderPath,
            multiloopState
          ),
          sprintEngineRoleCliDefaults: deps.normalizeSprintEngineRoleCliDefaults(ws.sprintEngineRoleCliDefaults),
          sprintEngineAutoState: deps.normalizeSprintEngineAutoState(ws.sprintEngineAutoState),
          multiloopAutoState: deps.normalizeMultiloopAutoState(ws.multiloopAutoState),
        } satisfies Workspace)
        const imported = state.workspaces.at(-1)
        if (imported) {
          Object.assign(
            imported,
            imported.mode === 'multiloop'
              ? { ...imported, layoutModel: deps.ensureMultiloopLayoutModel(imported.layoutModel) }
              : deps.migrateSprintEngineLayout(imported)
          )
        }
        state.activeWorkspaceId = id
        state.workspaceRegistryEmptyState = null
      }),

    moveAgentToWorkspace: (sourceWorkspaceId, destWorkspaceId, agentId) => {
      if (sourceWorkspaceId === destWorkspaceId) return
      set((state) => {
        const source = state.workspaces.find((w) => w.id === sourceWorkspaceId)
        const dest = state.workspaces.find((w) => w.id === destWorkspaceId)
        if (!source || !dest) return
        const agent = source.agents[agentId]
        if (!agent) return
        dest.agents[agentId] = agent
        delete source.agents[agentId]
      })
    },

    moveOpenFileToWorkspace: (sourceWorkspaceId, destWorkspaceId, path) => {
      if (sourceWorkspaceId === destWorkspaceId) return
      moveEditorBuffer(sourceWorkspaceId, destWorkspaceId, path)
      set((state) => {
        const source = state.workspaces.find((w) => w.id === sourceWorkspaceId)
        const dest = state.workspaces.find((w) => w.id === destWorkspaceId)
        if (!source || !dest) return
        const sourceEditor = source.editorState
        if (!sourceEditor) return
        const idx = sourceEditor.openFiles.findIndex((file) => file.path === path)
        if (idx === -1) return
        const [openFile] = sourceEditor.openFiles.splice(idx, 1)
        if (sourceEditor.activeFilePath === path) {
          sourceEditor.activeFilePath = sourceEditor.openFiles.at(-1)?.path ?? null
        }
        if (!dest.editorState) dest.editorState = deps.defaultEditorState()
        const destEditor = dest.editorState
        const existing = destEditor.openFiles.findIndex((file) => file.path === path)
        if (existing !== -1) {
          destEditor.openFiles[existing] = openFile
        } else {
          destEditor.openFiles.push(openFile)
        }
        destEditor.activeFilePath = path
      })
    },
  }
}

// Re-exports of editor-buffer helpers so workspaceStore.ts editor actions can
// still find them via the slice index when other slices land. These are pure
// utility passthroughs; they belong with the editor/agents slice in T18.
export {
  deleteEditorBuffer,
  moveEditorBuffer,
  remapEditorBuffers,
  removeEditorBuffersForPath,
  setEditorBuffer,
  detectLanguage,
}
// Type re-exports to keep unused-imports lint happy in callers that need them.
export type { AgentCli, AgentExecution, MemoryGraphSettings, SprintEngineRole, WorktreeEntry }
