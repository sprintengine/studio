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
import { normalizeSprintEngineState } from '../../utils/sprintengine'
import { defaultEditorState, normalizeAgentCli, normalizeAgentState } from './agentsSlice'
import {
  ensureGuidedBriefLayoutModel,
  normalizeGuidedBriefState,
} from './guidedBriefSlice'
import {
  consolidateSwitchboardWorkspaceLayout,
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
  normalizeSprintEngineAutoState,
  normalizeSprintEngineRoleCliDefaults,
  normalizeSprintEngineWorkspaceContext,
  reconcileSprintEngineAgents,
} from './runStateSlice'
import {
  defaultAppSettings,
  normalizeAppSettings,
  normalizeAgentSpawnPermissionPreset,
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
  dropRetiredMultiloopWorkspaces,
  dropRetiredRoadmapWorkspaces,
  mapMigrationWorkspaces,
} from './normalizers'
import { reconcileWorkspaceModuleState } from './workspaceModuleState'

export const WORKSPACE_STORAGE_KEY = 'multicode-workspaces'
export const APP_SETTINGS_STORAGE_KEY = 'multicode-app-settings'
export const WORKSPACE_STORE_VERSION = 72
export const PRIMARY_WORKSPACE_WINDOW_ID: WorkspaceWindowId = 'primary'
const LEGACY_WORKSPACE_STORAGE_KEY = ['free', 'ai', 'ide', 'workspaces'].join('-')

export type WorkspaceMigrationState = {
  workspaces: Workspace[]
  activeWorkspaceId?: WorkspaceId | null
  workspaceWindows?: WorkspaceWindowState[]
  primaryWorkspaceWindowId?: WorkspaceWindowId
  // Retired keys stay declared here so the migrations that read or delete them
  // are typed rather than cast: `cliCommands` (pre-v10 CLI commands),
  // `sprintEngineModelCatalog` (the model catalog retired in MC-1890), and
  // `lastSelectedSpecialist` / `lastSpawnWasGeneral` (the top-bar picker's
  // remembered default, retired in MC-2222).
  appSettings?: Partial<AppSettings> & {
    cliCommands?: Partial<Record<AgentCli, string>>
    sprintEngineModelCatalog?: unknown
    lastSelectedSpecialist?: unknown
    lastSpawnWasGeneral?: unknown
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
    // `manual` is the neutral value normalizeSprintEngineAutoState lands on when
    // a workspace carries no explicit choice, so it is the "no local override"
    // sentinel here — the role `default` played before MC-2210.
    cliPermissionPreset: autoState.cliPermissionPreset === 'manual'
      ? fallbackPermissionPreset
      : autoState.cliPermissionPreset,
    maxConcurrentAgents: autoState.maxConcurrentAgents,
  }
}

