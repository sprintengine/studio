import { createSprintEngineTemplate } from '../../../../modules/sprint-engine-workspace-types'
import {
  createInitialSprintEngineState,
  normalizeSprintEngineProjection,
  sprintEngineEnabledRoles,
  sprintEnginePlannerRole,
} from '../../../../utils/sprintengine'
import {
  sprintEngineAutomationInitialStateForMode,
  sprintEngineAutomationModeForRunOptions,
} from '../../../../utils/sprintengineAutomationLifecycle'
import {
  PlanSourcedSprintEngineWorkspaceError,
  buildSprintEngineRoleRuntimes,
  createPlanSourcedSprintEngineWorkspace,
} from '../../../../utils/sprintengineWorkspaceCreation'
import { slugifySprintEngineName } from '../../../../utils/sprintengineStateFile'
import { buildSprintEngineContext } from '../useNewWorkspaceFolder'
import type {
  SprintEngineAutomationMode,
  SprintEngineRoleCounts,
  SprintEngineRoleId,
} from '../../../../types/workspace'
import type {
  OnCreateArgs,
  SprintEngineExistingTeamInput,
  SprintEngineNewTeamInput,
  SprintEngineNewTeamPorts,
  SprintEnginePlanSourcedInput,
  SprintEnginePlanSourcedPorts,
} from './types'

export class SprintEngineNewTeamCreationError extends Error {
  constructor(public readonly code:
    | 'missing-folder'
    | 'team-exists'
    | 'init-failed'
    | 'invalid-projection'
    | 'unknown'
  ) {
    super(code)
    this.name = 'SprintEngineNewTeamCreationError'
  }
}

export class SprintEnginePlanSourcedError extends Error {
  constructor(public readonly code:
    | 'missing-folder'
    | 'missing-plan-option'
    | 'missing-plan-content'
    | 'missing-team-name'
    | 'plan-not-on-disk'
    | 'team-exists'
    | 'unknown'
  ) {
    super(code)
    this.name = 'SprintEnginePlanSourcedError'
  }
}

function sprintEngineAutoStateFromRunOptions(input: {
  startRunner: boolean
  autoApproveArtifacts: boolean
}) {
  return sprintEngineAutomationInitialStateForMode(sprintEngineAutomationModeForRunOptions(input))
}

// Workspace-level cap on concurrent agent sessions (MC-1450). The supervisor
// re-clamps on read, so this only shapes what gets stored.
export const SPRINT_ENGINE_DEFAULT_MAX_PARALLEL_AGENTS = 3

export function clampSprintEngineMaxParallelAgents(value: number | null | undefined): number {
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed) || parsed < 1) return SPRINT_ENGINE_DEFAULT_MAX_PARALLEL_AGENTS
  return Math.max(1, Math.min(10, parsed))
}

export function buildSprintEngineEffectiveSpawnAtStartRoles(input: {
  automationMode: SprintEngineAutomationMode
  existingTeam: boolean
  visibleRoleCounts: SprintEngineRoleCounts
}): Partial<Record<SprintEngineRoleId, boolean>> {
  // Lazy roster: only the planner carries a start-at-launch intent — the general
  // in a general-default run, the architect when the selection staffs one. Worker
  // ids are minted task-scoped and reviewer ids register on first gate, so there
  // is no per-role "Start now" toggle — the planner just bootstraps a non-manual
  // new-team run so an agent is awake to plan it.
  if (input.automationMode !== 'manual' && !input.existingTeam) {
    return { [sprintEnginePlannerRole(input.visibleRoleCounts)]: true }
  }
  return {}
}

export function buildSprintEngineExistingTeamCreation(
  input: SprintEngineExistingTeamInput,
): OnCreateArgs {
  const { displayName, state, context } = input.existingTeam
  const loadedState = { ...state, name: displayName }
  const template = createSprintEngineTemplate({
    name: loadedState.name,
    goal: loadedState.goal,
    roleCounts: loadedState.roleCounts,
  })
  return {
    template,
    name: loadedState.name,
    folderPath: input.folderPath,
    sprintEngineState: loadedState,
    sprintEngineContext: context,
    sprintEngineRoleCliDefaults: input.roleCliDefaults,
    sprintEngineAgentCliOverrides: input.agentCliOverrides,
    sprintEngineRoleModelOverrides: input.roleModelOverrides ?? null,
    sprintEngineInitialSpawnRoles: input.initialSpawnRoles ?? null,
    sprintEngineAutoState: {
      ...sprintEngineAutoStateFromRunOptions(input),
      cliPermissionPreset: input.cliPermissionPreset,
      // MC-1450: the ceiling is a user knob, never derived from roster size.
      maxConcurrentAgents: SPRINT_ENGINE_DEFAULT_MAX_PARALLEL_AGENTS,
    },
  }
}

