import type { IJsonModel } from 'flexlayout-react'
import { nanoid } from 'nanoid'
import {
  createEmptySprintEngineRoleCounts,
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
import { composeSprintEngineWorkspaceRecord } from '../../../../shared/sprintengine/workspace-record'
import { detectLanguage } from '../../utils/files'
import { isPlaceholderAgentName } from '../../utils/agentNames'
import { shouldAutoArchiveWorkspace } from '../../utils/workspaceAutoArchive'
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
import {
  AUTOMATIONS_HOST_WORKSPACE_MODE,
  REVIEW_WORKSPACE_MODE,
  REVIEWS_HOST_WORKSPACE_MODE,
} from '../../types/workspace'
import type { ReviewWorkspaceState } from '../../types/workspace'
import { deriveWorkspaceTitle, isDefaultWorkspaceName } from '../../../../shared/workspace-title'
import { SPRINT_ENGINE_MODULE_ID, reconcileWorkspaceModuleState } from './workspaceModuleState'
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
  sprintEngineState?: SprintEngineState | null
): WorkspaceMode {
  if (sprintEngineState) return 'sprintengine'
  if (typeof input === 'string' && input.trim().length > 0) return input
  return 'standard'
}

// One reviewer-state lift for the `review` workspace-type retirement (MC-1708).
// The review id is the workspace id (unchanged: it keys the on-disk review dir),
// so a lift is (workspaceRoot, reviewId, state) — everything needed to write the
// state onto disk beside the change set.
export type ReviewStateMigration = {
  reviewId: WorkspaceId
  workspaceRoot: string
  state: ReviewWorkspaceState
}

