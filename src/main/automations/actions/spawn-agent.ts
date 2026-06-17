import { createHash } from 'node:crypto'

import type { AutomationActionProvider, AutomationDefinition, AutomationRun } from '../../../shared/automations/contracts'

export type SpawnAgentConfig = {
  folderPath?: string
  workspaceId?: string
  cli?: string
  name?: string
  prompt: string
  requiredIntegrations?: string[]
}

export type SpawnAgentRuntime = {
  definition: AutomationDefinition
  runId: string
  workspaceRoot: string
  spawnAgent(input: {
    workspaceId?: string
    folderPath: string
    cli?: string
    name?: string
    prompt: string
  }): Promise<{ workspaceId: string; agentId: string }>
  requireIntegration(id: string): void
  isWorkspaceDirty(input: { workspaceId?: string; folderPath: string }): Promise<{ dirty: boolean; reason?: string }>
}

export type SpawnAgentActionResult = Partial<AutomationRun>

export function createSpawnAgentActionProvider(): AutomationActionProvider {
  return {
    kind: 'spawn-agent',
    configSchema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        folderPath: { type: 'string', minLength: 1 },
        workspaceId: { type: 'string', minLength: 1 },
        cli: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
        prompt: { type: 'string', minLength: 1 },
        requiredIntegrations: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
        },
      },
    },
    requiredIntegrations: [],
    run: async () => {
      throw new Error('spawn-agent provider must be run through runSpawnAgentAction.')
    },
  }
}

export async function runSpawnAgentAction(config: unknown, runtime: SpawnAgentRuntime): Promise<SpawnAgentActionResult> {
  const parsed = parseSpawnAgentConfig(config)
  for (const integrationId of parsed.requiredIntegrations ?? []) {
    runtime.requireIntegration(integrationId)
  }

  const folderPath = parsed.folderPath ?? runtime.workspaceRoot
  const autonomy = runtime.definition.autonomyDefault
  if (autonomy === 'allow_changes') {
    const dirty = await runtime.isWorkspaceDirty({ workspaceId: parsed.workspaceId, folderPath })
    if (dirty.dirty) {
      return {
        status: 'blocked',
        blockedReason: dirty.reason ?? 'Target workspace has uncommitted or unsaved changes.',
        summary: 'Automation blocked before launching because allow_changes requires a clean target workspace.',
      }
    }
  }

  const prompt = composeSpawnAgentPrompt({
    userPrompt: parsed.prompt,
    autonomy,
    automationId: runtime.definition.id,
    runId: runtime.runId,
  })
  const launched = await runtime.spawnAgent({
    workspaceId: parsed.workspaceId,
    folderPath,
    cli: parsed.cli,
    name: parsed.name ?? runtime.definition.name,
    prompt,
  })

  return {
    status: 'completed',
    workspaceId: launched.workspaceId,
    agentId: launched.agentId,
    promptFingerprint: fingerprintPrompt(prompt),
    summary: `Launched ${autonomy === 'allow_changes' ? 'allow-changes' : 'review-only'} agent ${launched.agentId}.`,
  }
}

export function parseSpawnAgentConfig(config: unknown): SpawnAgentConfig {
  if (!isRecord(config)) throw new Error('spawn-agent config must be an object.')
  const prompt = optionalString(config.prompt)
  if (!prompt) throw new Error('spawn-agent config requires a prompt.')

  const requiredIntegrations = config.requiredIntegrations
  if (
    requiredIntegrations !== undefined
    && (!Array.isArray(requiredIntegrations) || !requiredIntegrations.every((entry) => typeof entry === 'string' && entry.trim().length > 0))
  ) {
    throw new Error('spawn-agent requiredIntegrations must be non-empty strings.')
  }

  return {
    folderPath: optionalString(config.folderPath),
    workspaceId: optionalString(config.workspaceId),
    cli: optionalString(config.cli),
    name: optionalString(config.name),
    prompt,
    requiredIntegrations: Array.isArray(requiredIntegrations)
      ? requiredIntegrations.map((entry) => entry.trim())
      : undefined,
  }
}

export function composeSpawnAgentPrompt(input: {
  userPrompt: string
  autonomy: AutomationDefinition['autonomyDefault']
  automationId: string
  runId: string
}): string {
  const policy = input.autonomy === 'allow_changes'
    ? [
        'Automation execution mode: allow_changes.',
        'You may modify files only when the requested task requires it.',
        'Keep changes scoped to the automation request, preserve user work, and report every file and command you touch.',
      ]
    : [
        'Automation execution mode: review_only.',
        'Do not edit files, create files, delete files, stage changes, commit, push, install packages, or run commands that mutate the workspace.',
        'Inspect and report findings only. If a fix is needed, describe it instead of applying it.',
      ]

  return [
    `Automation: ${input.automationId}`,
    `Run: ${input.runId}`,
    ...policy,
    '',
    input.userPrompt.trim(),
  ].join('\n')
}

export function fingerprintPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex')
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
