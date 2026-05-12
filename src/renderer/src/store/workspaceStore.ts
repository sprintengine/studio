import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import type { IJsonModel } from 'flexlayout-react'
import { nanoid } from 'nanoid'
import type {
  Workspace,
  WorkspaceId,
  WorkspaceMode,
  LayoutTemplate,
  AgentState,
  AgentId,
  EditorState,
  SprintEngineAutoPendingSpawn,
  SprintEngineAutoState,
  SprintEngineCliPermissionPreset,
  MultiloopAutoPendingSpawn,
  MultiloopAutoState,
  SprintEngineState,
  SprintEngineWorkspaceContext,
  MultiloopState,
  MultiloopWorkspaceContext,
  SprintEngineRole,
  SprintEngineRoleCliDefaults,
  AgentCli,
  AppSettings,
  LearningSettings,
  UsageTelemetrySettings,
  CliRuntimeSettings,
  AgentKind,
  SpecialistActionId,
  MultiloopRole,
  AgentExecution,
  WorkspaceWorktreeState,
  WorktreeEntry,
  WorkspaceMemoryConfig,
  MemoryGraphSettings,
  WorkspaceHighlight,
  McpServerConfig,
  McpSettings,
} from '../types/workspace'
import {
  DEFAULT_GRAPH_SETTINGS,
  normalizeGraphSettings,
} from '../components/memory/memoryGraphTypes'
import { getSpecialistAction } from '../specialists/specialistActions'
import { pickRandomAgentName } from '../utils/agentNames'
import { detectLanguage } from '../utils/files'
import {
  buildSprintEngineAgentRosterForState,
  createDefaultSprintEngineRoleCounts,
  createInitialSprintEngineState,
  getNextSprintEngineAgentId,
  normalizeSprintEngineState,
} from '../utils/sprintengine'
import {
  getSprintEngineDirectoryPath,
  getSprintEngineStateFilePath,
  slugifySprintEngineName,
} from '../utils/sprintengineStateFile'
import {
  getMultiloopDirectoryPath,
  getMultiloopStateFilePath,
  slugifyMultiloopName,
} from '../utils/multiloopStateFile'
import {
  deleteEditorBuffer,
  moveEditorBuffer,
  remapEditorBuffers,
  removeEditorBuffersForPath,
  setEditorBuffer,
} from '../utils/editorBuffers'
import { normalizeProjectRootKey } from '../utils/projectKnowledge'

const WORKSPACE_STORAGE_KEY = 'multicode-workspaces'
const LEGACY_WORKSPACE_STORAGE_KEY = ['free', 'ai', 'ide', 'workspaces'].join('-')
const MAX_RECENT_WORKSPACE_FOLDERS = 12

function workspaceFolderKey(value: string | null | undefined): string | null {
  const normalized = normalizeProjectRootKey(value)
  return normalized ? normalized.toLowerCase() : null
}

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
  sidebarCollapsed: boolean
  setSidebarCollapsed: (collapsed: boolean) => void
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
  setLastSelectedCli: (cli: AgentCli) => void
  setLastSelectedSpecialist: (specialistId: SpecialistActionId) => void
  setLastSelectedMultiloopRole: (role: MultiloopRole) => void
  setLastAgentSpawnPermissionPreset: (preset: SprintEngineCliPermissionPreset) => void
  setSpecialistCliDefault: (specialistId: SpecialistActionId, cli: AgentCli | null) => void
  setMultiloopRoleCliDefault: (role: MultiloopRole, cli: AgentCli | null) => void
  setSearchExcludes: (patterns: string[]) => void
  setProjectKnowledgeRoot: (projectRoot: string, relativeRoot: string | null) => void
  setUsageTelemetrySettings: (update: Partial<UsageTelemetrySettings>) => void
  setLearningShowTipsOnStartup: (enabled: boolean) => void
  markLearningTipSeen: (tipId: string) => void
  markLearningLessonCompleted: (lessonId: string, completed?: boolean) => void
  resetLearningProgress: () => void
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
  addSprintEngineMember: (
    workspaceId: WorkspaceId,
    role: SprintEngineRole
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

const defaultLearningSettings = (): LearningSettings => ({
  showTipsOnStartup: true,
  lastShownTipId: null,
  seenTipIds: [],
  completedLessonIds: [],
})

function normalizeLearningStringList(value: unknown, max = 200): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
    if (out.length >= max) break
  }
  return out
}

