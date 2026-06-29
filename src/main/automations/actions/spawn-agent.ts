import { createHash } from 'node:crypto'

import type {
  AutomationActionProvider,
  AutomationCliPermissionPreset,
  AutomationDefinition,
  AutomationRun,
} from '../../../shared/automations/contracts'
import { RUN_SIGNAL_FILENAME } from '../run-signal'

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
}

export type SpawnAgentRuntime = {
  definition: AutomationDefinition
  runId: string
  workspaceRoot: string
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

  return {
    folderPath: optionalString(config.folderPath),
    workspaceId: optionalString(config.workspaceId),
    cli: optionalString(config.cli),
    cliModel: optionalString(config.cliModel),
    permissionPreset: permissionPreset as AutomationCliPermissionPreset | undefined,
    specialistId: optionalString(config.specialistId),
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
        `Exception: writing the single run-status file ${RUN_SIGNAL_FILENAME} described below is allowed and required; it is the only file you may create under this mode.`,
      ]

  const signalInstruction = [
    'When you finish, declare your terminal outcome as your final action:',
    `write the file ${RUN_SIGNAL_FILENAME} in your current working directory with exactly this JSON shape:`,
    '{ "status": "completed" | "failed", "summary"?: string, "reports"?: string[] }',
    'Use "completed" when you finished the task, or "failed" if you could not complete it. Include a short summary of what you did or why it failed.',
    'If you wrote any report files, list each one in "reports" as a project-relative path under reports/ (for example "reports/2026-06-28-review.md"); omit "reports" when you wrote none.',
  ]

  return [
    `Automation: ${input.automationId}`,
    `Run: ${input.runId}`,
    ...policy,
    '',
    input.userPrompt.trim(),
    '',
    ...signalInstruction,
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
