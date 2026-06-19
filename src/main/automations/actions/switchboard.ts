import type { AutomationActionProvider, AutomationRun } from '../../../shared/automations/contracts'
import type {
  SwitchboardReadResult,
  SwitchboardRunnerResult,
  SwitchboardRunnerWorkspaceInput,
  WatchtowerRunResult,
  WatchtowerStartReviewInput,
} from '../../../shared/switchboard'

export const SWITCHBOARD_AUTOMATION_INTEGRATION_ID = 'module:switchboard'
export const WATCHTOWER_AUTOMATION_INTEGRATION_ID = 'module:watchtower'

export const SWITCHBOARD_RUNNER_TICK_ACTION_KIND = 'switchboard-runner-tick'
export const WATCHTOWER_REVIEW_ACTION_KIND = 'watchtower-review'

export type SwitchboardAutomationFrontDoors = {
  readAllTasks(input: { workspaceRoot: string }): Promise<SwitchboardReadResult>
  tickRunner(input: SwitchboardRunnerWorkspaceInput): Promise<SwitchboardRunnerResult>
  startWatchtowerReview(input: WatchtowerStartReviewInput): Promise<WatchtowerRunResult>
}

export function createSwitchboardAutomationActionProviders(
  frontDoors: SwitchboardAutomationFrontDoors
): AutomationActionProvider[] {
  return [
    createSwitchboardRunnerTickActionProvider(frontDoors),
    createWatchtowerReviewActionProvider(frontDoors),
  ]
}

function createSwitchboardRunnerTickActionProvider(
  frontDoors: SwitchboardAutomationFrontDoors
): AutomationActionProvider {
  return {
    kind: SWITCHBOARD_RUNNER_TICK_ACTION_KIND,
    configSchema: {
      type: 'object',
      properties: {},
    },
    requiredIntegrations: [SWITCHBOARD_AUTOMATION_INTEGRATION_ID],
    run: async (_config, ctx) => {
      ctx.requireIntegration(SWITCHBOARD_AUTOMATION_INTEGRATION_ID)
      const result = await frontDoors.tickRunner({ workspaceRoot: ctx.workspaceRoot })
      if (!result.ok) return failedRun(result.message)
      return {
        status: 'completed',
        summary: `Switchboard runner tick completed with ${result.activeExecutions.length} active execution${result.activeExecutions.length === 1 ? '' : 's'}.`,
      }
    },
  }
}

function createWatchtowerReviewActionProvider(
  frontDoors: SwitchboardAutomationFrontDoors
): AutomationActionProvider {
  return {
    kind: WATCHTOWER_REVIEW_ACTION_KIND,
    configSchema: {
      type: 'object',
      required: ['preset'],
      properties: {
        preset: {
          type: 'string',
          minLength: 1,
          enum: [
            'lean_code_review',
            'ui_brand_alignment_review',
            'performance_focused_review',
            'security_deep_review',
            'full_product_review',
            'custom',
          ],
        },
      },
    },
    requiredIntegrations: [WATCHTOWER_AUTOMATION_INTEGRATION_ID],
    run: async (config, ctx) => {
      ctx.requireIntegration(WATCHTOWER_AUTOMATION_INTEGRATION_ID)
      const parsed = parseWatchtowerReviewConfig(config)
      const result = await frontDoors.startWatchtowerReview({
        workspaceRoot: ctx.workspaceRoot,
        preset: parsed.preset,
      })
      if (!result.ok) return failedRun(result.message)
      return {
        status: 'completed',
        summary: `Started Watchtower review ${result.run.runId}.`,
      }
    },
  }
}

function parseWatchtowerReviewConfig(config: unknown): { preset: string } {
  if (!isRecord(config)) throw new Error('watchtower-review config must be an object.')
  const preset = optionalString(config.preset)
  if (!preset) throw new Error('watchtower-review config requires a preset.')
  return { preset }
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
