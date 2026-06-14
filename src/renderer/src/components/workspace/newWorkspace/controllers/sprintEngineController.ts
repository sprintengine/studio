import { createSprintEngineTemplate } from '../../../../modules/sprint-engine-workspace-types'
import { countSprintEngineAgents, createInitialSprintEngineState } from '../../../../utils/sprintengine'
import {
  sprintEngineAutomationInitialStateForMode,
  sprintEngineAutomationModeForRunOptions,
} from '../../../../utils/sprintengineAutomationLifecycle'
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
      sprintEngineAutoState: {
        ...sprintEngineAutoStateFromRunOptions(input),
        cliPermissionPreset: input.cliPermissionPreset,
        maxConcurrentAgents: Math.max(1, input.totalAgents),
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
