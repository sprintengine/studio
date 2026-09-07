import type { IJsonModel } from 'flexlayout-react'
import type { BrowserViewport } from '../../../shared/browser-devices'
import type {
  SprintEngineAutoState,
  SprintEngineCliPermissionPreset,
} from '../../../shared/sprintengine/automation-types'
// The Sprint Engine run-domain type family (state/task/artifact/roster/…) and
// the AgentState record are shared with the main process (sprint-runtime-
// ownership Phase 2: main runs the auto-run planner). Canonical definitions —
// including all field documentation — live in
// `src/shared/sprintengine/run-types.ts` and
// `src/shared/sprintengine/agent-state.ts`; the imports pull in the names this
// module still references and the re-export blocks below keep every existing
// renderer import site working unchanged, mirroring the automation-types
// re-export at the bottom of the Sprint Engine section.
import type {
  AgentCli,
  AgentId,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
  SprintEngineRoleSettings,
  SprintEngineRosterSessions,
  SprintEngineRunSettings,
  SprintEngineSourceBundleItem,
  SprintEngineSourcePlanKind,
  SprintEngineState,
  SprintEngineWorkspaceContext,
} from '../../../shared/sprintengine/run-types'
import type {
  AgentConversationRuntime,
  AgentState,
  McpClientTarget,
  McpScope,
  McpServerConfig,
  McpSettings,
  SpecialistActionId,
} from '../../../shared/sprintengine/agent-state'

export type {
  AgentCli,
  AgentId,
  SprintEngineAgentMeasuredMetrics,
  SprintEngineAgentMetrics,
  SprintEngineAgentSelfReviewMetrics,
  SprintEngineAgentPeerReviewMetrics,
  SprintEngineAgentTaskCounts,
  SprintEngineArchitectDifficulty,
  SprintEngineArtifact,
  SprintEngineArtifactApprovalMode,
  SprintEngineArtifactKind,
  SprintEngineArtifactReviewHistoryEntry,
  SprintEngineArtifactStatus,
  SprintEngineCliWatchPolling,
  SprintEngineCurrentDispatch,
  SprintEngineEvent,
  SprintEngineFeedbackAnalysisData,
  SprintEngineFeedbackAnalysisSummary,
  SprintEngineFeedbackScoreStat,
  SprintEngineMockConfig,
  SprintEngineNeedsInputKind,
  SprintEngineNeedsInputReason,
  SprintEngineProjectionCreation,
  SprintEngineProjectionLockReport,
  SprintEngineProjectionLocks,
  SprintEngineProjectionLockWarning,
  SprintEngineProjectionSource,
  SprintEngineProjectionStatus,
  SprintEngineRecordedArtifact,
  SprintEngineRole,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
  SprintEngineRoleId,
  SprintEngineRoleModelOverrides,
  SprintEngineRoleReasoningOverrides,
  SprintEngineRoleRegistry,
  SprintEngineRoleRegistryMetadata,
  SprintEngineRoleRegistrySourceLayer,
  SprintEngineRoleRegistryWarning,
  SprintEngineRoleRuntime,
  SprintEngineRoleRuntimes,
  SprintEngineRoleSettings,
  SprintEngineRosterSession,
  SprintEngineRosterSessions,
  SprintEngineRoster,
  SprintEngineRunnerPolicy,
  SprintEngineRunSettings,
  SprintEngineRuntimeAgent,
  SprintEngineRuntimeAgentStatus,
  SprintEngineSavedRoster,
  SprintEngineSkillMap,
  SprintEngineSource,
  SprintEngineSourceBundleItem,
  SprintEngineSourceBundleKind,
  SprintEngineSourceBundleStateItem,
  SprintEngineSourcePlanKind,
  SprintEngineState,
  SprintEngineTask,
  SprintEngineTaskActivityEntry,
  SprintEngineTaskActivityType,
  SprintEngineTaskBoardColumn,
  SprintEngineTaskComment,
  SprintEngineTaskCommentType,
  SprintEngineTaskDiff,
  SprintEngineTaskDiffHunk,
  SprintEngineTaskDiffLine,
  SprintEngineTaskDiffSource,
  SprintEngineTaskDiffStatus,
  SprintEngineTaskEvidence,
  SprintEngineTaskFeedback,
  SprintEngineTaskFeedbackFinding,
  SprintEngineTaskFeedbackFindingArea,
  SprintEngineTaskFeedbackFindingKind,
  SprintEngineTaskFeedbackFindingSeverity,
  SprintEngineTaskFeedbackFindingStatus,
  SprintEngineTaskFeedbackIssue,
  SprintEngineTaskFeedbackIssueCategory,
  SprintEngineTaskFeedbackIssueSeverity,
  SprintEngineTaskFeedbackIssueStatus,
  SprintEngineTaskFeedbackScores,
  SprintEngineTaskNeedsInput,
  SprintEngineTaskPhase,
  SprintEngineTaskSource,
  SprintEngineTaskSourceSyncStatus,
  SprintEngineTaskSourceType,
  SprintEngineTaskStatus,
  SprintEngineTaskTriage,
  SprintEngineVcs,
  SprintEngineWorkspaceContext,
} from '../../../shared/sprintengine/run-types'

