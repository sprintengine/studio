import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import type { IJsonModel } from 'flexlayout-react'
import type {
  Workspace,
  WorkspaceBacklogState,
  WorkspaceGitPanelState,
  WorkspaceId,
  WorkspaceWindowId,
  WorkspaceWindowState,
  LayoutTemplate,
  AgentState,
  AgentId,
  SprintEngineAutoState,
  SprintEngineAutomationEvent,
  SprintEngineAutomationMode,
  SprintEngineCliPermissionPreset,
  SprintEngineState,
  SprintEngineWorkspaceContext,
  SprintEngineRoleId,
  SprintEngineRoleCliDefaults,
  SprintEngineRosterSession,
  SprintEngineRoleCounts,
  SprintEngineRoleModelOverrides,
  AgentCli,
  AgentCliModelSelection,
  AgentConfigAdoptionResult,
  AgentConversationRuntime,
  AppSettings,
  VoiceDictationSettings,
  CliRuntimeSettings,
  SpecialistActionId,
  SprintEngineRoleRegistry,
  NewChatAgentChoice,
  AgentExecution,
  WorkspaceWorktreeState,
  WorktreeEntry,
  MemoryGraphSettings,
  WorkspaceHighlight,
  McpServerConfig,
} from '../types/workspace'
import type { AppTheme, WindowMaterial } from '../types/appTheme'
import type { LaunchedAgentProjection } from '../utils/launchedAgentProjection'
import type { DiscoveredCliModelCatalog } from '../../../shared/cli-model-catalog'
import type { FolderOpenTargetId } from '../../../shared/folder-open-targets'
import type { CommandId } from '../commands/commandRegistry'
import type { ExtensionsDrawerView } from '../components/workspace/globalSurface/extensions/extensionsSurfaceTarget'
import { createAuthSlice } from './slices/authSlice'
import {
  createSettingsSlice,
  normalizeAppSettings,
  type ChatListView,
  type DiffViewMode,
  type SidebarSection,
} from './slices/settingsSlice'
import { clampSidebarWidth } from '../components/workspace/sidebarWidth'
import { clampWorkspaceAsideWidth } from '../components/workspace/workspaceAsideWidth'
import {
  adoptLegacyBacklogTab,
  createWorkspacePaneSlice,
  type WorkspacePaneSliceActions,
} from './slices/workspacePaneSlice'
import { createFocusedAgentSlice, type FocusedAgentSlice } from './slices/focusedAgentSlice'
import {
  createWorkspacesSlice,
  type SoloChatSeed,
  type WorkspacesSliceDependencies,
} from './slices/workspacesSlice'
import {
  createLayoutSlice,
  healRetiredRailLayout,
  stripRetiredRailTabsFromLayout,
  hideNavRailTabStrip,
  migrateSprintEngineLayout,
  sprintEngineTabsLayoutModel,
} from './slices/layoutSlice'
import {
  createAgentsSlice,
  defaultAgent,
  defaultEditorState,
  isPathOrChild,
  normalizeAgentState,
  pickWorkspaceAgentName,
} from './slices/agentsSlice'
import {
  createRunStateSlice,
  normalizeSprintEngineAutoState,
  normalizeSprintEngineRoleCliDefaults,
  normalizeSprintEngineWorkspaceContext,
} from './slices/runStateSlice'
import {
  createWorktreesSlice,
  defaultWorkspaceWorktreeState,
  normalizeWorkspaceWorktreeState,
} from './slices/worktreesSlice'
import {
  createMemorySlice,
  defaultWorkspaceMemoryConfig,
} from './slices/memorySlice'
import {
  createCliAvailabilitySlice,
  type CliAvailabilitySlice,
} from './slices/cliAvailabilitySlice'
import {
  createPluginsSlice,
  type PluginsSlice,
} from './slices/pluginsSlice'
import {
  createHostedModelFeedSlice,
  type HostedModelFeedSlice,
} from './slices/hostedModelFeedSlice'
import {
  createHostedCardFeedSlice,
  type HostedCardFeedSlice,
} from './slices/hostedCardFeedSlice'
import {
  createCliVersionAdvisorySlice,
  type CliVersionAdvisorySlice,
} from './slices/cliVersionAdvisorySlice'
import {
  dedupeAutomationsHostWorkspaces,
  dropRetiredModeWorkspaces,
  nameGenericWorkspaceAgents,
  normalizeWorkspaceForPartialize,
} from './slices/normalizers'
import { keepLaterWorkspaceClocks } from '../utils/workspaceRecency'
import { applyWorkspaceFieldsPatch } from '../../../shared/workspace-sync'
import { reconcileWorkspaceModuleState } from './slices/workspaceModuleState'
import {
  configureWorkspaceSyncClient,
  workspaceSyncClient,
  type AgentTerminalLaunchStateApply,
  type AgentTerminalSessionApply,
  type WorkspaceActiveChangedApply,
  type WorkspaceClosedApply,
  type WorkspaceCreatedApply,
  type WorkspaceMovedApply,
  type WorkspacePlacementApply,
} from './workspaceSyncClient'
import {
  APP_SETTINGS_STORAGE_KEY,
  PRIMARY_WORKSPACE_WINDOW_ID,
  WORKSPACE_STORAGE_KEY,
  WORKSPACE_STORE_VERSION,
  type HydrationDiagnostic,
  type HydrationStorageSource,
  type PersistedStateClassification,
  type WorkspaceMigrationState,
  classifyPersistedWorkspaceState,
  isDangerousEmptyClassification,
  hydrateSprintEngineLocalRunSettings,
  migrateLegacyWorkspaceStorageKey,
  migratePersistedWorkspaceState,
  normalizeWorkspaceWindows,
} from './slices/persistenceSlice'
import {
  isLegacyV44WorkspaceEnvelope,
  splitLegacyV44Envelope,
} from './repositories/workspaceRegistry'
import type {
  ProjectColorSetting,
  WorkspaceFolderRole,
  WorkspaceRegistryEmptyState,
  WorkspaceWorktree,
} from '../types/workspace'
import { sprintEngineAutomationShouldRun } from '../utils/sprintengineAutomationLifecycle'

migrateLegacyWorkspaceStorageKey()

