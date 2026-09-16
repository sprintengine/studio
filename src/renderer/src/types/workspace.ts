import type { IJsonModel } from 'flexlayout-react'
import type { BrowserViewport } from '../../../shared/browser-devices'
import type {
  SprintEngineAutoState,
  CliPermissionPreset,
} from '../../../shared/sprintengine/automation-types'
import { SPRINT_ENGINE_WORKSPACE_MODULE_ID } from '../../../shared/sprintengine/workspace-record'
// The Sprint Engine run-domain type family (state/task/artifact/roster/…) and
// the AgentState record are shared with the main process (sprint-runtime-
// ownership Phase 2: main runs the auto-run planner). Canonical definitions —
// including all field documentation — live in
// `src/shared/sprintengine/run-types.ts` and
// `src/shared/agent-state.ts`; the imports pull in the names this
// module still references and the re-export blocks below keep every existing
// renderer import site working unchanged, mirroring the automation-types
// re-export at the bottom of the Sprint Engine section.
import type {
  AgentCli,
  AgentId,
  SprintEngineRoleSettings,
  SprintEngineRosterSessions,
  SprintEngineRunSettings,
  SprintEngineSourceBundleItem,
  SprintEngineSourcePlanKind,
} from '../../../shared/sprintengine/run-types'
import type {
  AgentConversationRuntime,
  AgentState,
  McpServerConfig,
  McpSettings,
  SpecialistActionId,
} from '../../../shared/agent-state'

export type {
  AgentCli,
  AgentId,
  SprintEngineAgentMetrics,
  SprintEngineArchitectDifficulty,
  SprintEngineArtifact,
  SprintEngineEvent,
  SprintEngineFeedbackAnalysisData,
  SprintEngineMockConfig,
  SprintEngineProjectionSource,
  SprintEngineRole,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
  SprintEngineRoleId,
  SprintEngineRoleModelOverrides,
  SprintEngineRoleReasoningOverrides,
  SprintEngineRoleRegistry,
  SprintEngineRoleRegistryMetadata,
  SprintEngineRoleSettings,
  SprintEngineRosterSession,
  SprintEngineRoster,
  SprintEngineRunnerPolicy,
  SprintEngineRunSettings,
  SprintEngineRuntimeAgent,
  SprintEngineRuntimeAgentStatus,
  SprintEngineSavedRoster,
  SprintEngineSource,
  SprintEngineSourceBundleItem,
  SprintEngineSourceBundleStateItem,
  SprintEngineSourcePlanKind,
  SprintEngineState,
  SprintEngineTask,
  SprintEngineTaskActivityEntry,
  SprintEngineTaskActivityType,
  SprintEngineTaskBoardColumn,
  SprintEngineTaskDiff,
  SprintEngineTaskDiffLine,
  SprintEngineTaskEvidence,
  SprintEngineTaskFeedback,
  SprintEngineTaskFeedbackFinding,
  SprintEngineTaskFeedbackFindingSeverity,
  SprintEngineTaskFeedbackIssue,
  SprintEngineTaskFeedbackScores,
  SprintEngineTaskStatus,
  SprintEngineVcs,
  SprintEngineWorkspaceContext,
} from '../../../shared/sprintengine/run-types'

export type {
  AgentConversationRuntime,
  AgentExecution,
  AgentExecutionMode,
  AgentKind,
  AgentRuntimeKind,
  AgentState,
  McpServerConfig,
  McpSettings,
  SpecialistActionId,
} from '../../../shared/agent-state'
export type WorkspaceId = string
export type WorkspaceWindowId = string
export const STANDARD_WORKSPACE_MODE = 'standard'

export type BundledWorkspaceMode =
  | typeof STANDARD_WORKSPACE_MODE
  | typeof AUTOMATIONS_HOST_WORKSPACE_MODE

// Lifted to the shared layer so shared contracts can name the mode without
// importing the renderer; `STANDARD_WORKSPACE_MODE` is its `'standard'` member.
// The remaining bundled rail-hidden mode (automations-host) lives there too,
// beside `isModeHiddenFromRail`. Module-registered types that hide from the
// rail set `WorkspaceTypeDefinition.hiddenFromRail` instead. Imported here
// (so this module's own references resolve) and re-exported so every existing
// import site keeps resolving here.
import {
  AUTOMATIONS_HOST_WORKSPACE_MODE,
  type WorkspaceMode,
} from '../../../shared/workspace-mode'
export { AUTOMATIONS_HOST_WORKSPACE_MODE }
export type { WorkspaceMode }