export type {
  AgentBacklogItemRef,
  AgentConversationRuntime,
  AgentExecution,
  AgentExecutionMode,
  AgentKind,
  AgentMessage,
  AgentRuntimeKind,
  AgentState,
  AgentStatus,
  McpClientTarget,
  McpRiskLevel,
  McpScope,
  McpServerConfig,
  McpServerSource,
  McpServerSourceRef,
  McpSettings,
  McpTransport,
  SpecialistActionId,
} from '../../../shared/sprintengine/agent-state'
import type { ReviewWorkspaceState } from '../../../shared/review'

export type { ReviewWorkspaceState }

export type WorkspaceId = string
export type WorkspaceWindowId = string
export const STANDARD_WORKSPACE_MODE = 'standard'
export const SWITCHBOARD_WORKSPACE_MODE = 'switchboard'
export const GUIDED_BRIEF_WORKSPACE_MODE = 'guided-brief'
// Guided walkthrough of a pull request, branch, or pasted patch (MC-1677). A
// single-surface type: one non-closeable review tab, its change set persisted on
// disk under `.multi-code/review/<workspaceId>/`.
export const REVIEW_WORKSPACE_MODE = 'review'

export type BundledWorkspaceMode =
  | typeof STANDARD_WORKSPACE_MODE
  | typeof SPRINT_ENGINE_WORKSPACE_MODE
  | typeof SWITCHBOARD_WORKSPACE_MODE
  | typeof GUIDED_BRIEF_WORKSPACE_MODE
  | typeof AUTOMATIONS_HOST_WORKSPACE_MODE
  | typeof REVIEWS_HOST_WORKSPACE_MODE
  | typeof REVIEW_WORKSPACE_MODE

// Lifted to the shared layer so shared contracts can name the mode without
// importing the renderer; `STANDARD_WORKSPACE_MODE` is its `'standard'` member.
// The two rail-hidden modes live there too, beside the `isModeHiddenFromRail`
// predicate main also consults. Imported here (so this module's own references
// resolve) and re-exported so every existing import site keeps resolving here.
import {
  AUTOMATIONS_HOST_WORKSPACE_MODE,
  REVIEWS_HOST_WORKSPACE_MODE,
  SPRINT_ENGINE_WORKSPACE_MODE,
  type WorkspaceMode,
} from '../../../shared/workspace-mode'
export { AUTOMATIONS_HOST_WORKSPACE_MODE, REVIEWS_HOST_WORKSPACE_MODE, SPRINT_ENGINE_WORKSPACE_MODE }
export type { WorkspaceMode }

export type HighlightColor = 'red' | 'orange' | 'amber' | 'green' | 'blue' | 'purple' | 'pink'

export type WorkspaceHighlight = {
  starred: boolean
  color: HighlightColor | null
}

export type PreviewSlot = {
  x: number
  y: number
  w: number
  h: number
  type: 'agent' | 'editor' | 'explorer'
  label: string
}

export type LayoutTemplate = {
  id: string
  name: string
  description: string
  previewSlots: PreviewSlot[]
  layout: IJsonModel
}

// The Sprint Engine automation vocabulary is shared with the main process
// (MC-1567: the mode intent is main-owned). Canonical definitions — including
// `SprintEngineAutoState` and its field documentation — live in
// `src/shared/sprintengine/automation-types.ts`; these re-exports keep every
// existing renderer import site working unchanged.
export type {
  SprintEngineAutoState,
  SprintEngineAutomationDesiredMode,
  SprintEngineAutomationEvent,
  SprintEngineAutomationMode,
  SprintEngineAutomationRuntimeState,
  SprintEngineAutomationStopReason,
  SprintEngineCliPermissionPreset,
} from '../../../shared/sprintengine/automation-types'

export type WatchtowerReviewSectorId =
  | 'code_review'
  | 'spec_review'
  | 'ai_slop'
  | 'architecture_quality'
  | 'frontend_design'
  | 'production_readiness'
  | 'cross_platform'
  | 'brand_alignment'
  | 'security'
  | 'performance'
  | 'qa_testing'
  | 'infrastructure'
  | 'product_strategy'
  | 'accessibility'
  | 'documentation'

export type FuturePlanWorkspaceSource = {
  folderPath: string
  sourcePath: string
  sourceRelativePath: string
  sourceContent: string
  sourcePlanKind: SprintEngineSourcePlanKind
  sourceBundle?: SprintEngineSourceBundleItem[]
  teamName: string
  goal: string
}

export type WorktreeEntryStatus = 'available' | 'assigned' | 'missing' | 'removing' | 'error'

export type CliRuntimeSettings = {
  command: string
  useWsl: boolean
  // User-added model ids for this CLI, merged with the plugin manifest's seed
  // options in pickers. Mirrors the shared electron-api type.
  models?: string[]
}

// Whether an agent CLI's binary is actually installed/runnable on this machine,
// distinct from whether its plugin manifest is registered. Mirrors the shared
// electron-api type. Keyed by plugin id in AgentCliAvailabilityMap.
export type CliAvailability = {
  cli: AgentCli
  installed: boolean
  resolvedPath: string | null
  version: string | null
}

export type AgentCliAvailabilityMap = Record<AgentCli, CliAvailability>

export type McpCatalogServer = Omit<McpServerConfig, 'enabled' | 'scope' | 'source'> & {
  defaultClients?: McpClientTarget[]
  recommendedScope?: McpScope
  setupNotes?: string
  skill?: string
  icon?: string
}

export type WorktreeEntry = {
  id: string
  path: string
  branch: string | null
  ownerAgentId: AgentId | null
  status: WorktreeEntryStatus
  createdAt: number
  updatedAt: number
  missingAt?: number | null
}

