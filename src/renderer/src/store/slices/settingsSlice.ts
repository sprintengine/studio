import { nanoid } from 'nanoid'
import {
  NO_ROLES_ROSTER_ID,
  isNoRolesRosterRef,
} from '../../../../shared/sprintengine/run-types'
import { isFolderOpenTargetId } from '../../../../shared/folder-open-targets'
import type { FolderOpenTargetId } from '../../../../shared/folder-open-targets'
import { normalizeProjectKnowledgeRoots } from './memorySlice'
import { isConnectorsFoldedSettingsTab, SKILLS_SETTINGS_TAB } from '../../components/settings/extensionsRoute'
import { dispatchExtensionsSurfaceTarget } from '../../components/workspace/globalSurface/extensions/extensionsSurfaceTarget'
import type {
  AgentCli,
  AgentCliModelSelection,
  AgentConfigAdoptionResult,
  AppSettings,
  CliRuntimeSettings,
  KeybindingSettings,
  LastSelectedReview,
  LearningSettings,
  McpServerConfig,
  McpSettings,
  NewChatAgentChoice,
  ReviewGuideDefaults,
  SprintEngineRoleId,
  AgentConversationRuntime,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleModelOverrides,
  SprintEngineRoleCounts,
  SprintEngineRunSettings,
  SprintEngineRoleSettings,
  SprintEngineRoster,
  SprintEngineSavedRoster,
  SpecialistActionId,
  SprintEngineCliPermissionPreset,
  SprintEngineRoleRegistry,
  UsageTelemetrySettings,
  VoiceDictationModel,
  VoiceDictationSettings,
  Workspace,
} from '../../types/workspace'
import type {
  DiscoveredCliModel,
  DiscoveredCliModelCatalog,
} from '../../../../shared/cli-model-catalog'
import {
} from '../onboardingState'
import { SIDEBAR_DEFAULT_WIDTH, clampSidebarWidth } from '../../components/workspace/sidebarWidth'
import {
  WORKSPACE_ASIDE_DEFAULT_WIDTH,
  clampWorkspaceAsideWidth,
} from '../../components/workspace/workspaceAsideWidth'
import {
  isAppTheme,
  isWindowMaterial,
  type AppearanceSettings,
  type AppTheme,
  type WindowMaterial,
} from '../../types/appTheme'
import { normalizeModuleOverrides } from '../../../../shared/modules/manifest'
import { LEGACY_COMMAND_ID_ALIASES, collapseDuplicateKeybindings } from '../../commands/keybindings'

export const MAX_RECENT_WORKSPACE_FOLDERS = 50

// Settings is a DOOR (`activeGlobalSurface === 'settings'`), not an overlay:
// its categories replace the sidebar rail and its content takes the card
// region, exactly like Backlog or Sprints. What survives here is the REQUEST
// that opened it — which category to land on, and whether the caller asked for
// an update check — read once by the door as it mounts. Openness itself lives
// in `activeGlobalSurface`, so there is one answer to "is settings showing".
export type SettingsOverlayState = {
  initialTab: string | null
  checkForUpdatesRequestId: number | null
}

export type RunSummaryOverlayState = {
  open: boolean
  /** Which workspace's run summary the overlay is showing. */
  workspaceId: string | null
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
  return { theme: 'system', windowMaterial: 'solid' }
}

