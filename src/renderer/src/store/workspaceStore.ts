import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import type { IJsonModel } from 'flexlayout-react'
import { nanoid } from 'nanoid'
import type {
  Workspace,
  WorkspaceId,
  LayoutTemplate,
  AgentState,
  AgentId,
  EditorState,
  SwarmAutoPendingSpawn,
  SwarmAutoState,
  SwarmCliPermissionPreset,
  MultiloopAutoPendingSpawn,
  MultiloopAutoState,
  SwarmState,
  SwarmWorkspaceContext,
  MultiloopState,
  MultiloopWorkspaceContext,
  SwarmRole,
  SwarmRoleCliDefaults,
  AgentCli,
  AppSettings,
  UsageTelemetrySettings,
  CliRuntimeSettings,
  AgentKind,
  SpecialistActionId,
  MultiloopAgentSoulRole,
  AgentExecution,
  WorkspaceWorktreeState,
  WorktreeEntry,
  WorkspaceMemoryConfig,
  MemoryGraphSettings,
} from '../types/workspace'
import {
  DEFAULT_GRAPH_SETTINGS,
  normalizeGraphSettings,
} from '../components/memory/memoryGraphTypes'
import { getSpecialistAction } from '../specialists/specialistActions'
import { pickRandomAgentName } from '../utils/agentNames'
import { detectLanguage } from '../utils/files'
import {
  buildSwarmAgentRosterForState,
  createDefaultSwarmRoleCounts,
  createInitialSwarmState,
  getNextSwarmAgentId,
  normalizeSwarmState,
} from '../utils/sprintengine'
import {
  getSwarmDirectoryPath,
  getSwarmStateFilePath,
  slugifySwarmName,
} from '../utils/sprintengineStateFile'
import {
  getMultiloopDirectoryPath,
  getMultiloopStateFilePath,
  slugifyMultiloopName,
} from '../utils/multiloopStateFile'
import {
  deleteEditorBuffer,
  remapEditorBuffers,
  removeEditorBuffersForPath,
  setEditorBuffer,
} from '../utils/editorBuffers'

const WORKSPACE_STORAGE_KEY = 'multicode-workspaces'
const LEGACY_WORKSPACE_STORAGE_KEY = ['free', 'ai', 'ide', 'workspaces'].join('-')
const MAX_RECENT_WORKSPACE_FOLDERS = 12

function migrateLegacyWorkspaceStorageKey(): void {
  try {
    if (typeof window === 'undefined') return
    if (window.localStorage.getItem(WORKSPACE_STORAGE_KEY)) return

    const legacyState = window.localStorage.getItem(LEGACY_WORKSPACE_STORAGE_KEY)
    if (legacyState) window.localStorage.setItem(WORKSPACE_STORAGE_KEY, legacyState)
  } catch {
    // Persist will fall back to a fresh store if localStorage is unavailable.
  }
}

migrateLegacyWorkspaceStorageKey()

interface WorkspaceStore {
  workspaces: Workspace[]
  activeWorkspaceId: WorkspaceId | null
  appSettings: AppSettings
  authState: MulticodeAuthState
  setAuthState: (authState: MulticodeAuthState) => void
  setCliRuntime: (cli: AgentCli, update: Partial<CliRuntimeSettings>) => void
  setLastSelectedCli: (cli: AgentCli) => void
  setLastSelectedSpecialist: (specialistId: SpecialistActionId) => void
  setLastSelectedMultiloopRole: (role: MultiloopAgentSoulRole) => void
  setLastAgentSpawnPermissionPreset: (preset: SwarmCliPermissionPreset) => void
  setSearchExcludes: (patterns: string[]) => void
  setUsageTelemetrySettings: (update: Partial<UsageTelemetrySettings>) => void
  addWorkspace: (
    template: LayoutTemplate,
    options?: {
      name?: string
      folderPath?: string | null
      swarmState?: SwarmState | null
      swarmContext?: SwarmWorkspaceContext | null
      multiloopState?: MultiloopState | null
      multiloopContext?: MultiloopWorkspaceContext | null
      swarmRoleCliDefaults?: SwarmRoleCliDefaults | null
      swarmAutoState?: Partial<SwarmAutoState> | null
      multiloopAutoState?: Partial<MultiloopAutoState> | null
    }
  ) => WorkspaceId
  removeWorkspace: (id: WorkspaceId) => void
  renameWorkspace: (id: WorkspaceId, name: string) => void
  setActiveWorkspace: (id: WorkspaceId) => void
  updateLayout: (id: WorkspaceId, model: IJsonModel) => void
  setFolderPath: (id: WorkspaceId, folderPath: string | null) => void
  setSwarmContext: (id: WorkspaceId, swarmContext: SwarmWorkspaceContext | null) => void
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
  setSwarmState: (workspaceId: WorkspaceId, swarmState: SwarmState | null) => void
  setMultiloopState: (workspaceId: WorkspaceId, multiloopState: MultiloopState | null) => void
  setSwarmAutoEnabled: (workspaceId: WorkspaceId, enabled: boolean) => void
  setSwarmAutoApproveArtifacts: (workspaceId: WorkspaceId, autoApproveArtifacts: boolean) => void
  setSwarmKeepDoneAgentTerminals: (workspaceId: WorkspaceId, keepDoneAgentTerminals: boolean) => void
  setSwarmCliPermissionPreset: (
    workspaceId: WorkspaceId,
    cliPermissionPreset: SwarmCliPermissionPreset
  ) => void
  setSwarmAutoPendingSpawns: (
    workspaceId: WorkspaceId,
    pendingSpawns: SwarmAutoPendingSpawn[]
  ) => void
  setMultiloopAutoEnabled: (workspaceId: WorkspaceId, enabled: boolean) => void
  setMultiloopCliPermissionPreset: (
    workspaceId: WorkspaceId,
    cliPermissionPreset: SwarmCliPermissionPreset
  ) => void
  setMultiloopAutoPendingSpawns: (
    workspaceId: WorkspaceId,
    pendingSpawns: MultiloopAutoPendingSpawn[]
  ) => void
  setMultiloopCoordinatorAutoSpawnKey: (workspaceId: WorkspaceId, key: string | null) => void
  addSwarmMember: (
    workspaceId: WorkspaceId,
    role: SwarmRole
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
}

const defaultAppSettings = (): AppSettings => ({
  cliRuntimes: {
    codex: { command: 'codex', useWsl: false },
    claude: {
      command: 'claude',
      useWsl: typeof window !== 'undefined' && window.api?.platform === 'win32',
    },
  },
  lastSelectedCli: 'claude',
  lastSelectedSpecialist: 'architect',
  lastSelectedMultiloopRole: 'coordinator',
  lastAgentSpawnPermissionPreset: 'default',
  searchExcludes: [],
  recentWorkspaceFolders: [],
  usageTelemetry: defaultUsageTelemetrySettings(),
})

function normalizeAppSettings(settings: Partial<AppSettings> | undefined, workspaces: Workspace[]): AppSettings {
  const defaults = defaultAppSettings()
  return {
    ...defaults,
    cliRuntimes: {
      ...defaults.cliRuntimes,
      ...(settings?.cliRuntimes ?? {}),
    },
    lastSelectedCli: settings?.lastSelectedCli ?? defaults.lastSelectedCli,
    lastSelectedSpecialist: settings?.lastSelectedSpecialist ?? defaults.lastSelectedSpecialist,
    lastSelectedMultiloopRole: settings?.lastSelectedMultiloopRole ?? defaults.lastSelectedMultiloopRole,
    lastAgentSpawnPermissionPreset: normalizeCliPermissionPreset(settings?.lastAgentSpawnPermissionPreset),
    searchExcludes: normalizeSearchExcludes(settings?.searchExcludes),
    recentWorkspaceFolders: normalizeRecentWorkspaceFolders(
      settings?.recentWorkspaceFolders,
      workspaces.map((ws) => ws.folderPath)
    ),
    usageTelemetry: normalizeUsageTelemetrySettings(settings?.usageTelemetry),
  }
}

function defaultUsageTelemetrySettings(): UsageTelemetrySettings {
  return {
    sendUsageData: false,
    localDevExportEnabled: import.meta.env.DEV,
    lastExportAt: null,
    exportDiagnostics: true,
  }
}

function normalizeUsageTelemetrySettings(settings: unknown): UsageTelemetrySettings {
  const defaults = defaultUsageTelemetrySettings()
  if (!settings || typeof settings !== 'object') return defaults

  const candidate = settings as Partial<UsageTelemetrySettings>
  return {
    sendUsageData:
      typeof candidate.sendUsageData === 'boolean'
        ? candidate.sendUsageData
        : defaults.sendUsageData,
    localDevExportEnabled:
      typeof candidate.localDevExportEnabled === 'boolean'
        ? candidate.localDevExportEnabled
        : defaults.localDevExportEnabled,
    lastExportAt:
      typeof candidate.lastExportAt === 'string' || candidate.lastExportAt === null
        ? candidate.lastExportAt
        : defaults.lastExportAt,
    exportDiagnostics:
      typeof candidate.exportDiagnostics === 'boolean'
        ? candidate.exportDiagnostics
        : defaults.exportDiagnostics,
  }
}

function normalizeSearchExcludes(patterns: unknown): string[] {
  if (!Array.isArray(patterns)) return []
  const seen = new Set<string>()
  const normalized: string[] = []

  patterns.forEach((pattern) => {
    if (typeof pattern !== 'string') return
    const value = pattern.trim().replace(/\\/g, '/').replace(/^!+/u, '')
    if (!value || seen.has(value)) return
    seen.add(value)
    normalized.push(value)
  })

  return normalized.slice(0, 100)
}

function normalizeRecentWorkspaceFolders(
  folders: unknown,
  additionalFolders: unknown = []
): string[] {
  const candidates = [
    ...(Array.isArray(folders) ? folders : []),
    ...(Array.isArray(additionalFolders) ? additionalFolders : []),
  ]
  const seen = new Set<string>()
  const normalized: string[] = []

  candidates.forEach((folder) => {
    if (typeof folder !== 'string') return
    const value = folder.trim()
    if (!value) return

    const key = value.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase() || value
    if (seen.has(key)) return
    seen.add(key)
    normalized.push(value)
  })

  return normalized.slice(0, MAX_RECENT_WORKSPACE_FOLDERS)
}

const defaultAuthState = (): MulticodeAuthState => ({
  authenticated: false,
  user: null,
  selectedOrganization: null,
  entitlements: null,
  status: 'checking',
  entitlementStatus: 'missing',
  message: null,
  lastRefreshAt: null,
  graceExpiresAt: null,
})

const defaultAgentExecution = (): AgentExecution => ({
  mode: 'current_workspace',
  worktreeId: null,
  cwd: null,
})

function normalizeAgentExecution(input: Partial<AgentExecution> | null | undefined): AgentExecution {
  const mode = input?.mode === 'worktree' ? 'worktree' : 'current_workspace'
  const worktreeId = typeof input?.worktreeId === 'string' && input.worktreeId.trim()
    ? input.worktreeId.trim()
    : null
  const cwd = typeof input?.cwd === 'string' && input.cwd.trim()
    ? input.cwd
    : null

  if (mode === 'current_workspace') return defaultAgentExecution()

  return {
    mode,
    worktreeId,
    cwd,
  }
}

const defaultWorkspaceWorktreeState = (): WorkspaceWorktreeState => ({
  containerPath: null,
  entries: {},
  updatedAt: null,
})

const defaultWorkspaceMemoryConfig = (): WorkspaceMemoryConfig => ({
  relativeRoot: null,
  graphSettings: { ...DEFAULT_GRAPH_SETTINGS },
})

function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\')
}