export type WorkspaceWorktreeState = {
  containerPath: string | null
  entries: Record<string, WorktreeEntry>
  updatedAt: number | null
}

export type MemoryGraphColorRule = {
  id: string
  pattern: string
  color: string
}

export type MemoryGraphFiltersConfig = {
  hideOrphans: boolean
  hideAttachments: boolean
  hideUnresolved: boolean
  depthFromSelection: number | null
  disabledGroups: string[]
}

export type MemoryGraphDisplayConfig = {
  nodeSizeScale: number
  lineThicknessScale: number
  labelFadeThreshold: number
  labelFontSize: number
  showArrows: boolean
  curvedEdges: boolean
  glowHalos: boolean
  starfield: boolean
}

export type MemoryGraphForcesConfig = {
  centerForce: number
  repelForce: number
  linkForce: number
  linkDistance: number
}

export type MemoryGraphSettings = {
  /** Bumped when default tuning changes so the renderer can migrate stored values. */
  version?: number
  sidebarOpen: boolean
  activeTab: 'filters' | 'groups' | 'display' | 'forces'
  filters: MemoryGraphFiltersConfig
  colorRules: MemoryGraphColorRule[]
  display: MemoryGraphDisplayConfig
  forces: MemoryGraphForcesConfig
}

export type WorkspaceMemoryConfig = {
  relativeRoot: string | null
  graphSettings?: MemoryGraphSettings
}

// Records why a persisted workspace registry intentionally has zero workspaces.
// Hydration failure, parse failure, migration failure, and unknown startup
// empties all remain distinct (they are classifications of the persisted shape,
// not states of the registry). This record only exists for user-initiated wipes
// so the model unambiguously distinguishes intent from failure.
export type WorkspaceRegistryEmptyState = {
  reason: 'user_removed_all'
  updatedAt: string
}

export type WorkspaceWindowState = {
  id: WorkspaceWindowId
  kind: 'primary' | 'detached'
  workspaceIds: WorkspaceId[]
  activeWorkspaceId: WorkspaceId | null
  bounds: { x: number; y: number; width: number; height: number } | null
  isMaximized: boolean
  displayId: number | null
  createdAt: number
  lastFocusedAt: number
}

export type UsageTelemetrySettings = {
  sendUsageData: boolean
  localDevExportEnabled: boolean
  lastExportAt: string | null
  exportDiagnostics: boolean
}

export type LearningSettings = {
  showTipsOnStartup: boolean
  lastShownTipId: string | null
  seenTipIds: string[]
  completedLessonIds: string[]
  dismissedVersion?: string
}

// Whisper model ids understood by a Multivoice transcription host (the lowercase
// WhisperModel enum from multivoice-tauri). The host loads/downloads the model.
export type VoiceDictationModel =
  | 'tiny'
  | 'base'
  | 'small'
  | 'medium'
  | 'large-v2'
  | 'large-v3'
  | 'large-v3-turbo'

export type VoiceDictationSettings = {
  /** Base URL of the Multivoice transcription host (remote, LAN, or localhost). */
  serverUrl: string
  /** Optional bearer token sent as `Authorization: Bearer …`. */
  authToken: string
  /** Whisper model the host should use. */
  model: VoiceDictationModel
  /** ISO language code, or 'auto' to let the model detect it. */
  language: string
}

// Theme system source of truth lives in `src/renderer/src/types/appTheme.ts`.
// AppearanceSettings is imported here so AppSettings (below) can reference it;
// every other theme symbol (AppTheme, ResolvedAppTheme, the picker option list,
// the normalizer) imports directly from appTheme.ts.
import type { AppearanceSettings } from './appTheme'
import type { ModuleEnablementOverrides } from '../../../shared/modules/manifest'
import type { PluginRegistryListEntry } from '../../../shared/plugin-manifest'
import type { DiscoveredCliModelCatalog } from '../../../shared/cli-model-catalog'
import type { FolderOpenTargetId } from '../../../shared/folder-open-targets'

export type PluginCatalogStatus = 'loading' | 'ready' | 'error'

export type PluginCatalogEntry = PluginRegistryListEntry

export type KeybindingSettings = {
  /**
   * User-defined command shortcut overrides. Empty or missing arrays mean
   * "use the command registry defaults"; dispatch must also check `disabled`.
   */
  overrides: Record<string, string[]>
  /**
   * Persisted command disablement flags. Only `true` values are meaningful;
   * missing/false means the command remains enabled.
   */
  disabled: Record<string, boolean>
}

// A model choice scoped to the CLI it was made for. Model ids are only
// meaningful per-CLI; pairing them prevents cross-CLI leakage.
//
// `reasoning` is the selected reasoning-effort level, and it is a property of
// the CLI rather than of the model (owner ruling 2026-07-26): switching model
// within a CLI leaves it untouched, and switching CLI drops it, because the
// levels a CLI accepts are manifest knowledge that does not transfer. Absent
// means "the CLI's own default effort", which passes no flag.
//
// `model` may therefore be empty while `reasoning` is set: choosing the CLI's
// default model is a model switch, not a reason to forget the level. Readers
// resolve through resolveCliModel / resolveCliReasoning, which treat an empty
// value as "no flag".
export type AgentCliModelSelection = {
  cli: AgentCli
  model: string
  reasoning?: string
}

