import type {
  AgentCli,
  AgentId,
  GuidedBriefHasUi,
  GuidedBriefPreset,
  GuidedBriefRuntimeState,
  LayoutTemplate,
  SprintEngineAutoState,
  SprintEngineCliPermissionPreset,
  SprintEngineAllowedRuntime,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
  SprintEngineRoleId,
  SprintEngineRoleModelOverrides,
  SprintEngineRosterSource,
  SprintEngineSourceBundleItem,
  SprintEngineSourcePlanKind,
  SprintEngineState,
  SprintEngineWorkspaceContext,
  WorkspaceId,
  WorkspaceWindowId,
  WorkspaceMode,
} from '../../../../types/workspace'
import type {
  PlanSourcedSprintEngineWorkspaceArgs,
  PlanSourcedSprintEngineWorkspaceResult,
} from '../../../../utils/sprintengineWorkspaceCreation'
import type { SprintEngineArtifactCommandResult, SprintEngineStateInitializeInput } from '../../../../../../shared/electron-api'

export type OnCreateArgs = {
  template: LayoutTemplate
  name: string
  folderPath: string | null
  sprintEngineState?: SprintEngineState | null
  sprintEngineContext?: SprintEngineWorkspaceContext | null
  sprintEngineRoleCliDefaults?: SprintEngineRoleCliDefaults | null
  sprintEngineAgentCliOverrides?: Record<AgentId, AgentCli> | null
  sprintEngineRoleModelOverrides?: SprintEngineRoleModelOverrides | null
  sprintEngineInitialSpawnRoles?: SprintEngineRoleId[] | null
  sprintEngineAutoState?: Partial<SprintEngineAutoState> | null
  guidedBriefState?: GuidedBriefRuntimeState | null
  mode?: WorkspaceMode
}

/**
 * What each mode controller returns. `on-create` modes hand the args back to
 * the wizard so it can call `onCreate` (which the host uses to wire up the
 * workspace); `self-created` modes already wrote workspace state into the
 * store, and the wizard only needs to run the post-creation chrome.
 */
export type CreationResult =
  | { kind: 'on-create'; args: OnCreateArgs }
  | { kind: 'self-created' }

export type GuidedBriefFilesystemPort = {
  ensureDir: (parent: string, name: string) => Promise<string>
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, content: string) => Promise<void>
}

export type PathExists = (path: string) => Promise<boolean>

export type AddWorkspacePort = (
  template: LayoutTemplate,
  options?: {
    name?: string
    folderPath?: string | null
    sprintEngineState?: SprintEngineState | null
    sprintEngineContext?: SprintEngineWorkspaceContext | null
    sprintEngineRoleCliDefaults?: SprintEngineRoleCliDefaults | null
    sprintEngineAgentCliOverrides?: Record<AgentId, AgentCli> | null
    sprintEngineRoleModelOverrides?: SprintEngineRoleModelOverrides | null
    sprintEngineInitialSpawnRoles?: SprintEngineRoleId[] | null
    sprintEngineAutoState?: Partial<SprintEngineAutoState> | null
    guidedBriefState?: GuidedBriefRuntimeState | null
    mode?: WorkspaceMode
    windowId?: WorkspaceWindowId | null
  }
) => WorkspaceId

export type SprintEngineExistingTeamInput = {
  folderPath: string | null
  existingTeam: {
    slug: string
    displayName: string
    context: SprintEngineWorkspaceContext
    state: SprintEngineState
  }
  roleCliDefaults: Required<SprintEngineRoleCliDefaults>
  agentCliOverrides: Record<AgentId, AgentCli>
  roleModelOverrides?: SprintEngineRoleModelOverrides | null
  initialSpawnRoles?: SprintEngineRoleId[] | null
  startRunner: boolean
  autoApproveArtifacts: boolean
  cliPermissionPreset: SprintEngineCliPermissionPreset
  workspaceWindowId?: WorkspaceWindowId | null
}