export interface WorkspaceStore extends PluginsSlice, CliAvailabilitySlice, HostedModelFeedSlice, HostedCardFeedSlice, CliVersionAdvisorySlice, WorkspacePaneSliceActions, FocusedAgentSlice {
  workspaces: Workspace[]
  activeWorkspaceId: WorkspaceId | null
  workspaceWindows: WorkspaceWindowState[]
  primaryWorkspaceWindowId: WorkspaceWindowId
  workspaceRegistryEmptyState: WorkspaceRegistryEmptyState | null
  appSettings: AppSettings
  authState: MulticodeAuthState
  sidebarCollapsed: boolean
  setSidebarCollapsed: (collapsed: boolean) => void
  // Which shape the chat rail lists conversations in (all-chats-view):
  // the project tree, or one stream of every chat newest-first. Persisted
  // in the settings envelope beside sidebarWidth.
  chatListView: ChatListView
  setChatListView: (view: ChatListView) => void
  sidebarWidth: number
  setSidebarWidth: (width: number) => void
  sprintEngineRoleRegistry: SprintEngineRoleRegistry | null
  setSprintEngineRoleRegistry: (registry: SprintEngineRoleRegistry | null) => void
  // The workspace pane column's width (browser-pane epic), persisted in the
  // settings envelope beside sidebarWidth. Open/closed is per workspace
  // (`workspace.paneState.open`); maximised is session-only.
  workspacePaneWidth: number
  setWorkspacePaneWidth: (width: number) => void
  workspacePaneMaximised: boolean
  setWorkspacePaneMaximised: (maximised: boolean) => void
  openFilesInExternalWindow: boolean
  setOpenFilesInExternalWindow: (enabled: boolean) => void
  diffOpensInWindow: boolean
  setDiffOpensInWindow: (enabled: boolean) => void
  diffView: DiffViewMode
  setDiffView: (view: DiffViewMode) => void
  checkCliVersions: boolean
  setCheckCliVersions: (enabled: boolean) => void
  // The request that opened the Settings modal — not the modal's visibility;
  // `activeModalSurface === 'settings'` is what says it is showing.
  settingsOverlay: {
    initialTab: string | null
    checkForUpdatesRequestId: number | null
  }
  openSettingsOverlay: (opts?: { initialTab?: string | null; checkForUpdates?: boolean }) => void
  closeSettingsOverlay: () => void
  // Opens the Extensions door on one of its three views, optionally on that
  // view's Installed tab (source-tabs ruling, 2026-09-05).
  openExtensionsSurface: (opts?: { view?: ExtensionsDrawerView; installed?: boolean }) => void
  // The door-routed full-page surface for this window (global-surfaces epic
  // 1704): a registered surface id or null when a workspace owns the card
  // region. Transient and unsynced (absent from extractSettingsFields /
  // partializeWorkspaceStoreState). Opening a door sets
  // it; activating any workspace clears it — the sidebar's one-selected-thing
  // invariant.
  activeGlobalSurface: string | null
  openGlobalSurface: (surfaceId: string) => void
  closeGlobalSurface: () => void
  // The modal surface floating over this window (doors→modals, 2026-09-01): a
  // registered modal-surface id or null. Transient/unsynced like
  // activeGlobalSurface, but a float over the card region rather than a mount
  // kind — closing it lands where the user was. One at a time; activating a
  // workspace clears it.
  activeModalSurface: string | null
  // The workspace the open modal was opened from, when its opener had one.
  activeModalSurfaceWorkspaceId: string | null
  openModalSurface: (surfaceId: string, options?: { workspaceId?: string }) => void
  closeModalSurface: () => void
  // The app rail's active section (Home / Extensions), deciding what the
  // sidebar column shows. Transient like activeGlobalSurface.
  sidebarSection: SidebarSection
  setSidebarSection: (section: SidebarSection) => void
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
  forgetFolder: (folderPath: string) => void
  setWorkspaceHighlight: (id: WorkspaceId, highlight: Partial<WorkspaceHighlight>) => void
  clearWorkspaceHighlight: (id: WorkspaceId) => void
  setWorkspaceSettled: (id: WorkspaceId, settled: boolean) => void
  /**
   * Put a chat to sleep until `wakeAt`, or wake it now with `null`. Visibility
   * only — the terminals and the agent are untouched. See `utils/workspaceSnooze.ts`.
   */
  setWorkspaceSnoozed: (id: WorkspaceId, wakeAt: number | null) => void
  /** Returns the ids that CAME TO REST on this tick, for the caller to quiet. */
  reconcileWorkspaceSettlement: (input: {
    now: number
    busyIds: ReadonlySet<WorkspaceId>
    heldIds: ReadonlySet<WorkspaceId>
  }) => WorkspaceId[]
  recordWorkspaceTerminalActivity: (id: WorkspaceId, lastInputAt: number) => void
  recordWorkspaceUserMessage: (id: WorkspaceId, at: number) => void
  recordWorkspaceTurnEnd: (id: WorkspaceId, at: number) => void
  reconcileWorkspaceAgentLaunchFlags: (sessions: TerminalSessionSnapshot[]) => void
  projectLaunchedAgentSessions: (sessions: TerminalSessionSnapshot[]) => LaunchedAgentProjection[]
  setAuthState: (authState: MulticodeAuthState) => void
  setCliRuntime: (cli: AgentCli, update: Partial<CliRuntimeSettings>) => void
  setCliModelCatalog: (cli: AgentCli, catalog: DiscoveredCliModelCatalog | null) => void
  setMcpSyncEnabled: (enabled: boolean) => void
  upsertMcpServer: (server: McpServerConfig) => void
  /** Sync's writer: the same upsert, without turning MCP config sync back on. */
  refreshMcpServersFromSource: (servers: McpServerConfig[]) => void
  removeMcpServer: (serverId: string) => void
  setLastSelectedCli: (cli: AgentCli) => void
  setLastSelectedConversationModel: (selection: AgentConversationRuntime | null) => void
  setTextGenerationEnabled: (enabled: boolean) => void
  setTextGenerationEngine: (selection: AgentCliModelSelection | null) => void
  setLastNewChatAgent: (choice: NewChatAgentChoice) => void
  setLastFolderOpenTarget: (target: FolderOpenTargetId) => void
  /** The Design door's viewing scope. Null returns it to following the active workspace. */
  setDesignProjectScopePath: (path: string | null) => void
  /**
   * Set one project's colour, keyed by `projectColorKey` (utils/projectColor).
   * `'none'` is a stored "no colour"; `null` deletes the entry, returning the
   * project to not-yet-seen.
   */
  setProjectColor: (key: string, color: ProjectColorSetting | null) => void
  /**
   * Give every one of these projects a colour it has not got yet, allocated
   * against the hues THESE projects already wear — the on-screen set, never the
   * whole stored history. Keys that already carry an entry (a hue OR `'none'`)
   * are untouched, and a call with nothing missing writes nothing at all — so a
   * surface may call it from an effect on every render.
   */
  assignProjectColors: (keys: readonly string[]) => void
  /**
   * Stamp a design system as seen, now — the Design door's "New" marker reads
   * against it. Called AFTER the render that computed the markers, so the visit
   * that reveals them is the visit that clears them.
   */
  markDesignSystemSeen: (bundleId: string, at?: string) => void
  setLastAgentSpawnPermissionPreset: (preset: SprintEngineCliPermissionPreset) => void
  setSpecialistCliDefault: (specialistId: SpecialistActionId, cli: AgentCli | null) => void
  setSpecialistModelDefault: (specialistId: SpecialistActionId, selection: AgentCliModelSelection | null) => void
  /** Drop retired model ids from every remembered launch default for `cli`. */
  forgetCliModels: (cli: AgentCli, modelIds: readonly string[]) => void
  setSpecialistReasoningDefault: (
    specialistId: SpecialistActionId,
    cli: AgentCli,
    reasoning: string | null,
  ) => void
  setSpecialistOrder: (order: SpecialistActionId[]) => void
  setSpecialistPackEnabled: (packId: string, enabled: boolean) => void
  markBundledSpecialistPackMigrated: () => void
  setCommandKeybindings: (commandId: CommandId, keybindings: string[]) => void
  setCommandKeybindingDisabled: (commandId: CommandId, disabled: boolean) => void
  resetCommandKeybindings: (commandId: CommandId) => void
  resetAllKeybindings: () => void
  setProjectKnowledgeRoot: (projectRoot: string, relativeRoot: string | null) => void
  setTerminalIdleSuspendMinutes: (minutes: number) => void
  setTerminalKeepRecentAlive: (count: number) => void
  /** Keep the app (and its sprint runs) alive after the last window closes. */
  setKeepRunningInBackground: (enabled: boolean) => void
  setVoiceDictationSettings: (update: Partial<VoiceDictationSettings>) => void
  setSprintEngineRoleEnabled: (role: SprintEngineRoleId, enabled: boolean) => void
  saveSprintEngineRoster: (input: {
    id?: string
    name: string
    roleCounts: SprintEngineRoleCounts
    roleCliDefaults: SprintEngineRoleCliDefaults
    roleModelOverrides?: SprintEngineRoleModelOverrides
  }) => string
  renameSprintEngineRoster: (id: string, name: string) => void
  deleteSprintEngineRoster: (id: string) => void
  setSprintEngineLastSelectedRoster: (id: string | null) => void
  setModuleEnabled: (moduleId: string, enabled: boolean) => void
  /** Write one value in a module's `module:<id>` settings namespace; `undefined` deletes the key. */
  setModuleSettingValue: (moduleId: string, key: string, value: unknown) => void
  dismissFirstRunCliCard: () => void
  markAgentConfigAdopted: () => void
  // Transient outcome of the silent first-run config adoption, read out as one
  // line in Settings → Agents. Not persisted (see extractSettingsFields).
  agentConfigAdoptionResult: AgentConfigAdoptionResult | null
  setAgentConfigAdoptionResult: (result: AgentConfigAdoptionResult | null) => void
  setAppearanceTheme: (theme: AppTheme) => void
  setAppearanceWindowMaterial: (material: WindowMaterial) => void
  addWorkspace: (
    template: LayoutTemplate,
    options?: {
      name?: string
      folderPath?: string | null
      // Set for a chat created on a paired machine; see Workspace.remoteOrigin.
      remoteOrigin?: import('../types/workspace').WorkspaceRemoteOrigin | null
      worktree?: WorkspaceWorktree | null
      sprintEngineState?: SprintEngineState | null
      sprintEngineContext?: SprintEngineWorkspaceContext | null
      sprintEngineRoleCliDefaults?: SprintEngineRoleCliDefaults | null
      sprintEngineAgentCliOverrides?: Record<AgentId, AgentCli> | null
      sprintEngineRoleModelOverrides?: SprintEngineRoleModelOverrides | null
      sprintEngineInitialSpawnRoles?: SprintEngineRoleId[] | null
      templateAgentCli?: AgentCli | null
      seedAgent?: SoloChatSeed | null
      sprintEngineAutoState?: Partial<SprintEngineAutoState> | null
      mode?: Workspace['mode']
      // Executor-triggered creation: skip the door-surface clear (MC-1833).
      background?: boolean
      windowId?: WorkspaceWindowId | null
    }
  ) => WorkspaceId
  removeWorkspace: (id: WorkspaceId) => void
  renameWorkspace: (id: WorkspaceId, name: string) => void
  autoTitleWorkspaceFromPrompt: (id: WorkspaceId, prompt: string) => string | null
  applyGeneratedWorkspaceTitle: (id: WorkspaceId, title: string, replacing: string | null) => boolean
  setActiveWorkspace: (id: WorkspaceId) => void
  updateLayout: (id: WorkspaceId, model: IJsonModel) => void
  setFolderPath: (id: WorkspaceId, folderPath: string | null) => void
  setSprintEngineContext: (id: WorkspaceId, sprintEngineContext: SprintEngineWorkspaceContext | null) => void
  setFolderMissing: (id: WorkspaceId, folderMissing: boolean) => void
  setFileExplorerExpandedPaths: (id: WorkspaceId, expandedPaths: string[]) => void
  setFileExplorerFolderRole: (id: WorkspaceId, folderPath: string, role: WorkspaceFolderRole | null) => void
  setFileExplorerSelectedPath: (id: WorkspaceId, selectedPath: string | null) => void
  setBacklogViewState: (id: WorkspaceId, patch: Partial<WorkspaceBacklogState>) => void
  setGitPanelState: (id: WorkspaceId, patch: Partial<Omit<WorkspaceGitPanelState, 'commitDraftsByScopeId'>>) => void
  /** Remember which agent this workspace is on — the Diff surfaces' default
   *  changelist (agent changelists). See workspacesSlice. */
  setLastActiveAgent: (id: WorkspaceId, agentId: string | null) => void
  setGitCommitDraft: (id: WorkspaceId, scopeId: string, text: string) => void
  clearGitCommitDraft: (id: WorkspaceId, scopeId: string) => void
  /**
   * Write one module's entry in a workspace's per-module state bag (MC-1573);
   * null/undefined removes it. False for an unknown workspace or the reserved
   * `sprintengine` key (single writer: setSprintEngineState).
   */
  setWorkspaceModuleState: (workspaceId: WorkspaceId, moduleId: string, state: unknown) => boolean
  updateAgent: (workspaceId: WorkspaceId, agentId: AgentId, update: Partial<AgentState>) => void
  removeAgent: (workspaceId: WorkspaceId, agentId: AgentId) => void
  applyAgentTerminalSessionEvent: (apply: AgentTerminalSessionApply) => void
  applyAgentTerminalLaunchStateEvent: (apply: AgentTerminalLaunchStateApply) => void
  setAgentExecution: (
    workspaceId: WorkspaceId,
    agentId: AgentId,
    execution: Partial<AgentExecution>
  ) => void
  setWorkspaceWorktreeState: (
    workspaceId: WorkspaceId,
    worktreeState: Partial<WorkspaceWorktreeState> | null
  ) => void
  setWorkspaceMemoryRelativeRoot: (workspaceId: WorkspaceId, relativeRoot: string | null) => void
  updateMemoryGraphSettings: (
    workspaceId: WorkspaceId,
    update:
      | Partial<MemoryGraphSettings>
      | ((current: MemoryGraphSettings) => Partial<MemoryGraphSettings> | MemoryGraphSettings)
  ) => void
  upsertWorktreeEntry: (workspaceId: WorkspaceId, entry: WorktreeEntry) => void
  markWorktreeMissing: (workspaceId: WorkspaceId, worktreeId: string, missingAt?: number) => void
  removeWorktreeEntry: (workspaceId: WorkspaceId, worktreeId: string) => void
  setSprintEngineState: (workspaceId: WorkspaceId, sprintEngineState: SprintEngineState | null) => void
  setSprintEngineAutomationMode: (
    workspaceId: WorkspaceId,
    mode: SprintEngineAutomationMode,
    options?: {
      suppressManualAudit?: boolean
      reason?: string
      details?: string
      // Set by the automation-mode sync subscriber when adopting an
      // authoritative main broadcast (MC-1567): no push back to main.
      suppressMainSync?: boolean
    }
  ) => void
  applySprintEngineAutomationEvent: (
    workspaceId: WorkspaceId,
    event: SprintEngineAutomationEvent
  ) => void
  setSprintEngineCliPermissionPreset: (
    workspaceId: WorkspaceId,
    cliPermissionPreset: SprintEngineCliPermissionPreset
  ) => void
  setSprintEngineMaxConcurrentAgents: (workspaceId: WorkspaceId, maxConcurrentAgents: number) => void
  upsertSprintEngineRosterSession: (
    workspaceId: WorkspaceId,
    agentId: AgentId,
    session: SprintEngineRosterSession
  ) => void
  setSprintEngineCompletionTeardownAt: (workspaceId: WorkspaceId, at: number | undefined) => void
  markSprintEngineAgentNotificationDelivered: (workspaceId: WorkspaceId, eventKey: string) => void
  addSprintEngineMember: (
    workspaceId: WorkspaceId,
    role: SprintEngineRoleId
  ) => { id: AgentId; label: string } | null
  consumeSprintEngineInitialSpawns: (workspaceId: WorkspaceId, agentIds?: AgentId[]) => AgentId[]
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

const workspacesSliceDeps: WorkspacesSliceDependencies = {
  defaultAgent,
  defaultEditorState,
  defaultWorkspaceMemoryConfig,
  defaultWorkspaceWorktreeState,
  normalizeAgentState,
  normalizeWorkspaceWorktreeState,
  normalizeSprintEngineWorkspaceContext,
  normalizeSprintEngineAutoState,
  normalizeSprintEngineRoleCliDefaults,
  sprintEngineTabsLayoutModel,
  hideNavRailTabStrip,
  migrateSprintEngineLayout,
  pickWorkspaceAgentName,
  isPathOrChild,
}

// Module-level hydration context: getItem populates it during async hydrate;
// onRehydrateStorage reads it once after the store finishes hydrating and emits
// a single structured diagnostic log entry so persistence failures and recoveries
// are observable instead of silent.
type HydrationContext = {
  storageSource: HydrationStorageSource
  classification: PersistedStateClassification
  persistedWorkspaceCount: number
  parseError?: string
  recoveryError?: string
}

const hydrationContext: HydrationContext = {
  storageSource: 'fresh',
  classification: 'dangerous_empty_missing_storage',
  persistedWorkspaceCount: 0,
}

function getPersistedWorkspaceCount(raw: string | null): number {
  if (!raw) return 0
  try {
    const envelope = JSON.parse(raw) as { state?: { workspaces?: unknown } }
    const workspaces = envelope?.state?.workspaces
    return Array.isArray(workspaces) ? workspaces.length : 0
  } catch {
    return 0
  }
}

const BACKUP_WRITE_DEBOUNCE_MS = 250
let backupWriteTimer: ReturnType<typeof setTimeout> | null = null
let pendingBackupValue: { registry: string; settings: string } | null = null

function scheduleBackupWrite(
  serializedRegistryEnvelope: string,
  serializedSettingsEnvelope: string,
): void {
  if (typeof window === 'undefined') return
  const api = window.api
  if (!api || typeof api.workspaceBackupWrite !== 'function') return

  pendingBackupValue = {
    registry: serializedRegistryEnvelope,
    settings: serializedSettingsEnvelope,
  }
  if (backupWriteTimer) clearTimeout(backupWriteTimer)
  backupWriteTimer = setTimeout(() => {
    backupWriteTimer = null
    const value = pendingBackupValue
    pendingBackupValue = null
    if (value === null) return
    void api
      .workspaceBackupWrite({
        version: WORKSPACE_STORE_VERSION,
        writtenAt: new Date().toISOString(),
        data: value,
      })
      .catch((error: unknown) => {
        console.warn('[workspaceStore] backup write failed', {
          message: error instanceof Error ? error.message : 'unknown',
        })
      })
  }, BACKUP_WRITE_DEBOUNCE_MS)
}

// Two-key split persistence (T23). The custom storage adapter is the only
// place workspace-registry and app-settings keys are read/written, so non-
// workspace state changes physically cannot serialize the workspace registry:
//   setItem extracts registry fields → writes multicode-workspaces ONLY when
//                                      those fields changed (dedup)
//   setItem extracts settings fields → writes multicode-app-settings ONLY
//                                      when those fields changed (dedup)
// A setSidebarCollapsed call ends up in the dedup'd settings write; the
// workspace-registry key is untouched, so it cannot be wiped by construction.

type RegistryEnvelopeState = {
  workspaces: unknown
  activeWorkspaceId: unknown
  workspaceWindows: unknown
  primaryWorkspaceWindowId: unknown
  workspaceRegistryEmptyState: unknown
}

// The retired Sprint Engines aside's persisted keys (sprintEnginesAsideOpen /
// sprintsAsideWidth / sprintsAsideView, MC-1766). They are absent from this
// envelope, so they stop being written; an old profile's copies survive in the
// stored blob but no state field reads them, and the column they described is
// unclaimed. Nothing to migrate — there is no reachable way to reopen it.
type SettingsEnvelopeState = {
  appSettings: unknown
  sidebarCollapsed: unknown
  chatListView: unknown
  sidebarWidth: unknown
  workspacePaneWidth: unknown
  openFilesInExternalWindow: unknown
  diffOpensInWindow: unknown
  diffView: unknown
  checkCliVersions: unknown
}

let lastWrittenSettingsSerialized: string | null = null
let suppressNextPersistWrite = false

function preserveAgentTerminalMetadata(incomingWorkspace: Workspace, currentWorkspace: Workspace | undefined): Workspace {
  if (!currentWorkspace) return incomingWorkspace
  let changed = false
  const nextAgents = { ...incomingWorkspace.agents }
  for (const [agentId, currentAgent] of Object.entries(currentWorkspace.agents)) {
    if (
      !currentAgent.cliStartRequested
      && !currentAgent.cliHasLaunched
      && !currentAgent.cliSessionId
      && !currentAgent.cliResumeAvailable
      && !currentAgent.cliOnboardingPromptSent
    ) continue
    const incomingAgent = nextAgents[agentId] ?? defaultAgent(agentId)
    nextAgents[agentId] = {
      ...incomingAgent,
      cliSessionId: currentAgent.cliSessionId,
      cliStartRequested: currentAgent.cliStartRequested,
      cliHasLaunched: currentAgent.cliHasLaunched,
      cliOnboardingPromptSent: currentAgent.cliOnboardingPromptSent,
      cliResumeAvailable: currentAgent.cliResumeAvailable,
      cliUsesStableSessionId: currentAgent.cliUsesStableSessionId,
      cli: currentAgent.cli ?? incomingAgent.cli,
    }
    changed = true
  }
  return changed ? { ...incomingWorkspace, agents: nextAgents } : incomingWorkspace
}

function extractRegistryFields(state: Record<string, unknown>): RegistryEnvelopeState {
  return {
    workspaces: state.workspaces,
    activeWorkspaceId: state.activeWorkspaceId,
    workspaceWindows: state.workspaceWindows,
    primaryWorkspaceWindowId: state.primaryWorkspaceWindowId,
    workspaceRegistryEmptyState: state.workspaceRegistryEmptyState,
  }
}

// The persist `partialize` normalizes the registry portion before it reaches
// `setItem` — it strips workspace file content and in-memory agent buffers and
// re-derives window membership. Any code that advances the registry dedup
// baseline (`lastWrittenRegistrySerialized`) without going through a real
// persist write must serialize this SAME normalized shape, otherwise a later
// unrelated `setItem` sees a phantom registry diff and writes the registry.
// This is the single source of that normalized shape, shared by `partialize`
// and the imported-event no-echo baseline advance.
type RegistryFields = Pick<
  WorkspaceStore,
  'workspaces' | 'activeWorkspaceId' | 'workspaceWindows' | 'primaryWorkspaceWindowId' | 'workspaceRegistryEmptyState'
>

function partializeRegistryFields(state: RegistryFields): RegistryFields {
  return {
    workspaces: state.workspaces.map(normalizeWorkspaceForPartialize),
    activeWorkspaceId: state.activeWorkspaceId,
    workspaceWindows: normalizeWorkspaceWindows(
      state.workspaces,
      state.workspaceWindows,
      state.primaryWorkspaceWindowId,
      state.activeWorkspaceId,
    ).windows,
    primaryWorkspaceWindowId: state.primaryWorkspaceWindowId,
    workspaceRegistryEmptyState: state.workspaceRegistryEmptyState,
  }
}

/**
 * Every field the settings envelope carries, and therefore the ONLY keys a
 * settings blob read back off disk may put into the store.
 *
 * Exported because an aux window merges that blob before writing its own field
 * (`auxWindows/auxSettingsWrite.ts`), and "the key holds settings and nothing
 * else" is an assumption about a file on disk rather than a fact about this
 * process. Named here so the allowlist and the writer cannot drift apart.
 */
export const SETTINGS_ENVELOPE_FIELDS = [
  'appSettings',
  'sidebarCollapsed',
  'chatListView',
  'sidebarWidth',
  'workspacePaneWidth',
  'openFilesInExternalWindow',
  'diffOpensInWindow',
  'diffView',
  'checkCliVersions',
] as const

function extractSettingsFields(state: Record<string, unknown>): SettingsEnvelopeState {
  const fields: Record<string, unknown> = {}
  for (const key of SETTINGS_ENVELOPE_FIELDS) fields[key] = state[key]
  return fields as SettingsEnvelopeState
}

function partializeWorkspaceStoreState(s: WorkspaceStore): ReturnType<typeof partializeRegistryFields> & SettingsEnvelopeState {
  // s.workspaceRegistryEmptyState is the explicit intent record set by
  // workspacesSlice.removeWorkspace when the splice leaves workspaces=[]
  // and cleared by addWorkspace + importWorkspace. Its presence proves
  // user intent; its absence with workspaces=[] proves a dangerous
  // startup-write/wipe attempt.
  if (s.workspaces.length === 0 && s.workspaceRegistryEmptyState == null) {
    // Read the on-disk registry directly (not the legacy
    // nonEmptyPersistedWorkspaceState helper) so we retain the last
    // persisted registry even though the settings key may also exist.
    const registry = readWorkspaceRegistryKey()
    const retainedWorkspaces = Array.isArray(registry.envelope?.state?.workspaces)
      ? (registry.envelope!.state.workspaces as Workspace[])
      : []
    if (retainedWorkspaces.length > 0) {
      const retainedActiveId = (registry.envelope!.state.activeWorkspaceId as WorkspaceId | null | undefined) ?? null
      const classification = classifyPersistedWorkspaceState({
        rawLocalStorage: registry.raw,
      })
      console.warn('[workspaceStore] blocked empty workspace snapshot from overwriting persisted workspaces', {
        retainedWorkspaceCount: retainedWorkspaces.length,
        retainedActiveWorkspaceId: retainedActiveId,
        persistedClassification: classification,
        dangerous: isDangerousEmptyClassification(classification),
      })
      return {
        appSettings: s.appSettings,
        sidebarCollapsed: s.sidebarCollapsed,
        chatListView: s.chatListView,
        sidebarWidth: s.sidebarWidth,
        workspacePaneWidth: s.workspacePaneWidth,
        openFilesInExternalWindow: s.openFilesInExternalWindow,
        diffOpensInWindow: s.diffOpensInWindow,
        diffView: s.diffView,
        checkCliVersions: s.checkCliVersions,
        workspaces: retainedWorkspaces,
        activeWorkspaceId: retainedActiveId ?? retainedWorkspaces[0]?.id ?? s.activeWorkspaceId,
        workspaceWindows: normalizeWorkspaceWindows(
          retainedWorkspaces,
          registry.envelope!.state.workspaceWindows as WorkspaceWindowState[] | undefined,
          registry.envelope!.state.primaryWorkspaceWindowId as WorkspaceWindowId | undefined,
          retainedActiveId ?? retainedWorkspaces[0]?.id ?? s.activeWorkspaceId,
        ).windows,
        primaryWorkspaceWindowId:
          (registry.envelope!.state.primaryWorkspaceWindowId as WorkspaceWindowId | undefined)
          ?? PRIMARY_WORKSPACE_WINDOW_ID,
        workspaceRegistryEmptyState: null,
      }
    }
  }

  return {
    appSettings: s.appSettings,
    sidebarCollapsed: s.sidebarCollapsed,
    chatListView: s.chatListView,
    sidebarWidth: s.sidebarWidth,
    workspacePaneWidth: s.workspacePaneWidth,
    openFilesInExternalWindow: s.openFilesInExternalWindow,
    diffOpensInWindow: s.diffOpensInWindow,
    diffView: s.diffView,
    checkCliVersions: s.checkCliVersions,
    ...partializeRegistryFields(s),
  }
}

export function __workspaceStorePartializeForTests(s: WorkspaceStore): ReturnType<typeof partializeWorkspaceStoreState> {
  return partializeWorkspaceStoreState(s)
}

function readWorkspaceRegistryKey(): { raw: string | null; envelope: { state: RegistryEnvelopeState; version: number } | null } {
  if (typeof window === 'undefined') return { raw: null, envelope: null }
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY)
  } catch (error) {
    hydrationContext.parseError = error instanceof Error ? error.message : 'localStorage_read_failed'
    return { raw: null, envelope: null }
  }
  if (!raw) return { raw, envelope: null }
  try {
    const parsed = JSON.parse(raw) as { state?: RegistryEnvelopeState; version?: number }
    if (!parsed?.state) return { raw, envelope: null }
    return { raw, envelope: { state: parsed.state, version: parsed.version ?? 0 } }
  } catch {
    return { raw, envelope: null }
  }
}