// The agent the sidebar's "New chat in project" item spawns on a plain click,
// remembered from the last pick in the agent picker. Only the kind (and which
// specialist) is stored — the CLI/model still resolves from lastSelectedCli and
// the per-specialist defaults at spawn time, so a later CLI switch is honored.
export type NewChatAgentChoice =
  | { kind: 'general' }
  | { kind: 'terminal' }
  | { kind: 'conversation' }
  | { kind: 'specialist'; specialistId: SpecialistActionId }

export type AppSettings = {
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>
  /**
   * What each agent CLI last reported about its own models, keyed by plugin id.
   * A sibling of `cliRuntimes[id].models`, never the same store: that list is
   * the user's own escape hatch and must survive a refresh, while this one is
   * replaced wholesale every time the CLI is re-probed. No code path writes
   * both. Pickers merge manifest ∪ this ∪ the user's list (mergeModelCatalog);
   * absent means "never probed", and an entry with no models means "probed and
   * the CLI listed nothing".
   */
  cliModelCatalog?: Partial<Record<AgentCli, DiscoveredCliModelCatalog>>
  keybindings: KeybindingSettings
  mcp: McpSettings
  /**
   * The user's global default CLI — the fallback shown for any specialist,
   * Sprint Engine role, or automation with no per-agent default,
   * and settable directly in Settings. The General agent, like every specialist,
   * carries its own entry in `specialistCliDefaults` / `specialistModelDefaults`
   * (keyed by `GENERAL_AGENT_ENGINE_KEY`), so its engine is isolated from this.
   */
  lastSelectedCli: AgentCli
  /**
   * Last provider/model pair spawned as a conversation agent, so a new
   * Conversation agent reopens with it. `null` until the user spawns one; a
   * remembered pair that is no longer installed falls back to the first
   * available option at spawn time.
   */
  lastSelectedConversationModel: AgentConversationRuntime | null
  /**
   * Agent the sidebar's "New chat in project" item spawns on a plain click.
   * Updated whenever the user picks an agent from the new-chat picker, so the
   * next plain click repeats that choice and the menu can show what will spawn.
   */
  lastNewChatAgent: NewChatAgentChoice
  /**
   * Target the workspace bar's open-in-editor split button last used, so its
   * primary half repeats that choice. Per APP, not per workspace: which editor
   * you use is a property of the machine you are sitting at, not of the project
   * (item 1990). `null` until the user picks one, which resolves to the first
   * available target at render time; a remembered target that no longer probes
   * as installed falls back the same way rather than offering a dead editor.
   */
  lastFolderOpenTarget: FolderOpenTargetId | null
  lastAgentSpawnPermissionPreset: SprintEngineCliPermissionPreset
  specialistCliDefaults: Partial<Record<SpecialistActionId, AgentCli>>
  /**
   * Per-specialist model override, stored with the CLI it was picked for so a
   * later CLI switch cannot leak a stale model across CLIs. Honored only when
   * the row's effective CLI matches; otherwise no model flag is passed.
   */
  specialistModelDefaults: Partial<Record<SpecialistActionId, AgentCliModelSelection>>
  /**
   * User-defined display order for the spawn-agent specialist menu. Holds the
   * specialist ids in the sequence the user dragged them into; ids absent here
   * fall back to the canonical roster order. Empty means "use canonical order".
   */
  specialistOrder: SpecialistActionId[]
  /**
   * Specialist-pack enablement. `disabled` holds the ids of packs the user has
   * switched off; a pack absent there is enabled. `migratedBundledPack` guards
   * the one-time MC-1587 update-migration that installs the (now un-shipped)
   * specialist pack for users who had it enabled before it stopped being
   * bundled: false → the migration still needs to run this profile; true →
   * already evaluated (a fresh profile defaults to true so it installs nothing).
   */
  specialistPacks: { disabled: string[]; migratedBundledPack: boolean }
  sprintEngineRoleSettings: SprintEngineRoleSettings
  /**
   * Local operator preferences for an existing Sprint Engine run, keyed by the
   * normalized absolute `run.yaml` path. These intentionally stay in app-local
   * settings instead of the portable run store because permission bypass is a
   * machine/user trust decision.
   */
  sprintEngineRunSettings: Record<string, SprintEngineRunSettings>
  searchExcludes: string[]
  projectKnowledgeRoots: Record<string, string | null>
  recentWorkspaceFolders: string[]
  usageTelemetry: UsageTelemetrySettings
  learning: LearningSettings
  appearance: AppearanceSettings
  /** Voice dictation transcription server + model configuration. */
  voiceDictation: VoiceDictationSettings
  /** Capability-module enablement overrides, keyed by module id. */
  modules: ModuleEnablementOverrides
  /**
   * Values persisted by module-contributed settings sections, keyed by
   * `module:<moduleId>` namespace so module keys can never collide with shell
   * settings. Disabling a module hides its section but leaves this namespace
   * intact, so values survive a disable/enable cycle. Values must be
   * JSON-serializable.
   */
  moduleSettings: Record<string, Record<string, unknown>>
  /**
   * Whether the user has made a first-run capability-module choice. Until then
   * the module chooser is shown. Existing installs (with workspaces) are treated
   * as already-chosen so an upgrade never interrupts them.
   */
  modulesChosen: boolean
  /**
   * Whether the first-run "you have no agent CLI" card has been dismissed. The
   * only persisted trace of the retired onboarding wizard, and deliberately a
   * boolean rather than a step position: whether to ASK is a live predicate over
   * probe state (see store/onboardingState.ts), and only the user's "not now"
   * needs to survive a restart. Defaults true for any profile that predates the
   * wizard's removal, so an upgrade is never asked.
   */
  firstRunCliCardDismissed: boolean
  /**
   * Whether this profile has already had an existing Claude Code / Codex agent
   * config adopted. Adoption runs silently at first workspace creation — it
   * needs a real folder on disk, which does not exist any earlier — and this
   * flag is what makes it once-per-profile rather than once-per-workspace.
   */
  hasAdoptedAgentConfig: boolean
  /**
   * How long an idle agent terminal sits before it is paused (its CLI process is
   * killed to reclaim memory, with the painted view frozen and resumed on click
   * or keystroke). In MINUTES; default 15. Never applies to agents waiting on the
   * user or mid-work. Synced to the main reap policy, which clamps it to
   * [1 minute, 24 hours]. See terminal-reap-policy.ts.
   */
  terminalIdleSuspendMinutes: number
  /**
   * Recency floor for the idle-terminal pauser: the N most recently used agent
   * terminals are always left running, even once idle past the threshold, so
   * the reaper can never pause the user's whole active set. 0 disables the
   * floor. Synced to the main reap policy, which clamps it to [0, 20].
   */
  terminalKeepRecentAlive: number
  /**
   * Opt-in: when on, Design Wizard specialists on Claude run as conversation
   * sessions (structured question cards, streamed chat) instead of raw
   * terminals. Off by default — every other role and CLI takes the terminal
   * transport regardless.
   */
  guidedBriefConversationSessions: boolean
  /**
   * Whether the one-time store-v67 reset of {@link guidedBriefConversationSessions}
   * has been applied to this profile. The pre-opt-in default was `true`, so a
   * stored `true` cannot be told apart from an old default; the reset clears it
   * once and stamps this flag, after which a stored `true` is an explicit
   * choice and survives. Never surfaced in settings UI. See MC-1802 and
   * normalizeAppSettings.
   */
  guidedBriefConversationSessionsOptInReset: boolean
  /**
   * Keep the app running when its last window closes, on every platform
   * (MC-2156). Off by default, which is byte-for-byte the pre-MC-2156 rule:
   * quit on Windows/Linux, survive on macOS. On, the process stays up with a
   * tray presence, so sprint runs, the scheduler and the Studio gateway keep
   * working with no window open. Mirrored to main (`setBackgroundMode`), which
   * reads it at last-window-close when no renderer is left to ask.
   */
  keepRunningInBackground: boolean
}

