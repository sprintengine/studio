import {
  REPO_EVENT_TRIGGER_KIND,
  type AutomationTriggerPollContext,
  type AutomationTriggerPollEvent,
  type AutomationTriggerProvider,
  type RepoEventTriggerConfig,
  type RepoEventType,
} from '../../../shared/automations/contracts'
import {
  REPO_TASK_IMPORT_AUTHOR_ID,
  REPO_TASK_SOURCE_INTEGRATION_ID,
  type RepoTaskProvider,
  type RepoTaskReadResult,
  type RepoTaskRecord,
  type RepoTaskSourceFrontDoors,
} from '../repo-task-source'

// Canonical definitions now live in contracts.ts; re-export so existing importers
// of this module (provider registry, tests) keep their import paths.
export { REPO_EVENT_TRIGGER_KIND }
export type { RepoEventTriggerConfig }

type RepoEventTriggerValidationResult =
  | { ok: true; value: RepoEventTriggerConfig }
  | { ok: false; error: string }

const REPO_EVENT_TYPES = new Set<RepoEventType>(['created', 'updated'])
const REPO_EVENT_PROVIDERS = new Set<RepoTaskProvider | 'any'>(['github', 'jira', 'any'])
const DEFAULT_REPO_EVENT_TYPES: RepoEventType[] = ['updated']
const REPO_TASK_READ_ALL_CACHE_KEY_PREFIX = 'repo-tasks:read-all:'

export function createRepoEventTriggerProvider(
  frontDoors: Pick<RepoTaskSourceFrontDoors, 'readAllTasks'>
): AutomationTriggerProvider {
  return {
    kind: REPO_EVENT_TRIGGER_KIND,
    requiredIntegrations: [REPO_TASK_SOURCE_INTEGRATION_ID],
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

      const read = await readAllRepoTasksForPoll(frontDoors, input.workspaceRoot, input.context)
      if (!read.ok) {
        return {
          ok: false,
          blockedReason: `Repo task sync state is unavailable: ${read.message}`,
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
            ? 'This workspace has no GitHub or Jira sync state.'
            : `This workspace has no ${provider} sync state.`,
        }
      }

      return {
        ok: true,
        events: providerSyncedRecords
          .flatMap((record) => recordToRepoEvents(record))
          .filter((event) => matchesRepoEventConfig(event, validation.value))
          .sort(compareRepoEvents),
      }
    },
  }
}

function readAllRepoTasksForPoll(
  frontDoors: Pick<RepoTaskSourceFrontDoors, 'readAllTasks'>,
  workspaceRoot: string,
  context: AutomationTriggerPollContext | undefined
): Promise<RepoTaskReadResult> {
  const readAll = () => frontDoors.readAllTasks({ workspaceRoot })
  return context
    ? context.getSharedValue(`${REPO_TASK_READ_ALL_CACHE_KEY_PREFIX}${workspaceRoot}`, readAll)
    : readAll()
}

export function validateRepoEventTriggerConfig(config: unknown): RepoEventTriggerValidationResult {
  if (!isRecord(config)) return invalid('Repo-event trigger config must be an object.')
  if (config.kind !== REPO_EVENT_TRIGGER_KIND) return invalid('Repo-event trigger kind must be "repo-event".')

  if (config.provider !== undefined) {
    if (typeof config.provider !== 'string' || !REPO_EVENT_PROVIDERS.has(config.provider as RepoTaskProvider | 'any')) {
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

function recordToRepoEvents(record: RepoTaskRecord): AutomationTriggerPollEvent[] {
  const provider = record.task.source.type
  if (provider !== 'github' && provider !== 'jira') return []

  const importMetadata = readImportMetadata(record)
  if (!importMetadata) return []

  const sourceKey =
    normalizedString(record.task.source.externalId)
    ?? normalizedString(record.task.source.externalKey)
    ?? normalizedString(record.task.source.externalUrl)
    ?? record.task.id
  const externalKey = normalizedString(record.task.source.externalKey)
  const externalUrl = normalizedString(record.task.source.externalUrl)
  const externalId = normalizedString(record.task.source.externalId)
  const basePayload = {
    kind: REPO_EVENT_TRIGGER_KIND,
    provider,
    taskId: record.task.id,
    identifier: record.task.identifier,
    title: record.task.title,
    taskState: record.task.state,
    labels: record.task.labels,
    ...(externalId ? { externalId } : {}),
    ...(externalKey ? { externalKey } : {}),
    ...(externalUrl ? { externalUrl } : {}),
  }
  const events: AutomationTriggerPollEvent[] = []

  events.push({
    id: [
      REPO_EVENT_TRIGGER_KIND,
      provider,
      sourceKey,
      'created',
      importMetadata.createdAt,
    ].join(':'),
    occurredAt: importMetadata.createdAt,
    payload: {
      ...basePayload,
      eventType: 'created',
      occurredAt: importMetadata.createdAt,
      importedAt: importMetadata.createdAt,
    },
  })

  if (importMetadata.externalUpdatedAt) {
    events.push({
      id: [
        REPO_EVENT_TRIGGER_KIND,
        provider,
        sourceKey,
        'updated',
        importMetadata.externalUpdatedAt,
      ].join(':'),
      occurredAt: importMetadata.externalUpdatedAt,
      payload: {
        ...basePayload,
        eventType: 'updated',
        occurredAt: importMetadata.externalUpdatedAt,
        externalUpdatedAt: importMetadata.externalUpdatedAt,
      },
    })
  }

  return events
}

function matchesRepoEventConfig(event: AutomationTriggerPollEvent, config: RepoEventTriggerConfig): boolean {
  const payload = event.payload
  if (config.provider && config.provider !== 'any' && payload.provider !== config.provider) return false
  const eventTypes = config.eventTypes?.length ? config.eventTypes : DEFAULT_REPO_EVENT_TYPES
  if (!eventTypes.includes(payload.eventType as RepoEventType)) return false
  if (config.externalKey && payload.externalKey !== config.externalKey) return false
  if (config.label) {
    const labels = Array.isArray(payload.labels) ? payload.labels : []
    if (!labels.some((label) => label === config.label)) return false
  }
  return true
}

function isRepoSyncRecord(record: RepoTaskRecord): boolean {
  return record.task.source.type === 'github' || record.task.source.type === 'jira'
}

function readImportMetadata(record: RepoTaskRecord): { createdAt: string; externalUpdatedAt: string | null } | null {
  let createdAt: string | null = null

  for (const comment of record.task.comments) {
    if (comment.kind !== 'import') continue
    if (comment.author.id !== REPO_TASK_IMPORT_AUTHOR_ID) continue
    const commentCreatedAt = normalizedIsoTimestamp(comment.createdAt)
    if (!commentCreatedAt) continue
    createdAt ??= commentCreatedAt
  }

  const externalUpdatedAt = normalizedIsoTimestamp(record.task.source.externalUpdatedAt ?? '')
  return createdAt ? { createdAt, externalUpdatedAt } : null
}

function normalizedIsoTimestamp(value: string): string | null {
  const parsed = Date.parse(value)
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
