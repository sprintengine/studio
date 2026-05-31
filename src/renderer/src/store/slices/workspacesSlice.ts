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
  SprintEngineRoleId,
  SprintEngineRoleCliDefaults,
  SprintEngineWorkspaceContext,
  Workspace,
  WorkspaceHighlight,
  WorkspaceId,
  WorkspaceWindowId,
  WorkspaceWindowState,
  WorkspaceMemoryConfig,
  WorkspaceMode,
  WorkspaceWorktreeState,
  WorktreeEntry,
} from '../../types/workspace'
// TerminalSessionSnapshot is a global ambient type from src/renderer/src/env.d.ts.

const PRIMARY_WORKSPACE_WINDOW_ID: WorkspaceWindowId = 'primary'

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
  workspaceWindows: WorkspaceWindowState[]
  primaryWorkspaceWindowId: WorkspaceWindowId
  // Explicit intent record set by removeWorkspace when the splice leaves
  // workspaces=[] and cleared by addWorkspace/importWorkspace. Persisted into
  // the workspace-registry storage key so cold-load distinguishes user-removed-
  // all from hydration failure.
  workspaceRegistryEmptyState: import('../../types/workspace').WorkspaceRegistryEmptyState | null
}

export interface WorkspacesSliceActions {
  reorderWorkspaces: (orderedIds: WorkspaceId[]) => void
  registerWorkspaceWindow: (windowId: WorkspaceWindowId, kind?: WorkspaceWindowState['kind']) => void
  updateWorkspaceWindowPlacement: (
    windowId: WorkspaceWindowId,
    placement: Pick<WorkspaceWindowState, 'bounds' | 'isMaximized' | 'displayId'>
  ) => void
  closeWorkspaceWindow: (windowId: WorkspaceWindowId, fallbackWindowId?: WorkspaceWindowId) => void
  moveWorkspaceToWindow: (
    workspaceId: WorkspaceId,
    targetWindowId: WorkspaceWindowId,
    sourceWindowId?: WorkspaceWindowId | null
  ) => void
  setActiveWorkspaceForWindow: (windowId: WorkspaceWindowId, workspaceId: WorkspaceId) => void
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
      sprintEngineAgentCliOverrides?: Record<AgentId, AgentCli> | null
      sprintEngineAutoState?: Partial<SprintEngineAutoState> | null
      multiloopAutoState?: Partial<MultiloopAutoState> | null
      guidedBriefState?: import('../../types/workspace').GuidedBriefRuntimeState | null
      mode?: Workspace['mode']
      windowId?: WorkspaceWindowId | null
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
  hideNavRailTabStrip: (model: IJsonModel | null | undefined) => IJsonModel | null | undefined
  migrateSprintEngineLayout: (ws: Workspace) => Workspace
  pickWorkspaceAgentName: (agents: Workspace['agents']) => string
  isPathOrChild: (path: string, parentPath: string) => boolean
}

type WorkspacesSliceCarrier = WorkspacesSliceState & { appSettings: AppSettings }
type WorkspacesSliceSet = (mutator: (state: WorkspacesSliceCarrier) => void) => void

function findWorkspaceWindow(state: WorkspacesSliceCarrier, workspaceId: WorkspaceId): WorkspaceWindowState | undefined {
  return state.workspaceWindows.find((windowState) => windowState.workspaceIds.includes(workspaceId))
}

function ensureWorkspaceWindow(
  state: WorkspacesSliceCarrier,
  windowId: WorkspaceWindowId,
  kind: WorkspaceWindowState['kind'] = windowId === state.primaryWorkspaceWindowId ? 'primary' : 'detached',
): WorkspaceWindowState {
  const existing = state.workspaceWindows.find((windowState) => windowState.id === windowId)
  if (existing) return existing

  const now = Date.now()
  const windowState: WorkspaceWindowState = {
    id: windowId,
    kind,
    workspaceIds: [],
    activeWorkspaceId: null,
    bounds: null,
    isMaximized: false,
    displayId: null,
    createdAt: now,
    lastFocusedAt: now,
  }
  state.workspaceWindows.push(windowState)
  return windowState
}