export type SprintEngineNewTeamInput = {
  folderPath: string | null
  teamName: string
  goal: string
  roleCounts: SprintEngineRoleCounts
  visibleRoleCounts: SprintEngineRoleCounts
  // Workspace-level cap on concurrent agent sessions (MC-1450: replaces the
  // roster-size-derived ceiling). Clamped 1-10 by the consumer; default 3.
  maxParallelAgents: number
  roleCliDefaults: Required<SprintEngineRoleCliDefaults>
  roleModelOverrides?: SprintEngineRoleModelOverrides | null
  initialSpawnRoles?: SprintEngineRoleId[] | null
  startRunner: boolean
  autoApproveArtifacts: boolean
  useWorktrees?: boolean
  // The other projects this run also works in (MC-1613, restored by item 1765 as
  // the wizard's "Also works in" field), each `{id, root}` with a root relative to
  // the workspace folder. Forwarded verbatim to init as `--repo`. Requires
  // useWorktrees — the controller drops the list without it — and is omitted for a
  // run in a single project. Projects nobody foresaw still join a running sprint
  // through `sprintengine.vcs.request_repo`.
  repos?: Array<{ id: string; root: string }>
  cliPermissionPreset: SprintEngineCliPermissionPreset
  workspaceWindowId?: WorkspaceWindowId | null
  // "Architect picks the team" fields. When rosterSource is 'architect' the
  // controller seats only the architect (roleCounts/enabledRoles collapse to
  // ['architect']), pins its runtime from `architectSeat`, forwards the ticked
  // `allowedRuntimes` palette to init, and records the prompt-only guidance on
  // auto state. Absent/'user' keeps the wizard-composed roster untouched.
  rosterSource?: SprintEngineRosterSource
  architectSeat?: SprintEngineAllowedRuntime
  allowedRuntimes?: SprintEngineAllowedRuntime[]
  architectGuidance?: string
  // MC-1543 "Workflow steps" panel. Each is pre-computed by the wizard and
  // forwarded verbatim into the run init; each is present ONLY when it diverges
  // from the engine default, so a plain run sends none of them.
  defaultPhases?: string[]
  phaseRuntimes?: Record<string, { cli: string; model: string | null }>
}

export type SprintEngineNewTeamPorts = {
  pathExists?: PathExists
  initializeSprintEngineState: (
    input: SprintEngineStateInitializeInput
  ) => Promise<SprintEngineArtifactCommandResult>
}

export type SprintEnginePlanSourcedInput = {
  folderPath: string | null
  teamName: string
  goal: string
  sourcePlanPath: string
  sourcePlanRelativePath: string | undefined
  sourcePlanContent: string | null
  sourcePlanKind: SprintEngineSourcePlanKind
  sourceBundle: SprintEngineSourceBundleItem[] | null
  visibleRoleCounts: SprintEngineRoleCounts
  // Workspace-level cap on concurrent agent sessions (MC-1450). Clamped 1-10.
  maxParallelAgents: number
  roleCliDefaults: Required<SprintEngineRoleCliDefaults>
  roleModelOverrides?: SprintEngineRoleModelOverrides | null
  initialSpawnRoles?: SprintEngineRoleId[] | null
  startRunner: boolean
  autoApproveArtifacts: boolean
  useWorktrees?: boolean
  // No `repos` here on purpose (item 1765): a launch sourced from a backlog item,
  // an epic, or the roadmap orchestrator runs in that item's own project, and the
  // "Also works in" field is withheld for those paths. Such a run brings another
  // project in through `sprintengine.vcs.request_repo` when an agent finds it needs
  // one.
  // "Workflow steps" run-init keys (MC-1543), same contract as
  // SprintEngineNewTeamInput: forwarded verbatim, each present ONLY when it
  // diverges from the engine default.
  defaultPhases?: string[]
  phaseRuntimes?: Record<string, { cli: string; model: string | null }>
  // Record file-backed sources as project-root-relative references (no copy).
  sourceReference?: boolean
  // For an epic launch: the project-root-relative paths of the epic's child items,
  // flipped to `in_progress` at launch so every row shows the sprint immediately.
  epicChildRelativePaths?: string[]
  cliPermissionPreset: SprintEngineCliPermissionPreset
  workspaceWindowId?: WorkspaceWindowId | null
}

export type SprintEnginePlanSourcedPorts = {
  pathExists: PathExists
  initializeSprintEngineState?: (
    input: SprintEngineStateInitializeInput
  ) => Promise<SprintEngineArtifactCommandResult>
  recordBacklogExecutionLink?: (input: {
    workspaceRoot: string
    sourceRelativePath: string
    teamSlug: string
    statePath: string
    // Child items of an epic launch to also mark `in_progress` in the main checkout.
    childRelativePaths?: string[]
  }) => Promise<void>
}

