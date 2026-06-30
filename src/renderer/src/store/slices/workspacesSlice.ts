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
import {
  normalizeRecentWorkspaceFolders,
  normalizeSprintEngineRunSettings,
  sprintEngineRunSettingsKey,
} from './settingsSlice'
import {
  workspaceSyncClient,
  type WorkspaceActiveChangedApply,
  type WorkspaceClosedApply,
  type WorkspaceCreatedApply,
  type WorkspaceMovedApply,
  type WorkspacePlacementApply,
} from '../workspaceSyncClient'
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
  SprintEngineRoleModelOverrides,
  SprintEngineWorkspaceContext,
  GitPanelView,
  Workspace,
  WorkspaceWorktree,
  WorkspaceBacklogState,
  WorkspaceFileExplorerState,
  WorkspaceGitPanelState,
  WorkspaceHighlight,
  WorkspaceId,
  WorkspaceWindowId,
  WorkspaceWindowState,
  WorkspaceMemoryConfig,
  WorkspaceMode,
  WorkspaceWorktreeState,
  WorktreeEntry,
} from '../../types/workspace'
import { AUTOMATIONS_HOST_WORKSPACE_MODE } from '../../types/workspace'
// TerminalSessionSnapshot is a global ambient type from src/renderer/src/env.d.ts.

const PRIMARY_WORKSPACE_WINDOW_ID: WorkspaceWindowId = 'primary'

// This renderer's own window id, derived from the URL like workspaceStore and
// workspaceSyncClient. Used to decide whether a move targets this renderer's
// window (refocus the moved workspace) or another window (keep global active on
// the window this renderer displays). Guarded for the non-DOM test environment.
function getCurrentWorkspaceWindowIdForSlice(): WorkspaceWindowId {
  if (typeof window === 'undefined') return PRIMARY_WORKSPACE_WINDOW_ID
  try {
    return new URL(window.location.href).searchParams.get('windowId')?.trim() || PRIMARY_WORKSPACE_WINDOW_ID
  } catch {
    return PRIMARY_WORKSPACE_WINDOW_ID
  }
}

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
  if (typeof input === 'string' && input.trim().length > 0) return input
  return 'standard'
}

export function defaultWorkspaceFileExplorerState(): WorkspaceFileExplorerState {
  return { expandedPaths: [], selectedPath: null }
}

export function normalizeWorkspaceFileExplorerState(input: unknown): WorkspaceFileExplorerState {
  const obj = input && typeof input === 'object' ? (input as Partial<WorkspaceFileExplorerState>) : null
  const rawExpandedPaths = obj?.expandedPaths
  const expandedPaths = Array.isArray(rawExpandedPaths)
    ? Array.from(new Set(rawExpandedPaths.filter((path): path is string => typeof path === 'string' && path.trim().length > 0)))
    : []
  const selectedPath =
    typeof obj?.selectedPath === 'string' && obj.selectedPath.trim().length > 0 ? obj.selectedPath : null
  return { expandedPaths, selectedPath }
}

export function defaultWorkspaceBacklogState(): WorkspaceBacklogState {
  return { selectedRelativePath: null, view: 'active', sort: 'recent', group: 'none', search: '' }
}

// Runtime guards for the persisted enums, exhaustiveness-checked against the
// source unions via `satisfies` so a new lens/sort fails to compile until it is
// added here too.
const BACKLOG_VIEW_VALUES = {
  active: true,
  all: true,
  quick_wins: true,
  strategic_bets: true,
  defer: true,
  unestimated: true,
  completed: true,
  archived: true,
} satisfies Record<WorkspaceBacklogState['view'], true>

const BACKLOG_SORT_VALUES = {
  best: true,
  recent: true,
  status: true,
  priority: true,
  largest: true,
  smallest: true,
  dependency: true,
} satisfies Record<WorkspaceBacklogState['sort'], true>

const BACKLOG_GROUP_VALUES = {
  none: true,
  by_epic: true,
} satisfies Record<WorkspaceBacklogState['group'], true>

const MAX_BACKLOG_SEARCH_LENGTH = 200

