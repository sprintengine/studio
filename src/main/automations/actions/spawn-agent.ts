import { createHash } from 'node:crypto'

import type {
  AutomationActionProvider,
  AutomationCliPermissionPreset,
  AutomationDefinition,
  AutomationRun,
} from '../../../shared/automations/contracts'

const PERMISSION_PRESETS: readonly AutomationCliPermissionPreset[] = ['default', 'auto_workspace', 'bypass_all']

export type SpawnAgentConfig = {
  folderPath?: string
  workspaceId?: string
  cli?: string
  cliModel?: string
  permissionPreset?: AutomationCliPermissionPreset
  specialistId?: string
  name?: string
  prompt: string
  requiredIntegrations?: string[]
  connectorId?: string
  // Built-in skill id installed into the run's working directory at spawn (e.g.
  // 'backlog'). Built-in skills only — see AutomationRendererRequest.spawnSkillId.
  spawnSkillId?: string
  includeTriggerContext?: boolean
}

export type SpawnAgentRuntime = {
  definition: AutomationDefinition
  runId: string
  workspaceRoot: string
  // The run's triggering event payload (manual/schedule/trigger). Surfaced in the
  // launch prompt only when the action opts in via includeTriggerContext.
  triggerPayload?: Record<string, unknown>
  resolveSpawnAgentTarget(input: { workspaceId?: string; folderPath: string }): Promise<SpawnAgentResolvedTarget>
  spawnAgent(input: {
    workspaceId?: string
    folderPath: string
    resolvedTarget?: SpawnAgentResolvedTarget
    cli?: string
    cliModel?: string
    permissionPreset?: AutomationCliPermissionPreset
    specialistId?: string
    name?: string
    prompt: string
    connectorId?: string
    spawnSkillId?: string
  }): Promise<{ workspaceId: string; agentId: string; executionId?: string; worktreePath?: string; branch?: string }>
  requireIntegration(id: string): void
}

export type SpawnAgentActionResult = Partial<AutomationRun>
export type SpawnAgentResolvedTarget = {
  workspaceId?: string
  folderPath: string
}

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
        cliModel: { type: 'string', minLength: 1 },
        permissionPreset: { type: 'string', enum: [...PERMISSION_PRESETS] },
        specialistId: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
        prompt: { type: 'string', minLength: 1 },
        connectorId: { type: 'string', minLength: 1 },
        spawnSkillId: { type: 'string', minLength: 1 },
        includeTriggerContext: { type: 'boolean' },
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
  const target = await runtime.resolveSpawnAgentTarget({ workspaceId: parsed.workspaceId, folderPath })
  const autonomy = runtime.definition.autonomyDefault
  // Agent-backed runs execute in their own per-run worktree, so a dirty main
  // checkout no longer blocks a launch — the worktree gives a clean baseline and
  // keeps the run's diff (and PR) isolated from the user's uncommitted work.

  const prompt = composeSpawnAgentPrompt({
    userPrompt: parsed.prompt,
    autonomy,
    automationId: runtime.definition.id,
    runId: runtime.runId,
    includeTriggerContext: parsed.includeTriggerContext,
    triggerPayload: runtime.triggerPayload,
  })
  const launched = await runtime.spawnAgent({
    workspaceId: target.workspaceId,
    folderPath: target.folderPath,
    resolvedTarget: target,
    cli: parsed.cli,
    cliModel: parsed.cliModel,
    permissionPreset: parsed.permissionPreset,
    specialistId: parsed.specialistId,
    name: parsed.name ?? runtime.definition.name,
    prompt,
    connectorId: parsed.connectorId,
    spawnSkillId: parsed.spawnSkillId,
  })

  const isolation = launched.worktreePath ? ' in an isolated worktree' : ''
  // The run stays in-progress: the agent is now working. finalizeRun records the
  // terminal outcome (and links a PR) when the agent finishes.
  return {
    status: 'running',
    workspaceId: launched.workspaceId,
    agentId: launched.agentId,
    executionId: launched.executionId,
    worktreePath: launched.worktreePath,
    branch: launched.branch,
    promptFingerprint: fingerprintPrompt(prompt),
    summary: `Launched ${autonomy === 'allow_changes' ? 'allow-changes' : 'review-only'} agent ${launched.agentId}${isolation}; working…`,
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

  const permissionPreset = optionalString(config.permissionPreset)
  if (permissionPreset !== undefined && !PERMISSION_PRESETS.includes(permissionPreset as AutomationCliPermissionPreset)) {
    throw new Error(`spawn-agent permissionPreset must be one of: ${PERMISSION_PRESETS.join(', ')}.`)
  }

  const includeTriggerContext = config.includeTriggerContext
  if (includeTriggerContext !== undefined && typeof includeTriggerContext !== 'boolean') {
    throw new Error('spawn-agent includeTriggerContext must be a boolean.')
  }

  return {
    folderPath: optionalString(config.folderPath),
    workspaceId: optionalString(config.workspaceId),
    cli: optionalString(config.cli),
    cliModel: optionalString(config.cliModel),
    permissionPreset: permissionPreset as AutomationCliPermissionPreset | undefined,
    specialistId: optionalString(config.specialistId),
    name: optionalString(config.name),
    prompt,
    connectorId: optionalString(config.connectorId),
    spawnSkillId: optionalString(config.spawnSkillId),
    includeTriggerContext: typeof includeTriggerContext === 'boolean' ? includeTriggerContext : undefined,
    requiredIntegrations: Array.isArray(requiredIntegrations)
      ? requiredIntegrations.map((entry) => entry.trim())
      : undefined,
  }
}