/**
 * What the silent first-run adoption found worth bringing over: the keys of the
 * detected MCP servers and adoptable skills. Derived live at first workspace
 * creation and handed straight to the real adoptAgentConfig IPC — it is no
 * longer a persisted user selection, because there is no longer a card that asks.
 */
export type PendingAgentConfigAdoption = {
  mcpServerKeys: string[]
  skillKeys: string[]
}

/**
 * Live outcome of the first-run config adoption, read out as one line in
 * Settings → Agents. Transient app state (not persisted): set when adoption runs
 * at workspace creation, never resumed.
 */
export type AgentConfigAdoptionResult =
  | { status: 'adopting' }
  | { status: 'adopted'; mcpServerCount: number; skillCount: number; warnings: string[] }
  | { status: 'failed'; message: string }

export type GuidedBriefHasUi = 'yes' | 'no'

// Guided Brief ships three presets. `full-brief` is the classic strategist →
// architect → designer → handoff flow. `frontend-design` is surfaced to users
// as "Design only": a design-only studio that forces the UI path, skips
// the product and architecture discussions, and starts on the designer stage.
// `design-system` reuses that design-only studio but authors a portable
// design-system bundle (see knowledge/multicode/design-system-bundle.md)
// instead of one app's mockups. All presets stay inside the `guided-brief`
// workspace mode rather than becoming their own `WorkspaceMode`.
export type GuidedBriefPreset = 'full-brief' | 'frontend-design' | 'design-system'

// Where a design-system studio starts. `null`/absent is the blank scaffold;
// otherwise the designer agent's opening move is extracting the de-facto
// design language from the named source (a user-picked product folder, or the
// built-in Multicode brand reference resolved by the main process). The path
// is machine-local by design — it is read live by the designer session on this
// machine and never travels inside the portable bundle.
export type DesignSystemSeedSource = {
  kind: 'source-folder' | 'brand-demo'
  path: string
}

export type GuidedBriefRoleCliDefaults = {
  product: AgentCli
  architect: AgentCli
  frontend: AgentCli
}

// Explicit per-role launch model for the guided-brief discussions. A string is
// an explicit model id; null or an absent role means "CLI default" (no model
// flag passed). Mirrors SprintEngineRoleModelOverrides for the guided roles.
export type GuidedBriefRoleModelOverrides = Partial<Record<keyof GuidedBriefRoleCliDefaults, string | null>>

export type GuidedBriefStage =
  | 'strategist-working'
  | 'strategist-ready'
  | 'architect-working'
  | 'architect-ready'
  | 'designer-working'
  | 'designer-ready'
  | 'handoff'

export type GuidedBriefAcceptedArtifact = {
  kind: 'product' | 'mockup'
  title: string
  hash: string
  path: string
}

