import type {
  AgentCli,
  AppSettings,
  SprintEngineAutomationDesiredMode,
  SprintEngineRunSettings,
  SprintEngineWorkspaceContext,
  Workspace,
  WorkspaceId,
  WorkspaceWindowId,
  WorkspaceWindowState,
} from '../../types/workspace'
import { getSpecialistAction } from '../../specialists/specialistActions'
import { normalizeSprintEngineState } from '../../utils/sprintengine'
import { defaultEditorState, normalizeAgentCli, normalizeAgentState } from './agentsSlice'
import {
  ensureGuidedBriefLayoutModel,
  normalizeGuidedBriefState,
} from './guidedBriefSlice'
import {
  consolidateSwitchboardWorkspaceLayout,
  ensureMultiloopLayoutModel,
  hideGuidedBriefTabStrip,
  hideNavRailTabStrip,
  hideSprintEngineBoardTabStrip,
  markSwitchboardAnchorTabsSticky,
  migrateSprintEngineLayout,
  sprintEngineTabsLayoutModel,
  stripSettingsTabsFromLayout,
  stripSprintEnginesNavFromLayout,
} from './layoutSlice'
import { normalizeWorkspaceMemoryConfig } from './memorySlice'
import {
  migrateSprintEngineAgentNames,
  normalizeMultiloopAutoState,
  normalizeMultiloopWorkspaceContext,
  normalizeSprintEngineAutoState,
  normalizeSprintEngineRoleCliDefaults,
  normalizeSprintEngineWorkspaceContext,
  reconcileSprintEngineAgents,
} from './runStateSlice'
import {
  defaultAppSettings,
  normalizeAppSettings,
  normalizeCliPermissionPreset,
  normalizeRecentWorkspaceFolders,
  normalizeSearchExcludes,
  normalizeSprintEngineRunSettings,
  normalizeUsageTelemetrySettings,
  sprintEngineRunSettingsKey,
} from './settingsSlice'
import { normalizeWorkspaceFileExplorerState, normalizeWorkspaceMode } from './workspacesSlice'
import { normalizeWorkspaceWorktreeState } from './worktreesSlice'
import {
  clearSprintEngineAgentLaunchState,
  dedupeAutomationsHostWorkspaces,
  mapMigrationWorkspaces,
} from './normalizers'

export const WORKSPACE_STORAGE_KEY = 'multicode-workspaces'
export const APP_SETTINGS_STORAGE_KEY = 'multicode-app-settings'
export const WORKSPACE_STORE_VERSION = 64
export const PRIMARY_WORKSPACE_WINDOW_ID: WorkspaceWindowId = 'primary'
const LEGACY_WORKSPACE_STORAGE_KEY = ['free', 'ai', 'ide', 'workspaces'].join('-')

export type WorkspaceMigrationState = {
  workspaces: Workspace[]
  activeWorkspaceId?: WorkspaceId | null
  workspaceWindows?: WorkspaceWindowState[]
  primaryWorkspaceWindowId?: WorkspaceWindowId
  appSettings?: Partial<AppSettings> & {
    cliCommands?: Partial<Record<AgentCli, string>>
  }
  sidebarCollapsed?: boolean
  workspaceRegistryEmptyState?: import('../../types/workspace').WorkspaceRegistryEmptyState | null
}

type LegacySprintEngineAutoState = Partial<Workspace['sprintEngineAutoState']> & {
  supervisorEnabled?: unknown
  enabled?: unknown
  autoApproveArtifacts?: unknown
}

function sprintEngineDesiredModeFromLegacyBooleans(
  input: LegacySprintEngineAutoState | null | undefined
): SprintEngineAutomationDesiredMode {
  const explicitMode = input?.desiredMode
  if (
    explicitMode === 'manual'
    || explicitMode === 'run_agents'
    || explicitMode === 'run_agents_and_approve_artifacts'
  ) {
    return explicitMode
  }
  const runnerEnabled = input?.supervisorEnabled === true || input?.enabled === true
  if (runnerEnabled && input?.autoApproveArtifacts === true) return 'run_agents_and_approve_artifacts'
  if (runnerEnabled) return 'run_agents'
  return 'manual'
}

function repairSprintEngineAutomationLifecycleState(workspace: Workspace): Workspace {
  const legacyAutoState = workspace.sprintEngineAutoState as LegacySprintEngineAutoState | null | undefined
  const desiredMode = sprintEngineDesiredModeFromLegacyBooleans(legacyAutoState)
  const sprintEngineAutoState = normalizeSprintEngineAutoState({
    ...legacyAutoState,
    desiredMode,
    runtimeState: legacyAutoState?.runtimeState ?? (desiredMode === 'manual' ? 'idle' : 'running'),
  })
  return {
    ...workspace,
    sprintEngineAutoState,
  }
}