function normalizeMemoryRelativeRoot(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/u, '')
  if (!normalized || normalized === '.' || isAbsolutePath(normalized)) return null
  return normalized
}

function normalizeWorkspaceMemoryConfig(
  input: Partial<WorkspaceMemoryConfig> | null | undefined
): WorkspaceMemoryConfig {
  return {
    relativeRoot: normalizeMemoryRelativeRoot(input?.relativeRoot),
    graphSettings: normalizeGraphSettings(input?.graphSettings),
  }
}

function normalizeWorktreeEntry(input: Partial<WorktreeEntry> | null | undefined): WorktreeEntry | null {
  if (!input || typeof input.id !== 'string' || !input.id.trim()) return null
  if (typeof input.path !== 'string' || !input.path.trim()) return null

  const status = (
    input.status === 'assigned'
    || input.status === 'missing'
    || input.status === 'removing'
    || input.status === 'error'
  )
    ? input.status
    : 'available'
  const now = Date.now()

  return {
    id: input.id.trim(),
    path: input.path,
    branch: typeof input.branch === 'string' && input.branch.trim() ? input.branch : null,
    ownerAgentId:
      typeof input.ownerAgentId === 'string' && input.ownerAgentId.trim()
        ? input.ownerAgentId
        : null,
    status,
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : now,
    missingAt:
      status === 'missing'
        ? typeof input.missingAt === 'number'
          ? input.missingAt
          : now
        : null,
  }
}

function normalizeWorkspaceWorktreeState(
  input: Partial<WorkspaceWorktreeState> | null | undefined
): WorkspaceWorktreeState {
  const entries = Object.fromEntries(
    Object.values(input?.entries ?? {})
      .map((entry) => normalizeWorktreeEntry(entry))
      .filter((entry): entry is WorktreeEntry => Boolean(entry))
      .map((entry) => [entry.id, entry])
  )

  return {
    containerPath:
      typeof input?.containerPath === 'string' && input.containerPath.trim()
        ? input.containerPath
        : null,
    entries,
    updatedAt: typeof input?.updatedAt === 'number' ? input.updatedAt : null,
  }
}

const defaultAgent = (id: AgentId, name = id, kind: AgentKind = 'general'): AgentState => ({
  id,
  name,
  status: 'idle',
  execution: defaultAgentExecution(),
  messages: [],
  streamBuffer: '',
  cliSessionId: undefined,
  cliStartRequested: false,
  cliRestartNonce: 0,
  cliHasLaunched: false,
  cliOnboardingPromptSent: false,
  cliResumeAvailable: false,
  cli: 'codex' as AgentCli,
  cliPermissionPreset: 'default',
  cliStartupPrompt: undefined,
  kind,
  specialistId: undefined,
  multiloopRole: undefined,
})

const defaultEditorState = (): EditorState => ({
  openFiles: [],
  activeFilePath: null,
})

const defaultSwarmAutoState = (): SwarmAutoState => ({
  enabled: false,
  autoApproveArtifacts: false,
  keepDoneAgentTerminals: false,
  cliPermissionPreset: 'default',
  pendingSpawns: [],
})

const defaultMultiloopAutoState = (): MultiloopAutoState => ({
  enabled: false,
  cliPermissionPreset: 'default',
  maxConcurrentAgents: 1,
  coordinatorAutoSpawnKey: null,
  pendingSpawns: [],
})

