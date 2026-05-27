import { createSprintEngineTemplate } from '../../../../layouts/templates'
import { countSprintEngineAgents, createInitialSprintEngineState } from '../../../../utils/sprintengine'
import {
  PlanSourcedSprintEngineWorkspaceError,
  createPlanSourcedSprintEngineWorkspace,
} from '../../../../utils/sprintengineWorkspaceCreation'
import { slugifySprintEngineName } from '../../../../utils/sprintengineStateFile'
import { buildSprintEngineContext } from '../useNewWorkspaceFolder'
import type {
  OnCreateArgs,
  SprintEngineExistingTeamInput,
  SprintEngineNewTeamInput,
  SprintEnginePlanSourcedInput,
  SprintEnginePlanSourcedPorts,
} from './types'

export class SprintEnginePlanSourcedError extends Error {
  constructor(public readonly code:
    | 'missing-folder'
    | 'missing-plan-option'
    | 'missing-plan-content'
    | 'missing-team-name'
    | 'missing-goal'
    | 'plan-not-on-disk'
    | 'team-exists'
    | 'unknown'
  ) {
    super(code)
    this.name = 'SprintEnginePlanSourcedError'
  }
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
    sprintEngineAutoState: {
      enabled: input.startRunner,
      autoApproveArtifacts: input.autoApproveArtifacts,
      cliPermissionPreset: input.cliPermissionPreset,
      maxConcurrentAgents: Math.max(1, countSprintEngineAgents(loadedState.roleCounts)),
    },
  }
}

export function buildSprintEngineNewTeamCreation(
  input: SprintEngineNewTeamInput,
): OnCreateArgs {
  const sprintEngineConfig = {
    name: input.teamName.trim() || 'Sprint Engine Team',
    goal: input.goal.trim(),
    roleCounts: input.visibleRoleCounts,
  }
  const sprintEngineState = createInitialSprintEngineState(sprintEngineConfig)
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
    sprintEngineAutoState: {
      enabled: input.startRunner,
      autoApproveArtifacts: input.autoApproveArtifacts,
      cliPermissionPreset: input.cliPermissionPreset,
      maxConcurrentAgents: Math.max(1, input.totalAgents),
    },
  }
}

export async function runSprintEnginePlanSourcedCreation(
  input: SprintEnginePlanSourcedInput,
  ports: SprintEnginePlanSourcedPorts,
): Promise<void> {
  if (!input.folderPath) throw new SprintEnginePlanSourcedError('missing-folder')
  const bundlePrimary = input.sourceBundle?.[0] ?? null
  const optionRelativePath = bundlePrimary
    ? bundlePrimary.sourceRelativePath
    : input.sourcePlanRelativePath
  const optionPath = bundlePrimary ? bundlePrimary.sourcePath : input.sourcePlanPath
  if (!optionPath || !optionRelativePath) throw new SprintEnginePlanSourcedError('missing-plan-option')
  if (input.sourcePlanContent == null) throw new SprintEnginePlanSourcedError('missing-plan-content')
  if (!input.teamName.trim()) throw new SprintEnginePlanSourcedError('missing-team-name')
  if (!input.goal.trim()) throw new SprintEnginePlanSourcedError('missing-goal')

  if (!(await ports.pathExists(optionPath))) {
    throw new SprintEnginePlanSourcedError('plan-not-on-disk')
  }

  try {
    await createPlanSourcedSprintEngineWorkspace({
      rootPath: input.folderPath,
      teamName: input.teamName,
      goal: input.goal,
      sourcePath: optionRelativePath,
      sourceContent: input.sourcePlanContent,
      sourcePlanKind: input.sourcePlanKind,
      sourceBundle: input.sourceBundle ?? undefined,
      roleCounts: input.visibleRoleCounts,
      roleCliDefaults: input.roleCliDefaults,
      sprintEngineAutoState: {
        enabled: input.startRunner,
        autoApproveArtifacts: input.autoApproveArtifacts,
        cliPermissionPreset: input.cliPermissionPreset,
        maxConcurrentAgents: Math.max(1, input.totalAgents),
      },
      pathExists: ports.pathExists,
    })
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