function readSettingsKey(): { raw: string | null; envelope: { state: SettingsEnvelopeState; version: number } | null } {
  if (typeof window === 'undefined') return { raw: null, envelope: null }
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY)
  } catch {
    return { raw: null, envelope: null }
  }
  if (!raw) return { raw, envelope: null }
  try {
    const parsed = JSON.parse(raw) as { state?: SettingsEnvelopeState; version?: number }
    if (!parsed?.state) return { raw, envelope: null }
    return { raw, envelope: { state: parsed.state, version: parsed.version ?? 0 } }
  } catch {
    return { raw, envelope: null }
  }
}

type BackupEnvelopePair = {
  registry: string
  settings: string | null
}

function serializeBackupEnvelopeValue(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value === undefined) return null
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function coerceBackupEnvelopePair(data: unknown): BackupEnvelopePair | null {
  if (typeof data === 'string') {
    return { registry: data, settings: null }
  }

  if (data && typeof data === 'object') {
    const split = data as { registry?: unknown; settings?: unknown }
    if ('registry' in split) {
      const registry = serializeBackupEnvelopeValue(split.registry)
      if (!registry) return null
      return {
        registry,
        settings: serializeBackupEnvelopeValue(split.settings),
      }
    }
  }

  const registry = serializeBackupEnvelopeValue(data)
  return registry ? { registry, settings: null } : null
}