const defaultSwarmRoleCliDefaults = (): Required<SwarmRoleCliDefaults> => ({
  architect: 'codex',
  product: 'codex',
  frontend: 'codex',
  developer: 'codex',
  code_reviewer: 'codex',
  performance: 'codex',
  tester: 'codex',
  security: 'codex',
})

function normalizeSwarmRoleCliDefaults(
  input: SwarmRoleCliDefaults | null | undefined
): Required<SwarmRoleCliDefaults> {
  const defaults = defaultSwarmRoleCliDefaults()
  const next = { ...defaults }

  Object.keys(defaults).forEach((role) => {
    const value = input?.[role as SwarmRole]
    if (value === 'codex' || value === 'claude') {
      next[role as SwarmRole] = value
    }
  })

  return next
}

function normalizeSwarmAutoPendingSpawn(
  input: Partial<SwarmAutoPendingSpawn> | null | undefined
): SwarmAutoPendingSpawn | null {
  return typeof input?.taskId === 'string' && typeof input.agentId === 'string'
    ? {
      taskId: input.taskId,
      agentId: input.agentId,
      ...(typeof input.startedAt === 'number' ? { startedAt: input.startedAt } : {}),
    }
    : null
}

function isMultiloopAutoRole(input: unknown): input is MultiloopAgentSoulRole {
  return input === 'coordinator'
    || input === 'architect'
    || input === 'product'
    || input === 'developer'
    || input === 'frontend'
    || input === 'tester'
    || input === 'security'
    || input === 'code_reviewer'
    || input === 'performance'
}

function normalizeMultiloopAutoPendingSpawn(
  input: Partial<MultiloopAutoPendingSpawn> | null | undefined
): MultiloopAutoPendingSpawn | null {
  if (!input || !isMultiloopAutoRole(input.role) || typeof input.agentId !== 'string') return null

  return {
    role: input.role,
    agentId: input.agentId,
    taskId: typeof input.taskId === 'string' ? input.taskId : null,
    ...(typeof input.startedAt === 'number' ? { startedAt: input.startedAt } : {}),
  }
}

function normalizeCliPermissionPreset(
  input: SwarmCliPermissionPreset | null | undefined
): SwarmCliPermissionPreset {
  return input === 'auto_workspace' || input === 'bypass_all' ? input : 'default'
}

function normalizeSwarmAutoState(
  input: (Partial<SwarmAutoState> & { pending?: SwarmAutoPendingSpawn | null }) | null | undefined
): SwarmAutoState {
  const legacyPending = normalizeSwarmAutoPendingSpawn(input?.pending)
  const pendingSpawns = Array.isArray(input?.pendingSpawns)
    ? input.pendingSpawns
      .map((pending) => normalizeSwarmAutoPendingSpawn(pending))
      .filter((pending): pending is SwarmAutoPendingSpawn => Boolean(pending))
    : legacyPending
      ? [legacyPending]
      : []
  const cliPermissionPreset = normalizeCliPermissionPreset(input?.cliPermissionPreset)

  return {
    enabled: Boolean(input?.enabled),
    autoApproveArtifacts: Boolean(input?.autoApproveArtifacts),
    keepDoneAgentTerminals: Boolean(input?.keepDoneAgentTerminals),
    cliPermissionPreset,
    pendingSpawns,
  }
}

function normalizeMultiloopAutoState(
  input: Partial<MultiloopAutoState> | null | undefined
): MultiloopAutoState {
  const pendingSpawns = Array.isArray(input?.pendingSpawns)
    ? input.pendingSpawns
      .map((pending) => normalizeMultiloopAutoPendingSpawn(pending))
      .filter((pending): pending is MultiloopAutoPendingSpawn => Boolean(pending))
    : []

  const maxConcurrentAgents =
    typeof input?.maxConcurrentAgents === 'number' && Number.isFinite(input.maxConcurrentAgents)
      ? Math.max(1, Math.min(4, Math.floor(input.maxConcurrentAgents)))
      : 1

  return {
    enabled: Boolean(input?.enabled),
    cliPermissionPreset: normalizeCliPermissionPreset(input?.cliPermissionPreset),
    maxConcurrentAgents,
    coordinatorAutoSpawnKey:
      typeof input?.coordinatorAutoSpawnKey === 'string'
        ? input.coordinatorAutoSpawnKey
        : null,
    pendingSpawns,
  }
}

function createSwarmWorkspaceContext(
  folderPath: string | null | undefined,
  teamName: string | null | undefined,
  teamSlug?: string | null
): SwarmWorkspaceContext | null {
  if (!folderPath || !teamName?.trim()) return null

  const slug = teamSlug?.trim() || slugifySwarmName(teamName)
  return {
    teamName: teamName.trim(),
    teamSlug: slug,
    teamDirectoryPath: getSwarmDirectoryPath(folderPath, slug),
    statePath: getSwarmStateFilePath(folderPath, slug),
  }
}

function normalizeSwarmWorkspaceContext(
  input: Partial<SwarmWorkspaceContext> | null | undefined,
  folderPath: string | null | undefined,
  swarmState: SwarmState | null
): SwarmWorkspaceContext | null {
  if (!swarmState) return null

  if (input?.teamSlug && input.teamName) {
    return createSwarmWorkspaceContext(folderPath, input.teamName, input.teamSlug)
  }

  return createSwarmWorkspaceContext(folderPath, swarmState?.name)
}

function createMultiloopWorkspaceContext(
  folderPath: string | null | undefined,
  loopName: string | null | undefined,
  loopSlug?: string | null
): MultiloopWorkspaceContext | null {
  if (!folderPath || !loopName?.trim()) return null

  const slug = loopSlug?.trim() || slugifyMultiloopName(loopName)
  return {
    loopName: loopName.trim(),
    loopSlug: slug,
    loopDirectoryPath: getMultiloopDirectoryPath(folderPath, slug),
    statePath: getMultiloopStateFilePath(folderPath, slug),
  }
}

function isCompleteMultiloopWorkspaceContext(
  input: Partial<MultiloopWorkspaceContext> | null | undefined
): input is MultiloopWorkspaceContext {
  return Boolean(
    input?.loopName?.trim()
    && input.loopSlug?.trim()
    && input.loopDirectoryPath?.trim()
    && input.statePath?.trim()
  )
}

function normalizeMultiloopWorkspaceContext(
  input: Partial<MultiloopWorkspaceContext> | null | undefined,
  folderPath: string | null | undefined,
  multiloopState: MultiloopState | null
): MultiloopWorkspaceContext | null {
  const loopName = input?.loopName ?? multiloopState?.loop.displayName ?? multiloopState?.loop.name

  if (folderPath && loopName) {
    return createMultiloopWorkspaceContext(folderPath, loopName, input?.loopSlug)
  }

  if (isCompleteMultiloopWorkspaceContext(input)) {
    return {
      loopName: input.loopName.trim(),
      loopSlug: input.loopSlug.trim(),
      loopDirectoryPath: input.loopDirectoryPath,
      statePath: input.statePath,
    }
  }

  return null
}

const swarmAgentTab = (id: string, name: string) => ({
  type: 'tab',
  name,
  component: 'agent',
  config: { agentId: id },
})

function isDefaultSwarmAgentName(name: string | undefined, fallbackLabel: string): boolean {
  return !name || name === fallbackLabel
}

function pickWorkspaceAgentName(agents: Workspace['agents']): string {
  return pickRandomAgentName(Object.values(agents).map((agent) => agent.name))
}