// One interview decision the user resolved during a guided-brief stage,
// recorded from the specialist's structured GUIDED_DECISION stream so the
// build handoff can carry the real decision record.
export type GuidedBriefRecordedDecision = {
  role: 'product' | 'architect' | 'frontend'
  id: string
  question?: string
  label: string
}

export type GuidedBriefRuntimeState = {
  workspaceRoot: string
  workspaceName: string
  idea: string
  hasUi: GuidedBriefHasUi
  // Which Guided Brief preset this runtime was created from. Absent on legacy
  // states; normalization defaults it to `full-brief`.
  preset?: GuidedBriefPreset
  wantsProductDiscussion: boolean
  wantsArchitectureDiscussion: boolean
  wantsFrontendDiscussion: boolean
  guidedRoleCliDefaults: GuidedBriefRoleCliDefaults
  // Explicit per-role launch models for the guided discussions. Absent on
  // legacy states; normalization defaults it to {} (all roles use CLI default).
  guidedRoleModelOverrides?: GuidedBriefRoleModelOverrides
  buildRoleCounts: SprintEngineRoleCounts
  buildRoleCliDefaults: Required<SprintEngineRoleCliDefaults>
  buildCliPermissionPreset: SprintEngineCliPermissionPreset
  buildStartRunner: boolean
  buildAutoApproveArtifacts: boolean
  stage: GuidedBriefStage
  acceptedProductBrief: GuidedBriefAcceptedArtifact | null
  acceptedArchitecturePlan: GuidedBriefAcceptedArtifact | null
  acceptedUiDirection: GuidedBriefAcceptedArtifact | null
  acceptedMockups: GuidedBriefAcceptedArtifact[]
  // Optional agent-produced HTML overviews of the brief/plan (a view of the
  // markdown, never a second source of truth). Absent on legacy states.
  acceptedProductOverview?: GuidedBriefAcceptedArtifact | null
  acceptedArchitectureOverview?: GuidedBriefAcceptedArtifact | null
  activeMockupPath: string | null
  // Path of the design artifact currently selected in the Multicode Design
  // studio preview, relative to the workspace root. Absent on legacy states;
  // normalization defaults it to `null`.
  activeDesignArtifactPath?: string | null
  // Interview decisions resolved across all specialist stages, deduped by
  // role + question id. Absent on legacy states; normalization defaults it
  // to an empty array.
  guidedDecisions?: GuidedBriefRecordedDecision[]
  // Design-system preset only: the source the studio was seeded from, carried
  // into the designer session's opening prompt. Absent/null on legacy states
  // and on blank-start studios; always null for the other presets.
  designSystemSeedSource?: DesignSystemSeedSource | null
  // Persisted so the renderer reattaches to the same PTY across HMR / refresh
  // instead of spawning a fresh strategist, architect, or designer.
  strategistSessionId: string | null
  architectSessionId: string | null
  designerSessionId: string | null
}

export type DiagnosticLevel = 'info' | 'warning' | 'error'
export type DiagnosticSource =
  | 'auth'
  | 'automations'
  | 'cli'
  | 'filesystem'
  | 'git'
  | 'marketplace'
  | 'models'
  | 'sprintengine'
  | 'terminal'
  | 'update'
  | 'voice'
  | 'workspace'

// A typed, serializable deep-focus target for a notification's Open action. The
// shell treats it as opaque (it only knows how to reveal the workspace); the
// owning module interprets `kind`/`ref` (e.g. Sprint Engine resolves
// `{ kind: 'task', ref: <taskId> }` to its board selection). Must stay plain
// data — notifications persist to localStorage, so this never carries a
// callback.
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

export type AppNotification = DiagnosticLogEntry & {
  read: boolean
}

export type AgentConfig = {
  model: string
  systemPrompt: string
  temperature: number
  maxTokens: number
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You are a helpful AI assistant.',
  temperature: 1,
  maxTokens: 8096,
}

export type OpenFile = {
  path: string
  name: string
  content?: string
  language: string
  isDirty: boolean
}

export type EditorState = {
  openFiles: OpenFile[]
  activeFilePath: string | null
}

export type WorkspaceFileExplorerState = {
  expandedPaths: string[]
  // The file the user last clicked in the tree, restored as the highlighted row
  // after a reload/restart. Only the focused/lead path is persisted, never the
  // whole multi-select set. Best-effort: it highlights only when the row is
  // visible, which works because expandedPaths restores its ancestor folders.
  selectedPath?: string | null
}

// Backlog triage lens + sort. Canonically defined here (the shared workspace
// types module, also visible to the main/preload tsconfig project) so the
// persisted WorkspaceBacklogState can reference them without dragging the
// renderer-only triage util into the node project. `utils/backlogTriage.ts`
// re-exports these and owns their behavior (matchesBacklogView/compareBacklogItems).
export type BacklogView =
  | 'active'
  | 'all'
  | 'epics'
  | 'quick_wins'
  | 'strategic_bets'
  | 'defer'
  | 'unestimated'
  | 'completed'
  | 'archived'

// `dependency` is "Dependency order": a whole-list topological transform
// (prerequisites before dependents, unblocked frontier first) the panel applies
// via orderItemsByDependencies, branching around the pairwise compareBacklogItems
// the other sorts use.
export type BacklogSort =
  | 'best'
  | 'recent'
  | 'created'
  | 'status'
  | 'priority'
  | 'largest'
  | 'smallest'
  | 'dependency'
  | 'no_epic'