function parseSettingsEnvelopeState(raw: string | null): SettingsEnvelopeState | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { state?: SettingsEnvelopeState }
    return parsed?.state ?? null
  } catch {
    return null
  }
}

const workspaceStateStorage: StateStorage = {
  getItem: (_name: string): string | null => {
    if (typeof window === 'undefined') {
      hydrationContext.storageSource = 'fresh'
      hydrationContext.classification = 'dangerous_empty_missing_storage'
      hydrationContext.persistedWorkspaceCount = 0
      return null
    }

    // Cold-load: try registry key first. If it's a legacy v44 envelope (single
    // key holding both registry + settings), split it on the fly and write the
    // settings half to APP_SETTINGS_STORAGE_KEY so subsequent writes use the
    // new shape. The persist middleware's migrate ladder still upgrades the
    // workspace fields through version 45.
    const registry = readWorkspaceRegistryKey()
    let registryState = registry.envelope?.state ?? null
    let registryVersion = registry.envelope?.version ?? 0
    let legacyExtractedSettings: SettingsEnvelopeState | null = null

    if (registry.raw && isLegacyV44WorkspaceEnvelope(registry.raw)) {
      const split = splitLegacyV44Envelope(registry.raw)
      if (split) {
        registryState = {
          workspaces: split.registry.state.workspaces,
          activeWorkspaceId: split.registry.state.activeWorkspaceId,
          workspaceWindows: undefined,
          primaryWorkspaceWindowId: undefined,
          workspaceRegistryEmptyState: null,
        }
        registryVersion = split.registry.version
        if (split.extractedSettings) {
          legacyExtractedSettings = split.extractedSettings as SettingsEnvelopeState
          try {
            window.localStorage.setItem(
              APP_SETTINGS_STORAGE_KEY,
              JSON.stringify({ state: split.extractedSettings, version: registryVersion }),
            )
          } catch {
            // Best-effort; settings fields are still merged below in memory.
          }
        }
      }
    }

    const classification = classifyPersistedWorkspaceState({ rawLocalStorage: registry.raw })
    hydrationContext.classification = classification
    hydrationContext.persistedWorkspaceCount = getPersistedWorkspaceCount(registry.raw)

    if (classification === 'present') {
      hydrationContext.storageSource = 'localStorage'
    } else {
      // Dangerous empty hydrations leave storageSource as 'fresh' here; the
      // post-hydrate recovery kickoff may upgrade it to 'backup' before the
      // canonical diagnostic emits.
      hydrationContext.storageSource = 'fresh'
    }

    // Merge registry + settings into the single envelope zustand expects.
    const settings = readSettingsKey()
    const settingsState = legacyExtractedSettings ?? settings.envelope?.state ?? null
    const mergedState: Record<string, unknown> = {
      ...(registryState ?? {}),
      ...(settingsState ?? {}),
    }
    // If everything is absent we treat this as a true cold-start. Zustand will
    // create the store from defaults; partialize will not write until a real
    // mutation happens.
    if (!registryState && !settingsState) return null

    const version = Math.max(registryVersion, settings.envelope?.version ?? 0)
    // Seed the settings dedup baseline so the first post-hydrate setItem can
    // decide whether to re-serialize that key. The registry key has no baseline
    // any more: it is frozen and never written again.
    lastWrittenSettingsSerialized = JSON.stringify(extractSettingsFields(mergedState))
    return JSON.stringify({ state: mergedState, version })
  },

  setItem: (_name: string, value: string): void => {
    if (typeof window === 'undefined') return
    if (suppressNextPersistWrite) return
    let envelope: { state?: Record<string, unknown>; version?: number } | null = null
    try {
      envelope = JSON.parse(value) as { state?: Record<string, unknown>; version?: number }
    } catch (error) {
      console.warn('[workspaceStore] persist envelope parse failed', {
        message: error instanceof Error ? error.message : 'unknown',
      })
      return
    }
    if (!envelope?.state) return
    const version = envelope.version ?? WORKSPACE_STORE_VERSION
    const fullState = envelope.state

    // The registry key is FROZEN, not deleted (MC-2158). Main owns the workspace
    // registry now, so the renderer stops writing this key and leaves the last
    // written value in place for one release as the rollback artifact; the
    // release after this deletes it, in its own commit.
    //
    // The stated trade: a user who downgrades after one release loses workspace
    // changes made during it. Dual-writing the key instead would be exactly the
    // dual authority this move exists to end — and a stale dual-write is worse
    // than a clean frozen snapshot, because it would silently lose the NEWER
    // state on the way back up.
    const registryFields = extractRegistryFields(fullState)
    const registryEnvelopeSerialized = JSON.stringify({ state: registryFields, version })

    // Settings key — also dedup'd. Workspace registry mutations that don't
    // touch settings produce identical settings payloads here, so the
    // settings key is left alone.
    const settingsFields = extractSettingsFields(fullState)
    const settingsSerialized = JSON.stringify(settingsFields)
    const settingsEnvelopeSerialized = JSON.stringify({ state: settingsFields, version })
    if (settingsSerialized !== lastWrittenSettingsSerialized) {
      try {
        window.localStorage.setItem(
          APP_SETTINGS_STORAGE_KEY,
          settingsEnvelopeSerialized,
        )
      } catch (error) {
        console.warn('[workspaceStore] localStorage settings write failed', {
          message: error instanceof Error ? error.message : 'unknown',
        })
      }
      lastWrittenSettingsSerialized = settingsSerialized
    }
    // Backup mirror only when the registry has actual workspaces — the
    // intentional empty case (registryFields.workspaces=[],
    // workspaceRegistryEmptyState non-null) is honored locally but not
    // promoted to the userData backup, because backup is the last-known-
    // good non-empty mirror and stays out of intent decisions (AC4).
    //
    // The backup includes both split envelopes so recovery does not restore
    // workspaces while silently dropping app settings such as Knowledge Graph
    // roots, CLI defaults, MCP, skill packs, or sidebar state.
    if (Array.isArray(registryFields.workspaces) && registryFields.workspaces.length > 0) {
      scheduleBackupWrite(registryEnvelopeSerialized, settingsEnvelopeSerialized)
    }
  },

  removeItem: (_name: string): void => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.removeItem(WORKSPACE_STORAGE_KEY)
      window.localStorage.removeItem(APP_SETTINGS_STORAGE_KEY)
    } catch {
      // Removal is best-effort.
    }
    lastWrittenSettingsSerialized = null
  },
}

