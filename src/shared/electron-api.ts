import type { TranscriptionRequestSettings, VoiceTranscribeResponse } from './voiceTranscription'
import type { ObservedCheckout } from './observed-checkout'
// Type-only both ways (agent-launch.ts imports this module's McpSettings /
// permission-preset vocabulary), so the cycle erases at compile time and no
// runtime import exists in either direction.
import type { AgentLaunchRecord } from './agent-launch'
import type { HostedModelFeed } from './hosted-model-feed'
export type { HostedModel, HostedModelFeed, HostedCliModelCatalogs } from './hosted-model-feed'
import type { HostedCardFeed } from './hosted-card-feed'
export type { CardAction, CardActionVerb, HostedCard, HostedCardFeed, HostedCardKind } from './hosted-card-feed'
// The build-identity shape a window reports; re-exported because it is part of
// this IPC contract like the rest of the surface below.
import type { BuildStamp } from './build-stamp'
export type { BuildStamp } from './build-stamp'
import type {
  BrowserCaptureInput,
  BrowserClearResult,
  BrowserConfig,
  BrowserHostKey,
  BrowserPointerEvent,
  BrowserRegisterInput,
  BrowserRegisterResult,
  BrowserScreenshotResult,
  BrowserTabState,
  LocalServer,
} from './browser'
import type { BrowserColorScheme, BrowserViewport } from './browser-devices'
import type {
  FolderOpenRequest,
  FolderOpenResult,
  FolderOpenTargetAvailability,
} from './folder-open-targets'
// Re-exported because these shapes are the open-in-editor IPC contract itself:
// the renderer reads them off this module like the rest of the API surface.
export type {
  FolderOpenFailureReason,
  FolderOpenRequest,
  FolderOpenResult,
  FolderOpenTargetAvailability,
  FolderOpenTargetId,
} from './folder-open-targets'
import type {
  AgentCapabilitiesInput,
  AgentCapabilitiesInvalidation,
  AgentCapabilitiesResult,
  AgentCapabilitiesWatchInput,
  ScannedPlugin,
  ScanResult,
  SkillDiscoveryResult,
  SkillHarness,
  SkillRepoHit,
  SkillSearchHit,
  SkillSource,
} from './skills'
// Re-exported because the harness identity is part of this IPC contract: it
// rides BuiltinSkill, WorkspaceSkill and every install/uninstall result.
export type { SkillHarness } from './skills'
// The capability query's shapes live with the other skill shapes; these are its
// IPC envelopes, same split as the skill-source calls below.
export type {
  AgentCapabilitiesInput,
  AgentCapabilitiesInvalidation,
  AgentCapabilitiesResult,
  AgentCapabilitiesWatchInput,
  AgentMcpServer,
  AgentSkill,
  AgentSkillSource,
  CapabilityDiagnostic,
} from './skills'
import type { SprintEngineAutomationIntentRecord } from './sprintengine/automation-intent'
import type { SprintEngineAutomationMode as SprintEngineAutomationIntentMode } from './sprintengine/automation-types'
import type {
  SprintEngineLaunchSettings,
  SprintEngineLaunchSettingsRecord,
} from './sprintengine/launch-settings'
import type { SprintRunSummary, SprintRunsChangedEvent } from './sprintengine/runSummary'
import type {
  SprintRuntimeOp,
  SprintRuntimeRunRegistration,
  SprintRuntimeStopReasonPush,
} from './sprintengine/runtime-bridge'
import type { AutomationServerStatus } from './automation'
import type {
  TailnetApprovePairRequestView,
  TailnetLiveState,
  TailnetPairingOfferView,
  TailnetPushPayload,
  TailnetRemoteStatus,
  TailnetScope,
} from './tailnet'
import type { TailnetPeerScan } from './tailnet-peers'
import type { RepositoryIdentity } from './repository-identity'
import type {
  FleetAttachResult,
  FleetBrowse,
  FleetConnection,
  FleetCreateTerminalResult,
  FleetCheckoutRequest,
  FleetWorkspaceCheckoutResult,
  FleetEvent,
  FleetLiveState,
  FleetPairResult,
  FleetRun,
  FleetTerminalEvent,
  FleetCollectPairingResult,
  FleetRequestPairingResult,
} from './tailnet-fleet'
import type {
  AutomationsBuiltinInstallInput,
  AutomationsBuiltinInstallResult,
  AutomationsBuiltinListResult,
  AutomationsCreateInput,
  AutomationsDefinitionInput,
  AutomationsDefinitionResult,
  AutomationsDeleteResult,
  AutomationsEngineStatusResult,
  AutomationsInstanceListResult,
  AutomationsListResult,
  AutomationsProvidersResult,
  AutomationsDefinitionsChangedEvent,
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
import type { SprintEngineTokenUsageReport } from './sprintengine-token-usage'
// Re-export the tracker seam contract so the preload bridge and renderer import
// tracker types from the single electron-api surface (MC-1633).
// Write-back config + IPC contracts (MC-1640): schema owned by T10, IPC surface
// consumed by the T11 settings UI. Re-exported through the single electron-api
// surface like the rest of the tracker seam.
import type { LayoutTemplateInstallResult, UserLayoutTemplateListResult } from './layouts/template-manifest'
import type { DesignSystemBrandDemoResolveResult } from './design-system/brand-demo'
import type { DesignSystemBundleLintRunResult } from './design-system/bundle-lint-run'
import type { DesignSystemRegenResult } from './design-system/derived-files'
import type { DesignSystemScaffoldResult } from './design-system/bundle-scaffold'
import type { DesignSystemBundleReadResult } from './design-system/bundle-view'
import type {
  DesignSystemLibraryListResult,
  DesignSystemLibraryReadResult,
  DesignSystemRegisterResult,
} from './design-system/library'
import type {
  DesignSystemAttachResult,
  DesignSystemAttachSource,
  DesignSystemDetachResult,
} from './design-system/attach'
import type { ConversationProviderListEntry, ConversationProviderModel, PluginRegistryListEntry } from './plugin-manifest'
import type { MarketplaceComponentKind, MarketplaceIndex, MarketplaceManifestIssue, MarketplacePluginEntry } from './marketplace/manifest'
import type { MarketplaceUpdateStateEntry } from './marketplace/update-state'
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
  ConversationSetPermissionInput,
  ConversationProvidersListInput,
  ConversationStartSessionInput,
  ConversationStartSessionResult,
  ConversationStopSessionInput,
  ConversationTranscriptInput,
  ConversationTranscriptResult,
} from './conversation-runtime'
import type { ModuleBridgeInvokeResult } from './modules/bridge'
import type { ModuleEventEnvelope } from './modules/events'
import type {
  ModuleTrustStatus,
  ThirdPartyModuleInstallResult,
  ThirdPartyModuleListResult,
  ThirdPartyModuleTrustResult,
  ThirdPartyRendererEntriesResult,
} from './modules/manifest'
import type {
  ModuleRegistrySnapshot,
  ModuleRegistrySnapshotWriteResult,
} from './modules/registry-snapshot'
import type {
  WorkspaceSyncCommand,
  WorkspaceSyncCommandResult,
  WorkspaceSyncEvent,
  WorkspaceSyncSnapshot,
} from './workspace-sync'
import type {
  CommentSync,
  ReviewBrief,
  ReviewChangeSet,
  ReviewComment,
  ReviewSourceKind,
  ReviewWorkspaceState,
} from './review'
import type { VersionControlProviderProbe } from './version-control'
// Re-exported because the probe shape is part of this IPC contract: the
// version-control settings sections read it straight off the api surface.
export type {
  VersionControlProbeFailure,
  VersionControlProviderId,
  VersionControlProviderProbe,
} from './version-control'

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
  harnesses?: SkillHarness[]
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

/**
 * What the catalogue's built-in row for the app's own plugin reads.
 * `installedVersion` is '' until this app run has installed into that
 * workspace; a value that differs from `bundledVersion` is the drift Sync
 * reports, and the next open closes it.
 */
export type StudioPluginStatus = {
  bundledVersion: string
  installedVersion: string
  skillDirNames: string[]
  claudePluginKey: string
  /** ISO timestamp the hooks acknowledgement was answered, '' when it has not been. */
  hooksAcknowledgedAt: string
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

// The invocation a spawn would make, rendered for display before it happens
// (MC-2147 — the new-agent tab's receipt line). Main renders it through the
// SAME function the launch path uses, because the renderer's plugin catalog
// withholds argv and a hand-written preview of the flags would drift the first
// time a manifest changed. The prompt is never part of it: it is on screen a
// line above, and re-rendering per keystroke would bury the flags.
// No `debugMode`: it prepends a directive to the PROMPT and never touches a
// flag, so on a prompt-free preview it has nothing to add — and rendering it
// would put a multi-line directive in a one-line receipt.
export type AgentLaunchPreviewInput = {
  cli: AgentCli
  cliModel?: string
  cliReasoning?: string
  cliPermissionPreset?: SprintEngineCliPermissionPreset
  cliRuntime?: CliRuntimeSettings
}

export type AgentLaunchPreview = {
  /** The resolved command — a path when the runtime override names one. */
  binary: string
  /** Everything after the command, in spawn order. */
  args: string[]
  /** Binary + args as one posix-quoted line, ready to render. */
  display: string
}

export type AgentLaunchPreviewResult =
  | { ok: true; preview: AgentLaunchPreview }
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
  skillHarnesses?: SkillHarness[]
  // The CLI an agent-backed automation falls back to when its own config names
  // none (`appSettings.lastSelectedCli`, which only the renderer holds). An
  // automation component that would need it and does not get it refuses to
  // install, rather than creating a scheduled job that cannot launch.
  automationDefaultCli?: string
}

// Both bundle and inline-MCP registry installs use this shape: a bundle entry
// carries `source`, an inline-MCP entry carries `mcp.servers` (no bundle to
// download). `trustGranted` is the server-side community/unsigned trust gate;
// inline-MCP is code-execution config and never installs without it.
export type MarketplacePluginRegistryInstallInput = Omit<MarketplacePluginInstallInput, 'localFolder'> & {
  entry: MarketplacePluginEntry
  trustGranted?: boolean
  // Claude Code plugins: the commit the pre-trust verify disclosed; the
  // install downloads this exact ref (TOCTOU guard for unpinned sources).
  claudePluginRef?: string
}

export type MarketplacePluginUninstallInput = {
  pluginId: string
  workspaceRoot?: string
  mcpSettings?: McpSettings
  mcpClients?: McpClientTarget[]
  skillHarnesses?: SkillHarness[]
}

export type MarketplacePluginTrustClassification = 'verified' | 'community' | 'unsigned' | 'invalid'

export type MarketplacePluginVerifyResult = {
  classification: MarketplacePluginTrustClassification
  permissions: CapabilityPermission[]
  sourceUrl: string
  issues?: MarketplaceManifestIssue[]
  message?: string
  // Real content listing disclosed at the trust prompt for entries whose
  // payload is files rather than capability permissions (Claude Code plugins:
  // the skill folders the trust grant installs). Never fabricated.
  files?: string[]
  // The commit the listing was read from (Claude Code plugins). Passing it
  // back as MarketplacePluginRegistryInstallInput.claudePluginRef makes the
  // install fetch exactly the disclosed content — a mutable default-branch
  // source cannot swap bytes between the trust prompt and the install.
  pinnedRef?: string
}