function normalizeLearningSettings(input: unknown): LearningSettings {
  const defaults = defaultLearningSettings()
  if (!input || typeof input !== 'object') return defaults
  const candidate = input as Partial<LearningSettings>
  return {
    showTipsOnStartup:
      typeof candidate.showTipsOnStartup === 'boolean'
        ? candidate.showTipsOnStartup
        : defaults.showTipsOnStartup,
    lastShownTipId:
      typeof candidate.lastShownTipId === 'string' && candidate.lastShownTipId.trim()
        ? candidate.lastShownTipId.trim()
        : null,
    seenTipIds: normalizeLearningStringList(candidate.seenTipIds),
    completedLessonIds: normalizeLearningStringList(candidate.completedLessonIds),
    dismissedVersion:
      typeof candidate.dismissedVersion === 'string' && candidate.dismissedVersion.trim()
        ? candidate.dismissedVersion.trim()
        : undefined,
  }
}

const defaultAppSettings = (): AppSettings => ({
  cliRuntimes: {
    codex: { command: 'codex', useWsl: false },
    claude: {
      command: 'claude',
      useWsl: typeof window !== 'undefined' && window.api?.platform === 'win32',
    },
  },
  mcp: defaultMcpSettings(),
  lastSelectedCli: 'claude',
  lastSelectedSpecialist: 'architect',
  lastSelectedMultiloopRole: 'coordinator',
  lastAgentSpawnPermissionPreset: 'default',
  specialistCliDefaults: {},
  multiloopRoleCliDefaults: {},
  searchExcludes: [],
  projectKnowledgeRoots: {},
  recentWorkspaceFolders: [],
  usageTelemetry: defaultUsageTelemetrySettings(),
  learning: defaultLearningSettings(),
})

function defaultMcpSettings(): McpSettings {
  return {
    syncEnabled: false,
    servers: {},
  }
}

function normalizeMcpId(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
    : ''
}

function normalizeMcpStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizeMcpRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[0].trim()))
    .map(([key, item]) => [key.trim(), item] as const)
  return entries.length ? Object.fromEntries(entries) : undefined
}

function normalizeMcpServer(value: unknown): McpServerConfig | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<McpServerConfig>
  const id = normalizeMcpId(candidate.id)
  const name = typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : id
  const transport = candidate.transport === 'http' || candidate.transport === 'sse' ? candidate.transport : 'stdio'
  const clients = normalizeMcpStringList(candidate.clients).filter((client): client is AgentCli => client === 'codex' || client === 'claude')
  const scope = candidate.scope === 'user' ? 'user' : 'workspace'
  const source = candidate.source === 'custom' ? 'custom' : 'bundled'
  const riskLevel = (
    candidate.riskLevel === 'network'
    || candidate.riskLevel === 'local-command'
    || candidate.riskLevel === 'secrets'
  ) ? candidate.riskLevel : 'low'

  if (!id || !name || clients.length === 0) return null
  if (transport === 'stdio' && !(typeof candidate.command === 'string' && candidate.command.trim())) return null
  if ((transport === 'http' || transport === 'sse') && !(typeof candidate.url === 'string' && candidate.url.trim())) return null

  return {
    id,
    name,
    ...(typeof candidate.description === 'string' && candidate.description.trim()
      ? { description: candidate.description.trim() }
      : {}),
    transport,
    ...(typeof candidate.command === 'string' && candidate.command.trim() ? { command: candidate.command.trim() } : {}),
    args: normalizeMcpStringList(candidate.args),
    ...(typeof candidate.url === 'string' && candidate.url.trim() ? { url: candidate.url.trim() } : {}),
    ...(normalizeMcpRecord(candidate.env) ? { env: normalizeMcpRecord(candidate.env) } : {}),
    envVarNames: normalizeMcpStringList(candidate.envVarNames),
    ...(normalizeMcpRecord(candidate.headers) ? { headers: normalizeMcpRecord(candidate.headers) } : {}),
    enabled: candidate.enabled === true,
    required: candidate.required === true,
    clients,
    scope,
    source,
    riskLevel,
  }
}

function normalizeMcpSettings(value: unknown): McpSettings {
  const defaults = defaultMcpSettings()
  if (!value || typeof value !== 'object') return defaults
  const candidate = value as Partial<McpSettings>
  const servers: Record<string, McpServerConfig> = {}
  if (candidate.servers && typeof candidate.servers === 'object') {
    for (const server of Object.values(candidate.servers)) {
      const normalized = normalizeMcpServer(server)
      if (normalized) servers[normalized.id] = normalized
    }
  }
  return {
    syncEnabled: candidate.syncEnabled === true,
    servers,
  }
}