// THE ONE SANCTIONED REVIEW EXCEPTION IN CORE (MC-1856). Everything else review
// owns lives in src/renderer/src/review, src/main/review and src/shared/review,
// and core does not import them. This function stays because it is not review
// behaviour: it is a one-time retirement of CORE's OWN persisted workspace rows,
// rows core wrote and only core can drop. Handing it to the review module would
// make dropping dead core state depend on that module being installed and
// enabled. It reads the legacy `Workspace.reviewState` field and nothing else.
//
// The `review` workspace type retired (MC-1708): reviews are instance-level disk
// objects, so persisted review-mode rows are dropped — but only AFTER their
// reviewer state is lifted onto disk. This is the pure half: from the persisted
// workspaces, collect every review-mode row that still carries reviewer state and
// a project folder, as a lift the caller writes to `<reviewDir>/state.json`
// before dropping the row. A review row with no `reviewState` (nothing typed yet)
// or no `folderPath` (no place to write) yields no lift and is safe to drop
// directly. The reviewer state is carried verbatim — comments (including posted,
// which stay read-only, and 'moved' held ones) and read progress survive the move
// exactly as GitHub/the re-run left them.
export function collectReviewStateMigrations(workspaces: Workspace[]): ReviewStateMigration[] {
  const migrations: ReviewStateMigration[] = []
  for (const workspace of workspaces) {
    if (workspace.mode !== REVIEW_WORKSPACE_MODE) continue
    if (!workspace.reviewState || !workspace.folderPath) continue
    migrations.push({
      reviewId: workspace.id,
      workspaceRoot: workspace.folderPath,
      state: workspace.reviewState,
    })
  }
  return migrations
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
  epics: true,
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
  created: true,
  status: true,
  priority: true,
  largest: true,
  smallest: true,
  dependency: true,
  no_epic: true,
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
  stashes: true,
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
  setWorkspaceArchived: (id: WorkspaceId, archived: boolean) => void
  archiveStaleWorkspaces: () => void
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
      guidedBriefState?: import('../../types/workspace').GuidedBriefRuntimeState | null
      mode?: Workspace['mode']
      // Externally-triggered creation (the automation executor's hidden host):
      // it must not dismiss whatever the operator is reading, so a background
      // create skips the door-surface clear that user-initiated creation does
      // (MC-1833). activeWorkspaceId assignment is unchanged either way.
      background?: boolean
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
  /**
   * Name a still-default workspace after `prompt`, the first real request sent
   * inside it. No-op when the name is already locked or the prompt yields no
   * usable title.
   */
  autoTitleWorkspaceFromPrompt: (id: WorkspaceId, prompt: string) => void
  setActiveWorkspace: (id: WorkspaceId) => void
  setFolderPath: (id: WorkspaceId, folderPath: string | null) => void
  setFolderMissing: (id: WorkspaceId, folderMissing: boolean) => void
  setFileExplorerExpandedPaths: (id: WorkspaceId, expandedPaths: string[]) => void
  setFileExplorerSelectedPath: (id: WorkspaceId, selectedPath: string | null) => void
  setBacklogViewState: (id: WorkspaceId, patch: Partial<WorkspaceBacklogState>) => void
  setGitPanelState: (id: WorkspaceId, patch: Partial<Omit<WorkspaceGitPanelState, 'commitDraftsByScopeId'>>) => void
  setGitCommitDraft: (id: WorkspaceId, scopeId: string, text: string) => void
  clearGitCommitDraft: (id: WorkspaceId, scopeId: string) => void
  /**
   * Write one module's entry in a workspace's per-module state bag (MC-1573);
   * null/undefined removes it. False when the workspace is unknown, or for the
   * reserved `sprintengine` key — that entry's single writer stays
   * setSprintEngineState, which reconciles mode/agents/layout alongside it.
   * Declared here AND on the WorkspaceStore interface (dual-declaration).
   */
  setWorkspaceModuleState: (workspaceId: WorkspaceId, moduleId: string, state: unknown) => boolean
  importWorkspace: (ws: Workspace) => void
  moveAgentToWorkspace: (
    sourceWorkspaceId: WorkspaceId,
    destWorkspaceId: WorkspaceId,
    agentId: AgentId
  ) => void
  /** Delete an agent record from a workspace entirely (not just close its tab).
   *  Caller is responsible for killing the agent's terminal and removing its
   *  layout tab first. Idempotent: a missing workspace/agent is a no-op. */
  removeAgent: (workspaceId: WorkspaceId, agentId: AgentId) => void
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
  normalizeSprintEngineAutoState: (
    input:
      | (Partial<SprintEngineAutoState> & {
        deliveredAgentNotificationEventIds?: string[]
      })
      | null
      | undefined
  ) => SprintEngineAutoState
  normalizeSprintEngineRoleCliDefaults: (
    input: SprintEngineRoleCliDefaults | null | undefined
  ) => Required<SprintEngineRoleCliDefaults>
  sprintEngineTabsLayoutModel: (
    sprintEngineState: SprintEngineState,
    agents: Workspace['agents'],
    options?: { includeAgentTabs?: boolean }
  ) => IJsonModel
  hideNavRailTabStrip: (model: IJsonModel | null | undefined) => IJsonModel | null | undefined
  migrateSprintEngineLayout: (ws: Workspace) => Workspace
  pickWorkspaceAgentName: (agents: Workspace['agents']) => string
  isPathOrChild: (path: string, parentPath: string) => boolean
}

// activeGlobalSurface is owned by the settings slice but cleared here: activating
// a workspace must return the card region from a door-routed full-page surface to
// that workspace (the sidebar's one-selected-thing invariant, global-surfaces
// epic 1704). activeModalSurface clears with it (doors→modals, 2026-09-01): a
// reveal must land on a visible workspace, not one behind a scrim. The combined
// store carries both fields; the carrier widens to reach them.
type WorkspacesSliceCarrier = WorkspacesSliceState & {
  appSettings: AppSettings
  activeGlobalSurface: string | null
  activeModalSurface: string | null
}
type WorkspacesSliceSet = (mutator: (state: WorkspacesSliceCarrier) => void) => void