function hasPersistableSprintEngineRunSettings(runSettings: SprintEngineRunSettings): boolean {
  return runSettings.cliPermissionPreset !== undefined && runSettings.cliPermissionPreset !== 'manual'
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

// The persisted-state classifier moved to `src/shared/workspace-registry.ts`
// (MC-2158) so main's registry hydration and this window's wipe guard share one
// implementation instead of two that can drift — main refuses to seed on
// exactly the classifications the guard refuses to overwrite on. Re-exported
// here because the renderer's import sites (and the store's public surface)
// name it from this module.
export {
  classifyPersistedWorkspaceState,
  isDangerousEmptyClassification,
} from '../../../../shared/workspace-registry'
import type { PersistedStateClassification } from '../../../../shared/workspace-registry'
export type { PersistedStateClassification }

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
    }
  }
  if (version < 13) {
    // This rung used to re-key the remembered top-bar specialist onto the
    // registry role id. That field retired with the top-bar picker (MC-2222,
    // dropped at v72), so the rung keeps only its shape-preserving half.
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
      const mode = sprintEngineState ? 'sprintengine' : ws.mode ?? 'standard'
      const nextWorkspace: Workspace = {
        ...ws,
        mode,
        sprintEngineState,
        sprintEngineContext: normalizeSprintEngineWorkspaceContext(
          ws.sprintEngineContext,
          ws.folderPath,
          sprintEngineState,
        ),
        sprintEngineAutoState: normalizeSprintEngineAutoState(ws.sprintEngineAutoState),
      }

      return migrateSprintEngineLayout(nextWorkspace)
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
      lastAgentSpawnPermissionPreset: normalizeAgentSpawnPermissionPreset(
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
      return {
        ...ws,
        mode: normalizeWorkspaceMode(ws.mode, sprintEngineState),
        sprintEngineState,
        sprintEngineAutoState: normalizeSprintEngineAutoState(ws.sprintEngineAutoState),
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
    // The Sprint Engines survey left the per-workspace nav rail (it is the
    // Sprints door surface now); strip the retired 'sprint-engines' tab from
    // persisted layouts so it cannot render as an empty surface.
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
  if (version < 65) {
    // The `roadmap` workspace mode retired (MC-1692): Roadmap is now an
    // instance-global sidebar surface, not a per-project workspace you mint from
    // the picker. Drop any persisted roadmap-mode workspace — its only content
    // was the board lens, and the roadmap plan itself lives on disk under the
    // home project's `backlog/roadmaps/`, read by the global surface, so nothing
    // the user authored is lost. Window membership is reconciled by
    // normalizeWorkspaceWindows during merge; keep the top-level active pointer
    // honest too (mirrors the v62 automations-mode drop).
    migrationState.workspaces = dropRetiredRoadmapWorkspaces(migrationState.workspaces ?? [])
    if (
      migrationState.activeWorkspaceId
      && !migrationState.workspaces.some((ws) => ws.id === migrationState.activeWorkspaceId)
    ) {
      migrationState.activeWorkspaceId = migrationState.workspaces[0]?.id ?? null
    }
  }
  if (version < 66) {
    // The `multiloop` workspace mode retired: the Multiloop feature was removed
    // outright (the Roadmap/Horizon door replaces it). Drop any persisted
    // multiloop-mode workspace — any loop state on disk under the project folder
    // is untouched. Window membership is reconciled by normalizeWorkspaceWindows
    // during merge; keep the top-level active pointer honest too (mirrors the
    // v65 roadmap-mode drop above).
    migrationState.workspaces = dropRetiredMultiloopWorkspaces(migrationState.workspaces ?? [])
    if (
      migrationState.activeWorkspaceId
      && !migrationState.workspaces.some((ws) => ws.id === migrationState.activeWorkspaceId)
    ) {
      migrationState.activeWorkspaceId = migrationState.workspaces[0]?.id ?? null
    }
  }
  if (version < 67) {
    // The Design Wizard conversation transport became opt-in only, but the
    // pre-flip default was `true` and persist had already written it to every
    // existing profile — so the whole installed base kept taking the
    // Claude-only conversation path without ever choosing it. Reset the
    // persisted opt-in once and stamp the profile: a stored `true` cannot be
    // told apart from the old default, and re-enabling it is a single toggle.
    // normalizeAppSettings owns the rule (persist merge runs it on every
    // hydration, which is what catches current-version envelopes this ladder
    // never revisits); this step just gives clean upgrades the same result.
    const current = migrationState
    current.appSettings = normalizeAppSettings(current.appSettings, state.workspaces)
  }
  if (version < 68) {
    // The Sprint Engine model catalog retired (MC-1890): the Settings section
    // where each CLI+model carried hand-set intelligence / frontendDesign /
    // mobile / speed / cost axes is gone, and its last two live readers went
    // with the architect-decides-staffing formation (MC-1889). Drop the
    // persisted array so an upgraded profile stops carrying scores nothing
    // reads. Nothing the user chose is lost: per-role models live on the saved
    // roster and per-CLI model ids in `cliRuntimes[cli].models`.
    // Deleting the key here is the clean-upgrade half; normalizeAppSettings is
    // the enforcement half — it builds every field explicitly and never spreads
    // the persisted object, and persist merge() runs it on every hydration, so
    // the slice also cannot survive inside a current-version envelope this
    // ladder never revisits (a dev-HMR module swap stamps exactly that).
    if (migrationState.appSettings) delete migrationState.appSettings.sprintEngineModelCatalog
  }
  if (version < 69) {
    // `cliModelCatalog` arrives with this version: what each agent CLI last
    // reported about its own models, separate from the user's own ids in
    // `cliRuntimes[cli].models`. Nothing on disk carries one yet, so this rung
    // is the clean-upgrade half only — it runs the normalizer once so an
    // upgraded profile is stamped with the shape the pickers merge. The
    // enforcement half is normalizeAppSettings itself: persist merge() runs it
    // on every hydration, so a hand-edited or dev-written catalog cannot ride
    // into the pickers inside a current-version envelope this ladder will never
    // revisit (same split as the v67/v68 rungs above).
    const current = migrationState
    current.appSettings = normalizeAppSettings(current.appSettings, state.workspaces)
  }
  if (version < 70) {
    // Reasoning effort arrives with this version: `AgentCliModelSelection`
    // gains an optional per-CLI `reasoning` level, so a stored selection may
    // now legitimately carry an empty model (the CLI's default model at a
    // chosen effort). No profile on disk has one yet, so this rung is the
    // clean-upgrade half only. The enforcement half is normalizeAppSettings —
    // persist merge() runs it on every hydration, which is what keeps a
    // hand-edited or dev-written level (e.g. a blank one, or a selection with
    // neither model nor level) out of the pickers and out of launch argv
    // inside a current-version envelope this ladder will never revisit (same
    // split as the v67/v68/v69 rungs above).
    const current = migrationState
    current.appSettings = normalizeAppSettings(current.appSettings, state.workspaces)
  }
  if (version < 71) {
    // The per-module workspace-state bag arrives with this version (MC-1573):
    // `Workspace.moduleState` keyed by module id, with `sprintengine` as the
    // first migrated field (the legacy `sprintEngineState` field stays as a
    // store-maintained mirror for its in-tree readers). Persisted rows carry a
    // null run state and no bag — partialize strips both homes — so this rung
    // is the clean-upgrade half only: it reconciles any row that does carry
    // one representation (ancient pre-strip profiles, hand-edited state). The
    // enforcement half is reconcileWorkspaceModuleState in persist merge(),
    // which runs on every hydration and therefore also heals current-version
    // envelopes this ladder never revisits (the dev-HMR trap, same split as
    // the v67-v70 rungs above).
    mapMigrationWorkspaces(migrationState, reconcileWorkspaceModuleState)
  }
  if (version < 72) {
    // The title bar's specialist split-button is gone (MC-2222), and with it
    // the remembered-specialist default it repeated: `lastSelectedSpecialist`
    // (factory default 'architect') and `lastSpawnWasGeneral`. That default
    // was also what preselected a specialist nobody picked in New chat, so a
    // plain Enter fetched the architect soul. No spawn surface defaults to a
    // role any more; a specialist launches only when its row or shortcut is
    // chosen explicitly. Drop both keys so an upgraded profile stops carrying
    // a role nothing reads. Same split as v68: this is the clean-upgrade
    // half, and normalizeAppSettings — which builds every field explicitly
    // and never spreads the persisted object — is the enforcement half for
    // envelopes this ladder never revisits.
    if (migrationState.appSettings) {
      delete migrationState.appSettings.lastSelectedSpecialist
      delete migrationState.appSettings.lastSpawnWasGeneral
    }
  }

  return state as never
}
