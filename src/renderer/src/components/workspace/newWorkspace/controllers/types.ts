import type {
  AgentCli,
  AgentId,
  GuidedBriefHasUi,
  GuidedBriefPreset,
  GuidedBriefRuntimeState,
  LayoutTemplate,
  MultiloopAutoState,
  MultiloopState,
  MultiloopWorkspaceContext,
  SprintEngineAutoState,
  SprintEngineCliPermissionPreset,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
  SprintEngineRoleId,
  SprintEngineRoleModelOverrides,
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

export type MultiloopInitializeStatePort = (
  input: MultiloopInitInput,
) => Promise<MultiloopInitResult>

export type AddWorkspacePort = (
  template: LayoutTemplate,
  options?: {
    name?: string
    folderPath?: string | null
    sprintEngineState?: SprintEngineState | null
    sprintEngineContext?: SprintEngineWorkspaceContext | null
    multiloopState?: MultiloopState | null
    multiloopContext?: MultiloopWorkspaceContext | null
    sprintEngineRoleCliDefaults?: SprintEngineRoleCliDefaults | null
    sprintEngineAgentCliOverrides?: Record<AgentId, AgentCli> | null
    sprintEngineRoleModelOverrides?: SprintEngineRoleModelOverrides | null
    sprintEngineInitialSpawnRoles?: SprintEngineRoleId[] | null
    sprintEngineAutoState?: Partial<SprintEngineAutoState> | null
    multiloopAutoState?: Partial<MultiloopAutoState> | null
    guidedBriefState?: GuidedBriefRuntimeState | null
    mode?: WorkspaceMode
    windowId?: WorkspaceWindowId | null
  }
) => WorkspaceId

export type MultiloopControllerInput = {
  folderPath: string
  workspaceName: string
  loopName: string
  finalGoal: string
  cliPermissionPreset: SprintEngineCliPermissionPreset
  workspaceWindowId?: WorkspaceWindowId | null
}

export type MultiloopControllerPorts = {
  initializeMultiloopState: MultiloopInitializeStatePort
  readFile: (path: string) => Promise<string>
  addWorkspace: AddWorkspacePort
  createMultiloopTemplate: () => LayoutTemplate
}

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
  cliPermissionPreset: SprintEngineCliPermissionPreset
  workspaceWindowId?: WorkspaceWindowId | null
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