// The one activation-side dismissal of routed/floating surfaces: activating a
// workspace returns the card region from a door AND closes any modal, so the
// workspace lands visible (doors→modals, 2026-09-01). Every activation path
// calls this — a new path that forgets it re-opens the invisible-reveal bug.
function clearRoutedSurfaces(state: WorkspacesSliceCarrier): void {
  state.activeGlobalSurface = null
  state.activeModalSurface = null
}

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
        // Leaving a door-routed full-page surface for a workspace (epic 1704);
        // an open modal closes with it so the workspace lands unobscured.
        clearRoutedSurfaces(state)
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

    // Presentation-level archive flag: hides the workspace from the sidebar
    // rail and the Sprints aside's default lenses. Never touches agents, run
    // state, or window assignment, so unarchiving restores it exactly.
    setWorkspaceArchived: (id, archived) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        ws.archivedAt = archived ? Date.now() : null
      }),

    // Startup tidiness sweep: archive workspaces idle for 5+ days
    // (shouldAutoArchiveWorkspace — starred rows, pending-work sprints, and
    // the Automations host never qualify). Every window's active workspace is
    // excluded so the sweep can never hide what someone is looking at. Typing
    // into an archived workspace revives it (recordWorkspaceTerminalActivity).
    archiveStaleWorkspaces: () =>
      set((state) => {
        const now = Date.now()
        const activeIds = new Set<WorkspaceId | null>([
          state.activeWorkspaceId,
          ...state.workspaceWindows.map((windowState) => windowState.activeWorkspaceId),
        ])
        for (const ws of state.workspaces) {
          if (activeIds.has(ws.id)) continue
          if (shouldAutoArchiveWorkspace(ws, now)) ws.archivedAt = now
        }
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
        // Real work revives an archived workspace — typing is the one signal
        // that the user is back in it, so it reappears in the rail.
        if (typeof ws.archivedAt === 'number') ws.archivedAt = null
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
      // Captured for a genuinely new workspace (not the Switchboard-reuse early
      // return) so creation is broadcast through main as a workspace.created
      // event — and for an Automations-host reuse, where the offer heals a main
      // process whose routing snapshot forgot the host. Local creation stays the
      // functional path; storage-event sync is the rollback. Fire-and-forget
      // after the synchronous set().
      let createdEventPayload:
        | { workspace: Workspace; windowId: WorkspaceWindowId; folderPath: string | null }
        | null = null

      set((state) => {
        const folderPath = options?.folderPath ?? null
        const fallbackName = `${template.name} ${state.workspaces.length + 1}`
        const explicitMode = options?.mode
        const isSwitchboard = explicitMode === 'switchboard' || template.id === 'switchboard-mode'
        const isSprintEngine = !isSwitchboard && (template.id === 'sprintengine-mode' || Boolean(options?.sprintEngineState))
        const guidedBriefState = normalizeGuidedBriefState(options?.guidedBriefState)
        const isGuidedBrief = explicitMode === 'guided-brief' || template.id === 'guided-brief-mode' || Boolean(guidedBriefState)
        const isAutomationsHost = explicitMode === AUTOMATIONS_HOST_WORKSPACE_MODE
        const isReview = explicitMode === REVIEW_WORKSPACE_MODE || template.id === 'review-mode'
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
          // Activation always dismisses a door-routed surface (epic 1704) —
          // otherwise the workspace opens behind the door's opaque layer — and
          // an open modal, so the workspace lands unobscured. A background
          // create (automation executor) leaves both alone.
          if (!options?.background) clearRoutedSurfaces(state)
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
        // A background host — Automations (item 1707) or Reviews (MC-1911) — is
        // strictly one-per-project, the same contract as Switchboard. Every
        // creation path funnels here, so reusing the folder's existing host at
        // this boundary is what guarantees a duplicate can never be minted,
        // whatever the caller believed. Both are created by code rather than by a
        // person, which is exactly why the check has to be inside `set()`: two
        // calls in one tick each read the store before either writes.
        const hostMode = isAutomationsHost
          ? AUTOMATIONS_HOST_WORKSPACE_MODE
          : explicitMode === REVIEWS_HOST_WORKSPACE_MODE
            ? REVIEWS_HOST_WORKSPACE_MODE
            : null
        const hostFolderKey = hostMode ? workspaceFolderKey(folderPath) : null
        const existingHost = hostFolderKey
          ? state.workspaces.find((workspace) =>
            workspace.mode === hostMode
            && workspaceFolderKey(workspace.folderPath) === hostFolderKey
          )
          : null
        if (existingHost) {
          if (folderPath) {
            state.appSettings.recentWorkspaceFolders = normalizeRecentWorkspaceFolders(
              [folderPath],
              state.appSettings.recentWorkspaceFolders
            )
          }
          id = existingHost.id
          existingHost.folderMissing = false
          state.activeWorkspaceId = existingHost.id
          if (!options?.background) clearRoutedSurfaces(state)
          const targetWindow = ensureWorkspaceWindow(
            state,
            options?.windowId ?? findWorkspaceWindow(state, existingHost.id)?.id ?? targetWindowId,
          )
          if (!targetWindow.workspaceIds.includes(existingHost.id)) {
            targetWindow.workspaceIds.push(existingHost.id)
          }
          targetWindow.activeWorkspaceId = existingHost.id
          normalizeWindowAssignments(state)
          // No re-offer to main. That step existed only to heal a
          // restart-restored routing placeholder whose mode main had lost
          // (MC-2158 removed the placeholder), and reuse itself is main's call
          // now: `prepareCreate` resolves the folder's existing host inside the
          // same critical section as the mint, which is the only place the
          // check can hold ACROSS windows.
          return
        }
        const sprintEngineState = isSprintEngine
          ? normalizeSprintEngineState(options?.sprintEngineState)
            ?? createInitialSprintEngineState({
              goal: options?.sprintEngineState?.goal ?? 'Launch Sprint Engine mode',
              name: options?.sprintEngineState?.name ?? options?.name ?? 'Sprint Roster',
              roleCounts: options?.sprintEngineState?.roleCounts ?? createEmptySprintEngineRoleCounts(),
            })
          : null
        const workspaceName = sprintEngineState
          ? sprintEngineState.name
          : options?.name?.trim() || fallbackName
        // Only a workspace on an app-minted name ("Chat 44", "Solo 3") is a
        // candidate for auto-titling. A sprint roster name, a wizard-typed name,
        // or a chained run's name is already meaningful and is locked here so the
        // first prompt never overwrites it. A SHAPE test, deliberately: the New
        // chat button passes its own per-folder ordinal ("Chat 63") while
        // `fallbackName` numbers globally, so comparing the two strings locked
        // every new chat at birth and the first prompt never named anything.
        const titleLocked = !isDefaultWorkspaceName(workspaceName, template.name)
        const agents: Workspace['agents'] = {}
        const sprintEngineRoleCliDefaults = sprintEngineState
          ? deps.normalizeSprintEngineRoleCliDefaults(options?.sprintEngineRoleCliDefaults)
          : undefined
        // A sprint's roster agents and board layout are composed by the shared
        // builder below (MC-2160), which main runs too — a second copy here
        // would drift the first time a seeded field changes. All this branch
        // still owns is the fail-fast: the builder needs the CLI defaults, and
        // creation runs AFTER initializeSprintEngineState has written run.yaml
        // and (in worktree mode) created the git worktree, so failing later
        // would orphan a real on-disk run.
        if (sprintEngineState) {
          if (!sprintEngineRoleCliDefaults) {
            throw new Error('Missing Sprint Engine CLI defaults for workspace creation.')
          }
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
            // A generic template tab label ("Agent", "Agent 2", "A1") is a slot
            // placeholder, never an identity — general agents get a real picked
            // name exactly like specialists (the layout tab renames itself to
            // agent.name on render). A distinctive name from a user-saved
            // template survives.
            const templateName =
              agent.name && !isPlaceholderAgentName(agent.name) ? agent.name : undefined
            const base = {
              ...deps.defaultAgent(
                agent.id,
                templateName ?? deps.pickWorkspaceAgentName(agents),
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
        // A sprint workspace is composed by the shared builder (MC-2160): its
        // roster-seeded agents, board layout, and the canonical/legacy run-state
        // pair are the same record main mints for a headless `sprint.create`.
        const sprintWorkspace = sprintEngineState && sprintEngineRoleCliDefaults
          ? composeSprintEngineWorkspaceRecord({
            workspaceId: id,
            sprintEngineState,
            sprintEngineContext,
            folderPath,
            roleCliDefaults: sprintEngineRoleCliDefaults,
            agentCliOverrides: options?.sprintEngineAgentCliOverrides ?? null,
            roleModelOverrides: options?.sprintEngineRoleModelOverrides ?? null,
            initialSpawnRoles: options?.sprintEngineInitialSpawnRoles ?? null,
            sprintEngineAutoState,
            createdAt: Date.now(),
            pickAgentName: deps.pickWorkspaceAgentName,
            defaults: {
              worktreeState: deps.defaultWorkspaceWorktreeState(),
              memory: deps.defaultWorkspaceMemoryConfig(),
              editorState: deps.defaultEditorState(),
              fileExplorerState: defaultWorkspaceFileExplorerState(),
            },
            ...(options?.worktree ? { worktree: options.worktree } : {}),
          }).workspace
          : null
        const standardWorkspace: Workspace = {
          id,
          name: workspaceName,
          ...(titleLocked ? { titleLocked: true } : {}),
          mode: isSwitchboard
            ? 'switchboard'
            : isGuidedBrief
              ? 'guided-brief'
              : isAutomationsHost
                ? AUTOMATIONS_HOST_WORKSPACE_MODE
                : explicitMode === REVIEWS_HOST_WORKSPACE_MODE
                  ? REVIEWS_HOST_WORKSPACE_MODE
                  : isReview
                    ? REVIEW_WORKSPACE_MODE
                    // Module-contributed workspace types: the explicit mode
                    // from buildModuleTypeCreation IS the identity every
                    // mode-derived surface (panel scopes, run glyphs, the
                    // not-installed state, creation re-resolution) keys on —
                    // dropping it to 'standard' silently strips all of them.
                    : explicitMode ?? 'standard',
          folderPath,
          folderMissing: false,
          ...(options?.worktree ? { worktree: options.worktree } : {}),
          sprintEngineContext,
          templateId: template.id,
          layoutModel: isGuidedBrief ? guidedBriefLayoutModel() : standardLayout,
          agents,
          worktreeState: deps.defaultWorkspaceWorktreeState(),
          memory: deps.defaultWorkspaceMemoryConfig(),
          editorState: deps.defaultEditorState(),
          fileExplorerState: defaultWorkspaceFileExplorerState(),
          sprintEngineState,
          guidedBriefState,
          sprintEngineRoleCliDefaults,
          sprintEngineAutoState,
          createdAt: Date.now(),
        }
        const newWorkspace: Workspace = sprintWorkspace
          ? { ...sprintWorkspace, guidedBriefState }
          : standardWorkspace
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
        if (!options?.background) clearRoutedSurfaces(state)
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

    // Main tombstones the id as it removes the record, so a lagging window's
    // optimistic edit against this workspace is rejected rather than
    // resurrecting it.
    removeWorkspace: (id) => {
      void workspaceSyncClient.dispatchRemoveWorkspace(id)
      set((state) => {
        const idx = state.workspaces.findIndex((w) => w.id === id)
        if (idx === -1) return
        state.workspaces.splice(idx, 1)
        if (state.activeWorkspaceId === id) {
          state.activeWorkspaceId = state.workspaces.at(-1)?.id ?? null
        }
        normalizeWindowAssignments(state)
        if (state.workspaces.length === 0) {
          // Explicit registry empty-state record: the one thing that tells main
          // an empty registry is intent rather than a fault, so hydration seeds
          // empty instead of refusing. addWorkspace + importWorkspace clear it.
          state.workspaceRegistryEmptyState = {
            reason: 'user_removed_all',
            updatedAt: new Date().toISOString(),
          }
        }
      })
    },

    // Applied optimistically, then asked of main (MC-2158). Main decides with
    // per-field last-write-wins on the name stamp: the later gesture wins
    // whatever order the two commands arrive in, and the window that loses
    // converges on main's broadcast. The lock travels with the name — without
    // it the winning rename would still be auto-titled over.
    renameWorkspace: (id, name) => {
      let accepted: string | null = null
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        ws.name = name.trim() || ws.name
        // A hand-typed name is final: auto-titling must never overwrite it, and
        // the lock is set even when the rename was a no-op (the user retyping
        // the same name is still them settling on it).
        ws.titleLocked = true
        accepted = ws.name
      })
      if (accepted) void workspaceSyncClient.dispatchRenameWorkspace(id, accepted, true)
    },

    // Name a still-default workspace after the first real prompt sent inside it.
    // A no-op once the name is locked — by an earlier auto-title, a manual
    // rename, or an explicit name at creation — which is what stops the title
    // moving when a second prompt or a second terminal arrives.
    //
    // Takes the raw prompt rather than a finished title so the derivation stays
    // in one place and a rejected prompt (an app-injected skill drop, filler)
    // leaves the workspace unlocked for the next one.
    autoTitleWorkspaceFromPrompt: (id, prompt) => {
      let accepted: string | null = null
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws || ws.titleLocked) return
        const title = deriveWorkspaceTitle(prompt)
        if (!title) return
        ws.name = title
        ws.titleLocked = true
        accepted = title
      })
      if (accepted) void workspaceSyncClient.dispatchRenameWorkspace(id, accepted, true)
    },

    setActiveWorkspace: (id) =>
      set((state) => {
        state.activeWorkspaceId = id
        // Leaving a door-routed full-page surface for a workspace (epic 1704);
        // an open modal closes with it so the workspace lands unobscured.
        clearRoutedSurfaces(state)
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

    setWorkspaceModuleState: (workspaceId, moduleId, moduleStateValue) => {
      // The sprintengine entry has exactly one writer (setSprintEngineState),
      // which keeps the legacy mirror, mode, agents, and layout in step with
      // it; a bag-only write here would silently break that lockstep.
      if (moduleId === SPRINT_ENGINE_MODULE_ID) return false
      let updated = false
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        if (moduleStateValue === undefined || moduleStateValue === null) {
          if (ws.moduleState && moduleId in ws.moduleState) {
            delete ws.moduleState[moduleId]
            if (Object.keys(ws.moduleState).length === 0) delete ws.moduleState
          }
        } else {
          ;(ws.moduleState ??= {})[moduleId] = moduleStateValue
        }
        updated = true
      })
      return updated
    },

    importWorkspace: (ws) =>
      set((state) => {
        const id = nanoid()
        const sprintEngineState = normalizeSprintEngineState(ws.sprintEngineState)
        const mode = sprintEngineState ? 'sprintengine' : ws.mode ?? 'standard'
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
        // Reconcile the imported bag with the normalized mirror (an imported
        // payload can carry either representation) before it enters the store.
        state.workspaces.push(reconcileWorkspaceModuleState({
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
          sprintEngineRoleCliDefaults: deps.normalizeSprintEngineRoleCliDefaults(ws.sprintEngineRoleCliDefaults),
          sprintEngineAutoState: deps.normalizeSprintEngineAutoState(ws.sprintEngineAutoState),
        } satisfies Workspace))
        const imported = state.workspaces.at(-1)
        if (imported) {
          Object.assign(imported, deps.migrateSprintEngineLayout(imported))
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

    removeAgent: (workspaceId, agentId) => {
      set((state) => {
        const workspace = state.workspaces.find((w) => w.id === workspaceId)
        if (!workspace?.agents[agentId]) return
        delete workspace.agents[agentId]
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