export function normalizeAppearanceSettings(value: unknown): AppearanceSettings {
  const defaults = defaultAppearanceSettings()
  if (!value || typeof value !== 'object') return defaults
  const candidate = value as Partial<AppearanceSettings>
  return {
    theme: isAppTheme(candidate.theme) ? candidate.theme : defaults.theme,
    windowMaterial: isWindowMaterial(candidate.windowMaterial)
      ? candidate.windowMaterial
      : defaults.windowMaterial,
  }
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

const VOICE_DICTATION_MODELS: readonly VoiceDictationModel[] = [
  'tiny',
  'base',
  'small',
  'medium',
  'large-v2',
  'large-v3',
  'large-v3-turbo',
]

export function defaultVoiceDictationSettings(): VoiceDictationSettings {
  return {
    // Multivoice transcription-host default bind address.
    serverUrl: 'http://127.0.0.1:48173',
    authToken: '',
    model: 'small',
    language: 'auto',
  }
}

export function normalizeVoiceDictationSettings(settings: unknown): VoiceDictationSettings {
  const defaults = defaultVoiceDictationSettings()
  if (!settings || typeof settings !== 'object') return defaults
  const candidate = settings as Partial<VoiceDictationSettings>
  return {
    serverUrl: typeof candidate.serverUrl === 'string' ? candidate.serverUrl.trim() : defaults.serverUrl,
    authToken: typeof candidate.authToken === 'string' ? candidate.authToken : defaults.authToken,
    model:
      typeof candidate.model === 'string' && VOICE_DICTATION_MODELS.includes(candidate.model as VoiceDictationModel)
        ? (candidate.model as VoiceDictationModel)
        : defaults.model,
    language:
      typeof candidate.language === 'string' && candidate.language.trim()
        ? candidate.language.trim()
        : defaults.language,
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

export function defaultKeybindingSettings(): KeybindingSettings {
  return { overrides: {}, disabled: {} }
}

function normalizeCommandKeybindings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return collapseDuplicateKeybindings(value.filter((entry): entry is string => typeof entry === 'string'))
}

// Keybinding deltas are stored by command id and filtered at consumption, so
// validation here is shape-only. Ids outside the static shell registry are
// kept on purpose: module commands (`<moduleId>.<commandId>`) must keep their
// user customizations across module disable/enable cycles and even across
// uninstall/reinstall — the merge point (RendererKernel.getCommandContributions)
// decides what is currently bindable, not this normalizer.
export function normalizeKeybindingSettings(value: unknown): KeybindingSettings {
  if (!value || typeof value !== 'object') return defaultKeybindingSettings()
  const candidate = value as Partial<KeybindingSettings>
  const overrides: Record<string, string[]> = {}
  if (candidate.overrides && typeof candidate.overrides === 'object') {
    for (const [commandId, rawBindings] of Object.entries(candidate.overrides as Record<string, unknown>)) {
      const id = commandId.trim()
      if (!id) continue
      const normalized = normalizeCommandKeybindings(rawBindings)
      if (normalized.length > 0) overrides[id] = normalized
    }
  }

  const disabled: Record<string, boolean> = {}
  if (candidate.disabled && typeof candidate.disabled === 'object') {
    for (const [commandId, rawDisabled] of Object.entries(candidate.disabled as Record<string, unknown>)) {
      const id = commandId.trim()
      if (!id || rawDisabled !== true) continue
      disabled[id] = true
    }
  }

  return { overrides, disabled }
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

// The app-level default preset for NEW agent spawns (owner ruling 2026-07-26:
// "we should be setting bypass permission mode as the default generally
// everywhere"). A user who wants gated permissions picks one deliberately —
// the setting is right there in Settings ▸ Agents.
//
// NOT the same as `normalizeCliPermissionPreset`'s 'default' floor: there,
// 'default' is a real preset (no permission flags) AND the "no local override"
// sentinel for a run. Here, ABSENT means "this user has never chosen", which is
// the only case that may adopt the new default. Kept separate so flipping the
// app default can never rewrite someone's deliberate 'default' choice.
export const DEFAULT_AGENT_SPAWN_PERMISSION_PRESET: SprintEngineCliPermissionPreset = 'bypass_all'

// ONLY an absent value adopts the new default. A present-but-unrecognised value
// is corruption, and corruption must never ESCALATE permissions — it falls to
// the conservative 'default' floor exactly as it did before this item.
export function normalizeAgentSpawnPermissionPreset(
  input: SprintEngineCliPermissionPreset | null | undefined
): SprintEngineCliPermissionPreset {
  if (input === undefined || input === null) return DEFAULT_AGENT_SPAWN_PERMISSION_PRESET
  return normalizeCliPermissionPreset(input)
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

// Per-role saved launch-model overrides for a Sprint Engine roster/team. Keeps
// only explicit non-empty model ids; a null/empty/"CLI default" value drops to
// absent (no model flag), matching the save-time prune so load and save agree.
export function normalizeSprintEngineRoleModelOverrides(
  input: SprintEngineRoleModelOverrides | null | undefined,
): SprintEngineRoleModelOverrides {
  if (!input || typeof input !== 'object') return {}
  const result: SprintEngineRoleModelOverrides = {}
  for (const [key, value] of Object.entries(input)) {
    const role = key.trim()
    if (role && typeof value === 'string' && value.trim()) {
      result[role as SprintEngineRoleId] = value.trim()
    }
  }
  return result
}

// Per-surface (specialist) model + reasoning-effort overrides. Keeps only
// entries naming a CLI and carrying at least one choice for it; a partial blob
// drops back to "no override" so resolution falls through to the CLI's own
// default (no model and no effort flag). A level with no model is kept on
// purpose — "the CLI's default model at high effort" is a real selection — so
// `model` may normalize to an empty string while `reasoning` survives.
export function normalizeCliModelSelections<K extends string>(
  input: Partial<Record<K, AgentCliModelSelection>> | null | undefined
): Partial<Record<K, AgentCliModelSelection>> {
  if (!input || typeof input !== 'object') return {}
  const result: Partial<Record<K, AgentCliModelSelection>> = {}
  for (const [key, value] of Object.entries(input)) {
    if (!value || typeof value !== 'object') continue
    const selection = value as Partial<AgentCliModelSelection>
    const cli = typeof selection.cli === 'string' ? selection.cli.trim() : ''
    const model = typeof selection.model === 'string' ? selection.model.trim() : ''
    const reasoning = typeof selection.reasoning === 'string' ? selection.reasoning.trim() : ''
    if (!cli || (!model && !reasoning)) continue
    result[key as K] = { cli, model, ...(reasoning ? { reasoning } : {}) }
  }
  return result
}

export function normalizeSelectedCli(input: AgentCli | null | undefined, fallback: AgentCli = 'claude-code'): AgentCli {
  if (typeof input === 'string' && input.trim()) {
    return input.trim()
  }
  return fallback
}

function normalizeCliRuntimes(
  cliRuntimes: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>> | undefined,
  defaults: AppSettings,
): AppSettings['cliRuntimes'] {
  const canonicalClaude = cliRuntimes?.['claude-code']
  const merged: AppSettings['cliRuntimes'] = {
    ...defaults.cliRuntimes,
    ...(cliRuntimes ?? {}),
    'claude-code': {
      ...defaults.cliRuntimes['claude-code'],
      ...(canonicalClaude ?? {}),
    },
  }
  delete merged.claude
  // Rebuild entries rather than mutating them: the spread above shares object
  // references with the caller's persisted settings, which may be frozen.
  const result: AppSettings['cliRuntimes'] = {}
  for (const [id, runtime] of Object.entries(merged)) {
    const models = normalizeUserModelList(runtime.models)
    if (models) {
      result[id] = { ...runtime, models }
    } else {
      const { models: _dropped, ...rest } = runtime
      result[id] = rest
    }
  }
  return result
}

// User-added model ids for one CLI: trimmed, non-empty, deduped.
export function normalizeUserModelList(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined
  const seen = new Set<string>()
  const models: string[] = []
  for (const entry of input) {
    if (typeof entry !== 'string') continue
    const model = entry.trim()
    if (!model || seen.has(model)) continue
    seen.add(model)
    models.push(model)
  }
  return models.length > 0 ? models : undefined
}

// One model row as a CLI reported it. Everything but `id` is optional and
// dropped when it is not the type the shape declares, so a probe parser that
// grows a field cannot inject a wrong-typed value into every picker.
function normalizeDiscoveredModel(input: unknown): DiscoveredCliModel | null {
  if (!input || typeof input !== 'object') return null
  const candidate = input as Partial<DiscoveredCliModel>
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
  if (!id) return null
  const model: DiscoveredCliModel = { id }
  const text = (value: unknown): string | undefined => {
    const trimmed = typeof value === 'string' ? value.trim() : ''
    return trimmed || undefined
  }
  const displayName = text(candidate.displayName)
  if (displayName) model.displayName = displayName
  const description = text(candidate.description)
  if (description) model.description = description
  const resolvedModel = text(candidate.resolvedModel)
  if (resolvedModel) model.resolvedModel = resolvedModel
  if (typeof candidate.contextWindow === 'number' && Number.isFinite(candidate.contextWindow) && candidate.contextWindow > 0) {
    model.contextWindow = candidate.contextWindow
  }
  if (Array.isArray(candidate.effortLevels)) {
    const levels = candidate.effortLevels
      .map((level) => text(level))
      .filter((level): level is string => Boolean(level))
    if (levels.length > 0) model.effortLevels = levels
  }
  const defaultEffort = text(candidate.defaultEffort)
  if (defaultEffort) model.defaultEffort = defaultEffort
  if (typeof candidate.supportsFastMode === 'boolean') model.supportsFastMode = candidate.supportsFastMode
  return model
}

// What each CLI last reported about its own models, keyed by plugin id. Wholly
// app-owned: an entry that does not carry the recorded shape (models array,
// known source, a fetch timestamp) is dropped rather than repaired, because a
// half-parsed catalog would put rows the CLI never listed into every picker.
// An entry whose models array is empty is kept — "probed, listed nothing" is a
// state the Settings CLI detail has to be able to tell from "never probed".
export function normalizeCliModelCatalogs(
  input: unknown,
): Partial<Record<AgentCli, DiscoveredCliModelCatalog>> | undefined {
  if (!input || typeof input !== 'object') return undefined
  const result: Partial<Record<AgentCli, DiscoveredCliModelCatalog>> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const cli = key.trim()
    if (!cli || !value || typeof value !== 'object') continue
    const candidate = value as Partial<DiscoveredCliModelCatalog>
    if (!Array.isArray(candidate.models)) continue
    if (candidate.source !== 'argv-probe' && candidate.source !== 'agent-sdk') continue
    const fetchedAt = typeof candidate.fetchedAt === 'string' ? candidate.fetchedAt.trim() : ''
    if (!fetchedAt) continue
    const seen = new Set<string>()
    const models: DiscoveredCliModel[] = []
    for (const entry of candidate.models) {
      const model = normalizeDiscoveredModel(entry)
      if (!model || seen.has(model.id)) continue
      seen.add(model.id)
      models.push(model)
    }
    const catalog: DiscoveredCliModelCatalog = { models, fetchedAt, source: candidate.source }
    const cliVersion = typeof candidate.cliVersion === 'string' ? candidate.cliVersion.trim() : ''
    if (cliVersion) catalog.cliVersion = cliVersion
    result[cli] = catalog
  }
  return Object.keys(result).length > 0 ? result : undefined
}

// Persisted last-used conversation provider/model. Keeps only a well-formed
// non-empty pair; anything else (legacy absence, partial blob) resets to null so
// spawn falls back to the first available option.
export function normalizeConversationModel(
  input: AgentConversationRuntime | null | undefined,
): AgentConversationRuntime | null {
  if (!input || typeof input !== 'object') return null
  const providerId = typeof input.providerId === 'string' ? input.providerId.trim() : ''
  const modelId = typeof input.modelId === 'string' ? input.modelId.trim() : ''
  if (!providerId || !modelId) return null
  return { providerId, modelId }
}

// Persisted last-opened Reviews-door selection. Keeps only a well-formed pair
// (both ids non-empty); anything else — legacy absence, a half-written blob —
// resets to null so the door falls back to attention-first auto-select.
export function normalizeLastSelectedReview(
  input: LastSelectedReview | null | undefined,
): LastSelectedReview | null {
  if (!input || typeof input !== 'object') return null
  const reviewId = typeof input.reviewId === 'string' ? input.reviewId.trim() : ''
  const workspaceRoot = typeof input.workspaceRoot === 'string' ? input.workspaceRoot.trim() : ''
  if (!reviewId || !workspaceRoot) return null
  return { reviewId, workspaceRoot }
}

const REVIEW_GUIDE_DEPTHS: ReviewGuideDefaults['depth'][] = ['brief', 'standard', 'thorough']

// The reviewer's last-used guide preparation choices. An unknown persisted depth
// falls back to `standard` rather than riding a value the guide skill cannot
// render, and a model is dropped without the CLI it was picked for — a model id
// only means something to one engine.
export function normalizeReviewGuideDefaults(input: Partial<ReviewGuideDefaults> | null | undefined): ReviewGuideDefaults {
  const source = input && typeof input === 'object' ? input : {}
  const depth = REVIEW_GUIDE_DEPTHS.includes(source.depth as ReviewGuideDefaults['depth'])
    ? (source.depth as ReviewGuideDefaults['depth'])
    : 'standard'
  const cli = typeof source.cli === 'string' && source.cli.trim() ? source.cli.trim() : null
  const model = cli && typeof source.model === 'string' && source.model.trim() ? source.model.trim() : null
  return { depth, cli, model }
}

// Persisted specialist menu order. Keeps only known ids and drops duplicates;
// missing ids are resolved against the canonical roster at render time, so an
// incomplete or stale list is safe to store.
export function normalizeSpecialistOrder(input: unknown): SpecialistActionId[] {
  if (!Array.isArray(input)) return []
  // Keep any non-empty id (bundled or registry-discovered role id), de-duped.
  // The roster resolves order against the live specialist list at render time,
  // so an id whose pack is absent is simply skipped there.
  const seen = new Set<string>()
  const result: SpecialistActionId[] = []
  for (const entry of input) {
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (id && !seen.has(id)) {
      seen.add(id)
      result.push(id)
    }
  }
  return result
}

// Persisted specialist-pack enablement: the set of pack ids the user switched
// off. Keeps only non-empty strings and drops duplicates; an unknown id is
// harmless (it just has no pack to hide).
// `migratedFallback` is the value for `migratedBundledPack` when the persisted
// config omits it — false for a returning profile (so the one-time MC-1587
// migration still evaluates it), true for a fresh profile (so it installs
// nothing). The caller decides which via the fresh-vs-returning signal;
// hydration always runs this path, so the default cannot live in
// defaultAppSettings alone.
export function normalizeSpecialistPacks(
  input: unknown,
  migratedFallback = false,
): { disabled: string[]; migratedBundledPack: boolean } {
  const source = input as { disabled?: unknown; migratedBundledPack?: unknown } | undefined
  const persisted = source?.migratedBundledPack
  const migratedBundledPack = typeof persisted === 'boolean' ? persisted : migratedFallback
  const raw = source?.disabled
  if (!Array.isArray(raw)) return { disabled: [], migratedBundledPack }
  const seen = new Set<string>()
  const disabled: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (id && !seen.has(id)) {
      seen.add(id)
      disabled.push(id)
    }
  }
  return { disabled, migratedBundledPack }
}

// Persisted "New chat in project" agent choice. A specialist choice is kept as
// long as it carries a non-empty id — bundled or registry-discovered (a
// plugged-in specialist pack) — so a pluggable specialist can be the default.
// The live roster is validated where the choice is shown and spawned, so a
// removed pack degrades gracefully there; only malformed shapes (missing id,
// wrong type) fall back to the General agent here.
export function normalizeNewChatAgentChoice(input: unknown): NewChatAgentChoice {
  if (!input || typeof input !== 'object') return { kind: 'general' }
  const choice = input as Partial<NewChatAgentChoice>
  if (choice.kind === 'terminal') return { kind: 'terminal' }
  if (choice.kind === 'specialist') {
    const id = typeof choice.specialistId === 'string' ? (choice.specialistId.trim() as SpecialistActionId) : null
    if (id) return { kind: 'specialist', specialistId: id }
  }
  return { kind: 'general' }
}

// Module-contributed settings sections persist their values in a `module:<id>`
// namespace inside app settings (see AppSettings.moduleSettings). The prefix is
// the collision guard between module keyspaces and shell settings keys.
export const MODULE_SETTINGS_NAMESPACE_PREFIX = 'module:'

export function moduleSettingsNamespace(moduleId: string): string {
  return `${MODULE_SETTINGS_NAMESPACE_PREFIX}${moduleId.trim()}`
}

export function normalizeModuleSettings(value: unknown): Record<string, Record<string, unknown>> {
  if (!value || typeof value !== 'object') return {}
  const result: Record<string, Record<string, unknown>> = {}
  for (const [namespace, entry] of Object.entries(value as Record<string, unknown>)) {
    const key = namespace.trim()
    if (!key.startsWith(MODULE_SETTINGS_NAMESPACE_PREFIX)) continue
    if (key.length === MODULE_SETTINGS_NAMESPACE_PREFIX.length) continue
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    result[key] = { ...(entry as Record<string, unknown>) }
  }
  return result
}

// Architect is the only role Sprint Engine planning truly requires. It is
// excluded from user disablement so a stray persisted `architect: false`
// cannot strand future workspaces without a planner. Settings normalization
// and the setter both honor this contract.
const PROTECTED_SPRINT_ENGINE_ROLE_ID = 'architect'

export function defaultSprintEngineRoleSettings(): SprintEngineRoleSettings {
  return { enabled: {}, savedRosters: [], lastSelectedRosterId: null }
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

// Pre-MC-1874 spellings of the roster keys. Declared only so the one-time
// migration below can read them type-safely; nothing else may reference these.
type LegacyRosterKeys = {
  savedTeams?: unknown
  lastSelectedTeamId?: unknown
}

export function normalizeSprintEngineRoleSettings(value: unknown): SprintEngineRoleSettings {
  if (!value || typeof value !== 'object') return defaultSprintEngineRoleSettings()
  const candidate = value as Partial<SprintEngineRoleSettings> & LegacyRosterKeys
  const savedRoster = normalizeSprintEngineSavedRoster(candidate.savedRoster)

  // ONE-TIME KEY MIGRATION (MC-1874): `savedTeams`/`lastSelectedTeamId` were
  // renamed to `savedRosters`/`lastSelectedRosterId` when "team" was reserved
  // for the run slug. Read the legacy keys ONLY when the new key is absent —
  // key absence, not emptiness, so a user who deletes their last roster does
  // not see the pre-rename list resurrected. The normalizer's output is what
  // gets persisted, so this runs once and the legacy keys are never read again.
  const hasNewKey = Array.isArray(candidate.savedRosters)
  const rosterSource = hasNewKey ? candidate.savedRosters : candidate.savedTeams
  const legacyKeyMigrated = !hasNewKey && Array.isArray(candidate.savedTeams)
  const rosters = normalizeSprintEngineRosters(rosterSource)

  // Migrate a legacy single saved roster into a named roster so existing users
  // keep their saved config as a selectable roster the first time they load.
  // Gate on the absence of BOTH roster-list keys (the legacy signal) rather than
  // an empty list, so a user who deletes their last roster doesn't see it
  // resurrected on the next normalize/reload.
  let migratedRosterId: string | null = null
  if (!hasNewKey && !legacyKeyMigrated && rosters.length === 0 && savedRoster) {
    migratedRosterId = nanoid()
    rosters.push({
      id: migratedRosterId,
      name: 'Saved roster',
      roleCounts: savedRoster.roleCounts,
      roleCliDefaults: savedRoster.roleCliDefaults,
      // Carry a model-bearing legacy roster's overrides into the migrated roster
      // so the migration is lossless (older rosters simply have none).
      ...(savedRoster.roleModelOverrides && Object.keys(savedRoster.roleModelOverrides).length > 0
        ? { roleModelOverrides: savedRoster.roleModelOverrides }
        : {}),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  }

  // Same key-absence rule for the selection pointer: only fall back to the
  // legacy `lastSelectedTeamId` on the pass that migrates the legacy list.
  const selectedCandidate =
    typeof candidate.lastSelectedRosterId === 'string'
      ? candidate.lastSelectedRosterId
      : legacyKeyMigrated && typeof candidate.lastSelectedTeamId === 'string'
        ? candidate.lastSelectedTeamId
        : null
  const lastSelectedRosterId =
    // MC-1876: the built-in is a valid selection but is deliberately NOT in the
    // list, so it has to be admitted explicitly or normalization would clear it
    // on every load.
    isNoRolesRosterRef(selectedCandidate)
      ? NO_ROLES_ROSTER_ID
      : selectedCandidate !== null && rosters.some((roster) => roster.id === selectedCandidate)
        ? selectedCandidate
        // Pre-select the just-migrated roster so legacy users open on their
        // roster rather than a "Custom" entry.
        : migratedRosterId
  return {
    enabled: normalizeRoleEnabledRecord(candidate.enabled),
    savedRoster,
    savedRosters: rosters,
    lastSelectedRosterId,
  }
}

function normalizeSprintEngineRosters(value: unknown): SprintEngineRoster[] {
  if (!Array.isArray(value)) return []
  const result: SprintEngineRoster[] = []
  const seenIds = new Set<string>()
  for (const rawEntry of value) {
    if (!rawEntry || typeof rawEntry !== 'object') continue
    const candidate = rawEntry as Partial<SprintEngineRoster>
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : ''
    if (!name) continue
    // MC-1876: drop any persisted roster wearing the built-in's reserved id or
    // name. Nothing in the app writes one, but a hand-edited settings file (or
    // a blob from a build where the name was not yet reserved) otherwise gets a
    // user roster that shadows the default everywhere it is referenced by name.
    if (isNoRolesRosterRef(name) || isNoRolesRosterRef(candidate.id as string | undefined)) continue
    let id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
    if (!id || seenIds.has(id)) id = nanoid()
    seenIds.add(id)
    const now = Date.now()
    const createdAt = typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt) ? candidate.createdAt : now
    const updatedAt = typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt) ? candidate.updatedAt : createdAt
    const roleModelOverrides = normalizeSprintEngineRoleModelOverrides(candidate.roleModelOverrides)
    // MC-2064 deleted the roster `mode` formation axis outright (no migration:
    // owner ruling, no users and no saved pools). A stored `mode` key from an
    // older profile is simply not carried forward — a roster is a set of roles.
    result.push({
      id,
      name,
      roleCounts: normalizeSavedSprintEngineRoleCounts(candidate.roleCounts),
      roleCliDefaults: normalizeCliDefaults(candidate.roleCliDefaults) as SprintEngineRoleCliDefaults,
      // Omit the key entirely when empty so pre-model-persistence teams keep a
      // clean shape and comparisons don't churn on `{}` vs absent.
      ...(Object.keys(roleModelOverrides).length > 0 ? { roleModelOverrides } : {}),
      createdAt,
      updatedAt,
    })
  }
  return result
}

export function sprintEngineRunSettingsKey(statePath: string | null | undefined): string {
  return typeof statePath === 'string'
    ? statePath.trim().replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
    : ''
}

function normalizeSprintEngineMaxConcurrentAgents(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(1, Math.min(10, Math.floor(value)))
}

export function normalizeSprintEngineRunSettings(value: unknown): Record<string, SprintEngineRunSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, SprintEngineRunSettings> = {}
  for (const [rawKey, rawEntry] of Object.entries(value as Record<string, unknown>)) {
    const key = sprintEngineRunSettingsKey(rawKey)
    if (!key || !rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue
    const candidate = rawEntry as Partial<SprintEngineRunSettings>
    const next: SprintEngineRunSettings = {}
    if ('cliPermissionPreset' in candidate) {
      next.cliPermissionPreset = normalizeCliPermissionPreset(candidate.cliPermissionPreset)
    }
    const maxConcurrentAgents = normalizeSprintEngineMaxConcurrentAgents(candidate.maxConcurrentAgents)
    if (maxConcurrentAgents !== undefined) {
      next.maxConcurrentAgents = maxConcurrentAgents
    }
    if (Object.keys(next).length > 0) result[key] = next
  }
  return result
}

function normalizeSprintEngineSavedRoster(value: unknown): SprintEngineSavedRoster | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<SprintEngineSavedRoster>
  const roleModelOverrides = normalizeSprintEngineRoleModelOverrides(candidate.roleModelOverrides)
  return {
    roleCounts: normalizeSavedSprintEngineRoleCounts(candidate.roleCounts),
    roleCliDefaults: normalizeCliDefaults(candidate.roleCliDefaults) as SprintEngineRoleCliDefaults,
    ...(Object.keys(roleModelOverrides).length > 0 ? { roleModelOverrides } : {}),
  }
}

// Saved-roster counts are an enabled-set encoding (MC-1450): a legacy preset
// count > 0 loads as "enabled" (1). The count shape is kept on disk so old and
// new builds read each other's presets.
function normalizeSavedSprintEngineRoleCounts(value: unknown): SprintEngineRoleCounts {
  const result: SprintEngineRoleCounts = { architect: 1 }
  if (value && typeof value === 'object') {
    for (const [role, rawCount] of Object.entries(value as Record<string, unknown>)) {
      const id = role.trim()
      if (!id) continue
      const count = Math.floor(Number(rawCount))
      if (!Number.isFinite(count)) continue
      result[id] = Math.max(id === PROTECTED_SPRINT_ENGINE_ROLE_ID ? 1 : 0, Math.min(1, count))
    }
  }
  result[PROTECTED_SPRINT_ENGINE_ROLE_ID] = Math.max(1, result[PROTECTED_SPRINT_ENGINE_ROLE_ID] ?? 1)
  return result
}

// Idle-terminal pause threshold, in minutes. Default 15. Bounds mirror the main
// reap policy's clamp ([1 min, 24 h]) so the UI and the runtime agree.
export const DEFAULT_TERMINAL_IDLE_SUSPEND_MINUTES = 15
export const MIN_TERMINAL_IDLE_SUSPEND_MINUTES = 1
export const MAX_TERMINAL_IDLE_SUSPEND_MINUTES = 24 * 60

export function normalizeTerminalIdleSuspendMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_TERMINAL_IDLE_SUSPEND_MINUTES
  }
  return Math.max(
    MIN_TERMINAL_IDLE_SUSPEND_MINUTES,
    Math.min(MAX_TERMINAL_IDLE_SUSPEND_MINUTES, Math.round(value))
  )
}