export type MarketplacePluginInstalledComponent = {
  kind: MarketplaceComponentKind
  id: string
  message?: string
  serverIds?: string[]
  servers?: McpServerConfig[]
  harnesses?: SkillHarness[]
  installedDirName?: string
  // Module components only: the trust classification at install and the
  // installed manifest's content fingerprint — what the lifecycle's
  // post-success marketplace trust grant binds to (and what uninstall revokes).
  trustStatus?: ModuleTrustStatus
  manifestFp?: string
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
      // Non-fatal disclosures about a successful install, e.g. skills the
      // entry lists that shipped without bundled content and so were not
      // installed. Surfaced to the user; never hidden behind ok:true.
      notices?: string[]
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
      classification: Extract<MarketplacePluginTrustClassification, 'verified' | 'community' | 'unsigned'>
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

// Whether an installed agent CLI is behind the newest version its package
// registry publishes. `unknown` covers a
// CLI with no `package` block, an unparsable version, or a registry that did
// not answer; it is never rendered as "up to date". `updateCommand` is what
// the Update button will run, chosen in main from the manifest and where the
// binary lives; the renderer shows it and never composes one.
export type CliVersionAdvisoryStatus = 'current' | 'behind_latest' | 'unknown'

export type CliUpdateCommand = {
  kind: 'cli-updater' | 'brew' | 'npm' | 'install-method'
  command: string
}

export type CliVersionAdvisory = {
  cli: AgentCli
  status: CliVersionAdvisoryStatus
  currentVersion: string | null
  latestVersion: string | null
  updateCommand: CliUpdateCommand | null
  checkedAt: string
}

export type CliVersionAdvisoryMap = Partial<Record<AgentCli, CliVersionAdvisory>>

export type CliVersionAdvisoriesInput = {
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
  // Bypass the hour-long registry cache (Settings "Re-check").
  force?: boolean
}

export type CliVersionAdvisoriesResult =
  | {
      ok: true
      advisories: CliVersionAdvisoryMap
      checkedAt: string
      // Outdated CLIs this install has not been told about at this version
      // yet: the toast fires once per (cli, latestVersion). Main records the
      // pairs it has announced, so a restart does not repeat them.
      newlyOutdated?: CliVersionAdvisory[]
    }
  | { ok: false; message: string }

// The hosted model feed (src/shared/hosted-model-feed.ts) as the main-process
// client serves it. `ok: true` always carries a feed to render: live from
// GitHub, the disk cache, or the bundled seed. `degraded` means the last fetch
// failed or was rejected and the copy shown is the last good one; `message`
// says why in plain words for the Settings line.
export type HostedModelFeedReadInput = {
  forceRefresh?: boolean
  // Serve whatever is on disk (cache, else seed) without touching the network.
  // Store boot uses it so the pickers never wait on a fetch.
  cachedOnly?: boolean
}

export type HostedModelFeedReadResult =
  | {
      ok: true
      state: 'ok' | 'degraded'
      feedUrl: string
      source: 'network' | 'cache' | 'seed'
      fetchedAt: string
      etag?: string
      notModified?: boolean
      // True when this read wrote a different copy to the disk cache (the first
      // live copy after install counts, even if it equals the bundled seed).
      // Fires `hostedModelFeed:changed`; the renderer decides whether it is news.
      changed: boolean
      feed: HostedModelFeed
      message?: string
    }
  | {
      ok: false
      state: 'offline' | 'fetch-error' | 'invalid-schema'
      feedUrl: string
      statusCode?: number
      message: string
    }

// The hosted card feed (src/shared/hosted-card-feed.ts) as the main-process
// client serves it. Deliberately the model feed's shape and deliberately not
// the model feed's type: the two schemas ship on their own clocks and a shared
// alias would make one feed's change the other feed's problem. `ok: true`
// always carries a feed to draw — live from GitHub, the disk cache, or the
// bundled seed — because the home page never apologises for its own network
// (epic ruling R6). `dropped` counts rows this build refused inside an
// otherwise good body: a diagnostic, never a reason to blank the page.
export type HostedCardFeedReadInput = {
  forceRefresh?: boolean
  // Serve whatever is on disk (cache, else seed) without touching the network.
  // The Extensions home uses it so first paint never waits on a fetch.
  cachedOnly?: boolean
}

export type HostedCardFeedReadResult =
  | {
      ok: true
      state: 'ok' | 'degraded'
      feedUrl: string
      source: 'network' | 'cache' | 'seed'
      fetchedAt: string
      etag?: string
      notModified?: boolean
      // True when this read wrote a different copy to the disk cache (the first
      // live copy after install counts, even if it equals the bundled seed).
      // Fires `hosted-card-feed:changed`; the renderer decides what to do.
      changed: boolean
      feed: HostedCardFeed
      // Rows the schema gate refused inside an otherwise good body, and what
      // was wrong with each. Reported, never fatal — and reported for a cached
      // or seeded copy too, because a build that cannot read a card the feed
      // carries should say so wherever it read it from.
      dropped?: number
      dropReasons?: string[]
      message?: string
    }
  | {
      ok: false
      state: 'offline' | 'fetch-error' | 'invalid-schema'
      feedUrl: string
      statusCode?: number
      message: string
    }

export type MarketplaceRegistryReadInput = {
  forceRefresh?: boolean
}

export type MarketplaceRegistryReadResult =
  | {
      ok: true
      state: 'ok' | 'empty'
      registryUrl: string
      source: 'network' | 'cache' | 'bundled'
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

// Per-installed-entry update detection (MC-1873). `checked: false` is the
// honest "couldn't check for updates" shape — the registry read failed, so
// every entry carries `state: 'unknown'`, never "up to date". The `ok: false`
// arm is a local failure (unreadable receipt store), not a registry one.
export type MarketplaceUpdateStatesResult =
  | {
      ok: true
      checked: true
      registryState: MarketplaceRegistryState
      registrySource: 'network' | 'cache' | 'bundled' | 'seed'
      stale: boolean
      fetchedAt: string
      registryMessage?: string
      entries: MarketplaceUpdateStateEntry[]
    }
  | {
      ok: true
      checked: false
      registryState: MarketplaceRegistryState
      registryMessage?: string
      entries: MarketplaceUpdateStateEntry[]
    }
  | { ok: false; message: string }

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

// Generic credential IPC — the shared credential store surfaced for any owner
// kind (CLI plugins AND conversation providers). `id` is the manifest id whose
// `auth` descriptor owns the secret. Results reuse the conversation-secret
// shapes, which are structurally generic.
export type CredentialSecretStatusInput = {
  id: string
}

export type CredentialSecretSetInput = CredentialSecretStatusInput & {
  value: string
}

export type CredentialSecretClearInput = CredentialSecretStatusInput

export type CredentialSecretStatusResult = ConversationSecretStatusResult

export type CredentialSecretSetResult = ConversationSecretSetResult

export type CredentialSecretClearResult = ConversationSecretClearResult

// Runtime CLI identity is a plugin id. Bundled choices include `codex` and
// `claude-code`.
export type AgentCli = string
export type AgentExecutionMode = 'current_workspace' | 'worktree'
export type SprintEngineCliPermissionPreset = 'none' | 'manual' | 'auto' | 'bypass'

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
// 'source' is a server a *source* installed (backlog/2026-09-05-plugin-sources.md,
// "Provenance"): it is neither bundled with the app nor typed by hand, and Sync
// owns it. The distinction is what lets a sync overwrite exactly what it wrote
// and nothing else — the same rule `.multicode-skill.json` gives skills.
export type McpServerSource = 'bundled' | 'custom' | 'source'
export type McpRiskLevel = 'low' | 'network' | 'local-command' | 'secrets'

/**
 * Which source installed a server, which of its items it is, and the commit its
 * declaration was read at. A config carrying this is `source: 'source'`; one
 * without it can never be, so nothing a person typed is ever taken over by a
 * sync.
 */
export type McpServerSourceRef = {
  sourceId: string
  /** The `ScannedMcpServer.id` in that source's scan. */
  itemId: string
  commitSha: string
  /**
   * Set by a sync that re-read the source and no longer found `itemId`. The
   * entry stays and keeps working; the surface says it is no longer in its
   * source rather than deleting a server someone is using.
   */
  missing?: boolean
}

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
  /** Present exactly when `source` is 'source'; see McpServerSourceRef. */
  sourceRef?: McpServerSourceRef
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
  skill?: string
  icon?: string
  // Membership of the Ticket trackers surface, declared in the catalogue so
  // adding a fifth tracker is a data edit rather than a renderer change.
  ticketTracker?: boolean
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
  /**
   * Servers this sync must take OUT of every CLI's config, named because the
   * settings no longer do. A server is pruned from a config only while
   * `settings` still names it, so a caller that has just forgotten one — an
   * uninstalled plugin's, say — has to say so here or the entry survives in
   * `.mcp.json` for good
   * (backlog/2026-09-06-a-github-marketplace-plugin-installs-nothing-for-claude-code.md).
   */
  forgetServerIds?: string[]
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
    // Declared repo the session works in (MC-1610), derived from its launch
    // cwd. Binds the session's claim queue to that repo's tree; absent for
    // single-repo runs and launches outside a declared worktree.
    repo?: string
    // The one task this session may work (MC-2136), set when its launch cwd IS
    // that task's own worktree under per-task isolation. Binds the claim queue
    // to that task alone: the engine commits the task's work from this tree, so
    // a session here working anything else would have its changes committed by
    // nobody. Absent on every run that shares one worktree.
    taskId?: string
    cli?: McpClientTarget
    // Workspace Knowledge Graph root ('' when unset); lets the MCP server gate
    // the workspace_knowledge prompt layer at compose time.
    knowledgeRoot?: string
    http?: {
      url: string
      authTokenEnvVar?: string
      headers?: Record<string, string>
    }
  }
  requiredOnly?: boolean
  write?: boolean
  // Connector-scoped writes are exclusive: the worktree config must end with
  // exactly the servers in this sync (the connector set). Any MCP server the
  // base repo committed into the worktree config is pruned rather than merged,
  // preserving the connector-only isolation contract. Off (default) keeps the
  // normal workspace behavior of merging over the user's configured servers.
  pruneUnlistedServers?: boolean
}

/**
 * The two CLIs the first-run import wizard scans for existing config. A closed
 * pair, not a list of every CLI: the paths it scans are the *user-level* ones
 * (`~/.codex/config.toml`, `~/.claude.json`), which no plugin manifest declares
 * — manifests declare the workspace paths the writer owns.
 *
 * The parsers behind it are already shared with the manifest-driven read path
 * (src/main/mcp-config-readers), so there is one parser per format. What is
 * still literal here is the path list; widening the wizard to every CLI means
 * declaring those user-level paths in the manifests and resolving them through
 * `resolveMcpConfigPath`, which is the read path's job (MC-1960), not another
 * hardcoded pair here.
 */
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

// One entry in the unified workspace skill inventory: built-ins, skills
// installed from a source, and hand-dropped custom skill dirs, deduped by skill
// id across harness dirs. Name/description come from the installed SKILL.md
// frontmatter when present, falling back to BUILTIN_SKILLS metadata, then the
// directory name.
export type WorkspaceSkillSource = 'builtin' | 'custom' | 'plugin'
export type WorkspaceSkillInstallState = 'installed' | 'available' | 'update-available'

export type WorkspaceSkill = {
  id: string
  name: string
  description?: string
  source: WorkspaceSkillSource
  harnesses: SkillHarness[]
  installState: WorkspaceSkillInstallState
  version?: string
}

export type WorkspaceSkillsListInput = {
  workspaceRoot: string
}

export type WorkspaceSkillsListResult =
  | { ok: true; skills: WorkspaceSkill[] }
  | { ok: false; message: string }

// Attaching a skill to the agents that can use it, and removing it again.
// src/main/agent-skill-installer.ts owns the behaviour; these are the IPC
// envelopes.

/**
 * What happened at one harness directory. Attach reaches several at once, so
 * three successes and one permission error must render as three successes and
 * one error — never as a bare "failed", and never as a success that quietly
 * wrote nothing.
 */
export type AgentSkillTargetStatus = 'written' | 'unchanged' | 'removed' | 'skipped' | 'failed'

/**
 * `not-ours` is a skill the user wrote by hand under that name: reported, never
 * overwritten or deleted. `absent` is a remove target that held nothing.
 */
export type AgentSkillSkipReason = 'not-ours' | 'absent'

export type AgentSkillTarget = {
  harnessId: string
  /** Every installed CLI that reads this directory — `.claude` serves three. */
  pluginIds: string[]
  /** Workspace-relative, e.g. `.claude/skills/backlog`. */
  path: string
  /** Whether the CLIs reading it pick the change up only after a restart. */
  restartRequired: boolean
  status: AgentSkillTargetStatus
  reason?: AgentSkillSkipReason
  /** Present on `failed`, naming what the filesystem said. */
  message?: string
}

export type AgentSkillWriteInput = {
  workspaceRoot: string
  skillId: string
}

/**
 * `ok: false` is reserved for a request that could not be attempted at all — no
 * workspace, an unusable skill id, no installed CLI that reads skills, or
 * nothing to copy. Anything that reached the directories reports per target.
 */
export type AgentSkillWriteResult =
  | { ok: true; skillId: string; targets: AgentSkillTarget[] }
  | { ok: false; message: string }

// Skill sources (src/shared/skills.ts owns the shapes; these are the IPC
// envelopes). Sources are app-level; installing is workspace-level, so
// skillsInstall is the only call here that needs a workspace root.
export type SkillSourcesResult =
  | { ok: true; sources: SkillSource[] }
  | { ok: false; message: string }

export type SkillAddSourceInput = {
  /** `owner/name`, a github.com URL, or a /tree/<ref> deep link. */
  repo: string
  /** Re-scan a source already in the list instead of refusing it. */
  replace?: boolean
}

export type SkillAddSourceResult =
  | { ok: true; source: SkillSource; scan: ScanResult }
  | { ok: false; message: string }

/**
 * A folder on this machine, added as a source. Separate from
 * `skillsAddSource` because the two take different identities — a repository
 * reference and an absolute path — and a single field taking either would be
 * a string the caller has to hope is parsed the way it meant.
 */
export type SkillAddLocalSourceInput = {
  /** Absolute path to the folder to scan. */
  path: string
  /** Re-scan a folder already in the list instead of refusing it. */
  replace?: boolean
}

export type SkillRemoveSourceInput = { sourceId: string }

export type SkillRemoveSourceResult =
  | { ok: true; sourceId: string }
  | { ok: false; message: string }

export type SkillScanInput = { sourceId: string }

export type SkillScanOutcome =
  | { ok: true; source: SkillSource; scan: ScanResult }
  | { ok: false; message: string }

export type SkillReadFileInput = { sourceId: string; skillId: string; path: string }

export type SkillReadFileResult =
  | { ok: true; path: string; content: string }
  | { ok: false; message: string }

export type SkillInstallInput = { sourceId: string; skillId: string; workspaceRoot: string }

export type SkillInstallOutcome =
  | { ok: true; dirName: string; harnesses: SkillHarness[]; paths: string[]; fileCount: number }
  | { ok: false; message: string }

/**
 * Uninstalling is by directory name, not by source: a skill installed from a
 * source that has since been removed is still a directory in the workspace, and
 * the user must still be able to take it back out.
 */
export type SkillUninstallInput = { workspaceRoot: string; dirName: string }

export type SkillUninstallOutcome =
  | { ok: true; dirName: string; removedPaths: string[] }
  | { ok: false; message: string }

/** The workspace whose installed copies get re-copied; null with no workspace open. */
export type SkillSyncSourceInput = {
  sourceId: string
  workspaceRoot: string | null
  /**
   * The MCP servers this machine has configured. Sent in because MCP settings
   * live in the renderer's store, not on disk in main: the sync rewrites the
   * ones this source installed and hands them back for the surface to apply
   * (backlog/2026-09-06-mcp-installs-carry-source-provenance.md). Omitted by a
   * caller that has none, which refreshes skills and nothing else.
   */
  mcpServers?: McpServerConfig[]
}

export type SkillSyncFailure = { skillId: string; message: string }