export type GuidedBriefScaffoldInput = {
  folderPath: string | null
  workspaceName: string
  idea: string
  hasUi: GuidedBriefHasUi | null
  // Absent is treated as `full-brief`. `frontend-design` forces the design-only
  // path (UI implied, product/architecture skipped, start on the designer stage)
  // regardless of the discussion flags passed alongside it.
  preset?: GuidedBriefPreset
  wantsProduct: boolean
  wantsArchitecture: boolean
  wantsFrontend: boolean
  guidedRoleCliDefaults: import('../../../../types/workspace').GuidedBriefRoleCliDefaults
  guidedRoleModelOverrides?: import('../../../../types/workspace').GuidedBriefRoleModelOverrides
  buildRoleCounts: SprintEngineRoleCounts
  buildRoleCliDefaults: Required<SprintEngineRoleCliDefaults>
  buildCliPermissionPreset: SprintEngineCliPermissionPreset
  buildStartRunner: boolean
  buildAutoApproveArtifacts: boolean
}

export type GuidedBriefScaffoldPorts = {
  filesystem: GuidedBriefFilesystemPort
  /**
   * Read-only walker for the scaffold baseline (MC-1502): records every file
   * already under the preset's shared roots (`mockups/**`,
   * `product/ui-direction.md`) so run-scoped discovery can hide seed-repo
   * files. Required — a scaffold that cannot enumerate pre-existing files
   * would silently regress to leaking them into the studio index.
   */
  discovery: import('../../guidedBrief/designArtifacts').ScaffoldBaselinePort
}

export type GuidedBriefScaffoldResult = {
  runtimeState: GuidedBriefRuntimeState
}

// The design-system preset forces the design-only path (UI implied,
// product/architecture discussions off), so its scaffold input carries no
// hasUi or discussion flags.
export type DesignSystemScaffoldControllerInput = {
  folderPath: string | null
  workspaceName: string
  idea: string
  // Blank start when null/absent; otherwise the source the designer agent
  // extracts the starter bundle from (see DesignSystemSeedSource).
  seedSource?: import('../../../../types/workspace').DesignSystemSeedSource | null
  guidedRoleCliDefaults: import('../../../../types/workspace').GuidedBriefRoleCliDefaults
  guidedRoleModelOverrides?: import('../../../../types/workspace').GuidedBriefRoleModelOverrides
  buildRoleCounts: SprintEngineRoleCounts
  buildRoleCliDefaults: Required<SprintEngineRoleCliDefaults>
  buildCliPermissionPreset: SprintEngineCliPermissionPreset
  buildStartRunner: boolean
  buildAutoApproveArtifacts: boolean
}

export type DesignSystemScaffoldControllerPorts = {
  filesystem: GuidedBriefFilesystemPort
  /** Main-process bundle scaffold (design-system:scaffold-bundle IPC). */
  scaffoldBundle: (
    workspaceRoot: string,
    name: string,
    summary: string,
  ) => Promise<import('../../../../../../shared/design-system/bundle-scaffold').DesignSystemScaffoldResult>
}

export type GuidedBriefStartBuildInput = {
  runtimeState: GuidedBriefRuntimeState
  runOptions: {
    startRunner: boolean
    autoApproveArtifacts: boolean
    roleCounts: SprintEngineRoleCounts
    roleCliDefaults: Required<SprintEngineRoleCliDefaults>
    cliPermissionPreset: SprintEngineCliPermissionPreset
  }
  finalRoleCounts: SprintEngineRoleCounts
  rosterSummary: string[]
  planningDecisions: string[]
  planningValidationNotes: string[]
  buildHandoffRelativePath: string
  workspaceWindowId?: WorkspaceWindowId | null
}

export type GuidedBriefStartBuildPorts = {
  filesystem: GuidedBriefFilesystemPort
  pathExists: PathExists
  readArchitecturePlan: (workspaceRoot: string, path: string) => Promise<string>
  readBuildHandoff: (workspaceRoot: string, relativePath: string) => Promise<string>
  // Advanced-setup preflight (MCP sync + skill-pack install). Runs before any
  // handoff write or run/workspace creation so a failure fails closed: it
  // returns the actionable error message, and the controller aborts before the
  // first filesystem/run mutation. Returns null on success.
  persistAdvancedSetup: (workspaceRoot: string) => Promise<string | null>
  createPlanSourcedSprintEngineWorkspace?: (
    args: PlanSourcedSprintEngineWorkspaceArgs
  ) => Promise<PlanSourcedSprintEngineWorkspaceResult>
}

export type SprintEngineRoleLikeId = SprintEngineRoleId
