import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import type { IJsonModel } from 'flexlayout-react'
import type {
  Workspace,
  WorkspaceId,
  LayoutTemplate,
  AgentState,
  AgentId,
  SprintEngineAutoPendingSpawn,
  SprintEngineAutoState,
  SprintEngineCliPermissionPreset,
  MultiloopAutoPendingSpawn,
  MultiloopAutoState,
  SprintEngineState,
  SprintEngineWorkspaceContext,
  MultiloopState,
  MultiloopWorkspaceContext,
  SprintEngineRoleId,
  SprintEngineRoleCliDefaults,
  AgentCli,
  AppSettings,
  UsageTelemetrySettings,
  CliRuntimeSettings,
  SpecialistActionId,
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
import { createGuidedBriefSlice } from './slices/guidedBriefSlice'
import { createAuthSlice } from './slices/authSlice'
import { createSettingsSlice, normalizeAppSettings } from './slices/settingsSlice'
import {
  createWorkspacesSlice,
  type WorkspacesSliceDependencies,
} from './slices/workspacesSlice'
import {
  createLayoutSlice,
  ensureMultiloopLayoutModel,
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
import { normalizeWorkspaceForPartialize } from './slices/normalizers'
import {
  APP_SETTINGS_STORAGE_KEY,
  WORKSPACE_STORAGE_KEY,
  WORKSPACE_STORE_VERSION,
  type HydrationDiagnostic,
  type HydrationStorageSource,
  type PersistedStateClassification,
  type WorkspaceMigrationState,
  classifyPersistedWorkspaceState,
  isDangerousEmptyClassification,
  migrateLegacyWorkspaceStorageKey,
  migratePersistedWorkspaceState,
} from './slices/persistenceSlice'
import {
  isLegacyV44WorkspaceEnvelope,
  splitLegacyV44Envelope,
} from './repositories/workspaceRegistry'
import type { WorkspaceRegistryEmptyState } from '../types/workspace'

migrateLegacyWorkspaceStorageKey()

interface WorkspaceStore {
  workspaces: Workspace[]
  activeWorkspaceId: WorkspaceId | null
  workspaceRegistryEmptyState: WorkspaceRegistryEmptyState | null
  appSettings: AppSettings
  authState: MulticodeAuthState
  sidebarCollapsed: boolean
  setSidebarCollapsed: (collapsed: boolean) => void
  settingsOverlay: {
    open: boolean
    initialTab: string | null
    checkForUpdatesRequestId: number | null
  }
  openSettingsOverlay: (opts?: { initialTab?: string | null; checkForUpdates?: boolean }) => void
  closeSettingsOverlay: () => void
  reorderWorkspaces: (orderedIds: WorkspaceId[]) => void
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
  setLastSelectedSpecialist: (specialistId: SpecialistActionId) => void
  setLastSelectedMultiloopRole: (role: MultiloopRole) => void
  setLastAgentSpawnPermissionPreset: (preset: SprintEngineCliPermissionPreset) => void
  setSpecialistCliDefault: (specialistId: SpecialistActionId, cli: AgentCli | null) => void
  setMultiloopRoleCliDefault: (role: MultiloopRole, cli: AgentCli | null) => void
  setSearchExcludes: (patterns: string[]) => void
  setProjectKnowledgeRoot: (projectRoot: string, relativeRoot: string | null) => void
  setUsageTelemetrySettings: (update: Partial<UsageTelemetrySettings>) => void
  setSprintEngineRoleEnabled: (role: SprintEngineRoleId, enabled: boolean) => void
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
      sprintEngineAutoState?: Partial<SprintEngineAutoState> | null
      multiloopAutoState?: Partial<MultiloopAutoState> | null
      guidedBriefState?: GuidedBriefRuntimeState | null
      mode?: Workspace['mode']
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
  updateAgent: (workspaceId: WorkspaceId, agentId: AgentId, update: Partial<AgentState>) => void
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
  setSprintEngineAutoEnabled: (workspaceId: WorkspaceId, enabled: boolean) => void
  setSprintEngineAutoApproveArtifacts: (workspaceId: WorkspaceId, autoApproveArtifacts: boolean) => void
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
  workspaceRegistryEmptyState: unknown
}

type SettingsEnvelopeState = {
  appSettings: unknown
  sidebarCollapsed: unknown
}

let lastWrittenRegistrySerialized: string | null = null
let lastWrittenSettingsSerialized: string | null = null

function extractRegistryFields(state: Record<string, unknown>): RegistryEnvelopeState {
  return {
    workspaces: state.workspaces,
    activeWorkspaceId: state.activeWorkspaceId,
    workspaceRegistryEmptyState: state.workspaceRegistryEmptyState,
  }
}

function extractSettingsFields(state: Record<string, unknown>): SettingsEnvelopeState {
  return {
    appSettings: state.appSettings,
    sidebarCollapsed: state.sidebarCollapsed,
  }
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
      const next: WorkspaceStore = {
        ...current,
        workspaces: recoveredWorkspaces,
        activeWorkspaceId: envelope!.state!.activeWorkspaceId
          ?? envelope!.state!.workspaces?.[0]?.id
          ?? current.activeWorkspaceId,
        workspaceRegistryEmptyState: null,
      }
      if (legacyAppSettings !== undefined) {
        next.appSettings = normalizeAppSettings(legacyAppSettings, recoveredWorkspaces as Workspace[])
      } else if (recoveredSettingsState?.appSettings !== undefined) {
        next.appSettings = normalizeAppSettings(
          recoveredSettingsState.appSettings as Partial<AppSettings>,
          recoveredWorkspaces as Workspace[],
        )
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
        const state = persisted as Partial<WorkspaceMigrationState & { sidebarCollapsed?: boolean }> | undefined
        const workspaces = state?.workspaces ?? current.workspaces

        return {
          ...current,
          ...(state ?? {}),
          workspaces,
          activeWorkspaceId: state?.activeWorkspaceId ?? current.activeWorkspaceId,
          sidebarCollapsed:
            typeof state?.sidebarCollapsed === 'boolean'
              ? state.sidebarCollapsed
              : current.sidebarCollapsed,
          workspaceRegistryEmptyState:
            state?.workspaceRegistryEmptyState !== undefined
              ? state.workspaceRegistryEmptyState
              : current.workspaceRegistryEmptyState,
          appSettings: normalizeAppSettings(state?.appSettings, workspaces),
        }
      },
      partialize: (s) => {
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
              workspaces: retainedWorkspaces,
              activeWorkspaceId: retainedActiveId ?? retainedWorkspaces[0]?.id ?? s.activeWorkspaceId,
              workspaceRegistryEmptyState: null,
            }
          }
        }

        return {
          appSettings: s.appSettings,
          sidebarCollapsed: s.sidebarCollapsed,
          workspaces: s.workspaces.map(normalizeWorkspaceForPartialize),
          activeWorkspaceId: s.activeWorkspaceId,
          workspaceRegistryEmptyState: s.workspaceRegistryEmptyState,
        }
      },
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