export type HighlightColor = 'red' | 'orange' | 'amber' | 'green' | 'blue' | 'purple' | 'pink'

export type WorkspaceHighlight = {
  starred: boolean
  color: HighlightColor | null
}

/**
 * The hue a project's folder glyph wears: a whole degree on the OKLCH wheel,
 * 0 to 359 (owner, 2026-09-09; hashed from the project's name since
 * 2026-09-11). Lightness and chroma are design tokens, so the angle is the only
 * thing that varies between projects.
 *
 * Declared here, beside HighlightColor and for the same reason: AppSettings is
 * shared with main (tsconfig.node lists this file and nothing else out of the
 * renderer), so the type has to live somewhere main can reach. The hash, the
 * guards and the picker's presets are utils/projectColor.ts, which re-exports
 * these two names.
 */
export type ProjectColor = number

/**
 * What is stored per project, and only when the person chose it: a hue, or
 * `'none'` for "no colour". A project with no entry wears its hashed hue.
 */
export type ProjectColorSetting = ProjectColor | 'none'

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
  CliPermissionPreset,
} from '../../../shared/sprintengine/automation-types'

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

type WorktreeEntryStatus = 'available' | 'assigned' | 'missing' | 'removing' | 'error'

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
type CliAvailability = {
  cli: AgentCli
  installed: boolean
  resolvedPath: string | null
  version: string | null
}

export type AgentCliAvailabilityMap = Record<AgentCli, CliAvailability>

export type McpServerListing = Omit<McpServerConfig, 'enabled' | 'scope' | 'source'> & {
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
import type { TextGenerationSettings } from '../../../shared/text-generation/contract'

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
   * Whether, and on which of the person's own agent CLIs, small pieces of
   * text are written by a model instead of a heuristic — today the chat
   * title from a first prompt. Runs under the CLI's own login, never an API
   * key, and the heuristic stands whenever this is off, no supported CLI is
   * installed, or the call fails. `engine: null` means the first supported
   * installed CLI at its cheap default (see TEXT_GENERATION_BACKENDS).
   */
  textGeneration: TextGenerationSettings
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
  lastAgentSpawnPermissionPreset: CliPermissionPreset
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
  projectKnowledgeRoots: Record<string, string | null>
  /**
   * The colours a person chose for projects' folder glyphs, keyed by
   * `projectColorKey` (utils/projectColor) — the canonical repository key when
   * the folder has a remote, else the normalised folder path.
   *
   * Overrides only. A project with no entry wears the hue hashed from its key,
   * which is the same on every machine; an entry is a hue the person picked or
   * `'none'` for "no colour", and is this machine's alone.
   */
  projectColors: Record<string, ProjectColorSetting>
  recentWorkspaceFolders: string[]
  /**
   * The project the Design door is showing, chosen with its own project chip.
   *
   * The door opens from the Extensions drawer, which is global: without this it
   * bound to whichever workspace happened to be focused last, so pointing the
   * app at another folder made it claim knowledge of a project the user never
   * chose (owner, 2026-09-07). It is a VIEWING scope and nothing else — what an
   * agent is told about a design system still comes from the presence of
   * `design-system/` in its own execution root, so browsing project B here can
   * never change what an agent in project A is told.
   *
   * Null (the default) means "follow the active workspace", which is also where
   * a stored folder that has since gone lands.
   */
  designProjectScopePath: string | null
  /**
   * When the Design door last SHOWED each design system: bundle id → ISO.
   *
   * The bundle id is `designSystemRegistrationId(path)` — the library's own
   * stable key for a folder, so the attached in-project copy and the same folder
   * registered in the library are one bundle here, which is what they are.
   *
   * It is what "New" is measured against: an entry that arrived after this
   * stamp is marked, and opening the bundle re-stamps it so the next visit is
   * clean. Per MACHINE, deliberately — this is a fact about what this person has
   * looked at on this computer, not about the bundle, and it must never be
   * written into a folder someone else authored.
   *
   * `{}` (the default) means nothing has been opened yet, and a bundle absent
   * from the map has never been seen: everything in it is treated as already
   * seen except what arrived inside the last thirty days, so a fresh profile
   * pointed at a five-year-old repo surfaces this week rather than every week.
   */
  designSystemSeen: Record<string, string>
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
   * Keep the app running when its last window closes, on every platform
   * (MC-2156). Off by default, which is byte-for-byte the pre-MC-2156 rule:
   * quit on Windows/Linux, survive on macOS. On, the process stays up with a
   * tray presence, so sprint runs, the scheduler and the Studio gateway keep
   * working with no window open. Mirrored to main (`setBackgroundMode`), which
   * reads it at last-window-close when no renderer is left to ask.
   */
  keepRunningInBackground: boolean
  /**
   * Share anonymous usage data. On by default; the switch a user flips to opt
   * out of product telemetry.
   *
   * Mirrored to main (`setTelemetryEnabled`), which is the only process that
   * sends anything — the renderer neither holds the project key nor records
   * events, so turning this off here is a push, not a local suppression. What
   * may be collected, and the environment kill switch that outranks this
   * setting, are both in `src/shared/telemetry.ts`.
   */
  telemetryEnabled: boolean
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

export type DiagnosticLevel = 'info' | 'warning' | 'error'
export type DiagnosticSource =
  | 'auth'
  | 'automations'
  | 'cli'
  | 'filesystem'
  | 'marketplace'
  | 'models'
  | typeof SPRINT_ENGINE_WORKSPACE_MODULE_ID
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
  /**
   * The Extensions drawer row this news belongs to (`ExtensionsDrawerRowId`:
   * workflows, sprints, design, plugins, skills, agent-clis), when the emitter
   * knows. Absent, the row is read off `source` (`extensionsRowOfNotification`).
   * A string rather than the row type because this shape is shared with the
   * main process and persists to localStorage; unknown values fall back to the
   * source rule.
   */
  extensionsRow?: string
}