function normalizeBounds(
  bounds: WorkspaceWindowState['bounds'] | null | undefined
): WorkspaceWindowState['bounds'] {
  if (!bounds) return null
  const { x, y, width, height } = bounds
  if (![x, y, width, height].every(Number.isFinite)) return null
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(800, Math.round(width)),
    height: Math.max(600, Math.round(height)),
  }
}

function normalizeWindowAssignments(state: WorkspacesSliceCarrier): void {
  const workspaceOrder = new Map(state.workspaces.map((workspace, index) => [workspace.id, index] as const))
  const validWorkspaceIds = new Set(workspaceOrder.keys())
  const assignedWorkspaceIds = new Set<WorkspaceId>()
  const primaryWindow = ensureWorkspaceWindow(state, state.primaryWorkspaceWindowId, 'primary')
  primaryWindow.kind = 'primary'

  state.workspaceWindows.forEach((windowState) => {
    const nextWorkspaceIds: WorkspaceId[] = []
    for (const workspaceId of windowState.workspaceIds) {
      if (!validWorkspaceIds.has(workspaceId) || assignedWorkspaceIds.has(workspaceId)) continue
      nextWorkspaceIds.push(workspaceId)
      assignedWorkspaceIds.add(workspaceId)
    }
    windowState.workspaceIds = nextWorkspaceIds.sort(
      (left, right) => (workspaceOrder.get(left) ?? 0) - (workspaceOrder.get(right) ?? 0)
    )
    if (!windowState.activeWorkspaceId || !nextWorkspaceIds.includes(windowState.activeWorkspaceId)) {
      windowState.activeWorkspaceId = nextWorkspaceIds[0] ?? null
    }
  })

  for (const workspace of state.workspaces) {
    if (assignedWorkspaceIds.has(workspace.id)) continue
    primaryWindow.workspaceIds.push(workspace.id)
    assignedWorkspaceIds.add(workspace.id)
  }
  if (!primaryWindow.activeWorkspaceId || !primaryWindow.workspaceIds.includes(primaryWindow.activeWorkspaceId)) {
    primaryWindow.activeWorkspaceId = primaryWindow.workspaceIds[0] ?? null
  }
  state.workspaceWindows = state.workspaceWindows.filter((windowState) =>
    windowState.kind === 'primary' || windowState.workspaceIds.length > 0
  )
}

function requireSprintEngineRoleCli(
  roleCliDefaults: Required<SprintEngineRoleCliDefaults>,
  role: SprintEngineRoleId
): AgentCli {
  const cli = roleCliDefaults[role]
  if (typeof cli !== 'string' || !cli.trim()) {
    throw new Error(`Missing Sprint Engine CLI default for role "${role}".`)
  }
  return cli
}

type LayoutAgentTabNode = {
  component?: unknown
  name?: unknown
  config?: {
    agentId?: unknown
  }
  children?: LayoutAgentTabNode[]
}

function collectTemplateAgentTabs(template: LayoutTemplate): Array<{ id: AgentId; name?: string }> {
  const seen = new Set<string>()
  const agents: Array<{ id: AgentId; name?: string }> = []

  const collect = (node: LayoutAgentTabNode | undefined) => {
    if (!node) return

    if (node.component === 'agent' && typeof node.config?.agentId === 'string' && node.config.agentId.trim()) {
      const id = node.config.agentId.trim()
      if (!seen.has(id)) {
        seen.add(id)
        agents.push({
          id,
          name: typeof node.name === 'string' && node.name.trim() ? node.name.trim() : undefined,
        })
      }
    }

    node.children?.forEach(collect)
  }

  collect(template.layout.layout as LayoutAgentTabNode)
  template.layout.borders?.forEach((border) => collect(border as LayoutAgentTabNode))

  return agents
}