// Backlog grouping axis, orthogonal to view/sort. `none` is the flat list;
// `by_epic` renders collapsible epic headers with their children nested.
export type BacklogGroup = 'none' | 'by_epic'

// The Backlog panel's per-workspace navigation/view state, persisted so a
// reload/restart restores the item the user was reading plus the lens, sort, and
// search they left it in. Selection is keyed by project-root-relative
// `backlog/...` path (the durable identity) and resolved to the live scan's item
// id on restore — a deleted item degrades to no selection via the panel's
// existing scan-validity guard. The list/detail split is intentionally NOT
// persisted: it is derived from panel width by a ResizeObserver, not a user
// choice.
export type WorkspaceBacklogState = {
  selectedRelativePath: string | null
  view: BacklogView
  sort: BacklogSort
  group: BacklogGroup
  search: string
}

export type GitPanelView = 'changes' | 'worktrees' | 'log' | 'stashes' | 'terminal'

// The Git panel's per-workspace view state. Commit-message drafts are keyed by
// scope id (per worktree/main checkout) so a half-written message can never
// bleed across worktrees and is cleared once that scope commits.
export type WorkspaceGitPanelState = {
  activeView: GitPanelView
  activeScopeId: string
  commitDraftsByScopeId: Record<string, string>
}

// The workspace pane (browser-pane epic): the full-height tabbed column on the
// right that hosts a browser, terminals, Files, Git, Diff and the workspace's
// Backlog. Tabs are a plain per-workspace record rather than a FlexLayout
// tabset because the pane mixes kinds FlexLayout used to scatter across two
// exclusive rails.
export type WorkspacePaneTabKind = 'browser' | 'terminal' | 'files' | 'diff' | 'git' | 'backlog'

export type WorkspacePaneTab = {
  id: string
  kind: WorkspacePaneTabKind
  // A browser tab's page title or a terminal's pty title; absent, the tab
  // reads as its kind.
  title?: string
  // Browser only: the URL the tab is on, persisted so a restart reloads it.
  url?: string
  // Browser only: the page favicon as a data URL. Session-only — partialize
  // strips it; a favicon is fetched again on load.
  faviconUrl?: string
  // Terminal only: the pty id the tab owns; closing the tab kills it.
  terminalId?: string
  // Diff only: the file the viewer opened on, and which side.
  diff?: { focusPath: string | null; focusKind: 'staged' | 'unstaged' | null }
  // Browser only: the device toolbar's viewport; absent means fill.
  viewport?: BrowserViewport
}

export type WorkspacePaneState = {
  open: boolean
  activeTabId: string | null
  tabs: WorkspacePaneTab[]
  // The URLs this workspace's browser tabs visited last, newest first, for the
  // new-tab surface. Optional: records written before the browser child exist.
  recentUrls?: string[]
}

/**
 * Marks a standard workspace as living in a git worktree — set when a worktree
 * is opened as a workspace from the Worktree manager. The workspace's
 * `folderPath` already points at the worktree in this case, so this only carries
 * display info (branch/base) and flags the workspace as worktree-backed. Sprint
 * runs instead carry their worktree on `sprintEngineState.vcs`; both are
 * normalized by `resolveWorkspaceWorktree` (utils/workspaceWorktree.ts).
 */
export type WorkspaceWorktree = {
  branch?: string
  baseRef?: string
  /**
   * The project this worktree was cut from — the folder header the workspace
   * files under in the sidebar, in the app's own spelling of that path rather
   * than git's realpath (a symlinked root would otherwise not string-match the
   * open parent workspace and would found a second header). Absent on rows
   * written before this field existed, where it is instead derived from the
   * container convention (`repoRootFromWorktreePath`).
   */
  repoRoot?: string
}

/**
 * Per-module workspace state, keyed by module id (MC-1573). The canonical home
 * for state a module keeps on a workspace: entries persist with the workspace
 * registry and ride workspace-sync exactly like sibling fields, and modules
 * reach their own entry through the SDK accessors
 * (`RendererHost.getWorkspaceModuleState` / `setWorkspaceModuleState`).
 *
 * The `sprintengine` entry is the first migrated in-tree field. Its legacy
 * typed `Workspace.sprintEngineState` field remains as a store-maintained
 * mirror of `moduleState.sprintengine` until its in-tree readers migrate to
 * the bag (follow-up on backlog/2026-07-10-module-owned-workspace-state.md);
 * the store's writers and the persist merge() keep the two in lockstep, and
 * like the field, the `sprintengine` entry is stripped at partialize (it is a
 * cache of the on-disk projection, not durable state).
 */
export type WorkspaceModuleStateBag = Record<string, unknown>

export type WorkspaceRemoteOrigin = {
  // The paired machine (fleet connection id) the workspace was created on.
  connectionId: string
  machineName: string
  // The remote gateway's workspace: its id, display name, and folder there.
  workspaceId: string
  workspaceName: string
  workspaceRoot: string | null
  /**
   * The remote session this workspace's pane attaches to
   * (remote-band-in-the-sidebar): how the sidebar's Remote band knows that a
   * session the machine lists is THIS row, and focuses it rather than opening
   * a second attachment. Absent on rows born before the band existed, which
   * the band matches by the fleet pane still in their layout instead.
   */
  sessionId?: string
  /**
   * Where the chat runs there (checkout-and-branch-on-remote-create): the
   * remote workspace's own checkout, or a worktree the create minted, and
   * the branch either is on as of the create. The row's branch reads from
   * here — the local git poll has no path on this disk to ask. Absent on
   * rows born before the choice existed.
   */
  checkout?: {
    mode: 'current' | 'worktree'
    branch: string | null
    worktreePath: string | null
  } | null
  /**
   * Which repository the remote workspace is a clone of, as its machine's
   * `workspace.list` served it (one-project-across-machines). The sidebar
   * files the row under a local clone of the same repository when one is
   * open. Null when the remote had no identity to give.
   */
  repository?: import('../../../shared/repository-identity').RepositoryIdentity | null
}

