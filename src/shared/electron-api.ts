import type { TranscriptionRequestSettings, VoiceTranscribeResponse } from './voiceTranscription'
import type {
  AutomationRendererRequest,
  AutomationRendererResponse,
  AutomationServerStatus,
} from './automation'
import type {
  AutomationsCreateInput,
  AutomationsDefinitionInput,
  AutomationsDefinitionResult,
  AutomationsDeleteResult,
  AutomationsEngineStatusResult,
  AutomationsListResult,
  AutomationsProvidersResult,
  AutomationsRunEvent,
  AutomationsRunFinalizeInput,
  AutomationsRunFinalizeResult,
  AutomationsRunNowResult,
  AutomationsRunsListInput,
  AutomationsRunsListResult,
  AutomationsUpdateInput,
  AutomationsWorkspaceInput,
} from './automations/contracts'
import type {
  SwitchboardAddCommentInput,
  SwitchboardCancelTaskInput,
  SwitchboardClaimTaskInput,
  SwitchboardClaimTaskResult,
  SwitchboardCreateTaskInput,
  SwitchboardInitApiResult,
  SwitchboardImportResult,
  SwitchboardMoveTaskInput,
  SwitchboardMutationResult,
  SwitchboardPromoteInboxTaskInput,
  SwitchboardPublishTaskInput,
  SwitchboardReadResult,
  SwitchboardRecoverLockInput,
  SwitchboardRecoverLockResult,
  SwitchboardRequeueTaskInput,
  SwitchboardRunnerResult,
  SwitchboardRunnerStartInput,
  SwitchboardRunnerWorkspaceInput,
  SwitchboardExecutionLogsInput,
  SwitchboardExecutionLogsResult,
  SwitchboardExecutionStatusInput,
  SwitchboardExecutionStatusResult,
  SwitchboardStopExecutionInput,
  SwitchboardStopExecutionResult,
  SwitchboardUpdateTaskInput,
  WatchtowerRunListResult,
  WatchtowerRunResult,
  WatchtowerStartReviewInput,
  WatchtowerStartTriageInput,
} from './switchboard'
import type {
  RoleInstallResult,
  UserRoleDeleteResult,
  UserRoleGetResult,
  UserRoleListResult,
  UserRoleSaveInput,
  UserRoleSaveResult,
} from './sprintengine/role-manifest'
export type {
  UserRoleDeleteResult,
  UserRoleGetResult,
  UserRoleSaveInput,
  UserRoleSaveResult,
} from './sprintengine/role-manifest'
import type { LayoutTemplateInstallResult, UserLayoutTemplateListResult } from './layouts/template-manifest'
import type { ConversationProviderListEntry, ConversationProviderModel, PluginRegistryListEntry } from './plugin-manifest'
import type { MarketplaceComponentKind, MarketplaceIndex, MarketplaceManifestIssue, MarketplacePluginEntry } from './marketplace/manifest'
import type { CapabilityPermission } from './modules/permissions'
import type {
  ConversationEvent,
  ConversationInterruptInput,
  ConversationListSessionsInput,
  ConversationListSessionsResult,
  ConversationProviderTestInput,
  ConversationProviderTestResult,
  ConversationRespondToRequestInput,
  ConversationSendTurnInput,
  ConversationSessionActionResult,
  ConversationStartSessionInput,
  ConversationStartSessionResult,
  ConversationStopSessionInput,
} from './conversation-runtime'
import type {
  ModuleTrustStatus,
  ThirdPartyModuleInstallResult,
  ThirdPartyModuleListResult,
  ThirdPartyModuleTrustResult,
  ThirdPartyRendererEntriesResult,
} from './modules/manifest'
import type {
  WorkspaceSyncCommand,
  WorkspaceSyncCommandResult,
  WorkspaceSyncEvent,
  WorkspaceSyncSnapshot,
} from './workspace-sync'

export type SaveDialogOptions = {
  title?: string
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}

export type OpenDialogOptions = {
  title?: string
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}

export interface ContextMenuItem {
  id?: string
  label?: string
  enabled?: boolean
  type?: 'normal' | 'separator' | 'checkbox'
  checked?: boolean
  submenu?: ContextMenuItem[]
}

export interface FileWatchEvent {
  eventType: string
  path: string | null
}

export type FileSystemStat = {
  isFile: boolean
  isDirectory: boolean
  sizeBytes: number
  modifiedAt: string
  modifiedAtMs: number
}

export type FileSearchEntry = {
  name: string
  path: string
  parentPath: string
  isDir: false
}

export type FileSearchResult =
  | {
      ok: true
      results: FileSearchEntry[]
      truncated: boolean
      engine: 'ripgrep'
      elapsedMs: number
      resultCount: number
    }
  | {
      ok: false
      message: string
      engine: 'ripgrep' | null
    }

export type ContentSearchEntry = {
  name: string
  path: string
  parentPath: string
  lineNumber: number
  column: number
  lineText: string
  matchText: string
}

export type ContentSearchResult =
  | {
      ok: true
      results: ContentSearchEntry[]
      truncated: boolean
      engine: 'ripgrep'
      elapsedMs: number
      resultCount: number
    }
  | {
      ok: false
      message: string
      engine: 'ripgrep' | null
    }

export type MemoryGraphNodeKind = 'markdown' | 'image' | 'text' | 'asset'

export type MemoryGraphNode = {
  id: string
  path: string
  relativePath: string
  name: string
  kind: MemoryGraphNodeKind
  extension: string
  sizeBytes: number
  degree: number
  inboundDegree: number
  group: string
  title?: string
  type?: string
  tags?: string[]
  related?: string[]
}

export type MemoryGraphEdge = {
  id: string
  source: string
  target: string
  sourcePath: string
  targetPath: string
}

export type MemoryUnresolvedLink = {
  sourcePath: string
  href: string
  resolvedRelativePath: string | null
  reason: 'missing' | 'outside-root'
}

export type MemoryRootStatus =
  | { ok: true; rootPath: string; relativeRoot: string }
  | {
      ok: false
      status: 'missing-workspace' | 'invalid-relative-path' | 'missing-memory-root' | 'inaccessible'
      relativeRoot: string | null
      message: string
    }

export type MemoryGraphIndexResult =
  | {
      ok: true
      rootPath: string
      relativeRoot: string
      nodes: MemoryGraphNode[]
      edges: MemoryGraphEdge[]
      groups: string[]
      unresolvedLinks: MemoryUnresolvedLink[]
      indexedAt: number
    }
  | Extract<MemoryRootStatus, { ok: false }>

export type MemoryPreviewResult =
  | { ok: true; node: MemoryGraphNode; previewKind: 'markdown' | 'text'; content: string }
  | { ok: true; node: MemoryGraphNode; previewKind: 'image'; dataUrl: string }
  | { ok: true; node: MemoryGraphNode; previewKind: 'unsupported'; message: string }
  | { ok: false; message: string }

export type MemoryActivityEvent = {
  workspaceRoot: string
  sessionId: string
  nodeId: string
  prevNodeId: string | null
  tool: string
  ts: number
  synapseCount: number
}

export type MemoryActivitySynapse = {
  src: string
  dst: string
  count: number
  lastTs: number
}

export type MemoryActivityStatus = {
  workspaceRoot: string | null
  isInstalled: boolean
  isWatching: boolean
  sessionsRecorded: number
  totalEvents: number
  eventsToday: number
  lastEventAt: number | null
}

export type MemoryActivityInstallResult =
  | { ok: true; settingsPath: string; hookScriptPath: string }
  | { ok: false; message: string }

export type MemoryActivityUninstallResult =
  | { ok: true }
  | { ok: false; message: string }

export type MemoryActivitySynapsesPayload = {
  workspaceRoot: string
  synapses: MemoryActivitySynapse[]
}

export type BuiltinSkill = {
  id: string
  name: string
  version: string
  description: string
  harnesses?: SkillPackHarness[]
  targetPolicy?: 'agents' | 'all-native'
}

export type BuiltinSkillTargetState = {
  harness: string
  destinationPath?: string
  status: 'missing' | 'installed' | 'update-available' | 'modified' | 'local' | 'prompt-shim' | 'unsupported'
  installedVersion?: string
  pluginId?: string
  displayName?: string
  support?: 'native' | 'prompt-shim' | 'unsupported'
  installScope?: 'workspace' | 'user'
  format?: string
  restartRequired?: boolean
}

export type BuiltinSkillStatus =
  | { ok: true; status: 'missing'; skill: BuiltinSkill; destinationPath: string; targets: BuiltinSkillTargetState[] }
  | { ok: true; status: 'installed'; skill: BuiltinSkill; destinationPath: string; installedVersion: string; targets: BuiltinSkillTargetState[] }
  | { ok: true; status: 'update-available'; skill: BuiltinSkill; destinationPath: string; installedVersion: string; targets: BuiltinSkillTargetState[] }
  | { ok: true; status: 'modified'; skill: BuiltinSkill; destinationPath: string; installedVersion: string; targets: BuiltinSkillTargetState[] }
  | { ok: true; status: 'local'; skill: BuiltinSkill; destinationPath: string; message: string; targets: BuiltinSkillTargetState[] }
  | { ok: false; status: 'unknown-skill' | 'missing-workspace' | 'missing-source'; skillId: string; message: string }

export type BuiltinSkillInstallResult =
  | { ok: true; status: 'installed' | 'updated'; skill: BuiltinSkill; destinationPath: string; skipped?: BuiltinSkillTargetState[] }
  | { ok: false; status: 'unknown-skill' | 'missing-workspace' | 'missing-source' | 'modified' | 'local'; skillId: string; message: string }

export type PluginRegistryListResult =
  | { ok: true; plugins: PluginRegistryListEntry[] }
  | { ok: false; message: string }

// Whether a single agent CLI's binary is actually installed/runnable on this
// machine, distinct from whether its plugin manifest is registered. Bundled
// manifests (e.g. `codex`, `claude-code`) are always registered; this says
// which of them the user can really deploy.
export type CliAvailability = {
  cli: AgentCli
  installed: boolean
  resolvedPath: string | null
  version: string | null
}

// Detected availability for every registered agent CLI, keyed by plugin id.
export type AgentCliAvailabilityMap = Record<AgentCli, CliAvailability>

export type PluginAvailabilityResult =
  | { ok: true; availability: AgentCliAvailabilityMap }
  | { ok: false; message: string }

// Per-CLI runtime overrides the renderer forwards into a batch availability
// probe so detection runs against the same command/WSL mode each CLI launches
// with. `force` bypasses the main-process TTL cache (used after an install).
export type PluginDetectAvailabilityInput = {
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
  force?: boolean
}

export type PluginInstallResult =
  | { ok: true; id: string; kind: 'cli' | 'provider'; displayName: string }
  | { ok: false; message: string; issues?: Array<{ path: string; message: string }> }

export type MarketplacePluginInstallInput = {
  localFolder: string
  workspaceRoot?: string
  mcpSettings?: McpSettings
  mcpClients?: McpClientTarget[]
  skillHarnesses?: SkillPackHarness[]
}

export type MarketplacePluginRegistryInstallInput = Omit<MarketplacePluginInstallInput, 'localFolder'> & {
  entry: MarketplacePluginEntry
  trustGranted?: boolean
}