function normalizeProjectKnowledgeRoots(
  roots: unknown,
  workspaces: Workspace[]
): Record<string, string | null> {
  const normalized: Record<string, string | null> = {}

  if (roots && typeof roots === 'object') {
    for (const [projectRoot, relativeRoot] of Object.entries(roots as Record<string, unknown>)) {
      const key = normalizeProjectRootKey(projectRoot)
      const root = normalizeMemoryRelativeRoot(relativeRoot)
      if (key && root) normalized[key] = root
    }
  }

  for (const workspace of workspaces) {
    const projectRoot = normalizeProjectRootKey(workspace.folderPath)
    const relativeRoot = normalizeMemoryRelativeRoot(workspace.memory?.relativeRoot)
    if (projectRoot && relativeRoot && !normalized[projectRoot]) normalized[projectRoot] = relativeRoot
  }

  return normalized
}

function normalizeAppSettings(settings: Partial<AppSettings> | undefined, workspaces: Workspace[]): AppSettings {
  const defaults = defaultAppSettings()
  return {
    ...defaults,
    cliRuntimes: {
      ...defaults.cliRuntimes,
      ...(settings?.cliRuntimes ?? {}),
    },
    mcp: normalizeMcpSettings(settings?.mcp),
    lastSelectedCli: settings?.lastSelectedCli ?? defaults.lastSelectedCli,
    lastSelectedSpecialist: settings?.lastSelectedSpecialist ?? defaults.lastSelectedSpecialist,
    lastSelectedMultiloopRole: settings?.lastSelectedMultiloopRole ?? defaults.lastSelectedMultiloopRole,
    lastAgentSpawnPermissionPreset: normalizeCliPermissionPreset(settings?.lastAgentSpawnPermissionPreset),
    specialistCliDefaults: normalizeCliDefaults(settings?.specialistCliDefaults),
    multiloopRoleCliDefaults: normalizeCliDefaults(settings?.multiloopRoleCliDefaults),
    searchExcludes: normalizeSearchExcludes(settings?.searchExcludes),
    projectKnowledgeRoots: normalizeProjectKnowledgeRoots(settings?.projectKnowledgeRoots, workspaces),
    recentWorkspaceFolders: normalizeRecentWorkspaceFolders(
      settings?.recentWorkspaceFolders,
      workspaces.map((ws) => ws.folderPath)
    ),
    usageTelemetry: normalizeUsageTelemetrySettings(settings?.usageTelemetry),
    learning: normalizeLearningSettings(settings?.learning),
  }
}

type WorkspaceMigrationState = {
  workspaces: Workspace[]
  activeWorkspaceId?: WorkspaceId | null
  appSettings?: Partial<AppSettings> & {
    cliCommands?: Partial<Record<AgentCli, string>>
  }
}

