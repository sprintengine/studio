import type {
  AutomationDefinition,
  AutomationRun,
  AutomationTriggerPollEvent,
} from '../../shared/automations/contracts'
import type {
  AutomationRunExecutor,
  AutomationsEngineEvaluationResult,
  AutomationsEngineProblem,
  AutomationsEngineRunSummary,
  AutomationsProjectFolder,
} from './engine'
import { completeAutomationRun as completeRun } from './run-record'
import { AutomationsStore, type AutomationStoreProblem, type AutomationStoreState } from './store'

export const TRIGGER_EVENT_DEDUP_RETENTION_LIMIT = 100

export type TriggerEventRunResult =
  | { status: 'duplicate' }
  | { status: 'in_flight' }
  | { status: 'fired'; summary: AutomationsEngineRunSummary; run: AutomationRun }
  | { status: 'problem'; problem: AutomationsEngineProblem }

export type TriggerEventRunInput = {
  store: AutomationsStore
  state: AutomationStoreState
  projectFolder: AutomationsProjectFolder
  definition: AutomationDefinition
  event: AutomationTriggerPollEvent
  runAutomation: AutomationRunExecutor
  now: () => number
  createRunId: (input: { workspaceRoot: string; automationId: string; dueAt: string }) => string
  inFlight: Set<string>
  emitRunEvent(input: { workspaceId?: string | null; definition: AutomationDefinition; run: AutomationRun }): void
  result?: AutomationsEngineEvaluationResult
}

export async function enqueueTriggerEventRun(input: TriggerEventRunInput): Promise<TriggerEventRunResult> {
  const { definition, event, projectFolder, store } = input
  const workspaceRoot = projectFolder.folderPath
  if (input.state.triggerEventDedupByAutomationId?.[definition.id]?.[event.id]) {
    return { status: 'duplicate' }
  }

  const inFlightKey = triggerEventInFlightKey(workspaceRoot, definition.id)
  if (input.inFlight.has(inFlightKey)) {
    input.result?.droppedInFlight.push({ workspaceRoot, automationId: definition.id })
    return { status: 'in_flight' }
  }

  input.inFlight.add(inFlightKey)
  const dueAt = normalizedIso(event.occurredAt) ?? new Date(input.now()).toISOString()
  const startedAt = new Date(input.now()).toISOString()
  const run = runRecord(input, dueAt, {
    status: 'running',
    startedAt,
    completedAt: null,
  })

  try {
    const started = await store.recordRun(run)
    if (!started.ok) return problem(input, storeProblem(workspaceRoot, started.error, definition.id))

    try {
      const patch = await input.runAutomation({
        workspaceRoot,
        definition,
        run,
        triggerPayload: event.payload,
        workspaceId: projectFolder.workspaceId,
      })
      const completedAt = patch.completedAt ?? new Date(input.now()).toISOString()
      const finalRun = completeRun(run, patch, completedAt)
      return await completeTriggerEventRun(input, event.id, finalRun, completedAt)
    } catch (error) {
      const failedAt = new Date(input.now()).toISOString()
      const failedRun = completeRun(
        run,
        {
          status: 'failed',
          completedAt: failedAt,
          summary: error instanceof Error ? error.message : 'Automation action failed.',
        },
        failedAt,
      )
      return await completeTriggerEventRun(input, event.id, failedRun, failedAt)
    }
  } finally {
    input.inFlight.delete(inFlightKey)
  }
}

export function clearTriggerBlockedReasonState(state: AutomationStoreState, automationId: string): void {
  if (!state.triggerBlockedReasonByAutomationId) return
  delete state.triggerBlockedReasonByAutomationId[automationId]
}

export function triggerEventInFlightKey(workspaceRoot: string, automationId: string): string {
  return `${workspaceRoot}\u0000${automationId}`
}

async function completeTriggerEventRun(
  input: TriggerEventRunInput,
  eventId: string,
  finalRun: AutomationRun,
  completedAt: string,
): Promise<TriggerEventRunResult> {
  const { definition, projectFolder, store } = input
  const workspaceRoot = projectFolder.folderPath
  const completed = await store.recordRun(finalRun)
  if (!completed.ok) return problem(input, storeProblem(workspaceRoot, completed.error, definition.id))
  input.emitRunEvent({ workspaceId: projectFolder.workspaceId, definition, run: finalRun })

  const updated = await updateDefinitionAfterTriggerRun(input, finalRun, Date.parse(completedAt), () => {
    markTriggerEventSeen(input.state, definition.id, eventId, completedAt)
    clearTriggerBlockedReasonState(input.state, definition.id)
  })
  if (!updated) {
    const existingProblem = input.result?.problems[input.result.problems.length - 1]
    if (existingProblem) return { status: 'problem', problem: existingProblem }
    return problem(input, {
      workspaceRoot,
      automationId: definition.id,
      code: 'definition_update_failed',
      message: `Automation "${definition.id}" ran, but its trigger state could not be updated.`,
    })
  }

  const summary = {
    workspaceRoot,
    automationId: definition.id,
    runId: finalRun.id,
    status: finalRun.status,
  }
  input.result?.fired.push(summary)
  return { status: 'fired', summary, run: finalRun }
}

