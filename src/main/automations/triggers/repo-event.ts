import type {
  AutomationTriggerPollEvent,
  AutomationTriggerProvider,
} from '../../../shared/automations/contracts'
import type {
  SwitchboardImportProvider,
  SwitchboardTaskRecord,
} from '../../../shared/switchboard'
import {
  SWITCHBOARD_AUTOMATION_INTEGRATION_ID,
  type SwitchboardAutomationFrontDoors,
} from '../actions/switchboard'

export const REPO_EVENT_TRIGGER_KIND = 'repo-event'

type RepoEventType = 'created' | 'updated'

export type RepoEventTriggerConfig = {
  kind: typeof REPO_EVENT_TRIGGER_KIND
  provider?: SwitchboardImportProvider | 'any'
  eventTypes?: RepoEventType[]
  externalKey?: string
  label?: string
}

type RepoEventTriggerValidationResult =
  | { ok: true; value: RepoEventTriggerConfig }
  | { ok: false; error: string }

const REPO_EVENT_TYPES = new Set<RepoEventType>(['created', 'updated'])
const REPO_EVENT_PROVIDERS = new Set<SwitchboardImportProvider | 'any'>(['github', 'jira', 'any'])
const EXTERNAL_UPDATED_AT_LABEL = 'External updated at:'

export function createRepoEventTriggerProvider(
  frontDoors: Pick<SwitchboardAutomationFrontDoors, 'readAllTasks'>
): AutomationTriggerProvider {
  return {
    kind: REPO_EVENT_TRIGGER_KIND,
    requiredIntegrations: [SWITCHBOARD_AUTOMATION_INTEGRATION_ID],
    configSchema: {
      type: 'object',
      required: ['kind'],
      properties: {
        kind: { const: REPO_EVENT_TRIGGER_KIND },
        provider: { type: 'string', enum: ['github', 'jira', 'any'] },
        eventTypes: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: { type: 'string', enum: ['created', 'updated'] },
        },
        externalKey: { type: 'string', minLength: 1 },
        label: { type: 'string', minLength: 1 },
      },
    },
    validateConfig(config) {
      const validation = validateRepoEventTriggerConfig(config)
      return validation.ok ? { ok: true } : validation
    },
    subscribe(input) {
      const validation = validateRepoEventTriggerConfig(input.config)
      if (!validation.ok) throw new Error(validation.error)
      return () => undefined
    },
    async poll(input) {
      const validation = validateRepoEventTriggerConfig(input.config)
      if (!validation.ok) return { ok: false, blockedReason: validation.error }

      const read = await frontDoors.readAllTasks({ workspaceRoot: input.workspaceRoot })
      if (!read.ok) {
        return {
          ok: false,
          blockedReason: `Switchboard sync state is unavailable: ${read.message}`,
        }
      }

      const provider = validation.value.provider ?? 'any'
      const syncedRecords = read.tasks.filter((record) => isRepoSyncRecord(record))
      const providerSyncedRecords = provider === 'any'
        ? syncedRecords
        : syncedRecords.filter((record) => record.task.source.type === provider)
      if (providerSyncedRecords.length === 0) {
        return {
          ok: false,
          blockedReason: provider === 'any'
            ? 'Switchboard has no GitHub or Jira sync state for this workspace.'
            : `Switchboard has no ${provider} sync state for this workspace.`,
        }
      }

      return {
        ok: true,
        events: providerSyncedRecords
          .map((record) => recordToRepoEvent(record))
          .filter((event): event is AutomationTriggerPollEvent => event !== null)
          .filter((event) => matchesRepoEventConfig(event, validation.value))
          .sort(compareRepoEvents),
      }
    },
  }
}

