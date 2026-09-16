import type {
  AgentCli,
  AgentId,
  LayoutTemplate,
  SprintEngineAutoState,
  SprintEngineCliPermissionPreset,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
  SprintEngineRoleId,
  SprintEngineRoleModelOverrides,
  SprintEngineRoleReasoningOverrides,
  SprintEngineSourceBundleItem,
  SprintEngineSourcePlanKind,
  SprintEngineState,
  SprintEngineWorkspaceContext,
  WorkspaceWindowId,
  WorkspaceMode,
} from '../../../../types/workspace'
import type {
  SprintEngineArtifactCommandResult,
  SprintEngineStateInitializeInput,
} from '../../../../../../shared/sprintengine/ipc-types'
import type { SprintEngineIntake } from '../../../../../../shared/sprintengine/run-types'

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
  mode?: WorkspaceMode
}

type PathExists = (path: string) => Promise<boolean>

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
  // Per-role reasoning-effort level (MC-1885). Rides the same `roleRuntimes`
  // entry as the CLI/model pick; an absent role means the CLI's own default
  // effort, which passes no flag.
  roleReasoningOverrides?: SprintEngineRoleReasoningOverrides | null
  initialSpawnRoles?: SprintEngineRoleId[] | null
  startRunner: boolean
  autoApproveArtifacts: boolean
  useWorktrees?: boolean
  // Per-task worktrees (MC-2136): every task works in its own checkout branched
  // off the run branch. Layered on useWorktrees, which the engine requires.
  taskIsolation?: boolean
  // The other projects this run also works in (MC-1613, restored by item 1765 as
  // the wizard's "Also works in" field), each `{id, root}` with a root relative to
  // the workspace folder. Forwarded verbatim to init as `--repo`. Requires
  // useWorktrees — the controller drops the list without it — and is omitted for a
  // run in a single project. Projects nobody foresaw still join a running sprint
  // through `sprintengine.vcs.request_repo`.
  repos?: Array<{ id: string; root: string }>
  cliPermissionPreset: SprintEngineCliPermissionPreset
  workspaceWindowId?: WorkspaceWindowId | null
  // The run's post-implementation phase list, forwarded verbatim into the run
  // init and present ONLY when it diverges from the engine default, so a plain
  // run sends nothing.
  defaultPhases?: string[]
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
  // Per-role reasoning-effort level (MC-1885). Rides the same `roleRuntimes`
  // entry as the CLI/model pick; an absent role means the CLI's own default
  // effort, which passes no flag.
  roleReasoningOverrides?: SprintEngineRoleReasoningOverrides | null
  initialSpawnRoles?: SprintEngineRoleId[] | null
  startRunner: boolean
  autoApproveArtifacts: boolean
  useWorktrees?: boolean
  // Per-task worktrees (MC-2136): every task works in its own checkout branched
  // off the run branch. Layered on useWorktrees, which the engine requires.
  taskIsolation?: boolean
  // No `repos` here on purpose (item 1765): a launch sourced from a backlog
  // item or an epic runs in that item's own project, and the "Also works in"
  // field is withheld for those paths. Such a run brings another
  // project in through `sprintengine.vcs.request_repo` when an agent finds it needs
  // one.
  // The run's post-implementation phase list, same contract as
  // SprintEngineNewTeamInput: forwarded verbatim, present ONLY when it diverges
  // from the engine default.
  defaultPhases?: string[]
  // Record file-backed sources as project-root-relative references (no copy).
  sourceReference?: boolean
  // How this run gets its task graph (MC-2128/2129): the New sprint dialog's
  // Planning-agent row. Omit to let the engine apply its per-source default —
  // `direct` for an epic, `planned` for everything else.
  intake?: SprintEngineIntake
  // For an epic launch: the project-root-relative paths of the epic's child items,
  // flipped to `in_progress` at launch so every row shows the sprint immediately.
  epicChildRelativePaths?: string[]
  cliPermissionPreset: SprintEngineCliPermissionPreset
  workspaceWindowId?: WorkspaceWindowId | null
}

export type SprintEnginePlanSourcedPorts = {
  pathExists: PathExists
  // Advanced-setup preflight (MC-2124): it returns the actionable failure
  // message rather than throwing, and it runs
  // BEFORE any run/workspace mutation so a failure fails closed — creation
  // aborts instead of producing a run whose agents lack the tools app settings
  // declare. Returns null on success or when there was nothing to write.
  persistAdvancedSetup?: (workspaceRoot: string) => Promise<string | null>
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