// Run after the synchronous hydrate completes. For non-dangerous classifications
// this is a no-op that immediately emits the canonical hydration diagnostic. For
// dangerous classifications it reads the userData backup over IPC, validates
// that the backup classifies as `present`, and replays the recovered envelope
// into the store before emitting the final diagnostic. Either way exactly one
// `[workspaceStore] hydration` log entry fires per cold load, and it reflects
// the final storageSource (`localStorage`, `backup`, or `fresh`) plus any
// parse/recovery error.
async function attemptBackupRecovery(): Promise<void> {
  if (typeof window === 'undefined') {
    emitHydrationDiagnostic()
    return
  }

  // Re-read and re-classify from the current localStorage. The recovery
  // function is module-load-once in production, but tests rebind the storage
  // mock between cases and call it again; trusting the previous hydration
  // context would carry stale values into the new scenario.
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY)
  } catch (error) {
    hydrationContext.parseError = error instanceof Error ? error.message : 'localStorage_read_failed'
  }
  hydrationContext.classification = classifyPersistedWorkspaceState({ rawLocalStorage: raw })
  hydrationContext.persistedWorkspaceCount = getPersistedWorkspaceCount(raw)
  hydrationContext.storageSource = hydrationContext.classification === 'present' ? 'localStorage' : 'fresh'
  hydrationContext.recoveryError = undefined

  if (!isDangerousEmptyClassification(hydrationContext.classification)) {
    emitHydrationDiagnostic()
    return
  }

  // Honor the in-memory or on-disk intent record: if the user explicitly
  // removed all workspaces, do not overwrite that decision with a stale
  // backup payload. AC6: distinguish intentional user_removed_all from
  // hydration failure / unknown wipe.
  const currentIntent = useWorkspaceStore.getState().workspaceRegistryEmptyState
  let persistedIntent: WorkspaceRegistryEmptyState | null = null
  try {
    const parsedRegistry = raw ? (JSON.parse(raw) as { state?: { workspaceRegistryEmptyState?: WorkspaceRegistryEmptyState | null } }) : null
    persistedIntent = parsedRegistry?.state?.workspaceRegistryEmptyState ?? null
  } catch {
    persistedIntent = null
  }
  if (currentIntent != null || persistedIntent != null) {
    emitHydrationDiagnostic()
    return
  }
  if (typeof window.api?.workspaceBackupRead !== 'function') {
    emitHydrationDiagnostic()
    return
  }

  try {
    const result = await window.api.workspaceBackupRead()
    if (!result.ok) {
      if (result.reason !== 'missing') {
        hydrationContext.recoveryError = `${result.reason}${result.message ? `:${result.message}` : ''}`
      }
      emitHydrationDiagnostic()
      return
    }

    // The backup IPC is async. A user can create a workspace while recovery is
    // in flight; if that happens, the new non-empty registry is the fresher
    // source of truth and must not be replaced by an older backup snapshot.
    let latestRaw: string | null = null
    try {
      latestRaw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY)
    } catch {
      latestRaw = null
    }
    const latestClassification = classifyPersistedWorkspaceState({ rawLocalStorage: latestRaw })
    const latestWorkspaceCount = getPersistedWorkspaceCount(latestRaw)
    const latestIntent = useWorkspaceStore.getState().workspaceRegistryEmptyState
    if (
      useWorkspaceStore.getState().workspaces.length > 0
      || latestWorkspaceCount > 0
      || !isDangerousEmptyClassification(latestClassification)
      || latestIntent != null
    ) {
      hydrationContext.classification = latestClassification
      hydrationContext.persistedWorkspaceCount = latestWorkspaceCount
      hydrationContext.storageSource = latestClassification === 'present' ? 'localStorage' : 'fresh'
      emitHydrationDiagnostic()
      return
    }

    const recoveredBackup = coerceBackupEnvelopePair(result.payload.data)
    if (!recoveredBackup) {
      hydrationContext.recoveryError = 'backup_payload_unserializable'
      emitHydrationDiagnostic()
      return
    }
    const recovered = recoveredBackup.registry
    const recoveredClassification = classifyPersistedWorkspaceState({ rawLocalStorage: recovered })
    if (recoveredClassification !== 'present') {
      // Backup exists but does not classify as a recoverable workspace list.
      // This is expected after an intentional valid-empty persist write: the
      // previous session ended with workspaces=[], so the backup mirrors that
      // and we honor the user's intent by not recovering. Not an error.
      emitHydrationDiagnostic()
      return
    }

    let envelope: { state?: Partial<WorkspaceMigrationState> } | null = null
    try {
      envelope = JSON.parse(recovered) as { state?: Partial<WorkspaceMigrationState> }
    } catch (error) {
      hydrationContext.recoveryError = error instanceof Error ? error.message : 'recovery_parse_error'
      emitHydrationDiagnostic()
      return
    }
    if (!envelope?.state || !Array.isArray(envelope.state.workspaces)) {
      emitHydrationDiagnostic()
      return
    }

    // Automations is a global screen now, not a workspace type (store v62). This
    // backup-recovery path bypasses the migrate ladder, so apply the same drop
    // here — both in memory and in the write-back below — so we never re-persist
    // a retired automations workspace. If dropping it empties the list there is
    // nothing to recover, so honor the clean empty state.
    envelope.state.workspaces = envelope.state.workspaces.filter(
      (workspace) => (workspace as { mode?: string }).mode !== 'automations',
    )
    // Roadmap (store v65) and Multiloop (store v66) are retired workspace modes.
    // This backup-recovery path bypasses the migrate ladder too, so run the same
    // retired-mode filter here before we re-persist.
    envelope.state.workspaces = dropRetiredModeWorkspaces(
      envelope.state.workspaces as Workspace[],
    )
    // Same bypass applies to the one-host-per-project invariant (store v64):
    // a recovered backup can carry one Automations host per automation run,
    // and once recovery writes it back the state is stamped current-version so
    // the migrate ladder never sees it again. Dedupe before adopting.
    envelope.state.workspaces = dedupeAutomationsHostWorkspaces(
      envelope.state.workspaces as Workspace[],
    )
    // Same migrate-ladder bypass for the MC-1573 module-state bag: reconcile
    // the bag with the legacy sprintEngineState mirror before re-persisting.
    envelope.state.workspaces = (envelope.state.workspaces as Workspace[])
      .map(reconcileWorkspaceModuleState)
      .map(healRetiredRailLayout)
    if (envelope.state.workspaces.length === 0) {
      emitHydrationDiagnostic()
      return
    }

    // App-settings salvage. New backups carry the split settings envelope
    // beside the registry envelope. Older T22-era backups may carry
    // appSettings/sidebarCollapsed inside the recovered registry envelope.
    // In both cases, recovery must not bring the workspace list back while
    // silently dropping Knowledge Graph roots, CLI defaults, MCP, skill packs,
    // or sidebar state.
    const legacyState = envelope!.state as Partial<WorkspaceMigrationState> & {
      sidebarCollapsed?: boolean
    }
    const legacyAppSettings = legacyState.appSettings
    const legacySidebarCollapsed = legacyState.sidebarCollapsed
    const recoveredSettingsState = parseSettingsEnvelopeState(recoveredBackup.settings)

    try {
      // Write back the filtered envelope (automations workspaces already
      // dropped above), never the raw backup, so the on-disk registry matches
      // the recovered in-memory state.
      window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(envelope))
      if (recoveredBackup.settings && recoveredSettingsState) {
        window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, recoveredBackup.settings)
      }
    } catch {
      // Best-effort write-back; the in-memory recovery still proceeds.
    }
    hydrationContext.storageSource = 'backup'
    hydrationContext.persistedWorkspaceCount = envelope.state.workspaces.length

    useWorkspaceStore.setState((current) => {
      const recoveredWorkspaces = envelope!.state!.workspaces as WorkspaceStore['workspaces']
      const recoveredAppSettings =
        legacyAppSettings !== undefined
          ? normalizeAppSettings(legacyAppSettings, recoveredWorkspaces as Workspace[])
          : recoveredSettingsState?.appSettings !== undefined
            ? normalizeAppSettings(
              recoveredSettingsState.appSettings as Partial<AppSettings>,
              recoveredWorkspaces as Workspace[],
            )
            : normalizeAppSettings(current.appSettings, recoveredWorkspaces as Workspace[])
      const hydrated = hydrateSprintEngineLocalRunSettings(
        recoveredWorkspaces as Workspace[],
        recoveredAppSettings,
      )
      const normalizedWindows = normalizeWorkspaceWindows(
        hydrated.workspaces,
        envelope!.state!.workspaceWindows,
        envelope!.state!.primaryWorkspaceWindowId,
        envelope!.state!.activeWorkspaceId ?? current.activeWorkspaceId,
      )
      // Don't let the recovered active pointer dangle at a dropped automations
      // workspace; fall back to the first surviving (filtered) workspace.
      const recoveredActiveId =
        envelope!.state!.activeWorkspaceId
        && hydrated.workspaces.some((workspace) => workspace.id === envelope!.state!.activeWorkspaceId)
          ? envelope!.state!.activeWorkspaceId
          : hydrated.workspaces[0]?.id ?? current.activeWorkspaceId
      const next: WorkspaceStore = {
        ...current,
        workspaces: hydrated.workspaces,
        activeWorkspaceId: recoveredActiveId,
        workspaceWindows: normalizedWindows.windows,
        primaryWorkspaceWindowId: normalizedWindows.primaryWorkspaceWindowId,
        workspaceRegistryEmptyState: null,
        appSettings: hydrated.appSettings,
      }
      if (typeof legacySidebarCollapsed === 'boolean') {
        next.sidebarCollapsed = legacySidebarCollapsed
      } else if (typeof recoveredSettingsState?.sidebarCollapsed === 'boolean') {
        next.sidebarCollapsed = recoveredSettingsState.sidebarCollapsed
      }
      return next
    })

    // Mirror the recovered app-settings to multicode-app-settings now so the
    // next persist write doesn't clobber projectKnowledgeRoots /
    // recentWorkspaceFolders with the current empty state.
    if (
      legacyAppSettings !== undefined
      || typeof legacySidebarCollapsed === 'boolean'
      || recoveredSettingsState !== null
    ) {
      try {
        const next = useWorkspaceStore.getState()
        window.localStorage.setItem(
          APP_SETTINGS_STORAGE_KEY,
          JSON.stringify({
            state: {
              appSettings: next.appSettings,
              sidebarCollapsed: next.sidebarCollapsed,
            },
            version: WORKSPACE_STORE_VERSION,
          }),
        )
      } catch {
        // Best-effort write-back; in-memory state still carries the salvage.
      }
    }
  } catch (error) {
    hydrationContext.recoveryError = error instanceof Error ? error.message : 'unknown_recovery_error'
  }

  emitHydrationDiagnostic()
}

