import { lazy } from 'react'
import type { RendererHost } from './renderer-host'
import type {
  AgentCli,
  AgentId,
  LayoutTemplate,
  SprintEngineAutoState,
  SprintEngineCliPermissionPreset,
  SprintEngineMockConfig,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
  SprintEngineRoleId,
  SprintEngineRoleModelOverrides,
  SprintEngineRoleReasoningOverrides,
  SprintEngineSourceBundleItem,
  SprintEngineSourcePlanKind,
  SprintEngineState,
  SprintEngineWorkspaceContext,
  WorkspaceMode,
  WorkspaceWindowId,
} from '../types/workspace'
import type {
  SprintEngineArtifactCommandResult,
  SprintEngineStateInitializeInput,
} from '../../../shared/sprintengine/ipc-types'
import type { SprintEngineIntake } from '../../../shared/sprintengine/run-types'
import {
  createSprintEngineLayoutTemplate,
  type SprintEngineModuleState,
} from '../../../shared/sprintengine/workspace-record'

export type { SprintEngineModuleState } from '../../../shared/sprintengine/workspace-record'
export type {
  AgentCli,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
  SprintEngineRoleId,
  SprintEngineRoleModelOverrides,
  SprintEngineRoleReasoningOverrides,
  SprintEngineRoster,
  SprintEngineRoleRegistry,
} from '../types/workspace'
import { SprintEngineWorkspaceTypeIcon } from '../components/AppIcons'
import { deriveSprintEngineRunGlyph } from '../utils/sprintengine'
import { isSprintEngineWorkspace } from '../utils/sprintEngineWorkspace'
import type { WorkspaceRunGlyph, WorkspaceRunGlyphProviderInput } from '../utils/workspaceRunGlyph'
import { sprintEngineRunState } from '../store/slices/workspaceModuleState'

const SprintEngineProjectionSupervisor = lazy(() => import('../components/workspace/SprintEngineProjectionSupervisor'))
const SprintEngineRunChangeSubscriber = lazy(() => import('../components/workspace/SprintEngineRunChangeSubscriber'))

const defaultSprintEngineTemplateConfig: SprintEngineMockConfig = {
  name: 'Sprint Roster',
  goal: '',
  roleCounts: {} as SprintEngineMockConfig['roleCounts'],
}

// The layout itself lives in `shared/sprintengine/workspace-record.ts` (MC-2160)
// so a headlessly minted sprint workspace and a window-minted one record the
// same template id and board tab. The config has never shaped the layout.
export function createSprintEngineTemplate(_config: SprintEngineMockConfig): LayoutTemplate {
  return createSprintEngineLayoutTemplate()
}

// A sprint's run glyph is a pure function of sprint state — the task board plus
// the AutoRun runtime (see deriveSprintEngineRunGlyph). Terminals are ephemeral
// and deliberately excluded: a single agent terminal sitting at a prompt must
// not light the whole sprint. The rollup already covers a manually-completed run
// (all tasks done → `done`), so there is nothing terminal-derived to fold in.
function deriveSprintEngineWorkspaceRunGlyph(
  workspace: WorkspaceRunGlyphProviderInput,
): WorkspaceRunGlyph | null {
  return deriveSprintEngineRunGlyph({
    sprintEngineState: sprintEngineRunState(workspace),
    autoState: workspace.sprintEngineAutoState,
  })
}

export function registerSprintEngineWorkspaceTypes(host: RendererHost): void {
  host.registerWorkspaceType({
    id: 'sprintengine',
    label: 'Sprint',
    description: 'Inbox, Agents, and Tasks together in one stable board.',
    icon: SprintEngineWorkspaceTypeIcon,
    accentToken: '--tool-sprintengine',
    searchTerms: ['sprint engine', 'sprintengine', 'roster', 'kanban', 'evidence'],
    createTemplate: () => createSprintEngineTemplate(defaultSprintEngineTemplateConfig),
    isRunGlyphProviderForWorkspace: isSprintEngineWorkspace,
    deriveRunGlyph: deriveSprintEngineWorkspaceRunGlyph,
    // Projection refresh and the quiesced-run change subscriber used to be
    // propful mounts in WorkspaceManager (they needed the window's workspace
    // list). They now read that list from the store themselves, so they ship
    // as zero-prop WorkspaceTypeDefinition.supervisors. Auto-run scheduling
    // still lives in the main-process scheduler; these only keep this
    // window's bag projection current.
    supervisors: [
      { Component: SprintEngineProjectionSupervisor, scope: 'all-windows' },
      { Component: SprintEngineRunChangeSubscriber, scope: 'all-windows' },
    ],
    // Sprint creation left the wizard (MC-2062): picking this type anywhere —
    // the hub rail, the sidebar "+" menu — opens the New sprint dialog, never
    // a wizard flow. There is no sprint creation flow, so no creationStepsId:
    // the type registers for the sake of existing sprint workspaces, and the
    // hub reroutes any selection of it to the dialog.
    pickerOrder: 20,
  })
  // The `roadmap` workspace type retired (MC-1692) and its door was deleted on
  // 2026-09-05, so nothing registers it. The plans it steered are still files
  // under the home project's `backlog/roadmaps/`.
}

// Create-time request types (MC-2573). The type's `createWorkspace` hook
// (MC-2577) is the writer; this item defines the payload that hook consumes.
// Durable identity lands in `sprintEngineModule`; live projection is the
// `state` field of that bag entry.

export type OnCreateArgs = {
  template: LayoutTemplate
  name: string
  folderPath: string | null
  sprintEngineModule?: SprintEngineModuleState | null
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

export function sprintEngineModuleFromCreatedRun(created: {
  sprintEngineState: SprintEngineState
  sprintEngineContext: SprintEngineWorkspaceContext | null
  roleCliDefaults: SprintEngineRoleCliDefaults
}): SprintEngineModuleState {
  return {
    state: created.sprintEngineState,
    context: created.sprintEngineContext,
    roleCliDefaults: created.roleCliDefaults,
  }
}
