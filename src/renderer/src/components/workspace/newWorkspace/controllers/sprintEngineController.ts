import { createSprintEngineTemplate } from '../../../../modules/sprint-engine-workspace-types'
import {
  createInitialSprintEngineState,
  normalizeSprintEngineProjection,
  sprintEngineEnabledRoles,
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
  // Lazy roster: only the architect can carry a start-at-launch intent. Worker
  // ids are minted task-scoped and reviewer ids register on first gate, so there
  // is no per-role "Start now" toggle — the architect just bootstraps a
  // non-manual new-team run.
  if (
    input.automationMode !== 'manual'
    && !input.existingTeam
    && (input.visibleRoleCounts.architect ?? 0) > 0
  ) {
    return { architect: true }
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
      // Prompt-only "Guidance for the architect" (architect-roster runs only).
      // Rides auto state, not run.yaml — the engine never sees it.
      ...(input.rosterSource === 'architect' && input.architectGuidance?.trim()
        ? { architectGuidance: input.architectGuidance.trim() }
        : {}),
    },
  }
}

// The architect-roster init overrides: only the architect is seated, its runtime
// is pinned from the wizard seat picker, and the ticked palette becomes the run's
// allowedRuntimes. Returns null in user mode so the caller keeps its existing
// wizard-composed roster wiring untouched (byte-identical for rosterSource:'user').
function architectRosterInitOverrides(input: SprintEngineNewTeamInput): {
  roleRuntimes: Record<string, { model?: string | null; cli?: string | null }>
  enabledRoles: string[]
  rosterSource: 'architect'
  allowedRuntimes: Array<{ cli: string; model: string | null }>
} | null {
  if (input.rosterSource !== 'architect') return null
  const seat = input.architectSeat
  return {
    roleRuntimes: seat
      ? { architect: { cli: seat.cli, model: seat.model } }
      : {},
    enabledRoles: ['architect'],
    rosterSource: 'architect',
    allowedRuntimes: input.allowedRuntimes ?? [],
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

  const architectOverrides = architectRosterInitOverrides(input)

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
      // Record the roster's per-role model selection so claimed tasks get
      // stamped with the model that worked them (same as the plan-sourced path).
      // Architect-roster runs pin only the architect seat instead.
      roleRuntimes: architectOverrides
        ? architectOverrides.roleRuntimes
        : buildSprintEngineRoleRuntimes(input.roleModelOverrides, input.roleCliDefaults),
      // Persist the enabled role set so Python derives quality gates for the
      // configured-but-not-yet-seated roles under the lazy roster. Architect
      // mode enables only the architect; the architect grows the roster later
      // via roster.configure.
      enabledRoles: architectOverrides
        ? architectOverrides.enabledRoles
        : sprintEngineEnabledRoles(args.sprintEngineState.roleCounts),
      // Architect-roster metadata: the roster-source mode and the ticked model
      // palette the engine enforces. Omitted (undefined) in user mode.
      ...(architectOverrides
        ? { rosterSource: architectOverrides.rosterSource, allowedRuntimes: architectOverrides.allowedRuntimes }
        : {}),
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
  // bundle holds its children; for every other bundle (e.g. an HTML mockup) the
  // first bundle item is the primary source.
  const isEpicSource = input.sourcePlanKind === 'epic'
  const bundlePrimary = !isEpicSource ? (input.sourceBundle?.[0] ?? null) : null
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
      initialSpawnRoles: input.initialSpawnRoles ?? null,
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