function mapMigrationWorkspaces(
  state: WorkspaceMigrationState,
  migrate: (workspace: Workspace) => Workspace
): void {
  state.workspaces = state.workspaces.map(migrate)
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

function normalizeWorkspaceMode(
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
  ) {
    return input
  }
  return 'standard'
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

const defaultSprintEngineAutoState = (): SprintEngineAutoState => ({
  enabled: false,
  autoApproveArtifacts: false,
  keepDoneAgentTerminals: false,
  cliPermissionPreset: 'default',
  maxConcurrentAgents: 3,
  pendingSpawns: [],
})

const defaultMultiloopAutoState = (): MultiloopAutoState => ({
  enabled: false,
  cliPermissionPreset: 'default',
  maxConcurrentAgents: 1,
  coordinatorAutoSpawnKey: null,
  pendingSpawns: [],
})

const defaultSprintEngineRoleCliDefaults = (): Required<SprintEngineRoleCliDefaults> => ({
  architect: 'codex',
  product: 'codex',
  frontend: 'codex',
  developer: 'codex',
  code_reviewer: 'codex',
  spec_reviewer: 'codex',
  performance: 'codex',
  tester: 'codex',
  security: 'codex',
})

function normalizeSprintEngineRoleCliDefaults(
  input: SprintEngineRoleCliDefaults | null | undefined
): Required<SprintEngineRoleCliDefaults> {
  const defaults = defaultSprintEngineRoleCliDefaults()
  const next = { ...defaults }

  Object.keys(defaults).forEach((role) => {
    const value = input?.[role as SprintEngineRole]
    if (value === 'codex' || value === 'claude') {
      next[role as SprintEngineRole] = value
    }
  })

  return next
}

function normalizeSprintEngineAutoPendingSpawn(
  input: Partial<SprintEngineAutoPendingSpawn> | null | undefined
): SprintEngineAutoPendingSpawn | null {
  return typeof input?.taskId === 'string' && typeof input.agentId === 'string'
    ? {
      taskId: input.taskId,
      agentId: input.agentId,
      ...(typeof input.startedAt === 'number' ? { startedAt: input.startedAt } : {}),
    }
    : null
}

function isMultiloopAutoRole(input: unknown): input is MultiloopRole | SprintEngineRole {
  return input === 'coordinator'
    || input === 'architect'
    || input === 'product'
    || input === 'developer'
    || input === 'frontend'
    || input === 'tester'
    || input === 'security'
    || input === 'code_reviewer'
    || input === 'spec_reviewer'
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
  input: SprintEngineCliPermissionPreset | null | undefined
): SprintEngineCliPermissionPreset {
  return input === 'auto_workspace' || input === 'bypass_all' ? input : 'default'
}

function normalizeCliDefaults<K extends string>(
  input: Partial<Record<K, AgentCli>> | null | undefined
): Partial<Record<K, AgentCli>> {
  if (!input || typeof input !== 'object') return {}
  const result: Partial<Record<K, AgentCli>> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === 'codex' || value === 'claude') {
      result[key as K] = value
    }
  }
  return result
}