function sprintEngineRunSettingsFromWorkspace(
  workspace: Workspace,
  fallbackPermissionPreset: SprintEngineRunSettings['cliPermissionPreset'],
): SprintEngineRunSettings {
  const autoState = normalizeSprintEngineAutoState(workspace.sprintEngineAutoState)
  return {
    cliPermissionPreset: autoState.cliPermissionPreset === 'default'
      ? fallbackPermissionPreset
      : autoState.cliPermissionPreset,
    maxConcurrentAgents: autoState.maxConcurrentAgents,
  }
}

function hasPersistableSprintEngineRunSettings(runSettings: SprintEngineRunSettings): boolean {
  return runSettings.cliPermissionPreset !== undefined && runSettings.cliPermissionPreset !== 'default'
    || (
      typeof runSettings.maxConcurrentAgents === 'number'
      && Number.isFinite(runSettings.maxConcurrentAgents)
      && runSettings.maxConcurrentAgents !== 3
    )
}

function applySprintEngineRunSettingsToWorkspace(
  workspace: Workspace,
  runSettings: SprintEngineRunSettings | undefined,
): Workspace {
  if (!runSettings) return workspace
  return {
    ...workspace,
    sprintEngineAutoState: normalizeSprintEngineAutoState({
      ...workspace.sprintEngineAutoState,
      ...runSettings,
    }),
  }
}

export function hydrateSprintEngineLocalRunSettings(
  workspaces: Workspace[],
  appSettings: AppSettings,
): { workspaces: Workspace[]; appSettings: AppSettings } {
  const runSettings = normalizeSprintEngineRunSettings(appSettings.sprintEngineRunSettings)
  const fallbackPermissionPreset = appSettings.lastAgentSpawnPermissionPreset

  for (const workspace of workspaces) {
    if (!workspace.sprintEngineState) continue
    const key = sprintEngineRunSettingsKey(workspace.sprintEngineContext?.statePath)
    if (!key || runSettings[key]) continue
    const derivedRunSettings = sprintEngineRunSettingsFromWorkspace(workspace, fallbackPermissionPreset)
    if (hasPersistableSprintEngineRunSettings(derivedRunSettings)) {
      runSettings[key] = derivedRunSettings
    }
  }

  return {
    workspaces: workspaces.map((workspace) => {
      const key = sprintEngineRunSettingsKey(workspace.sprintEngineContext?.statePath)
      return applySprintEngineRunSettingsToWorkspace(workspace, key ? runSettings[key] : undefined)
    }),
    appSettings: {
      ...appSettings,
      sprintEngineRunSettings: runSettings,
    },
  }
}

export function normalizeWorkspaceWindows(
  workspaces: Workspace[],
  windows: WorkspaceWindowState[] | null | undefined,
  primaryWorkspaceWindowId: WorkspaceWindowId | null | undefined,
  fallbackActiveWorkspaceId?: WorkspaceId | null,
): { windows: WorkspaceWindowState[]; primaryWorkspaceWindowId: WorkspaceWindowId } {
  const now = Date.now()
  const workspaceIds = workspaces.map((workspace) => workspace.id)
  const validWorkspaceIds = new Set(workspaceIds)
  const primaryId = primaryWorkspaceWindowId?.trim() || PRIMARY_WORKSPACE_WINDOW_ID
  const seenWindowIds = new Set<WorkspaceWindowId>()
  const assignedWorkspaceIds = new Set<WorkspaceId>()
  const nextWindows: WorkspaceWindowState[] = []

  const sourceWindows = Array.isArray(windows) && windows.length > 0
    ? windows
    : [
        {
          id: primaryId,
          kind: 'primary' as const,
          workspaceIds,
          activeWorkspaceId: fallbackActiveWorkspaceId ?? workspaceIds[0] ?? null,
          bounds: null,
          isMaximized: false,
          displayId: null,
          createdAt: now,
          lastFocusedAt: now,
        },
      ]

  for (const source of sourceWindows) {
    if (!source || typeof source.id !== 'string' || !source.id.trim()) continue
    const id = source.id.trim()
    if (seenWindowIds.has(id)) continue
    seenWindowIds.add(id)

    const memberIds: WorkspaceId[] = []
    for (const workspaceId of Array.isArray(source.workspaceIds) ? source.workspaceIds : []) {
      if (!validWorkspaceIds.has(workspaceId) || assignedWorkspaceIds.has(workspaceId)) continue
      memberIds.push(workspaceId)
      assignedWorkspaceIds.add(workspaceId)
    }

    nextWindows.push({
      id,
      kind: id === primaryId ? 'primary' : source.kind === 'primary' ? 'detached' : 'detached',
      workspaceIds: memberIds,
      activeWorkspaceId:
        source.activeWorkspaceId && memberIds.includes(source.activeWorkspaceId)
          ? source.activeWorkspaceId
          : memberIds[0] ?? null,
      bounds: normalizeWorkspaceWindowBounds(source.bounds),
      isMaximized: source.isMaximized === true,
      displayId: typeof source.displayId === 'number' ? source.displayId : null,
      createdAt: typeof source.createdAt === 'number' ? source.createdAt : now,
      lastFocusedAt: typeof source.lastFocusedAt === 'number' ? source.lastFocusedAt : now,
    })
  }

  let primaryWindow = nextWindows.find((windowState) => windowState.id === primaryId)
  if (!primaryWindow) {
    primaryWindow = {
      id: primaryId,
      kind: 'primary',
      workspaceIds: [],
      activeWorkspaceId: null,
      bounds: null,
      isMaximized: false,
      displayId: null,
      createdAt: now,
      lastFocusedAt: now,
    }
    nextWindows.unshift(primaryWindow)
  } else {
    primaryWindow.kind = 'primary'
  }

  for (const workspaceId of workspaceIds) {
    if (assignedWorkspaceIds.has(workspaceId)) continue
    primaryWindow.workspaceIds.push(workspaceId)
    assignedWorkspaceIds.add(workspaceId)
  }

  primaryWindow.activeWorkspaceId =
    primaryWindow.activeWorkspaceId && primaryWindow.workspaceIds.includes(primaryWindow.activeWorkspaceId)
      ? primaryWindow.activeWorkspaceId
      : fallbackActiveWorkspaceId && primaryWindow.workspaceIds.includes(fallbackActiveWorkspaceId)
        ? fallbackActiveWorkspaceId
        : primaryWindow.workspaceIds[0] ?? null

  return {
    windows: nextWindows.filter((windowState) =>
      windowState.kind === 'primary' || windowState.workspaceIds.length > 0
    ),
    primaryWorkspaceWindowId: primaryId,
  }
}