async function updateDefinitionAfterTriggerRun(
  input: TriggerEventRunInput,
  run: AutomationRun,
  updatedAt: number,
  mutateState: () => void,
): Promise<boolean> {
  const { definition, projectFolder, state, store } = input
  const workspaceRoot = projectFolder.folderPath
  const updatedAtIso = new Date(updatedAt).toISOString()
  // Once-off consumption for the trigger-event path (webhook + polling both
  // funnel through here): one launched run consumes the shot and pauses the
  // definition — even a failed run, per the once-off contract. Blocked polls
  // never reach this function (polling-trigger-runner records those through its
  // own non-pausing copy), so a shot is only ever consumed by a launched run.
  const pauseAfterRun = definition.disableAfterRun === true && definition.status === 'enabled'
  const updated = await store.updateDefinition({
    ...definition,
    ...(pauseAfterRun ? { status: 'paused' as const } : {}),
    nextRunAt: null,
    lastRunAt: run.completedAt ?? updatedAtIso,
    lastRunId: run.id,
    updatedAt: updatedAtIso,
  })
  if (!updated.ok) {
    pushProblem(input, storeProblem(workspaceRoot, updated.error, definition.id))
    return false
  }

  state.nextRunAtByAutomationId[definition.id] = null
  mutateState()
  const stateWrite = await store.writeState(state)
  if (!stateWrite.ok) {
    pushProblem(input, storeProblem(workspaceRoot, stateWrite.error, definition.id))
    return false
  }
  return true
}

function runRecord(
  input: TriggerEventRunInput,
  dueAt: string,
  fields: Pick<AutomationRun, 'status' | 'startedAt' | 'completedAt'> & Partial<AutomationRun>,
): AutomationRun {
  return {
    id: input.createRunId({ workspaceRoot: input.projectFolder.folderPath, automationId: input.definition.id, dueAt }),
    automationId: input.definition.id,
    dueAt,
    ...fields,
  }
}

function markTriggerEventSeen(
  state: AutomationStoreState,
  automationId: string,
  eventId: string,
  seenAt: string,
): void {
  state.triggerEventDedupByAutomationId = state.triggerEventDedupByAutomationId ?? {}
  state.triggerEventDedupByAutomationId[automationId] = state.triggerEventDedupByAutomationId[automationId] ?? {}
  const automationEvents = state.triggerEventDedupByAutomationId[automationId]
  automationEvents[eventId] = seenAt
  pruneTriggerEventDedup(automationEvents)
}

function pruneTriggerEventDedup(events: Record<string, string>): void {
  const entries = Object.entries(events)
  if (entries.length <= TRIGGER_EVENT_DEDUP_RETENTION_LIMIT) return

  const retainedEventIds = new Set(
    entries
      .sort(compareTriggerEventDedupEntriesNewestFirst)
      .slice(0, TRIGGER_EVENT_DEDUP_RETENTION_LIMIT)
      .map(([eventId]) => eventId),
  )
  for (const eventId of Object.keys(events)) {
    if (!retainedEventIds.has(eventId)) delete events[eventId]
  }
}

function compareTriggerEventDedupEntriesNewestFirst(
  [leftEventId, leftSeenAt]: [string, string],
  [rightEventId, rightSeenAt]: [string, string],
): number {
  const leftTimestamp = triggerEventDedupTimestamp(leftSeenAt)
  const rightTimestamp = triggerEventDedupTimestamp(rightSeenAt)
  if (leftTimestamp !== rightTimestamp) return rightTimestamp - leftTimestamp
  return rightEventId.localeCompare(leftEventId)
}

function triggerEventDedupTimestamp(value: string): number {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY
}

function normalizedIso(value: string): string | null {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function problem(input: TriggerEventRunInput, value: AutomationsEngineProblem): TriggerEventRunResult {
  pushProblem(input, value)
  return { status: 'problem', problem: value }
}

function pushProblem(input: TriggerEventRunInput, value: AutomationsEngineProblem): void {
  input.result?.problems.push(value)
}

function storeProblem(
  workspaceRoot: string,
  error: AutomationStoreProblem,
  automationId?: string,
): AutomationsEngineProblem {
  return {
    workspaceRoot,
    automationId,
    code: error.code,
    message: `${error.path}: ${error.message}`,
  }
}
