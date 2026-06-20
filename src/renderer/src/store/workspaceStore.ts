import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import type { IJsonModel } from 'flexlayout-react'
import type { OnboardingStep } from './onboardingState'
import type {
  Workspace,
  WorkspaceId,
  WorkspaceWindowId,
  WorkspaceWindowState,
  LayoutTemplate,
  AgentState,
  AgentId,
  SprintEngineAutoPendingSpawn,
  SprintEngineAutoState,
  SprintEngineAutomationEvent,
  SprintEngineAutomationMode,
  SprintEngineCliPermissionPreset,
  MultiloopAutoPendingSpawn,
  MultiloopAutoState,
  SprintEngineState,
  SprintEngineWorkspaceContext,
  MultiloopState,
  MultiloopWorkspaceContext,
  SprintEngineRoleId,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
  SprintEngineRoleModelOverrides,
  AgentCli,
  AgentCliModelSelection,
  AgentConversationRuntime,
  AppSettings,
  UsageTelemetrySettings,
  VoiceDictationSettings,
  CliRuntimeSettings,
  SpecialistActionId,
  SprintEngineRoleRegistry,
  MultiloopRole,
  AgentExecution,
  WorkspaceWorktreeState,
  WorktreeEntry,
  MemoryGraphSettings,
  WorkspaceHighlight,
  McpServerConfig,
  SkillPackEntry,
  GuidedBriefRuntimeState,
} from '../types/workspace'
import type { AppTheme } from '../types/appTheme'
import type { CommandId } from '../commands/commandRegistry'
import { createGuidedBriefSlice } from './slices/guidedBriefSlice'
import { createAuthSlice } from './slices/authSlice'
import { createSettingsSlice, normalizeAppSettings } from './slices/settingsSlice'
import {
  createWorkspacesSlice,
  type SoloChatSeed,
  type WorkspacesSliceDependencies,
} from './slices/workspacesSlice'
import {
  createLayoutSlice,
  ensureMultiloopLayoutModel,
  hideNavRailTabStrip,
  migrateSprintEngineLayout,
  multiloopTabsLayoutModel,
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
  normalizeMultiloopAutoState,
  normalizeMultiloopWorkspaceContext,
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
  normalizeWorkspaceForPartialize,
  preserveNewerSprintEngineAutomationState,
} from './slices/normalizers'
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
import type { WorkspaceRegistryEmptyState } from '../types/workspace'

migrateLegacyWorkspaceStorageKey()