export type MarketplacePluginUninstallInput = {
  pluginId: string
  workspaceRoot?: string
  mcpSettings?: McpSettings
  mcpClients?: McpClientTarget[]
  skillHarnesses?: SkillPackHarness[]
}

export type MarketplacePluginTrustClassification = 'verified' | 'community' | 'unsigned' | 'invalid'

export type MarketplacePluginVerifyResult = {
  classification: MarketplacePluginTrustClassification
  permissions: CapabilityPermission[]
  sourceUrl: string
  issues?: MarketplaceManifestIssue[]
  message?: string
}

export type MarketplacePluginInstalledComponent = {
  kind: MarketplaceComponentKind
  id: string
  message?: string
  serverIds?: string[]
  servers?: McpServerConfig[]
  harnesses?: SkillPackHarness[]
  installedDirName?: string
}

export type MarketplacePluginInstallResult =
  | {
      ok: true
      id: string
      displayName: string
      version: number
      trust: ModuleTrustStatus
      loadEligible: boolean
      installed: MarketplacePluginInstalledComponent[]
      mcpSettings?: McpSettings
    }
  | {
      ok: false
      message: string
      component?: MarketplaceComponentKind
      issues?: Array<{ path: string; message: string }>
      installed?: MarketplacePluginInstalledComponent[]
      trust?: ModuleTrustStatus
      loadEligible?: boolean
    }

export type MarketplacePluginRegistryInstallResult =
  | (Extract<MarketplacePluginInstallResult, { ok: true }> & {
      classification: Extract<MarketplacePluginTrustClassification, 'verified' | 'community'>
      sourceUrl: string
      updated: boolean
    })
  | (Extract<MarketplacePluginInstallResult, { ok: false }> & {
      classification?: MarketplacePluginTrustClassification
      sourceUrl?: string
      updated?: boolean
    })

export type MarketplacePluginUninstallResult =
  | {
      ok: true
      id: string
      removed: MarketplacePluginInstalledComponent[]
      mcpSettings?: McpSettings
    }
  | {
      ok: false
      message: string
      removed?: MarketplacePluginInstalledComponent[]
      mcpSettings?: McpSettings
    }

export type MarketplaceRegistryState = 'ok' | 'empty' | 'offline' | 'fetch-error' | 'invalid-schema'

export type MarketplaceRegistryReadInput = {
  forceRefresh?: boolean
}

export type MarketplaceRegistryReadResult =
  | {
      ok: true
      state: 'ok' | 'empty'
      registryUrl: string
      source: 'network' | 'cache'
      stale: false
      fetchedAt: string
      etag?: string
      notModified?: boolean
      marketplace: MarketplaceIndex
    }
  | {
      ok: true
      state: 'offline'
      registryUrl: string
      source: 'cache' | 'seed'
      stale: boolean
      fetchedAt: string
      etag?: string
      marketplace: MarketplaceIndex
      message: string
    }
  | {
      ok: false
      state: Exclude<MarketplaceRegistryState, 'ok' | 'empty'>
      registryUrl: string
      stale: false
      message: string
      statusCode?: number
      issues?: MarketplaceManifestIssue[]
    }

export type ConversationProviderListResult =
  | { ok: true; providers: ConversationProviderListEntry[] }
  | { ok: false; message: string }

export type ConversationProviderModelsInput = {
  providerId: string
}

export type ConversationProviderModelsResult =
  | { ok: true; models: ConversationProviderModel[] }
  | { ok: false; message: string }

export type ConversationSecretStatus = {
  providerId: string
  configured: boolean
  source: 'settings' | 'session' | 'environment' | 'none'
  persistence: 'encrypted' | 'session' | 'environment'
  encryptionAvailable: boolean
  label: string
}

export type ConversationSecretStatusInput = {
  providerId: string
}

export type ConversationSecretSetInput = ConversationSecretStatusInput & {
  value: string
}

export type ConversationSecretClearInput = ConversationSecretStatusInput

export type ConversationSecretStatusResult =
  | { ok: true; status: ConversationSecretStatus }
  | { ok: false; message: string }

export type ConversationSecretSetResult = ConversationSecretStatusResult

export type ConversationSecretClearResult = ConversationSecretStatusResult

// Runtime CLI identity is a plugin id. Bundled choices include `codex` and
// `claude-code`.
export type AgentCli = string
export type AgentExecutionMode = 'current_workspace' | 'worktree'
export type SprintEngineCliPermissionPreset = 'default' | 'auto_workspace' | 'bypass_all'

export type CliRuntimeSettings = {
  command: string
  useWsl: boolean
  // User-added model ids for this CLI, shown in pickers alongside the plugin
  // manifest's seed options. Terminal CLIs expose no live model catalog, so
  // this list is how users keep pace with new models.
  models?: string[]
}

// Result of probing whether an agent CLI binary is installed and runnable.
export type CliDetectResult = {
  cli: AgentCli
  binary: string
  installed: boolean
  version: string | null
  resolvedPath: string | null
  // True when the probe ran through WSL (Windows + useWsl runtime override).
  useWsl: boolean
  error: string | null
}

// One offered install path for a CLI on the current platform/runtime. The
// command string is authoritative in the main process; `commandPreview` is
// surfaced to the UI for transparency before the user consents to run it.
export type CliInstallMethodInfo = {
  id: string
  label: string
  // Whether the method's prerequisite (e.g. `npm`, `brew`) is present on PATH.
  available: boolean
  unavailableReason: string | null
  recommended: boolean
  commandPreview: string
  // The platform bucket this method was resolved from ('darwin' | 'linux' |
  // 'win32' | 'wsl').
  platform: string
}

export type CliInstallInput = {
  cli: AgentCli
  methodId: string
}

export type CliInstallResult = {
  ok: boolean
  cli: AgentCli
  installed: boolean
  version: string | null
  resolvedPath: string | null
  log: string
  error: string | null
}

export type McpClientTarget = AgentCli
export type McpTransport = 'stdio' | 'http' | 'sse'
export type McpScope = 'workspace' | 'user'
export type McpServerSource = 'bundled' | 'custom'
export type McpRiskLevel = 'low' | 'network' | 'local-command' | 'secrets'

export type McpServerConfig = {
  id: string
  name: string
  category?: string
  description?: string
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  envVarNames?: string[]
  headers?: Record<string, string>
  enabled: boolean
  required?: boolean
  clients: McpClientTarget[]
  scope: McpScope
  source: McpServerSource
  riskLevel: McpRiskLevel
  auth?: string
  capabilities?: string[]
  sourceUrl?: string
}

export type McpSettings = {
  syncEnabled: boolean
  servers: Record<string, McpServerConfig>
}

export type McpCatalogServer = Omit<McpServerConfig, 'enabled' | 'scope' | 'source'> & {
  defaultClients?: McpClientTarget[]
  recommendedScope?: McpScope
  setupNotes?: string
}

export type McpCatalogResult =
  | { ok: true; servers: McpCatalogServer[] }
  | { ok: false; message: string }

export type McpValidationIssue = {
  level: 'error' | 'warning'
  serverId?: string
  client?: McpClientTarget
  message: string
}

export type McpSyncTarget = {
  client: McpClientTarget
  path: string
  serverIds: string[]
}

export type McpSyncPreview =
  | { ok: true; targets: McpSyncTarget[]; issues: McpValidationIssue[] }
  | { ok: false; message: string; issues?: McpValidationIssue[] }

export type McpSyncResult =
  | { ok: true; targets: McpSyncTarget[]; issues: McpValidationIssue[] }
  | { ok: false; message: string; issues?: McpValidationIssue[] }

export type McpSyncInput = {
  workspaceRoot: string
  settings: McpSettings
  clients?: McpClientTarget[]
  managedSprintEngine?: {
    statePath: string
    workspaceRoot?: string
    allowedRoots?: string[]
    registryRoots?: string[]
    userRoot?: string
    actorId?: string
    workspaceId?: string
    agentId?: string
    role?: string
    cli?: McpClientTarget
    http?: {
      url: string
      authTokenEnvVar?: string
      headers?: Record<string, string>
    }
  }
  requiredOnly?: boolean
  write?: boolean
}

export type AgentConfigImportSource = 'codex' | 'claude-code'

export type AgentConfigDetectedMcpServer = {
  key: string
  id: string
  name: string
  source: AgentConfigImportSource
  sourceLabel: string
  transport: McpTransport
  enabled: boolean
  envVarNames: string[]
  hasSecretValues: boolean
}

export type AgentConfigDetectedSkill = {
  key: string
  id: string
  name: string
  source: AgentConfigImportSource
  sourceLabel: string
  adoptable: boolean
}

export type AgentConfigDetectInput = {
  sources?: AgentConfigImportSource[]
}

export type AgentConfigDetectResult =
  | {
      ok: true
      mcpServers: AgentConfigDetectedMcpServer[]
      skills: AgentConfigDetectedSkill[]
      warnings: string[]
    }
  | { ok: false; message: string; warnings?: string[] }

export type AgentConfigAdoptInput = {
  workspaceRoot: string
  mcpServerKeys?: string[]
  skillKeys?: string[]
}

export type AgentConfigAdoptedMcpServer = {
  id: string
  clients: McpClientTarget[]
}

export type AgentConfigAdoptedSkill = {
  id: string
  status: 'installed' | 'updated'
}

export type AgentConfigAdoptResult =
  | {
      ok: true
      adoptedMcpServers: AgentConfigAdoptedMcpServer[]
      adoptedSkills: AgentConfigAdoptedSkill[]
      warnings: string[]
    }
  | {
      ok: false
      message: string
      adoptedMcpServers?: AgentConfigAdoptedMcpServer[]
      adoptedSkills?: AgentConfigAdoptedSkill[]
      warnings?: string[]
    }

export type SkillPackHarness = 'claude' | 'codex' | 'cursor' | 'gemini' | 'opencode' | 'agents'
export type SkillPackSource = 'bundled' | 'custom'

export type SkillPackEntry = {
  id: string
  slug: string
  name: string
  category?: string
  description?: string
  version?: string
  sourceUrl?: string
  installedDirName?: string
  harnesses: SkillPackHarness[]
  source: SkillPackSource
  installedAt?: string
}

export type SkillPackCatalogEntry = Omit<SkillPackEntry, 'source' | 'installedAt'> & {
  recommended?: boolean
  setupNotes?: string
}

export type SkillPackCatalogResult =
  | { ok: true; packs: SkillPackCatalogEntry[] }
  | { ok: false; message: string }

export type SkillPackListInstalledInput = {
  workspaceRoot: string
}

export type SkillPackListInstalledResult =
  | { ok: true; installed: SkillPackEntry[] }
  | { ok: false; message: string }

export type SkillPackInstallInput = {
  workspaceRoot: string
  slug: string
  harnesses?: SkillPackHarness[]
  installedDirName?: string
}

export type SkillPackInstallResult =
  | { ok: true; installed: SkillPackEntry; log: string }
  | { ok: false; message: string; log?: string }

export type SkillPackRemoveInput = {
  workspaceRoot: string
  slug: string
  installedDirName?: string
  harnesses?: SkillPackHarness[]
}