/**
 * What a sync did, in counts. What changed *inside* a skill is not derivable
 * here and is not guessed at: the repository's own commit history answers that,
 * which is why the surface links to it instead of rendering a diff.
 */
export type SkillSyncSourceOutcome =
  | {
      ok: true
      source: SkillSource
      scan: ScanResult
      /** Skills the refreshed scan holds that the cached one did not. */
      added: number
      /** Skills the cached scan held that the repository no longer does. */
      removed: number
      /** Installed skills re-copied from the refreshed scan. */
      refreshed: number
      /** Installed skills whose re-copy failed; the list still refreshed. */
      failures: SkillSyncFailure[]
      /**
       * The source-installed MCP servers as they now stand: `updated` is what
       * to write back, `changed` the ones whose declaration really moved, and
       * `missing` the ones this source no longer declares (their entries stay,
       * marked, and go on working).
       */
      mcpServers: { updated: McpServerConfig[]; changed: string[]; missing: string[] }
    }
  | { ok: false; message: string }

/**
 * Discover. Both calls answer with `{ results, rateLimit, degraded }` and no
 * ok flag: a failed or limited query is a stated condition on the same shape,
 * so a caller can never mistake it for "GitHub had no match".
 */
export type SkillSearchInput = { query: string }

export type SkillSearchOutcome = SkillDiscoveryResult<SkillSearchHit>

export type SkillPopularReposOutcome = SkillDiscoveryResult<SkillRepoHit>

// Plugins from sources (backlog/2026-09-05-plugin-sources.md). A source's
// plugins ride in its scan; these are the calls that read a linked plugin,
// install one into a workspace, take it out again, and list what is in.

export type SkillPluginScanLinkedInput = { sourceId: string; pluginId: string }

export type SkillPluginScanLinkedOutcome =
  | { ok: true; source: SkillSource; scan: ScanResult; plugin: ScannedPlugin }
  | { ok: false; message: string }

export type SkillPluginInstallInput = {
  sourceId: string
  pluginId: string
  workspaceRoot: string
  /** Required true when the plugin declares hooks — they run shell commands. */
  acknowledgedHooks?: boolean
}

export type SkillPluginInstallHarness = {
  harness: SkillHarness
  /** `skills` — skill directories copied; `nothing` — the plugin has nothing this harness reads. */
  mode: 'skills' | 'nothing'
  skillDirNames: string[]
  message: string
}

export type SkillPluginInstallOutcome =
  | {
      ok: true
      plugin: ScannedPlugin
      harnesses: SkillPluginInstallHarness[]
      /** MCP servers the plugin declares, shaped for the MCP settings store. */
      mcpServers: McpServerConfig[]
      /**
       * `name@marketplace` written into the workspace's Claude settings, '' when
       * none was. An extra for `claude plugin install`, never what delivered the
       * plugin — see src/main/skills/install-plugin.ts.
       */
      claudePluginKey: string
      warnings: string[]
    }
  | { ok: false; message: string; needsHookAcknowledgement?: boolean }

export type SkillPluginUninstallInput = { sourceId: string; pluginId: string; workspaceRoot: string }

export type SkillPluginUninstallOutcome =
  | {
      ok: true
      removedPaths: string[]
      disabledClaudePluginKey: string
      mcpServerIds: string[]
      /** The copies went; the Claude settings file refused its edit. */
      warnings: string[]
    }
  | { ok: false; message: string }

/** One installed plugin, as this app recorded it. */
export type InstalledPluginRecord = {
  workspaceRoot: string
  sourceId: string
  pluginId: string
  pluginName: string
  marketplaceName: string
  claudePluginKey: string
  skillDirNames: string[]
  mcpServerIds: string[]
  /** The commit the bytes were read at; '' for a registry plugin. */
  commitSha: string
  installedAt: string
}

export type SkillInstalledPluginsInput = { workspaceRoot: string }

export type SkillInstalledPluginsOutcome =
  | { ok: true; plugins: InstalledPluginRecord[] }
  | { ok: false; message: string }

/** One repository source, as the hourly update check saw it. */
export type SkillSourceUpdateEntry = {
  sourceId: string
  /** `owner/name`. */
  name: string
  headSha: string
  /** The head differs from the commit the source was scanned at. */
  changed: boolean
}

/**
 * What an update check found. `newlyChanged` is the drift THIS check
 * discovered (worth a toast); `changed` is every source currently behind its
 * head (what the rails mark). Broadcast on `skills:sources-updated`.
 */
export type SkillSourceUpdateCheck = {
  checkedAt: string
  sources: SkillSourceUpdateEntry[]
  changed: string[]
  newlyChanged: string[]
  failures: { sourceId: string; message: string }[]
}

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
  // Orthogonal Debug Mode toggle (the agent picker). Layers on top of the chosen
  // permission preset without changing its flags; the launch boundary prepends
  // the debug directive to the initial prompt when set. Transient per-spawn —
  // not persisted like cliPermissionPreset.
  debugMode?: boolean
  // Model id passed to the agent CLI when its plugin declares modelSelection;
  // undefined means the CLI's own default model.
  cliModel?: string
  // Reasoning-effort level passed to the agent CLI when its plugin declares
  // reasoningSelection; undefined means the CLI's own default effort, which
  // passes no flag. Travels with cliModel from the spawning surface.
  cliReasoning?: string
  memoryRootPath?: string
  memoryRelativeRoot?: string
  agentSession?: AgentSessionMetadata
  visible?: boolean
  mcpSettings?: McpSettings
  // True when `mcpSettings` is a connector launch's isolated single-server
  // config: the spawn prunes any other MCP server from the worktree config and
  // git-excludes it, whether or not the connector carries a driving skill.
  // Undefined/false for ordinary spawns (workspace MCP merges as usual).
  connectorLaunch?: boolean
  // Connector launches with a driving skill (e.g. Railway) name the builtin
  // skill to install into the worktree at spawn, so the seeded skill invocation
  // resolves to a present skill. Generalizes the debug-skill install;
  // best-effort at the launch boundary. Undefined for skill-less connector
  // launches and ordinary spawns. See TerminalSpawnPayload.
  connectorSkillId?: string
  // Skill-at-spawn for ordinary agents (the composer's "+ Skill" attachment):
  // ensure-installs the named builtin like connectorSkillId, but WITHOUT the
  // connector coupling (no MCP prune, no worktree .mcp.json exclude). The
  // invocation itself is prefilled renderer-side, never auto-sent.
  spawnSkillId?: string
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

/** Main's answer to a window's one-time registry hydration offer. */
export type WorkspaceRegistryHydrateResult = {
  changed: boolean
  reason: 'seeded' | 'already_present' | 'refused_dangerous_empty' | 'seeded_empty_intent'
  classification?: string
  seededWorkspaceCount?: number
  droppedRecordIds?: string[]
}

// Provenance for an AgentState. `hook` means the phase came from an
// authoritative lifecycle-hook frame; `inferred` means a lifecycle stamp —
// `starting` at spawn, `stalled` from the watchdog, `exited`/`failed` from the
// pty. Output-timing status inference was deleted (decision of record
// 2026-08-31): nothing ever guesses a phase from output recency.
export type AgentStateSource = 'hook' | 'lifecycle'

export type AgentState = {
  phase: AgentPhase
  since: number
  source: AgentStateSource
}

// The last prompt a person submitted to an agent session, captured from the
// CLI's `UserPromptSubmit` lifecycle hook. `text` is their verbatim typing,
// truncated to MAX_AGENT_PROMPT_LENGTH; `at` is when the hook reported it.
//
// Only CLIs whose reporter forwards the prompt supply this (Claude Code, Codex,
// Grok Build). A hookless or unsupported CLI simply never sets it, and every
// consumer treats absence as "nothing to show" rather than an error.
export type SessionPrompt = {
  text: string
  at: number
}