function normalizeWorkspaceWindowBounds(
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

export function migrateLegacyWorkspaceStorageKey(): void {
  try {
    if (typeof window === 'undefined') return
    if (window.localStorage.getItem(WORKSPACE_STORAGE_KEY)) return

    const legacyState = window.localStorage.getItem(LEGACY_WORKSPACE_STORAGE_KEY)
    if (legacyState) window.localStorage.setItem(WORKSPACE_STORAGE_KEY, legacyState)
  } catch {
    // Persist will fall back to a fresh store if localStorage is unavailable.
  }
}

export function readPersistedWorkspaceState(): Partial<WorkspaceMigrationState> | null {
  if (typeof window === 'undefined') return null

  try {
    const raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { state?: Partial<WorkspaceMigrationState> }
    return parsed.state && typeof parsed.state === 'object' ? parsed.state : null
  } catch {
    return null
  }
}

export function nonEmptyPersistedWorkspaceState(): Partial<WorkspaceMigrationState> | null {
  const persisted = readPersistedWorkspaceState()
  return Array.isArray(persisted?.workspaces) && persisted.workspaces.length > 0 ? persisted : null
}

export type PersistedStateClassification =
  | 'present'
  | 'dangerous_empty_missing_storage'
  | 'dangerous_empty_unreadable'
  | 'dangerous_empty_no_workspaces'

type ClassificationInput = {
  rawLocalStorage: string | null
  parseError?: unknown
}

// Shape-only classifier. It cannot prove intent — the previous "valid_empty"
// inference (workspaces=[] + companion appSettings/sidebarCollapsed) was
// unreliable because every startup write also carries those fields. Intent
// lives in {@link consumePendingValidEmptyIntent} instead, which the user-
// action path (removeWorkspace on the last workspace) sets and partialize
// consumes.
export function classifyPersistedWorkspaceState(input: ClassificationInput): PersistedStateClassification {
  if (input.rawLocalStorage === null) return 'dangerous_empty_missing_storage'
  if (input.parseError) return 'dangerous_empty_unreadable'

  let parsed: { state?: Partial<WorkspaceMigrationState> } | null = null
  try {
    parsed = JSON.parse(input.rawLocalStorage) as { state?: Partial<WorkspaceMigrationState> }
  } catch {
    return 'dangerous_empty_unreadable'
  }

  const state = parsed?.state
  if (!state || typeof state !== 'object') return 'dangerous_empty_unreadable'

  if (Array.isArray(state.workspaces) && state.workspaces.length > 0) return 'present'

  // workspaces missing or empty — defense-in-depth treats both as dangerous.
  // Whether to write empty or recover from backup is governed by the explicit
  // intent flag and the recovery flow, not by guessing intent from shape.
  return 'dangerous_empty_no_workspaces'
}

export function isDangerousEmptyClassification(
  classification: PersistedStateClassification,
): boolean {
  return classification !== 'present'
}

// The T22 one-shot intent flag was removed in T23 — intent now lives in
// state.workspaceRegistryEmptyState (an explicit record set by removeWorkspace
// when the splice leaves workspaces=[], cleared by addWorkspace and
// importWorkspace, and persisted into the registry storage key). Partialize
// reads the field directly; no module-local flag coordination is needed.

export type HydrationStorageSource = 'localStorage' | 'backup' | 'fresh'

export type HydrationDiagnostic = {
  persistedWorkspaceCount: number
  hydratedWorkspaceCount: number
  activeWorkspaceId: string | null
  storageSource: HydrationStorageSource
  classification: PersistedStateClassification
  parseError?: string
  migrationError?: string
  recoveryError?: string
}

export function migratePersistedWorkspaceState(
  persisted: unknown,
  version: number,
): unknown {
  const state = persisted as Partial<WorkspaceMigrationState> | undefined
  if (!state) return state as never
  state.workspaces = state.workspaces ?? []
  const migrationState = state as WorkspaceMigrationState

  if (version < 1) {
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      folderPath: ws.folderPath ?? null,
      editorState: ws.editorState ?? defaultEditorState(),
    }))
  }
  if (version < 2) {
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      mode: ws.mode ?? (ws.sprintEngineState ? 'sprintengine' : 'standard'),
      sprintEngineState: normalizeSprintEngineState(ws.sprintEngineState),
    }))
  }
  if (version < 3) {
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      sprintEngineState: normalizeSprintEngineState(ws.sprintEngineState),
    }))
  }
  if (version < 4) {
    mapMigrationWorkspaces(migrationState, migrateSprintEngineLayout)
  }
  if (version < 5) {
    mapMigrationWorkspaces(migrationState, migrateSprintEngineLayout)
  }
  if (version < 6) {
    mapMigrationWorkspaces(migrationState, migrateSprintEngineLayout)
  }
  if (version < 7) {
    mapMigrationWorkspaces(migrationState, (ws) =>
      ws.mode === 'sprintengine' || ws.sprintEngineState
        ? { ...ws, layoutModel: sprintEngineTabsLayoutModel(ws.sprintEngineState, ws.agents) }
        : ws,
    )
  }
  if (version < 8) {
    mapMigrationWorkspaces(migrationState, (ws) => {
      const sprintEngineState = normalizeSprintEngineState(ws.sprintEngineState)
      if (ws.mode !== 'sprintengine' && !sprintEngineState) return ws

      return {
        ...ws,
        sprintEngineState,
        agents: reconcileSprintEngineAgents(ws.agents, sprintEngineState),
      }
    })
  }
  if (version < 10) {
    const current = migrationState
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
        'claude-code': {
          ...defaults.cliRuntimes['claude-code'],
          ...(existing.cliRuntimes?.['claude-code'] ?? {}),
          command:
            existing.cliRuntimes?.['claude-code']?.command
            ?? defaults.cliRuntimes['claude-code'].command,
        },
      },
      lastSelectedCli: defaults.lastSelectedCli,
    }
  }
  if (version < 11) {
    const current = migrationState
    const defaults = defaultAppSettings()
    current.appSettings = {
      ...defaults,
      ...(current.appSettings ?? {}),
      cliRuntimes: {
        ...defaults.cliRuntimes,
        ...(current.appSettings?.cliRuntimes ?? {}),
        'claude-code': {
          ...defaults.cliRuntimes['claude-code'],
          ...(current.appSettings?.cliRuntimes?.['claude-code'] ?? {}),
        },
      },
      lastSelectedCli: current.appSettings?.lastSelectedCli ?? defaults.lastSelectedCli,
    }
  }
  if (version < 12) {
    const current = migrationState
    const defaults = defaultAppSettings()
    current.appSettings = {
      ...defaults,
      ...(current.appSettings ?? {}),
      cliRuntimes: {
        ...defaults.cliRuntimes,
        ...(current.appSettings?.cliRuntimes ?? {}),
      },
      lastSelectedCli: current.appSettings?.lastSelectedCli ?? defaults.lastSelectedCli,
      lastSelectedSpecialist:
        current.appSettings?.lastSelectedSpecialist ?? defaults.lastSelectedSpecialist,
    }
  }
  if (version < 13) {
    const current = migrationState
    const defaults = defaultAppSettings()
    const selectedSpecialist =
      current.appSettings?.lastSelectedSpecialist ?? defaults.lastSelectedSpecialist

    current.appSettings = {
      ...defaults,
      ...(current.appSettings ?? {}),
      cliRuntimes: {
        ...defaults.cliRuntimes,
        ...(current.appSettings?.cliRuntimes ?? {}),
      },
      lastSelectedCli: current.appSettings?.lastSelectedCli ?? defaults.lastSelectedCli,
      lastSelectedSpecialist: getSpecialistAction(selectedSpecialist).id,
    }
  }
  if (version < 14) {
    mapMigrationWorkspaces(migrationState, migrateSprintEngineLayout)
  }
  if (version < 15) {
    mapMigrationWorkspaces(migrationState, migrateSprintEngineLayout)
  }
  if (version < 16) {
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      folderMissing: false,
    }))
  }
  if (version < 17) {
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      sprintEngineAutoState: normalizeSprintEngineAutoState(ws.sprintEngineAutoState),
    }))
  }
  if (version < 18) {
    mapMigrationWorkspaces(migrationState, migrateSprintEngineAgentNames)
  }
  if (version < 19) {
    mapMigrationWorkspaces(migrationState, (ws) => {
      const sprintEngineState = normalizeSprintEngineState(ws.sprintEngineState)
      return {
        ...ws,
        sprintEngineState,
        sprintEngineContext: normalizeSprintEngineWorkspaceContext(
          (ws as Workspace & { sprintEngineContext?: SprintEngineWorkspaceContext | null }).sprintEngineContext,
          ws.folderPath,
          sprintEngineState,
        ),
      }
    })
  }
  if (version < 20) {
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      sprintEngineAutoState: normalizeSprintEngineAutoState(ws.sprintEngineAutoState),
    }))
  }
  if (version < 21) {
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      agents: Object.fromEntries(
        Object.entries(ws.agents ?? {}).map(([id, agent]) => [
          id,
          normalizeAgentState(agent),
        ]),
      ),
      worktreeState: normalizeWorkspaceWorktreeState(ws.worktreeState),
    }))
  }
  if (version < 22) {
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      sprintEngineAutoState: normalizeSprintEngineAutoState(ws.sprintEngineAutoState),
    }))
  }
  if (version < 23) {
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      sprintEngineRoleCliDefaults: ws.mode === 'sprintengine' || ws.sprintEngineState
        ? normalizeSprintEngineRoleCliDefaults(ws.sprintEngineRoleCliDefaults)
        : undefined,
    }))
  }
  if (version < 24) {
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      sprintEngineAutoState: normalizeSprintEngineAutoState(ws.sprintEngineAutoState),
    }))
  }
  if (version < 25) {
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      editorState: {
        openFiles: (ws.editorState?.openFiles ?? []).map(({ content: _content, ...file }) => ({
          ...file,
          isDirty: false,
        })),
        activeFilePath: ws.editorState?.activeFilePath ?? null,
      },
    }))
  }
  if (version < 26) {
    const current = migrationState
    const defaults = defaultAppSettings()
    current.appSettings = {
      ...defaults,
      ...(current.appSettings ?? {}),
      cliRuntimes: {
        ...defaults.cliRuntimes,
        ...(current.appSettings?.cliRuntimes ?? {}),
      },
      lastSelectedCli: current.appSettings?.lastSelectedCli ?? defaults.lastSelectedCli,
      lastSelectedSpecialist:
        current.appSettings?.lastSelectedSpecialist ?? defaults.lastSelectedSpecialist,
      searchExcludes: normalizeSearchExcludes(current.appSettings?.searchExcludes),
    }
  }
  if (version < 27) {
    const current = migrationState
    const defaults = defaultAppSettings()
    current.appSettings = {
      ...defaults,
      ...(current.appSettings ?? {}),
      cliRuntimes: {
        ...defaults.cliRuntimes,
        ...(current.appSettings?.cliRuntimes ?? {}),
      },
      lastSelectedCli: current.appSettings?.lastSelectedCli ?? defaults.lastSelectedCli,
      lastSelectedSpecialist:
        current.appSettings?.lastSelectedSpecialist ?? defaults.lastSelectedSpecialist,
      searchExcludes: normalizeSearchExcludes(current.appSettings?.searchExcludes),
      recentWorkspaceFolders: normalizeRecentWorkspaceFolders(
        current.appSettings?.recentWorkspaceFolders,
        state.workspaces.map((ws) => ws.folderPath),
      ),
    }
  }
  if (version < 28) {
    const current = migrationState
    const defaults = defaultAppSettings()
    current.appSettings = {
      ...defaults,
      ...(current.appSettings ?? {}),
      cliRuntimes: {
        ...defaults.cliRuntimes,
        ...(current.appSettings?.cliRuntimes ?? {}),
      },
      lastSelectedCli: current.appSettings?.lastSelectedCli ?? defaults.lastSelectedCli,
      lastSelectedSpecialist:
        current.appSettings?.lastSelectedSpecialist ?? defaults.lastSelectedSpecialist,
      searchExcludes: normalizeSearchExcludes(current.appSettings?.searchExcludes),
      recentWorkspaceFolders: normalizeRecentWorkspaceFolders(
        current.appSettings?.recentWorkspaceFolders,
        state.workspaces.map((ws) => ws.folderPath),
      ),
      usageTelemetry: normalizeUsageTelemetrySettings(
        current.appSettings?.usageTelemetry,
      ),
    }
  }
  if (version < 29) {
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      sprintEngineAutoState: normalizeSprintEngineAutoState(ws.sprintEngineAutoState),
    }))
  }
  if (version < 30) {
    mapMigrationWorkspaces(migrationState, (ws) => {
      const sprintEngineState = normalizeSprintEngineState(ws.sprintEngineState)
      const multiloopState = ws.multiloopState ?? null
      const mode = multiloopState ? 'multiloop' : sprintEngineState ? 'sprintengine' : ws.mode ?? 'standard'
      const nextWorkspace: Workspace = {
        ...ws,
        mode,
        sprintEngineState,
        sprintEngineContext: normalizeSprintEngineWorkspaceContext(
          ws.sprintEngineContext,
          ws.folderPath,
          sprintEngineState,
        ),
        multiloopState,
        multiloopContext: normalizeMultiloopWorkspaceContext(
          ws.multiloopContext,
          ws.folderPath,
          multiloopState,
        ),
        sprintEngineAutoState: normalizeSprintEngineAutoState(ws.sprintEngineAutoState),
        multiloopAutoState: normalizeMultiloopAutoState(ws.multiloopAutoState),
      }

      return mode === 'multiloop'
        ? { ...nextWorkspace, layoutModel: ensureMultiloopLayoutModel(nextWorkspace.layoutModel) }
        : migrateSprintEngineLayout(nextWorkspace)
    })
  }
  if (version < 31) {
    const current = migrationState
    const defaults = defaultAppSettings()
    current.appSettings = {
      ...defaults,
      ...(current.appSettings ?? {}),
      cliRuntimes: {
        ...defaults.cliRuntimes,
        ...(current.appSettings?.cliRuntimes ?? {}),
      },
      lastSelectedCli: current.appSettings?.lastSelectedCli ?? defaults.lastSelectedCli,
      lastSelectedSpecialist:
        current.appSettings?.lastSelectedSpecialist ?? defaults.lastSelectedSpecialist,
      lastSelectedMultiloopRole:
        current.appSettings?.lastSelectedMultiloopRole ?? defaults.lastSelectedMultiloopRole,
      lastAgentSpawnPermissionPreset: normalizeCliPermissionPreset(
        current.appSettings?.lastAgentSpawnPermissionPreset,
      ),
      searchExcludes: normalizeSearchExcludes(current.appSettings?.searchExcludes),
      recentWorkspaceFolders: normalizeRecentWorkspaceFolders(
        current.appSettings?.recentWorkspaceFolders,
        state.workspaces.map((ws) => ws.folderPath),
      ),
      usageTelemetry: normalizeUsageTelemetrySettings(
        current.appSettings?.usageTelemetry,
      ),
    }
  }
  if (version < 32) {
    state.workspaces = state.workspaces.map((ws) => ({
      ...ws,
      multiloopAutoState: normalizeMultiloopAutoState(ws.multiloopAutoState),
    }))
  }
  if (version < 33) {
    const current = migrationState
    current.appSettings = normalizeAppSettings(current.appSettings, state.workspaces)
  }
  if (version < 34) {
    const current = migrationState
    current.appSettings = normalizeAppSettings(current.appSettings, state.workspaces)
  }
  if (version < 35) {
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      memory: normalizeWorkspaceMemoryConfig(ws.memory),
    }))
  }
  if (version < 36) {
    // Re-run memory normalization so the bumped GRAPH_SETTINGS_VERSION
    // upgrades layout numerics (link distance, node size, forces) on
    // workspaces that pre-date the tighter defaults.
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      memory: normalizeWorkspaceMemoryConfig(ws.memory),
    }))
  }
  if (version < 39) {
    const current = migrationState
    current.appSettings = normalizeAppSettings(current.appSettings, state.workspaces)
  }
  if (version < 40) {
    mapMigrationWorkspaces(migrationState, (ws) => {
      const sprintEngineState = normalizeSprintEngineState(ws.sprintEngineState)
      const multiloopState = ws.multiloopState ?? null
      return {
        ...ws,
        mode: normalizeWorkspaceMode(ws.mode, sprintEngineState, multiloopState),
        sprintEngineState,
        multiloopState,
        sprintEngineAutoState: normalizeSprintEngineAutoState(ws.sprintEngineAutoState),
        multiloopAutoState: normalizeMultiloopAutoState(ws.multiloopAutoState),
      }
    })
  }
  if (version < 41) {
    const current = migrationState
    current.appSettings = normalizeAppSettings(current.appSettings, state.workspaces)
  }
  if (version < 42) {
    const current = migrationState
    current.appSettings = normalizeAppSettings(current.appSettings, state.workspaces)
  }
  if (version < 43) {
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      layoutModel: stripSettingsTabsFromLayout(ws.layoutModel) as Workspace['layoutModel'],
    }))
  }
  if (version < 44) {
    mapMigrationWorkspaces(migrationState, (ws) => {
      const guidedBriefState = normalizeGuidedBriefState(ws.guidedBriefState)
      if (ws.mode !== 'guided-brief' && !guidedBriefState) return ws
      return {
        ...ws,
        mode: 'guided-brief',
        guidedBriefState,
        layoutModel: ensureGuidedBriefLayoutModel(ws.layoutModel),
      }
    })
  }
  if (version < 45) {
    // v45 splits non-workspace state into APP_SETTINGS_STORAGE_KEY and adds an
    // explicit workspaceRegistryEmptyState record to the registry envelope.
    // The on-disk split is handled by the workspaceStore custom storage
    // adapter on first read; here we only backfill the in-memory field so
    // existing rehydrate paths (merge, partialize) see it.
    if (migrationState.workspaceRegistryEmptyState === undefined) {
      migrationState.workspaceRegistryEmptyState = null
    }
  }
  if (version < 46) {
    const fallbackCli = normalizeAgentCli(
      { cli: migrationState.appSettings?.lastSelectedCli },
      'claude-code',
    )
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      agents: Object.fromEntries(
        Object.entries(ws.agents ?? {}).map(([id, agent]) => [
          id,
          normalizeAgentState({ ...agent, id }, fallbackCli),
        ]),
      ),
    }))
  }
  if (version < 47) {
    mapMigrationWorkspaces(migrationState, (ws) => {
      const next = markSwitchboardAnchorTabsSticky(ws.layoutModel)
      return next ? { ...ws, layoutModel: next } : ws
    })
  }
  if (version < 48) {
    // Sprint Engine: Inbox / Roster / Tasks are now internal segmented chrome
    // inside SprintEngineBoardPanel rather than three closeable FlexLayout
    // tabs. Existing workspaces still carry the retired component IDs in
    // their persisted layout, which the renderer no longer handles — rerun
    // the SE layout migration to forward them to the single board.
    mapMigrationWorkspaces(migrationState, migrateSprintEngineLayout)
  }
  if (version < 49) {
    // The SE board tabset's FlexLayout tab strip is redundant once the
    // workspace top bar carries the icon segmented nav. Stamp
    // enableTabStrip: false onto the tabset that wraps the 'sprintengine'
    // board in existing layouts without rewriting custom arrangements.
    mapMigrationWorkspaces(migrationState, (ws) => {
      const next = hideSprintEngineBoardTabStrip(ws.layoutModel)
      return next ? { ...ws, layoutModel: next } : ws
    })
  }
  if (version < 50) {
    // Switchboard workspaces now anchor on a single 'switchboard-workspace'
    // wrapper whose internal icon sub-nav switches between Watchtower and
    // Switchboard. Forward existing layouts that still ship the two
    // separate component tabs to the wrapper shape.
    mapMigrationWorkspaces(migrationState, (ws) => {
      const next = consolidateSwitchboardWorkspaceLayout(ws.layoutModel)
      return next ? { ...ws, layoutModel: next } : ws
    })
  }
  if (version < 58) {
    // One-time local repair for development snapshots that still carried the
    // removed Sprint Engine automation boolean mirrors. Run before older
    // automation normalization steps so pre-v53 snapshots do not lose intent.
    mapMigrationWorkspaces(migrationState, repairSprintEngineAutomationLifecycleState)
  }
  if (version < 59) {
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      fileExplorerState: normalizeWorkspaceFileExplorerState(ws.fileExplorerState),
    }))
  }
  if (version < 51) {
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      sprintEngineAutoState: normalizeSprintEngineAutoState(ws.sprintEngineAutoState),
    }))
  }
  if (version < 52) {
    // The guided brief panel owns its own step nav, so the FlexLayout tab
    // strip on the tabset that wraps the 'guided-brief' tab is redundant
    // chrome. Stamp enableTabStrip: false onto existing layouts without
    // touching custom arrangements, matching the Sprint Engine pattern.
    mapMigrationWorkspaces(migrationState, (ws) => {
      const next = hideGuidedBriefTabStrip(ws.layoutModel)
      return next ? { ...ws, layoutModel: next } : ws
    })
  }
  if (version < 53) {
    // Normalize automation state (the normalizer also drops any legacy
    // transient spawn bookkeeping).
    mapMigrationWorkspaces(migrationState, (ws) => ({
      ...ws,
      sprintEngineAutoState: normalizeSprintEngineAutoState(ws.sprintEngineAutoState),
    }))
  }
  if (version < 54) {
    // Files / Git / Knowledge Graph are now exclusive strip-less switches that
    // share one left pane; the sidebar PanelRail carries their selection chrome,
    // so the FlexLayout tab strip on a nav-only tabset is redundant. Stamp
    // enableTabStrip: false onto existing layouts' nav-only tabsets without
    // touching mixed tabsets (those self-heal on the next rail toggle).
    mapMigrationWorkspaces(migrationState, (ws) => {
      const next = hideNavRailTabStrip(ws.layoutModel)
      return next ? { ...ws, layoutModel: next } : ws
    })
  }
  if (version < 55) {
    const normalized = normalizeWorkspaceWindows(
      migrationState.workspaces,
      migrationState.workspaceWindows,
      migrationState.primaryWorkspaceWindowId,
      migrationState.activeWorkspaceId,
    )
    migrationState.workspaceWindows = normalized.windows
    migrationState.primaryWorkspaceWindowId = normalized.primaryWorkspaceWindowId
  }
  if (version < 56) {
    // v56 adds appSettings.voiceDictation; normalize so existing installs pick
    // up the default Whisper/server configuration.
    const current = migrationState
    current.appSettings = normalizeAppSettings(current.appSettings, state.workspaces)
  }
  if (version < 57) {
    // Sprint Engine roster membership is durable, but app-owned terminal
    // processes are not. Clear stale launch intent so reopening Multicode or
    // restoring an agent tab does not spawn autonomous agents.
    mapMigrationWorkspaces(migrationState, clearSprintEngineAgentLaunchState)
  }
  if (version < 60) {
    // The Sprint Engines survey moved from the per-workspace nav rail to the
    // app-level right aside (SprintEnginesAside); strip the retired
    // 'sprint-engines' tab from persisted layouts so it cannot render as an
    // empty surface.
    mapMigrationWorkspaces(migrationState, (ws) => {
      const next = stripSprintEnginesNavFromLayout(ws.layoutModel)
      return next === ws.layoutModel ? ws : { ...ws, layoutModel: next as Workspace['layoutModel'] }
    })
  }
  if (version < 61) {
    // Sprint Engine run permissions are local operator preferences. Older
    // workspaces kept them only on workspace auto-state, while mounted Backlog
    // runs could keep the factory default even after the app-level default was
    // changed. Seed a local per-run settings map by run.yaml path, then hydrate
    // each saved Sprint Engine workspace from it.
    const current = migrationState
    const hydrated = hydrateSprintEngineLocalRunSettings(
      current.workspaces,
      normalizeAppSettings(current.appSettings, current.workspaces),
    )
    current.workspaces = hydrated.workspaces
    current.appSettings = hydrated.appSettings
  }
  if (version < 62) {
    // Automations is now a global app screen (a content-area destination), not
    // a workspace type. Drop any persisted automations workspaces: their only
    // content was the locked control-center tab — every automation definition
    // and run history lives on disk under each project's
    // `.multi-code/automations/`, so nothing the user authored is lost. Window
    // membership and the active-workspace pointer are reconciled against the
    // surviving workspaces by normalizeWorkspaceWindows during merge.
    migrationState.workspaces = (migrationState.workspaces ?? []).filter(
      (ws) => ws.mode !== 'automations',
    )
    // Don't leave the active pointer dangling at a dropped automations workspace.
    // (Window-level active ids are reconciled by normalizeWorkspaceWindows; this
    // keeps the top-level pointer honest too.)
    if (
      migrationState.activeWorkspaceId
      && !migrationState.workspaces.some((ws) => ws.id === migrationState.activeWorkspaceId)
    ) {
      migrationState.activeWorkspaceId = migrationState.workspaces[0]?.id ?? null
    }
  }
  if (version < 63) {
    // The per-project Automations host is one-per-folder, but before v63 the
    // automation executor could not see restored hosts' modes on the sync bus
    // (main rehydrated every workspace as 'standard'), so each restart's first
    // run minted a duplicate host. Keep the earliest-created host per folder —
    // the one the user most likely arranged — and drop the duplicates. Nothing
    // durable is lost: automation definitions and run history live on disk under
    // each project's `.multi-code/automations/`, and host agents are finalized
    // runs whose launch state is cleared on load anyway. Window membership is
    // reconciled by normalizeWorkspaceWindows during merge.
    const keptHostByFolder = new Map<string, WorkspaceId>()
    const folderKey = (value: string | null | undefined): string | null => {
      const trimmed = value?.trim()
      return trimmed ? trimmed.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase() : null
    }
    const hosts = (migrationState.workspaces ?? []).filter((ws) => ws.mode === 'automations-host')
    for (const host of [...hosts].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))) {
      const key = folderKey(host.folderPath)
      if (key === null) continue
      if (!keptHostByFolder.has(key)) keptHostByFolder.set(key, host.id)
    }
    migrationState.workspaces = (migrationState.workspaces ?? []).filter((ws) => {
      if (ws.mode !== 'automations-host') return true
      const key = folderKey(ws.folderPath)
      return key === null || keptHostByFolder.get(key) === ws.id
    })
    if (
      migrationState.activeWorkspaceId
      && !migrationState.workspaces.some((ws) => ws.id === migrationState.activeWorkspaceId)
    ) {
      migrationState.activeWorkspaceId = migrationState.workspaces[0]?.id ?? null
    }
  }
  if (version < 64) {
    // Re-run the v63 host dedupe via the shared normalizer. v63 could be
    // bypassed: backup recovery and cross-window storage sync both apply
    // workspace lists without the migrate ladder, and the next persist write
    // stamped the un-deduped state with the current version — leaving stores
    // at v63 that still hold one host per automation run. The shared helper
    // also restores the kept host's stable 'Automations' name, which v63 left
    // branded after whichever run minted it.
    migrationState.workspaces = dedupeAutomationsHostWorkspaces(migrationState.workspaces ?? [])
    if (
      migrationState.activeWorkspaceId
      && !migrationState.workspaces.some((ws) => ws.id === migrationState.activeWorkspaceId)
    ) {
      migrationState.activeWorkspaceId = migrationState.workspaces[0]?.id ?? null
    }
  }

  return state as never
}