// Returns undefined for absent state so the persisted registry is not bloated
// with a default record for every workspace; a present-but-malformed record is
// coerced to safe defaults rather than dropped.
export function normalizeWorkspaceBacklogState(input: unknown): WorkspaceBacklogState | undefined {
  if (!input || typeof input !== 'object') return undefined
  const raw = input as Partial<WorkspaceBacklogState>
  const view =
    typeof raw.view === 'string' && raw.view in BACKLOG_VIEW_VALUES ? (raw.view as WorkspaceBacklogState['view']) : 'active'
  const sort =
    typeof raw.sort === 'string' && raw.sort in BACKLOG_SORT_VALUES ? (raw.sort as WorkspaceBacklogState['sort']) : 'recent'
  const group =
    typeof raw.group === 'string' && raw.group in BACKLOG_GROUP_VALUES ? (raw.group as WorkspaceBacklogState['group']) : 'none'
  const selectedRelativePath =
    typeof raw.selectedRelativePath === 'string' && raw.selectedRelativePath.trim().length > 0
      ? raw.selectedRelativePath
      : null
  const search = typeof raw.search === 'string' ? raw.search.slice(0, MAX_BACKLOG_SEARCH_LENGTH) : ''
  return { selectedRelativePath, view, sort, group, search }
}

export function defaultWorkspaceGitPanelState(): WorkspaceGitPanelState {
  return { activeView: 'changes', activeScopeId: 'main', commitDraftsByScopeId: {} }
}

const GIT_PANEL_VIEW_VALUES = {
  changes: true,
  worktrees: true,
  log: true,
  terminal: true,
} satisfies Record<GitPanelView, true>

const MAX_COMMIT_DRAFT_LENGTH = 10000

