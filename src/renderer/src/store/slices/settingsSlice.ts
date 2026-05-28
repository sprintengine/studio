import { normalizeProjectKnowledgeRoots } from './memorySlice'
import type {
  AgentCli,
  AppSettings,
  CliRuntimeSettings,
  LearningSettings,
  McpServerConfig,
  McpSettings,
  MultiloopRole,
  SprintEngineRoleId,
  SprintEngineRoleSettings,
  SkillPackEntry,
  SkillPackHarness,
  SkillPackSettings,
  SpecialistActionId,
  SprintEngineCliPermissionPreset,
  UsageTelemetrySettings,
  Workspace,
} from '../../types/workspace'
import { isAppTheme, type AppearanceSettings, type AppTheme } from '../../types/appTheme'
import { normalizeModuleOverrides } from '../../../../shared/modules/manifest'

export const MAX_RECENT_WORKSPACE_FOLDERS = 50

export type SettingsOverlayState = {
  open: boolean
  initialTab: string | null
  checkForUpdatesRequestId: number | null
}

export const defaultLearningSettings = (): LearningSettings => ({
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

export function normalizeLearningSettings(input: unknown): LearningSettings {
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

export function defaultAppearanceSettings(): AppearanceSettings {
  return { theme: 'system' }
}

export function normalizeAppearanceSettings(value: unknown): AppearanceSettings {
  const defaults = defaultAppearanceSettings()
  if (!value || typeof value !== 'object') return defaults
  const candidate = value as Partial<AppearanceSettings>
  return { theme: isAppTheme(candidate.theme) ? candidate.theme : defaults.theme }
}

export function defaultMcpSettings(): McpSettings {
  return {
    syncEnabled: false,
    servers: {},
  }
}

export function normalizeMcpId(value: unknown): string {
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

export function normalizeMcpServer(value: unknown): McpServerConfig | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<McpServerConfig>
  const id = normalizeMcpId(candidate.id)
  const name = typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : id
  const transport = candidate.transport === 'http' || candidate.transport === 'sse' ? candidate.transport : 'stdio'
  const clients = normalizeMcpStringList(candidate.clients)
    .map(normalizeMcpId)
    .filter(Boolean)
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

export function normalizeMcpSettings(value: unknown): McpSettings {
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

const SKILL_PACK_HARNESSES: readonly SkillPackHarness[] = [
  'claude',
  'codex',
  'cursor',
  'gemini',
  'opencode',
  'agents',
]

export function defaultSkillPackSettings(): SkillPackSettings {
  return { installed: {} }
}

export function normalizeSkillPackId(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
    : ''
}

export function normalizeSkillPack(value: unknown): SkillPackEntry | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<SkillPackEntry>
  const id = normalizeSkillPackId(candidate.id)
  const slug = typeof candidate.slug === 'string' ? candidate.slug.trim() : ''
  const name = typeof candidate.name === 'string' && candidate.name.trim()
    ? candidate.name.trim()
    : id
  if (!id || !slug) return null
  const harnesses = Array.isArray(candidate.harnesses)
    ? candidate.harnesses.filter((h): h is SkillPackHarness =>
        SKILL_PACK_HARNESSES.includes(h as SkillPackHarness),
      )
    : []
  const source = candidate.source === 'custom' ? 'custom' : 'bundled'
  return {
    id,
    slug,
    name,
    category: typeof candidate.category === 'string' ? candidate.category.trim() || undefined : undefined,
    description: typeof candidate.description === 'string' ? candidate.description.trim() || undefined : undefined,
    version: typeof candidate.version === 'string' ? candidate.version.trim() || undefined : undefined,
    sourceUrl: typeof candidate.sourceUrl === 'string' ? candidate.sourceUrl.trim() || undefined : undefined,
    installedDirName: typeof candidate.installedDirName === 'string'
      ? candidate.installedDirName.trim() || undefined
      : undefined,
    harnesses,
    source,
    installedAt: typeof candidate.installedAt === 'string' ? candidate.installedAt : undefined,
  }
}

export function normalizeSkillPackSettings(value: unknown): SkillPackSettings {
  if (!value || typeof value !== 'object') return defaultSkillPackSettings()
  const candidate = value as Partial<SkillPackSettings>
  const installed: Record<string, SkillPackEntry> = {}
  if (candidate.installed && typeof candidate.installed === 'object') {
    for (const entry of Object.values(candidate.installed)) {
      const normalized = normalizeSkillPack(entry)
      if (normalized) installed[normalized.id] = normalized
    }
  }
  return { installed }
}

export function defaultUsageTelemetrySettings(): UsageTelemetrySettings {
  return {
    sendUsageData: false,
    localDevExportEnabled: import.meta.env?.DEV === true,
    lastExportAt: null,
    exportDiagnostics: true,
  }
}

export function normalizeUsageTelemetrySettings(settings: unknown): UsageTelemetrySettings {
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

export function normalizeSearchExcludes(patterns: unknown): string[] {
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

export function normalizeRecentWorkspaceFolders(
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

export function normalizeCliPermissionPreset(
  input: SprintEngineCliPermissionPreset | null | undefined
): SprintEngineCliPermissionPreset {
  return input === 'auto_workspace' || input === 'bypass_all' ? input : 'default'
}

export function normalizeCliDefaults<K extends string>(
  input: Partial<Record<K, AgentCli>> | null | undefined
): Partial<Record<K, AgentCli>> {
  if (!input || typeof input !== 'object') return {}
  const result: Partial<Record<K, AgentCli>> = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.trim()) {
      result[key as K] = value.trim()
    }
  }
  return result
}

// Architect is the only role Sprint Engine planning truly requires. It is
// excluded from user disablement so a stray persisted `architect: false`
// cannot strand future workspaces without a planner. Settings normalization
// and the setter both honor this contract.
const PROTECTED_SPRINT_ENGINE_ROLE_ID = 'architect'

export function defaultSprintEngineRoleSettings(): SprintEngineRoleSettings {
  return { enabled: {} }
}

function normalizeRoleEnabledRecord(value: unknown): Record<SprintEngineRoleId, boolean> {
  if (!value || typeof value !== 'object') return {}
  const result: Record<SprintEngineRoleId, boolean> = {}
  for (const [key, enabled] of Object.entries(value as Record<string, unknown>)) {
    const id = key.trim()
    if (!id || typeof enabled !== 'boolean') continue
    if (id === PROTECTED_SPRINT_ENGINE_ROLE_ID && enabled === false) continue
    result[id] = enabled
  }
  return result
}

export function normalizeSprintEngineRoleSettings(value: unknown): SprintEngineRoleSettings {
  if (!value || typeof value !== 'object') return defaultSprintEngineRoleSettings()
  const candidate = value as Partial<SprintEngineRoleSettings>
  return { enabled: normalizeRoleEnabledRecord(candidate.enabled) }
}

export const defaultAppSettings = (): AppSettings => ({
  cliRuntimes: {
    codex: { command: 'codex', useWsl: false },
    claude: {
      command: 'claude',
      useWsl: typeof window !== 'undefined' && window.api?.platform === 'win32',
    },
  },
  mcp: defaultMcpSettings(),
  skillPacks: defaultSkillPackSettings(),
  lastSelectedCli: 'claude',
  lastSelectedSpecialist: 'architect',
  lastSelectedMultiloopRole: 'coordinator',
  lastAgentSpawnPermissionPreset: 'default',
  specialistCliDefaults: {},
  multiloopRoleCliDefaults: {},
  sprintEngineRoleSettings: defaultSprintEngineRoleSettings(),
  searchExcludes: [],
  projectKnowledgeRoots: {},
  recentWorkspaceFolders: [],
  usageTelemetry: defaultUsageTelemetrySettings(),
  learning: defaultLearningSettings(),
  appearance: defaultAppearanceSettings(),
  modules: {},
})

export function normalizeAppSettings(settings: Partial<AppSettings> | undefined, workspaces: Workspace[]): AppSettings {
  const defaults = defaultAppSettings()
  return {
    ...defaults,
    cliRuntimes: {
      ...defaults.cliRuntimes,
      ...(settings?.cliRuntimes ?? {}),
    },
    mcp: normalizeMcpSettings(settings?.mcp),
    skillPacks: normalizeSkillPackSettings(settings?.skillPacks),
    lastSelectedCli: settings?.lastSelectedCli ?? defaults.lastSelectedCli,
    lastSelectedSpecialist: settings?.lastSelectedSpecialist ?? defaults.lastSelectedSpecialist,
    lastSelectedMultiloopRole: settings?.lastSelectedMultiloopRole ?? defaults.lastSelectedMultiloopRole,
    lastAgentSpawnPermissionPreset: normalizeCliPermissionPreset(settings?.lastAgentSpawnPermissionPreset),
    specialistCliDefaults: normalizeCliDefaults(settings?.specialistCliDefaults),
    multiloopRoleCliDefaults: normalizeCliDefaults(settings?.multiloopRoleCliDefaults),
    sprintEngineRoleSettings: normalizeSprintEngineRoleSettings(settings?.sprintEngineRoleSettings),
    searchExcludes: normalizeSearchExcludes(settings?.searchExcludes),
    projectKnowledgeRoots: normalizeProjectKnowledgeRoots(settings?.projectKnowledgeRoots, workspaces),
    recentWorkspaceFolders: normalizeRecentWorkspaceFolders(
      settings?.recentWorkspaceFolders,
      workspaces.map((ws) => ws.folderPath)
    ),
    usageTelemetry: normalizeUsageTelemetrySettings(settings?.usageTelemetry),
    learning: normalizeLearningSettings(settings?.learning),
    appearance: normalizeAppearanceSettings(settings?.appearance),
    modules: normalizeModuleOverrides(settings?.modules),
  }
}

export interface SettingsSliceState {
  appSettings: AppSettings
  settingsOverlay: SettingsOverlayState
  sidebarCollapsed: boolean
}

export interface SettingsSliceActions {
  setSidebarCollapsed: (collapsed: boolean) => void
  openSettingsOverlay: (opts?: { initialTab?: string | null; checkForUpdates?: boolean }) => void
  closeSettingsOverlay: () => void
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
  setSprintEngineRoleEnabled: (role: SprintEngineRoleId, enabled: boolean) => void
  setModuleEnabled: (moduleId: string, enabled: boolean) => void
  setSearchExcludes: (patterns: string[]) => void
  setUsageTelemetrySettings: (update: Partial<UsageTelemetrySettings>) => void
  setLearningShowTipsOnStartup: (enabled: boolean) => void
  markLearningTipSeen: (tipId: string) => void
  markLearningLessonCompleted: (lessonId: string, completed?: boolean) => void
  resetLearningProgress: () => void
  setAppearanceTheme: (theme: AppTheme) => void
}

export type SettingsSlice = SettingsSliceState & SettingsSliceActions

type SettingsSliceCarrier = SettingsSliceState & { workspaces: Workspace[] }
type SettingsSliceSet = (mutator: (state: SettingsSliceCarrier) => void) => void

export function createSettingsSlice(set: SettingsSliceSet): SettingsSlice {
  return {
    appSettings: defaultAppSettings(),
    settingsOverlay: { open: false, initialTab: null, checkForUpdatesRequestId: null },
    sidebarCollapsed: false,

    setSidebarCollapsed: (collapsed) =>
      set((state) => {
        state.sidebarCollapsed = collapsed
      }),

    openSettingsOverlay: (opts) =>
      set((state) => {
        state.settingsOverlay.open = true
        state.settingsOverlay.initialTab = opts?.initialTab ?? null
        state.settingsOverlay.checkForUpdatesRequestId = opts?.checkForUpdates ? Date.now() : null
      }),

    closeSettingsOverlay: () =>
      set((state) => {
        state.settingsOverlay.open = false
        state.settingsOverlay.initialTab = null
        state.settingsOverlay.checkForUpdatesRequestId = null
      }),

    setCliRuntime: (cli, update) =>
      set((state) => {
        const defaults = defaultAppSettings()
        state.appSettings.cliRuntimes ??= defaults.cliRuntimes
        const fallback = defaults.cliRuntimes[cli] ?? { command: cli, useWsl: false }
        state.appSettings.cliRuntimes[cli] = {
          ...fallback,
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
          syncEnabled: true,
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
        state.appSettings.mcp = { ...current, syncEnabled: true }
      }),

    setSkillPacksInstalled: (installed) =>
      set((state) => {
        const next: Record<string, SkillPackEntry> = {}
        for (const entry of installed) {
          const normalized = normalizeSkillPack(entry)
          if (normalized) next[normalized.id] = normalized
        }
        state.appSettings.skillPacks = { installed: next }
      }),

    upsertSkillPack: (pack) =>
      set((state) => {
        const normalized = normalizeSkillPack(pack)
        if (!normalized) return
        const current = normalizeSkillPackSettings(state.appSettings.skillPacks)
        state.appSettings.skillPacks = {
          installed: {
            ...current.installed,
            [normalized.id]: normalized,
          },
        }
      }),

    removeSkillPack: (id) =>
      set((state) => {
        const current = normalizeSkillPackSettings(state.appSettings.skillPacks)
        delete current.installed[normalizeSkillPackId(id)]
        state.appSettings.skillPacks = current
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

    setSprintEngineRoleEnabled: (role, enabled) =>
      set((state) => {
        const id = role.trim()
        if (!id) return
        if (id === PROTECTED_SPRINT_ENGINE_ROLE_ID && enabled === false) return
        const current = normalizeSprintEngineRoleSettings(state.appSettings.sprintEngineRoleSettings)
        state.appSettings.sprintEngineRoleSettings = {
          enabled: {
            ...current.enabled,
            [id]: enabled,
          },
        }
      }),

    setModuleEnabled: (moduleId, enabled) =>
      set((state) => {
        const id = moduleId.trim()
        if (!id) return
        state.appSettings.modules = {
          ...normalizeModuleOverrides(state.appSettings.modules),
          [id]: enabled,
        }
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

    setAppearanceTheme: (theme) =>
      set((state) => {
        state.appSettings.appearance = normalizeAppearanceSettings({
          ...state.appSettings.appearance,
          theme,
        })
      }),
  }
}