export type DiagnosticLogEntry = DiagnosticLogInput & {
  id: string
  timestamp: string
  logPath?: string
}

export type AppNotification = DiagnosticLogEntry & {
  read: boolean
}

type OpenFile = {
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

// What a folder IS, as declared through "Mark Directory As". Canonically defined here, beside the state that
// persists it, for the same reason BacklogView is: the node tsconfig project
// sees this module, and the renderer-only util that owns the behaviour
// (utils/folderRoles.ts, which re-exports this as FolderRole) it does not.
export type WorkspaceFolderRole =
  | 'sources'
  | 'test-sources'
  | 'resources'
  | 'test-resources'
  | 'generated'
  | 'excluded'

export type WorkspaceFileExplorerState = {
  expandedPaths: string[]
  // Absolute folder path -> the role declared ON it. Descendants inherit and
  // are never stored, so this stays as small as the number of folders actually
  // marked — a handful, against a tree of thousands.
  folderRoles?: Record<string, WorkspaceFolderRole>
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
  // Diff only: the repository the viewer reads, the file it opened on, and
  // which side. `repoRoot` is the opener's repository — the Git panel's active
  // scope, which is not always the workspace's own worktree — and the pane
  // honours it rather than re-deriving one; absent, the workspace's worktree
  // is the repository (a Diff tab opened from the pane's own + menu).
  diff?: {
    repoRoot?: string
    focusPath: string | null
    focusKind: 'staged' | 'unstaged' | null
    /** Filter the viewer to one changelist (`agent:<agentId>`); absent = all. */
    changelistId?: string
  }
  // Browser only: the device toolbar's viewport; absent means fill.
  viewport?: BrowserViewport
  // Browser only: where the floating player sits, in viewport pixels. Persisted
  // — the rect is the thing worth remembering across a restart. Keyed on the
  // TAB rather than the workspace so two agents floating previews do not fight
  // over one rectangle: a floating player is keyed per thread, and a tab is this
  // app's equivalent grain now that agents hold tabs of their own.
  float?: { x: number; y: number; width: number; height: number }
  // Browser only: whether the tab is floating right now. Session-only —
  // partialize strips it, because a cold start showing a collapsed pane and a
  // window floating over the workspace is a confusing first frame, and the
  // spec only promises the RECT across restarts.
  floating?: boolean
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
 * runs instead carry their worktree on the sprintengine bag's `vcs`; both are
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
 * The `sprintengine` entry is a wrapped `SprintEngineModuleState`: durable
 * identity (`context`, `roleCliDefaults`) persists in the bag; the live run
 * projection (`state`) is a cache of on-disk projection.json and is stripped
 * at partialize. Readers use `getWorkspaceModuleState` / the sprintengine
 * accessors; a one-time persist hoist (store v76) is marked for deletion
 * with the in-tree engine.
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
  // `sprintengine` entry is the canonical SprintEngineModuleState.
  moduleState?: WorkspaceModuleStateBag
  // Durable per-agent CLI session records, keyed by roster agent id. Populated
  // when a sprint agent gets a live session and just before completion teardown
  // removes its panel, so a role can be re-opened later and resumed. Survives
  // panel removal and app restart (persisted alongside role CLI defaults).
  sprintEngineRosterSessions?: SprintEngineRosterSessions
  // Roster agents the user explicitly asked to start when the workspace
  // opens (new-workspace "Start now" intent). Session-only launch intent:
  // consumed by the Sprint Engine board on first ready render and stripped
  // at persist so an app restart never replays the spawns.
  sprintEngineInitialSpawnAgentIds?: AgentId[]
  sprintEngineAutoState: SprintEngineAutoState
  highlight?: WorkspaceHighlight
  createdAt: number
  lastTerminalActivityAt?: number | null
  // When the person last SENT A MESSAGE to an agent in this chat — the
  // `UserPromptSubmit` hook, mirrored off the session snapshots' `lastPrompt`
  // by WorkspaceManager. Monotonic like the clocks around it.
  //
  // This is the sidebar's ordering key (`workspaceLastUserMessageAt`), and the
  // reason it exists apart from `lastTerminalActivityAt`: that one moves on
  // every keystroke — an arrow key, a `y` at a permission prompt, a `git log`
  // in a plain shell — so the list reordered under the cursor of someone who
  // had not said anything. A submitted message is the one event a person
  // performs on purpose and expects to reorder their chats.
  //
  // Absent until the first prompt, and for a runtime whose reporter forwards
  // none (a plain shell, a hookless CLI) — for those rows the ordering key
  // falls back to `workspaceLastWorkedAt`, which is all that is knowable.
  lastUserMessageAt?: number | null
  // When an agent in this workspace last finished a turn (hook-reported Stop),
  // monotonic like `lastTerminalActivityAt`. The sidebar's idle time for a
  // parked chat with no live session, so it says when the agent finished
  // rather than when the person last typed — or nothing.
  lastTurnEndedAt?: number | null
  // When set, the chat has come to rest: it renders as a compact row in its
  // folder's Settled shelf rather than in the active list. Set by the
  // sidebar's reconcile sweep after three idle days, or by hand from the row
  // menu; cleared by input into the chat, by the agent working or blocking
  // on input again, or by hand. Settling kills the chat's terminals (owner
  // ruling 2026-09-07) — the agent record, its CLI session id and the run
  // state are untouched, so opening the chat resumes it. See
  // `utils/workspaceSettle.ts`. The
  // retired `archivedAt` (the startup archive sweep, gone 2026-09-07) heals
  // into this on registry read.
  settledAt?: number | null
  // A hand decision about rest that outranks the sweep. `'settled'` is a
  // manual Settle; `'active'` is a manual Un-settle, which holds the row in
  // the active list until new input into it clears it — otherwise
  // the sweep would settle it straight back on its next tick. The sweep never
  // touches a row carrying either value.
  settledOverride?: 'settled' | 'active' | null
  // When set, the chat is asleep until this instant: it renders in its folder's
  // Snoozed shelf rather than in the active list, wearing the countdown to its
  // wake. Set from the row menu's Snooze presets; cleared by opening the chat,
  // by Wake, and by settling.
  //
  // Snoozing SUSPENDS the chat's terminals, so a sleeping chat sits like every
  // other non-live chat — no agent process — and the wake returns the row with
  // them still paused; the person's first keystroke resumes the agent with
  // `--resume`. Suspend and not kill is the difference from `settledAt`, which
  // drops the ptys for good: a snoozed chat is coming back on a known clock.
  //
  // Nothing schedules that wake — a row is asleep while this stamp is in the
  // future and awake when it is not, so a wake missed while the app was closed
  // simply never happens. See `utils/workspaceSnooze.ts`.
  snoozedUntil?: number | null
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
  // The agent whose terminal was last selected in this workspace's layout
  // (agent changelists, Wave 4). It is the DEFAULT the Diff surfaces open on:
  // a Diff tab asked for with no file and no changelist shows that agent's
  // changelist, because "show me the diff" in a workspace where an agent has
  // been working means that agent's diff far more often than it means the
  // whole repository's.
  //
  // Only a default, and only when the list is really there: the helper that
  // reads it (`utils/diffChangelistDefault.ts`) checks the repository's lists
  // first, so an agent that exited and had its list reconciled away leaves the
  // Diff tab unfiltered rather than empty.
  //
  // Null once nothing qualifies; absent on every workspace written before the
  // field existed, which reads the same way. Persisted like its siblings — it
  // is a remembered choice, and forgetting it on every restart would make the
  // first Diff of a session the one that never obeys.
  lastActiveAgentId?: string | null
}