function emitHydrationDiagnostic(): void {
  const hydratedWorkspaceCount = useWorkspaceStore.getState().workspaces.length
  const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId ?? null
  const diagnostic: HydrationDiagnostic = {
    persistedWorkspaceCount: hydrationContext.persistedWorkspaceCount,
    hydratedWorkspaceCount,
    activeWorkspaceId,
    storageSource: hydrationContext.storageSource,
    classification: hydrationContext.classification,
    ...(hydrationContext.parseError ? { parseError: hydrationContext.parseError } : {}),
    ...(hydrationContext.recoveryError ? { recoveryError: hydrationContext.recoveryError } : {}),
  }
  console.info('[workspaceStore] hydration', diagnostic)
}

export const useWorkspaceStore = create<WorkspaceStore>()(
  persist(
    immer((set, get) => ({
      ...createAuthSlice(set),
      ...createSettingsSlice(set),
      ...createLayoutSlice(set),
      ...createAgentsSlice(set),
      ...createRunStateSlice(set),
      ...createWorktreesSlice(set),
      ...createMemorySlice(set),
      ...createPluginsSlice(set),
      ...createCliAvailabilitySlice(set),
      ...createHostedModelFeedSlice(set),
      ...createHostedCardFeedSlice(set),
      ...createCliVersionAdvisorySlice(set),
      ...createWorkspacePaneSlice(set),
      ...createFocusedAgentSlice(set),
      ...createWorkspacesSlice(set, workspacesSliceDeps, get),
    })),
    {
      name: WORKSPACE_STORAGE_KEY,
      version: WORKSPACE_STORE_VERSION,
      storage: createJSONStorage(() => workspaceStateStorage),
      migrate: (persisted: unknown, version: number) => {
        try {
          return migratePersistedWorkspaceState(persisted, version)
        } catch (error) {
          hydrationContext.parseError = error instanceof Error ? error.message : 'migration_failed'
          throw error
        }
      },
      merge: (persisted, current) => {
        const state = persisted as Partial<WorkspaceMigrationState & { sidebarCollapsed?: boolean; chatListView?: string; sidebarWidth?: number; workspacePaneWidth?: number }> | undefined
        // Version-gated migrations cannot be the only enforcement of these
        // workspace-row invariants: a dev-HMR module swap (or any write path that
        // stamps WORKSPACE_STORE_VERSION onto un-migrated state) leaves the
        // un-migrated rows — duplicate Automations hosts, or a workspace in a
        // mode whose feature was retired (store v65, v66) — in a
        // "current-version" envelope the migrate ladder will never look at again,
        // exactly how the v63 dedupe was bypassed in the wild. merge() runs on
        // every hydration regardless of version, so the invariants self-heal here.
        const rawWorkspaces = nameGenericWorkspaceAgents(
          dropRetiredModeWorkspaces(
            dedupeAutomationsHostWorkspaces(state?.workspaces ?? current.workspaces),
          ),
        // The MC-1573 lockstep invariant (moduleState.sprintengine === the
        // legacy sprintEngineState mirror) is enforced here, not only in the
        // v71 migration rung, for the same reason as the heals above: merge()
        // runs on every hydration regardless of envelope version. Persisted
        // rows carry a null run state (partialize strips both homes), so this
        // is a reference-preserving no-op on the normal load path.
        ).map(reconcileWorkspaceModuleState)
        // Files/Git rail tabs → pane tabs (browser-pane epic, store v73): the
        // enforcement half, for the same reason as the heals above.
        .map(healRetiredRailLayout)
        const hydrated = hydrateSprintEngineLocalRunSettings(
          rawWorkspaces,
          normalizeAppSettings(state?.appSettings, rawWorkspaces),
        )
        const workspaces = hydrated.workspaces
        const normalizedWindows = normalizeWorkspaceWindows(
          workspaces,
          state?.workspaceWindows ?? current.workspaceWindows,
          state?.primaryWorkspaceWindowId ?? current.primaryWorkspaceWindowId,
          state?.activeWorkspaceId ?? current.activeWorkspaceId,
        )

        // The persisted active pointer can reference a host the dedupe just
        // dropped; fall back to a surviving workspace instead of dangling.
        const persistedActiveWorkspaceId =
          state?.activeWorkspaceId
          && workspaces.some((workspace) => workspace.id === state.activeWorkspaceId)
            ? state.activeWorkspaceId
            : null
        return {
          ...current,
          ...(state ?? {}),
          workspaces,
          activeWorkspaceId:
            persistedActiveWorkspaceId
            ?? (state?.activeWorkspaceId ? workspaces[0]?.id ?? null : current.activeWorkspaceId),
          workspaceWindows: normalizedWindows.windows,
          primaryWorkspaceWindowId: normalizedWindows.primaryWorkspaceWindowId,
          sidebarCollapsed:
            typeof state?.sidebarCollapsed === 'boolean'
              ? state.sidebarCollapsed
              : current.sidebarCollapsed,
          // A value this build does not know (an older or newer name for a
          // rail shape) falls back to the tree rather than leaving the rail
          // in a shape nothing renders.
          chatListView:
            state?.chatListView === 'all' || state?.chatListView === 'projects'
              ? state.chatListView
              : current.chatListView,
          sidebarWidth:
            typeof state?.sidebarWidth === 'number'
              ? clampSidebarWidth(state.sidebarWidth)
              : current.sidebarWidth,
          workspacePaneWidth:
            typeof state?.workspacePaneWidth === 'number'
              ? clampWorkspaceAsideWidth(state.workspacePaneWidth)
              : current.workspacePaneWidth,
          workspaceRegistryEmptyState:
            state?.workspaceRegistryEmptyState !== undefined
              ? state.workspaceRegistryEmptyState
              : current.workspaceRegistryEmptyState,
          appSettings: hydrated.appSettings,
        }
      },
      partialize: partializeWorkspaceStoreState,
      // Hydration diagnostic emission moved to attemptBackupRecovery so the
      // single canonical entry reflects the final storageSource and any
      // recovery error. onRehydrateStorage only records sync-rehydrate parse
      // errors that arose before recovery; the diagnostic is emitted exactly
      // once when recovery completes (or is a no-op for non-dangerous states).
      onRehydrateStorage: () => (_state, error) => {
        if (error) {
          hydrationContext.parseError =
            hydrationContext.parseError
            ?? (error instanceof Error ? error.message : 'rehydrate_failed')
        }
      },
    },
  ),
)