// Producer-controlled payloads must not blow up the prompt, so the serialized
// JSON is capped. 8 KB is generous for the run-event payloads that motivate this
// (taskId/question/…) while still bounding a pathological producer.
const TRIGGER_CONTEXT_MAX_BYTES = 8192

export function composeSpawnAgentPrompt(input: {
  userPrompt: string
  autonomy: AutomationDefinition['autonomyDefault']
  automationId: string
  runId: string
  // Opt-in (default off): when true and a non-empty payload exists, the launch
  // prompt carries a fenced JSON block of the triggering event so the agent knows
  // which task/question woke it. Absent flag ⇒ byte-identical prompt as before.
  includeTriggerContext?: boolean
  triggerPayload?: Record<string, unknown>
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

  // The run finalizes when this agent ends its turn, so a turn ended to ask a
  // question reads as "the work is finished" and finalizes a half-done run. There
  // is no human at this terminal to answer, so ending the turn is the only way to
  // report a blocker — say why, and stop.
  const nonInteractive = [
    'You are running unattended: no one will read a question or answer a prompt.',
    'Do not ask questions, request confirmation, or wait for input. If you cannot proceed, state why in your final message and stop.',
  ]

  return [
    `Automation: ${input.automationId}`,
    `Run: ${input.runId}`,
    ...policy,
    '',
    input.userPrompt.trim(),
    ...triggerContextBlock(input.includeTriggerContext, input.triggerPayload),
    '',
    ...nonInteractive,
  ].join('\n')
}

// Empty (no lines) unless opted in with a non-empty payload — keeping the
// composed prompt byte-identical for every existing automation. When present it
// sits between the user task and the non-interactive directive.
function triggerContextBlock(
  includeTriggerContext: boolean | undefined,
  triggerPayload: Record<string, unknown> | undefined
): string[] {
  if (includeTriggerContext !== true) return []
  if (!triggerPayload || Object.keys(triggerPayload).length === 0) return []
  return [
    '',
    '## Trigger event',
    'This run was fired by an automation trigger. Event payload:',
    '```json',
    cappedTriggerJson(triggerPayload),
    '```',
  ]
}

function cappedTriggerJson(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload, null, 2)
  if (Buffer.byteLength(json, 'utf8') <= TRIGGER_CONTEXT_MAX_BYTES) return json
  return `${json.slice(0, TRIGGER_CONTEXT_MAX_BYTES)}\n[truncated]`
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