export function createWorkspacesSlice(
  set: WorkspacesSliceSet,
  deps: WorkspacesSliceDependencies
): WorkspacesSlice {
  return {
    workspaces: [],
    activeWorkspaceId: null,
    workspaceWindows: [
      {
        id: PRIMARY_WORKSPACE_WINDOW_ID,
        kind: 'primary',
        workspaceIds: [],
        activeWorkspaceId: null,
        bounds: null,
        isMaximized: false,
        displayId: null,
        createdAt: Date.now(),
        lastFocusedAt: Date.now(),
      },
    ],
    primaryWorkspaceWindowId: PRIMARY_WORKSPACE_WINDOW_ID,
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
        normalizeWindowAssignments(state)
      }),

    registerWorkspaceWindow: (windowId, kind) =>
      set((state) => {
        if (!windowId.trim()) return
        ensureWorkspaceWindow(state, windowId.trim(), kind)
        normalizeWindowAssignments(state)
      }),

    updateWorkspaceWindowPlacement: (windowId, placement) =>
      set((state) => {
        const windowState = ensureWorkspaceWindow(state, windowId)
        windowState.bounds = normalizeBounds(placement.bounds)
        windowState.isMaximized = placement.isMaximized === true
        windowState.displayId = typeof placement.displayId === 'number' ? placement.displayId : null
        windowState.lastFocusedAt = Date.now()
      }),

    closeWorkspaceWindow: (windowId, fallbackWindowId) =>
      set((state) => {
        if (windowId === state.primaryWorkspaceWindowId) return
        const closing = state.workspaceWindows.find((windowState) => windowState.id === windowId)
        if (!closing) return
        const target = ensureWorkspaceWindow(
          state,
          fallbackWindowId ?? state.primaryWorkspaceWindowId,
          fallbackWindowId && fallbackWindowId !== state.primaryWorkspaceWindowId ? 'detached' : 'primary',
        )
        for (const workspaceId of closing.workspaceIds) {
          if (!target.workspaceIds.includes(workspaceId)) target.workspaceIds.push(workspaceId)
        }
        if (!target.activeWorkspaceId && target.workspaceIds.length > 0) {
          target.activeWorkspaceId = closing.activeWorkspaceId && target.workspaceIds.includes(closing.activeWorkspaceId)
            ? closing.activeWorkspaceId
            : target.workspaceIds[0] ?? null
        }
        state.workspaceWindows = state.workspaceWindows.filter((windowState) => windowState.id !== windowId)
        normalizeWindowAssignments(state)
      }),

    moveWorkspaceToWindow: (workspaceId, targetWindowId, sourceWindowId) =>
      set((state) => {
        if (!state.workspaces.find((workspace) => workspace.id === workspaceId)) return
        const target = ensureWorkspaceWindow(
          state,
          targetWindowId,
          targetWindowId === state.primaryWorkspaceWindowId ? 'primary' : 'detached',
        )
        for (const windowState of state.workspaceWindows) {
          if (windowState.id === targetWindowId) continue
          windowState.workspaceIds = windowState.workspaceIds.filter((id) => id !== workspaceId)
          if (windowState.activeWorkspaceId === workspaceId) {
            windowState.activeWorkspaceId = windowState.workspaceIds[0] ?? null
          }
        }
        if (!target.workspaceIds.includes(workspaceId)) target.workspaceIds.push(workspaceId)
        target.activeWorkspaceId = workspaceId
        target.lastFocusedAt = Date.now()
        state.activeWorkspaceId = workspaceId
        if (sourceWindowId && sourceWindowId !== targetWindowId) {
          const source = state.workspaceWindows.find((windowState) => windowState.id === sourceWindowId)
          if (source && source.activeWorkspaceId === workspaceId) {
            source.activeWorkspaceId = source.workspaceIds[0] ?? null
          }
        }
        normalizeWindowAssignments(state)
      }),

    setActiveWorkspaceForWindow: (windowId, workspaceId) =>
      set((state) => {
        const windowState = state.workspaceWindows.find((candidate) => candidate.id === windowId)
        if (!windowState?.workspaceIds.includes(workspaceId)) return
        windowState.activeWorkspaceId = workspaceId
        windowState.lastFocusedAt = Date.now()
        state.activeWorkspaceId = workspaceId
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
        normalizeWindowAssignments(state)
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
        const targetWindowId =
          options?.windowId
          ?? (state.activeWorkspaceId ? findWorkspaceWindow(state, state.activeWorkspaceId)?.id : null)
          ?? state.primaryWorkspaceWindowId
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
          const targetWindow = ensureWorkspaceWindow(
            state,
            options?.windowId ?? findWorkspaceWindow(state, existingSwitchboard.id)?.id ?? targetWindowId,
          )
          if (!targetWindow.workspaceIds.includes(existingSwitchboard.id)) {
            targetWindow.workspaceIds.push(existingSwitchboard.id)
          }
          targetWindow.activeWorkspaceId = existingSwitchboard.id
          normalizeWindowAssignments(state)
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
          if (!sprintEngineRoleCliDefaults) {
            throw new Error('Missing Sprint Engine CLI defaults for workspace creation.')
          }
          buildSprintEngineAgentRosterForState(sprintEngineState).forEach((agent) => {
            const overrideCli = options?.sprintEngineAgentCliOverrides?.[agent.id]
            agents[agent.id] = {
              ...deps.defaultAgent(
                agent.id,
                deps.pickWorkspaceAgentName(agents),
                'sprintengine'
              ),
              cli: typeof overrideCli === 'string' && overrideCli.trim()
                ? overrideCli.trim()
                : requireSprintEngineRoleCli(sprintEngineRoleCliDefaults, agent.role),
            }
          })
        } else {
          collectTemplateAgentTabs(template).forEach((agent) => {
            agents[agent.id] = {
              ...deps.defaultAgent(
                agent.id,
                agent.name ?? deps.pickWorkspaceAgentName(agents),
                'general'
              ),
              cli: state.appSettings.lastSelectedCli,
            }
          })
        }
        const newWorkspace: Workspace = {
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
            // Standard/dev templates: normalize nav-only tabsets to strip-less
            // so a user-saved template predating the nav-switch model never
            // seeds a redundant tab strip on Files / Git / Knowledge Graph.
            : deps.hideNavRailTabStrip(template.layout) ?? template.layout,
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
        }
        // New workspaces appear at the top of their folder's block (newest
        // first), matching the recency-ordered sidebar. A brand-new folder
        // lands at the head of the registry so its group renders first. Manual
        // drag-reorder still rewrites this order afterward.
        const insertFolderKey = workspaceFolderKey(folderPath)
        const blockStart = state.workspaces.findIndex(
          (existing) => workspaceFolderKey(existing.folderPath) === insertFolderKey
        )
        if (blockStart === -1) {
          state.workspaces.unshift(newWorkspace)
        } else {
          state.workspaces.splice(blockStart, 0, newWorkspace)
        }
        if (folderPath) {
          state.appSettings.recentWorkspaceFolders = normalizeRecentWorkspaceFolders(
            [folderPath],
            state.appSettings.recentWorkspaceFolders
          )
        }
        state.activeWorkspaceId = id
        const targetWindow = ensureWorkspaceWindow(
          state,
          targetWindowId,
        )
        targetWindow.workspaceIds = [
          id,
          ...targetWindow.workspaceIds.filter((workspaceId) => workspaceId !== id),
        ]
        targetWindow.activeWorkspaceId = id
        normalizeWindowAssignments(state)
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
        normalizeWindowAssignments(state)
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
      set((state) => {
        state.activeWorkspaceId = id
        const windowState = findWorkspaceWindow(state, id)
        if (windowState) {
          windowState.activeWorkspaceId = id
          windowState.lastFocusedAt = Date.now()
        }
      }),

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
        const targetWindow = ensureWorkspaceWindow(state, state.primaryWorkspaceWindowId)
        targetWindow.workspaceIds.push(id)
        targetWindow.activeWorkspaceId = id
        normalizeWindowAssignments(state)
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
