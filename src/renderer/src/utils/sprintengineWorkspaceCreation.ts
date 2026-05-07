import { createSwarmTemplate } from '../layouts/templates'
import { useWorkspaceStore } from '../store/workspaceStore'
import type {
  SwarmRoleCounts,
  SwarmRoleCliDefaults,
  SwarmWorkspaceContext,
  WorkspaceId,
} from '../types/workspace'
import {
  buildSwarmAgentRosterForState,
  buildSwarmRosterCommandArgs,
  createInitialSwarmState,
} from './sprintengine'
import { buildPlanFileSwarmHandoffPrompt } from './sprintengineHandoff'
import {
  getSwarmDirectoryPath,
  getSwarmStateFilePath,
  slugifySwarmName,
} from './sprintengineStateFile'

const planSourcedSwarmRoleCounts: SwarmRoleCounts = {
  architect: 1,
  product: 1,
  developer: 0,
  frontend: 0,
  code_reviewer: 0,
  performance: 0,
  tester: 0,
  security: 0,
}

export type PlanSourcedSwarmWorkspaceArgs = {
  rootPath: string
  teamName: string
  goal: string
  sourcePath: string
  sourceContent: string
  roleCounts?: SwarmRoleCounts
  roleCliDefaults?: SwarmRoleCliDefaults
  pathExists?: (path: string) => boolean | Promise<boolean>
}

export type PlanSourcedSwarmWorkspaceResult = {
  workspaceId: WorkspaceId
  swarmContext: SwarmWorkspaceContext
  architectAgentId: string
}

export class PlanSourcedSwarmWorkspaceError extends Error {
  constructor(
    public readonly code:
      | 'missing-root'
      | 'missing-team'
      | 'missing-goal'
      | 'missing-source'
      | 'team-exists'
      | 'missing-architect'
  ) {
    super(code)
    this.name = 'PlanSourcedSwarmWorkspaceError'
  }
}

export function buildPlanSourcedSwarmWorkspaceContext(
  rootPath: string,
  teamName: string
): SwarmWorkspaceContext {
  const trimmedRoot = rootPath.trim()
  const trimmedTeamName = teamName.trim()
  const teamSlug = slugifySwarmName(trimmedTeamName)

  return {
    teamName: trimmedTeamName,
    teamSlug,
    teamDirectoryPath: getSwarmDirectoryPath(trimmedRoot, teamSlug),
    statePath: getSwarmStateFilePath(trimmedRoot, teamSlug),
  }
}

export async function createPlanSourcedSwarmWorkspace({
  rootPath,
  teamName,
  goal,
  sourcePath,
  sourceContent,
  roleCounts = planSourcedSwarmRoleCounts,
  roleCliDefaults,
  pathExists,
}: PlanSourcedSwarmWorkspaceArgs): Promise<PlanSourcedSwarmWorkspaceResult> {
  const trimmedRoot = rootPath.trim()
  const trimmedTeamName = teamName.trim()
  const trimmedGoal = goal.trim()
  const trimmedSourcePath = sourcePath.trim()

  if (!trimmedRoot) throw new PlanSourcedSwarmWorkspaceError('missing-root')
  if (!trimmedTeamName) throw new PlanSourcedSwarmWorkspaceError('missing-team')
  if (!trimmedGoal) throw new PlanSourcedSwarmWorkspaceError('missing-goal')
  if (!trimmedSourcePath) throw new PlanSourcedSwarmWorkspaceError('missing-source')

  const swarmContext = buildPlanSourcedSwarmWorkspaceContext(trimmedRoot, trimmedTeamName)
  if (pathExists && await pathExists(swarmContext.statePath)) {
    throw new PlanSourcedSwarmWorkspaceError('team-exists')
  }

  const swarmState = createInitialSwarmState({
    name: swarmContext.teamName,
    goal: trimmedGoal,
    roleCounts,
  })
  const architect = buildSwarmAgentRosterForState(swarmState).find((agent) => agent.role === 'architect')
  if (!architect) throw new PlanSourcedSwarmWorkspaceError('missing-architect')

  const template = createSwarmTemplate({
    name: swarmState.name,
    goal: swarmState.goal,
    roleCounts: swarmState.roleCounts,
  })
  const workspaceId = useWorkspaceStore.getState().addWorkspace(template, {
    name: swarmContext.teamName,
    folderPath: trimmedRoot,
    swarmState,
    swarmContext,
    swarmRoleCliDefaults: roleCliDefaults,
  })

  const startupPrompt = buildPlanFileSwarmHandoffPrompt({
    teamSlug: swarmContext.teamSlug,
    goal: trimmedGoal,
    sourcePath: trimmedSourcePath,
    sourceContent,
    statePath: swarmContext.statePath,
    rosterArgs: buildSwarmRosterCommandArgs(swarmState),
  })

  useWorkspaceStore.getState().updateAgent(workspaceId, architect.id, {
    cliStartupPrompt: startupPrompt,
    cliOnboardingPromptSent: false,
  })

  return {
    workspaceId,
    swarmContext,
    architectAgentId: architect.id,
  }
}