function scheduleInitialPluginCatalogRefresh(): void {
  if (typeof window === 'undefined') return
  if (!window.api || typeof window.api.pluginsList !== 'function') return
  queueMicrotask(() => {
    const store = useWorkspaceStore.getState()
    void store.refreshPluginCatalog()
    // Detect which agent CLI binaries are actually installed so deployment
    // pickers/defaults can hide and avoid defaulting to uninstalled agents.
    if (typeof window.api?.pluginsDetectAvailability === 'function') {
      void store.refreshCliAvailability({
        cliRuntimes: store.appSettings.cliRuntimes,
      })
    }
  })
}

scheduleInitialPluginCatalogRefresh()

// Mirror module enablement to the main process so it can gate module IPC and
// sidecar spawning at the next launch. The renderer is the source of truth; the
// main cache is updated whenever the override changes (deduped). Guarded for
// non-browser bundles (node test harnesses) where window/api are absent.
function syncModuleEnablementToMain(): void {
  if (typeof window === 'undefined') return
  const api = window.api as { setModuleEnablement?: (o: Record<string, boolean>) => Promise<unknown> } | undefined
  if (!api?.setModuleEnablement) return

  let lastSerialized = ''
  const push = (overrides: Record<string, boolean>): void => {
    const serialized = JSON.stringify(overrides)
    if (serialized === lastSerialized) return
    lastSerialized = serialized
    void api.setModuleEnablement!(overrides)
  }

  push(useWorkspaceStore.getState().appSettings.modules ?? {})
  useWorkspaceStore.subscribe((state) => push(state.appSettings.modules ?? {}))
}
syncModuleEnablementToMain()

// Mirror the "Pause idle terminals after" setting (minutes → ms) to the main
// reap policy so the next idle sweep uses the user's value. Renderer is the
// source of truth; pushed on startup and on every change (deduped). Main clamps.
function syncTerminalIdleSuspendToMain(): void {
  if (typeof window === 'undefined') return
  const api = window.api as { setTerminalIdleSuspendMs?: (ms: number) => Promise<unknown> } | undefined
  if (!api?.setTerminalIdleSuspendMs) return

  let lastSent = NaN
  const push = (minutes: number): void => {
    const ms = Math.round(minutes * 60 * 1000)
    if (ms === lastSent) return
    lastSent = ms
    void api.setTerminalIdleSuspendMs!(ms)
  }

  push(useWorkspaceStore.getState().appSettings.terminalIdleSuspendMinutes)
  useWorkspaceStore.subscribe((state) => push(state.appSettings.terminalIdleSuspendMinutes))
}
syncTerminalIdleSuspendToMain()

// Mirror the "Always keep running" recency floor to the main reap policy so the
// next idle sweep never pauses below the user's N most recently used agents.
// Renderer is the source of truth; pushed on startup and on every change
// (deduped). Main clamps.
function syncTerminalKeepRecentAliveToMain(): void {
  if (typeof window === 'undefined') return
  const api = window.api as { setTerminalKeepRecentAliveCount?: (count: number) => Promise<unknown> } | undefined
  if (!api?.setTerminalKeepRecentAliveCount) return

  let lastSent = NaN
  const push = (count: number): void => {
    if (count === lastSent) return
    lastSent = count
    void api.setTerminalKeepRecentAliveCount!(count)
  }

  push(useWorkspaceStore.getState().appSettings.terminalKeepRecentAlive)
  useWorkspaceStore.subscribe((state) => push(state.appSettings.terminalKeepRecentAlive))
}
syncTerminalKeepRecentAliveToMain()

// Mirror which SprintEngine runs are ACTIVELY dispatching to main, so the idle
// reaper protects those runs' agents (owned by the claim-aware 5-min retirement)
// and only disposes agents of inactive/completed runs. Renderer owns run-active
// state; pushed on startup and on every workspace change (deduped). A run is
// active when its automation should run (mode !== manual && runtimeState running);
// completion flips runtimeState off 'running', so it drops out automatically.
function syncActiveSprintRunsToMain(): void {
  if (typeof window === 'undefined') return
  const api = window.api as { setActiveSprintRunStatePaths?: (paths: string[]) => Promise<unknown> } | undefined
  if (!api?.setActiveSprintRunStatePaths) return

  let lastSerialized = ''
  const push = (workspaces: Workspace[]): void => {
    const paths = workspaces
      .filter((ws) => ws.sprintEngineContext?.statePath && sprintEngineAutomationShouldRun(ws.sprintEngineAutoState))
      .map((ws) => ws.sprintEngineContext!.statePath)
      .sort()
    const serialized = JSON.stringify(paths)
    if (serialized === lastSerialized) return
    lastSerialized = serialized
    void api.setActiveSprintRunStatePaths!(paths)
  }

  push(useWorkspaceStore.getState().workspaces)
  useWorkspaceStore.subscribe((state) => push(state.workspaces))
}
syncActiveSprintRunsToMain()

// One-time hydration handshake (MC-2158). On the first boot after the registry
// inverted, main has no registry file and this window is the only place the
// user's workspaces exist. It offers its POST-migrate-ladder state — the value
// after zustand's `migrate` chain has run up to WORKSPACE_STORE_VERSION —
// because the ladder lives here and would never be re-run against main's file.
//
// Main decides: it seeds only when it has written nothing, so a second window
// racing this one is a no-op rather than a merge, and it REFUSES an empty offer
// that carries no explicit "the user removed everything" record. The legacy key
// is left untouched either way, so a refusal costs one boot and retries.
async function offerRegistryHydration(): Promise<void> {
  const api = window.api as {
    workspaceRegistryNeedsHydration?: () => Promise<boolean>
    workspaceRegistryHydrate?: (payload: unknown) => Promise<unknown>
  } | undefined
  if (!api?.workspaceRegistryNeedsHydration || !api.workspaceRegistryHydrate) return
  let needsHydration = false
  try {
    needsHydration = await api.workspaceRegistryNeedsHydration()
  } catch {
    return
  }
  if (!needsHydration) return
  const state = useWorkspaceStore.getState()
  const registry = readWorkspaceRegistryKey()
  try {
    await api.workspaceRegistryHydrate({
      ...partializeRegistryFields(state),
      rawLocalStorage: registry.raw,
    })
  } catch (error) {
    console.warn('[workspaceStore] workspace registry hydration offer failed', {
      message: error instanceof Error ? error.message : 'unknown',
    })
  }
}