// Recency floor for the idle-terminal pauser: the N most recently used agent
// terminals are always left running, even once idle past the threshold. Bounds
// mirror the main reap policy's clamp ([0, 20]); 0 means pause everything idle.
export const DEFAULT_TERMINAL_KEEP_RECENT_ALIVE = 3
export const MIN_TERMINAL_KEEP_RECENT_ALIVE = 0
export const MAX_TERMINAL_KEEP_RECENT_ALIVE = 20

export function normalizeTerminalKeepRecentAlive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_TERMINAL_KEEP_RECENT_ALIVE
  }
  return Math.max(
    MIN_TERMINAL_KEEP_RECENT_ALIVE,
    Math.min(MAX_TERMINAL_KEEP_RECENT_ALIVE, Math.round(value))
  )
}

export const defaultAppSettings = (): AppSettings => ({
  cliRuntimes: {
    codex: { command: 'codex', useWsl: false },
    'claude-code': {
      command: 'claude',
      useWsl: false,
    },
  },
  keybindings: defaultKeybindingSettings(),
  mcp: defaultMcpSettings(),
  lastSelectedCli: 'claude-code',
  lastSelectedConversationModel: null,
  lastSelectedReview: null,
  reviewGuideDefaults: { depth: 'standard', cli: null, model: null },
  lastSelectedSpecialist: 'architect',
  lastSpawnWasGeneral: false,
  lastNewChatAgent: { kind: 'general' },
  // No default editor: the control resolves the first target the machine
  // actually has. Naming one here would claim an install we have not probed.
  lastFolderOpenTarget: null,
  lastAgentSpawnPermissionPreset: DEFAULT_AGENT_SPAWN_PERMISSION_PRESET,
  specialistCliDefaults: {},
  specialistModelDefaults: {},
  specialistOrder: [],
  // Pre-hydration base only. The effective flag is resolved in
  // normalizeAppSettings, which defaults it from the fresh-vs-returning signal
  // (fresh → true/skip, returning → false/run the one-time MC-1587 migration).
  specialistPacks: { disabled: [], migratedBundledPack: true },
  sprintEngineRoleSettings: defaultSprintEngineRoleSettings(),
  sprintEngineRunSettings: {},
  searchExcludes: [],
  projectKnowledgeRoots: {},
  recentWorkspaceFolders: [],
  usageTelemetry: defaultUsageTelemetrySettings(),
  learning: defaultLearningSettings(),
  appearance: defaultAppearanceSettings(),
  voiceDictation: defaultVoiceDictationSettings(),
  modules: {},
  moduleSettings: {},
  modulesChosen: false,
  firstRunCliCardDismissed: false,
  hasAdoptedAgentConfig: false,
  terminalIdleSuspendMinutes: DEFAULT_TERMINAL_IDLE_SUSPEND_MINUTES,
  terminalKeepRecentAlive: DEFAULT_TERMINAL_KEEP_RECENT_ALIVE,
  // Design Wizard specialists run on terminals by default. The conversation
  // transport is an experimental opt-in; hydration only turns it on for a
  // stored `true` recorded after the one-time reset (see normalizeAppSettings),
  // so a fresh profile lands here on the terminal path.
  guidedBriefConversationSessions: false,
  // A fresh profile has no pre-opt-in `true` to reset, so it starts stamped:
  // the first opt-in it records is explicit and survives every hydration.
  guidedBriefConversationSessionsOptInReset: true,
})