export type TerminalSessionSnapshot = {
  sessionId: string
  processAlive: boolean
  kind: TerminalKind
  pathStyle?: TerminalPathStyle
  workspaceId?: string
  agentId?: string
  // Display name from spawn metadata. The session-manager label for agent
  // sessions whose agentId has no workspace.agents record (e.g. the Design
  // Wizard's guided-brief-* specialists).
  agentName?: string
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
  // Where the session's own hooks last saw it, resolved through git into the
  // checkout containing that cwd (MC-2440). Distinct from the launch-intent
  // fields above (`cwd`, `worktreePath`): an agent that creates a worktree and
  // moves into it, or is launched by hand into one the app did not make, is
  // only describable here. Absent for plain terminals and for CLIs whose hooks
  // carry no cwd; `resolved: false` until git has answered.
  observedCheckout?: ObservedCheckout
  agentSession?: AgentSessionIdentity
  // Present only on sessions the main-process AgentLaunchService composed
  // (MC-2159): the launch decisions main made — name, CLI, model, permission
  // preset, specialist, connector environment. The renderer projects these into
  // an AgentState so a headless-launched agent gets a tab it never created, and
  // so a window opened after the launch sees the same agent the launch made.
  // Absent for renderer-launched agents (which already own their record) and
  // for plain terminals.
  agentRecord?: AgentLaunchRecord
  visible: boolean
  // Freeze-the-view: agent process killed to reclaim memory, scrollback kept
  // painted, resumable on keystroke. `processAlive` is false while suspended.
  suspended: boolean
  // User lock ("keep running"): the reaper never suspends or disposes this
  // session while set. Session-scoped — toggled from the terminal's lock
  // control; does not survive an app restart (the process it protects doesn't
  // either).
  reapExempt: boolean
  startedAt: number
  lastOutputAt: number | null
  lastInputAt: number | null
  lastVisibleAt: number | null
  // When the agent's last turn ended — the hook-reported Stop, epoch ms. Kept
  // apart from `activity`, which the reaper's suspend and the quit path
  // overwrite with the moment the PROCESS died, so a parked chat can say when
  // it actually finished. Survives suspend, resume and an app restart (carried
  // in the snapshot sidecar). Absent for plain terminals and before the first
  // turn end.
  lastTurnEndedAt?: number | null
  activity: SessionActivity
  // Authoritative phase from lifecycle hooks, when available. Absent for
  // sessions whose CLI emits no hooks (the legacy idle-timer `activity` above
  // remains the floor). `source` distinguishes hook truth from inference.
  agentState?: AgentState
  // The last prompt submitted to this session. Absent for plain terminals and
  // for CLIs whose reporter does not forward one.
  lastPrompt?: SessionPrompt
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
  // Reported process memory in bytes. Electron rows use Electron working set
  // (reported in KB and converted by main); spawned child rows use OS RSS. On
  // macOS neither should be treated as Activity Monitor physical footprint.
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
// processes). This is what actually predicts system exhaustion across every app.
// `availableBytes`/`utilizationRatio` are best-effort availability estimates;
// they are not the operating system's memory-pressure signal. `source` records
// how they were derived ('vm_stat' macOS, 'proc' linux, 'os' fallback).
export type SystemMemorySample = {
  totalBytes: number
  availableBytes: number
  usedBytes: number
  compressedBytes: number
  swapUsedBytes: number
  // 0..1 estimated utilization: 1 - available/total. On Darwin, available
  // includes free + speculative + inactive + purgeable pages, so usedBytes is
  // an estimated non-reclaimable amount rather than Activity Monitor "Memory
  // Used" and this ratio must never be labelled OS memory pressure.
  utilizationRatio: number
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

// A specialist id is a registry role id (MC-1587: specialists ship as an
// installable pack, so there is no fixed union of ids). Kept as a named alias
// so the many IPC-boundary import sites need no churn; mirrors
// `SpecialistActionId` in `src/shared/sprintengine/agent-state.ts`.
export type SpecialistActionId = string

export type SoulPromptResult =
  | { ok: true; prompt: string; path: string }
  | { ok: false; message: string; path: string | null }

export type GitFileStatus = 'new' | 'modified' | 'deleted' | 'renamed' | 'conflicted'

export type GitStatusEntry = {
  path: string
  relativePath: string
  status: GitFileStatus
  staged: boolean
  unstaged: boolean
}

/** A multi-step operation parked in the repo, awaiting continue or abort. */
export type GitRepoOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert'

export type GitResetMode = 'soft' | 'mixed' | 'hard'

export type GitStatusSnapshot = {
  repoRoot: string
  files: Record<string, GitStatusEntry>
  operation: GitRepoOperation | null
  updatedAt: number
}

/**
 * The sidebar row's one-line git story (remote-sessions-ux /
 * two-line-session-rows): branch + working-tree ±lines against HEAD. Quiet on
 * anything unreadable — a row simply shows no git facts.
 */
export type GitRowSummary = {
  branch: string | null
  additions: number
  deletions: number
}

/**
 * What a workspace's row reports as changed
 * (the-diff-an-agent-made / branch-scoped-row-diff).
 *
 * The numbers are the span `merge-base(HEAD, <default branch>) → working tree`
 * taken in the checkout the workspace's agents actually work in, so a pull, a
 * merge or a commit landing under the agent cannot inflate them.
 *
 * `scope` is load-bearing, not diagnostic — it says how much the UI is entitled
 * to claim, and the row's tooltip and spoken label are derived from it:
 * `worktree` (a linked worktree, exclusive to this chat), `branch` (a shared
 * checkout ahead of the default branch — the BRANCH's work, which may include a
 * person's commits), and `folder` (a shared checkout level with the default
 * branch, so only its uncommitted state can be reported).
 */
export type WorkspaceChangeSummary = {
  branch: string | null
  additions: number
  deletions: number
  changedFiles: number
  scope: 'worktree' | 'branch' | 'folder'
}

/**
 * One step in a branch's timeline: a commit
 * (the-diff-an-agent-made / changed-files-and-commit-steps).
 *
 * A step is a commit rather than a captured turn, so the timeline is the repo's
 * own history — it survives a restart, a re-clone and a machine change, and a
 * pull cannot invent one.
 */
export type BranchStep = {
  hash: string
  shortHash: string
  /** The commit subject. May be empty; never trusted to be one line. */
  subject: string
  /** Author date, epoch ms. Zero when git gave something unparseable. */
  authoredAt: number
  /**
   * More than one parent. A merge step still carries a diff — what it brought
   * into the branch — so the strip labels it rather than hiding it.
   */
  isMerge: boolean
}

export type BranchStepsSnapshot = {
  branch: string | null
  /** The merge-base the span measures from, or null when none resolves. */
  baseOid: string | null
  /** Same contract as WorkspaceChangeSummary['scope'] — how much may be claimed. */
  scope: 'worktree' | 'branch' | 'folder'
  /** Oldest first: the order the work happened in. */
  steps: BranchStep[]
  /** Whether the working tree carries anything at all, tracked or untracked. */
  hasUncommitted: boolean
}

/** Which slice of the branch a viewer is showing. */
export type BranchStepSelection =
  | { kind: 'span' }
  | { kind: 'uncommitted' }
  | { kind: 'commit'; hash: string }

export type BranchStepFile = {
  path: string
  status: 'new' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  /** Where a rename came from. Absent for every other status. */
  oldPath?: string
}

/** One side of a step's diff, read at a revision. */
export type RevFileResult =
  | { kind: 'content'; content: string }
  | { kind: 'absent' }
  | { kind: 'too-large' }

export type BranchStepDiff = {
  files: BranchStepFile[]
  additions: number
  deletions: number
}

export type GitStashEntry = {
  /** Git's selector for the entry, e.g. `stash@{0}`. */
  ref: string
  /** The stash commit hash — the entry's stable identity; selectors renumber. */
  hash: string
  index: number
  branch: string | null
  message: string
  createdAt: number
}

export type GitStashListSnapshot = {
  repoRoot: string
  stashes: GitStashEntry[]
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

export type GitHubRepoSummary = {
  fullName: string
  name: string
  owner: string
  isPrivate: boolean
  description: string | null
  cloneUrl: string
  defaultBranch: string | null
  pushedAt: string | null
}

export type GitHubRepoListResult =
  | { ok: true; repos: GitHubRepoSummary[] }
  | { ok: false; reason: 'no_token' | 'unauthorized' | 'network'; message: string }

export type GitHubCloneInput = {
  url: string
  parentDir: string
  folderName: string
}

export type GitHubCloneResult =
  | { ok: true; path: string }
  | { ok: false; message: string }

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
export type DiagnosticSource = 'auth' | 'automations' | 'cli' | 'filesystem' | 'git' | 'marketplace' | 'models' | 'sprintengine' | 'terminal' | 'update' | 'voice' | 'workspace'

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

// A logo found at the top level of a project's repo (MC-2135). `dataUrl` is the
// sanitized, downscaled image ready to render in an icon slot; `path` and
// `mtimeMs` are what the main process re-checks on the next open so a changed
// or deleted file is picked up without a watcher.
export type ProjectLogo = {
  path: string
  mtimeMs: number
  dataUrl: string
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

// One push from the boot-discovery pass to the splash window. `status` is a
// plain sentence naming the leg still in flight ("Finding your agents…"), never
// a percentage: the legs run concurrently and resolve out of order, so a
// percentage would be a promise the boot cannot keep. `progress` is 0..1 and
// drives only the hairline pinned to the splash's bottom edge, which advances on
// leg COMPLETION. Declared here rather than in src/main because the splash
// renderer and the preload both read it, and src/shared cannot import src/main.
export type SplashProgress = {
  status: string
  progress: number
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
  // `permanent` marks a failure no retry can heal — the run directory is gone
  // (archived or deleted) or the store predates the schema this build reads —
  // so pollers stop retrying instead of re-failing every tick.
  | { ok: false; message: string; permanent?: boolean }

export type SprintEngineRegistryRolesReadInput = {
  workspaceRoot: string
  includeShadowed?: boolean
}

export type SprintEngineRegistryRoleReadInput = {
  workspaceRoot: string
  roleId: string
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
  // review, needs_input, done, canceled). The backend rejects illegal
  // transitions, so the renderer only sends legal targets — today `in_progress`,
  // which reopens a reviewed/done task for rework under its original owner.
  status: string
}

// The resolved sprint source seed, mirroring the shape the Python handover
// command writes to run.yaml. App-created (reference-mode) runs pass this into
// init so the seed is persisted at t=0 and the Sprint Inbox shows an honest
// "Started from" before any agent runs handover.
export type SprintEngineStateInitializeSource = {
  kind: string
  origin: string
  path: string
  planKind?: string
  originalPath?: string
  capturedAt?: string
}

export type SprintEngineStateInitializeSourceBundleItem = {
  kind: string
  origin: string
  path: string
  originalPath?: string
  capturedAt?: string
  // This entry is one of the launched epic's child items (a unit of work the
  // planner mints one task for), not supporting reading material sharing the
  // bundle. See SprintEngineSourceBundleItem.epicChild.
  epicChild?: boolean
  // A directly-selected work item on a `selection` launch (MC-2060). See
  // SprintEngineSourceBundleItem.selectedItem.
  selectedItem?: boolean
}

export type SprintEngineStateInitializeInput = {
  statePath: string
  name: string
  goal: string
  agents: Record<string, unknown>
  tasks?: unknown[]
  events?: unknown[]
  artifacts?: unknown[]
  // The root source seed and its bundle, persisted into run.yaml at creation.
  // Set only for app-created reference-mode launches (backlog/plan-sourced); the
  // Guided Brief and CLI/headless paths seed the source through handover instead.
  source?: SprintEngineStateInitializeSource
  sourceBundle?: SprintEngineStateInitializeSourceBundleItem[]
  // How this run gets its task graph (MC-2128). `direct` imports it from the
  // source epic's child items at init — one task per open child, ordered by the
  // items' own `dependsOn`, with no planning agent and no plan-approval gate.
  // `planned` runs a planning agent behind the plan gate. Omit to let the engine
  // apply its per-source default: `direct` for an epic, `planned` for everything
  // else. Fixed at run creation.
  intake?: 'direct' | 'planned'
  // When true, Sprint Engine creates one shared git worktree + branch for the
  // whole team before any task runs, and all agents work and commit there.
  useWorktrees?: boolean
  // When true, every TASK also gets its own worktree branched off the run branch
  // and merged back at publish (MC-2130), instead of the whole run sharing one
  // checkout per project. Layered on `useWorktrees` — the engine rejects it
  // without run worktrees — and fixed at creation like every other vcs choice.
  // Omitted/false is the normal mode: one worktree per sprint (MC-2136).
  taskIsolation?: boolean
  // The OTHER projects this run also changes (MC-1613), beyond the workspace's own.
  // Each entry becomes one `--repo <id>=<root>` at init: its own worktree, branch,
  // commit lock, and pull request. `root` is relative to the workspace folder and
  // must be a separate git repository outside it; `id` is the short handle tasks
  // target ('primary' is reserved for the workspace's own project).
  //
  // Fixed at creation and immutable after, exactly like `useWorktrees` — every
  // task, lock, commit, and worktree resolves through this list for the life of
  // the run. Requires `useWorktrees`: a run can only span projects when each gets
  // its own worktree, and the engine rejects the combination otherwise. Omitted
  // (not `[]`) for a single-project run.
  repos?: Array<{ id: string; root: string }>
  // Commit-ish the primary repo's run worktree branches FROM, for chained sprints
  // whose local branch may be behind its remote (the chain action fetches first
  // and passes e.g. `origin/main`). Start point only: the stored `vcs.baseRef` —
  // and therefore the `gh pr create --base` value — stays the plain branch name.
  // Only meaningful alongside `useWorktrees`.
  baseStartPoint?: string
  // The roster's per-role CLI model selection, recorded into run state at init
  // so each claimed task can be stamped with the model that worked it. A role
  // with no explicit model (CLI default) is omitted / left null. `reasoning` is
  // the seat's reasoning-effort level (MC-1885), absent for the CLI's own default.
  roleRuntimes?: Record<string, { model?: string | null; cli?: string | null; reasoning?: string | null }>
  // The enabled role ids (architect always included) the user turned on for
  // this run. Written to run.yaml `configuredRoles` at init so Python knows
  // which roles the architect may seat under the lazy (architect-only) roster.
  enabledRoles?: string[]
  // The post-implementation phases every task inherits (MC-1542). Written to
  // run.yaml `defaultPhases` via `--default-phases-json`. It is the DEFAULT and
  // the CEILING: a task may trim its phases, never add one outside this set, so
  // "agents on this run don't review their own work" (`[]`) is an operator
  // guarantee. `undefined` leaves the key absent and the engine default
  // (`['review']`) applies; `[]` is a meaningful, recorded value.
  defaultPhases?: string[]
}

export type SprintEngineTaskWorktreeInput = {
  statePath: string
  taskId: string
}

export type SprintEngineTaskWorktreeResult = {
  ok: boolean
  /** Whether this run gives every task its own worktree at all. */
  isolated: boolean
  /** Project-root-relative path to the task's tree; null when there is none. */
  worktreePath: string | null
  message?: string
}

export type SprintEngineCliWatchPolling = 'enabled' | 'disabled'

export type SprintEngineRunnerSetInput = {
  statePath: string
  // Automation-mode hint recorded on the run. The CLI watch loop it once
  // configured is gone (MC-1827); Multicode reads it back to derive the run's
  // automation mode.
  cliWatchPolling: SprintEngineCliWatchPolling
}

// ── Sprint Engine automation intent (MC-1567: main-owned mode ownership) ────
// The authoritative three-state automation mode lives in a main-owned sidecar
// (`automation.json` beside `run.yaml`); the renderer subscribes and pushes
// writes through `sprintengine:automation:set-mode`. Record shape and revision
// semantics: src/shared/sprintengine/automation-intent.ts.

export type SprintEngineAutomationReadInput = {
  statePath: string
}

export type SprintEngineAutomationSetModeInput = {
  statePath: string
  mode: SprintEngineAutomationIntentMode
  // Per-window token echoed back on the broadcast so the pushing window can
  // recognize (and drop) its own echo — the broadcast is delivered before the
  // push's IPC response resolves, so a revision guard alone cannot.
  clientToken?: string
  reason?: string
  details?: string
  suppressManualAudit?: boolean
  workspaceId?: string
  workspaceName?: string
  taskId?: string
  agentId?: string
}

export type SprintEngineAutomationHydrateInput = {
  statePath: string
  mode: SprintEngineAutomationIntentMode
}

// MC-1799: the CLI permission preset is an engine-level control like the mode,
// so it is written by statePath and never by workspace id — the Sprints door
// mounts a run with no resident workspace and must still be able to set it.
export type SprintEngineCliPermissionPresetSetInput = {
  statePath: string
  preset: SprintEngineCliPermissionPreset
  /** Echoed on the broadcast so the pushing window drops its own echo. */
  clientToken?: string
}

export type SprintEngineAutomationReadResult =
  | { ok: true; record: SprintEngineAutomationIntentRecord | null }
  | { ok: false; message: string }

export type SprintEngineAutomationWriteResult =
  | { ok: true; record: SprintEngineAutomationIntentRecord; changed: boolean }
  | { ok: false; message: string }

/**
 * Acknowledgement of a launch-settings push: the authoritative record main now
 * holds (the pusher reconciles its revision floor against it) and whether the
 * push actually changed anything — an unchanged blob is not a new revision.
 */
export type SprintEngineLaunchSettingsWriteAck = {
  ok: true
  record: SprintEngineLaunchSettingsRecord
  changed: boolean
}

export type SprintEngineAutomationChangedEvent = {
  statePath: string
  record: SprintEngineAutomationIntentRecord
  // The clientToken of the write that produced this event, when the writer
  // supplied one (renderer pushes). Absent for mobile/system writers.
  sourceClientToken?: string
}

export type SprintEngineRosterRuntimeInput = {
  statePath: string
  /** Registry role id; the CLI canonicalizes it and rejects unknown/off-roster roles. */
  role: string
  /** CLI id, e.g. `claude-code`. Required — pass the role's current CLI when changing only the model. */
  cli: string
  /** Model id; null/absent pins the CLI's default model (launches with no --model flag). */
  model?: string | null
}

export type SprintEngineRosterEnableInput = {
  statePath: string
  /** Registry role id; the CLI canonicalizes it and rejects unknown roles. */
  role: string
  /** Optional CLI id to seed the role's runtime in the same write. */
  cli?: string | null
  /** Model id; only meaningful with `cli`. */
  model?: string | null
}

export type SessionUser = {
  id: string
  email: string | null
  displayName: string | null
  /**
   * The provider profile photo, ready to render: a `data:` URL served from the
   * main process's on-disk cache (MC-2220), never the provider's remote URL.
   * Null when the account has no photo or the bytes could not be fetched —
   * the renderer falls back to initials either way.
   */
  photoUrl: string | null
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
  | 'sprintengine.openPullRequest'
  | 'sprintengine.setAutomationMode'
  | 'automations.control'

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
  | 'sprintengines.pr'
  | 'sprintengines.automation'
  | 'automations.control'

export type MobileControlDevice = {
  protocolVersion: 2
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
  protocolVersion: 2
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
  // Enabled and configured, but deliberately not connected because no active paired
  // device (and no pending pairing challenge) can be listening; zero relay traffic.
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'retrying'
  | 'error'

// Current effective command-poll cadence, surfaced so Settings → Mobile can explain
// first-command latency. `paused` = not polling; `fast` = base interval; `decayed` =
// backed off toward the idle ceiling.
export type MobileBridgeCommandPollCadence = {
  intervalMs: number
  state: 'paused' | 'fast' | 'decayed'
}

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
  commandPollCadence: MobileBridgeCommandPollCadence
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

// Window chrome material: 'glass' renders the window canvas (sidebar, title
// strip, aside column) over OS-native vibrancy; 'solid' is the opaque default.
// macOS-only for now — main ignores 'glass' on other platforms.
export type WindowMaterial = 'solid' | 'glass'
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
    // The one task inside the target that owns this item, when the target is a
    // run and the item is one of its epic children (MC-2017).
    taskId?: string
  }
  // `pending` is recorded-but-not-started: the link exists so the item shows its
  // sprint, but it does not drive the item to `in_progress` yet.
  status?: 'pending' | 'active' | 'completed' | 'canceled' | 'failed' | 'unknown'
  // The item status to restore if this link's work is abandoned. Written when an
  // epic-child link is created and consumed when the run or its task is canceled.
  priorStatus?: BacklogItemStatusPayload
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

// Review change-set ingestion transport (MC-1676). Mirrors ReviewSource minus
// derived fields: the renderer supplies the raw source, the main service
// normalizes it into a ReviewChangeSet. The pull-request arm is typed here but its
// provider is unregistered until MC-1678, so it fails with a clear message.
export type ReviewSourceInput =
  | { kind: 'branch'; repoRoot: string; baseRef: string; headRef: string }
  | { kind: 'patch'; text: string; label?: string }
  | { kind: 'pull-request'; url: string }

// Cheap live probe returned by review:detect-source; never a thrown error.
export interface ReviewSourceProbe {
  ok: boolean
  title?: string
  stats?: { files: number; additions: number; deletions: number }
  headSha?: string
  error?: string
}

// Identifies where a workspace's change set is persisted; the main service owns
// the `.multi-code/review/<workspaceId>/` path layout, so callers pass identity
// rather than constructing paths.
export interface ReviewTarget {
  workspaceRoot: string
  workspaceId: string
}

export type ReviewIngestResult =
  | { ok: true; changeset: ReviewChangeSet }
  | { ok: false; error: string }

export type ReviewChangeSetReadResult =
  | { ok: true; changeset: ReviewChangeSet | null }
  | { ok: false; error: string }

// Reading the guide's walkthrough (MC-1679/MC-1680). `brief: null` means the
// guide has not run for this workspace yet (render the prepare state); an invalid
// on-disk brief comes back as `ok: false` with path-qualified errors so the
// surface shows a failure, never a blank pane.
export type ReviewBriefReadResult =
  | { ok: true; brief: ReviewBrief | null }
  | { ok: false; error: string }

export type ReviewBriefRunDepth = 'brief' | 'standard' | 'thorough'

export interface ReviewBriefRunInput {
  workspaceId: string
  workspaceRoot: string
  // The project's Reviews-host workspace, which hosts the guide's terminal
  // (MC-1911). The renderer resolves-or-creates it and passes it here, so main
  // never has to wait for its workspace-sync snapshot to catch up. Omitted, main
  // looks for an existing host on the project root and falls back to the
  // project's own workspace.
  hostWorkspaceId?: string
  depth: ReviewBriefRunDepth
  // A freshness re-run (MC-1682): the ids of the steps whose files changed since
  // the previous walkthrough. When present and a previous walkthrough exists, the
  // run is incremental — unaffected steps keep their ids verbatim. Absent = full.
  affectedStepIds?: string[]
  // Replace a run that is already in flight (MC-1784). Without it a start against
  // a live run joins: the result reports that run instead of interrupting it, so
  // a remount or a second Prepare never throws away work in progress. The
  // freshness re-run sets it, because its point is to rebuild against the new head.
  restart?: boolean
  // Which agent CLI (and model) runs the guide (MC-1783). The guide is an
  // ordinary terminal agent, so this is the reviewer's pick — any installed CLI.
  // Omitted falls back to the CLI a live guide terminal is already running, then
  // to the last agent CLI used in that project; with nothing to go on the start
  // fails visibly rather than guessing an engine.
  cli?: string
  cliModel?: string
}

// Where a review's guide terminal lives, so a caller can show or focus it. The
// agent id is stable per review (`review-guide-<reviewId>`) and is what a tab
// reattaches by. The session id is minted per spawn and is a UUID: a
// Claude-harness CLI is launched with `--session-id <it>` and rejects any other
// shape, which is why the two are no longer the same string.
export interface ReviewGuideTerminal {
  workspaceId: string
  agentId: string
  sessionId: string
  cli: string
}

// Freshness probe (MC-1682): rebuild the current change set WITHOUT persisting it,
// so the panel can compare its head sha + per-file diffs against the walkthrough
// it already shows. Never overwrites the on-disk change set the current brief
// walks; a patch source has no upstream so the panel never probes it.
export type ReviewProbeResult =
  | { ok: true; changeset: ReviewChangeSet }
  | { ok: false; error: string }

// Honest run progress the panel renders. `reading` loads the change set,
// `grouping` is the guide generating, `annotating` validates the produced brief,
// `writing` persists, and `done`/`failed` are terminal.
export type ReviewBriefRunPhase = 'reading' | 'grouping' | 'annotating' | 'writing' | 'done' | 'failed'

export interface ReviewBriefRunEvent {
  workspaceId: string
  phase: ReviewBriefRunPhase
  detail?: string
}

// The guide run as the main process records it (MC-1784), so run state outlives
// the renderer: navigating away from a review and back re-reads it instead of
// showing "no run". A terminal phase is retained with `running: false` until the
// next start, so a remount can still explain why the last run failed.
export interface ReviewGuideRunStatus {
  running: boolean
  phase: ReviewBriefRunPhase
  detail?: string
  startedAt: string
}

// Result of starting the guide (MC-1783). `ok` means its terminal has the
// prompt, NOT that a walkthrough exists: the guide is an agent working in a
// terminal, and the brief arrives later as a `done` phase event. `joined: true`
// means a run was already in flight and this start reported it instead of
// replacing it. `reason: 'validation'` is retained for a producer that rejects
// its own output before writing; the terminal guide's failures are all
// `guide-error` (the brief validators now run inside review_submit_brief, which
// answers the guide, not the panel).
export type ReviewBriefRunResult =
  | { ok: true; joined?: false; status?: undefined; guide?: ReviewGuideTerminal }
  | { ok: true; joined: true; status: ReviewGuideRunStatus; guide?: ReviewGuideTerminal }
  | { ok: false; reason: 'validation' | 'guide-error'; errors: string[] }

// "Ask the guide": one question sent to the review's guide terminal, which is
// started if none is live. The answer is not in the result — the reviewer reads
// it in that terminal, which is the point of the redesign; this reports only
// whether the question was delivered and which terminal to focus, so a guide
// that could not start surfaces as a visible error rather than a silent no-op.
// The guide answers questions; it never creates or edits a review comment.
export interface ReviewAskGuideInput {
  workspaceId: string
  workspaceRoot: string
  // The Reviews-host workspace for the guide's terminal; see ReviewBriefRunInput.
  hostWorkspaceId?: string
  message: string
  // Same fallback chain as ReviewBriefRunInput when omitted.
  cli?: string
  cliModel?: string
}

export type ReviewAskGuideResult =
  | { ok: true; guide?: ReviewGuideTerminal }
  | { ok: false; error: string }

// Posting the pending review to the pull request (MC-1683). An explicit,
// human-initiated, batched action: the reviewer's pending comments post as ONE
// GitHub review (event COMMENT) under their own account. The renderer sends the
// workspace's PR change-set target plus the comments to post; the main process
// re-reads the persisted change set for the PR coordinates and current head,
// re-anchors as needed, and returns a per-comment outcome the panel applies.
export interface ReviewPostReviewInput {
  target: ReviewTarget
  comments: ReviewComment[]
}

// One comment's result. `sync` is the new sync state to flip the comment to;
// `anchorStatus: 'moved'` marks a comment held for re-review because its line
// could not be anchored on the PR's current head (never posted to a guessed line).
export interface ReviewCommentPostOutcome {
  id: string
  sync: CommentSync
  anchorStatus?: 'moved'
}

// `ok: false` is a whole-batch failure (not a pull request, unreadable change set,
// or an auth/transport error carrying the same actionable copy as the read path) —
// nothing was posted. `ok: true` carries the created review URL (absent when every
// comment was held) and the per-comment outcomes; GitHub's create-review is atomic,
// so a mixed result is comments held locally, never a partially-created review.
export type ReviewPostReviewResult =
  | { ok: true; reviewUrl?: string; outcomes: ReviewCommentPostOutcome[] }
  | { ok: false; error: string }

// Reviewer state persistence (MC-1708). The human's mutable review progress moved
// off the retired `review` workspace's `Workspace.reviewState` store field onto
// disk beside the change set (`<reviewDir>/state.json`), keyed by review id so it
// is reachable without any workspace. `state: null` means the reviewer has not
// started this review yet; an invalid on-disk state comes back as `ok: false` so a
// corrupted file surfaces instead of silently resetting comments/read progress.
export type ReviewStateReadResult =
  | { ok: true; state: ReviewWorkspaceState | null }
  | { ok: false; error: string }

export type ReviewStateWriteResult = { ok: true } | { ok: false; error: string }

// One review in the instance-level index (MC-1708). The Reviews surface enumerates
// every review across the known project roots (scanning `.multi-code/review/`),
// independent of the retired workspace type. Each entry carries the identity the
// rail shows (project, title, source) plus the state-line inputs (walkthrough
// presence + step count, files read vs total, pending/posted comment counts).
export interface ReviewIndexEntry {
  reviewId: string
  workspaceRoot: string
  projectName: string
  title: string
  sourceKind: ReviewSourceKind
  fetchedAt: string
  fileCount: number
  hasWalkthrough: boolean
  stepCount: number
  readFileCount: number
  pendingComments: number
  postedComments: number
}

export type ReviewListResult =
  | { ok: true; reviews: ReviewIndexEntry[] }
  | { ok: false; error: string }

// PR-project inference (MC-1787). Given a pasted pull-request URL and the caller's
// known open project roots, `matches` is exactly the roots whose git remote points
// at the same repository (host + owner/repo, case-insensitive; ssh and https forms).
// Zero matches is a valid answer, not an error — the form still creates the review,
// with the reviewer picking a project. `matches` is always a subset of the roots the
// caller supplied, so the result never carries a git remote URL or any path the
// caller did not already hold.
export type ReviewMatchPrProjectResult =
  | { ok: true; matches: string[] }
  | { ok: false; error: string }

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

export type BacklogRemoveLinkInput = {
  workspaceRoot: string
  relativePath: string
  linkId: string
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

// The epic-side ordering mark (MC-2137): the author asserting that this epic's
// children are ordered — deliberately parallel counts — so a sprint may start
// from it with no planning agent. `true` writes `dependenciesPlanned: true`;
// `false` removes the line, since absent is the same assertion as false.
export type BacklogDependenciesPlannedInput = {
  workspaceRoot: string
  relativePath: string
  dependenciesPlanned: boolean
}

// Mockup attachments are the item-side write: `mockups` is the list of
// project-relative mockup paths, serialized to the single comma-separated
// `mockups:` frontmatter line (mirrors `dependsOn`). An empty list or null clears
// the line. Body-prose references stay derived (see backlogMockups.ts), never
// written back here.
export type BacklogMockupsInput = {
  workspaceRoot: string
  relativePath: string
  mockups: string[] | null
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
  // The embedded browser (browser-pane epic, src/shared/browser.ts). The
  // renderer mounts the `<webview>` and registers its WebContents id; main
  // drives it and pushes `onBrowserState` for every registered tab.
  browserConfig: () => Promise<BrowserConfig>
  browserRegister: (input: BrowserRegisterInput) => Promise<BrowserRegisterResult>
  browserUnregister: (tabId: string) => Promise<void>
  browserState: (tabId: string) => Promise<BrowserTabState | null>
  browserNavigate: (tabId: string, url: string) => Promise<boolean>
  browserBack: (tabId: string) => Promise<boolean>
  browserForward: (tabId: string) => Promise<boolean>
  browserReload: (tabId: string, ignoreCache?: boolean) => Promise<boolean>
  browserStop: (tabId: string) => Promise<boolean>
  browserOpenExternal: (tabId: string) => Promise<{ ok: true } | { ok: false; message: string }>
  browserZoomStep: (tabId: string, direction: 1 | -1 | 0) => Promise<boolean>
  browserSetColorScheme: (tabId: string, scheme: BrowserColorScheme) => Promise<boolean>
  browserOpenDevTools: (tabId: string) => Promise<boolean>
  browserOpenWindow: (tabId: string) => Promise<boolean>
  browserClearCookies: () => Promise<BrowserClearResult>
  browserClearCache: () => Promise<BrowserClearResult>
  browserCapture: (input: BrowserCaptureInput) => Promise<BrowserScreenshotResult>
  browserCopyScreenshot: (tabId: string) => Promise<BrowserClearResult>
  browserLocalServers: (workspaceId: string) => Promise<LocalServer[]>
  /** Tell main which tab the person is looking at in a workspace's pane (agent tools target it). */
  browserNoteActive: (workspaceId: string, tabId: string | null) => Promise<void>
  /** An agent asked for a URL in this workspace's pane (browser.open); the renderer opens or navigates a tab. */
  onBrowserOpenRequest: (cb: (payload: { workspaceId: string; url: string | null; tabId: string | null }) => void) => () => void
  /** The agent's pointer is about to act at a point in a tab's viewport (the cursor overlay). */
  onBrowserPointer: (cb: (event: BrowserPointerEvent) => void) => () => void
  /** An agent asked for a device viewport on a tab (browser.resize); the renderer owns viewport state. */
  onBrowserViewportRequest: (cb: (payload: { tabId: string; viewport: BrowserViewport }) => void) => () => void
  onBrowserState: (cb: (state: BrowserTabState) => void) => () => void
  onBrowserFocusUrl: (cb: (payload: { tabId: string }) => void) => () => void
  onBrowserHostKey: (cb: (payload: { tabId: string; key: BrowserHostKey }) => void) => () => void
  // Splash boot handshake. `onSplashProgress` is consumed only by the standalone
  // splash renderer; `notifyBootComplete` is sent once by the primary workspace
  // window when its first frame is on screen, and is what closes the splash and
  // reveals the main window (main also holds a hard timeout, so a renderer that
  // never gets there cannot strand a hidden main window).
  onSplashProgress: (cb: (update: SplashProgress) => void) => () => void
  notifyBootComplete: () => void
  // Boot measurement (MC-2075), off unless asked for. The flag is resolved in
  // preload from the same environment main reads, so the renderer never reports
  // marks into a main process that is not collecting them. A mark is an epoch
  // millisecond because the two processes have different `performance.now()`
  // origins — see src/shared/startup-timeline.ts.
  startupTimelineEnabled: boolean
  reportStartupMark: (id: string, atEpochMs: number) => void
  // Build identity (MC-2182). Every window reports the commit its bundle was
  // built from; main compares it against its own and says so once when the two
  // halves have diverged — see src/shared/build-stamp.ts.
  reportBuildStamp: (stamp: BuildStamp) => void
  workspaceSyncDispatch: (command: WorkspaceSyncCommand) => Promise<WorkspaceSyncCommandResult>
  workspaceSyncGetSnapshot: () => Promise<WorkspaceSyncSnapshot>
  workspaceSyncGetEventsAfter: (sequence: number) => Promise<WorkspaceSyncEvent[]>
  /**
   * True while main has never written a workspace registry (MC-2158) — the
   * first boot after the inversion, or a fresh install. A window answers it by
   * offering its post-migrate-ladder localStorage state to
   * `workspaceRegistryHydrate`; false means main is authoritative and the
   * window mirrors instead.
   */
  workspaceRegistryNeedsHydration: () => Promise<boolean>
  workspaceRegistryHydrate: (payload: unknown) => Promise<WorkspaceRegistryHydrateResult>
  onWorkspaceSyncEvent: (cb: (event: WorkspaceSyncEvent) => void) => () => void
  automationGetStatus: () => Promise<AutomationServerStatus>
  automationSetEnabled: (enabled: boolean) => Promise<AutomationServerStatus>
  // Tailnet remote control (MC-2162): the opt-in listener that serves the same
  // gateway surface to paired devices on the Tailscale network. Configuration
  // only — it never carries a tool call, and no MCP tool can reach it, so an
  // agent cannot pair a device or widen its own reach.
  tailnetGetStatus: () => Promise<TailnetRemoteStatus>
  tailnetSetEnabled: (enabled: boolean) => Promise<TailnetRemoteStatus>
  /** Mint a one-time pairing code. The token comes back once and is never re-readable. */
  tailnetOfferPairing: (scopes?: TailnetScope[]) => Promise<TailnetPairingOfferView>
  tailnetCancelPairing: () => Promise<TailnetRemoteStatus>
  tailnetRevokeDevice: (deviceId: string) => Promise<TailnetRemoteStatus>
  /**
   * Answer a pairing request from another machine (MC-2233). The scopes are the
   * ones chosen here, and this is the only surface that can grant the terminal
   * tier to a person rather than to an agent on the local socket.
   */
  tailnetApprovePairRequest: (id: string, scopes: TailnetScope[], code: string) => Promise<TailnetApprovePairRequestView>
  tailnetDenyPairRequest: (id: string) => Promise<TailnetRemoteStatus>
  /** Whether pairing and reachability events raise OS notifications (phase 3). Persisted beside the listener setting. */
  tailnetSetNotifications: (enabled: boolean) => Promise<TailnetRemoteStatus>
  /**
   * Main asks the chrome to open the Remote popover — the click on an OS
   * notification about a pair request or a machine's answer lands here.
   */
  onRemoteOpenRequested: (cb: () => void) => () => void
  /**
   * Machines on this tailnet, and which of them answer as a Studio (MC-2163).
   *
   * A read of the local Tailscale daemon plus a probe of each peer's public
   * health endpoint. Works with this machine's own listener off: finding
   * somewhere to connect to is independent of being connectable.
   */
  tailnetListPeers: () => Promise<TailnetPeerScan>
  /**
   * Live connections behind the push channel (remote-sessions-ux): which
   * devices hold a socket right now and which terminals they are attached to.
   * Read once as the initial snapshot; every `onTailnetEvent` payload carries
   * a fresher one.
   */
  tailnetGetLiveState: () => Promise<TailnetLiveState>
  /**
   * Subscribe to tailnet changes pushed from main — listener up/down, pair
   * requests arriving or resolving, devices connecting, terminal drive
   * begin/end. Returns the unsubscribe.
   */
  onTailnetEvent: (cb: (payload: TailnetPushPayload) => void) => () => void
  // The Fleet (MC-2167): the machines this Studio is paired WITH, and the panes
  // it mounts from them. Main owns the device tokens and every outbound socket —
  // the listener refuses any request carrying an `Origin`, which a renderer
  // always sends, so this is the only route a window has.
  fleetListConnections: () => Promise<FleetConnection[]>
  /** Redeem a pairing link from another machine's Settings → Remote. */
  fleetPair: (pairingUrl: string) => Promise<FleetPairResult>
  /**
   * Ask a machine to pair, for someone there to approve (MC-2233), then poll it.
   * Main holds the collect secret, so a window can neither dial the peer nor
   * take the token the approval mints.
   */
  fleetRequestPairing: (
    endpoint: string,
    options?: { reverseScopes?: TailnetScope[] }
  ) => Promise<FleetRequestPairingResult>
  fleetCollectPairing: (requestId: string) => Promise<FleetCollectPairingResult>
  fleetCancelPairing: (requestId: string) => Promise<void>
  /** Re-check whether one paired machine (or every one, with no id) answers right now (phase 4). */
  fleetCheckReachability: (connectionId?: string) => Promise<FleetLiveState>
  /** Drop this machine's credential for a peer. Revoking the device THERE is the other half. */
  fleetForget: (connectionId: string) => Promise<FleetConnection[]>
  /** One machine's workspaces and terminals, with anything this pairing may not read named as a gap. */
  fleetBrowse: (connectionId: string) => Promise<FleetBrowse>
  fleetListRuns: (
    connectionId: string,
    workspaceId: string
  ) => Promise<{ ok: true; runs: FleetRun[] } | { ok: false; code: string; message: string }>
  /** Open a terminal on the remote machine and get the session id to attach to. */
  fleetCreateTerminal: (input: {
    connectionId: string
    workspaceId?: string
    name?: string
    /** Launch identity, forwarded verbatim; the remote gateway validates (and refuses bypass). */
    cli?: string
    prompt?: string
    cliModel?: string
    permissionPreset?: string
    /**
     * Where the chat runs there (checkout-and-branch-on-remote-create): the
     * workspace's current checkout, or a fresh worktree branched from
     * `baseRef`. The current checkout when absent.
     */
    checkout?: FleetCheckoutRequest
  }) => Promise<FleetCreateTerminalResult>
  /** A remote workspace's checkout facts — branch, trunk, branches, worktrees — for the launch panel's checkout · branch segments. */
  fleetWorkspaceCheckout: (connectionId: string, workspaceId: string) => Promise<FleetWorkspaceCheckoutResult>
  /**
   * Attach a pane to a remote session. Subscribe with `onFleetTerminalEvent`
   * on the same `attachId` FIRST — the replay is the first thing that arrives.
   */
  fleetAttachTerminal: (input: {
    attachId: string
    connectionId: string
    sessionId: string
  }) => Promise<FleetAttachResult>
  fleetDetachTerminal: (attachId: string) => Promise<void>
  fleetTerminalInput: (attachId: string, data: string) => void
  fleetTerminalResize: (attachId: string, cols: number, rows: number) => void
  onFleetTerminalEvent: (attachId: string, cb: (event: FleetTerminalEvent) => void) => () => void
  /**
   * Every attachment main holds right now with its link state — the initial
   * read behind `onFleetEvent`, carrying the same revision the events do.
   */
  fleetGetLiveState: () => Promise<FleetLiveState>
  /**
   * Whole-app fleet lifecycle (remote-sessions-ux): a machine paired or
   * forgotten, an attachment's link state changing — broadcast to every
   * window, credential-free. Returns the unsubscribe.
   */
  onFleetEvent: (cb: (event: FleetEvent) => void) => () => void
  // Automations platform (per-project scheduled agent automations). The renderer
  // reads/writes only through these channels; the engine owns the on-disk store.
  listAutomations: (input: AutomationsWorkspaceInput) => Promise<AutomationsListResult>
  /**
   * Instance-wide automation index: every automation across every known project
   * root with live rail state (status, last-run outcome/time, running-now). The
   * full-page Automations surface reads this instead of one host folder's list.
   */
  listInstanceAutomations: () => Promise<AutomationsInstanceListResult>
  /**
   * The five automations that ship inside the app (Extensions drawer ruling,
   * 2026-09-05). Read, never imported: main decides what is built in, so the
   * Automations surface's "Built in" group asks rather than holding its own copy.
   */
  listBuiltinAutomations: () => Promise<AutomationsBuiltinListResult>
  /**
   * Writes a built-in's definition into a project — the same catalogue write the
   * marketplace shelf's Get used, keyed on the built-in's stable id, so adding
   * one twice reports the copy the project already has instead of duplicating it.
   */
  addBuiltinAutomation: (input: AutomationsBuiltinInstallInput) => Promise<AutomationsBuiltinInstallResult>
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
  /** Fires after any automation-definition write (user IPC or module service); panels reload their list. */
  onAutomationsDefinitionsChanged: (cb: (event: AutomationsDefinitionsChangedEvent) => void) => () => void
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
  onAuthStateChanged: (cb: (state: MulticodeAuthState) => void) => () => void
  onAuthCallbackError: (cb: (message: string) => void) => () => void
  mobileBridgeGetState: () => Promise<MobileBridgeState>
  mobileBridgeUpdateSettings: (input: MobileBridgeSettingsUpdate) => Promise<MobileBridgeState>
  mobileBridgeRequestPairingCode: () => Promise<MobileBridgePairingChallenge>
  mobileBridgeListDevices: () => Promise<MobileControlDevice[]>
  mobileBridgeRevokeDevice: (deviceId: string, reason?: string) => Promise<MobileControlDevice>
  mobileBridgePublishPresence: (presence: MobileBridgePresence) => Promise<MobileBridgeState>
  mobileBridgeGetDiagnostics: () => Promise<MobileBridgeDiagnosticEntry[]>
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
  detectProjectLogo: (folderPath: string) => Promise<ProjectLogo | null>
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
  /**
   * The app's own plugin: what this build ships against what the open workspace
   * holds. Read-only — the built-in plugin has no Install and no Remove.
   */
  studioPluginStatus: (input: { workspaceRoot: string | null }) => Promise<StudioPluginStatus>
  pluginsList: () => Promise<PluginRegistryListResult>
  pluginsDetectAvailability: (input?: PluginDetectAvailabilityInput) => Promise<PluginAvailabilityResult>
  agentLaunchPreview: (input: AgentLaunchPreviewInput) => Promise<AgentLaunchPreviewResult>
  readMarketplaceRegistry: (input?: MarketplaceRegistryReadInput) => Promise<MarketplaceRegistryReadResult>
  // The hosted model feed (src/shared/hosted-model-feed.ts). `get` is the disk
  // copy with no network; `refresh` may fetch (the client's TTL decides unless
  // forced); `changed` fires after any read that replaced the feed.
  hostedModelFeedGet: () => Promise<HostedModelFeedReadResult>
  hostedModelFeedRefresh: (input?: Pick<HostedModelFeedReadInput, 'forceRefresh'>) => Promise<HostedModelFeedReadResult>
  onHostedModelFeedChanged: (cb: (result: HostedModelFeedReadResult) => void) => () => void
  // The hosted card feed (src/shared/hosted-card-feed.ts), the model feed's
  // sibling. `get` is the disk copy with no network — the first-paint path;
  // `refresh` may fetch (the client's TTL decides unless forced); `changed`
  // fires after any read that replaced the feed, and only then.
  hostedCardFeedGet: () => Promise<HostedCardFeedReadResult>
  hostedCardFeedRefresh: (input?: Pick<HostedCardFeedReadInput, 'forceRefresh'>) => Promise<HostedCardFeedReadResult>
  onHostedCardFeedChanged: (cb: (result: HostedCardFeedReadResult) => void) => () => void
  // CLI version advisories: installed version against the package registry's
  // newest. `set-enabled` mirrors the Settings switch into main so the
  // background check can be turned off; `changed` fires from the poller.
  cliVersionAdvisories: (input?: CliVersionAdvisoriesInput) => Promise<CliVersionAdvisoriesResult>
  cliVersionChecksSetEnabled: (enabled: boolean) => Promise<{ enabled: boolean }>
  onCliVersionAdvisoriesChanged: (cb: (result: CliVersionAdvisoriesResult) => void) => () => void
  installPluginFolder: (srcDir: string) => Promise<PluginInstallResult>
  verifyMarketplacePlugin: (entry: MarketplacePluginEntry) => Promise<MarketplacePluginVerifyResult>
  installMarketplacePluginFolder: (input: MarketplacePluginInstallInput) => Promise<MarketplacePluginInstallResult>
  installMarketplacePluginFromRegistry: (input: MarketplacePluginRegistryInstallInput) => Promise<MarketplacePluginRegistryInstallResult>
  updateMarketplacePluginFromRegistry: (input: MarketplacePluginRegistryInstallInput) => Promise<MarketplacePluginRegistryInstallResult>
  uninstallMarketplacePlugin: (input: MarketplacePluginUninstallInput) => Promise<MarketplacePluginUninstallResult>
  readMarketplacePluginUpdateStates: (input?: MarketplaceRegistryReadInput) => Promise<MarketplaceUpdateStatesResult>
  reloadPlugins: () => Promise<PluginRegistryListResult>
  conversationProvidersList: (input?: ConversationProvidersListInput) => Promise<ConversationProviderListResult>
  conversationProviderModels: (input: ConversationProviderModelsInput) => Promise<ConversationProviderModelsResult>
  conversationProviderTest: (input: ConversationProviderTestInput) => Promise<ConversationProviderTestResult>
  conversationSecretStatus: (input: ConversationSecretStatusInput) => Promise<ConversationSecretStatusResult>
  conversationSecretSet: (input: ConversationSecretSetInput) => Promise<ConversationSecretSetResult>
  conversationSecretClear: (input: ConversationSecretClearInput) => Promise<ConversationSecretClearResult>
  credentialSecretStatus: (input: CredentialSecretStatusInput) => Promise<CredentialSecretStatusResult>
  credentialSecretSet: (input: CredentialSecretSetInput) => Promise<CredentialSecretSetResult>
  credentialSecretClear: (input: CredentialSecretClearInput) => Promise<CredentialSecretClearResult>
  conversationSessionStart: (input: ConversationStartSessionInput) => Promise<ConversationStartSessionResult>
  conversationSessionSendTurn: (input: ConversationSendTurnInput) => Promise<ConversationSessionActionResult>
  conversationSessionInterrupt: (input: ConversationInterruptInput) => Promise<ConversationSessionActionResult>
  conversationSessionRespondToRequest: (
    input: ConversationRespondToRequestInput
  ) => Promise<ConversationSessionActionResult>
  // Live tool-permission switch on a running conversation session (takes effect
  // on the agent's next tool call).
  conversationSessionSetPermission: (
    input: ConversationSetPermissionInput
  ) => Promise<ConversationSessionActionResult>
  conversationSessionStop: (input: ConversationStopSessionInput) => Promise<ConversationSessionActionResult>
  conversationSessionsList: (input?: ConversationListSessionsInput) => Promise<ConversationListSessionsResult>
  conversationTranscript: (input: ConversationTranscriptInput) => Promise<ConversationTranscriptResult>
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
  writefile: (path: string, content: string) => Promise<void>
  writeBinaryFile: (path: string, base64Content: string) => Promise<void>
  /**
   * Save one pasted/dropped image that exists only as bytes (a clipboard
   * screenshot, an image dragged out of a browser) into the app's temp images
   * folder, returning the absolute path an agent can read. An image dropped
   * from the OS already has a path and never comes through here.
   */
  saveDroppedImage: (input: { mediaType: string; dataBase64: string }) => Promise<string>
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
  listFolderOpenTargets: () => Promise<FolderOpenTargetAvailability[]>
  openFolderInTarget: (request: FolderOpenRequest) => Promise<FolderOpenResult>
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
  // What this machine actually has: probed `git`/`gh` versions plus gh's own
  // auth login. Read-only and argument-free — see src/shared/version-control.ts.
  probeVersionControlProviders: () => Promise<VersionControlProviderProbe[]>
  getGitRepoRoot: (folderPath: string) => Promise<string | null>
  getGitStatus: (repoRoot: string) => Promise<GitStatusSnapshot>
  getGitRowSummary: (repoRoot: string) => Promise<GitRowSummary>
  /**
   * The branch reading for one checkout — the worktree the workspace's agents
   * run in when it has one, else its folder. Resolved by the caller, because
   * only the renderer holds the workspace's worktree record.
   */
  getWorkspaceChangeSummary: (checkoutPath: string) => Promise<WorkspaceChangeSummary>
  /**
   * The branch's commits as steps, oldest first, for the changed-files surface.
   * Read live on every call — a rebase re-identifies commits, so a cached strip
   * would be confidently wrong about work that no longer exists.
   */
  getBranchSteps: (checkoutPath: string) => Promise<BranchStepsSnapshot>
  /** The files and line counts for one step, or for the whole span. */
  getBranchStepDiff: (
    checkoutPath: string,
    selection: BranchStepSelection
  ) => Promise<BranchStepDiff>
  /**
   * A file's content at a revision, for one side of a step's diff. `absent` is
   * the correct original side for an addition and modified side for a deletion —
   * and also what a rejected rev or an out-of-repo path resolves to, so a caller
   * renders an empty pane rather than an error.
   */
  getGitFileAtRev: (repoRoot: string, rev: string, filePath: string) => Promise<RevFileResult>
  getGitFileBase: (repoRoot: string, filePath: string) => Promise<GitFileBaseResult>
  getGitFileAtStage: (repoRoot: string, filePath: string, stage: GitFileStage) => Promise<GitFileStageResult>
  getGitBranches: (repoRoot: string) => Promise<GitBranchSnapshot>
  /**
   * Which repository a folder is a clone of — its primary remote, normalised
   * (one-project-across-machines). Null for a non-repo or a remote-less one.
   */
  getGitRepositoryIdentity: (folderPath: string) => Promise<RepositoryIdentity | null>
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
  rebaseGitBranch: (repoRoot: string, ontoRef: string) => Promise<GitCommandResult>
  cherryPickGitCommit: (repoRoot: string, commitHash: string) => Promise<GitCommandResult>
  revertGitCommit: (repoRoot: string, commitHash: string) => Promise<GitCommandResult>
  resetGitBranchToCommit: (repoRoot: string, commitHash: string, mode: GitResetMode) => Promise<GitCommandResult>
  deleteGitBranch: (repoRoot: string, branchName: string, force?: boolean) => Promise<GitCommandResult>
  renameGitBranch: (repoRoot: string, branchName: string, newName: string) => Promise<GitCommandResult>
  continueGitOperation: (repoRoot: string, operation: GitRepoOperation) => Promise<GitCommandResult>
  abortGitOperation: (repoRoot: string, operation: GitRepoOperation) => Promise<GitCommandResult>
  listGitStashes: (repoRoot: string) => Promise<GitStashListSnapshot>
  pushGitStash: (repoRoot: string, message: string, includeUntracked?: boolean) => Promise<GitCommandResult>
  applyGitStash: (repoRoot: string, index: number, expectedHash: string, pop?: boolean) => Promise<GitCommandResult>
  dropGitStash: (repoRoot: string, index: number, expectedHash: string) => Promise<GitCommandResult>
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
  listGitHubRepos: () => Promise<GitHubRepoListResult>
  cloneGitHubRepo: (input: GitHubCloneInput) => Promise<GitHubCloneResult>
  detectExistingAgentConfig: (input?: AgentConfigDetectInput) => Promise<AgentConfigDetectResult>
  adoptAgentConfig: (input: AgentConfigAdoptInput) => Promise<AgentConfigAdoptResult>
  mcpListCatalog: () => Promise<McpCatalogResult>
  mcpPreviewSync: (input: McpSyncInput) => Promise<McpSyncPreview>
  mcpSync: (input: McpSyncInput) => Promise<McpSyncResult>
  workspaceSkillsList: (input: WorkspaceSkillsListInput) => Promise<WorkspaceSkillsListResult>
  // Everything the agent in one CLI can reach in one workspace, in one call:
  // its skills, its MCP servers, and any path that failed to read.
  agentCapabilities: (input: AgentCapabilitiesInput) => Promise<AgentCapabilitiesResult>
  // Keeping that answer true while a surface stays open. Main watches the paths
  // it resolved and says only *that* they changed; the refetch goes back through
  // agentCapabilities, so there is one source of truth for the list. Refcounted:
  // stop what you start, or the watchers outlive the surface.
  agentCapabilitiesWatchStart: (input: AgentCapabilitiesWatchInput) => Promise<void>
  agentCapabilitiesWatchStop: (input: AgentCapabilitiesWatchInput) => Promise<void>
  onAgentCapabilitiesInvalidated: (cb: (event: AgentCapabilitiesInvalidation) => void) => () => void
  // Put one skill where every installed, skill-capable CLI reads it, and take
  // it away again. Both report per target and neither returns the new list: the
  // write invalidates, and the surface re-reads through agentCapabilities.
  agentSkillAttach: (input: AgentSkillWriteInput) => Promise<AgentSkillWriteResult>
  agentSkillRemove: (input: AgentSkillWriteInput) => Promise<AgentSkillWriteResult>
  skillsListSources: () => Promise<SkillSourcesResult>
  skillsAddSource: (input: SkillAddSourceInput) => Promise<SkillAddSourceResult>
  skillsAddLocalSource: (input: SkillAddLocalSourceInput) => Promise<SkillAddSourceResult>
  skillsRemoveSource: (input: SkillRemoveSourceInput) => Promise<SkillRemoveSourceResult>
  skillsGetScan: (input: SkillScanInput) => Promise<SkillScanOutcome>
  skillsReadFile: (input: SkillReadFileInput) => Promise<SkillReadFileResult>
  skillsInstall: (input: SkillInstallInput) => Promise<SkillInstallOutcome>
  skillsUninstall: (input: SkillUninstallInput) => Promise<SkillUninstallOutcome>
  skillsSyncSource: (input: SkillSyncSourceInput) => Promise<SkillSyncSourceOutcome>
  skillsSearch: (input: SkillSearchInput) => Promise<SkillSearchOutcome>
  skillsListPopularRepos: () => Promise<SkillPopularReposOutcome>
  skillsScanLinkedPlugin: (input: SkillPluginScanLinkedInput) => Promise<SkillPluginScanLinkedOutcome>
  skillsInstallPlugin: (input: SkillPluginInstallInput) => Promise<SkillPluginInstallOutcome>
  skillsUninstallPlugin: (input: SkillPluginUninstallInput) => Promise<SkillPluginUninstallOutcome>
  skillsListInstalledPlugins: (input: SkillInstalledPluginsInput) => Promise<SkillInstalledPluginsOutcome>
  /** Run the source update check now (Settings "Check now", or a test). */
  skillsCheckSourceUpdates: () => Promise<SkillSourceUpdateCheck>
  /** Every check's result, pushed from main — the poller's hourly leg or a manual check. */
  onSkillSourcesUpdated: (cb: (check: SkillSourceUpdateCheck) => void) => () => void
  cliDetect: (cli: AgentCli, runtime?: Partial<CliRuntimeSettings>) => Promise<CliDetectResult>
  cliInstallMethods: (cli: AgentCli, runtime?: Partial<CliRuntimeSettings>) => Promise<CliInstallMethodInfo[]>
  cliInstall: (input: CliInstallInput, runtime?: Partial<CliRuntimeSettings>) => Promise<CliInstallResult>
  cliUpdate: (cli: AgentCli, runtime?: Partial<CliRuntimeSettings>) => Promise<CliInstallResult>
  onCliInstallOutput: (cli: AgentCli, cb: (chunk: string) => void) => () => void
  openSprintEngineArtifact: (statePath: string, artifactPath: string) => Promise<SprintEngineArtifactCommandResult>
  approveSprintEngineArtifact: (statePath: string, artifactId: string) => Promise<SprintEngineArtifactCommandResult>
  autoApproveSprintEngineArtifact: (statePath: string, artifactId: string) => Promise<SprintEngineArtifactCommandResult>
  requestSprintEngineArtifactChanges: (
    statePath: string,
    artifactId: string,
    feedback: string
  ) => Promise<SprintEngineArtifactCommandResult>
  initializeSprintEngineState: (input: SprintEngineStateInitializeInput) => Promise<SprintEngineArtifactCommandResult>
  updateSprintEngineTask: (input: SprintEngineTaskUpdateInput) => Promise<SprintEngineArtifactCommandResult>
  createSprintEngineTask: (input: SprintEngineTaskCreateInput) => Promise<SprintEngineArtifactCommandResult>
  commentSprintEngineTask: (input: SprintEngineTaskCommentInput) => Promise<SprintEngineArtifactCommandResult>
  resolveSprintEngineTaskInput: (input: SprintEngineTaskResolveInput) => Promise<SprintEngineArtifactCommandResult>
  setSprintEngineTaskStatus: (input: SprintEngineTaskStatusSetInput) => Promise<SprintEngineArtifactCommandResult>
  /** Read the main-owned automation mode intent for a run (null until first write/hydration). */
  readSprintEngineAutomationMode: (input: SprintEngineAutomationReadInput) => Promise<SprintEngineAutomationReadResult>
  /** Write the automation mode through the one authoritative main-process path. */
  setSprintEngineAutomationMode: (input: SprintEngineAutomationSetModeInput) => Promise<SprintEngineAutomationWriteResult>
  /** One-time seed of the main-owned intent from the legacy renderer value; no-op when a record exists. */
  hydrateSprintEngineAutomationMode: (input: SprintEngineAutomationHydrateInput) => Promise<SprintEngineAutomationWriteResult>
  /** Write the CLI permission preset agents spawn with, by statePath — works without a resident workspace. */
  setSprintEngineCliPermissionPreset: (input: SprintEngineCliPermissionPresetSetInput) => Promise<SprintEngineAutomationWriteResult>
  /** Authoritative automation-intent changes pushed from main (any writer: UI, phone, system). */
  onSprintEngineAutomationChanged: (cb: (event: SprintEngineAutomationChangedEvent) => void) => () => void
  /** Push the renderer-authored launch settings to main's store so it can spawn headless (MC-2154). */
  syncSprintEngineLaunchSettings: (
    input: SprintEngineLaunchSettings
  ) => Promise<SprintEngineLaunchSettingsWriteAck>
  /** One-time seed of main's launch-settings store; no-op once a record exists. */
  hydrateSprintEngineLaunchSettings: (
    input: SprintEngineLaunchSettings
  ) => Promise<SprintEngineLaunchSettingsWriteAck>
  /** Announce/refresh a sprint run's context to the main scheduler (Phase 2). */
  registerSprintRuntimeRun: (input: SprintRuntimeRunRegistration) => Promise<{ ok: boolean }>
  /** Stop tracking a run in the main scheduler (workspace removed). */
  unregisterSprintRuntimeRun: (input: { statePath: string }) => Promise<{ ok: boolean }>
  /** Push a renderer-originated automation stop (terminal closed, removed…) to the scheduler. */
  pushSprintRuntimeStopReason: (input: SprintRuntimeStopReasonPush) => Promise<{ ok: boolean }>
  /** Resume a paused/blocked/failed run in the scheduler (same-mode recovery). */
  resumeSprintRuntimeRun: (input: { statePath: string }) => Promise<{ ok: boolean }>
  /** User-initiated sprint cancellation (MC-1604b): runs the engine `cancel` op
   *  (run/tasks → canceled) and parks the automation runtime so live agents are
   *  torn down. The Cancel action on the board overflow and workspace menu. */
  cancelSprintEngineRun: (input: { statePath: string }) => Promise<SprintEngineArtifactCommandResult>
  /** Scheduler-performed store mutations, mirrored to every window (Phase 2). */
  onSprintRuntimeOp: (cb: (op: SprintRuntimeOp) => void) => () => void
  /**
   * Cross-project sprint run index (MC-1761): every run — live and historical —
   * under the given known project roots, as a compact summary with no resident
   * workspace. The data source for the Sprints door. Unreadable projections come
   * back as `unknown`-state rows carrying a reason, never dropped.
   */
  listSprintRuns: (roots: string[]) => Promise<SprintRunSummary[]>
  /** A run's projection changed; the Sprints door refetches the index on this. */
  onSprintRunsChanged: (cb: (event: SprintRunsChangedEvent) => void) => () => void
  createSprintEnginePullRequest: (statePath: string) => Promise<SprintEngineArtifactCommandResult>
  refreshSprintEnginePullRequestStatus: (statePath: string) => Promise<SprintEngineArtifactCommandResult>
  /**
   * Merge ONE project's pull request (MC-1612). `repo` is the declared project id;
   * omitted means the run's own project, which is all a single-project run has.
   * Fails with the engine's plain-language reason when the project it builds on has
   * not merged yet. Merging is always the user's call — nothing merges on its own.
   */
  mergeSprintEnginePullRequest: (statePath: string, repo?: string) => Promise<SprintEngineArtifactCommandResult>
  /**
   * Provision one task's own worktree ahead of its claim and report where it is
   * (MC-2136). The spawn path calls this on a per-task-isolation run so the
   * agent's terminal can be born INSIDE its task's tree — a cwd cannot be moved
   * later, and the engine commits that task's work from that tree.
   *
   * `isolated: false` is the ordinary answer on every other run: nothing was
   * provisioned and the caller keeps the run worktree it already resolves.
   */
  ensureSprintEngineTaskWorktree: (
    input: SprintEngineTaskWorktreeInput
  ) => Promise<SprintEngineTaskWorktreeResult>
  /** Operator edit of one role's cli/model mid-run; merges into the run's canonical roleRuntimes. */
  setSprintEngineRoleRuntime: (input: SprintEngineRosterRuntimeInput) => Promise<SprintEngineArtifactCommandResult>
  enableSprintEngineRole: (input: SprintEngineRosterEnableInput) => Promise<SprintEngineArtifactCommandResult>
  readSprintEngineProjection: (statePath: string, knownToken?: string) => Promise<SprintEngineProjectionReadResult>
  readSprintEngineRegistryRoles: (input: SprintEngineRegistryRolesReadInput) => Promise<SprintEngineMcpReadResult>
  readSprintEngineRegistryRole: (input: SprintEngineRegistryRoleReadInput) => Promise<SprintEngineMcpReadResult>
  /** Install third-party Sprint Engine roles from a folder into the user-global registry. */
  installUserSprintEngineRoleFolder: (srcDir: string) => Promise<RoleInstallResult>
  /**
   * One-time MC-1587 update-migration: install the shipped (un-bundled)
   * specialist pack into the user-global registry. The renderer owns the
   * run-once guard and the enabled decision; main copies the pack and
   * invalidates the role catalog.
   */
  installBundledSpecialistPack: () => Promise<RoleInstallResult>
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
  /** Regenerate design-system derived files (tokens.css, catalog) for every bundle under a root dir. */
  regenerateDesignSystemDerivedFiles: (rootDir: string) => Promise<DesignSystemRegenResult>
  /** Stamp the design-system bundle layout (templates + manifest) into a workspace. Never overwrites an existing bundle. */
  scaffoldDesignSystemBundle: (workspaceRoot: string, name: string, summary: string) => Promise<DesignSystemScaffoldResult>
  /** Create a new design-system bundle in a user-chosen folder — seeded from an existing bundle, or bare from the shipped templates. Never overwrites; rolls back on failure. */
  seedDesignSystemBundle: (sourceDir: string | null, targetDir: string, name: string, summary: string) => Promise<DesignSystemScaffoldResult>
  /** Resolve the built-in "seed from the Multicode brand" demo source dir (knowledge/brand/); unavailable in builds that do not carry it. */
  resolveDesignSystemBrandDemoSeed: () => Promise<DesignSystemBrandDemoResolveResult>
  /** Run a bundle's own scripts/lint.mjs on demand (the guided-brief studio's validating preview — the author's contribution gate). */
  lintDesignSystemBundle: (bundleDir: string) => Promise<DesignSystemBundleLintRunResult>
  /** Read one design-system bundle directory for the Design door: identity, accent resolved from the token SOURCE, and the parsed manifest. Read-only — never writes, never forks a bundle script. */
  readDesignSystemBundle: (bundleDir: string) => Promise<DesignSystemBundleReadResult>
  /** List the library: every registered folder, probed live for its source state. */
  listDesignSystemLibrary: () => Promise<DesignSystemLibraryListResult>
  /** Read one registered design system by its registration id. */
  readDesignSystemLibraryEntry: (id: string) => Promise<DesignSystemLibraryReadResult>
  /** Point the library at a folder on disk. Registers a reference — copies nothing. */
  registerDesignSystemFolder: (folderPath: string) => Promise<DesignSystemRegisterResult>
  /** Drop a registration. Removes the reference only; the user's folder is untouched. */
  forgetDesignSystemFolder: (id: string) => Promise<{ ok: true; forgotten: boolean }>
  /** Attach a design-system bundle (library entry or browsed folder) to a workspace as a one-time copy at design-system/, provenance stamped. Refuses if design-system/ already exists. */
  attachDesignSystemBundle: (source: DesignSystemAttachSource, workspaceRoot: string) => Promise<DesignSystemAttachResult>
  /** Remove the workspace's design-system/ copy. Idempotent; the caller owns the destructive confirmation. */
  detachDesignSystemBundle: (workspaceRoot: string) => Promise<DesignSystemDetachResult>
  /** List installed third-party capability modules with trust, permissions, and launch readiness. */
  listThirdPartyModules: () => Promise<ThirdPartyModuleListResult>
  /** Install a third-party capability module from a folder (validated, not executed). */
  installThirdPartyModuleFolder: (srcDir: string) => Promise<ThirdPartyModuleInstallResult>
  /** Trust or untrust an installed third-party module. */
  setThirdPartyModuleTrust: (id: string, trusted: boolean) => Promise<ThirdPartyModuleTrustResult>
  /** Serve trusted third-party modules' entry.renderer bundles for the renderer loader. */
  listThirdPartyRendererEntries: () => Promise<ThirdPartyRendererEntriesResult>
  /** Renderer→module-main bridge: invoke a channel a third-party module registered via registerIpc. Refusals are structured, not rejections. */
  moduleBridgeInvoke: (channel: string, payload?: unknown) => Promise<ModuleBridgeInvokeResult>
  /** Every capability module's main→renderer events on one host-owned channel; the renderer kernel fans them out by `sourceModuleId`. Returns the unsubscriber. */
  onModuleEvent: (cb: (envelope: ModuleEventEnvelope) => void) => () => void
  /** Sanitized per-run + per-agent feedback analysis for the run summary (read-only). */
  summarizeSprintEngineFeedback: (statePath: string) => Promise<SprintEngineMcpReadResult>
  /** Per-task / per-agent / run token usage computed from the run's durable
   * token ledger + projection (read-only; coverage-truthful, counts only). */
  readSprintEngineTokenUsage: (statePath: string) => Promise<SprintEngineTokenUsageReport>
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
  // The name of the shell a plain terminal session launches on this machine
  // ('zsh', 'bash', 'powershell'), resolved by the launcher itself so a surface
  // that names it cannot advertise one shell and start another.
  terminalDefaultShellName: () => Promise<string>
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
  // Push the user's "Always keep running" count — the recency floor below which
  // the idle reaper never pauses live agent terminals. Clamped/validated in main.
  setTerminalKeepRecentAliveCount: (count: number) => Promise<void>
  // Toggle the per-terminal user lock: while set, the reaper never suspends or
  // disposes this session. Broadcasts a sessions-changed snapshot so the lock
  // state stays in sync across views.
  setTerminalReapExempt: (sessionId: string, exempt: boolean) => Promise<void>
  // Push the SprintEngine run statePaths whose dispatch loop is actively running,
  // so the idle reaper protects those runs' agents and only reclaims inactive ones.
  setActiveSprintRunStatePaths: (statePaths: string[]) => Promise<void>
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
  // Renderer → main mirror of the module registry the user sees (MC-2078); main
  // caches the last push in memory for its own read surfaces.
  setModuleRegistrySnapshot: (snapshot: ModuleRegistrySnapshot) => Promise<ModuleRegistrySnapshotWriteResult>
  setColorScheme: (scheme: ColorScheme) => Promise<void>
  setWindowMaterial: (material: WindowMaterial) => Promise<void>
  // Renderer → main mirror of `appSettings.keepRunningInBackground` (MC-2156).
  // Main reads it inside `window-all-closed`, when no renderer is left to ask.
  setBackgroundMode: (enabled: boolean) => Promise<void>
  readBacklogObjectStore: (workspaceRoot: string) => Promise<BacklogReadResult>
  ensureBacklogObjectRecords: (workspaceRoot: string, items: BacklogItemRecordInput[]) => Promise<BacklogReadResult>
  ensureBacklogItemIds: (input: BacklogEnsureIdsInput) => Promise<BacklogEnsureIdsResult>
  readBacklogWorkspaceKey: (workspaceRoot: string) => Promise<BacklogWorkspaceKeyResult>
  updateBacklogStatus: (input: BacklogStatusInput) => Promise<BacklogMutationResult>
  updateBacklogType: (input: BacklogTypeInput) => Promise<BacklogMutationResult>
  updateBacklogTriage: (input: BacklogTriageInput) => Promise<BacklogMutationResult>
  updateBacklogHighlight: (input: BacklogHighlightInput) => Promise<BacklogMutationResult>
  addOrUpdateBacklogLink: (input: BacklogAddOrUpdateLinkInput) => Promise<BacklogMutationResult>
  removeBacklogLink: (input: BacklogRemoveLinkInput) => Promise<BacklogMutationResult>
  updateBacklogModuleMetadata: (input: BacklogModuleMetadataInput) => Promise<BacklogMutationResult>
  moveBacklogObjectSource: (input: BacklogMoveSourceInput) => Promise<BacklogMutationResult>
  removeBacklogObjectRecord: (input: BacklogRemoveRecordInput) => Promise<BacklogMutationResult>
  updateBacklogEpic: (input: BacklogEpicInput) => Promise<BacklogMutationResult>
  updateBacklogEpicColor: (input: BacklogEpicColorInput) => Promise<BacklogMutationResult>
  updateBacklogDependencies: (input: BacklogDependenciesInput) => Promise<BacklogMutationResult>
  updateBacklogMockups: (input: BacklogMockupsInput) => Promise<BacklogMutationResult>
  createBacklogEpic: (input: BacklogCreateEpicInput) => Promise<BacklogCreateEpicResult>
  reviewDetectSource: (input: ReviewSourceInput) => Promise<ReviewSourceProbe>
  reviewIngestSource: (input: ReviewSourceInput, target: ReviewTarget) => Promise<ReviewIngestResult>
  reviewReadChangeset: (target: ReviewTarget) => Promise<ReviewChangeSetReadResult>
  reviewReadBrief: (target: ReviewTarget) => Promise<ReviewBriefReadResult>
  reviewProbeChangeset: (input: ReviewSourceInput) => Promise<ReviewProbeResult>
  reviewStartBriefRun: (input: ReviewBriefRunInput) => Promise<ReviewBriefRunResult>
  // Stop this review's guide: kills its terminal and closes the run as stopped,
  // so the panel reports who ended it instead of a bare "session ended".
  reviewStopBriefRun: (target: ReviewTarget) => Promise<void>
  // The main process's record of this review's guide run; null when the guide has
  // never run for it in this app session. The panel seeds its run state from this
  // on mount so a remount mid-run shows progress instead of a prepare button.
  reviewBriefRunStatus: (target: ReviewTarget) => Promise<ReviewGuideRunStatus | null>
  reviewAskGuide: (input: ReviewAskGuideInput) => Promise<ReviewAskGuideResult>
  reviewPostReview: (input: ReviewPostReviewInput) => Promise<ReviewPostReviewResult>
  reviewReadState: (target: ReviewTarget) => Promise<ReviewStateReadResult>
  reviewWriteState: (target: ReviewTarget, state: ReviewWorkspaceState) => Promise<ReviewStateWriteResult>
  reviewList: (roots: string[]) => Promise<ReviewListResult>
  reviewMatchPrProject: (url: string, roots: string[]) => Promise<ReviewMatchPrProjectResult>
}