function normalizeAgentState(agent: AgentState): AgentState {
  return {
    ...agent,
    execution: normalizeAgentExecution(agent.execution),
    cliPermissionPreset: normalizeCliPermissionPreset(agent.cliPermissionPreset),
  }
}

const swarmTabsLayoutModel = (
  swarmState: SwarmState | null,
  agents: Workspace['agents'] = {},
  options?: { includeAgentTabs?: boolean }
): IJsonModel => ({
  global: { tabSetEnableDrop: true, tabEnableClose: true },
  borders: [],
  layout: {
    type: 'row',
    children: [
      {
        type: 'tabset',
        weight: options?.includeAgentTabs === false ? 100 : 58,
        children: [
          { type: 'tab', name: 'Project', component: 'sprintengine-project' },
          { type: 'tab', name: 'SprintEngine Map', component: 'sprintengine-map' },
          { type: 'tab', name: 'Task Graph', component: 'sprintengine-task-graph' },
          { type: 'tab', name: 'Kanban', component: 'sprintengine-kanban' },
        ],
      },
      ...(options?.includeAgentTabs === false
        ? []
        : [{
          type: 'tabset',
          weight: 42,
          children: buildSwarmAgentRosterForState(swarmState).map((agent) =>
            swarmAgentTab(agent.id, agents[agent.id]?.name ?? agent.label)
          ),
        }]),
    ],
  },
})

const multiloopTabsLayoutModel = (): IJsonModel => ({
  global: { tabSetEnableDrop: true, tabEnableClose: true },
  borders: [],
  layout: {
    type: 'row',
    children: [
      {
        type: 'tabset',
        weight: 100,
        children: [
          { type: 'tab', name: 'Multiloop', component: 'multiloop-board' },
        ],
      },
    ],
  },
})

function modelContainsComponent(value: unknown, component: string): boolean {
  if (!value) return false
  if (Array.isArray(value)) {
    return value.some((entry) => modelContainsComponent(entry, component))
  }
  if (typeof value !== 'object') return false

  const record = value as Record<string, unknown>
  if (record.component === component) return true

  return Object.values(record).some((entry) => modelContainsComponent(entry, component))
}

function hasMultiloopBoardLayout(model: IJsonModel | null | undefined): boolean {
  return modelContainsComponent(model, 'multiloop-board')
}

function ensureMultiloopLayoutModel(model: IJsonModel | null | undefined): IJsonModel {
  return model && hasMultiloopBoardLayout(model) ? model : multiloopTabsLayoutModel()
}

function isLegacySwarmLayout(model: IJsonModel): boolean {
  const serialized = JSON.stringify(model)
  if (serialized.includes('"component":"sprintengine"') && !serialized.includes('"component":"sprintengine-map"')) return true
  if (serialized.includes('"component":"sprintengine-terminals"')) return true

  return false
}

type LayoutTreeNode = {
  type?: string
  component?: string
  name?: string
  children?: LayoutTreeNode[]
  [key: string]: unknown
}

function addTaskGraphTabToSwarmLayout(model: IJsonModel): IJsonModel {
  const serialized = JSON.stringify(model)
  if (serialized.includes('"component":"sprintengine-task-graph"')) return model

  const nextModel = JSON.parse(serialized) as IJsonModel & { layout?: LayoutTreeNode }
  let inserted = false

  const visit = (node: LayoutTreeNode | undefined) => {
    if (!node || inserted) return

    const children = node.children
    if (node.type === 'tabset' && Array.isArray(children)) {
      const mapIndex = children.findIndex((child) => child.component === 'sprintengine-map')
      const kanbanIndex = children.findIndex((child) => child.component === 'sprintengine-kanban')
      if (mapIndex >= 0 || kanbanIndex >= 0) {
        const insertIndex = mapIndex >= 0 ? mapIndex + 1 : kanbanIndex
        children.splice(insertIndex, 0, {
          type: 'tab',
          name: 'Task Graph',
          component: 'sprintengine-task-graph',
        })
        inserted = true
        return
      }
    }

    children?.forEach(visit)
  }

  visit(nextModel.layout)
  return inserted ? nextModel : model
}

function addProjectTabToSwarmLayout(model: IJsonModel): IJsonModel {
  const serialized = JSON.stringify(model)
  if (serialized.includes('"component":"sprintengine-project"')) return model

  const nextModel = JSON.parse(serialized) as IJsonModel & { layout?: LayoutTreeNode }
  let inserted = false

  const visit = (node: LayoutTreeNode | undefined) => {
    if (!node || inserted) return

    const children = node.children
    if (node.type === 'tabset' && Array.isArray(children)) {
      const mapIndex = children.findIndex((child) => child.component === 'sprintengine-map')
      const taskGraphIndex = children.findIndex((child) => child.component === 'sprintengine-task-graph')
      const kanbanIndex = children.findIndex((child) => child.component === 'sprintengine-kanban')
      const firstSwarmViewIndex = [mapIndex, taskGraphIndex, kanbanIndex]
        .filter((index) => index >= 0)
        .sort((a, b) => a - b)[0]

      if (firstSwarmViewIndex !== undefined) {
        children.splice(firstSwarmViewIndex, 0, {
          type: 'tab',
          name: 'Project',
          component: 'sprintengine-project',
        })
        inserted = true
        return
      }
    }

    children?.forEach(visit)
  }

  visit(nextModel.layout)
  return inserted ? nextModel : model
}

function migrateSwarmLayout(ws: Workspace): Workspace {
  if (ws.mode !== 'sprintengine' && !ws.swarmState) return ws
  if (!isLegacySwarmLayout(ws.layoutModel)) {
    return {
      ...ws,
      layoutModel: addProjectTabToSwarmLayout(addTaskGraphTabToSwarmLayout(ws.layoutModel)),
    }
  }

  return {
    ...ws,
    layoutModel: swarmTabsLayoutModel(ws.swarmState, ws.agents),
  }
}

function migrateSwarmAgentNames(ws: Workspace): Workspace {
  const swarmState = normalizeSwarmState(ws.swarmState)
  if (ws.mode !== 'sprintengine' && !swarmState) return ws

  const agents = reconcileSwarmAgents(ws.agents ?? {}, swarmState)
  return {
    ...ws,
    swarmState,
    agents,
    layoutModel: swarmTabsLayoutModel(swarmState, agents),
  }
}

function isPathOrChild(path: string, parentPath: string): boolean {
  if (path === parentPath) return true
  const separator = parentPath.includes('\\') && !parentPath.includes('/') ? '\\' : '/'
  return path.startsWith(`${parentPath}${separator}`)
}

function reconcileSwarmAgents(
  currentAgents: Workspace['agents'],
  swarmState: SwarmState | null
): Workspace['agents'] {
  if (!swarmState) return {}

  const nextAgents: Workspace['agents'] = {}
  const rosterAgents = Object.fromEntries(
    buildSwarmAgentRosterForState(swarmState).map((agent) => {
      const current = currentAgents[agent.id]
      const nextName = isDefaultSwarmAgentName(current?.name, agent.label)
        ? pickWorkspaceAgentName({ ...currentAgents, ...nextAgents })
        : current?.name ?? agent.label
      const nextAgent = current
        ? normalizeAgentState({ ...current, name: nextName, kind: 'sprintengine' as const })
        : defaultAgent(agent.id, nextName, 'sprintengine')
      nextAgents[agent.id] = nextAgent
      return [agent.id, nextAgent]
    })
  )

  const specialistAgents = Object.fromEntries(
    Object.entries(currentAgents).filter(([id, agent]) =>
      agent.kind === 'specialist' && !rosterAgents[id]
    ).map(([id, agent]) => [id, normalizeAgentState(agent)])
  )
  const transientSwarmAgents = Object.fromEntries(
    Object.entries(currentAgents).filter(([id, agent]) =>
      agent.kind === 'sprintengine'
      && !rosterAgents[id]
      && Boolean(agent.cliStartRequested || agent.cliHasLaunched || agent.cliSessionId)
    ).map(([id, agent]) => [id, normalizeAgentState(agent)])
  )

  return {
    ...specialistAgents,
    ...transientSwarmAgents,
    ...rosterAgents,
  }
}