export function normalizeWorkspaceGitPanelState(input: unknown): WorkspaceGitPanelState | undefined {
  if (!input || typeof input !== 'object') return undefined
  const raw = input as Partial<WorkspaceGitPanelState>
  const activeView =
    typeof raw.activeView === 'string' && raw.activeView in GIT_PANEL_VIEW_VALUES
      ? (raw.activeView as GitPanelView)
      : 'changes'
  const activeScopeId =
    typeof raw.activeScopeId === 'string' && raw.activeScopeId.trim().length > 0 ? raw.activeScopeId : 'main'
  const commitDraftsByScopeId: Record<string, string> = {}
  if (raw.commitDraftsByScopeId && typeof raw.commitDraftsByScopeId === 'object') {
    for (const [scopeId, text] of Object.entries(raw.commitDraftsByScopeId)) {
      if (scopeId.length > 0 && typeof text === 'string' && text.trim().length > 0) {
        commitDraftsByScopeId[scopeId] = text.slice(0, MAX_COMMIT_DRAFT_LENGTH)
      }
    }
  }
  return { activeView, activeScopeId, commitDraftsByScopeId }
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
  applyWorkspaceActiveChangedEvent: (apply: WorkspaceActiveChangedApply) => void
  applyWorkspaceMovedEvent: (apply: WorkspaceMovedApply) => void
  applyWorkspaceClosedEvent: (apply: WorkspaceClosedApply) => void
  applyWorkspacePlacementEvent: (apply: WorkspacePlacementApply) => void
  applyWorkspaceCreatedEvent: (apply: WorkspaceCreatedApply) => void
  setWorkspaceHighlight: (id: WorkspaceId, highlight: Partial<WorkspaceHighlight>) => void
  clearWorkspaceHighlight: (id: WorkspaceId) => void
  recordWorkspaceTerminalActivity: (id: WorkspaceId, lastInputAt: number) => void
  forgetFolder: (folderPath: string) => void
  addWorkspace: (
    template: LayoutTemplate,
    options?: {
      name?: string
      folderPath?: string | null
      worktree?: WorkspaceWorktree | null
      sprintEngineState?: SprintEngineState | null
      sprintEngineContext?: SprintEngineWorkspaceContext | null
      multiloopState?: MultiloopState | null
      multiloopContext?: MultiloopWorkspaceContext | null
      sprintEngineRoleCliDefaults?: SprintEngineRoleCliDefaults | null
      sprintEngineAgentCliOverrides?: Record<AgentId, AgentCli> | null
      // Explicit per-role launch model from the new-workspace roster. String =
      // explicit model id, null or absent = CLI default with no model flag.
      sprintEngineRoleModelOverrides?: SprintEngineRoleModelOverrides | null
      // Roles the user marked "start now" in the new-workspace roster. Every
      // seeded roster agent of these roles is queued as session-only initial
      // spawn intent for the Sprint Engine board to launch on first open.
      sprintEngineInitialSpawnRoles?: SprintEngineRoleId[] | null
      // CLI for the general template agents (e.g. the solo "New chat" agent).
      // When set, overrides the remembered `lastSelectedCli` default below.
      templateAgentCli?: AgentCli | null
      sprintEngineAutoState?: Partial<SprintEngineAutoState> | null
      multiloopAutoState?: Partial<MultiloopAutoState> | null
      guidedBriefState?: import('../../types/workspace').GuidedBriefRuntimeState | null
      mode?: Workspace['mode']
      windowId?: WorkspaceWindowId | null
      // Open-in-new-chat seed for the single-agent "solo chat" template. The UI
      // builds a data-only descriptor so this slice never imports specialist or
      // prompt helpers. `agentPatch` is merged onto the lone template agent
      // record, `tabName` renames the lone layout tab, and `terminal` swaps that
      // tab for a terminal tab (and seeds no agent record).
      seedAgent?: SoloChatSeed | null
    }
  ) => WorkspaceId
  removeWorkspace: (id: WorkspaceId) => void
  renameWorkspace: (id: WorkspaceId, name: string) => void
  setActiveWorkspace: (id: WorkspaceId) => void
  setFolderPath: (id: WorkspaceId, folderPath: string | null) => void
  setFolderMissing: (id: WorkspaceId, folderMissing: boolean) => void
  setFileExplorerExpandedPaths: (id: WorkspaceId, expandedPaths: string[]) => void
  setFileExplorerSelectedPath: (id: WorkspaceId, selectedPath: string | null) => void
  setBacklogViewState: (id: WorkspaceId, patch: Partial<WorkspaceBacklogState>) => void
  setGitPanelState: (id: WorkspaceId, patch: Partial<Omit<WorkspaceGitPanelState, 'commitDraftsByScopeId'>>) => void
  setGitCommitDraft: (id: WorkspaceId, scopeId: string, text: string) => void
  clearGitCommitDraft: (id: WorkspaceId, scopeId: string) => void
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

function resolveSprintEngineRoleCli(
  roleCliDefaults: Required<SprintEngineRoleCliDefaults>,
  role: SprintEngineRoleId
): AgentCli {
  const cli = roleCliDefaults[role]
  if (typeof cli === 'string' && cli.trim()) return cli.trim()
  // SprintEngineRoleId is open-ended (custom/user-defined roles), so a role
  // missing from the defaults map must never throw here: addWorkspace runs
  // AFTER initializeSprintEngineState has already written run.yaml and (in
  // worktree mode) created the git worktree+branch, so a throw orphans a real
  // on-disk run with no workspace. Fall back to the team's architect CLI
  // (always present after normalization), else the universal default.
  return roleCliDefaults.architect?.trim() || 'claude-code'
}

type LayoutAgentTabNode = {
  component?: unknown
  name?: unknown
  config?: {
    agentId?: unknown
  }
  children?: LayoutAgentTabNode[]
}

// Data-only descriptor for opening a specific agent in a fresh "solo chat"
// workspace (see addWorkspace `seedAgent`). Built by the spawn-menu UI so this
// slice stays free of specialist/prompt/runtime imports.
export type SoloChatSeed = {
  agentPatch?: Partial<AgentState>
  tabName?: string
  terminal?: { terminalId: string }
}

// Transform the single-agent solo-chat layout for a seed: rename the lone agent
// tab, or swap it for a terminal tab. Pure — clones the template layout so the
// shared template constant is never mutated. Only the solo template (exactly one
// agent tab) is ever passed here.
export function applySoloChatSeed(layout: IJsonModel, seed: SoloChatSeed): IJsonModel {
  const next = structuredClone(layout)
  let done = false
  const visit = (node: LayoutAgentTabNode | undefined) => {
    if (!node || done) return
    if (node.component === 'agent') {
      const target = node as { component?: unknown; name?: unknown; config?: Record<string, unknown> }
      if (seed.terminal) {
        target.component = 'terminal'
        target.name = seed.tabName ?? 'Terminal'
        target.config = { terminalId: seed.terminal.terminalId }
        done = true
        return
      }
      if (seed.tabName) {
        target.name = seed.tabName
        done = true
        return
      }
    }
    node.children?.forEach(visit)
  }
  visit(next.layout as LayoutAgentTabNode)
  next.borders?.forEach((border) => visit(border as LayoutAgentTabNode))
  return next
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

    updateWorkspaceWindowPlacement: (windowId, placement) => {
      set((state) => {
        const windowState = ensureWorkspaceWindow(state, windowId)
        windowState.bounds = normalizeBounds(placement.bounds)
        windowState.isMaximized = placement.isMaximized === true
        windowState.displayId = typeof placement.displayId === 'number' ? placement.displayId : null
        windowState.lastFocusedAt = Date.now()
      })
      // Local state is the functional path; storage-event sync still mirrors it
      // to other windows as rollback. Also broadcast the placement through main.
      // Callers pass only their own window id, and these calls already arrive
      // pre-debounced by the 250 ms window placement debounce in
      // window-factory.ts/window-ipc.ts, so dispatch frequency stays bounded.
      // Fire-and-forget: an unseeded/rejecting main service is a logged no-op.
      void workspaceSyncClient.dispatchUpdatePlacement({
        windowId,
        bounds: placement.bounds ?? null,
        isMaximized: placement.isMaximized === true,
        displayId: typeof placement.displayId === 'number' ? placement.displayId : null,
      })
    },

    closeWorkspaceWindow: (windowId, fallbackWindowId) => {
      let resolvedFallbackWindowId: WorkspaceWindowId | null = null
      set((state) => {
        if (windowId === state.primaryWorkspaceWindowId) return
        const closing = state.workspaceWindows.find((windowState) => windowState.id === windowId)
        if (!closing) return
        resolvedFallbackWindowId = fallbackWindowId ?? state.primaryWorkspaceWindowId
        const target = ensureWorkspaceWindow(
          state,
          resolvedFallbackWindowId,
          resolvedFallbackWindowId !== state.primaryWorkspaceWindowId ? 'detached' : 'primary',
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
      })
      // Broadcast the detached-window close through main (functional path stays
      // local + storage-event rollback). Only dispatch when a close actually
      // happened: a non-existent or primary window short-circuits above.
      if (resolvedFallbackWindowId) {
        void workspaceSyncClient.dispatchCloseWorkspaceWindow(windowId, resolvedFallbackWindowId)
      }
    },

    moveWorkspaceToWindow: (workspaceId, targetWindowId, sourceWindowId) => {
      let moved = false
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
        const currentWindowId = getCurrentWorkspaceWindowIdForSlice()
        if (targetWindowId === currentWindowId) {
          // The workspace landed in THIS renderer's own window — focus it
          // globally. This covers same-window moves and the failed move-out
          // rollback (createWorkspaceWindow failure) that restores the workspace
          // to the current window using the failed target id as sourceWindowId.
          state.activeWorkspaceId = workspaceId
        } else if (state.activeWorkspaceId === workspaceId || state.activeWorkspaceId == null) {
          // The workspace moved to another window. Keep this renderer's global
          // active on the window it displays (its own/source window's
          // deterministic fallback, already advanced off the moved workspace by
          // the loop) rather than a workspace that now lives elsewhere. Only
          // adjust when global active was the moved-away workspace or unset; a
          // still-present active workspace in this window stays.
          const anchorWindow =
            state.workspaceWindows.find((windowState) => windowState.id === currentWindowId)
            ?? (sourceWindowId
              ? state.workspaceWindows.find((windowState) => windowState.id === sourceWindowId)
              : undefined)
          state.activeWorkspaceId = anchorWindow?.activeWorkspaceId ?? null
        }
        normalizeWindowAssignments(state)
        moved = true
      })
      // A user move always focuses the moved workspace in its destination, so
      // dispatch makeActive: true. Broadcast through main (functional path stays
      // local + storage-event rollback). Skip when the workspace was unknown.
      if (moved) {
        void workspaceSyncClient.dispatchMoveWorkspaceToWindow(
          workspaceId,
          sourceWindowId ?? null,
          targetWindowId,
          true
        )
      }
    },

    setActiveWorkspaceForWindow: (windowId, workspaceId) => {
      let changed = false
      set((state) => {
        const windowState = state.workspaceWindows.find((candidate) => candidate.id === windowId)
        if (!windowState?.workspaceIds.includes(workspaceId)) return
        changed = windowState.activeWorkspaceId !== workspaceId
        windowState.activeWorkspaceId = workspaceId
        windowState.lastFocusedAt = Date.now()
        state.activeWorkspaceId = workspaceId
      })
      // Local state is the functional path (storage-event sync still mirrors it
      // to other windows as rollback). When the active selection actually
      // changes, also dispatch it through main so the event bus can broadcast it
      // once the main service is authoritative. Re-focusing the already-active
      // workspace bumps lastFocusedAt locally but emits no cross-window event.
      // Fire-and-forget: dispatch failures are logged, never thrown.
      if (changed) void workspaceSyncClient.dispatchSetActiveWorkspace(windowId, workspaceId)
    },

    // Applies an accepted/broadcast active_changed event without re-dispatching,
    // so an imported event never re-emits a new command. Updates only the
    // targeted window's active workspace; global active selection is claimed
    // only when this renderer owns the targeted window.
    applyWorkspaceActiveChangedEvent: ({ windowId, workspaceId, createdAt, isCurrentWindow }) =>
      set((state) => {
        const windowState = state.workspaceWindows.find((candidate) => candidate.id === windowId)
        if (!windowState) return
        if (workspaceId !== null && !windowState.workspaceIds.includes(workspaceId)) return
        windowState.activeWorkspaceId = workspaceId
        if (Number.isFinite(createdAt)) windowState.lastFocusedAt = createdAt
        if (isCurrentWindow && workspaceId) state.activeWorkspaceId = workspaceId
      }),

    // Applies an accepted/broadcast moved_to_window event without re-dispatching.
    // Mirrors the move membership transfer but only claims the single global
    // active id when this renderer owns the destination window — a move targeting
    // another window updates routing without flipping this renderer's selection.
    applyWorkspaceMovedEvent: ({ workspaceId, fromWindowId, toWindowId, makeActive, createdAt, isCurrentWindowTarget }) =>
      set((state) => {
        if (!state.workspaces.find((workspace) => workspace.id === workspaceId)) return
        const target = ensureWorkspaceWindow(
          state,
          toWindowId,
          toWindowId === state.primaryWorkspaceWindowId ? 'primary' : 'detached',
        )
        for (const windowState of state.workspaceWindows) {
          if (windowState.id === toWindowId) continue
          windowState.workspaceIds = windowState.workspaceIds.filter((id) => id !== workspaceId)
          if (windowState.activeWorkspaceId === workspaceId) {
            windowState.activeWorkspaceId = windowState.workspaceIds[0] ?? null
          }
        }
        if (!target.workspaceIds.includes(workspaceId)) target.workspaceIds.push(workspaceId)
        if (makeActive) {
          target.activeWorkspaceId = workspaceId
          if (Number.isFinite(createdAt)) target.lastFocusedAt = createdAt
          if (isCurrentWindowTarget) state.activeWorkspaceId = workspaceId
        } else if (!target.activeWorkspaceId) {
          target.activeWorkspaceId = target.workspaceIds[0] ?? null
        }
        if (fromWindowId && fromWindowId !== toWindowId) {
          const source = state.workspaceWindows.find((windowState) => windowState.id === fromWindowId)
          if (source && source.activeWorkspaceId === workspaceId) {
            source.activeWorkspaceId = source.workspaceIds[0] ?? null
          }
        }
        normalizeWindowAssignments(state)
      }),

    // Applies an accepted/broadcast closed event without re-dispatching. Routes
    // the moved workspaces to the fallback window and drops the closing window.
    // The event can reach a renderer that never held the closing window record
    // (routing drift) — `movedWorkspaceIds` carries the ids the service routed to
    // the fallback so the transfer still completes; the closing record's own
    // membership is only a fallback for an empty payload. Global active selection
    // is left untouched — closing a foreign window must not flip this renderer's
    // active workspace.
    applyWorkspaceClosedEvent: ({ windowId, fallbackWindowId, movedWorkspaceIds, createdAt }) =>
      set((state) => {
        if (windowId === state.primaryWorkspaceWindowId) return
        const closing = state.workspaceWindows.find((windowState) => windowState.id === windowId)
        const routedWorkspaceIds = movedWorkspaceIds.length > 0 ? movedWorkspaceIds : closing?.workspaceIds ?? []
        if (!closing && routedWorkspaceIds.length === 0) return
        const fallback = ensureWorkspaceWindow(
          state,
          fallbackWindowId,
          fallbackWindowId !== state.primaryWorkspaceWindowId ? 'detached' : 'primary',
        )
        for (const id of routedWorkspaceIds) {
          if (!fallback.workspaceIds.includes(id)) fallback.workspaceIds.push(id)
        }
        if (!fallback.activeWorkspaceId && fallback.workspaceIds.length > 0) {
          fallback.activeWorkspaceId = closing?.activeWorkspaceId && fallback.workspaceIds.includes(closing.activeWorkspaceId)
            ? closing.activeWorkspaceId
            : fallback.workspaceIds[0] ?? null
        }
        if (Number.isFinite(createdAt)) fallback.lastFocusedAt = createdAt
        if (closing) {
          state.workspaceWindows = state.workspaceWindows.filter((windowState) => windowState.id !== windowId)
        }
        normalizeWindowAssignments(state)
      }),

    // Applies an accepted/broadcast placement event without re-dispatching.
    // Touches only the target window's placement fields, never workspace objects
    // or window membership.
    applyWorkspacePlacementEvent: ({ windowId, bounds, isMaximized, displayId, createdAt }) =>
      set((state) => {
        const windowState = ensureWorkspaceWindow(state, windowId)
        windowState.bounds = normalizeBounds(bounds)
        windowState.isMaximized = isMaximized === true
        windowState.displayId = typeof displayId === 'number' ? displayId : null
        if (Number.isFinite(createdAt)) windowState.lastFocusedAt = createdAt
      }),

    // Applies an accepted/broadcast workspace.created event without re-dispatching.
    // Inserts the workspace at its folder head (deterministic by event sequence)
    // and assigns it to the target window at the head. A renderer that already
    // has the workspace (the source applying its own accepted event, or a
    // duplicate broadcast) keeps its local object and only re-confirms the
    // assignment, so application is idempotent. Only the renderer that owns the
    // target window claims the single global active id.
    applyWorkspaceCreatedEvent: ({ workspace, windowId, folderPath, createdAt, isCurrentWindowTarget }) =>
      set((state) => {
        if (!state.workspaces.some((candidate) => candidate.id === workspace.id)) {
          const insertFolderKey = workspaceFolderKey(folderPath)
          const blockStart = state.workspaces.findIndex(
            (candidate) => workspaceFolderKey(candidate.folderPath) === insertFolderKey
          )
          if (blockStart === -1) {
            state.workspaces.unshift(workspace)
          } else {
            state.workspaces.splice(blockStart, 0, workspace)
          }
        }
        for (const windowState of state.workspaceWindows) {
          windowState.workspaceIds = windowState.workspaceIds.filter((id) => id !== workspace.id)
        }
        const target = ensureWorkspaceWindow(state, windowId)
        target.workspaceIds = [workspace.id, ...target.workspaceIds]
        target.activeWorkspaceId = workspace.id
        if (Number.isFinite(createdAt)) target.lastFocusedAt = createdAt
        if (isCurrentWindowTarget) state.activeWorkspaceId = workspace.id
        state.workspaceRegistryEmptyState = null
        normalizeWindowAssignments(state)
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

    // Monotonic: `lastTerminalActivityAt` only moves forward, and is fed from the
    // user's last terminal input (typing), not terminal output — so reopening a
    // workspace never advances it. See deriveWorkspaceLastInputAt.
    recordWorkspaceTerminalActivity: (id, lastInputAt) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        if (
          typeof ws.lastTerminalActivityAt !== 'number'
          || ws.lastTerminalActivityAt < lastInputAt
        ) {
          ws.lastTerminalActivityAt = lastInputAt
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
      // Captured only for a genuinely new workspace (not the Switchboard-reuse
      // early return) so creation is broadcast through main as a workspace.created
      // event. Local creation stays the functional path; storage-event sync is the
      // rollback. Fire-and-forget after the synchronous set().
      let createdEventPayload:
        | { workspace: Workspace; windowId: WorkspaceWindowId; folderPath: string | null }
        | null = null

      set((state) => {
        const folderPath = options?.folderPath ?? null
        const fallbackName = `${template.name} ${state.workspaces.length + 1}`
        const explicitMode = options?.mode
        const isSwitchboard = explicitMode === 'switchboard' || template.id === 'switchboard-mode'
        const isSprintEngine = !isSwitchboard && (template.id === 'sprintengine-mode' || Boolean(options?.sprintEngineState))
        const isMultiloop = template.id === 'multiloop-mode' || Boolean(options?.multiloopState)
        const guidedBriefState = normalizeGuidedBriefState(options?.guidedBriefState)
        const isGuidedBrief = explicitMode === 'guided-brief' || template.id === 'guided-brief-mode' || Boolean(guidedBriefState)
        const isAutomationsHost = explicitMode === AUTOMATIONS_HOST_WORKSPACE_MODE
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
              name: options?.sprintEngineState?.name ?? options?.name ?? 'Sprint Roster',
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
        const initialSpawnRoles = new Set(options?.sprintEngineInitialSpawnRoles ?? [])
        const initialSpawnAgentIds: AgentId[] = []
        if (sprintEngineState) {
          if (!sprintEngineRoleCliDefaults) {
            throw new Error('Missing Sprint Engine CLI defaults for workspace creation.')
          }
          buildSprintEngineAgentRosterForState(sprintEngineState).forEach((agent) => {
            const overrideCli = options?.sprintEngineAgentCliOverrides?.[agent.id]
            const rosterCli = typeof overrideCli === 'string' && overrideCli.trim()
              ? overrideCli.trim()
              : resolveSprintEngineRoleCli(sprintEngineRoleCliDefaults, agent.role)
            // An explicit roster model choice wins; null or absent means the
            // user picked the CLI default (no model flag).
            const modelOverride = options?.sprintEngineRoleModelOverrides?.[agent.role]
            const rosterModel = modelOverride === null
              ? undefined
              : modelOverride?.trim() || undefined
            agents[agent.id] = {
              ...deps.defaultAgent(
                agent.id,
                deps.pickWorkspaceAgentName(agents),
                'sprintengine'
              ),
              cli: rosterCli,
              cliModel: rosterModel,
            }
            if (initialSpawnRoles.has(agent.role)) initialSpawnAgentIds.push(agent.id)
          })
        } else if (options?.seedAgent?.terminal) {
          // Terminal seed: the lone agent tab is swapped for a terminal tab in
          // the layout below, so no agent record is created for it.
        } else {
          const templateAgentCli =
            typeof options?.templateAgentCli === 'string' && options.templateAgentCli.trim()
              ? options.templateAgentCli.trim()
              : state.appSettings.lastSelectedCli
          const agentPatch = options?.seedAgent?.agentPatch
          collectTemplateAgentTabs(template).forEach((agent, index) => {
            const base = {
              ...deps.defaultAgent(
                agent.id,
                agent.name ?? deps.pickWorkspaceAgentName(agents),
                'general'
              ),
              cli: templateAgentCli,
            }
            // The solo-chat template has a single agent tab; merge the seed patch
            // onto it so an Open-in-new-chat agent (specialist/conversation) is
            // initialized at creation time, race-free before first render.
            agents[agent.id] = index === 0 && agentPatch ? { ...base, ...agentPatch } : base
          })
        }
        // Standard/dev templates: normalize nav-only tabsets to strip-less so a
        // user-saved template predating the nav-switch model never seeds a
        // redundant tab strip on Files / Git / Knowledge Graph. When a seed
        // renames the lone tab or swaps it for a terminal, apply that transform.
        const baseStandardLayout = deps.hideNavRailTabStrip(template.layout) ?? template.layout
        const standardLayout =
          options?.seedAgent && (options.seedAgent.tabName || options.seedAgent.terminal)
            ? applySoloChatSeed(baseStandardLayout, options.seedAgent)
            : baseStandardLayout
        const sprintEngineContext = deps.normalizeSprintEngineWorkspaceContext(
          options?.sprintEngineContext,
          folderPath,
          sprintEngineState
        )
        const multiloopContext = deps.normalizeMultiloopWorkspaceContext(
          options?.multiloopContext,
          folderPath,
          multiloopState
        )
        const savedSprintEngineRunSettings = sprintEngineContext
          ? normalizeSprintEngineRunSettings(state.appSettings.sprintEngineRunSettings)[
            sprintEngineRunSettingsKey(sprintEngineContext.statePath)
          ]
          : undefined
        const sprintEngineAutoState = sprintEngineState
          ? deps.normalizeSprintEngineAutoState({
            cliPermissionPreset: state.appSettings.lastAgentSpawnPermissionPreset,
            ...savedSprintEngineRunSettings,
            ...(options?.sprintEngineAutoState ?? {}),
          })
          : deps.normalizeSprintEngineAutoState(options?.sprintEngineAutoState)
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
                  : isAutomationsHost
                    ? AUTOMATIONS_HOST_WORKSPACE_MODE
                    : 'standard',
          folderPath,
          folderMissing: false,
          ...(options?.worktree ? { worktree: options.worktree } : {}),
          sprintEngineContext,
          multiloopContext,
          templateId: template.id,
          layoutModel: isMultiloop
            ? deps.multiloopTabsLayoutModel()
            : isGuidedBrief
              ? guidedBriefLayoutModel()
            : sprintEngineState
            ? deps.sprintEngineTabsLayoutModel(sprintEngineState, agents, { includeAgentTabs: false })
            : standardLayout,
          agents,
          worktreeState: deps.defaultWorkspaceWorktreeState(),
          memory: deps.defaultWorkspaceMemoryConfig(),
          editorState: deps.defaultEditorState(),
          fileExplorerState: defaultWorkspaceFileExplorerState(),
          sprintEngineState,
          multiloopState,
          guidedBriefState,
          sprintEngineRoleCliDefaults,
          ...(initialSpawnAgentIds.length > 0 ? { sprintEngineInitialSpawnAgentIds: initialSpawnAgentIds } : {}),
          sprintEngineAutoState,
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
        createdEventPayload = { workspace: newWorkspace, windowId: targetWindowId, folderPath }
      })

      if (createdEventPayload) {
        const { workspace, windowId, folderPath } = createdEventPayload
        void workspaceSyncClient.dispatchCreateWorkspace(workspace, windowId, folderPath)
      }
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
        const seenAt = Date.now()
        if (windowState) {
          windowState.activeWorkspaceId = id
          windowState.lastFocusedAt = seenAt
        }
      }),

    setFolderPath: (id, folderPath) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (ws) {
          const folderChanged = ws.folderPath !== folderPath
          ws.folderPath = folderPath
          ws.folderMissing = false
          if (folderChanged) {
            // The new folder invalidates folder/repo-scoped view state: the file
            // selection, the Backlog item (keyed by folder-relative path), and the
            // Git scope/commit drafts all belong to the previous folder.
            ws.fileExplorerState = defaultWorkspaceFileExplorerState()
            ws.backlogState = undefined
            ws.gitPanelState = undefined
          }
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

    setFileExplorerExpandedPaths: (id, expandedPaths) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        // Preserve the persisted selection; only the expanded set is changing here.
        ws.fileExplorerState = normalizeWorkspaceFileExplorerState({
          expandedPaths,
          selectedPath: ws.fileExplorerState?.selectedPath ?? null,
        })
      }),

    setFileExplorerSelectedPath: (id, selectedPath) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        ws.fileExplorerState = normalizeWorkspaceFileExplorerState({
          expandedPaths: ws.fileExplorerState?.expandedPaths ?? [],
          selectedPath,
        })
      }),

    setBacklogViewState: (id, patch) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        const current = ws.backlogState ?? defaultWorkspaceBacklogState()
        ws.backlogState = normalizeWorkspaceBacklogState({ ...current, ...patch })
      }),

    setGitPanelState: (id, patch) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        const current = ws.gitPanelState ?? defaultWorkspaceGitPanelState()
        ws.gitPanelState = normalizeWorkspaceGitPanelState({ ...current, ...patch })
      }),

    setGitCommitDraft: (id, scopeId, text) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws || scopeId.length === 0) return
        const current = ws.gitPanelState ?? defaultWorkspaceGitPanelState()
        const commitDraftsByScopeId = { ...current.commitDraftsByScopeId }
        if (text.trim().length > 0) commitDraftsByScopeId[scopeId] = text
        else delete commitDraftsByScopeId[scopeId]
        ws.gitPanelState = normalizeWorkspaceGitPanelState({ ...current, commitDraftsByScopeId })
      }),

    clearGitCommitDraft: (id, scopeId) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws?.gitPanelState) return
        if (!(scopeId in ws.gitPanelState.commitDraftsByScopeId)) return
        const commitDraftsByScopeId = { ...ws.gitPanelState.commitDraftsByScopeId }
        delete commitDraftsByScopeId[scopeId]
        ws.gitPanelState = { ...ws.gitPanelState, commitDraftsByScopeId }
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
          fileExplorerState: normalizeWorkspaceFileExplorerState(ws.fileExplorerState),
          backlogState: normalizeWorkspaceBacklogState(ws.backlogState),
          gitPanelState: normalizeWorkspaceGitPanelState(ws.gitPanelState),
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