export type SkillPackRemoveResult =
  | { ok: true; slug: string; log: string }
  | { ok: false; message: string; log?: string }

export type TerminalKind = 'agent' | 'terminal'
export type TerminalPathStyle = 'posix' | 'windows' | 'wsl'
export type AgentSessionSystem = 'switchboard' | 'watchtower' | 'sprintengine' | 'manual'

export type AgentSessionIdentity = {
  sessionId: string
  executionId: string
  system: AgentSessionSystem
  workspaceId: string
  workspaceRoot: string
  workId: string
  role: string
  displayName: string
}

export type AgentSessionMetadata = Omit<AgentSessionIdentity, 'sessionId'> & {
  sessionId?: string
}

export type TerminalSpawnMetadata = {
  kind?: TerminalKind
  workspaceId?: string
  agentId?: string
  // The agent's session id within its CLI/harness, used as the resume token.
  // Distinct from the terminal-tracking `sessionId`; supplied on resume so the
  // CLI reattaches its own conversation. See TerminalSpawnPayload.cliSessionId.
  cliSessionId?: string
  // Agent display name, exposed to the session as MULTICODE_AGENT_NAME for the
  // typed-handoff Backlog link label. See agentIdentityEnv (terminal-launch).
  agentName?: string
  terminalId?: string
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  cliPermissionPreset?: SprintEngineCliPermissionPreset
  // Orthogonal Debug Mode toggle (SpawnAgentMenu). Layers on top of the chosen
  // permission preset without changing its flags; the launch boundary prepends
  // the debug directive to the initial prompt when set. Transient per-spawn —
  // not persisted like cliPermissionPreset.
  debugMode?: boolean
  // Model id passed to the agent CLI when its plugin declares modelSelection;
  // undefined means the CLI's own default model.
  cliModel?: string
  memoryRootPath?: string
  memoryRelativeRoot?: string
  agentSession?: AgentSessionMetadata
  visible?: boolean
  mcpSettings?: McpSettings
}

export type SessionActivity =
  | { kind: 'working'; since: number }
  | { kind: 'idle'; since: number }
  | { kind: 'exited'; at: number; exitCode: number }
  | { kind: 'failed'; at: number; exitCode: number; message?: string }

// Authoritative agent phase, reported by the agent CLI's own lifecycle hooks
// (see backlog/2026-06-26-authoritative-agent-state-hooks.md). This is the
// richer, less ambiguous companion to `SessionActivity`: it can tell
// `awaiting_input` (blocked on a permission/prompt) apart from `idle` (turn
// finished) — a distinction output-scraping structurally cannot make.
export type AgentPhase =
  | 'starting'
  | 'thinking'
  | 'tool_use'
  | 'awaiting_input'
  | 'idle'
  | 'exited'
  | 'failed'
  | 'stalled'

// Provenance for an AgentState. `hook` means the phase came from an authoritative
// lifecycle-hook frame; `inferred` means it was derived from the legacy
// output-timing heuristic. The UI uses this to signal confidence and we run both
// detection paths side by side before cutting over.
export type AgentStateSource = 'hook' | 'inferred'

export type AgentState = {
  phase: AgentPhase
  since: number
  source: AgentStateSource
}

export type TerminalSessionSnapshot = {
  sessionId: string
  processAlive: boolean
  kind: TerminalKind
  pathStyle?: TerminalPathStyle
  workspaceId?: string
  agentId?: string
  terminalId?: string
  // The agent's session id within its own CLI/harness (the id used to resume the
  // conversation), captured from lifecycle hooks. Distinct from `sessionId`,
  // which is our Multicode terminal-tracking id. Equal to it for Claude (we mint
  // and pass the id); minted by the harness and learned post-launch for Codex etc.
  cliSessionId?: string
  cli?: AgentCli
  cwd?: string
  sprintEngineStatePath?: string
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  agentSession?: AgentSessionIdentity
  visible: boolean
  // Freeze-the-view: agent process killed to reclaim memory, scrollback kept
  // painted, resumable on keystroke. `processAlive` is false while suspended.
  suspended: boolean
  startedAt: number
  lastOutputAt: number | null
  lastInputAt: number | null
  lastVisibleAt: number | null
  activity: SessionActivity
  // Authoritative phase from lifecycle hooks, when available. Absent for
  // sessions whose CLI emits no hooks (the legacy idle-timer `activity` above
  // remains the floor). `source` distinguishes hook truth from inference.
  agentState?: AgentState
  exitedAt: number | null
  outputBufferLength: number
  retainedOutputBytes: number
  historyTier?: 'standard' | 'recent'
  replayLimitBytes?: number
}

// One process row from Electron's app.getAppMetrics() plus throttled child
// process tree sampling. `kind` maps Electron's process type and known spawned
// child categories to the roles operators reason about: 'main' (Browser),
// 'renderer' (Tab), 'gpu', 'utility', terminal/agent/helper children, and
// 'other'. `cpuPercent` is the rolling CPU share since the previous metrics
// sample for Electron rows, and best-effort OS CPU% for child rows. `threads` is
// populated from a throttled, off-poll OS sample (macOS `ps -M`, Linux /proc) —
// not on the 1s poll, since per-poll ps/lsof would add the overhead the panel
// exists to measure. `fileDescriptors` remains undefined (same per-poll-cost
// reason).
export type ProcessMetricKind = 'main' | 'renderer' | 'gpu' | 'utility' | 'agent' | 'terminal' | 'helper' | 'other'

export type ProcessMetricSample = {
  pid: number
  kind: ProcessMetricKind
  // Electron's raw process type ('Browser' | 'Tab' | 'GPU' | 'Utility' | …) and
  // the utility/service name when present, so the panel can disambiguate
  // multiple renderers/utilities without guessing.
  type: string
  name?: string
  cpuPercent: number
  // Working set size in bytes (Electron reports KB; the main process converts).
  memoryBytes: number
  threads?: number
  fileDescriptors?: number
  // V8 heap detail, currently populated only for the main process (from
  // process.memoryUsage() in the IPC handler). getAppMetrics does not expose
  // per-renderer heap; the renderer's own heap is sampled separately via
  // performance.memory in the metrics-history store.
  heapUsedBytes?: number
  heapTotalBytes?: number
}

// OS-wide memory, sampled out-of-band (getAppMetrics only covers Electron's own
// processes). This is what actually predicts macOS "out of application memory"
// — system exhaustion across every app — and the input the pressure-aware
// evictor keys off. `availableBytes`/`pressure` are best-effort approximations;
// `source` records how they were derived ('vm_stat' macOS, 'proc' linux, 'os'
// fallback).
export type SystemMemorySample = {
  totalBytes: number
  availableBytes: number
  usedBytes: number
  compressedBytes: number
  swapUsedBytes: number
  // 0..1 proxy: 1 - available/total.
  pressure: number
  source: 'vm_stat' | 'proc' | 'os'
}

// One terminal/agent's real process cost, attributed to its workspace. The
// memory is the RSS of the pty's whole subtree (the CLI plus any MCP/dev-server
// children), summed in the main process where pids and sessions meet.
export type WorkspaceTerminalMemorySample = {
  sessionId: string
  kind: TerminalKind
  cli: AgentCli | null
  agentId: string | null
  terminalId: string | null
  activityKind: string
  processAlive: boolean
  memoryBytes: number
  startedAt: number
}

// Per-workspace rollup of resident agent/terminal memory. Only live sessions
// contribute; shared overhead (main/renderer/GPU) is intentionally not
// attributed, so the sum is "what this workspace's terminals cost", not the
// whole app.
export type WorkspaceMemorySample = {
  workspaceId: string
  // At least one live agent PTY — the same "hot" signal the sidebar bolds.
  resident: boolean
  totalMemoryBytes: number
  // Earliest startedAt across the workspace's live terminals ("live for …").
  becameLiveAt: number | null
  terminals: WorkspaceTerminalMemorySample[]
}

// One terminal the main-process reaper acted on, kept in a bounded ring buffer
// so the diagnostics panel can show an audit trail of what was reaped and from
// which workspace. `idle-suspend` is the memory-bounded sweep
// (`runIdleAgentReapSweep`) suspending an idle (non-sprint) agent outside the hot
// set; `idle-dispose` is the same sweep DISPOSING an idle SprintEngine agent
// (orchestrator-driven, so it leaves → revives via dispatch rather than freezing
// the view); `stale-dispose` is the 24h backstop (`reapStaleTerminals`). The
// suspend reasons preserve the agent's resume flags so it relaunches with
// `--resume` on reopen.
export type TerminalReapReason = 'idle-suspend' | 'idle-dispose' | 'stale-dispose'

export type TerminalReapEvent = {
  reapedAt: number
  reason: TerminalReapReason
  sessionId: string
  workspaceId: string | null
  agentId: string | null
  terminalId: string | null
  cli: string | null
  kind: string
  // Idle window (ms since last real interaction) that triggered an idle-suspend.
  idleMs?: number
  // Unseen window (ms since last seen) that triggered a stale-dispose.
  unseenMs?: number
}

export type ProcessMetricsSnapshot = {
  sampledAt: number
  // Best-effort: empty when app.getAppMetrics() is unavailable in the current
  // runtime rather than throwing, so the panel degrades to "unavailable".
  processes: ProcessMetricSample[]
  // Best-effort: omitted until the first out-of-band sample lands.
  systemMemory?: SystemMemorySample
  // Best-effort: per-workspace RSS attribution; omitted until the first sample.
  workspaceMemory?: WorkspaceMemorySample[]
  // Most-recent-first audit trail of terminals the reaper suspended/disposed
  // this session (bounded). Omitted when nothing has been reaped yet.
  reapEvents?: TerminalReapEvent[]
}

// Per-api-method IPC accounting, accumulated in the preload (see preload/ipcStats).
// Counts are monotonic since process start; the renderer diffs consecutive
// snapshots to derive per-second rates.
export type IpcChannelStat = {
  name: string
  calls: number
  outBytes: number
  inEvents: number
  inBytes: number
}

export type IpcStatsSnapshot = {
  sampledAt: number
  channels: IpcChannelStat[]
}

export type TerminalSpawnResult =
  | { ok: true; sessionId: string }
  | { ok: false; sessionId: string; message: string; exitCode: number }

// Bundled specialist action ids, plus any registry-discovered role id from a
// dropped-in specialist pack. The `(string & {})` arm preserves autocomplete
// for the bundled ids while accepting any role id over IPC.
export type SpecialistActionId =
  | 'architect'
  | 'product-strategist'
  | 'developer'
  | 'devops-infra'
  | 'performance'
  | 'production-readiness-review'
  | 'cross-platform'
  | 'blog-writer'
  | 'qa-test'
  | 'security-review'
  | 'frontend-design-review'
  | 'ui-ux-review'
  | 'code-review'
  | 'nuclear-review'
  | 'spec-review'
  | (string & {})

export type SoulPromptResult =
  | { ok: true; prompt: string; path: string }
  | { ok: false; message: string; path: string | null }