export function buildSprintEngineNewTeamCreation(
  input: SprintEngineNewTeamInput,
): OnCreateArgs {
  const sprintEngineConfig = {
    name: input.teamName.trim() || 'Sprint Roster',
    goal: input.goal.trim(),
    roleCounts: input.visibleRoleCounts,
  }
  const sprintEngineState = createInitialSprintEngineState(sprintEngineConfig)
  if (input.useWorktrees) {
    sprintEngineState.useWorktrees = true
  }
  const template = createSprintEngineTemplate(sprintEngineConfig)
  const sprintEngineContext = input.folderPath
    ? buildSprintEngineContext(
      input.folderPath,
      sprintEngineState.name,
      slugifySprintEngineName(sprintEngineState.name),
    )
    : null
  return {
    template,
    name: sprintEngineState.name,
    folderPath: input.folderPath,
    sprintEngineState,
    sprintEngineContext,
    sprintEngineRoleCliDefaults: input.roleCliDefaults,
    sprintEngineRoleModelOverrides: input.roleModelOverrides ?? null,
    sprintEngineInitialSpawnRoles: input.initialSpawnRoles ?? null,
    sprintEngineAutoState: {
      ...sprintEngineAutoStateFromRunOptions(input),
      cliPermissionPreset: input.cliPermissionPreset,
      maxConcurrentAgents: clampSprintEngineMaxParallelAgents(input.maxParallelAgents),
    },
  }
}

function parseInitializedSprintEngineState(
  input: unknown,
  fallbackName: string,
) {
  if (!input || typeof input !== 'object') return null
  const projectionContent = (input as { projectionContent?: unknown }).projectionContent
  if (typeof projectionContent !== 'string' || !projectionContent.trim()) return null
  try {
    return normalizeSprintEngineProjection(JSON.parse(projectionContent) as unknown, fallbackName)
  } catch {
    return null
  }
}

export async function runSprintEngineNewTeamCreation(
  input: SprintEngineNewTeamInput,
  ports: SprintEngineNewTeamPorts,
): Promise<OnCreateArgs> {
  if (!input.folderPath) throw new SprintEngineNewTeamCreationError('missing-folder')

  const args = buildSprintEngineNewTeamCreation(input)
  if (!args.sprintEngineContext || !args.sprintEngineState) {
    throw new SprintEngineNewTeamCreationError('missing-folder')
  }
  if (ports.pathExists && await ports.pathExists(args.sprintEngineContext.statePath)) {
    throw new SprintEngineNewTeamCreationError('team-exists')
  }

  try {
    const initResult = await ports.initializeSprintEngineState({
      statePath: args.sprintEngineContext.statePath,
      name: args.sprintEngineState.name,
      goal: args.sprintEngineState.goal,
      agents: args.sprintEngineState.sprintEngineAgents,
      tasks: args.sprintEngineState.tasks,
      events: args.sprintEngineState.events,
      artifacts: args.sprintEngineState.artifacts,
      useWorktrees: input.useWorktrees === true,
      // The other projects this run also works in (item 1765), declared here so a
      // multi-project run has every worktree the moment it initializes. Only ever
      // present alongside worktree mode — the engine refuses the pair, and the
      // wizard drops the selection when the toggle goes off. Mid-run additions
      // still arrive through `sprintengine.vcs.request_repo`; this is the set the
      // operator already knew about.
      ...(input.useWorktrees === true && input.repos && input.repos.length > 0
        ? { repos: input.repos }
        : {}),
      // Record the roster's per-role model selection so claimed tasks get
      // stamped with the model that worked them, and its effort level so every
      // spawn of the role launches at it (same as the plan-sourced path).
      roleRuntimes: buildSprintEngineRoleRuntimes(
        input.roleModelOverrides,
        input.roleCliDefaults,
        input.roleReasoningOverrides,
      ),
      // Persist the enabled role set (init `configuredRoles`, the run's legal
      // role set for plan.add_task/seating) covering the configured-but-not-
      // yet-seated roles under the lazy roster.
      enabledRoles: sprintEngineEnabledRoles(args.sprintEngineState.roleCounts),
      // The run's phase list. The wizard omits it when it is at its default, so
      // forward it only when actually set — a plain run stays byte-identical.
      ...(input.defaultPhases !== undefined ? { defaultPhases: input.defaultPhases } : {}),
    })
    if (!initResult.ok) {
      const wrapped = new SprintEngineNewTeamCreationError('init-failed')
      wrapped.message = initResult.message || 'Could not initialize sprint run state.'
      throw wrapped
    }

    const initializedState = parseInitializedSprintEngineState(
      initResult.data,
      args.sprintEngineState.name,
    )
    if (!initializedState) {
      throw new SprintEngineNewTeamCreationError('invalid-projection')
    }

    return {
      ...args,
      sprintEngineState: initializedState,
    }
  } catch (error) {
    if (error instanceof SprintEngineNewTeamCreationError) throw error
    const wrapped = new SprintEngineNewTeamCreationError('unknown')
    wrapped.message = error instanceof Error ? error.message : String(error)
    throw wrapped
  }
}