function normalizeSprintEngineAutoState(
  input: (Partial<SprintEngineAutoState> & { pending?: SprintEngineAutoPendingSpawn | null }) | null | undefined
): SprintEngineAutoState {
  const legacyPending = normalizeSprintEngineAutoPendingSpawn(input?.pending)
  const pendingSpawns = Array.isArray(input?.pendingSpawns)
    ? input.pendingSpawns
      .map((pending) => normalizeSprintEngineAutoPendingSpawn(pending))
      .filter((pending): pending is SprintEngineAutoPendingSpawn => Boolean(pending))
    : legacyPending
      ? [legacyPending]
      : []
  const cliPermissionPreset = normalizeCliPermissionPreset(input?.cliPermissionPreset)
  const maxConcurrentAgents =
    typeof input?.maxConcurrentAgents === 'number' && Number.isFinite(input.maxConcurrentAgents)
      ? Math.max(1, Math.min(10, Math.floor(input.maxConcurrentAgents)))
      : 3

  return {
    enabled: Boolean(input?.enabled),
    autoApproveArtifacts: Boolean(input?.autoApproveArtifacts),
    keepDoneAgentTerminals: Boolean(input?.keepDoneAgentTerminals),
    cliPermissionPreset,
    maxConcurrentAgents,
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

function createSprintEngineWorkspaceContext(
  folderPath: string | null | undefined,
  teamName: string | null | undefined,
  teamSlug?: string | null
): SprintEngineWorkspaceContext | null {
  if (!folderPath || !teamName?.trim()) return null

  const slug = teamSlug?.trim() || slugifySprintEngineName(teamName)
  return {
    teamName: teamName.trim(),
    teamSlug: slug,
    teamDirectoryPath: getSprintEngineDirectoryPath(folderPath, slug),
    statePath: getSprintEngineStateFilePath(folderPath, slug),
  }
}

function normalizeSprintEngineWorkspaceContext(
  input: Partial<SprintEngineWorkspaceContext> | null | undefined,
  folderPath: string | null | undefined,
  sprintEngineState: SprintEngineState | null
): SprintEngineWorkspaceContext | null {
  if (!sprintEngineState) return null

  if (input?.teamSlug && input.teamName) {
    return createSprintEngineWorkspaceContext(folderPath, input.teamName, input.teamSlug)
  }

  return createSprintEngineWorkspaceContext(folderPath, sprintEngineState?.name)
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

const sprintEngineAgentTab = (id: string, name: string) => ({
  type: 'tab',
  name,
  component: 'agent',
  config: { agentId: id },
})

function isDefaultSprintEngineAgentName(name: string | undefined, fallbackLabel: string): boolean {
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

const sprintEngineTabsLayoutModel = (
  sprintEngineState: SprintEngineState | null,
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
          { type: 'tab', name: 'Task Graph', component: 'sprintengine-task-graph' },
          { type: 'tab', name: 'Kanban', component: 'sprintengine-kanban' },
        ],
      },
      ...(options?.includeAgentTabs === false
        ? []
        : [{
          type: 'tabset',
          weight: 42,
          children: buildSprintEngineAgentRosterForState(sprintEngineState).map((agent) =>
            sprintEngineAgentTab(agent.id, agents[agent.id]?.name ?? agent.label)
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

function isLegacySprintEngineLayout(model: IJsonModel): boolean {
  const serialized = JSON.stringify(model)
  if (serialized.includes('"component":"sprintengine"') && !serialized.includes('"component":"sprintengine-project"')) return true
  if (serialized.includes('"component":"sprintengine-terminals"')) return true

  return false
}

function migrateSprintEngineLayout(ws: Workspace): Workspace {
  if (ws.mode !== 'sprintengine' && !ws.sprintEngineState) return ws

  if (!isLegacySprintEngineLayout(ws.layoutModel)) return ws

  return {
    ...ws,
    layoutModel: sprintEngineTabsLayoutModel(ws.sprintEngineState, ws.agents),
  }
}

function migrateSprintEngineAgentNames(ws: Workspace): Workspace {
  const sprintEngineState = normalizeSprintEngineState(ws.sprintEngineState)
  if (ws.mode !== 'sprintengine' && !sprintEngineState) return ws

  const agents = reconcileSprintEngineAgents(ws.agents ?? {}, sprintEngineState)
  return {
    ...ws,
    sprintEngineState,
    agents,
    layoutModel: sprintEngineTabsLayoutModel(sprintEngineState, agents),
  }
}

function isPathOrChild(path: string, parentPath: string): boolean {
  if (path === parentPath) return true
  const separator = parentPath.includes('\\') && !parentPath.includes('/') ? '\\' : '/'
  return path.startsWith(`${parentPath}${separator}`)
}

function reconcileSprintEngineAgents(
  currentAgents: Workspace['agents'],
  sprintEngineState: SprintEngineState | null
): Workspace['agents'] {
  if (!sprintEngineState) return {}

  const nextAgents: Workspace['agents'] = {}
  const rosterAgents = Object.fromEntries(
    buildSprintEngineAgentRosterForState(sprintEngineState).map((agent) => {
      const current = currentAgents[agent.id]
      const nextName = isDefaultSprintEngineAgentName(current?.name, agent.label)
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
      (agent.kind === 'specialist' || agent.kind === 'watchtower') && !rosterAgents[id]
    ).map(([id, agent]) => [id, normalizeAgentState(agent)])
  )
  const transientSprintEngineAgents = Object.fromEntries(
    Object.entries(currentAgents).filter(([id, agent]) =>
      agent.kind === 'sprintengine'
      && !rosterAgents[id]
      && Boolean(agent.cliStartRequested || agent.cliHasLaunched || agent.cliSessionId)
    ).map(([id, agent]) => [id, normalizeAgentState(agent)])
  )

  return {
    ...specialistAgents,
    ...transientSprintEngineAgents,
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
      sidebarCollapsed: false,

      setSidebarCollapsed: (collapsed) =>
        set((state) => {
          state.sidebarCollapsed = collapsed
        }),

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

      reconcileWorkspaceAgentLaunchFlags: (sessions) =>
        set((state) => {
          for (const ws of state.workspaces) {
            for (const [agentId, agent] of Object.entries(ws.agents)) {
              if (
                !agent.cliStartRequested
                && !agent.cliHasLaunched
                && !agent.cliSessionId
              ) continue
              const matchingLive = sessions.find(
                (session) =>
                  session.processAlive
                  && session.kind === 'agent'
                  && session.workspaceId === ws.id
                  && (
                    (agent.cliSessionId && session.sessionId === agent.cliSessionId)
                    || session.agentId === agentId
                  )
              )
              if (matchingLive) continue
              agent.cliStartRequested = false
              agent.cliHasLaunched = false
              agent.cliSessionId = undefined
            }
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
          state.appSettings.recentWorkspaceFolders = state.appSettings.recentWorkspaceFolders.filter(
            (folder) => normalize(folder) !== key
          )
        }),

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

      setMcpSyncEnabled: (enabled) =>
        set((state) => {
          state.appSettings.mcp = normalizeMcpSettings({
            ...state.appSettings.mcp,
            syncEnabled: enabled,
          })
        }),

      upsertMcpServer: (server) =>
        set((state) => {
          const normalized = normalizeMcpServer(server)
          if (!normalized) return
          const current = normalizeMcpSettings(state.appSettings.mcp)
          state.appSettings.mcp = {
            ...current,
            servers: {
              ...current.servers,
              [normalized.id]: normalized,
            },
          }
        }),

      removeMcpServer: (serverId) =>
        set((state) => {
          const current = normalizeMcpSettings(state.appSettings.mcp)
          delete current.servers[normalizeMcpId(serverId)]
          state.appSettings.mcp = current
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

      setSpecialistCliDefault: (specialistId, cli) =>
        set((state) => {
          state.appSettings.specialistCliDefaults ??= {}
          if (cli === null) {
            delete state.appSettings.specialistCliDefaults[specialistId]
          } else {
            state.appSettings.specialistCliDefaults[specialistId] = cli
          }
        }),

      setMultiloopRoleCliDefault: (role, cli) =>
        set((state) => {
          state.appSettings.multiloopRoleCliDefaults ??= {}
          if (cli === null) {
            delete state.appSettings.multiloopRoleCliDefaults[role]
          } else {
            state.appSettings.multiloopRoleCliDefaults[role] = cli
          }
        }),

      setSearchExcludes: (patterns) =>
        set((state) => {
          state.appSettings.searchExcludes = normalizeSearchExcludes(patterns)
        }),

      setProjectKnowledgeRoot: (projectRoot, relativeRoot) =>
        set((state) => {
          const key = normalizeProjectRootKey(projectRoot)
          if (!key) return
          const normalizedRoot = normalizeMemoryRelativeRoot(relativeRoot)
          state.appSettings.projectKnowledgeRoots = normalizeProjectKnowledgeRoots(
            state.appSettings.projectKnowledgeRoots,
            state.workspaces
          )
          if (normalizedRoot) {
            state.appSettings.projectKnowledgeRoots[key] = normalizedRoot
          } else {
            delete state.appSettings.projectKnowledgeRoots[key]
          }
          for (const workspace of state.workspaces) {
            if (normalizeProjectRootKey(workspace.folderPath) !== key) continue
            workspace.memory = {
              relativeRoot: null,
              graphSettings: normalizeGraphSettings(workspace.memory?.graphSettings),
            }
          }
        }),

      setUsageTelemetrySettings: (update) =>
        set((state) => {
          state.appSettings.usageTelemetry = normalizeUsageTelemetrySettings({
            ...state.appSettings.usageTelemetry,
            ...update,
          })
        }),

      setLearningShowTipsOnStartup: (enabled) =>
        set((state) => {
          state.appSettings.learning ??= defaultLearningSettings()
          state.appSettings.learning.showTipsOnStartup = enabled
        }),

      markLearningTipSeen: (tipId) =>
        set((state) => {
          const id = tipId?.trim()
          if (!id) return
          state.appSettings.learning ??= defaultLearningSettings()
          const learning = state.appSettings.learning
          if (!learning.seenTipIds.includes(id)) {
            learning.seenTipIds = [...learning.seenTipIds, id]
          }
          learning.lastShownTipId = id
        }),

      markLearningLessonCompleted: (lessonId, completed = true) =>
        set((state) => {
          const id = lessonId?.trim()
          if (!id) return
          state.appSettings.learning ??= defaultLearningSettings()
          const learning = state.appSettings.learning
          const already = learning.completedLessonIds.includes(id)
          if (completed && !already) {
            learning.completedLessonIds = [...learning.completedLessonIds, id]
          } else if (!completed && already) {
            learning.completedLessonIds = learning.completedLessonIds.filter((entry) => entry !== id)
          }
        }),

      resetLearningProgress: () =>
        set((state) => {
          const current = state.appSettings.learning ?? defaultLearningSettings()
          state.appSettings.learning = {
            ...defaultLearningSettings(),
            showTipsOnStartup: current.showTipsOnStartup,
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
            ? normalizeSprintEngineRoleCliDefaults(options?.sprintEngineRoleCliDefaults)
            : undefined
          if (sprintEngineState) {
            buildSprintEngineAgentRosterForState(sprintEngineState).forEach((agent) => {
              agents[agent.id] = {
                ...defaultAgent(
                  agent.id,
                  pickWorkspaceAgentName(agents),
                  'sprintengine'
                ),
                cli: sprintEngineRoleCliDefaults?.[agent.role] ?? 'codex',
              }
            })
          }
          state.workspaces.push({
            id,
            name: workspaceName,
            mode: multiloopState || isMultiloop
              ? 'multiloop'
              : isSwitchboard
                ? 'switchboard'
                  : sprintEngineState
                    ? 'sprintengine'
                    : 'standard',
            folderPath,
            folderMissing: false,
            sprintEngineContext: normalizeSprintEngineWorkspaceContext(
              options?.sprintEngineContext,
              folderPath,
              sprintEngineState
            ),
            multiloopContext: normalizeMultiloopWorkspaceContext(
              options?.multiloopContext,
              folderPath,
              multiloopState
            ),
            templateId: template.id,
            layoutModel: isMultiloop
              ? multiloopTabsLayoutModel()
              : sprintEngineState
              ? sprintEngineTabsLayoutModel(sprintEngineState, agents, { includeAgentTabs: false })
              : template.layout,
            agents,
            worktreeState: defaultWorkspaceWorktreeState(),
            memory: defaultWorkspaceMemoryConfig(),
            editorState: defaultEditorState(),
            sprintEngineState,
            multiloopState,
            sprintEngineRoleCliDefaults,
            sprintEngineAutoState: normalizeSprintEngineAutoState(options?.sprintEngineAutoState),
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
            ws.sprintEngineContext = normalizeSprintEngineWorkspaceContext(
              ws.sprintEngineContext,
              folderPath,
              normalizeSprintEngineState(ws.sprintEngineState)
            )
            ws.multiloopContext = normalizeMultiloopWorkspaceContext(
              ws.multiloopContext,
              folderPath,
              ws.multiloopState ?? null
            )
          }
        }),

      setSprintEngineContext: (id, sprintEngineContext) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === id)
          if (ws) ws.sprintEngineContext = sprintEngineContext
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

      setSprintEngineState: (workspaceId, sprintEngineState) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          const normalized = normalizeSprintEngineState(sprintEngineState)
          ws.sprintEngineState = normalized
          ws.mode = normalized ? 'sprintengine' : 'standard'
          ws.sprintEngineContext = normalizeSprintEngineWorkspaceContext(
            ws.sprintEngineContext,
            ws.folderPath,
            normalized
          )
          ws.agents = reconcileSprintEngineAgents(ws.agents, normalized)
          ws.sprintEngineAutoState = normalized
            ? normalizeSprintEngineAutoState(ws.sprintEngineAutoState)
            : defaultSprintEngineAutoState()
        }),

      setMultiloopState: (workspaceId, multiloopState) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          ws.multiloopState = multiloopState
          ws.mode = multiloopState
            ? 'multiloop'
            : ws.sprintEngineState
              ? 'sprintengine'
              : 'standard'
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

      setSprintEngineAutoEnabled: (workspaceId, enabled) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          const current = normalizeSprintEngineAutoState(ws.sprintEngineAutoState)
          ws.sprintEngineAutoState = {
            ...current,
            enabled,
            pendingSpawns: enabled ? current.pendingSpawns : [],
          }
        }),

      setSprintEngineAutoApproveArtifacts: (workspaceId, autoApproveArtifacts) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          const current = normalizeSprintEngineAutoState(ws.sprintEngineAutoState)
          ws.sprintEngineAutoState = {
            ...current,
            autoApproveArtifacts,
          }
        }),

      setSprintEngineKeepDoneAgentTerminals: (workspaceId, keepDoneAgentTerminals) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          const current = normalizeSprintEngineAutoState(ws.sprintEngineAutoState)
          ws.sprintEngineAutoState = {
            ...current,
            keepDoneAgentTerminals,
          }
        }),

      setSprintEngineCliPermissionPreset: (workspaceId, cliPermissionPreset) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          const current = normalizeSprintEngineAutoState(ws.sprintEngineAutoState)
          ws.sprintEngineAutoState = {
            ...current,
            cliPermissionPreset,
          }
        }),

      setSprintEngineMaxConcurrentAgents: (workspaceId, maxConcurrentAgents) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          const current = normalizeSprintEngineAutoState(ws.sprintEngineAutoState)
          ws.sprintEngineAutoState = {
            ...current,
            maxConcurrentAgents: Math.max(1, Math.min(10, Math.floor(maxConcurrentAgents))),
          }
        }),

      setSprintEngineAutoPendingSpawns: (workspaceId, pendingSpawns) =>
        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws) return
          const current = normalizeSprintEngineAutoState(ws.sprintEngineAutoState)
          ws.sprintEngineAutoState = {
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

      addSprintEngineMember: (workspaceId, role) => {
        let addedAgent: { id: AgentId; label: string } | null = null

        set((state) => {
          const ws = state.workspaces.find((w) => w.id === workspaceId)
          if (!ws?.sprintEngineState) return

          const agentId = getNextSprintEngineAgentId(role, ws.sprintEngineState.sprintEngineAgents)
          ws.sprintEngineState.sprintEngineAgents[agentId] = {
            role,
            status: 'idle',
            currentTaskId: null,
          }
          ws.sprintEngineState.roleCounts[role] += 1

          const rosterAgent = buildSprintEngineAgentRosterForState(ws.sprintEngineState).find(
            (agent) => agent.id === agentId
          )
          const agentRoleLabel = rosterAgent?.label ?? agentId
          const agentLabel = pickWorkspaceAgentName(ws.agents)
          const roleCliDefaults = normalizeSprintEngineRoleCliDefaults(ws.sprintEngineRoleCliDefaults)
          ws.agents[agentId] = {
            ...defaultAgent(agentId, agentLabel, 'sprintengine'),
            cli: roleCliDefaults[role],
          }
          ws.agents = reconcileSprintEngineAgents(ws.agents, ws.sprintEngineState)
          ws.sprintEngineState.events.push({
            id: `EVT-${String(ws.sprintEngineState.events.length + 1).padStart(3, '0')}`,
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
              normalizeAgentState({
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
            worktreeState: normalizeWorkspaceWorktreeState(ws.worktreeState),
            editorState: ws.editorState ?? defaultEditorState(),
            sprintEngineState,
            sprintEngineContext: normalizeSprintEngineWorkspaceContext(ws.sprintEngineContext, ws.folderPath, sprintEngineState),
            multiloopState,
            multiloopContext: normalizeMultiloopWorkspaceContext(
              ws.multiloopContext,
              ws.folderPath,
              multiloopState
            ),
            sprintEngineRoleCliDefaults: normalizeSprintEngineRoleCliDefaults(ws.sprintEngineRoleCliDefaults),
            sprintEngineAutoState: normalizeSprintEngineAutoState(ws.sprintEngineAutoState),
            multiloopAutoState: normalizeMultiloopAutoState(ws.multiloopAutoState),
          } satisfies Workspace)
          const imported = state.workspaces.at(-1)
          if (imported) {
            Object.assign(
              imported,
              imported.mode === 'multiloop'
                ? { ...imported, layoutModel: ensureMultiloopLayoutModel(imported.layoutModel) }
                : migrateSprintEngineLayout(imported)
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
          if (!dest.editorState) dest.editorState = defaultEditorState()
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
    })),
    {
      name: WORKSPACE_STORAGE_KEY,
      version: 42,
      // Migrate older persisted state that lacks editorState / folderPath / sprintEngineState
      migrate: (persisted: unknown, version: number) => {
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
              : ws
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
                sprintEngineState
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
              ])
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
              state.workspaces.map((ws) => ws.folderPath)
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
              state.workspaces.map((ws) => ws.folderPath)
            ),
            usageTelemetry: normalizeUsageTelemetrySettings(
              current.appSettings?.usageTelemetry
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
                sprintEngineState
              ),
              multiloopState,
              multiloopContext: normalizeMultiloopWorkspaceContext(
                ws.multiloopContext,
                ws.folderPath,
                multiloopState
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
        return state as never
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
          appSettings: normalizeAppSettings(state?.appSettings, workspaces),
        }
      },
      partialize: (s) => ({
        appSettings: s.appSettings,
        sidebarCollapsed: s.sidebarCollapsed,
        workspaces: s.workspaces.map((ws) => ({
          ...ws,
          mode: normalizeWorkspaceMode(ws.mode, ws.sprintEngineState, ws.multiloopState),
          memory: normalizeWorkspaceMemoryConfig(ws.memory),
          sprintEngineAutoState: normalizeSprintEngineAutoState(ws.sprintEngineAutoState),
          multiloopAutoState: normalizeMultiloopAutoState(ws.multiloopAutoState),
          agents: Object.fromEntries(
            Object.entries(ws.agents).map(([id, a]) => {
              const shouldKeepStartupPrompt =
                !a.cliOnboardingPromptSent
                && (
                  (a.kind === 'specialist' && Boolean(a.specialistId))
                  || (a.kind === 'multiloop' && Boolean(a.multiloopRole))
                  || (a.kind === 'watchtower' && Boolean(a.specialistId))
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
