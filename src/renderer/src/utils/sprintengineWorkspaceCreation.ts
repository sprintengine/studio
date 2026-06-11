import { createSprintEngineTemplate } from '../modules/sprint-engine-workspace-types'
import { useWorkspaceStore } from '../store/workspaceStore'
import type {
  SprintEngineRoleCounts,
  SprintEngineAutoState,
  SprintEngineRoleCliDefaults,
  SprintEngineSourceBundleItem,
  SprintEngineSourcePlanKind,
  SprintEngineWorkspaceContext,
  WorkspaceId,
  WorkspaceWindowId,
} from '../types/workspace'
import type { SprintEngineArtifactCommandResult, SprintEngineStateInitializeInput } from '../../../shared/electron-api'
import {
  buildSprintEngineAgentRosterForState,
  buildSprintEngineRosterCommandArgs,
  createInitialSprintEngineState,
} from './sprintengine'
import { buildPlanFileSprintEngineHandoffPrompt } from './sprintengineHandoff'
import { buildRunWorkspaceContext } from './runWorkspaceCreation'
import { deriveSprintEngineAutomationDesiredMode } from './sprintengineAutomationLifecycle'

const planSourcedSprintEngineRoleCounts: SprintEngineRoleCounts = {
  architect: 1,
  product: 1,
  developer: 0,
  frontend: 0,
  code_reviewer: 0,
  nuclear_reviewer: 0,
  spec_reviewer: 0,
  performance: 0,
  production_readiness_reviewer: 0,
  tester: 0,
  security: 0,
}

export type PlanSourcedSprintEngineWorkspaceArgs = {
  rootPath: string
  teamName: string
  goal: string
  sourcePath: string
  sourceContent: string
  sourcePlanKind?: SprintEngineSourcePlanKind
  sourceBundle?: SprintEngineSourceBundleItem[]
  roleCounts?: SprintEngineRoleCounts
  roleCliDefaults?: SprintEngineRoleCliDefaults
  sprintEngineAutoState?: Partial<SprintEngineAutoState> | null
  workspaceWindowId?: WorkspaceWindowId | null
  useWorktrees?: boolean
  pathExists?: (path: string) => boolean | Promise<boolean>
  initializeSprintEngineState?: (
    input: SprintEngineStateInitializeInput
  ) => Promise<SprintEngineArtifactCommandResult>
}

export type PlanSourcedSprintEngineWorkspaceResult = {
  workspaceId: WorkspaceId
  sprintEngineContext: SprintEngineWorkspaceContext
  architectAgentId: string
}

export class PlanSourcedSprintEngineWorkspaceError extends Error {
  constructor(
    public readonly code:
      | 'missing-root'
      | 'missing-team'
      | 'missing-source'
      | 'team-exists'
      | 'missing-architect'
  ) {
    super(code)
    this.name = 'PlanSourcedSprintEngineWorkspaceError'
  }
}

export function buildPlanSourcedSprintEngineWorkspaceContext(
  rootPath: string,
  teamName: string
): SprintEngineWorkspaceContext {
  const context = buildRunWorkspaceContext({
    kind: 'sprintengine',
    rootPath,
    name: teamName,
  })
  return {
    teamName: context.name,
    teamSlug: context.slug,
    teamDirectoryPath: context.directoryPath,
    statePath: context.statePath,
  }
}

export async function createPlanSourcedSprintEngineWorkspace({
  rootPath,
  teamName,
  goal,
  sourcePath,
  sourceContent,
  sourcePlanKind = 'unknown',
  sourceBundle,
  roleCounts = planSourcedSprintEngineRoleCounts,
  roleCliDefaults,
  sprintEngineAutoState,
  workspaceWindowId,
  useWorktrees,
  pathExists,
  initializeSprintEngineState,
}: PlanSourcedSprintEngineWorkspaceArgs): Promise<PlanSourcedSprintEngineWorkspaceResult> {
  const trimmedRoot = rootPath.trim()
  const trimmedTeamName = teamName.trim()
  const trimmedSourcePath = sourcePath.trim()
  const trimmedGoal = goal.trim() || derivePlanSourcedGoal(sourceContent, trimmedSourcePath)

  if (!trimmedRoot) throw new PlanSourcedSprintEngineWorkspaceError('missing-root')
  if (!trimmedTeamName) throw new PlanSourcedSprintEngineWorkspaceError('missing-team')
  if (!trimmedSourcePath) throw new PlanSourcedSprintEngineWorkspaceError('missing-source')

  const sprintEngineContext = buildPlanSourcedSprintEngineWorkspaceContext(trimmedRoot, trimmedTeamName)
  if (pathExists && await pathExists(sprintEngineContext.statePath)) {
    throw new PlanSourcedSprintEngineWorkspaceError('team-exists')
  }

  const sprintEngineState = createInitialSprintEngineState({
    name: sprintEngineContext.teamName,
    goal: trimmedGoal,
    roleCounts,
  })
  const architect = buildSprintEngineAgentRosterForState(sprintEngineState).find((agent) => agent.role === 'architect')
  if (!architect) throw new PlanSourcedSprintEngineWorkspaceError('missing-architect')

  if (initializeSprintEngineState) {
    const initResult = await initializeSprintEngineState({
      statePath: sprintEngineContext.statePath,
      name: sprintEngineState.name,
      goal: sprintEngineState.goal,
      agents: sprintEngineState.sprintEngineAgents,
      tasks: sprintEngineState.tasks,
      events: sprintEngineState.events,
      artifacts: sprintEngineState.artifacts,
      useWorktrees: useWorktrees === true,
    })
    if (!initResult.ok) {
      throw new Error(initResult.message || 'Could not initialize Sprint Engine run state.')
    }
  }

  const template = createSprintEngineTemplate({
    name: sprintEngineState.name,
    goal: sprintEngineState.goal,
    roleCounts: sprintEngineState.roleCounts,
  })
  const workspaceId = useWorkspaceStore.getState().addWorkspace(template, {
    name: sprintEngineContext.teamName,
    folderPath: trimmedRoot,
    sprintEngineState,
    sprintEngineContext,
    sprintEngineRoleCliDefaults: roleCliDefaults,
    sprintEngineAutoState,
    windowId: workspaceWindowId,
  })

  const startupPrompt = buildPlanFileSprintEngineHandoffPrompt({
    teamSlug: sprintEngineContext.teamSlug,
    goal: trimmedGoal,
    sourcePath: trimmedSourcePath,
    sourceContent,
    sourcePlanKind,
    sourceBundle,
    statePath: sprintEngineContext.statePath,
    rosterArgs: buildSprintEngineRosterCommandArgs(sprintEngineState),
    autoRunRequested: deriveSprintEngineAutomationDesiredMode(sprintEngineAutoState) !== 'manual',
  })

  useWorkspaceStore.getState().updateAgent(workspaceId, architect.id, {
    cliStartupPrompt: startupPrompt,
    cliOnboardingPromptSent: false,
  })

  return {
    workspaceId,
    sprintEngineContext,
    architectAgentId: architect.id,
  }
}

function derivePlanSourcedGoal(sourceContent: string, sourcePath: string): string {
  const heading = sourceContent
    .split(/\r?\n/u)
    .map((line) => line.match(/^#{1,3}\s+(.+?)\s*$/u)?.[1]?.trim())
    .find((title): title is string => Boolean(title))
  if (heading) return heading

  const filename = sourcePath.replace(/\\/g, '/').split('/').pop() ?? ''
  const stem = filename.replace(/\.[^.]+$/u, '').trim()
  const normalized = stem.replace(/[-_]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  return normalized || 'Sprint Engine handoff'
}