export type Workspace = {
  id: WorkspaceId
  name: string
  mode: WorkspaceMode
  folderPath: string | null
  folderMissing?: boolean
  // Where a remote-born workspace's code and agent actually live
  // (remote-sessions-ux / new-chat-on-a-remote-machine). Set once at creation
  // for a chat started on a paired machine; the sidebar groups and badges by
  // it, so the row keeps its provenance even after its fleet pane closes.
  // Absent for every local workspace — local is the unmarked default.
  remoteOrigin?: WorkspaceRemoteOrigin | null
  worktree?: WorkspaceWorktree | null
  sprintEngineContext?: SprintEngineWorkspaceContext | null
  // LEGACY, READ-ONLY (MC-1856). The human's review progress on a `review`-mode
  // workspace (MC-1675). The `review` workspace type retired in MC-1708, so
  // nothing writes this any more — it survives ONLY so persisted rows written
  // before that retirement can still be lifted onto disk by
  // `collectReviewStateMigrations`, which is core's job (see the comment there).
  // Live review progress lives on disk beside the change set, not on a
  // workspace row. Do not add readers.
  reviewState?: ReviewWorkspaceState | null
  templateId: string
  layoutModel: IJsonModel
  agents: Record<AgentId, AgentState>
  worktreeState: WorkspaceWorktreeState
  memory: WorkspaceMemoryConfig
  editorState: EditorState
  fileExplorerState?: WorkspaceFileExplorerState
  backlogState?: WorkspaceBacklogState
  gitPanelState?: WorkspaceGitPanelState
  // The workspace pane's tabs (browser-pane epic); absent until first opened.
  paneState?: WorkspacePaneState
  // Per-module state bag (MC-1573) — see WorkspaceModuleStateBag. The
  // `sprintengine` entry is canonical; `sprintEngineState` below mirrors it.
  moduleState?: WorkspaceModuleStateBag
  // Legacy mirror of `moduleState.sprintengine` (MC-1573). Kept only for the
  // existing in-tree readers; new code reads the bag. The store's writers and
  // the persist merge() enforce the lockstep invariant — never assign this
  // field without going through them.
  sprintEngineState: SprintEngineState | null
  sprintEngineRoleCliDefaults?: SprintEngineRoleCliDefaults
  // Durable per-agent CLI session records, keyed by roster agent id. Populated
  // when a sprint agent gets a live session and just before completion teardown
  // removes its panel, so a role can be re-opened later and resumed. Survives
  // panel removal and app restart (persisted alongside sprintEngineRoleCliDefaults).
  sprintEngineRosterSessions?: SprintEngineRosterSessions
  // Roster agents the user explicitly asked to start when the workspace
  // opens (new-workspace "Start now" intent). Session-only launch intent:
  // consumed by the Sprint Engine board on first ready render and stripped
  // at persist so an app restart never replays the spawns.
  sprintEngineInitialSpawnAgentIds?: AgentId[]
  sprintEngineAutoState: SprintEngineAutoState
  guidedBriefState?: GuidedBriefRuntimeState | null
  highlight?: WorkspaceHighlight
  createdAt: number
  lastTerminalActivityAt?: number | null
  // When an agent in this workspace last finished a turn (hook-reported Stop),
  // monotonic like `lastTerminalActivityAt`. The sidebar's idle time for a
  // parked chat with no live session, so it says when the agent finished
  // rather than when the person last typed — or nothing.
  lastTurnEndedAt?: number | null
  // When set, the chat has come to rest: it renders as a compact row in its
  // folder's Settled shelf rather than in the active list. Set by the
  // sidebar's reconcile sweep after three idle days, or by hand from the row
  // menu; cleared by input into the chat, by the agent working or blocking
  // on input again, or by hand. Presentation-level: settling never touches
  // agents, sessions, or run state. See `utils/workspaceSettle.ts`. The
  // retired `archivedAt` (the startup archive sweep, gone 2026-09-07) heals
  // into this on registry read.
  settledAt?: number | null
  // A hand decision about rest that outranks the sweep. `'settled'` is a
  // manual Settle; `'active'` is a manual Un-settle, which holds the row in
  // the active list until new input into it clears it — otherwise
  // the sweep would settle it straight back on its next tick. The sweep never
  // touches a row carrying either value.
  settledOverride?: 'settled' | 'active' | null
  // True once this workspace's name is settled and auto-titling must never touch
  // it again. Set by the auto-title itself (a name derived from the first real
  // prompt), by a manual rename, and at creation for any workspace given an
  // explicit name (the wizard, a sprint roster, a chained run).
  //
  // This is what makes the name stop moving: a second prompt, a second terminal,
  // or a resumed session all find the lock set and leave the name alone. Absent
  // on workspaces created before the field existed, which reads as unlocked —
  // correct, since those are sitting on a default "Chat 44" name.
  titleLocked?: boolean
}