// `onboardingStep` is a RETIRED key: the wizard wrote it, nothing writes it now,
// and it is no longer part of AppSettings. It is still read once at hydration —
// through this widened view rather than by re-adding the field — because it is
// the strongest signal that a profile was already in use before the wizard was
// deleted. 'welcome' does not count: that profile installed the app, saw the
// first screen and quit, which makes it a fresh user, not a returning one.
type LegacyOnboardingSettings = { onboardingStep?: unknown }

function isPostWelcomeLegacyOnboarding(settings: Partial<AppSettings> | undefined): boolean {
  const step = (settings as LegacyOnboardingSettings | undefined)?.onboardingStep
  return typeof step === 'string' && step !== 'welcome'
}

export function normalizeAppSettings(settings: Partial<AppSettings> | undefined, workspaces: Workspace[]): AppSettings {
  const defaults = defaultAppSettings()
  return {
    ...defaults,
    cliRuntimes: normalizeCliRuntimes(settings?.cliRuntimes, defaults),
    cliModelCatalog: normalizeCliModelCatalogs(settings?.cliModelCatalog),
    keybindings: normalizeKeybindingSettings(settings?.keybindings),
    mcp: normalizeMcpSettings(settings?.mcp),
    lastSelectedCli: normalizeSelectedCli(settings?.lastSelectedCli, defaults.lastSelectedCli),
    lastSelectedConversationModel: normalizeConversationModel(settings?.lastSelectedConversationModel),
    lastSelectedReview: normalizeLastSelectedReview(settings?.lastSelectedReview),
    reviewGuideDefaults: normalizeReviewGuideDefaults(settings?.reviewGuideDefaults),
    lastSelectedSpecialist: settings?.lastSelectedSpecialist ?? defaults.lastSelectedSpecialist,
    lastSpawnWasGeneral: settings?.lastSpawnWasGeneral ?? defaults.lastSpawnWasGeneral,
    lastNewChatAgent: normalizeNewChatAgentChoice(settings?.lastNewChatAgent),
    lastFolderOpenTarget: isFolderOpenTargetId(settings?.lastFolderOpenTarget)
      ? settings.lastFolderOpenTarget
      : null,
    lastAgentSpawnPermissionPreset: normalizeAgentSpawnPermissionPreset(settings?.lastAgentSpawnPermissionPreset),
    specialistCliDefaults: normalizeCliDefaults(settings?.specialistCliDefaults),
    specialistModelDefaults: normalizeCliModelSelections(settings?.specialistModelDefaults),
    specialistOrder: normalizeSpecialistOrder(settings?.specialistOrder),
    // A returning profile (has workspaces, or a persisted modulesChosen — the
    // same signal `modulesChosen` below uses) that never recorded the migration
    // defaults to not-yet-migrated so it runs once; a fresh profile defaults to
    // migrated so it installs nothing.
    specialistPacks: normalizeSpecialistPacks(
      settings?.specialistPacks,
      !(settings?.modulesChosen ?? workspaces.length > 0),
    ),
    sprintEngineRoleSettings: normalizeSprintEngineRoleSettings(settings?.sprintEngineRoleSettings),
    // No `sprintEngineModelCatalog` line: the model catalog retired (MC-1890,
    // store v68). Every field here is built explicitly and `settings` is never
    // spread, so an upgraded profile's persisted array drops on every hydration
    // — the same merge-not-only-migrate enforcement as the opt-in reset below.
    sprintEngineRunSettings: normalizeSprintEngineRunSettings(settings?.sprintEngineRunSettings),
    searchExcludes: normalizeSearchExcludes(settings?.searchExcludes),
    projectKnowledgeRoots: normalizeProjectKnowledgeRoots(settings?.projectKnowledgeRoots, workspaces),
    recentWorkspaceFolders: normalizeRecentWorkspaceFolders(
      settings?.recentWorkspaceFolders,
      workspaces.map((ws) => ws.folderPath)
    ),
    usageTelemetry: normalizeUsageTelemetrySettings(settings?.usageTelemetry),
    learning: normalizeLearningSettings(settings?.learning),
    appearance: normalizeAppearanceSettings(settings?.appearance),
    voiceDictation: normalizeVoiceDictationSettings(settings?.voiceDictation),
    modules: normalizeModuleOverrides(settings?.modules),
    moduleSettings: normalizeModuleSettings(settings?.moduleSettings),
    // Existing installs (already have workspaces) are treated as chosen so the
    // first-run chooser only appears for a genuinely fresh install.
    modulesChosen: settings?.modulesChosen ?? workspaces.length > 0,
    // MIGRATION off the retired onboarding wizard. `modulesChosen` and
    // `onboardingStep` are the two signals that used to keep an existing install
    // out of onboarding; both stay READABLE here (and are never written again) so
    // an upgrade is recognised and converted, once, into this boolean.
    //
    // A profile parked at 'welcome' with no workspaces is deliberately NOT
    // treated as dismissed: it installed, saw the welcome step, quit, and
    // upgraded — which makes it exactly the fresh user this card is for. Anything
    // past 'welcome' is someone who was already using the app.
    firstRunCliCardDismissed:
      settings?.firstRunCliCardDismissed
      ?? (workspaces.length > 0
        || settings?.modulesChosen === true
        || isPostWelcomeLegacyOnboarding(settings)),
    // An existing install already had its chance to adopt through the wizard's
    // card, so it is not re-offered; a fresh profile adopts on its first
    // workspace creation.
    hasAdoptedAgentConfig: settings?.hasAdoptedAgentConfig ?? workspaces.length > 0,
    terminalIdleSuspendMinutes: normalizeTerminalIdleSuspendMinutes(settings?.terminalIdleSuspendMinutes),
    terminalKeepRecentAlive: normalizeTerminalKeepRecentAlive(settings?.terminalKeepRecentAlive),
    // Opt-in only: on solely when the stored value is exactly `true` AND this
    // profile has already been through the one-time reset (MC-1802). The
    // pre-opt-in default was `true`, which persist wrote to every existing
    // profile's disk state, so an un-stamped `true` is indistinguishable from
    // that old default and is cleared; the profile is stamped here, so any
    // opt-in recorded afterwards is explicit and survives. A fresh profile
    // (undefined) or any non-`true` value resolves to the terminal path.
    // Enforced in the normalizer rather than only in the v67 migration because
    // persist merge() calls this on every hydration, and a current-version
    // envelope (dev HMR, backup recovery) never re-enters the migrate ladder
    // ([[zustand-migration-hmr-version-stamp]]).
    guidedBriefConversationSessions:
      settings?.guidedBriefConversationSessionsOptInReset === true
      && settings?.guidedBriefConversationSessions === true,
    guidedBriefConversationSessionsOptInReset: true,
  }
}