export type MultiloopRole =
  | 'coordinator'
  | 'architect'
  | 'product'
  | 'developer'
  | 'frontend'
  | 'tester'
  | 'security'
  | 'code_reviewer'
  | 'performance'
  | 'cross_platform'

export type GitFileStatus = 'new' | 'modified' | 'deleted' | 'renamed' | 'conflicted'

export type GitStatusEntry = {
  path: string
  relativePath: string
  status: GitFileStatus
  staged: boolean
  unstaged: boolean
}

export type GitStatusSnapshot = {
  repoRoot: string
  files: Record<string, GitStatusEntry>
  updatedAt: number
}

export type GitFileBaseResult =
  | { ok: true; content: string }
  | { ok: false; message: string }

// Which stored version of a file the diff viewer reads. `head` is the committed
// version (`git show HEAD:<p>`); `index` is the staged version (`git show :0:<p>`).
export type GitFileStage = 'head' | 'index'

export type GitFileStageResult =
  | { ok: true; exists: boolean; content: string; binary: boolean; tooLarge: boolean }
  | { ok: false; message: string }

export type GitBranch = {
  name: string
  current: boolean
  upstream: string | null
}

export type GitBranchSnapshot = {
  current: string | null
  branches: GitBranch[]
  ahead: number
  behind: number
}

export type GitCommit = {
  hash: string
  shortHash: string
  author: string
  date: string
  refs: string[]
  subject: string
  commitWebUrl: string | null
}

export type GitRef = {
  name: string
  hash: string
  type: 'head' | 'remote' | 'tag' | 'other'
}

export type GitHistorySnapshot = {
  commits: GitCommit[]
  refs: GitRef[]
  totalCount: number
  updatedAt: number
}

export type GitGraphCommit = GitCommit & {
  parents: string[]
}

export type GitGraphSnapshot = {
  commits: GitGraphCommit[]
  refs: GitRef[]
  headHash: string | null
  detached: boolean
  totalCount: number
  hasMore: boolean
  updatedAt: number
}

export type GitGraphOptions = {
  limit?: number
  skip?: number
}

export type GitCommandResult = {
  ok: boolean
  stdout: string
  stderr: string
  message: string | null
  pushedCommitCount?: number
}

export type GitWorktreeEntry = {
  path: string
  head: string | null
  branch: string | null
  branchRef: string | null
  detached: boolean
  bare: boolean
  locked: boolean
  lockedReason: string | null
  prunable: boolean
  prunableReason: string | null
}

export type GitWorktreeListSnapshot = {
  repoRoot: string
  worktrees: GitWorktreeEntry[]
  updatedAt: number
}

export type GitWorktreeCopyIncludedResult = {
  copied: string[]
  skipped: { path: string; reason: string }[]
}

export type GitWorktreeOperationResult<T> =
  | { ok: true; data: T; message: string | null; stdout?: string; stderr?: string }
  | { ok: false; message: string; stdout?: string; stderr?: string }

export type GitWorktreeCreateInput = {
  repoRoot: string
  containerPath: string
  destinationPath: string
  branchName: string
  baseRef: string
  copyIncludedFiles?: boolean
}

export type GitWorktreeRemoveInput = {
  repoRoot: string
  path: string
  force?: boolean
}

export type GitWorktreeRepairInput = {
  repoRoot: string
  path?: string
}

export type GitWorktreeCopyIncludedInput = {
  repoRoot: string
  worktreePath: string
}

export type GitHubRepoRef = {
  owner: string
  repo: string
  webUrl: string
}

export type GitHubTokenStatus = {
  configured: boolean
  source: 'settings' | 'environment' | 'none'
  encryptionAvailable: boolean
}

export type GitConflictFile = {
  path: string
  relativePath: string
  status: string
}

export type GitConflictSnapshot = {
  repoRoot: string
  files: GitConflictFile[]
  updatedAt: number
}

export type GitConflictFileContent = {
  path: string
  relativePath: string
  base: string | null
  ours: string | null
  theirs: string | null
  result: string
}

export type DiagnosticLevel = 'info' | 'warning' | 'error'
export type DiagnosticSource = 'auth' | 'automations' | 'filesystem' | 'git' | 'sprintengine' | 'terminal' | 'update' | 'voice' | 'workspace'

// Serializable deep-focus target for a notification's Open action. Mirrors the
// renderer `NotificationNavigationTarget` (src/renderer/src/types/workspace.ts);
// declared here so a diagnostic's navigation target is an explicit part of the
// logDiagnostic IPC contract rather than an undeclared passthrough.
export type NotificationNavigationTarget = {
  kind: string
  ref: string
}

export type DiagnosticLogInput = {
  level: DiagnosticLevel
  source: DiagnosticSource
  title: string
  message: string
  details?: string
  workspaceId?: string
  workspaceName?: string
  agentId?: string
  taskId?: string
  sessionId?: string
  navigationTarget?: NotificationNavigationTarget
}

export type DiagnosticLogEntry = DiagnosticLogInput & {
  id: string
  timestamp: string
  logPath?: string
}

export type WorkspaceFolderCheckResult =
  | { ok: true; status: 'ready'; path: string; checkedPath: string; message: string }
  | {
      ok: false
      status: 'missing' | 'inaccessible' | 'timeout'
      path: string
      checkedPath: string
      message: string
      code?: string
    }

export type WindowState = {
  isMaximized: boolean
  isFullScreen: boolean
}

export type WindowBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type WindowPlacement = {
  bounds: WindowBounds
  isMaximized: boolean
  displayId: number | null
}

export type CreateWorkspaceWindowInput = {
  windowId: string
  workspaceId?: string | null
  bounds?: WindowBounds | null
  isMaximized?: boolean
}

export type CreateWorkspaceWindowResult =
  | { ok: true; windowId: string }
  | { ok: false; message: string }

// Lightweight auxiliary windows (diff viewer, external file editor). Unlike
// workspace windows they do not mount the workspace shell or join workspace
// sync — the renderer branches on the `aux` query param into a dedicated root,
// mirroring the diagnostics window (`?view=diagnostics`).
export type AuxWindowKind = 'diff' | 'file'

export type OpenAuxWindowInput = {
  kind: AuxWindowKind
  // Small string params encoded into the renderer URL (e.g. repoRoot, focusPath).
  params: Record<string, string>
  // Singleton identity. A request whose key matches an open window retargets and
  // focuses it instead of opening a duplicate. Diff uses a constant key (one diff
  // window at a time); file uses the file path (one window per file).
  singletonKey: string
  bounds?: WindowBounds | null
}

export type OpenAuxWindowResult =
  | { ok: true; retargeted: boolean }
  | { ok: false; message: string }

export type AuxWindowRetargetPayload = {
  kind: AuxWindowKind
  params: Record<string, string>
}

// Dock-back: the external editor window asks the owning workspace window to
// reopen a file as a normal editor tab. Broadcast to all windows; the one whose
// model owns the workspace handles it (others no-op).
export type DockFileToWorkspaceInput = {
  workspaceId: string
  path: string
  name: string
}

export type OpenExternalResult =
  | { ok: true }
  | { ok: false; message: string }

export type AppUpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not_available'
  | 'error'

export type AppUpdateChannel = 'dev' | 'preview' | 'stable'

