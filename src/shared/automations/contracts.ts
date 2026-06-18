export type JsonSchema = Record<string, unknown>

export const AUTOMATIONS_LIST_CHANNEL = 'automations:list'
export const AUTOMATIONS_GET_CHANNEL = 'automations:get'
export const AUTOMATIONS_CREATE_CHANNEL = 'automations:create'
export const AUTOMATIONS_UPDATE_CHANNEL = 'automations:update'
export const AUTOMATIONS_DELETE_CHANNEL = 'automations:delete'
export const AUTOMATIONS_RUN_NOW_CHANNEL = 'automations:run-now'
export const AUTOMATIONS_RUNS_LIST_CHANNEL = 'automations:runs:list'
export const AUTOMATIONS_PROVIDERS_LIST_CHANNEL = 'automations:providers:list'

export type AutomationStatus = 'enabled' | 'paused' | 'blocked'

export type AutomationRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'skipped'

export type TriggerKind = 'schedule' | string

export type ScheduleTriggerConfig = {
  kind: 'schedule'
  cadence:
    | { type: 'interval'; everyMinutes: number }
    | { type: 'daily'; timeLocal: string }
    | { type: 'weekly'; timeLocal: string; daysOfWeek: number[] }
    | { type: 'cron'; expression: string }
  timezone: string
}

export type AutomationTriggerProvider = {
  kind: TriggerKind
  configSchema: JsonSchema
  subscribe(input: {
    config: unknown
    fire: (payload: Record<string, unknown>) => void
    now: () => number
  }): () => void
  computeNextRun?(config: unknown, after: number): number | null
}

export type ActionKind = 'spawn-agent' | 'run-command' | 'run-skill-loop' | string

export type ActionContext = {
  automationId: string
  runId: string
  workspaceRoot: string
  triggerPayload: Record<string, unknown>
  spawnAgent(input: {
    workspaceId?: string
    folderPath: string
    cli?: string
    name?: string
    prompt: string
  }): Promise<{ workspaceId: string; agentId: string }>
  runCommand(input: { command: string[]; cwd: string }): Promise<{ code: number; output: string }>
  reportProgress(patch: Partial<AutomationRun>): void
  requireIntegration(id: string): void
}

export type AutomationActionProvider = {
  kind: ActionKind
  configSchema: JsonSchema
  requiredIntegrations?: string[]
  run(config: unknown, ctx: ActionContext): Promise<Partial<AutomationRun>>
}

export type AutomationDefinition = {
  id: string
  name: string
  status: AutomationStatus
  trigger: { kind: TriggerKind; config: unknown }
  condition?: { kind: string; config: unknown }
  action: { kind: ActionKind; config: unknown }
  autonomyDefault: 'review_only' | 'allow_changes'
  nextRunAt: string | null
  lastRunAt: string | null
  lastRunId: string | null
  createdAt: string
  updatedAt: string
}

export type AutomationRun = {
  id: string
  automationId: string
  status: AutomationRunStatus
  dueAt: string
  startedAt: string | null
  completedAt: string | null
  blockedReason?: string
  workspaceId?: string
  agentId?: string
  promptFingerprint?: string
  touchedFiles?: string[]
  commandsRan?: string[]
  summary?: string
}

export type AutomationDefinitionDraft = {
  id?: string
  name: string
  status: AutomationStatus
  trigger: { kind: TriggerKind; config: unknown }
  condition?: { kind: string; config: unknown }
  action: { kind: ActionKind; config: unknown }
  autonomyDefault: AutomationDefinition['autonomyDefault']
}

export type AutomationDefinitionPatch = Partial<Omit<AutomationDefinitionDraft, 'id'>>

export type AutomationsWorkspaceInput = {
  workspaceRoot: string
}

export type AutomationsDefinitionInput = AutomationsWorkspaceInput & {
  automationId: string
}

export type AutomationsCreateInput = AutomationsWorkspaceInput & {
  definition: AutomationDefinitionDraft
}

export type AutomationsUpdateInput = AutomationsDefinitionInput & {
  patch: AutomationDefinitionPatch
}

export type AutomationsRunsListInput = AutomationsDefinitionInput

export type AutomationsProviderView = {
  kind: string
  configSchema: JsonSchema
  requiredIntegrations: string[]
  missingIntegrations: string[]
}

export type AutomationsProviders = {
  triggers: AutomationsProviderView[]
  actions: AutomationsProviderView[]
}

export type AutomationsResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string }

export type AutomationsListResult = AutomationsResult<AutomationDefinition[]>
export type AutomationsDefinitionResult = AutomationsResult<AutomationDefinition>
export type AutomationsDeleteResult = AutomationsResult<{ automationId: string }>
export type AutomationsRunNowResult = AutomationsResult<{
  definition: AutomationDefinition
  run: AutomationRun
}>
export type AutomationsRunsListResult = AutomationsResult<AutomationRun[]>
export type AutomationsProvidersResult = AutomationsResult<AutomationsProviders>