export interface WorkspaceStore extends PluginsSlice, CliAvailabilitySlice {
  workspaces: Workspace[]
  activeWorkspaceId: WorkspaceId | null
  workspaceWindows: WorkspaceWindowState[]
  primaryWorkspaceWindowId: WorkspaceWindowId
  workspaceRegistryEmptyState: WorkspaceRegistryEmptyState | null
  appSettings: AppSettings
  authState: MulticodeAuthState
  sidebarCollapsed: boolean
  setSidebarCollapsed: (collapsed: boolean) => void
  sprintEngineRoleRegistry: SprintEngineRoleRegistry | null
  setSprintEngineRoleRegistry: (registry: SprintEngineRoleRegistry | null) => void
  sprintEnginesAsideOpen: boolean
  setSprintEnginesAsideOpen: (open: boolean) => void
  openFilesInExternalWindow: boolean
  setOpenFilesInExternalWindow: (enabled: boolean) => void
  settingsOverlay: {
    open: boolean
    initialTab: string | null
    checkForUpdatesRequestId: number | null
  }
  openSettingsOverlay: (opts?: { initialTab?: string | null; checkForUpdates?: boolean }) => void
  closeSettingsOverlay: () => void
  runSummaryOverlay: {
    open: boolean
    workspaceId: string | null
  }
  openRunSummaryOverlay: (workspaceId: string) => void
  closeRunSummaryOverlay: () => void
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
  recordWorkspaceTerminalActivity: (id: WorkspaceId, lastOutputAt: number) => void
  reconcileWorkspaceAgentLaunchFlags: (sessions: TerminalSessionSnapshot[]) => void
  setAuthState: (authState: MulticodeAuthState) => void
  setCliRuntime: (cli: AgentCli, update: Partial<CliRuntimeSettings>) => void
  setMcpSyncEnabled: (enabled: boolean) => void
  upsertMcpServer: (server: McpServerConfig) => void
  removeMcpServer: (serverId: string) => void
  setSkillPacksInstalled: (installed: SkillPackEntry[]) => void
  upsertSkillPack: (pack: SkillPackEntry) => void
  removeSkillPack: (id: string) => void
  setLastSelectedCli: (cli: AgentCli) => void
  setLastSelectedConversationModel: (selection: AgentConversationRuntime | null) => void
  setLastSelectedSpecialist: (specialistId: SpecialistActionId) => void
  setLastSelectedMultiloopRole: (role: MultiloopRole) => void
  setLastAgentSpawnPermissionPreset: (preset: SprintEngineCliPermissionPreset) => void
  setSpecialistCliDefault: (specialistId: SpecialistActionId, cli: AgentCli | null) => void
  setMultiloopRoleCliDefault: (role: MultiloopRole, cli: AgentCli | null) => void
  setSpecialistModelDefault: (specialistId: SpecialistActionId, selection: AgentCliModelSelection | null) => void
  setMultiloopRoleModelDefault: (role: MultiloopRole, selection: AgentCliModelSelection | null) => void
  setSpecialistOrder: (order: SpecialistActionId[]) => void
  setSpecialistPackEnabled: (packId: string, enabled: boolean) => void
  setCommandKeybindings: (commandId: CommandId, keybindings: string[]) => void
  setCommandKeybindingDisabled: (commandId: CommandId, disabled: boolean) => void
  resetCommandKeybindings: (commandId: CommandId) => void
  resetAllKeybindings: () => void
  setSearchExcludes: (patterns: string[]) => void
  setProjectKnowledgeRoot: (projectRoot: string, relativeRoot: string | null) => void
  setUsageTelemetrySettings: (update: Partial<UsageTelemetrySettings>) => void
  setVoiceDictationSettings: (update: Partial<VoiceDictationSettings>) => void
  setSprintEngineRoleEnabled: (role: SprintEngineRoleId, enabled: boolean) => void
  saveSprintEngineRosterTeam: (input: {
    id?: string
    name: string
    roleCounts: SprintEngineRoleCounts
    roleCliDefaults: SprintEngineRoleCliDefaults
  }) => string
  renameSprintEngineRosterTeam: (id: string, name: string) => void
  deleteSprintEngineRosterTeam: (id: string) => void
  setSprintEngineLastSelectedTeam: (id: string | null) => void
  setModuleEnabled: (moduleId: string, enabled: boolean) => void
  /** Write one value in a module's `module:<id>` settings namespace; `undefined` deletes the key. */
  setModuleSettingValue: (moduleId: string, key: string, value: unknown) => void
  setModulesChosen: (chosen: boolean) => void
  setOnboardingStep: (step: OnboardingStep) => void
  advanceOnboarding: () => void
  setLearningShowTipsOnStartup: (enabled: boolean) => void
  markLearningTipSeen: (tipId: string) => void
  markLearningLessonCompleted: (lessonId: string, completed?: boolean) => void
  resetLearningProgress: () => void
  setAppearanceTheme: (theme: AppTheme) => void
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
      sprintEngineRoleModelOverrides?: SprintEngineRoleModelOverrides | null
      sprintEngineInitialSpawnRoles?: SprintEngineRoleId[] | null
      templateAgentCli?: AgentCli | null
      seedAgent?: SoloChatSeed | null
      sprintEngineAutoState?: Partial<SprintEngineAutoState> | null
      multiloopAutoState?: Partial<MultiloopAutoState> | null
      guidedBriefState?: GuidedBriefRuntimeState | null
      mode?: Workspace['mode']
      windowId?: WorkspaceWindowId | null
    }
  ) => WorkspaceId
  removeWorkspace: (id: WorkspaceId) => void
  renameWorkspace: (id: WorkspaceId, name: string) => void
  setActiveWorkspace: (id: WorkspaceId) => void
  updateLayout: (id: WorkspaceId, model: IJsonModel) => void
  setFolderPath: (id: WorkspaceId, folderPath: string | null) => void
  setSprintEngineContext: (id: WorkspaceId, sprintEngineContext: SprintEngineWorkspaceContext | null) => void
  setMultiloopContext: (
    id: WorkspaceId,
    multiloopContext: MultiloopWorkspaceContext | null
  ) => void
  setFolderMissing: (id: WorkspaceId, folderMissing: boolean) => void
  setFileExplorerExpandedPaths: (id: WorkspaceId, expandedPaths: string[]) => void
  updateAgent: (workspaceId: WorkspaceId, agentId: AgentId, update: Partial<AgentState>) => void
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
  setMultiloopState: (workspaceId: WorkspaceId, multiloopState: MultiloopState | null) => void
  setSprintEngineAutomationMode: (
    workspaceId: WorkspaceId,
    mode: SprintEngineAutomationMode,
    options?: { suppressManualAudit?: boolean; reason?: string; details?: string }
  ) => void
  applySprintEngineAutomationEvent: (
    workspaceId: WorkspaceId,
    event: SprintEngineAutomationEvent
  ) => void
  setSprintEngineKeepDoneAgentTerminals: (workspaceId: WorkspaceId, keepDoneAgentTerminals: boolean) => void
  setSprintEngineCliPermissionPreset: (
    workspaceId: WorkspaceId,
    cliPermissionPreset: SprintEngineCliPermissionPreset
  ) => void
  setSprintEngineMaxConcurrentAgents: (workspaceId: WorkspaceId, maxConcurrentAgents: number) => void
  setSprintEngineAutoPendingSpawns: (
    workspaceId: WorkspaceId,
    pendingSpawns: SprintEngineAutoPendingSpawn[]
  ) => void
  markSprintEngineAgentNotificationDelivered: (workspaceId: WorkspaceId, eventKey: string) => void
  setMultiloopAutoEnabled: (workspaceId: WorkspaceId, enabled: boolean) => void
  setMultiloopCliPermissionPreset: (
    workspaceId: WorkspaceId,
    cliPermissionPreset: SprintEngineCliPermissionPreset
  ) => void
  setMultiloopAutoPendingSpawns: (
    workspaceId: WorkspaceId,
    pendingSpawns: MultiloopAutoPendingSpawn[]
  ) => void
  setMultiloopCoordinatorAutoSpawnKey: (workspaceId: WorkspaceId, key: string | null) => void
  setGuidedBriefState: (workspaceId: WorkspaceId, guidedBriefState: GuidedBriefRuntimeState | null) => void
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
  normalizeMultiloopWorkspaceContext,
  normalizeSprintEngineAutoState,
  normalizeMultiloopAutoState,
  normalizeSprintEngineRoleCliDefaults,
  multiloopTabsLayoutModel,
  sprintEngineTabsLayoutModel,
  ensureMultiloopLayoutModel,
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