export async function runSprintEnginePlanSourcedCreation(
  input: SprintEnginePlanSourcedInput,
  ports: SprintEnginePlanSourcedPorts,
): Promise<void> {
  if (!input.folderPath) throw new SprintEnginePlanSourcedError('missing-folder')
  // For an epic, the epic file itself is the primary handover source and the
  // bundle holds its children. For every other launch the selected plan path is
  // the primary when the caller set one — a bundle may carry supporting items
  // (attached mockups, sibling docs) whose first entry must never displace the
  // selected source. Only a bundle-only launch (no plan path, e.g. a hand-picked
  // HTML mockup) promotes its first item to primary.
  const isEpicSource = input.sourcePlanKind === 'epic'
  const bundlePrimary = !isEpicSource && !input.sourcePlanPath
    ? (input.sourceBundle?.[0] ?? null)
    : null
  const optionRelativePath = bundlePrimary
    ? bundlePrimary.sourceRelativePath
    : input.sourcePlanRelativePath
  const optionPath = bundlePrimary ? bundlePrimary.sourcePath : input.sourcePlanPath
  if (!optionPath || !optionRelativePath) throw new SprintEnginePlanSourcedError('missing-plan-option')
  if (input.sourcePlanContent == null) throw new SprintEnginePlanSourcedError('missing-plan-content')
  if (!input.teamName.trim()) throw new SprintEnginePlanSourcedError('missing-team-name')

  if (!(await ports.pathExists(optionPath))) {
    throw new SprintEnginePlanSourcedError('plan-not-on-disk')
  }

  try {
    const result = await createPlanSourcedSprintEngineWorkspace({
      rootPath: input.folderPath,
      teamName: input.teamName,
      goal: input.goal,
      sourcePath: optionRelativePath,
      sourceContent: input.sourcePlanContent,
      sourcePlanKind: input.sourcePlanKind,
      sourceBundle: input.sourceBundle ?? undefined,
      roleCounts: input.visibleRoleCounts,
      roleCliDefaults: input.roleCliDefaults,
      roleModelOverrides: input.roleModelOverrides ?? null,
      roleReasoningOverrides: input.roleReasoningOverrides ?? null,
      initialSpawnRoles: input.initialSpawnRoles ?? null,
      // The run's phase list — forwarded exactly like the new-team path.
      ...(input.defaultPhases !== undefined ? { defaultPhases: input.defaultPhases } : {}),
      workspaceWindowId: input.workspaceWindowId,
      useWorktrees: input.useWorktrees === true,
      sourceReference: input.sourceReference === true,
      sprintEngineAutoState: {
        ...sprintEngineAutoStateFromRunOptions(input),
        cliPermissionPreset: input.cliPermissionPreset,
        maxConcurrentAgents: clampSprintEngineMaxParallelAgents(input.maxParallelAgents),
      },
      pathExists: ports.pathExists,
      initializeSprintEngineState: ports.initializeSprintEngineState,
    })
    if (ports.recordBacklogExecutionLink && optionRelativePath.startsWith('backlog/')) {
      await ports.recordBacklogExecutionLink({
        workspaceRoot: input.folderPath,
        sourceRelativePath: optionRelativePath,
        teamSlug: result.sprintEngineContext.teamSlug,
        statePath: result.sprintEngineContext.statePath,
        ...(isEpicSource
          ? { childRelativePaths: (input.epicChildRelativePaths ?? []).filter((path) => path.startsWith('backlog/')) }
          : {}),
      })
    }
  } catch (error) {
    if (error instanceof PlanSourcedSprintEngineWorkspaceError && error.code === 'team-exists') {
      throw new SprintEnginePlanSourcedError('team-exists')
    }
    if (error instanceof Error) {
      const wrapped = new SprintEnginePlanSourcedError('unknown')
      wrapped.message = error.message
      throw wrapped
    }
    throw new SprintEnginePlanSourcedError('unknown')
  }
}