export const useWorkspaceStore = create<WorkspaceStore>()(
  persist(
    immer((set) => ({
      workspaces: [],
      activeWorkspaceId: null,
      appSettings: defaultAppSettings(),
      authState: defaultAuthState(),

      setAuthState: (authState) =>
        set((state) => {
          state.authState = authState
        }),

      setCliRuntime: (cli, update) =>
        set((state) => {
          const defaults = defaultAppSettings()
          state.appSettings.cliRuntimes ??= defaults.cliRuntimes
          state.appSettings.cliRuntimes[cli] = {
            ...defaults.cliRuntimes[cli],
            ...state.appSettings.cliRuntimes[cli],
            ...update,
          }
        }),

      setLastSelectedCli: (cli) =>
        set((state) => {
          state.appSettings.lastSelectedCli = cli
        }),

      setLastSelectedSpecialist: (specialistId) =>
        set((state) => {
          state.appSettings.lastSelectedSpecialist = specialistId
        }),

      setLastSelectedMultiloopRole: (role) =>
        set((state) => {
          state.appSettings.lastSelectedMultiloopRole = role
        }),

      setLastAgentSpawnPermissionPreset: (preset) =>
        set((state) => {
          state.appSettings.lastAgentSpawnPermissionPreset = normalizeCliPermissionPreset(preset)
        }),

      setSearchExcludes: (patterns) =>
        set((state) => {
          state.appSettings.searchExcludes = normalizeSearchExcludes(patterns)
        }),

      setUsageTelemetrySettings: (update) =>
        set((state) => {
          state.appSettings.usageTelemetry = normalizeUsageTelemetrySettings({
            ...state.appSettings.usageTelemetry,
            ...update,
          })
        }),

      addWorkspace: (template, options) => {
        const id = nanoid()

        set((state) => {
          const folderPath = options?.folderPath ?? null
          const fallbackName = `${template.name} ${state.workspaces.length + 1}`
          const isSwarm = template.id === 'sprintengine-mode' || Boolean(options?.swarmState)
          const isMultiloop = template.id === 'multiloop-mode' || Boolean(options?.multiloopState)
          const swarmState = isSwarm
            ? normalizeSwarmState(options?.swarmState)
              ?? createInitialSwarmState({
                goal: options?.swarmState?.goal ?? 'Launch Sprint Engine mode',
                name: options?.swarmState?.name ?? options?.name ?? 'Sprint Engine Team',
                roleCounts: options?.swarmState?.roleCounts ?? createDefaultSwarmRoleCounts(),
              })
            : null
          const multiloopState = isMultiloop ? options?.multiloopState ?? null : null
          const workspaceName = swarmState
            ? swarmState.name
            : options?.name?.trim() || fallbackName
          const agents: Workspace['agents'] = {}
          const swarmRoleCliDefaults = swarmState
            ? normalizeSwarmRoleCliDefaults(options?.swarmRoleCliDefaults)
            : undefined
          if (swarmState) {
            buildSwarmAgentRosterForState(swarmState).forEach((agent) => {
              agents[agent.id] = {
                ...defaultAgent(
                  agent.id,
                  pickWorkspaceAgentName(agents),
                  'sprintengine'
                ),
                cli: swarmRoleCliDefaults?.[agent.role] ?? 'codex',
              }
            })
          }

          state.workspaces.push({
            id,
            name: workspaceName,
            mode: multiloopState || isMultiloop ? 'multiloop' : swarmState ? 'sprintengine' : 'standard',
            folderPath,
            folderMissing: false,
            swarmContext: normalizeSwarmWorkspaceContext(
              options?.swarmContext,
              folderPath,
              swarmState
            ),
            multiloopContext: normalizeMultiloopWorkspaceContext(
              options?.multiloopContext,
              folderPath,
              multiloopState
            ),
            templateId: template.id,
            layoutModel: isMultiloop
              ? multiloopTabsLayoutModel()
              : swarmState
              ? swarmTabsLayoutModel(swarmState, agents, { includeAgentTabs: false })
              : template.layout,
            agents,
            worktreeState: defaultWorkspaceWorktreeState(),
            memory: defaultWorkspaceMemoryConfig(),
            editorState: defaultEditorState(),
            swarmState,
            multiloopState,
            swarmRoleCliDefaults,
            swarmAutoState: normalizeSwarmAutoState(options?.swarmAutoState),
            multiloopAutoState: normalizeMultiloopAutoState(options?.multiloopAutoState),
            createdAt: Date.now(),
          })
          if (folderPath) {
            state.appSettings.recentWorkspaceFolders = normalizeRecentWorkspaceFolders(
              [folderPath],
              state.appSettings.recentWorkspaceFolders
            )
          }
          state.activeWorkspaceId = id
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
        }),

      renameWorkspace: (id, name) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === id)
          if (ws) ws.name = name.trim() || ws.name
        }),

      setActiveWorkspace: (id) =>
        set((state) => { state.activeWorkspaceId = id }),

      updateLayout: (id, model) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === id)
          if (ws) ws.layoutModel = model
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
            ws.swarmContext = normalizeSwarmWorkspaceContext(
              ws.swarmContext,
              folderPath,
              normalizeSwarmState(ws.swarmState)
            )
            ws.multiloopContext = normalizeMultiloopWorkspaceContext(
              ws.multiloopContext,
              folderPath,
              ws.multiloopState ?? null
            )
          }
        }),

      setSwarmContext: (id, swarmContext) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === id)
          if (ws) ws.swarmContext = swarmContext
        }),

      setMultiloopContext: (id, multiloopContext) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === id)
          if (ws) ws.multiloopContext = multiloopContext
        }),

      setFolderMissing: (id, folderMissing) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === id)
          if (ws) ws.folderMissing = folderMissing
        }),

      updateAgent: (workspaceId, agentId, update) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          if (!ws.agents[agentId]) ws.agents[agentId] = defaultAgent(agentId)
          Object.assign(ws.agents[agentId], update)
          ws.agents[agentId].execution = normalizeAgentExecution(ws.agents[agentId].execution)
        }),

      setAgentExecution: (workspaceId, agentId, execution) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          if (!ws.agents[agentId]) ws.agents[agentId] = defaultAgent(agentId)
          ws.agents[agentId].execution = normalizeAgentExecution({
            ...ws.agents[agentId].execution,
            ...execution,
          })
        }),

      setWorkspaceWorktreeState: (workspaceId, worktreeState) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          const current = normalizeWorkspaceWorktreeState(ws.worktreeState)
          ws.worktreeState = normalizeWorkspaceWorktreeState(
            worktreeState
              ? {
                ...current,
                ...worktreeState,
                entries: worktreeState.entries ?? current.entries,
              }
              : null
          )
        }),

      setWorkspaceMemoryRelativeRoot: (workspaceId, relativeRoot) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          ws.memory = {
            relativeRoot: normalizeMemoryRelativeRoot(relativeRoot),
            graphSettings: normalizeGraphSettings(ws.memory?.graphSettings),
          }
        }),

      updateMemoryGraphSettings: (workspaceId, update) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          const current = normalizeGraphSettings(ws.memory?.graphSettings)
          const patch = typeof update === 'function' ? update(current) : update
          const next = normalizeGraphSettings({ ...current, ...patch })
          ws.memory = {
            relativeRoot: normalizeMemoryRelativeRoot(ws.memory?.relativeRoot),
            graphSettings: next,
          }
        }),

      upsertWorktreeEntry: (workspaceId, entry) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          ws.worktreeState = normalizeWorkspaceWorktreeState(ws.worktreeState)
          const normalized = normalizeWorktreeEntry(entry)
          if (!normalized) return
          ws.worktreeState.entries[normalized.id] = normalized
          ws.worktreeState.updatedAt = normalized.updatedAt
        }),

      markWorktreeMissing: (workspaceId, worktreeId, missingAt = Date.now()) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          const entry = ws?.worktreeState?.entries[worktreeId]
          if (!ws || !entry) return
          entry.status = 'missing'
          entry.missingAt = missingAt
          entry.updatedAt = missingAt
          ws.worktreeState.updatedAt = missingAt
        }),

      removeWorktreeEntry: (workspaceId, worktreeId) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws?.worktreeState?.entries[worktreeId]) return
          delete ws.worktreeState.entries[worktreeId]
          ws.worktreeState.updatedAt = Date.now()
        }),

      setSwarmState: (workspaceId, swarmState) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          const normalized = normalizeSwarmState(swarmState)
          ws.swarmState = normalized
          ws.mode = normalized ? 'sprintengine' : 'standard'
          ws.swarmContext = normalizeSwarmWorkspaceContext(
            ws.swarmContext,
            ws.folderPath,
            normalized
          )
          ws.agents = reconcileSwarmAgents(ws.agents, normalized)
          ws.swarmAutoState = normalized
            ? normalizeSwarmAutoState(ws.swarmAutoState)
            : defaultSwarmAutoState()
        }),

      setMultiloopState: (workspaceId, multiloopState) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          ws.multiloopState = multiloopState
          ws.mode = multiloopState ? 'multiloop' : ws.swarmState ? 'sprintengine' : 'standard'
          ws.multiloopContext = normalizeMultiloopWorkspaceContext(
            ws.multiloopContext,
            ws.folderPath,
            multiloopState
          )
          if (multiloopState) ws.layoutModel = ensureMultiloopLayoutModel(ws.layoutModel)
          ws.multiloopAutoState = multiloopState
            ? normalizeMultiloopAutoState(ws.multiloopAutoState)
            : defaultMultiloopAutoState()
        }),

      setSwarmAutoEnabled: (workspaceId, enabled) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          const current = normalizeSwarmAutoState(ws.swarmAutoState)
          ws.swarmAutoState = {
            ...current,
            enabled,
            pendingSpawns: enabled ? current.pendingSpawns : [],
          }
        }),

      setSwarmAutoApproveArtifacts: (workspaceId, autoApproveArtifacts) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          const current = normalizeSwarmAutoState(ws.swarmAutoState)
          ws.swarmAutoState = {
            ...current,
            autoApproveArtifacts,
          }
        }),

      setSwarmKeepDoneAgentTerminals: (workspaceId, keepDoneAgentTerminals) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          const current = normalizeSwarmAutoState(ws.swarmAutoState)
          ws.swarmAutoState = {
            ...current,
            keepDoneAgentTerminals,
          }
        }),

      setSwarmCliPermissionPreset: (workspaceId, cliPermissionPreset) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          const current = normalizeSwarmAutoState(ws.swarmAutoState)
          ws.swarmAutoState = {
            ...current,
            cliPermissionPreset,
          }
        }),

      setSwarmAutoPendingSpawns: (workspaceId, pendingSpawns) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          const current = normalizeSwarmAutoState(ws.swarmAutoState)
          ws.swarmAutoState = {
            ...current,
            pendingSpawns,
          }
        }),

      setMultiloopAutoEnabled: (workspaceId, enabled) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          const current = normalizeMultiloopAutoState(ws.multiloopAutoState)
          ws.multiloopAutoState = {
            ...current,
            enabled,
            pendingSpawns: enabled ? current.pendingSpawns : [],
          }
        }),

      setMultiloopCliPermissionPreset: (workspaceId, cliPermissionPreset) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          const current = normalizeMultiloopAutoState(ws.multiloopAutoState)
          ws.multiloopAutoState = {
            ...current,
            cliPermissionPreset,
          }
        }),

      setMultiloopAutoPendingSpawns: (workspaceId, pendingSpawns) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          const current = normalizeMultiloopAutoState(ws.multiloopAutoState)
          ws.multiloopAutoState = {
            ...current,
            pendingSpawns: pendingSpawns
              .map((pending) => normalizeMultiloopAutoPendingSpawn(pending))
              .filter((pending): pending is MultiloopAutoPendingSpawn => Boolean(pending)),
          }
        }),

      setMultiloopCoordinatorAutoSpawnKey: (workspaceId, key) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          const current = normalizeMultiloopAutoState(ws.multiloopAutoState)
          ws.multiloopAutoState = {
            ...current,
            coordinatorAutoSpawnKey: key,
          }
        }),

      addSwarmMember: (workspaceId, role) => {
        let addedAgent: { id: AgentId; label: string } | null = null

        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws?.swarmState) return

          const agentId = getNextSwarmAgentId(role, ws.swarmState.swarmAgents)
          ws.swarmState.swarmAgents[agentId] = {
            role,
            status: 'idle',
            currentTaskId: null,
          }
          ws.swarmState.roleCounts[role] += 1

          const rosterAgent = buildSwarmAgentRosterForState(ws.swarmState).find(
            (agent) => agent.id === agentId
          )
          const agentRoleLabel = rosterAgent?.label ?? agentId
          const agentLabel = pickWorkspaceAgentName(ws.agents)
          const roleCliDefaults = normalizeSwarmRoleCliDefaults(ws.swarmRoleCliDefaults)
          ws.agents[agentId] = {
            ...defaultAgent(agentId, agentLabel, 'sprintengine'),
            cli: roleCliDefaults[role],
          }
          ws.agents = reconcileSwarmAgents(ws.agents, ws.swarmState)
          ws.swarmState.events.push({
            id: `EVT-${String(ws.swarmState.events.length + 1).padStart(3, '0')}`,
            timestamp: new Date().toISOString(),
            type: 'member_added',
            actor: 'user',
            message: `${agentLabel} joined the sprintengine as ${agentRoleLabel}.`,
          })

          addedAgent = { id: agentId, label: agentLabel }
        })

        return addedAgent
      },

      appendStream: (workspaceId, agentId, chunk) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          if (!ws.agents[agentId]) ws.agents[agentId] = defaultAgent(agentId)
          ws.agents[agentId].streamBuffer += chunk
          ws.agents[agentId].status = 'streaming'
        }),

      commitStream: (workspaceId, agentId) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          const agent = ws?.agents[agentId]
          if (!agent) return

          if (agent.streamBuffer) {
            agent.messages.push({
              role: 'assistant',
              content: agent.streamBuffer,
              timestamp: Date.now(),
            })
            agent.streamBuffer = ''
          }

          if (agent.status !== 'error') {
            agent.status = 'complete'
          }
        }),

      importWorkspace: (ws) =>
        set((state) => {
          const id = nanoid()
          const swarmState = normalizeSwarmState(ws.swarmState)
          const multiloopState = ws.multiloopState ?? null
          const mode = multiloopState ? 'multiloop' : swarmState ? 'sprintengine' : ws.mode ?? 'standard'
          state.workspaces.push({
            ...ws,
            id,
            name: `${ws.name} (imported)`,
            mode,
            folderPath: ws.folderPath ?? null,
            folderMissing: false,
            agents: Object.fromEntries(
              Object.entries(ws.agents).map(([k, v]) => [
                k,
                normalizeAgentState({
                  ...v,
                  streamBuffer: '',
                  status: 'idle' as const,
                  cliStartupPrompt: undefined,
                }),
              ])
            ),
            worktreeState: normalizeWorkspaceWorktreeState(ws.worktreeState),
            editorState: ws.editorState ?? defaultEditorState(),
            swarmState,
            swarmContext: normalizeSwarmWorkspaceContext(ws.swarmContext, ws.folderPath, swarmState),
            multiloopState,
            multiloopContext: normalizeMultiloopWorkspaceContext(
              ws.multiloopContext,
              ws.folderPath,
              multiloopState
            ),
            swarmRoleCliDefaults: normalizeSwarmRoleCliDefaults(ws.swarmRoleCliDefaults),
            swarmAutoState: normalizeSwarmAutoState(ws.swarmAutoState),
            multiloopAutoState: normalizeMultiloopAutoState(ws.multiloopAutoState),
          } satisfies Workspace)
          const imported = state.workspaces.at(-1)
          if (imported) {
            Object.assign(
              imported,
              imported.mode === 'multiloop'
                ? { ...imported, layoutModel: ensureMultiloopLayoutModel(imported.layoutModel) }
                : migrateSwarmLayout(imported)
            )
          }
          state.activeWorkspaceId = id
        }),

      openFile: (workspaceId, path, name, content) => {
        setEditorBuffer(workspaceId, path, content)
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          if (!ws.editorState) ws.editorState = defaultEditorState()
          const existing = ws.editorState.openFiles.find((f) => f.path === path)
          if (existing) {
            existing.isDirty = false
            existing.name = name
            existing.language = detectLanguage(name)
            delete existing.content
          } else {
            ws.editorState.openFiles.push({
              path,
              name,
              language: detectLanguage(name),
              isDirty: false,
            })
          }
          ws.editorState.activeFilePath = path
        })
      },

      closeFile: (workspaceId, path) => {
        deleteEditorBuffer(workspaceId, path)
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws?.editorState) return
          const idx = ws.editorState.openFiles.findIndex((f) => f.path === path)
          if (idx === -1) return
          ws.editorState.openFiles.splice(idx, 1)
          if (ws.editorState.activeFilePath === path) {
            ws.editorState.activeFilePath = ws.editorState.openFiles.at(-1)?.path ?? null
          }
        })
      },

      setActiveFile: (workspaceId, path) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (ws?.editorState) ws.editorState.activeFilePath = path
        }),

      updateFileContent: (workspaceId, path, content) => {
        setEditorBuffer(workspaceId, path, content)
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          const file = ws?.editorState?.openFiles.find((f) => f.path === path)
          if (!file || file.isDirty) return
          file.isDirty = true
        })
      },

      markFileClean: (workspaceId, path) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          const file = ws?.editorState?.openFiles.find((f) => f.path === path)
          if (file) file.isDirty = false
        }),

      remapOpenFiles: (workspaceId, fromPath, toPath) => {
        remapEditorBuffers(workspaceId, fromPath, toPath)
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          const openFiles = ws?.editorState?.openFiles
          if (!ws?.editorState || !openFiles?.length) return

          const separator = fromPath.includes('\\') && !fromPath.includes('/') ? '\\' : '/'
          const fromPrefix = `${fromPath}${separator}`

          openFiles.forEach((file) => {
            if (file.path !== fromPath && !file.path.startsWith(fromPrefix)) return

            const suffix = file.path === fromPath ? '' : file.path.slice(fromPath.length)
            file.path = `${toPath}${suffix}`
            file.name = file.path.split(/[/\\]/).filter(Boolean).pop() ?? file.name
          })

          if (ws.editorState.activeFilePath === fromPath) {
            ws.editorState.activeFilePath = toPath
          } else if (ws.editorState.activeFilePath?.startsWith(fromPrefix)) {
            ws.editorState.activeFilePath = `${toPath}${ws.editorState.activeFilePath.slice(fromPath.length)}`
          }
        })
      },

      removeOpenFilesForPath: (workspaceId, path) => {
        removeEditorBuffersForPath(workspaceId, path)
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          const openFiles = ws?.editorState?.openFiles
          if (!ws?.editorState || !openFiles?.length) return

          const activeFileDeleted = ws.editorState.activeFilePath
            ? isPathOrChild(ws.editorState.activeFilePath, path)
            : false

          ws.editorState.openFiles = openFiles.filter((file) => !isPathOrChild(file.path, path))

          if (activeFileDeleted) {
            ws.editorState.activeFilePath = ws.editorState.openFiles.at(-1)?.path ?? null
          }
        })
      },
    })),
    {
      name: WORKSPACE_STORAGE_KEY,
      version: 36,
      // Migrate older persisted state that lacks editorState / folderPath / swarmState
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as { workspaces?: Workspace[]; activeWorkspaceId?: WorkspaceId | null } | undefined
        if (!state) return state as never
        state.workspaces = state.workspaces ?? []
        if (version < 1) {
          state.workspaces = state.workspaces.map((ws) => ({
            ...ws,
            folderPath: ws.folderPath ?? null,
            editorState: ws.editorState ?? defaultEditorState(),
          }))
        }
        if (version < 2) {
          state.workspaces = state.workspaces.map((ws) => ({
            ...ws,
            mode: ws.mode ?? (ws.swarmState ? 'sprintengine' : 'standard'),
            swarmState: normalizeSwarmState(ws.swarmState),
          }))
        }
        if (version < 3) {
          state.workspaces = state.workspaces.map((ws) => ({
            ...ws,
            swarmState: normalizeSwarmState(ws.swarmState),
          }))
        }
        if (version < 4) {
          state.workspaces = state.workspaces.map((ws) => migrateSwarmLayout(ws))
        }
        if (version < 5) {
          state.workspaces = state.workspaces.map((ws) => migrateSwarmLayout(ws))
        }
        if (version < 6) {
          state.workspaces = state.workspaces.map((ws) => migrateSwarmLayout(ws))
        }
        if (version < 7) {
          state.workspaces = state.workspaces.map((ws) =>
            ws.mode === 'sprintengine' || ws.swarmState
              ? { ...ws, layoutModel: swarmTabsLayoutModel(ws.swarmState, ws.agents) }
              : ws
          )
        }
        if (version < 8) {
          state.workspaces = state.workspaces.map((ws) => {
            const swarmState = normalizeSwarmState(ws.swarmState)
            if (ws.mode !== 'sprintengine' && !swarmState) return ws

            return {
              ...ws,
              swarmState,
              agents: reconcileSwarmAgents(ws.agents, swarmState),
            }
          })
        }
        if (version < 10) {
          type LegacyAppSettings = Partial<AppSettings> & {
            cliCommands?: Partial<Record<AgentCli, string>>
          }
          const current = state as typeof state & { appSettings?: LegacyAppSettings }
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
          const current = state as typeof state & { appSettings?: Partial<AppSettings> }
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
          const current = state as typeof state & { appSettings?: Partial<AppSettings> }
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
          const current = state as typeof state & { appSettings?: Partial<AppSettings> }
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
          state.workspaces = state.workspaces.map((ws) => migrateSwarmLayout(ws))
        }
        if (version < 15) {
          state.workspaces = state.workspaces.map((ws) => migrateSwarmLayout(ws))
        }
        if (version < 16) {
          state.workspaces = state.workspaces.map((ws) => ({
            ...ws,
            folderMissing: false,
          }))
        }
        if (version < 17) {
          state.workspaces = state.workspaces.map((ws) => ({
            ...ws,
            swarmAutoState: normalizeSwarmAutoState(ws.swarmAutoState),
          }))
        }
        if (version < 18) {
          state.workspaces = state.workspaces.map((ws) => migrateSwarmAgentNames(ws))
        }
        if (version < 19) {
          state.workspaces = state.workspaces.map((ws) => {
            const swarmState = normalizeSwarmState(ws.swarmState)
            return {
              ...ws,
              swarmState,
              swarmContext: normalizeSwarmWorkspaceContext(
                (ws as Workspace & { swarmContext?: SwarmWorkspaceContext | null }).swarmContext,
                ws.folderPath,
                swarmState
              ),
            }
          })
        }
        if (version < 20) {
          state.workspaces = state.workspaces.map((ws) => ({
            ...ws,
            swarmAutoState: normalizeSwarmAutoState(ws.swarmAutoState),
          }))
        }
        if (version < 21) {
          state.workspaces = state.workspaces.map((ws) => ({
            ...ws,
            agents: Object.fromEntries(
              Object.entries(ws.agents ?? {}).map(([id, agent]) => [
                id,
                normalizeAgentState(agent),
              ])
            ),
            worktreeState: normalizeWorkspaceWorktreeState(ws.worktreeState),
          }))
        }
        if (version < 22) {
          state.workspaces = state.workspaces.map((ws) => ({
            ...ws,
            swarmAutoState: normalizeSwarmAutoState(ws.swarmAutoState),
          }))
        }
        if (version < 23) {
          state.workspaces = state.workspaces.map((ws) => ({
            ...ws,
            swarmRoleCliDefaults: ws.mode === 'sprintengine' || ws.swarmState
              ? normalizeSwarmRoleCliDefaults(ws.swarmRoleCliDefaults)
              : undefined,
          }))
        }
        if (version < 24) {
          state.workspaces = state.workspaces.map((ws) => ({
            ...ws,
            swarmAutoState: normalizeSwarmAutoState(ws.swarmAutoState),
          }))
        }
        if (version < 25) {
          state.workspaces = state.workspaces.map((ws) => ({
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
          const current = state as typeof state & { appSettings?: Partial<AppSettings> }
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
          const current = state as typeof state & { appSettings?: Partial<AppSettings> }
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
              state.workspaces.map((ws) => ws.folderPath)
            ),
          }
        }
        if (version < 28) {
          const current = state as typeof state & { appSettings?: Partial<AppSettings> }
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
              state.workspaces.map((ws) => ws.folderPath)
            ),
            usageTelemetry: normalizeUsageTelemetrySettings(
              current.appSettings?.usageTelemetry
            ),
          }
        }
        if (version < 29) {
          state.workspaces = state.workspaces.map((ws) => ({
            ...ws,
            swarmAutoState: normalizeSwarmAutoState(ws.swarmAutoState),
          }))
        }
        if (version < 30) {
          state.workspaces = state.workspaces.map((ws) => {
            const swarmState = normalizeSwarmState(ws.swarmState)
            const multiloopState = ws.multiloopState ?? null
            const mode = multiloopState ? 'multiloop' : swarmState ? 'sprintengine' : ws.mode ?? 'standard'
            const nextWorkspace = {
              ...ws,
              mode,
              swarmState,
              swarmContext: normalizeSwarmWorkspaceContext(
                ws.swarmContext,
                ws.folderPath,
                swarmState
              ),
              multiloopState,
              multiloopContext: normalizeMultiloopWorkspaceContext(
                ws.multiloopContext,
                ws.folderPath,
                multiloopState
              ),
              swarmAutoState: normalizeSwarmAutoState(ws.swarmAutoState),
              multiloopAutoState: normalizeMultiloopAutoState(ws.multiloopAutoState),
            }

            return mode === 'multiloop'
              ? { ...nextWorkspace, layoutModel: ensureMultiloopLayoutModel(nextWorkspace.layoutModel) }
              : migrateSwarmLayout(nextWorkspace)
          })
        }
        if (version < 31) {
          const current = state as typeof state & { appSettings?: Partial<AppSettings> }
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
              current.appSettings?.lastAgentSpawnPermissionPreset
            ),
            searchExcludes: normalizeSearchExcludes(current.appSettings?.searchExcludes),
            recentWorkspaceFolders: normalizeRecentWorkspaceFolders(
              current.appSettings?.recentWorkspaceFolders,
              state.workspaces.map((ws) => ws.folderPath)
            ),
            usageTelemetry: normalizeUsageTelemetrySettings(
              current.appSettings?.usageTelemetry
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
          const current = state as typeof state & { appSettings?: Partial<AppSettings> }
          current.appSettings = normalizeAppSettings(current.appSettings, state.workspaces)
        }
        if (version < 34) {
          const current = state as typeof state & { appSettings?: Partial<AppSettings> }
          current.appSettings = normalizeAppSettings(current.appSettings, state.workspaces)
        }
        if (version < 35) {
          state.workspaces = state.workspaces.map((ws) => ({
            ...ws,
            memory: normalizeWorkspaceMemoryConfig(ws.memory),
          }))
        }
        if (version < 36) {
          // Re-run memory normalization so the bumped GRAPH_SETTINGS_VERSION
          // upgrades layout numerics (link distance, node size, forces) on
          // workspaces that pre-date the tighter defaults.
          state.workspaces = state.workspaces.map((ws) => ({
            ...ws,
            memory: normalizeWorkspaceMemoryConfig(ws.memory),
          }))
        }
        return state as never
      },
      partialize: (s) => ({
        appSettings: s.appSettings,
        workspaces: s.workspaces.map((ws) => ({
          ...ws,
          memory: normalizeWorkspaceMemoryConfig(ws.memory),
          agents: Object.fromEntries(
            Object.entries(ws.agents).map(([id, a]) => {
              const shouldKeepStartupPrompt =
                !a.cliOnboardingPromptSent
                && (
                  (a.kind === 'specialist' && Boolean(a.specialistId))
                  || (a.kind === 'multiloop' && Boolean(a.multiloopRole))
                )
              const cliStartupPrompt = shouldKeepStartupPrompt ? a.cliStartupPrompt : undefined

              return [
                id,
                normalizeAgentState({
                  ...a,
                  streamBuffer: '',
                  status: 'idle' as const,
                  cliStartupPrompt,
                }),
              ]
            })
          ),
          worktreeState: normalizeWorkspaceWorktreeState(ws.worktreeState),
          // Keep file list + active file, drop content so we don't resurrect stale edits
          editorState: {
            openFiles: (ws.editorState?.openFiles ?? []).map(({ content: _content, ...f }) => ({
              ...f,
              isDirty: false,
            })),
            activeFilePath: ws.editorState?.activeFilePath ?? null,
          },
        })),
        activeWorkspaceId: s.activeWorkspaceId,
      }),
    }
  )
)