// First-run surface for opening files. Defaults to the external pop-up window;
// it is sticky thereafter (docking a file back flips it to workspace tabs).
// Flip this one constant to make tabs the out-of-the-box default instead.
export const DEFAULT_OPEN_FILES_IN_EXTERNAL_WINDOW = true

export interface SettingsSliceState {
  appSettings: AppSettings
  settingsOverlay: SettingsOverlayState
  runSummaryOverlay: RunSummaryOverlayState
  // The active door-routed full-page surface for this window (global-surfaces
  // epic 1704): a registered surface id (e.g. 'roadmap') or null when a
  // workspace — not a door — owns the card region. Per-window and transient
  // (omitted from extractSettingsFields / partializeWorkspaceStoreState, so
  // never persisted and never replicated across windows). Unlike the Settings
  // overlay this is a MOUNT KIND that pre-empts the workspace card region
  // rather than floating a dialog over it, so opening a door and activating a
  // workspace are mutually exclusive — the sidebar selection invariant.
  activeGlobalSurface: string | null
  sidebarCollapsed: boolean
  // User-resizable expanded width of the workspace sidebar, in px. Persisted so
  // the rail reopens at the width the user dragged it to. Only meaningful while
  // expanded; the collapsed rail is a fixed icon width.
  sidebarWidth: number
  // The right-docked workspace aside column (WorkspaceAsideMount). App-level,
  // not per-workspace layout: the column sits outside the workspace card and
  // survives workspace switches. Transient — deliberately NOT persisted, so an
  // unclaimed column can never be reopened by a stale profile (MC-1766).
  workspaceAsideOpen: boolean
  // User-resizable width of the aside column, in px. Owned by the mount seam so
  // a tenant inherits the resize behaviour rather than re-implementing it.
  workspaceAsideWidth: number
  // Sticky "where do files open" preference. When true, opening a file routes to
  // the external editor window (a tabbed pop-up) instead of a workspace tab.
  // Set by user action — popping a tab out turns it on, docking a file back
  // turns it off — and remembered so the next file reuses the last surface.
  openFilesInExternalWindow: boolean
  // Discovered Sprint Engine role registry for the active workspace (bundled +
  // workspace/user/plugin layers). In-memory only (re-fetched per workspace,
  // never persisted); powers the registry-discovered specialist packs in the
  // spawn dropdown and the Modules settings tab. Null until loaded.
  sprintEngineRoleRegistry: SprintEngineRoleRegistry | null
  // Live outcome of the deferred first-run agent-config adoption, shown on the
  // first-run overlay. Transient (not persisted via extractSettingsFields) — it
  // describes an action that ran this session, never a resumed one.
  agentConfigAdoptionResult: AgentConfigAdoptionResult | null
}