type SettingsEnvelopeState = {
  appSettings: unknown
  sidebarCollapsed: unknown
  sprintEnginesAsideOpen: unknown
  openFilesInExternalWindow: unknown
}

let lastWrittenRegistrySerialized: string | null = null
let lastWrittenSettingsSerialized: string | null = null
let suppressNextPersistWrite = false

function getCurrentWorkspaceWindowId(): WorkspaceWindowId {
  if (typeof window === 'undefined') return PRIMARY_WORKSPACE_WINDOW_ID
  try {
    return new URL(window.location.href).searchParams.get('windowId')?.trim() || PRIMARY_WORKSPACE_WINDOW_ID
  } catch {
    return PRIMARY_WORKSPACE_WINDOW_ID
  }
}

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

function extractSettingsFields(state: Record<string, unknown>): SettingsEnvelopeState {
  return {
    appSettings: state.appSettings,
    sidebarCollapsed: state.sidebarCollapsed,
    sprintEnginesAsideOpen: state.sprintEnginesAsideOpen,
    openFilesInExternalWindow: state.openFilesInExternalWindow,
  }
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
        sprintEnginesAsideOpen: s.sprintEnginesAsideOpen,
        openFilesInExternalWindow: s.openFilesInExternalWindow,
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
    sprintEnginesAsideOpen: s.sprintEnginesAsideOpen,
    openFilesInExternalWindow: s.openFilesInExternalWindow,
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
    // Seed the dedup baselines so the first post-hydrate setItem can decide
    // whether to re-serialize each key.
    lastWrittenRegistrySerialized = JSON.stringify(extractRegistryFields(mergedState))
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

    // Registry key — dedup'd. Settings writes that don't touch workspace
    // fields produce an identical serialized payload and the localStorage
    // write is skipped, which gives the AC2/AC3 by-construction guarantee.
    const registryFields = extractRegistryFields(fullState)
    const registrySerialized = JSON.stringify(registryFields)
    const registryEnvelopeSerialized = JSON.stringify({ state: registryFields, version })
    if (registrySerialized !== lastWrittenRegistrySerialized) {
      try {
        window.localStorage.setItem(
          WORKSPACE_STORAGE_KEY,
          registryEnvelopeSerialized,
        )
      } catch (error) {
        console.warn('[workspaceStore] localStorage registry write failed', {
          message: error instanceof Error ? error.message : 'unknown',
        })
      }
      lastWrittenRegistrySerialized = registrySerialized
    }

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
    // roots, CLI defaults, MCP, skill packs, learning state, or sidebar state.
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
    lastWrittenRegistrySerialized = null
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

    // App-settings salvage. New backups carry the split settings envelope
    // beside the registry envelope. Older T22-era backups may carry
    // appSettings/sidebarCollapsed inside the recovered registry envelope.
    // In both cases, recovery must not bring the workspace list back while
    // silently dropping Knowledge Graph roots, CLI defaults, MCP, skill packs,
    // learning state, or sidebar state.
    const legacyState = envelope!.state as Partial<WorkspaceMigrationState> & {
      sidebarCollapsed?: boolean
    }
    const legacyAppSettings = legacyState.appSettings
    const legacySidebarCollapsed = legacyState.sidebarCollapsed
    const recoveredSettingsState = parseSettingsEnvelopeState(recoveredBackup.settings)

    try {
      window.localStorage.setItem(WORKSPACE_STORAGE_KEY, recovered)
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
      const next: WorkspaceStore = {
        ...current,
        workspaces: hydrated.workspaces,
        activeWorkspaceId: envelope!.state!.activeWorkspaceId
          ?? envelope!.state!.workspaces?.[0]?.id
          ?? current.activeWorkspaceId,
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
    // next persist write doesn't clobber projectKnowledgeRoots / learning /
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
    immer((set) => ({
      ...createAuthSlice(set),
      ...createSettingsSlice(set),
      ...createLayoutSlice(set),
      ...createAgentsSlice(set),
      ...createRunStateSlice(set),
      ...createGuidedBriefSlice(set),
      ...createWorktreesSlice(set),
      ...createMemorySlice(set),
      ...createPluginsSlice(set),
      ...createCliAvailabilitySlice(set),
      ...createWorkspacesSlice(set, workspacesSliceDeps),
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
        const state = persisted as Partial<WorkspaceMigrationState & { sidebarCollapsed?: boolean; sprintEnginesAsideOpen?: boolean }> | undefined
        const rawWorkspaces = state?.workspaces ?? current.workspaces
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

        return {
          ...current,
          ...(state ?? {}),
          workspaces,
          activeWorkspaceId: state?.activeWorkspaceId ?? current.activeWorkspaceId,
          workspaceWindows: normalizedWindows.windows,
          primaryWorkspaceWindowId: normalizedWindows.primaryWorkspaceWindowId,
          sidebarCollapsed:
            typeof state?.sidebarCollapsed === 'boolean'
              ? state.sidebarCollapsed
              : current.sidebarCollapsed,
          sprintEnginesAsideOpen:
            typeof state?.sprintEnginesAsideOpen === 'boolean'
              ? state.sprintEnginesAsideOpen
              : current.sprintEnginesAsideOpen,
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

function syncWorkspaceRegistryAcrossWindows(): void {
  if (typeof window === 'undefined') return
  if (!isStorageEventWorkspaceLiveSyncEnabled()) return
  window.addEventListener('storage', (event) => {
    if (event.key !== WORKSPACE_STORAGE_KEY || !event.newValue) return
    let parsed: { state?: Partial<WorkspaceMigrationState> } | null = null
    try {
      parsed = JSON.parse(event.newValue) as { state?: Partial<WorkspaceMigrationState> }
    } catch {
      return
    }
    const incoming = parsed?.state
    if (!incoming || !Array.isArray(incoming.workspaces)) return
    let appliedRegistrySerialized: string | null = null
    suppressNextPersistWrite = true
    try {
      useWorkspaceStore.setState((current) => {
        const normalizedWindows = normalizeWorkspaceWindows(
          incoming.workspaces as Workspace[],
          incoming.workspaceWindows,
          incoming.primaryWorkspaceWindowId,
          incoming.activeWorkspaceId ?? current.activeWorkspaceId,
        )
        const workspaceWindowId = getCurrentWorkspaceWindowId()
        const currentOwnedWindow = current.workspaceWindows.find((windowState) => windowState.id === workspaceWindowId)
        const incomingOwnedWindow = normalizedWindows.windows.find((windowState) => windowState.id === workspaceWindowId)
        const currentWorkspaceById = new Map(current.workspaces.map((workspace) => [workspace.id, workspace] as const))
        const currentOwnedWorkspaceIds = new Set(currentOwnedWindow?.workspaceIds ?? [])
        let nextWorkspaces = (incoming.workspaces as Workspace[]).map((workspace) => {
          const currentWorkspace = currentWorkspaceById.get(workspace.id)
          const automationSafe = preserveNewerSprintEngineAutomationState(workspace, currentWorkspace)
          return currentOwnedWorkspaceIds.has(workspace.id)
            ? preserveAgentTerminalMetadata(automationSafe, currentWorkspace)
            : automationSafe
        })
        if (currentOwnedWindow && incomingOwnedWindow) {
          const preservableWorkspaceIds = new Set(
            currentOwnedWindow.workspaceIds.filter((workspaceId) => incomingOwnedWindow.workspaceIds.includes(workspaceId))
          )
          nextWorkspaces = nextWorkspaces.map((workspace) =>
            preservableWorkspaceIds.has(workspace.id)
              ? currentWorkspaceById.get(workspace.id) ?? workspace
              : workspace
          )
        }
        if (
          currentOwnedWindow
          && incomingOwnedWindow
          && currentOwnedWindow.lastFocusedAt > incomingOwnedWindow.lastFocusedAt
        ) {
          if (
            currentOwnedWindow.activeWorkspaceId
            && incomingOwnedWindow.workspaceIds.includes(currentOwnedWindow.activeWorkspaceId)
          ) {
            incomingOwnedWindow.activeWorkspaceId = currentOwnedWindow.activeWorkspaceId
          }
          incomingOwnedWindow.lastFocusedAt = currentOwnedWindow.lastFocusedAt
        }
        const nextState = {
          ...current,
          workspaces: nextWorkspaces,
          activeWorkspaceId: incoming.activeWorkspaceId ?? current.activeWorkspaceId,
          workspaceWindows: normalizedWindows.windows,
          primaryWorkspaceWindowId: normalizedWindows.primaryWorkspaceWindowId,
          workspaceRegistryEmptyState:
            incoming.workspaceRegistryEmptyState === undefined
              ? current.workspaceRegistryEmptyState
              : incoming.workspaceRegistryEmptyState,
        }
        // Advance the dedup baseline with the SAME normalized shape partialize
        // feeds setItem. nextWorkspaces can reuse live workspace objects (with
        // file content / in-memory buffers) for preserved ids, so serializing
        // the raw state here would differ from the normalized partialized form
        // and let a later unrelated write re-emit this imported registry.
        appliedRegistrySerialized = JSON.stringify(partializeRegistryFields(nextState))
        return nextState
      })
    } finally {
      suppressNextPersistWrite = false
    }
    if (appliedRegistrySerialized) {
      lastWrittenRegistrySerialized = appliedRegistrySerialized
    }
  })
}
syncWorkspaceRegistryAcrossWindows()

function isStorageEventWorkspaceLiveSyncEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (window.localStorage.getItem('multicode.workspaceStorageLiveSync') === '1') return true
  } catch {
    // Dev/rollback flag read is best-effort.
  }
  return import.meta.env.DEV && import.meta.env.VITE_MULTICODE_WORKSPACE_STORAGE_LIVE_SYNC === '1'
}

// Wire the main-mediated workspace sync bus. The client dispatches active
// selection commands and applies accepted/broadcast active_changed events to
// the store. Storage-event sync above remains the functional rollback path.
function initWorkspaceSyncClient(): void {
  if (typeof window === 'undefined') return
  // Applying an imported (accepted or broadcast) event must not re-emit a live
  // command. Each apply runs under `suppressNextPersistWrite` so it mutates the
  // in-memory store but does not write the registry to localStorage — without
  // this, the application would persist the full registry and another window's
  // storage listener would import routing/active wholesale, echoing the event
  // back and potentially flipping a window that the event did not target
  // (AC5/AC6 of the active path; the same hazard applies to move/close/
  // placement). The change still reaches other windows through the source
  // renderer's own persisted user-action write, so suppression only removes the
  // echo. Suppressing the immediate write is not enough on its own: the registry
  // dedup baseline (`lastWrittenRegistrySerialized`) must also advance to the
  // post-apply state, or the next unrelated persisted mutation (e.g.
  // setSidebarCollapsed) would detect a phantom registry diff and serialize the
  // imported snapshot later. The baseline uses the SAME normalized shape
  // `partialize` feeds setItem, so this reuses partializeRegistryFields.
  const applyImportedSyncEvent = (apply: () => void): void => {
    suppressNextPersistWrite = true
    try {
      apply()
    } finally {
      suppressNextPersistWrite = false
    }
    lastWrittenRegistrySerialized = JSON.stringify(
      partializeRegistryFields(useWorkspaceStore.getState()),
    )
  }
  configureWorkspaceSyncClient({
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
  workspaceSyncClient.start()
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