// Adopt main's registry wholesale. This is the mirror's seed at start and its
// recovery after a sequence gap. Presentation state the renderer still owns
// (open editor files, the file-explorer/backlog/git panel view) is preserved
// per workspace: main strips those fields on write, so taking the snapshot
// verbatim would blank the panels of every workspace on every resync.
function adoptRegistrySnapshot(snapshot: import('../../../shared/workspace-sync').WorkspaceSyncSnapshot): void {
  // An empty registry never replaces a non-empty window. This is the same wipe
  // guard the localStorage path has carried since an empty snapshot overwrote a
  // real profile once, moved to the seam where the hazard now lives: on the
  // first boot the hydration offer and this seed race, and a corrupt registry
  // file reads as empty on purpose. Either way, blanking every open workspace
  // is never the right answer — main re-seeds from this window instead.
  if (snapshot.state.workspaces.length === 0 && useWorkspaceStore.getState().workspaces.length > 0) {
    console.warn('[workspaceStore] ignored an empty registry snapshot over a non-empty window', {
      localWorkspaceCount: useWorkspaceStore.getState().workspaces.length,
      snapshotSequence: snapshot.sequence,
    })
    return
  }
  // Layouts main still holds in their rail form (Files/Git docked): healed on
  // the way in, and written back once so the heal converges instead of
  // re-running on every snapshot.
  const healedLayouts: { id: WorkspaceId; layoutModel: Workspace['layoutModel'] }[] = []
  useWorkspaceStore.setState((current) => {
    const currentById = new Map(current.workspaces.map((workspace) => [workspace.id, workspace] as const))
    const workspaces = snapshot.state.workspaces.map((raw) => {
      // Main's copy of a layout can still dock Files/Git in the rail until a
      // window's next layout write; heal it here as merge() does.
      const incoming = healRetiredRailLayout(raw)
      if (incoming.layoutModel !== raw.layoutModel) {
        healedLayouts.push({ id: incoming.id, layoutModel: incoming.layoutModel })
      }
      const existing = currentById.get(incoming.id)
      if (!existing) return incoming
      return keepLaterWorkspaceClocks(existing, {
        ...incoming,
        editorState: existing.editorState,
        fileExplorerState: existing.fileExplorerState,
        backlogState: existing.backlogState,
        gitPanelState: existing.gitPanelState,
        // The pane record is window-owned view state like the three above:
        // main never carries it, so a snapshot must not blank it. Main's
        // layout can still dock the Backlog rail (store v74) while this
        // window already has a pane: the heal above seeded a pane from the
        // raw layout that the existing record would now discard, so adopt
        // the rail into the record we keep instead.
        paneState: existing.paneState
          ? adoptLegacyBacklogTab(raw.layoutModel, existing.paneState)
          : incoming.paneState,
        // Live-only fields main never persists: the projection cache the
        // supervisor re-reads from disk, and in-flight terminal metadata for
        // agents this window owns.
        sprintEngineState: existing.sprintEngineState,
        agents: preserveAgentTerminalMetadata(incoming, existing).agents,
      })
    })
    return {
      ...current,
      workspaces,
      activeWorkspaceId: snapshot.state.activeWorkspaceId ?? current.activeWorkspaceId,
      workspaceWindows: snapshot.state.workspaceWindows,
      primaryWorkspaceWindowId: snapshot.state.primaryWorkspaceWindowId,
      workspaceRegistryEmptyState: workspaces.length === 0 ? current.workspaceRegistryEmptyState : null,
    }
  })
  for (const healed of healedLayouts) {
    void workspaceSyncClient.dispatchUpdateWorkspaceLayout(healed.id, healed.layoutModel)
  }
}

// Wire the main-mediated workspace sync bus. The client asks main for every
// registry mutation and applies the accepted/broadcast events to this window's
// mirror. Main is the authority: an apply is not a local decision being
// recorded, it is main's decision being adopted.
function initWorkspaceSyncClient(): void {
  if (typeof window === 'undefined') return
  // Applying an imported (accepted or broadcast) event must not re-emit a
  // command — the no-echo contract. It no longer needs the persist-suppression
  // and dedup-baseline plumbing it used to: with the registry out of
  // localStorage, an apply cannot trigger a registry write, and there is no
  // storage listener left to echo it back.
  const applyImportedSyncEvent = (apply: () => void): void => {
    apply()
  }
  const patchWorkspace = (workspaceId: WorkspaceId, patch: (workspace: Workspace) => Workspace): void => {
    useWorkspaceStore.setState((current) => ({
      ...current,
      workspaces: current.workspaces.map((workspace) =>
        workspace.id === workspaceId ? patch(workspace) : workspace),
    }))
  }
  configureWorkspaceSyncClient({
    applyRegistrySnapshot: (snapshot) => applyImportedSyncEvent(() => adoptRegistrySnapshot(snapshot)),
    applyWorkspaceRenamed: (apply) =>
      applyImportedSyncEvent(() => patchWorkspace(apply.workspaceId, (workspace) => ({
        ...workspace,
        name: apply.name,
        ...(apply.titleLocked !== undefined ? { titleLocked: apply.titleLocked } : {}),
      }))),
    applyWorkspaceLayoutUpdated: (apply) =>
      applyImportedSyncEvent(() => patchWorkspace(apply.workspaceId, (workspace) => ({
        ...workspace,
        // A window on an older build can still broadcast a layout docking a
        // retired rail tab; this window never renders one.
        layoutModel: stripRetiredRailTabsFromLayout(apply.layoutModel) as Workspace['layoutModel'],
      }))),
    applyWorkspaceFieldsUpdated: (apply) =>
      applyImportedSyncEvent(() => patchWorkspace(apply.workspaceId, (workspace) => {
        // The shared patch contract: absent = no opinion, null = cleared, a
        // clock only advances (`applyWorkspaceFieldsPatch`).
        const next = { ...workspace } as Record<string, unknown>
        applyWorkspaceFieldsPatch(next, apply.patch)
        return next as Workspace
      })),
    applyWorkspaceAgentUpdated: (apply) =>
      applyImportedSyncEvent(() => patchWorkspace(apply.workspaceId, (workspace) => {
        if (apply.patch === null) {
          const { [apply.agentId]: _removed, ...agents } = workspace.agents
          return { ...workspace, agents }
        }
        const existing = workspace.agents[apply.agentId] ?? defaultAgent(apply.agentId)
        return {
          ...workspace,
          agents: {
            ...workspace.agents,
            [apply.agentId]: { ...existing, ...apply.patch, configEditedAt: apply.configEditedAt },
          },
        }
      })),
    applyWorkspaceRemoved: (apply) =>
      applyImportedSyncEvent(() => {
        useWorkspaceStore.setState((current) => ({
          ...current,
          workspaces: current.workspaces.filter((workspace) => workspace.id !== apply.workspaceId),
          activeWorkspaceId: current.activeWorkspaceId === apply.workspaceId
            ? current.workspaces.filter((workspace) => workspace.id !== apply.workspaceId).at(-1)?.id ?? null
            : current.activeWorkspaceId,
          workspaceWindows: current.workspaceWindows.map((windowState) => ({
            ...windowState,
            workspaceIds: windowState.workspaceIds.filter((id) => id !== apply.workspaceId),
            activeWorkspaceId: windowState.activeWorkspaceId === apply.workspaceId
              ? windowState.workspaceIds.filter((id) => id !== apply.workspaceId)[0] ?? null
              : windowState.activeWorkspaceId,
          })),
        }))
      }),
    applyActiveChanged: (apply: WorkspaceActiveChangedApply) =>
      applyImportedSyncEvent(() => useWorkspaceStore.getState().applyWorkspaceActiveChangedEvent(apply)),
    applyWorkspaceMoved: (apply: WorkspaceMovedApply) =>
      applyImportedSyncEvent(() => useWorkspaceStore.getState().applyWorkspaceMovedEvent(apply)),
    applyWorkspaceClosed: (apply: WorkspaceClosedApply) =>
      applyImportedSyncEvent(() => useWorkspaceStore.getState().applyWorkspaceClosedEvent(apply)),
    applyWorkspacePlacement: (apply: WorkspacePlacementApply) =>
      applyImportedSyncEvent(() => useWorkspaceStore.getState().applyWorkspacePlacementEvent(apply)),
    applyWorkspaceCreated: (apply: WorkspaceCreatedApply) =>
      applyImportedSyncEvent(() => useWorkspaceStore.getState().applyWorkspaceCreatedEvent(apply)),
    applyAgentTerminalSession: (apply: AgentTerminalSessionApply) =>
      applyImportedSyncEvent(() => useWorkspaceStore.getState().applyAgentTerminalSessionEvent(apply)),
    applyAgentTerminalLaunchState: (apply: AgentTerminalLaunchStateApply) =>
      applyImportedSyncEvent(() => useWorkspaceStore.getState().applyAgentTerminalLaunchStateEvent(apply)),
  })
  // Subscribe immediately so no broadcast is missed, and offer hydration
  // alongside it. The two race by design: the snapshot seed cannot blank this
  // window because `adoptRegistrySnapshot` refuses an empty registry over a
  // non-empty one, and once main is seeded its next broadcast (or the next
  // gap resync) carries the authoritative list.
  workspaceSyncClient.start()
  void offerRegistryHydration()
}
initWorkspaceSyncClient()

// Re-export so consumers (tests, devtools) can use a single import surface.
export {
  WORKSPACE_STORAGE_KEY,
  WORKSPACE_STORE_VERSION,
  classifyPersistedWorkspaceState,
  isDangerousEmptyClassification,
}
export type { HydrationDiagnostic, PersistedStateClassification }

export const __workspaceStoreBackupRecoveryPromise: Promise<void> = attemptBackupRecovery()
export const __workspaceStoreRunBackupRecoveryForTests = attemptBackupRecovery