export interface SettingsSliceActions {
  setSidebarCollapsed: (collapsed: boolean) => void
  setSidebarWidth: (width: number) => void
  setSprintEngineRoleRegistry: (registry: SprintEngineRoleRegistry | null) => void
  setWorkspaceAsideOpen: (open: boolean) => void
  setWorkspaceAsideWidth: (width: number) => void
  setOpenFilesInExternalWindow: (enabled: boolean) => void
  openSettingsOverlay: (opts?: { initialTab?: string | null; checkForUpdates?: boolean }) => void
  closeSettingsOverlay: () => void
  openRunSummaryOverlay: (workspaceId: string) => void
  closeRunSummaryOverlay: () => void
  // Opens the Extensions door on the requested view (MC-1847 B1): the modal
  // this action used to float is gone, so every legacy caller — the command
  // palette, Settings → Modules, the agent "Manage skills" footers — lands on
  // the door with its deep-link latched. (Renamed in the D1 sweep.)
  openExtensionsSurface: (opts?: { view?: 'browse' | 'installed' }) => void
  // The Roadmap door routes here; a named
  // convenience over openGlobalSurface('roadmap') so every caller opens the same
  // door-routed full-page surface (global-surfaces epic 1704).
  openRoadmapSurface: () => void
  // Open/close the door-routed full-page surface (global-surfaces epic 1704).
  // `openGlobalSurface` is the generic entry a module's door calls with its own
  // registered surface id; `closeGlobalSurface` returns the card region to the
  // active workspace. Activating a workspace clears it too (see workspacesSlice).
  openGlobalSurface: (surfaceId: string) => void
  closeGlobalSurface: () => void
  setCliRuntime: (cli: AgentCli, update: Partial<CliRuntimeSettings>) => void
  // Record (or clear) what one CLI reported about its own models. Replaces that
  // CLI's entry wholesale — a model the CLI no longer lists is gone from the
  // discovered layer — and never touches `cliRuntimes[cli].models`.
  setCliModelCatalog: (cli: AgentCli, catalog: DiscoveredCliModelCatalog | null) => void
  setMcpSyncEnabled: (enabled: boolean) => void
  upsertMcpServer: (server: McpServerConfig) => void
  removeMcpServer: (serverId: string) => void
  setLastSelectedCli: (cli: AgentCli) => void
  setLastSelectedConversationModel: (selection: AgentConversationRuntime | null) => void
  /** Remember (or clear with `null`) the review last opened in the Reviews door. */
  setLastSelectedReview: (selection: LastSelectedReview | null) => void
  /**
   * Remember the guide preparation choices made on the prepare banner. Patches
   * merge over the stored value, so changing the depth leaves the agent alone;
   * pass `model: null` alongside a new `cli` to drop a model that engine cannot run.
   */
  setReviewGuideDefaults: (patch: Partial<ReviewGuideDefaults>) => void
  setLastSelectedSpecialist: (specialistId: SpecialistActionId) => void
  setLastSpawnWasGeneral: (value: boolean) => void
  setLastNewChatAgent: (choice: NewChatAgentChoice) => void
  /** Remember the open-in-editor target the user just used (app-wide). */
  setLastFolderOpenTarget: (target: FolderOpenTargetId) => void
  setLastAgentSpawnPermissionPreset: (preset: SprintEngineCliPermissionPreset) => void
  setSpecialistCliDefault: (specialistId: SpecialistActionId, cli: AgentCli | null) => void
  /**
   * Write (or clear with `null`) a surface's model choice. A stored
   * reasoning-effort level survives a model change within the same CLI and is
   * dropped when the CLI changes, per the per-CLI effort ruling; pass
   * `model: ''` for "the CLI's own default model" so the level survives that
   * choice too. `null` clears the whole selection, level included.
   */
  setSpecialistModelDefault: (specialistId: SpecialistActionId, selection: AgentCliModelSelection | null) => void
  /**
   * Write (or clear with `null`) a surface's reasoning-effort level for `cli`,
   * keeping the model already chosen for that CLI. A level set while a
   * different CLI is stored replaces the selection, since levels do not
   * transfer between CLIs.
   */
  setSpecialistReasoningDefault: (
    specialistId: SpecialistActionId,
    cli: AgentCli,
    reasoning: string | null,
  ) => void
  setSpecialistOrder: (order: SpecialistActionId[]) => void
  setSpecialistPackEnabled: (packId: string, enabled: boolean) => void
  /** Mark the one-time MC-1587 bundled-pack migration as evaluated for this profile. */
  markBundledSpecialistPackMigrated: () => void
  // Command ids are open strings: shell registry ids plus namespaced module
  // command ids (`<moduleId>.<commandId>`). The Shortcuts tab only offers rows
  // the merged registry currently exposes.
  setCommandKeybindings: (commandId: string, keybindings: string[]) => void
  setCommandKeybindingDisabled: (commandId: string, disabled: boolean) => void
  resetCommandKeybindings: (commandId: string) => void
  resetAllKeybindings: () => void
  setSprintEngineRoleEnabled: (role: SprintEngineRoleId, enabled: boolean) => void
  /**
   * Create or update a named roster team. When `id` is supplied and matches an
   * existing team, that team is updated in place; otherwise a new team is added.
   * Returns the team id (empty string if the name was blank).
   */
  saveSprintEngineRoster: (input: {
    id?: string
    name: string
    roleCounts: SprintEngineRoleCounts
    roleCliDefaults: SprintEngineRoleCliDefaults
    roleModelOverrides?: SprintEngineRoleModelOverrides
  }) => string
  /** Rename a saved team in place. Leaves its roster (counts + CLI defaults)
   *  untouched so renaming is orthogonal to saving roster edits. */
  renameSprintEngineRoster: (id: string, name: string) => void
  deleteSprintEngineRoster: (id: string) => void
  setSprintEngineLastSelectedRoster: (id: string | null) => void
  setModuleEnabled: (moduleId: string, enabled: boolean) => void
  /**
   * Write one value in a module's settings namespace (`module:<moduleId>`).
   * `undefined` deletes the key. Module enablement never touches this state,
   * so values survive a disable/enable cycle.
   */
  setModuleSettingValue: (moduleId: string, key: string, value: unknown) => void
  /** Record the user's "not now" on the first-run CLI card. One way only —
   *  there is no affordance that brings the card back, and none should be. */
  dismissFirstRunCliCard: () => void
  /** Mark this profile's one-time agent-config adoption as done. */
  markAgentConfigAdopted: () => void
  /** Set (or clear with `null`) the live outcome of the first-run adoption,
   *  read out as one line in Settings → Agents. */
  setAgentConfigAdoptionResult: (result: AgentConfigAdoptionResult | null) => void
  setSearchExcludes: (patterns: string[]) => void
  /** Set how long an idle agent terminal waits before it is paused (minutes). */
  setTerminalIdleSuspendMinutes: (minutes: number) => void
  setTerminalKeepRecentAlive: (count: number) => void
  setGuidedBriefConversationSessions: (enabled: boolean) => void
  setUsageTelemetrySettings: (update: Partial<UsageTelemetrySettings>) => void
  setVoiceDictationSettings: (update: Partial<VoiceDictationSettings>) => void
  setLearningShowTipsOnStartup: (enabled: boolean) => void
  markLearningTipSeen: (tipId: string) => void
  markLearningLessonCompleted: (lessonId: string, completed?: boolean) => void
  resetLearningProgress: () => void
  setAppearanceTheme: (theme: AppTheme) => void
  setAppearanceWindowMaterial: (material: WindowMaterial) => void
}

export type SettingsSlice = SettingsSliceState & SettingsSliceActions

type SettingsSliceCarrier = SettingsSliceState & { workspaces: Workspace[] }
type SettingsSliceSet = (mutator: (state: SettingsSliceCarrier) => void) => void