export type AppUpdateProgress = {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export type AppUpdateState = {
  status: AppUpdateStatus
  version: string
  channel: AppUpdateChannel
  packaged: boolean
  updateVersion: string | null
  releaseName: string | null
  releaseNotes: string | null
  releaseNotesUrl: string | null
  downloaded: boolean
  progress: AppUpdateProgress | null
  errorMessage: string | null
  lastCheckedAt: string | null
}

export type AppUpdateCheckResult =
  | { ok: true; state: AppUpdateState; message: string }
  | { ok: false; state: AppUpdateState; message: string }

export type SprintEngineMutationEventMetadata = {
  id?: string
  type?: string
  timestamp?: string
  actor?: string
  message?: string
}

export type SprintEngineMutationRefreshData = {
  projectionContent?: string
  projectionToken?: string
  events?: SprintEngineMutationEventMetadata[]
  latestEvent?: SprintEngineMutationEventMetadata
  latestEventId?: string
  [key: string]: unknown
}

export type SprintEngineArtifactCommandResult =
  | { ok: true; data: SprintEngineMutationRefreshData }
  | { ok: false; message: string; stdout?: string; stderr?: string; exitCode?: number | string }

export type SprintEngineProjectionReadResult =
  // `token` is a cheap file-change fingerprint (mtime:size) the caller can pass
  // back as `knownToken` to skip re-reading an unchanged projection. When the
  // token matches, `unchanged` is true and `data` is null (no read/parse done).
  | { ok: true; data: unknown; token?: string; unchanged?: boolean }
  | { ok: false; message: string }

export type SprintEngineRegistryRolesReadInput = {
  workspaceRoot: string
  includeShadowed?: boolean
}

export type SprintEngineRegistryRoleReadInput = {
  workspaceRoot: string
  roleId: string
}

export type SprintEngineDispatchReadInput = {
  statePath: string
  agentId: string
  lastDispatchId?: string
}

export type SprintEngineMcpReadResult =
  | { ok: true; data: unknown }
  | { ok: false; message: string; stdout?: string; stderr?: string; exitCode?: number | string }

export type SprintEngineTaskMutationRole =
  | 'architect'
  | 'product'
  | 'developer'
  | 'frontend'
  | 'tester'
  | 'security'
  | 'code_reviewer'
  | 'spec_reviewer'
  | 'performance'
  | 'production_readiness_reviewer'
  | 'cross_platform'

export type SprintEngineTaskUpdateInput = {
  statePath: string
  taskId: string
  title?: string
  description?: string
  role?: SprintEngineTaskMutationRole
  acceptanceCriteria?: string[]
  implementationNotes?: string[]
  notes?: string[]
}

export type SprintEngineTaskCreateInput = {
  statePath: string
  title: string
  description?: string
  role: SprintEngineTaskMutationRole
  acceptanceCriteria?: string[]
  implementationNotes?: string[]
  notes?: string[]
  manualDispatch?: boolean
}

export type SprintEngineTaskCommentInput = {
  statePath: string
  taskId: string
  body: string
}

export type SprintEngineTaskResolveInput = {
  statePath: string
  taskId: string
  resolution: string
  complete?: boolean
}

export type SprintEngineTaskStatusSetInput = {
  statePath: string
  taskId: string
  // A value from the engine's task-status vocabulary (todo, in_progress,
  // changes_requested, review, testing, product, needs_input, done, canceled).
  // The backend rejects illegal transitions (e.g. done with open gates), so the
  // renderer only sends gate-legal targets — today `changes_requested`, which
  // sends a task back for rework and lands it in a claimable column for re-pickup.
  status: string
}

export type SprintEngineStateInitializeInput = {
  statePath: string
  name: string
  goal: string
  agents: Record<string, unknown>
  tasks?: unknown[]
  events?: unknown[]
  artifacts?: unknown[]
  // When true, Sprint Engine creates one shared git worktree + branch for the
  // whole team before any task runs, and all agents work and commit there.
  useWorktrees?: boolean
}

export type SprintEngineCliWatchPolling = 'enabled' | 'disabled'

export type SprintEngineRunnerSetInput = {
  statePath: string
  // Whether `sprintengine join --watch` keeps polling for ready work. CLI
  // runtime only — Multicode supervisor ignores this. Existing IPC callers
  // that send `mode: 'auto' | 'off'` are translated by the main-process
  // handler in `src/main/sprintengine-artifacts.ts` to preserve backward
  // compatibility for one release cycle.
  cliWatchPolling: SprintEngineCliWatchPolling
}

export type SprintEngineRosterReplenishInput = {
  statePath: string
  role?: SprintEngineTaskMutationRole
}

export type SprintEngineRosterAddInput = {
  statePath: string
  /** Expected agent id, e.g. `frontend-2`; the CLI add is idempotent on it. */
  agentId: string
  /**
   * Registry role id. A plain string (not SprintEngineTaskMutationRole)
   * because roster membership accepts any configured registry role, including
   * custom and plugin-installed roles; the Sprint Engine CLI canonicalizes
   * the id and rejects unknown roles.
   */
  role: string
}

export type MultiloopInitInput = {
  workspaceRoot: string
  loopName: string
  finalGoal: string
}

export type MultiloopInitResult =
  | {
      ok: true
      data: {
        workspaceRoot: string
        loopName: string
        loopSlug: string
        loopDirectory: string
        statePath: string
        created: boolean
      }
    }
  | { ok: false; message: string; stdout?: string; stderr?: string; exitCode?: number | string }

export type SessionUser = {
  id: string
  email: string | null
  displayName: string | null
}

export type SessionOrganization = {
  id: string
  name: string
  slug: string
  type: 'personal' | 'team' | 'enterprise'
}

export type FeatureValue = boolean | number | string

export type EntitlementSnapshot = {
  userId: string
  organizationId: string
  product: 'multicode'
  roles: string[]
  features: Record<string, FeatureValue>
  limits: Record<string, number>
  sources: Record<string, string>
  plan: {
    code: string
    status: string
  }
  issuedAt: string
  expiresAt: string
  schemaVersion: 1
}

export type MulticodeAuthState = {
  authenticated: boolean
  user: SessionUser | null
  selectedOrganization: SessionOrganization | null
  entitlements: EntitlementSnapshot | null
  status: 'checking' | 'signed_out' | 'signed_in' | 'error'
  entitlementStatus: 'fresh' | 'offline_grace' | 'expired' | 'missing'
  message: string | null
  lastRefreshAt: string | null
  graceExpiresAt: string | null
}

export type PremiumAccessRequest = {
  featureKey: string
  amount?: number
  hostedCost?: boolean
}

export type PremiumAccessDecision = {
  allowed: boolean
  featureKey: string
  value: FeatureValue | undefined
  status: 'fresh' | 'offline_grace' | 'expired' | 'signed_out' | 'missing' | 'error'
  message: string
  limit?: number
  graceExpiresAt?: string
}

export type UsageRequest = {
  featureKey: string
  amount?: number
  actorType?: 'user' | 'organization' | 'api_key'
  actorId?: string
  idempotencyKey: string
  window?: 'day' | 'month'
}

export type UsageResult = {
  allowed: boolean
  featureKey: string
  amount: number
  used: number
  remaining: number | null
  limit: number | null
  idempotencyKey: string
  windowStart: string
  windowEnd: string
  replayed: boolean
  reason: 'allowed' | 'missing_entitlement' | 'limit_exceeded' | 'released'
}

export type SessionSnapshot =
  | {
      authenticated: true
      user: SessionUser
      selectedOrganization: SessionOrganization
      session: {
        id: string
        expiresAt: string
      }
    }
  | {
      authenticated: false
      user: null
      selectedOrganization: null
    }

export type MobileControlCommandType =
  | 'snapshot.request'
  | 'artifact.read'
  | 'sprintengine.create'
  | 'task.start'
  | 'artifact.approve'
  | 'artifact.requestChanges'
  | 'agent.followUp'
  | 'device.revoke'
  | 'backlog.update'
  | 'backlog.startSprintEngine'
  | 'backlog.create'

export type MobileControlCapability =
  | 'snapshots.read'
  | 'artifacts.read'
  | 'sprintengines.create'
  | 'tasks.start'
  | 'artifacts.review'
  | 'agents.followUp'
  | 'devices.revoke'
  | 'backlog.update'
  | 'backlog.start'
  | 'backlog.create'

export type MobileControlDevice = {
  protocolVersion: 1
  deviceId: string
  displayName: string
  platform: 'ios' | 'android' | 'web'
  appVersion: string
  pairedAt: string
  lastSeenAt?: string
  revokedAt?: string
  capabilities: MobileControlCapability[]
}

export type MobileControlCapabilities = {
  protocolVersion: 1
  deviceId: string
  commands: MobileControlCommandType[]
  capabilities: MobileControlCapability[]
  artifactPreviewModes: ('text' | 'markdown' | 'restrictedHtml')[]
  maxFollowUpCharacters: number
  snapshotTtlMs: number
}

export type MobileBridgeRelayStatus =
  | 'disabled'
  | 'unconfigured'
  | 'connecting'
  | 'connected'
  | 'retrying'
  | 'error'

export type MobileBridgePresence = 'available' | 'busy' | 'idle' | 'offline'

export type MobileBridgeDiagnosticEntry = {
  id: string
  timestamp: string
  level: 'info' | 'warning' | 'error'
  code: string
  message: string
  retryable: boolean
}

export type MobileBridgeCommandEvent = {
  id: string
  commandId: string
  commandType: MobileControlCommandType
  deviceId: string | null
  deviceName: string | null
  receivedAt: string
  completedAt?: string
  status: 'received' | 'completed' | 'failed'
  resultCode?: string
}

export type MobileBridgePairingChallenge = {
  pairingChallengeId: string
  pairingCode: string
  pairingUri: string
  expiresAt: string
  requestedScopes: MobileControlCapability[]
}

export type MobileBridgeState = {
  enabled: boolean
  relayStatus: MobileBridgeRelayStatus
  relayUrl: string | null
  desktopInstanceId: string
  desktopRelaySessionId: string | null
  relayTokenExpiresAt: string | null
  nextReconnectAt: string | null
  presence: MobileBridgePresence
  lastPresenceAt: string | null
  pairingChallenge: Omit<MobileBridgePairingChallenge, 'pairingCode' | 'pairingUri'> | null
  pairedDevices: MobileControlDevice[]
  capabilities: MobileControlCapabilities
  diagnostics: MobileBridgeDiagnosticEntry[]
  recentCommands: MobileBridgeCommandEvent[]
}

export type MobileBridgeSettingsUpdate = {
  enabled?: boolean
  relayUrl?: string | null
}

export type WorkspaceBackupPayload = {
  version: number
  writtenAt: string
  data: unknown
}

export type WorkspaceBackupReadResult =
  | { ok: true; payload: WorkspaceBackupPayload }
  | { ok: false; reason: 'missing' | 'unreadable' | 'parse_error'; message?: string }

export type WorkspaceBackupWriteResult = { ok: boolean; message?: string }

export type ModuleEnablementOverrides = Record<string, boolean>
export type ModuleEnablementWriteResult = { ok: boolean; message?: string }

// Light/dark surface preference of the active app theme. The renderer resolves
// its chosen theme to one of these and pushes it to main so spawned agent CLIs
// can be launched matching the app's appearance (e.g. Claude Code's --settings
// theme). Main keeps only the latest pushed value; the renderer owns the truth.
export type ColorScheme = 'light' | 'dark'
export type AppMenuAcceleratorUpdate = {
  commandId: string
  accelerator: string | null
}
export type AppMenuAcceleratorUpdateResult = { ok: true }

export type BacklogItemStatusPayload = 'idea' | 'ready' | 'in_progress' | 'needs_input' | 'completed' | 'archived'
export type BacklogTypePayload = 'epic' | 'feature' | 'bug' | 'mockup' | 'spike'
export type BacklogDifficultyPayload = 'xs' | 's' | 'm' | 'l' | 'xl'
export type BacklogCriticalityPayload = 'low' | 'normal' | 'high' | 'critical'
export type BacklogRiskPayload = 'low' | 'normal' | 'high'
// Declared fresh in shared (no renderer imports); the renderer's HighlightColor
// union must stay assignable to this payload type.
export type BacklogHighlightColorPayload = 'red' | 'orange' | 'amber' | 'green' | 'blue' | 'purple' | 'pink'

export type BacklogHighlightPayload = {
  starred: boolean
  color: BacklogHighlightColorPayload | null
}

export type BacklogItemLinkPayload = {
  id: string
  moduleId: string
  // `agent` is lifecycle-neutral: unlike `execution`, an active agent link
  // never drives item status (see nextBacklogItemStatusFromLinks). It records
  // which agent terminal is working the item, for two-way navigation.
  type: 'execution' | 'issue' | 'review' | 'artifact' | 'external' | 'agent'
  label: string
  target: {
    kind: string
    id: string
    path?: string
    url?: string
  }
  status?: 'active' | 'completed' | 'failed' | 'unknown'
  updatedAt?: string
}

export type BacklogObjectRecordPayload = {
  id: string
  source: {
    type: 'file'
    relativePath: string
  }
  status?: BacklogItemStatusPayload
  type?: BacklogTypePayload
  difficulty?: BacklogDifficultyPayload
  criticality?: BacklogCriticalityPayload
  risk?: BacklogRiskPayload
  highlight?: BacklogHighlightPayload
  metadata?: Record<string, unknown>
  links?: BacklogItemLinkPayload[]
  createdAt?: string
  updatedAt?: string
}

export type BacklogObjectStorePayload = {
  schemaVersion: 1
  items: BacklogObjectRecordPayload[]
}

export type BacklogItemRecordInput = {
  relativePath: string
  status?: BacklogItemStatusPayload
  type?: BacklogTypePayload
  difficulty?: BacklogDifficultyPayload
  criticality?: BacklogCriticalityPayload
}

export type BacklogReadResult =
  | { ok: true; store: BacklogObjectStorePayload }
  | { ok: false; message: string }

// Scan-time id allocation: the renderer hands the main process every scanned
// item with its current frontmatter id (or null), and the service writes the
// next sequential id into the frontmatter of those without one. `assignments`
// maps relativePath -> the newly minted numeric id (only for items that gained
// one); `key` is the workspace display key so the panel can render `KEY-n`.
export type BacklogEnsureIdsItemInput = {
  relativePath: string
  numericId?: number | null
}

export type BacklogEnsureIdsInput = {
  workspaceRoot: string
  items: BacklogEnsureIdsItemInput[]
}

export type BacklogEnsureIdsResult =
  | { ok: true; key: string; assignments: Record<string, number> }
  | { ok: false; message: string }

export type BacklogWorkspaceKeyResult =
  | { ok: true; key: string }
  | { ok: false; message: string }

export type BacklogMutationResult =
  | { ok: true; store: BacklogObjectStorePayload }
  | { ok: false; message: string }

export type BacklogStatusInput = {
  workspaceRoot: string
  relativePath: string
  status: BacklogItemStatusPayload
}

export type BacklogTypeInput = {
  workspaceRoot: string
  relativePath: string
  type: BacklogTypePayload | null
}

export type BacklogTriageInput = {
  workspaceRoot: string
  relativePath: string
  difficulty?: BacklogDifficultyPayload | null
  criticality?: BacklogCriticalityPayload | null
  risk?: BacklogRiskPayload | null
}

export type BacklogHighlightInput = {
  workspaceRoot: string
  relativePath: string
  starred: boolean
  color: BacklogHighlightColorPayload | null
}

export type BacklogAddOrUpdateLinkInput = {
  workspaceRoot: string
  relativePath: string
  link: BacklogItemLinkPayload
  status?: BacklogItemStatusPayload
}

export type BacklogModuleMetadataInput = {
  workspaceRoot: string
  relativePath: string
  moduleId: string
  value: unknown
}

export type BacklogMoveSourceInput = {
  workspaceRoot: string
  relativePath: string
  nextRelativePath: string
}

export type BacklogRemoveRecordInput = {
  workspaceRoot: string
  relativePath: string
}

// Epic membership is the child-side write: `epic` is the up-pointing slug to set
// on the child item's frontmatter, or null to remove it from its epic. The
// down-direction (epic -> children) stays derived, never stored.
export type BacklogEpicInput = {
  workspaceRoot: string
  relativePath: string
  epic: string | null
}

// Prerequisites are the dependent-side write: `dependsOn` is the list of item
// slugs this item waits on, serialized to the single comma-separated `dependsOn:`
// frontmatter line. An empty list or null clears the line. The reverse "blocks"
// edges and the waiting signal stay derived (see backlogDependencies.ts), never
// stored.
export type BacklogDependenciesInput = {
  workspaceRoot: string
  relativePath: string
  dependsOn: string[] | null
}

export type BacklogCreateEpicInput = {
  workspaceRoot: string
  title: string
}

// Epic identity colour is an epic-only write: one of the seven highlight colours
// to set on the epic file's `color:` frontmatter, or null to clear it. Unlike the
// per-item `highlight` (owned by items.json) this lives in the epic's markdown,
// so its members can derive the colour at scan time.
export type BacklogEpicColorInput = {
  workspaceRoot: string
  relativePath: string
  color: BacklogHighlightColorPayload | null
}

export type BacklogCreateEpicResult =
  | { ok: true; slug: string; relativePath: string }
  | { ok: false; message: string }

export type ElectronApi = {
  platform: string
  isDevelopment: boolean
  isDiagnosticsEnabled: boolean
  windowMinimize: () => Promise<void>
  windowToggleMaximize: () => Promise<WindowState | null>
  windowClose: () => Promise<void>
  getWindowState: () => Promise<WindowState | null>
  getWindowPlacement: () => Promise<WindowPlacement | null>
  getWorkspaceWindowId: () => Promise<string>
  createWorkspaceWindow: (input: CreateWorkspaceWindowInput) => Promise<CreateWorkspaceWindowResult>
  openAuxWindow: (input: OpenAuxWindowInput) => Promise<OpenAuxWindowResult>
  onAuxWindowRetarget: (cb: (payload: AuxWindowRetargetPayload) => void) => () => void
  dockFileToWorkspace: (input: DockFileToWorkspaceInput) => Promise<void>
  onDockFileToWorkspace: (cb: (input: DockFileToWorkspaceInput) => void) => () => void
  confirmWindowClose: () => Promise<void>
  openExternal: (url: string) => Promise<OpenExternalResult>
  onWindowStateChanged: (cb: (state: WindowState) => void) => () => void
  onWindowPlacementChanged: (cb: (placement: WindowPlacement) => void) => () => void
  onWindowCloseRequested: (cb: () => void) => () => void
  workspaceSyncDispatch: (command: WorkspaceSyncCommand) => Promise<WorkspaceSyncCommandResult>
  workspaceSyncGetSnapshot: () => Promise<WorkspaceSyncSnapshot>
  workspaceSyncGetEventsAfter: (sequence: number) => Promise<WorkspaceSyncEvent[]>
  onWorkspaceSyncEvent: (cb: (event: WorkspaceSyncEvent) => void) => () => void
  automationGetStatus: () => Promise<AutomationServerStatus>
  automationSetEnabled: (enabled: boolean) => Promise<AutomationServerStatus>
  onAutomationRequest: (cb: (requestId: string, request: AutomationRendererRequest) => void) => () => void
  automationRespond: (requestId: string, response: AutomationRendererResponse) => Promise<void>
  // Automations platform (per-project scheduled agent automations). The renderer
  // reads/writes only through these channels; the engine owns the on-disk store.
  listAutomations: (input: AutomationsWorkspaceInput) => Promise<AutomationsListResult>
  getAutomation: (input: AutomationsDefinitionInput) => Promise<AutomationsDefinitionResult>
  createAutomation: (input: AutomationsCreateInput) => Promise<AutomationsDefinitionResult>
  updateAutomation: (input: AutomationsUpdateInput) => Promise<AutomationsDefinitionResult>
  deleteAutomation: (input: AutomationsDefinitionInput) => Promise<AutomationsDeleteResult>
  runAutomationNow: (input: AutomationsDefinitionInput) => Promise<AutomationsRunNowResult>
  listAutomationRuns: (input: AutomationsRunsListInput) => Promise<AutomationsRunsListResult>
  finalizeAutomationRun: (input: AutomationsRunFinalizeInput) => Promise<AutomationsRunFinalizeResult>
  listAutomationProviders: () => Promise<AutomationsProvidersResult>
  // Read-only health of the Automations engine/scheduler sidecar for the control
  // center indicator. Never mutates; main reads kernel sidecar status (T5).
  getAutomationsEngineStatus: () => Promise<AutomationsEngineStatusResult>
  onAutomationRunEvent: (cb: (event: AutomationsRunEvent) => void) => () => void
  authGetState: () => Promise<MulticodeAuthState>
  authLogin: (organizationId?: string | null) => Promise<{ state: string; authorizationUrl: string }>
  authLogout: () => Promise<{ loggedOut: true }>
  authRefreshEntitlements: () => Promise<MulticodeAuthState>
  authSelectOrganization: (organizationId: string) => Promise<{ organizationId: string }>
  authOpenUpgrade: (reason?: string) => Promise<{ opened: true; url: string }>
  authCheckPremiumAccess: (input: PremiumAccessRequest) => Promise<PremiumAccessDecision>
  authGetSession: () => Promise<SessionSnapshot>
  authGetEntitlements: (options?: { forceRefresh?: boolean }) => Promise<EntitlementSnapshot>
  authRequireEntitlement: (input: string | PremiumAccessRequest) => Promise<FeatureValue>
  authCheckUsage: (input: UsageRequest) => Promise<UsageResult>
  authConsumeUsage: (input: UsageRequest) => Promise<UsageResult>
  authReleaseUsage: (input: UsageRequest) => Promise<UsageResult>
  onAuthStateChanged: (cb: (state: MulticodeAuthState) => void) => () => void
  onAuthCallbackError: (cb: (message: string) => void) => () => void
  mobileBridgeGetState: () => Promise<MobileBridgeState>
  mobileBridgeUpdateSettings: (input: MobileBridgeSettingsUpdate) => Promise<MobileBridgeState>
  mobileBridgeRequestPairingCode: () => Promise<MobileBridgePairingChallenge>
  mobileBridgeListDevices: () => Promise<MobileControlDevice[]>
  mobileBridgeRevokeDevice: (deviceId: string, reason?: string) => Promise<MobileControlDevice>
  mobileBridgePublishPresence: (presence: MobileBridgePresence) => Promise<MobileBridgeState>
  mobileBridgeGetDiagnostics: () => Promise<MobileBridgeDiagnosticEntry[]>
  mobileBridgeUpdateWorkspaceRoots: (roots: string[]) => Promise<{ roots: string[] }>
  onMobileBridgeStateChanged: (cb: (state: MobileBridgeState) => void) => () => void
  readdir: (path: string) => Promise<{ name: string; isDir: boolean }[]>
  searchFiles: (rootPath: string, query: string, options?: { limit?: number; excludes?: string[] }) => Promise<FileSearchResult>
  searchContent: (rootPath: string, query: string, options?: { limit?: number; excludes?: string[] }) => Promise<ContentSearchResult>
  cancelContentSearch: () => Promise<void>
  readfile: (path: string) => Promise<string>
  readImageDataUrl: (path: string) => Promise<string>
  pathExists: (path: string) => Promise<boolean>
  statPath: (path: string) => Promise<FileSystemStat>
  getPathForFile: (file: unknown) => string
  checkWorkspaceFolder: (path: string) => Promise<WorkspaceFolderCheckResult>
  memoryResolveRoot: (input: { workspaceRoot: string | null; relativeRoot: string | null }) => Promise<MemoryRootStatus>
  memoryIndex: (input: { workspaceRoot: string | null; relativeRoot: string | null }) => Promise<MemoryGraphIndexResult>
  memoryReadPreview: (
    input: { workspaceRoot: string | null; relativeRoot: string | null; relativePath: string }
  ) => Promise<MemoryPreviewResult>
  memoryActivityInstall: (
    input: { workspaceRoot: string | null; memoryRelativeRoot: string | null }
  ) => Promise<MemoryActivityInstallResult>
  memoryActivityUninstall: (
    input: { workspaceRoot: string | null }
  ) => Promise<MemoryActivityUninstallResult>
  memoryActivityStartWatching: (
    input: { workspaceRoot: string | null; memoryRelativeRoot: string | null }
  ) => Promise<{ ok: true }>
  memoryActivityStopWatching: (
    input: { workspaceRoot: string | null }
  ) => Promise<{ ok: true }>
  memoryActivityGetStatus: (
    input: { workspaceRoot: string | null }
  ) => Promise<MemoryActivityStatus>
  memoryActivityGetSynapses: (
    input: { workspaceRoot: string | null }
  ) => Promise<MemoryActivitySynapse[]>
  memoryActivityIsInstalled: (
    input: { workspaceRoot: string | null }
  ) => Promise<boolean>
  memoryActivityClearHistory: (
    input: { workspaceRoot: string | null }
  ) => Promise<{ ok: true }>
  onMemoryActivityEvent: (cb: (event: MemoryActivityEvent) => void) => () => void
  onMemoryActivityStatus: (cb: (status: MemoryActivityStatus) => void) => () => void
  onMemoryActivitySynapses: (cb: (payload: MemoryActivitySynapsesPayload) => void) => () => void
  builtinSkillsList: () => Promise<BuiltinSkill[]>
  builtinSkillStatus: (
    input: { workspaceRoot: string | null; skillId: string }
  ) => Promise<BuiltinSkillStatus>
  builtinSkillInstall: (
    input: { workspaceRoot: string | null; skillId: string }
  ) => Promise<BuiltinSkillInstallResult>
  pluginsList: () => Promise<PluginRegistryListResult>
  pluginsDetectAvailability: (input?: PluginDetectAvailabilityInput) => Promise<PluginAvailabilityResult>
  readMarketplaceRegistry: (input?: MarketplaceRegistryReadInput) => Promise<MarketplaceRegistryReadResult>
  installPluginFolder: (srcDir: string) => Promise<PluginInstallResult>
  verifyMarketplacePlugin: (entry: MarketplacePluginEntry) => Promise<MarketplacePluginVerifyResult>
  installMarketplacePluginFolder: (input: MarketplacePluginInstallInput) => Promise<MarketplacePluginInstallResult>
  installMarketplacePluginFromRegistry: (input: MarketplacePluginRegistryInstallInput) => Promise<MarketplacePluginRegistryInstallResult>
  updateMarketplacePluginFromRegistry: (input: MarketplacePluginRegistryInstallInput) => Promise<MarketplacePluginRegistryInstallResult>
  uninstallMarketplacePlugin: (input: MarketplacePluginUninstallInput) => Promise<MarketplacePluginUninstallResult>
  reloadPlugins: () => Promise<PluginRegistryListResult>
  conversationProvidersList: () => Promise<ConversationProviderListResult>
  conversationProviderModels: (input: ConversationProviderModelsInput) => Promise<ConversationProviderModelsResult>
  conversationProviderTest: (input: ConversationProviderTestInput) => Promise<ConversationProviderTestResult>
  conversationSecretStatus: (input: ConversationSecretStatusInput) => Promise<ConversationSecretStatusResult>
  conversationSecretSet: (input: ConversationSecretSetInput) => Promise<ConversationSecretSetResult>
  conversationSecretClear: (input: ConversationSecretClearInput) => Promise<ConversationSecretClearResult>
  conversationSessionStart: (input: ConversationStartSessionInput) => Promise<ConversationStartSessionResult>
  conversationSessionSendTurn: (input: ConversationSendTurnInput) => Promise<ConversationSessionActionResult>
  conversationSessionInterrupt: (input: ConversationInterruptInput) => Promise<ConversationSessionActionResult>
  conversationSessionRespondToRequest: (
    input: ConversationRespondToRequestInput
  ) => Promise<ConversationSessionActionResult>
  conversationSessionStop: (input: ConversationStopSessionInput) => Promise<ConversationSessionActionResult>
  conversationSessionsList: (input?: ConversationListSessionsInput) => Promise<ConversationListSessionsResult>
  onConversationEvent: (cb: (event: ConversationEvent) => void) => () => void
  logDiagnostic: (input: DiagnosticLogInput) => Promise<DiagnosticLogEntry>
  openDiagnosticsLogsFolder: () => Promise<{ opened: true; path: string }>
  updateGetState: () => Promise<AppUpdateState>
  updateCheck: () => Promise<AppUpdateCheckResult>
  updateDownload: () => Promise<AppUpdateCheckResult>
  updateQuitAndInstall: () => Promise<AppUpdateCheckResult>
  updateOpenReleaseNotes: () => Promise<{ opened: true; url: string }>
  onUpdateStateChanged: (cb: (state: AppUpdateState) => void) => () => void
  readSpecialistSoul: (specialistId: SpecialistActionId) => Promise<SoulPromptResult>
  readMultiloopPrompt: (role: MultiloopRole) => Promise<SoulPromptResult>
  writefile: (path: string, content: string) => Promise<void>
  writeBinaryFile: (path: string, base64Content: string) => Promise<void>
  createFile: (parentDir: string, name: string) => Promise<string>
  createDir: (parentDir: string, name: string) => Promise<string>
  ensureDir: (parentDir: string, name: string) => Promise<string>
  createWorkspaceFolder: (parentDir: string, name: string) => Promise<string>
  renamePath: (sourcePath: string, nextName: string) => Promise<string>
  movePath: (sourcePath: string, destinationDir: string) => Promise<string>
  copyPath: (sourcePath: string, destinationDir: string) => Promise<string>
  copyPathInto: (sourcePath: string, destinationDir: string, options?: { overwrite?: boolean }) => Promise<string>
  deletePath: (targetPath: string) => Promise<void>
  showItemInFolder: (targetPath: string) => Promise<void>
  openHtmlFileInBrowser: (targetPath: string) => Promise<void>
  watchPath: (path: string, cb: (event: FileWatchEvent) => void) => Promise<() => Promise<void>>
  openDir: () => Promise<string | null>
  defaultWorkspaceParentDir: () => Promise<string | null>
  saveFile: (options?: SaveDialogOptions) => Promise<string | null>
  openFile: (options?: OpenDialogOptions) => Promise<string | null>
  showContextMenu: (items: ContextMenuItem[]) => Promise<string | null>
  showMenubarMenu: (label: string, position?: { x?: number; y?: number }) => Promise<boolean>
  clipboardReadText: () => Promise<string>
  clipboardWriteText: (text: string) => Promise<void>
  voiceTranscribe: (
    wav: ArrayBuffer,
    settings: TranscriptionRequestSettings
  ) => Promise<VoiceTranscribeResponse>
  getGitRepoRoot: (folderPath: string) => Promise<string | null>
  getGitStatus: (repoRoot: string) => Promise<GitStatusSnapshot>
  getGitFileBase: (repoRoot: string, filePath: string) => Promise<GitFileBaseResult>
  getGitFileAtStage: (repoRoot: string, filePath: string, stage: GitFileStage) => Promise<GitFileStageResult>
  getGitBranches: (repoRoot: string) => Promise<GitBranchSnapshot>
  getGitHistory: (repoRoot: string, limit?: number) => Promise<GitHistorySnapshot>
  getGitCommitGraph: (repoRoot: string, options?: GitGraphOptions) => Promise<GitGraphSnapshot>
  getGitConflicts: (repoRoot: string) => Promise<GitConflictSnapshot>
  getGitConflictFile: (repoRoot: string, filePath: string) => Promise<GitConflictFileContent | null>
  resolveGitConflict: (repoRoot: string, filePath: string, content: string) => Promise<GitCommandResult>
  stageGitPaths: (repoRoot: string, paths: string[]) => Promise<GitCommandResult>
  unstageGitPaths: (repoRoot: string, paths: string[]) => Promise<GitCommandResult>
  revertGitPaths: (repoRoot: string, paths: string[]) => Promise<GitCommandResult>
  discardUnstagedGitChanges: (repoRoot: string, paths: string[]) => Promise<GitCommandResult>
  commitGitChanges: (repoRoot: string, message: string) => Promise<GitCommandResult>
  pushGitBranch: (repoRoot: string) => Promise<GitCommandResult>
  fetchGitRemotes: (repoRoot: string) => Promise<GitCommandResult>
  pullGitBranchWithStash: (repoRoot: string) => Promise<GitCommandResult>
  switchGitBranch: (repoRoot: string, branchName: string) => Promise<GitCommandResult>
  mergeGitRef: (repoRoot: string, ref: string) => Promise<GitCommandResult>
  checkoutGitCommit: (repoRoot: string, commitHash: string) => Promise<GitCommandResult>
  createGitBranchFromCommit: (repoRoot: string, branchName: string, commitHash: string) => Promise<GitCommandResult>
  checkoutGitCommitAsBranch: (repoRoot: string, branchName: string, commitHash: string) => Promise<GitCommandResult>
  createGitTagFromCommit: (repoRoot: string, tagName: string, commitHash: string) => Promise<GitCommandResult>
  listGitWorktrees: (repoRoot: string) => Promise<GitWorktreeOperationResult<GitWorktreeListSnapshot>>
  createGitWorktree: (input: GitWorktreeCreateInput) => Promise<GitWorktreeOperationResult<GitWorktreeEntry>>
  removeGitWorktree: (input: GitWorktreeRemoveInput) => Promise<GitWorktreeOperationResult<GitCommandResult>>
  pruneGitWorktrees: (repoRoot: string) => Promise<GitWorktreeOperationResult<GitCommandResult>>
  repairGitWorktrees: (input: GitWorktreeRepairInput) => Promise<GitWorktreeOperationResult<GitCommandResult>>
  copyGitWorktreeIncludedFiles: (
    input: GitWorktreeCopyIncludedInput
  ) => Promise<GitWorktreeOperationResult<GitWorktreeCopyIncludedResult>>
  getGitHubTokenStatus: () => Promise<GitHubTokenStatus>
  setGitHubToken: (token: string) => Promise<GitHubTokenStatus>
  clearGitHubToken: () => Promise<GitHubTokenStatus>
  detectExistingAgentConfig: (input?: AgentConfigDetectInput) => Promise<AgentConfigDetectResult>
  adoptAgentConfig: (input: AgentConfigAdoptInput) => Promise<AgentConfigAdoptResult>
  mcpListCatalog: () => Promise<McpCatalogResult>
  mcpPreviewSync: (input: McpSyncInput) => Promise<McpSyncPreview>
  mcpSync: (input: McpSyncInput) => Promise<McpSyncResult>
  skillPackListCatalog: () => Promise<SkillPackCatalogResult>
  skillPackListInstalled: (input: SkillPackListInstalledInput) => Promise<SkillPackListInstalledResult>
  skillPackInstall: (input: SkillPackInstallInput) => Promise<SkillPackInstallResult>
  skillPackRemove: (input: SkillPackRemoveInput) => Promise<SkillPackRemoveResult>
  cliDetect: (cli: AgentCli, runtime?: Partial<CliRuntimeSettings>) => Promise<CliDetectResult>
  cliInstallMethods: (cli: AgentCli, runtime?: Partial<CliRuntimeSettings>) => Promise<CliInstallMethodInfo[]>
  cliInstall: (input: CliInstallInput, runtime?: Partial<CliRuntimeSettings>) => Promise<CliInstallResult>
  onCliInstallOutput: (cli: AgentCli, cb: (chunk: string) => void) => () => void
  openSprintEngineArtifact: (statePath: string, artifactPath: string) => Promise<SprintEngineArtifactCommandResult>
  approveSprintEngineArtifact: (statePath: string, artifactId: string) => Promise<SprintEngineArtifactCommandResult>
  autoApproveSprintEngineArtifact: (statePath: string, artifactId: string) => Promise<SprintEngineArtifactCommandResult>
  requestSprintEngineArtifactChanges: (
    statePath: string,
    artifactId: string,
    feedback: string
  ) => Promise<SprintEngineArtifactCommandResult>
  readySprintEngineTask: (statePath: string, taskId: string) => Promise<SprintEngineArtifactCommandResult>
  initializeSprintEngineState: (input: SprintEngineStateInitializeInput) => Promise<SprintEngineArtifactCommandResult>
  updateSprintEngineTask: (input: SprintEngineTaskUpdateInput) => Promise<SprintEngineArtifactCommandResult>
  createSprintEngineTask: (input: SprintEngineTaskCreateInput) => Promise<SprintEngineArtifactCommandResult>
  commentSprintEngineTask: (input: SprintEngineTaskCommentInput) => Promise<SprintEngineArtifactCommandResult>
  resolveSprintEngineTaskInput: (input: SprintEngineTaskResolveInput) => Promise<SprintEngineArtifactCommandResult>
  setSprintEngineTaskStatus: (input: SprintEngineTaskStatusSetInput) => Promise<SprintEngineArtifactCommandResult>
  setSprintEngineRunnerMode: (input: SprintEngineRunnerSetInput) => Promise<SprintEngineArtifactCommandResult>
  createSprintEnginePullRequest: (statePath: string) => Promise<SprintEngineArtifactCommandResult>
  refreshSprintEnginePullRequestStatus: (statePath: string) => Promise<SprintEngineArtifactCommandResult>
  replenishSprintEngineRoster: (input: SprintEngineRosterReplenishInput) => Promise<SprintEngineArtifactCommandResult>
  addSprintEngineRosterMember: (input: SprintEngineRosterAddInput) => Promise<SprintEngineArtifactCommandResult>
  readSprintEngineProjection: (statePath: string, knownToken?: string) => Promise<SprintEngineProjectionReadResult>
  readSprintEngineRegistryRoles: (input: SprintEngineRegistryRolesReadInput) => Promise<SprintEngineMcpReadResult>
  readSprintEngineRegistryRole: (input: SprintEngineRegistryRoleReadInput) => Promise<SprintEngineMcpReadResult>
  /** Install third-party Sprint Engine roles from a folder into the user-global registry. */
  installUserSprintEngineRoleFolder: (srcDir: string) => Promise<RoleInstallResult>
  /** List the roles currently installed in the user-global registry. */
  listUserSprintEngineRoles: () => Promise<UserRoleListResult>
  /** Save (create or overwrite) a user-authored role manifest and its soul (SKILL.md) body. */
  saveUserSprintEngineRole: (input: UserRoleSaveInput) => Promise<UserRoleSaveResult>
  /** Delete a user-authored role and its soul skill folder. Idempotent. */
  deleteUserSprintEngineRole: (id: string) => Promise<UserRoleDeleteResult>
  /** Read a user-authored role manifest and its soul body for edit prefill. */
  getUserSprintEngineRole: (id: string) => Promise<UserRoleGetResult>
  /** Install third-party workspace layout templates from a folder. */
  installUserLayoutTemplateFolder: (srcDir: string) => Promise<LayoutTemplateInstallResult>
  /** List the layout templates installed in the user-global registry. */
  listUserLayoutTemplates: () => Promise<UserLayoutTemplateListResult>
  /** List installed third-party capability modules with trust, permissions, and launch readiness. */
  listThirdPartyModules: () => Promise<ThirdPartyModuleListResult>
  /** Install a third-party capability module from a folder (validated, not executed). */
  installThirdPartyModuleFolder: (srcDir: string) => Promise<ThirdPartyModuleInstallResult>
  /** Trust or untrust an installed third-party module. */
  setThirdPartyModuleTrust: (id: string, trusted: boolean) => Promise<ThirdPartyModuleTrustResult>
  /** Serve trusted third-party modules' entry.renderer bundles for the renderer loader. */
  listThirdPartyRendererEntries: () => Promise<ThirdPartyRendererEntriesResult>
  readSprintEngineDispatch: (input: SprintEngineDispatchReadInput) => Promise<SprintEngineMcpReadResult>
  /** Sanitized per-run + per-agent feedback analysis for the run summary (read-only). */
  summarizeSprintEngineFeedback: (statePath: string) => Promise<SprintEngineMcpReadResult>
  initializeSwitchboard: (workspaceRoot: string) => Promise<SwitchboardInitApiResult>
  readSwitchboardTasks: (workspaceRoot: string) => Promise<SwitchboardReadResult>
  createSwitchboardTask: (input: SwitchboardCreateTaskInput) => Promise<SwitchboardMutationResult>
  updateSwitchboardTask: (input: SwitchboardUpdateTaskInput) => Promise<SwitchboardMutationResult>
  moveSwitchboardTask: (input: SwitchboardMoveTaskInput) => Promise<SwitchboardMutationResult>
  promoteSwitchboardInboxTask: (input: SwitchboardPromoteInboxTaskInput) => Promise<SwitchboardMutationResult>
  cancelSwitchboardTask: (input: SwitchboardCancelTaskInput) => Promise<SwitchboardMutationResult>
  addSwitchboardComment: (input: SwitchboardAddCommentInput) => Promise<SwitchboardMutationResult>
  claimSwitchboardTask: (input: SwitchboardClaimTaskInput) => Promise<SwitchboardClaimTaskResult>
  publishSwitchboardTask: (input: SwitchboardPublishTaskInput) => Promise<SwitchboardMutationResult>
  recoverSwitchboardLock: (input: SwitchboardRecoverLockInput) => Promise<SwitchboardRecoverLockResult>
  requeueSwitchboardTask: (input: SwitchboardRequeueTaskInput) => Promise<SwitchboardMutationResult>
  startSwitchboardRunner: (input: SwitchboardRunnerStartInput) => Promise<SwitchboardRunnerResult>
  pauseSwitchboardRunner: (workspaceRoot: string) => Promise<SwitchboardRunnerResult>
  resumeSwitchboardRunner: (input: SwitchboardRunnerWorkspaceInput) => Promise<SwitchboardRunnerResult>
  stopSwitchboardRunner: (workspaceRoot: string) => Promise<SwitchboardRunnerResult>
  tickSwitchboardRunner: (input: SwitchboardRunnerWorkspaceInput) => Promise<SwitchboardRunnerResult>
  getSwitchboardRunnerState: (input?: string | SwitchboardRunnerWorkspaceInput) => Promise<SwitchboardRunnerResult>
  stopSwitchboardExecution: (input: SwitchboardStopExecutionInput) => Promise<SwitchboardStopExecutionResult>
  getSwitchboardExecutionStatus: (input: SwitchboardExecutionStatusInput) => Promise<SwitchboardExecutionStatusResult>
  getSwitchboardExecutionLogs: (input: SwitchboardExecutionLogsInput) => Promise<SwitchboardExecutionLogsResult>
  startWatchtowerReview: (input: WatchtowerStartReviewInput) => Promise<WatchtowerRunResult>
  startWatchtowerTriage: (input: WatchtowerStartTriageInput) => Promise<WatchtowerRunResult>
  getWatchtowerRun: (input: { workspaceRoot: string; runId: string }) => Promise<WatchtowerRunResult>
  listWatchtowerRuns: (workspaceRoot: string) => Promise<WatchtowerRunListResult>
  importGitHubIssuesToWatchtower: (workspaceRoot: string) => Promise<SwitchboardImportResult>
  importJiraIssuesToWatchtower: (workspaceRoot: string) => Promise<SwitchboardImportResult>
  initializeMultiloopState: (input: MultiloopInitInput) => Promise<MultiloopInitResult>
  terminalSpawn: (
    sessionId: string,
    cols: number,
    rows: number,
    cwd?: string,
    resume?: boolean,
    sprintEngineStatePath?: string,
    cli?: AgentCli,
    initialPrompt?: string,
    cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>,
    shellOnly?: boolean,
    metadata?: TerminalSpawnMetadata
  ) => Promise<TerminalSpawnResult>
  terminalWrite: (sessionId: string, data: string) => Promise<void>
  terminalWriteFast: (sessionId: string, data: string) => void
  terminalResize: (sessionId: string, cols: number, rows: number) => Promise<void>
  terminalStatus: (sessionId: string) => Promise<{ processAlive: boolean; suspended: boolean }>
  terminalList: () => Promise<TerminalSessionSnapshot[]>
  terminalSetVisible: (sessionId: string, visible: boolean) => Promise<void>
  // Freeze-the-view: suspend kills the agent process but keeps the painted,
  // resumable session; resume relaunches it (mirrors terminalSpawn's payload,
  // forced --resume) on the first keystroke.
  terminalSuspend: (sessionId: string) => Promise<void>
  terminalResume: (
    sessionId: string,
    cols: number,
    rows: number,
    cwd?: string,
    resume?: boolean,
    sprintEngineStatePath?: string,
    cli?: AgentCli,
    initialPrompt?: string,
    cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>,
    shellOnly?: boolean,
    metadata?: TerminalSpawnMetadata
  ) => Promise<TerminalSpawnResult>
  terminalKill: (sessionId: string) => Promise<void>
  // Push the user's "Pause idle terminals after" setting (ms) to the main reap
  // policy. Clamped/validated in main; the next idle sweep uses the latest value.
  setTerminalIdleSuspendMs: (ms: number) => Promise<void>
  onTerminalReplay: (sessionId: string, cb: (data: string) => void) => () => void
  onTerminalData: (sessionId: string, cb: (data: string) => void) => () => void
  onTerminalExit: (sessionId: string, cb: (code: number) => void) => () => void
  onTerminalError: (sessionId: string, cb: (message: string) => void) => () => void
  onTerminalSessionsChanged: (cb: (sessions: TerminalSessionSnapshot[]) => void) => () => void
  diagnosticsGetProcessMetrics: () => Promise<ProcessMetricsSnapshot>
  // Synchronous: returns the preload's accumulated IPC counters (empty channels
  // when diagnostics is disabled, since instrumentation is skipped entirely).
  diagnosticsGetIpcStats: () => IpcStatsSnapshot
  diagnosticsOpenWindow: () => Promise<void>
  onAppMenuCommand: (cb: (command: string) => void) => () => void
  updateAppMenuAccelerators: (updates: AppMenuAcceleratorUpdate[]) => Promise<AppMenuAcceleratorUpdateResult>
  workspaceBackupWrite: (payload: WorkspaceBackupPayload) => Promise<WorkspaceBackupWriteResult>
  workspaceBackupRead: () => Promise<WorkspaceBackupReadResult>
  setModuleEnablement: (overrides: ModuleEnablementOverrides) => Promise<ModuleEnablementWriteResult>
  setColorScheme: (scheme: ColorScheme) => Promise<void>
  readBacklogObjectStore: (workspaceRoot: string) => Promise<BacklogReadResult>
  ensureBacklogObjectRecords: (workspaceRoot: string, items: BacklogItemRecordInput[]) => Promise<BacklogReadResult>
  ensureBacklogItemIds: (input: BacklogEnsureIdsInput) => Promise<BacklogEnsureIdsResult>
  readBacklogWorkspaceKey: (workspaceRoot: string) => Promise<BacklogWorkspaceKeyResult>
  updateBacklogStatus: (input: BacklogStatusInput) => Promise<BacklogMutationResult>
  updateBacklogType: (input: BacklogTypeInput) => Promise<BacklogMutationResult>
  updateBacklogTriage: (input: BacklogTriageInput) => Promise<BacklogMutationResult>
  updateBacklogHighlight: (input: BacklogHighlightInput) => Promise<BacklogMutationResult>
  addOrUpdateBacklogLink: (input: BacklogAddOrUpdateLinkInput) => Promise<BacklogMutationResult>
  updateBacklogModuleMetadata: (input: BacklogModuleMetadataInput) => Promise<BacklogMutationResult>
  moveBacklogObjectSource: (input: BacklogMoveSourceInput) => Promise<BacklogMutationResult>
  removeBacklogObjectRecord: (input: BacklogRemoveRecordInput) => Promise<BacklogMutationResult>
  updateBacklogEpic: (input: BacklogEpicInput) => Promise<BacklogMutationResult>
  updateBacklogEpicColor: (input: BacklogEpicColorInput) => Promise<BacklogMutationResult>
  updateBacklogDependencies: (input: BacklogDependenciesInput) => Promise<BacklogMutationResult>
  createBacklogEpic: (input: BacklogCreateEpicInput) => Promise<BacklogCreateEpicResult>
}
