import { join } from 'node:path'

import type { AutomationActionProvider, AutomationRun } from '../../../shared/automations/contracts'
import type {
  SprintEngineArtifactCommandResult,
  SprintEngineRosterReplenishInput,
  SprintEngineRunnerSetInput,
  SprintEngineTaskMutationRole,
} from '../../../shared/electron-api'

export const SPRINT_ENGINE_AUTOMATION_INTEGRATION_ID = 'module:sprint-engine'
export const SPRINT_ENGINE_RUN_ACTION_KIND = 'sprint-engine-run'

const SPRINT_ENGINE_AUTOMATION_ROLES: SprintEngineTaskMutationRole[] = [
  'architect',
  'product',
  'developer',
  'frontend',
  'tester',
  'security',
  'code_reviewer',
  'spec_reviewer',
  'performance',
  'production_readiness_reviewer',
  'cross_platform',
]

export type SprintEngineAutomationFrontDoors = {
  setRunnerMode(input: SprintEngineRunnerSetInput): Promise<SprintEngineArtifactCommandResult>
  replenishRoster(input: SprintEngineRosterReplenishInput): Promise<SprintEngineArtifactCommandResult>
}

export function createSprintEngineRunActionProvider(
  frontDoors: SprintEngineAutomationFrontDoors
): AutomationActionProvider {
  return {
    kind: SPRINT_ENGINE_RUN_ACTION_KIND,
    configSchema: {
      type: 'object',
      required: ['team'],
      properties: {
        team: { type: 'string', minLength: 1 },
        role: {
          type: 'string',
          minLength: 1,
          enum: SPRINT_ENGINE_AUTOMATION_ROLES,
        },
      },
    },
    requiredIntegrations: [SPRINT_ENGINE_AUTOMATION_INTEGRATION_ID],
    run: async (config, ctx) => {
      ctx.requireIntegration(SPRINT_ENGINE_AUTOMATION_INTEGRATION_ID)
      const parsed = parseSprintEngineRunConfig(config)
      const statePath = join(ctx.workspaceRoot, '.multi-code', 'sprintengine', parsed.team, 'run.yaml')

      const runner = await frontDoors.setRunnerMode({ statePath, cliWatchPolling: 'enabled' })
      if (!runner.ok) return failedRun(runner.message)

      const roster = await frontDoors.replenishRoster({
        statePath,
        ...(parsed.role ? { role: parsed.role } : {}),
      })
      if (!roster.ok) return failedRun(roster.message)

      return {
        status: 'completed',
        summary: parsed.role
          ? `Started a sprint for team "${parsed.team}" (${parsed.role}).`
          : `Started a sprint for team "${parsed.team}".`,
      }
    },
  }
}

function parseSprintEngineRunConfig(config: unknown): {
  team: string
  role?: SprintEngineTaskMutationRole
} {
  if (!isRecord(config)) throw new Error('sprint-engine-run config must be an object.')
  const team = optionalString(config.team)
  if (!team) throw new Error('sprint-engine-run config requires a team.')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(team)) {
    throw new Error('sprint-engine-run team must be a safe sprint roster id.')
  }
  const role = optionalString(config.role)
  let parsedRole: SprintEngineTaskMutationRole | undefined
  if (role) {
    if (!isSprintEngineAutomationRole(role)) {
      throw new Error('sprint-engine-run role must be a known sprint role.')
    }
    parsedRole = role
  }
  return {
    team,
    ...(parsedRole ? { role: parsedRole } : {}),
  }
}

function isSprintEngineAutomationRole(value: string): value is SprintEngineTaskMutationRole {
  return SPRINT_ENGINE_AUTOMATION_ROLES.includes(value as SprintEngineTaskMutationRole)
}

function failedRun(message: string): Partial<AutomationRun> {
  return {
    status: 'failed',
    summary: message,
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