export function createSettingsSlice(set: SettingsSliceSet): SettingsSlice {
  return {
    appSettings: defaultAppSettings(),
    settingsOverlay: { initialTab: null, checkForUpdatesRequestId: null },
    runSummaryOverlay: { open: false, workspaceId: null },
    activeGlobalSurface: null,
    sidebarCollapsed: false,
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
    workspaceAsideOpen: false,
    workspaceAsideWidth: WORKSPACE_ASIDE_DEFAULT_WIDTH,
    openFilesInExternalWindow: DEFAULT_OPEN_FILES_IN_EXTERNAL_WINDOW,
    sprintEngineRoleRegistry: null,
    agentConfigAdoptionResult: null,

    setSprintEngineRoleRegistry: (registry) =>
      set((state) => {
        state.sprintEngineRoleRegistry = registry
      }),

    setSidebarCollapsed: (collapsed) =>
      set((state) => {
        state.sidebarCollapsed = collapsed
      }),

    setSidebarWidth: (width) =>
      set((state) => {
        state.sidebarWidth = clampSidebarWidth(width)
      }),

    // No caller today: the column is unclaimed, so nothing can open it. Kept as
    // the seam's open/close half — a tenant wires its own trigger to it.
    setWorkspaceAsideOpen: (open) =>
      set((state) => {
        state.workspaceAsideOpen = open
      }),

    setOpenFilesInExternalWindow: (enabled) =>
      set((state) => {
        state.openFilesInExternalWindow = enabled
      }),

    openSettingsOverlay: (opts) => {
      // The MCPs / Skill packs / Extensions settings tabs folded into the
      // connectors surface (T3), which is the Extensions door now (MC-1847).
      // Deep-links that once opened one of those tabs land on the door, so no
      // caller has to know either move happened; the old skill-packs tab lands
      // on Skills, which is what it was asking for (MC-1936). The latch
      // dispatch stays outside the producer — its listeners run synchronously
      // and must never observe a mid-update store.
      if (isConnectorsFoldedSettingsTab(opts?.initialTab)) {
        dispatchExtensionsSurfaceTarget(opts?.initialTab === SKILLS_SETTINGS_TAB ? 'skills' : 'browse')
        set((state) => {
          // Both are doors, and a door replaces a door: opening Extensions from
          // inside Settings leaves nothing of Settings behind.
          state.activeGlobalSurface = 'extensions'
          state.settingsOverlay.initialTab = null
          state.settingsOverlay.checkForUpdatesRequestId = null
        })
        return
      }
      set((state) => {
        state.activeGlobalSurface = 'settings'
        state.settingsOverlay.initialTab = opts?.initialTab ?? null
        state.settingsOverlay.checkForUpdatesRequestId = opts?.checkForUpdates ? Date.now() : null
      })
    },

    closeSettingsOverlay: () =>
      set((state) => {
        // Only ever closes SETTINGS: a caller that means "leave settings" must
        // not clear another door someone navigated to in the meantime.
        if (state.activeGlobalSurface === 'settings') state.activeGlobalSurface = null
        state.settingsOverlay.initialTab = null
        state.settingsOverlay.checkForUpdatesRequestId = null
      }),


    openRunSummaryOverlay: (workspaceId) =>
      set((state) => {
        state.runSummaryOverlay.open = true
        state.runSummaryOverlay.workspaceId = workspaceId
      }),

    closeRunSummaryOverlay: () =>
      set((state) => {
        state.runSummaryOverlay.open = false
        state.runSummaryOverlay.workspaceId = null
      }),

    setWorkspaceAsideWidth: (width) =>
      set((state) => {
        state.workspaceAsideWidth = clampWorkspaceAsideWidth(width)
      }),

    openExtensionsSurface: (opts) => {
      // Latch the deep-link first (the door drains it on mount or live), then
      // open the door — the same order the automations deep-link uses. The
      // dispatch stays outside the producer so its synchronous listeners never
      // observe a mid-update store.
      dispatchExtensionsSurfaceTarget(opts?.view ?? 'browse')
      set((state) => {
        state.activeGlobalSurface = 'extensions'
        // Callers can sit inside the Settings door (Settings → Modules
        // "Browse marketplace"): one door replaces the other, and the settings
        // request it was carrying goes with it.
        state.settingsOverlay.initialTab = null
        state.settingsOverlay.checkForUpdatesRequestId = null
      })
    },

    // The Roadmap door routes to the
    // door-routed full-page surface (global-surfaces epic 1704). A named
    // convenience over openGlobalSurface('roadmap') so every caller opens the same
    // surface; the legacy centered overlay + its store flag are retired (T2).
    openRoadmapSurface: () =>
      set((state) => {
        state.activeGlobalSurface = 'roadmap'
      }),

    openGlobalSurface: (surfaceId) =>
      set((state) => {
        state.activeGlobalSurface = surfaceId
      }),

    closeGlobalSurface: () =>
      set((state) => {
        state.activeGlobalSurface = null
      }),

    setCliRuntime: (cli, update) =>
      set((state) => {
        const defaults = defaultAppSettings()
        state.appSettings.cliRuntimes ??= defaults.cliRuntimes
        // Unknown plugin ids default to a blank command so a row the user only
        // toggles WSL on does not pin the command to the plugin id; a blank
        // command resolves to the plugin manifest binary at launch.
        const fallback = defaults.cliRuntimes[cli] ?? { command: '', useWsl: false }
        state.appSettings.cliRuntimes[cli] = {
          ...fallback,
          ...state.appSettings.cliRuntimes[cli],
          ...update,
        }
      }),

    setCliModelCatalog: (cli, catalog) =>
      set((state) => {
        // Only an explicit null clears. A payload that fails normalization is
        // not written at all: a probe that came back unusable must leave the
        // pickers rendering exactly what they rendered before, not wipe the
        // CLI's last good answer.
        const normalized = catalog ? normalizeCliModelCatalogs({ [cli]: catalog })?.[cli] : undefined
        if (catalog && !normalized) return
        const next = { ...state.appSettings.cliModelCatalog }
        if (normalized) {
          next[cli] = normalized
        } else {
          delete next[cli]
        }
        state.appSettings.cliModelCatalog = Object.keys(next).length > 0 ? next : undefined
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

    setLastSelectedCli: (cli) =>
      set((state) => {
        state.appSettings.lastSelectedCli = cli
      }),

    setLastSelectedConversationModel: (selection) =>
      set((state) => {
        state.appSettings.lastSelectedConversationModel = normalizeConversationModel(selection)
      }),

    setLastSelectedReview: (selection) =>
      set((state) => {
        state.appSettings.lastSelectedReview = normalizeLastSelectedReview(selection)
      }),

    setReviewGuideDefaults: (patch) =>
      set((state) => {
        state.appSettings.reviewGuideDefaults = normalizeReviewGuideDefaults({
          ...state.appSettings.reviewGuideDefaults,
          ...patch,
        })
      }),

    setLastSelectedSpecialist: (specialistId) =>
      set((state) => {
        state.appSettings.lastSelectedSpecialist = specialistId
      }),

    setLastSpawnWasGeneral: (value) =>
      set((state) => {
        state.appSettings.lastSpawnWasGeneral = value
      }),

    setLastNewChatAgent: (choice) =>
      set((state) => {
        state.appSettings.lastNewChatAgent = normalizeNewChatAgentChoice(choice)
      }),

    setLastFolderOpenTarget: (target) =>
      set((state) => {
        state.appSettings.lastFolderOpenTarget = isFolderOpenTargetId(target) ? target : null
      }),

    setLastAgentSpawnPermissionPreset: (preset) =>
      set((state) => {
        // An explicit user pick, so the plain normalizer: choosing 'default'
        // must stay 'default' and not snap back to the app-wide bypass default.
        const nextPreset = normalizeCliPermissionPreset(preset)
        state.appSettings.lastAgentSpawnPermissionPreset = nextPreset
        const runSettings = normalizeSprintEngineRunSettings(state.appSettings.sprintEngineRunSettings)
        state.appSettings.sprintEngineRunSettings = runSettings
        const changedAt = Date.now()
        for (const workspace of state.workspaces) {
          if (!workspace.sprintEngineState || !workspace.sprintEngineAutoState) continue
          const key = sprintEngineRunSettingsKey(workspace.sprintEngineContext?.statePath)
          if (!key || runSettings[key]) continue
          workspace.sprintEngineAutoState = {
            ...workspace.sprintEngineAutoState,
            cliPermissionPreset: nextPreset,
            changedAt,
          }
        }
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

    setSpecialistModelDefault: (specialistId, selection) =>
      set((state) => {
        state.appSettings.specialistModelDefaults ??= {}
        if (!selection) {
          delete state.appSettings.specialistModelDefaults[specialistId]
          return
        }
        const model = selection.model.trim()
        const stored = state.appSettings.specialistModelDefaults[specialistId]
        // Effort is per-CLI: a level chosen for this CLI outlives a model
        // change (including a switch to the CLI's default model), and a level
        // chosen for a different CLI is dropped rather than carried onto a CLI
        // that may not accept it. An explicit `reasoning` on the incoming
        // selection wins over the stored one.
        const reasoning = (
          selection.reasoning ?? (stored?.cli === selection.cli ? stored.reasoning : undefined)
        )?.trim()
        if (!model && !reasoning) {
          delete state.appSettings.specialistModelDefaults[specialistId]
          return
        }
        state.appSettings.specialistModelDefaults[specialistId] = {
          cli: selection.cli,
          model,
          ...(reasoning ? { reasoning } : {}),
        }
      }),

    setSpecialistReasoningDefault: (specialistId, cli, reasoning) =>
      set((state) => {
        state.appSettings.specialistModelDefaults ??= {}
        const level = reasoning?.trim()
        const stored = state.appSettings.specialistModelDefaults[specialistId]
        // The model only survives when it belongs to the CLI the level was
        // picked for; a level for another CLI starts that CLI's selection on
        // its own default model.
        const model = stored?.cli === cli ? stored.model : ''
        if (!level && !model) {
          delete state.appSettings.specialistModelDefaults[specialistId]
          return
        }
        state.appSettings.specialistModelDefaults[specialistId] = {
          cli,
          model,
          ...(level ? { reasoning: level } : {}),
        }
      }),

    setSpecialistOrder: (order) =>
      set((state) => {
        state.appSettings.specialistOrder = normalizeSpecialistOrder(order)
      }),

    setSpecialistPackEnabled: (packId, enabled) =>
      set((state) => {
        const id = packId.trim()
        if (!id) return
        const current = normalizeSpecialistPacks(state.appSettings.specialistPacks)
        const disabled = new Set(current.disabled)
        if (enabled) {
          disabled.delete(id)
        } else {
          disabled.add(id)
        }
        // Preserve migratedBundledPack: a pack toggle must never reset the
        // one-time migration guard, or a later uninstall would be undone.
        state.appSettings.specialistPacks = { disabled: [...disabled], migratedBundledPack: current.migratedBundledPack }
      }),

    markBundledSpecialistPackMigrated: () =>
      set((state) => {
        const current = normalizeSpecialistPacks(state.appSettings.specialistPacks)
        state.appSettings.specialistPacks = { disabled: current.disabled, migratedBundledPack: true }
      }),

    // The setters accept any non-empty command id: the Shortcuts tab only
    // offers rows from the merged shell + enabled-module registry, and stored
    // deltas for ids that are not currently registered are inert until the
    // owning module is enabled again.
    setCommandKeybindings: (commandId, keybindings) =>
      set((state) => {
        if (!commandId.trim()) return
        const current = normalizeKeybindingSettings(state.appSettings.keybindings)
        const normalized = normalizeCommandKeybindings(keybindings)
        const legacyId = LEGACY_COMMAND_ID_ALIASES[commandId]
        if (normalized.length === 0) {
          delete current.overrides[commandId]
          // Clearing must also drop a persisted legacy-id override, or the
          // read paths would resurrect the stale binding.
          if (legacyId) delete current.overrides[legacyId]
        } else {
          current.overrides[commandId] = normalized
          // The new-id override now owns the binding; the legacy entry would
          // only shadow future clears.
          if (legacyId) delete current.overrides[legacyId]
        }
        state.appSettings.keybindings = current
      }),

    setCommandKeybindingDisabled: (commandId, disabled) =>
      set((state) => {
        if (!commandId.trim()) return
        const current = normalizeKeybindingSettings(state.appSettings.keybindings)
        // A migrated command's persisted state may live under its legacy id
        // (LEGACY_COMMAND_ID_ALIASES) — writes must clear it, or re-enabling
        // could never stick (the read paths honor the legacy key).
        const legacyId = LEGACY_COMMAND_ID_ALIASES[commandId]
        if (disabled) {
          current.disabled[commandId] = true
        } else {
          delete current.disabled[commandId]
          if (legacyId) delete current.disabled[legacyId]
        }
        state.appSettings.keybindings = current
      }),

    resetCommandKeybindings: (commandId) =>
      set((state) => {
        if (!commandId.trim()) return
        const current = normalizeKeybindingSettings(state.appSettings.keybindings)
        const legacyId = LEGACY_COMMAND_ID_ALIASES[commandId]
        delete current.overrides[commandId]
        delete current.disabled[commandId]
        if (legacyId) {
          delete current.overrides[legacyId]
          delete current.disabled[legacyId]
        }
        state.appSettings.keybindings = current
      }),

    resetAllKeybindings: () =>
      set((state) => {
        state.appSettings.keybindings = defaultKeybindingSettings()
      }),

    setSprintEngineRoleEnabled: (role, enabled) =>
      set((state) => {
        const id = role.trim()
        if (!id) return
        if (id === PROTECTED_SPRINT_ENGINE_ROLE_ID && enabled === false) return
        const current = normalizeSprintEngineRoleSettings(state.appSettings.sprintEngineRoleSettings)
        state.appSettings.sprintEngineRoleSettings = {
          ...current,
          enabled: {
            ...current.enabled,
            [id]: enabled,
          },
        }
      }),

    saveSprintEngineRoster: (input) => {
      const name = input.name.trim()
      if (!name) return ''
      // MC-1876: the built-in "No roles" is synthetic and reserved. Refusing
      // both its id and its name here — not just in the UI's validation — is
      // what makes "it cannot be renamed, edited, or deleted" true rather than
      // merely unreachable through the happy path.
      if (isNoRolesRosterRef(name) || isNoRolesRosterRef(input.id)) return ''
      const roster = normalizeSprintEngineSavedRoster({
        roleCounts: input.roleCounts,
        roleCliDefaults: input.roleCliDefaults,
        roleModelOverrides: input.roleModelOverrides,
      }) ?? { roleCounts: { architect: 1 } as SprintEngineRoleCounts, roleCliDefaults: {} }
      const id = input.id?.trim() || nanoid()
      const now = Date.now()
      set((state) => {
        const current = normalizeSprintEngineRoleSettings(state.appSettings.sprintEngineRoleSettings)
        const teams = [...(current.savedRosters ?? [])]
        const existingIndex = teams.findIndex((team) => team.id === id)
        if (existingIndex >= 0) {
          teams[existingIndex] = {
            ...teams[existingIndex],
            name,
            roleCounts: roster.roleCounts,
            roleCliDefaults: roster.roleCliDefaults,
            // Explicitly overwrite (not spread-merge) so clearing every model
            // override on an edited team drops the stale map instead of keeping it.
            roleModelOverrides: roster.roleModelOverrides,
            updatedAt: now,
          }
        } else {
          teams.push({
            id,
            name,
            roleCounts: roster.roleCounts,
            roleCliDefaults: roster.roleCliDefaults,
            roleModelOverrides: roster.roleModelOverrides,
            createdAt: now,
            updatedAt: now,
          })
        }
        state.appSettings.sprintEngineRoleSettings = {
          ...current,
          savedRosters: teams,
          lastSelectedRosterId: id,
          // Keep the legacy default in sync so run-mount CLI defaults stay meaningful.
          savedRoster: roster,
        }
      })
      return id
    },

    renameSprintEngineRoster: (id, name) => {
      const teamId = id.trim()
      const nextName = name.trim()
      if (!teamId || !nextName) return
      set((state) => {
        const current = normalizeSprintEngineRoleSettings(state.appSettings.sprintEngineRoleSettings)
        const teams = current.savedRosters ?? []
        const index = teams.findIndex((team) => team.id === teamId)
        if (index < 0) return
        const updated = [...teams]
        updated[index] = { ...updated[index], name: nextName, updatedAt: Date.now() }
        state.appSettings.sprintEngineRoleSettings = {
          ...current,
          savedRosters: updated,
        }
      })
    },

    deleteSprintEngineRoster: (id) =>
      set((state) => {
        const teamId = id.trim()
        if (!teamId) return
        const current = normalizeSprintEngineRoleSettings(state.appSettings.sprintEngineRoleSettings)
        const teams = (current.savedRosters ?? []).filter((team) => team.id !== teamId)
        state.appSettings.sprintEngineRoleSettings = {
          ...current,
          savedRosters: teams,
          lastSelectedRosterId: current.lastSelectedRosterId === teamId ? null : current.lastSelectedRosterId,
        }
      }),

    setSprintEngineLastSelectedRoster: (id) =>
      set((state) => {
        const current = normalizeSprintEngineRoleSettings(state.appSettings.sprintEngineRoleSettings)
        const teamId = id?.trim() || null
        // MC-1876: picking the built-in must STICK. It is not in savedRosters
        // (by design), so without this branch the lookup below would fail, the
        // pointer would clear, and the next resolve would fall through to the
        // legacy savedRoster mirror — silently re-staffing "No roles" with the
        // last specialist roster the user touched.
        if (isNoRolesRosterRef(teamId)) {
          state.appSettings.sprintEngineRoleSettings = {
            ...current,
            lastSelectedRosterId: NO_ROLES_ROSTER_ID,
            // The legacy mirror is deliberately left alone: it is the run-mount
            // CLI-default fallback, not a staffing source for the built-in.
          }
          return
        }
        const team = teamId ? (current.savedRosters ?? []).find((entry) => entry.id === teamId) ?? null : null
        state.appSettings.sprintEngineRoleSettings = {
          ...current,
          lastSelectedRosterId: team ? team.id : null,
          // Mirror the picked team into the legacy default for run-mount fallback,
          // including its model overrides so savedRoster stays a faithful mirror
          // (matches what saveSprintEngineRoster writes).
          savedRoster: team
            ? {
                roleCounts: team.roleCounts,
                roleCliDefaults: team.roleCliDefaults,
                ...(team.roleModelOverrides ? { roleModelOverrides: team.roleModelOverrides } : {}),
              }
            : current.savedRoster,
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

    setModuleSettingValue: (moduleId, key, value) =>
      set((state) => {
        const id = moduleId.trim()
        const settingKey = key.trim()
        if (!id || !settingKey) return
        const namespace = moduleSettingsNamespace(id)
        const current = normalizeModuleSettings(state.appSettings.moduleSettings)
        const entry = { ...(current[namespace] ?? {}) }
        if (value === undefined) {
          delete entry[settingKey]
        } else {
          entry[settingKey] = value
        }
        state.appSettings.moduleSettings = { ...current, [namespace]: entry }
      }),

    dismissFirstRunCliCard: () =>
      set((state) => {
        state.appSettings.firstRunCliCardDismissed = true
      }),

    markAgentConfigAdopted: () =>
      set((state) => {
        state.appSettings.hasAdoptedAgentConfig = true
      }),

    setAgentConfigAdoptionResult: (result) =>
      set((state) => {
        state.agentConfigAdoptionResult = result
      }),

    setSearchExcludes: (patterns) =>
      set((state) => {
        state.appSettings.searchExcludes = normalizeSearchExcludes(patterns)
      }),

    setTerminalIdleSuspendMinutes: (minutes) =>
      set((state) => {
        state.appSettings.terminalIdleSuspendMinutes = normalizeTerminalIdleSuspendMinutes(minutes)
      }),

    setTerminalKeepRecentAlive: (count) =>
      set((state) => {
        state.appSettings.terminalKeepRecentAlive = normalizeTerminalKeepRecentAlive(count)
      }),

    setGuidedBriefConversationSessions: (enabled) =>
      set((state) => {
        // Record the user's explicit choice verbatim. The reset stamp travels
        // with it so the choice is self-carrying: hydration honors a stored
        // `true` only alongside the stamp, and this is the one place a `true`
        // is written on purpose rather than inherited from the old default.
        state.appSettings.guidedBriefConversationSessions = enabled === true
        state.appSettings.guidedBriefConversationSessionsOptInReset = true
      }),

    setUsageTelemetrySettings: (update) =>
      set((state) => {
        state.appSettings.usageTelemetry = normalizeUsageTelemetrySettings({
          ...state.appSettings.usageTelemetry,
          ...update,
        })
      }),

    setVoiceDictationSettings: (update) =>
      set((state) => {
        state.appSettings.voiceDictation = normalizeVoiceDictationSettings({
          ...(state.appSettings.voiceDictation ?? defaultVoiceDictationSettings()),
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

    setAppearanceWindowMaterial: (material) =>
      set((state) => {
        state.appSettings.appearance = normalizeAppearanceSettings({
          ...state.appSettings.appearance,
          windowMaterial: material,
        })
      }),
  }
}