export function validateRepoEventTriggerConfig(config: unknown): RepoEventTriggerValidationResult {
  if (!isRecord(config)) return invalid('Repo-event trigger config must be an object.')
  if (config.kind !== REPO_EVENT_TRIGGER_KIND) return invalid('Repo-event trigger kind must be "repo-event".')

  if (config.provider !== undefined) {
    if (typeof config.provider !== 'string' || !REPO_EVENT_PROVIDERS.has(config.provider as SwitchboardImportProvider | 'any')) {
      return invalid('Repo-event trigger provider must be "github", "jira", or "any".')
    }
  }

  if (config.eventTypes !== undefined) {
    if (
      !Array.isArray(config.eventTypes)
      || config.eventTypes.length === 0
      || !config.eventTypes.every((eventType) => typeof eventType === 'string' && REPO_EVENT_TYPES.has(eventType as RepoEventType))
      || new Set(config.eventTypes).size !== config.eventTypes.length
    ) {
      return invalid('Repo-event trigger eventTypes must contain unique "created" or "updated" values.')
    }
  }

  const externalKey = trimmedString(config.externalKey)
  if (config.externalKey !== undefined && !externalKey) {
    return invalid('Repo-event trigger externalKey must be a non-empty string.')
  }

  const label = trimmedString(config.label)
  if (config.label !== undefined && !label) {
    return invalid('Repo-event trigger label must be a non-empty string.')
  }

  return {
    ok: true,
    value: {
      kind: REPO_EVENT_TRIGGER_KIND,
      provider: config.provider === 'github' || config.provider === 'jira' || config.provider === 'any'
        ? config.provider
        : undefined,
      eventTypes: Array.isArray(config.eventTypes) ? config.eventTypes as RepoEventType[] : undefined,
      ...(externalKey ? { externalKey } : {}),
      ...(label ? { label } : {}),
    },
  }
}

function recordToRepoEvent(record: SwitchboardTaskRecord): AutomationTriggerPollEvent | null {
  const provider = record.task.source.type
  if (provider !== 'github' && provider !== 'jira') return null

  const externalUpdatedAt = latestExternalUpdatedAt(record)
  if (!externalUpdatedAt) return null

  const sourceKey =
    normalizedString(record.task.source.externalId)
    ?? normalizedString(record.task.source.externalKey)
    ?? normalizedString(record.task.source.externalUrl)
    ?? record.task.id
  const externalKey = normalizedString(record.task.source.externalKey)
  const externalUrl = normalizedString(record.task.source.externalUrl)
  const externalId = normalizedString(record.task.source.externalId)

  return {
    id: [
      REPO_EVENT_TRIGGER_KIND,
      provider,
      sourceKey,
      'updated',
      externalUpdatedAt,
    ].join(':'),
    occurredAt: externalUpdatedAt,
    payload: {
      kind: REPO_EVENT_TRIGGER_KIND,
      provider,
      eventType: 'updated',
      taskId: record.task.id,
      identifier: record.task.identifier,
      title: record.task.title,
      taskState: record.task.state,
      labels: record.task.labels,
      occurredAt: externalUpdatedAt,
      externalUpdatedAt,
      ...(externalId ? { externalId } : {}),
      ...(externalKey ? { externalKey } : {}),
      ...(externalUrl ? { externalUrl } : {}),
    },
  }
}

function matchesRepoEventConfig(event: AutomationTriggerPollEvent, config: RepoEventTriggerConfig): boolean {
  const payload = event.payload
  if (config.provider && config.provider !== 'any' && payload.provider !== config.provider) return false
  if (config.eventTypes?.length && !config.eventTypes.includes(payload.eventType as RepoEventType)) return false
  if (config.externalKey && payload.externalKey !== config.externalKey) return false
  if (config.label) {
    const labels = Array.isArray(payload.labels) ? payload.labels : []
    if (!labels.some((label) => label === config.label)) return false
  }
  return true
}

function isRepoSyncRecord(record: SwitchboardTaskRecord): boolean {
  return record.task.source.type === 'github' || record.task.source.type === 'jira'
}

function latestExternalUpdatedAt(record: SwitchboardTaskRecord): string | null {
  for (const comment of [...record.task.comments].reverse()) {
    if (comment.kind !== 'import') continue
    if (comment.author.id !== 'switchboard-import') continue
    const externalUpdatedAt = parseExternalUpdatedAt(comment.body)
    if (externalUpdatedAt) return externalUpdatedAt
  }
  return null
}

function parseExternalUpdatedAt(body: string): string | null {
  const labelIndex = body.indexOf(EXTERNAL_UPDATED_AT_LABEL)
  if (labelIndex < 0) return null
  const raw = body.slice(labelIndex + EXTERNAL_UPDATED_AT_LABEL.length).trim().split(/\s+/u)[0]?.replace(/[.)]+$/u, '')
  if (!raw) return null
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function compareRepoEvents(left: AutomationTriggerPollEvent, right: AutomationTriggerPollEvent): number {
  const timeDelta = Date.parse(left.occurredAt) - Date.parse(right.occurredAt)
  if (timeDelta !== 0) return timeDelta
  return left.id.localeCompare(right.id)
}

function normalizedString(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function invalid(error: string): RepoEventTriggerValidationResult {
  return { ok: false, error }
}
