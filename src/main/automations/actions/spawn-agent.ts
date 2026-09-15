import { createHash } from 'node:crypto'

import { AUTOMATION_DEFAULT_PERMISSION_PRESET } from '../../../shared/automations/contracts'
import { isRecord } from '../../../shared/records'
import type {
  AutomationActionProvider,
  AutomationCliPermissionPreset,
  AutomationDefinition,
  AutomationRun,
  AutomationRunIsolation,
} from '../../../shared/automations/contracts'

const PERMISSION_PRESETS: readonly AutomationCliPermissionPreset[] = ['none', 'manual', 'auto', 'bypass']

// Pre-MC-2210 spellings. An automation saved before the rename still carries
// one, and rejecting it would break a definition nobody edited, so they stay
// accepted on read (and in the config schema, which validates saved definitions
// as well as new ones) and are normalized to the canonical name. `default` maps
// to `manual`, matching normalizeCliPermissionPreset: it was the "asks before
// acting" option in the UI, and it also served as the no-override sentinel.
const LEGACY_PERMISSION_PRESETS: Readonly<Record<string, AutomationCliPermissionPreset>> = {
  default: 'manual',
  auto_workspace: 'auto',
  bypass_all: 'bypass',
}

function normalizeAutomationPermissionPreset(value: string): AutomationCliPermissionPreset | undefined {
  if ((PERMISSION_PRESETS as readonly string[]).includes(value)) return value as AutomationCliPermissionPreset
  return LEGACY_PERMISSION_PRESETS[value]
}

export type SpawnAgentConfig = {
  folderPath?: string
  workspaceId?: string
  cli?: string
  cliModel?: string
  // Always resolved — an omitted preset becomes AUTOMATION_DEFAULT_PERMISSION_PRESET.
  permissionPreset: AutomationCliPermissionPreset
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
    label: 'Spawn an agent',
    glyph: 'agent',
    summary: 'Launch a CLI agent in a workspace',
    configSchema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        folderPath: { type: 'string', minLength: 1 },
        workspaceId: { type: 'string', minLength: 1 },
        cli: { type: 'string', minLength: 1 },
        cliModel: { type: 'string', minLength: 1 },
        permissionPreset: { type: 'string', enum: [...PERMISSION_PRESETS, ...Object.keys(LEGACY_PERMISSION_PRESETS)] },
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
  // Agent-backed runs execute in their own per-run worktree, so a dirty main
  // checkout no longer blocks a launch — the worktree gives a clean baseline and
  // keeps the run's diff (and PR) isolated from the user's uncommitted work.

  const prompt = composeSpawnAgentPrompt({
    userPrompt: parsed.prompt,
    automationId: runtime.definition.id,
    runId: runtime.runId,
    includeTriggerContext: parsed.includeTriggerContext,
    triggerPayload: runtime.triggerPayload,
    writeUpOnly: runtime.definition.legacyWriteUpOnly === true,
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

  // A run without a worktree is here only because its definition opted out: the
  // executor blocks a run that wanted isolation and could not get it. Record
  // which of the two shapes this run is, so a reader of the run alone can tell a
  // contained run from one that wrote into the user's checkout.
  const isolation: AutomationRunIsolation = launched.worktreePath ? 'worktree' : 'workspace-checkout'
  const where = launched.worktreePath
    ? 'in an isolated worktree'
    : 'in the workspace checkout (no branch, no pull request)'
  // The run stays in-progress: the agent is now working. finalizeRun records the
  // terminal outcome (and links a PR) when the agent finishes.
  return {
    status: 'running',
    workspaceId: launched.workspaceId,
    agentId: launched.agentId,
    executionId: launched.executionId,
    isolation,
    worktreePath: launched.worktreePath,
    branch: launched.branch,
    promptFingerprint: fingerprintPrompt(prompt),
    summary: `Launched agent ${launched.agentId} ${where}; working…`,
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

  const rawPermissionPreset = optionalString(config.permissionPreset)
  const permissionPreset = rawPermissionPreset === undefined
    ? undefined
    : normalizeAutomationPermissionPreset(rawPermissionPreset)
  if (rawPermissionPreset !== undefined && permissionPreset === undefined) {
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
    permissionPreset: (permissionPreset as AutomationCliPermissionPreset | undefined) ?? AUTOMATION_DEFAULT_PERMISSION_PRESET,
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

// The substitution the owner named when retiring `autonomyDefault`, verbatim, so
// a definition whose author asked for a reviewer still gets one.
export const WRITE_UP_ONLY_INSTRUCTION =
  'Open a pull request containing the write-up only; do not refactor.'

export function composeSpawnAgentPrompt(input: {
  userPrompt: string
  automationId: string
  runId: string
  // Opt-in (default off): when true and a non-empty payload exists, the launch
  // prompt carries a fenced JSON block of the triggering event so the agent knows
  // which task/question woke it. Absent flag ⇒ byte-identical prompt as before.
  includeTriggerContext?: boolean
  triggerPayload?: Record<string, unknown>
  // Set for a definition stored before `autonomyDefault` was retired whose author
  // chose `review_only` (AutomationDefinition.legacyWriteUpOnly). Their intent
  // was "report, do not fix", and it now lives here — in the prompt — because
  // that is where the owner put reviewer-vs-fixer intent when the field was
  // retired. Nothing sets it for a definition written since.
  writeUpOnly?: boolean
}): string {
  // One unconditional policy block. A run that must not refactor says so in its
  // own task prompt ("open a pull request containing the write-up only"), which
  // is precise where a read-only mode was self-contradictory: it forbade the
  // commit and push that opening a pull request requires.
  const policy = [
    'You may modify files only when the requested task requires it.',
    'Keep changes scoped to the automation request, preserve user work, and report every file and command you touch.',
    ...(input.writeUpOnly === true ? [WRITE_UP_ONLY_INSTRUCTION] : []),
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
  // Neutralize any run of 3+ backticks so a payload value cannot break out of the
  // launch prompt's ```json fence. Backticks live only inside JSON string values,
  // and the Unicode escape they are rewritten to stays a valid JSON escape, so the
  // block remains parseable JSON. Escaping before truncation keeps the marker safe too.
  const json = JSON.stringify(payload, null, 2).replace(
    /`{3,}/g,
    (run) => '\\u0060'.repeat(run.length),
  )
  if (Buffer.byteLength(json, 'utf8') <= TRIGGER_CONTEXT_MAX_BYTES) return json
  return `${truncateUtf8(json, TRIGGER_CONTEXT_MAX_BYTES)}\n[truncated]`
}

// Truncate to at most maxBytes of UTF-8 without splitting a multibyte character.
// Slicing by string length counts UTF-16 code units, so a non-ASCII payload would
// overshoot the byte cap the comment on TRIGGER_CONTEXT_MAX_BYTES promises; cut on
// the encoded buffer and back off any trailing continuation byte instead.
function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1
  return buf.toString('utf8', 0, end)
}

export function fingerprintPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex')
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

