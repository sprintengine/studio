import type {
  AgentCli,
  AppSettings,
  SprintEngineWorkspaceContext,
  Workspace,
  WorkspaceId,
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
  hideSprintEngineBoardTabStrip,
  markSwitchboardAnchorTabsSticky,
  migrateSprintEngineLayout,
  sprintEngineTabsLayoutModel,
  stripSettingsTabsFromLayout,
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
  normalizeUsageTelemetrySettings,
} from './settingsSlice'
import { normalizeWorkspaceMode } from './workspacesSlice'
import { normalizeWorkspaceWorktreeState } from './worktreesSlice'
import { mapMigrationWorkspaces } from './normalizers'

export const WORKSPACE_STORAGE_KEY = 'multicode-workspaces'
export const APP_SETTINGS_STORAGE_KEY = 'multicode-app-settings'
export const WORKSPACE_STORE_VERSION = 52
const LEGACY_WORKSPACE_STORAGE_KEY = ['free', 'ai', 'ide', 'workspaces'].join('-')

export type WorkspaceMigrationState = {
  workspaces: Workspace[]
  activeWorkspaceId?: WorkspaceId | null
  appSettings?: Partial<AppSettings> & {
    cliCommands?: Partial<Record<AgentCli, string>>
  }
  sidebarCollapsed?: boolean
  workspaceRegistryEmptyState?: import('../../types/workspace').WorkspaceRegistryEmptyState | null
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
      'claude',
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
  if (version < 51) {
    mapMigrationWorkspaces(migrationState, (ws) => {
      const sprintEngineAutoState = normalizeSprintEngineAutoState(ws.sprintEngineAutoState)
      return {
        ...ws,
        sprintEngineAutoState: {
          ...sprintEngineAutoState,
          supervisorEnabled: false,
          enabled: false,
          pendingSpawns: [],
        },
      }
    })
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

  return state as never
}
