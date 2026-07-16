import type {
  AutomationDefinition,
  AutomationRun,
  AutomationTriggerPollContext,
  AutomationTriggerProvider,
} from '../../shared/automations/contracts'
import type { AutomationRunExecutor, AutomationsEngineEvaluationResult, AutomationsProjectFolder } from './engine'
import { AutomationsStore, type AutomationStoreProblem, type AutomationStoreState } from './store'
import {
  clearTriggerBlockedReasonState,
  enqueueTriggerEventRun,
  triggerEventInFlightKey,
} from './trigger-event-runner'

export { TRIGGER_EVENT_DEDUP_RETENTION_LIMIT } from './trigger-event-runner'

export type PollingTriggerEvaluationInput = {
  store: AutomationsStore
  state: AutomationStoreState
  projectFolder: AutomationsProjectFolder
  definition: AutomationDefinition
  triggerProvidersByKind: ReadonlyMap<string, AutomationTriggerProvider>
  pollContext: AutomationTriggerPollContext
  isIntegrationAvailable?: (id: string) => boolean | undefined
  runAutomation: AutomationRunExecutor
  now: () => number
  createRunId: (input: { workspaceRoot: string; automationId: string; dueAt: string }) => string
  inFlight: Set<string>
  emitRunEvent(input: { workspaceId?: string | null; definition: AutomationDefinition; run: AutomationRun }): void
  result: AutomationsEngineEvaluationResult
}

export async function evaluatePollingTriggerDefinition(input: PollingTriggerEvaluationInput): Promise<void> {
  const { definition, projectFolder, result } = input
  const workspaceRoot = projectFolder.folderPath
  const provider = input.triggerProvidersByKind.get(definition.trigger.kind)
  if (!provider) {
    result.problems.push({
      workspaceRoot,
      automationId: definition.id,
      code: 'unknown_trigger',
      message: `No automation trigger provider is registered for "${definition.trigger.kind}".`,
    })
    return
  }

  if (!provider.poll) {
    result.problems.push({
      workspaceRoot,
      automationId: definition.id,
      code: 'unsupported_trigger',
      message: `Automation trigger "${definition.trigger.kind}" does not support engine polling.`,
    })
    return
  }

  const configValidation = provider.validateConfig?.(definition.trigger.config)
  if (configValidation && !configValidation.ok) {
    result.problems.push({
      workspaceRoot,
      automationId: definition.id,
      code: 'invalid_trigger_config',
      message: configValidation.error,
    })
    return
  }

  const missingIntegrations = (provider.requiredIntegrations ?? [])
    .filter((id) => input.isIntegrationAvailable?.(id) !== true)
  if (missingIntegrations.length > 0) {
    await recordBlockedTriggerRun(input, `Required trigger integration is unavailable: ${missingIntegrations.join(', ')}.`)
    return
  }

  let pollResult: Awaited<ReturnType<NonNullable<AutomationTriggerProvider['poll']>>>
  try {
    pollResult = await provider.poll({
      config: definition.trigger.config,
      workspaceRoot,
      now: input.now,
      context: input.pollContext,
    })
  } catch (error) {
    await recordBlockedTriggerRun(
      input,
      error instanceof Error ? error.message : `Automation trigger "${definition.trigger.kind}" failed while polling.`
    )
    return
  }

  if (!pollResult.ok) {
    await recordBlockedTriggerRun(input, pollResult.blockedReason)
    return
  }

  await clearTriggerBlockedReason(input)

  for (const event of pollResult.events) {
    await enqueueTriggerEventRun({ ...input, event })
  }
}

async function recordBlockedTriggerRun(input: PollingTriggerEvaluationInput, blockedReason: string): Promise<void> {
  const { definition, projectFolder, result, state, store } = input
  const workspaceRoot = projectFolder.folderPath
  if (state.triggerBlockedReasonByAutomationId?.[definition.id] === blockedReason) return

  const inFlightKey = triggerEventInFlightKey(workspaceRoot, definition.id)
  if (input.inFlight.has(inFlightKey)) {
    result.droppedInFlight.push({ workspaceRoot, automationId: definition.id })
    return
  }

  input.inFlight.add(inFlightKey)
  try {
    const completedAt = new Date(input.now()).toISOString()
    const run = runRecord(input, completedAt, {
      status: 'blocked',
      startedAt: null,
      completedAt,
      blockedReason,
      summary: blockedReason,
    })
    const recorded = await store.recordRun(run)
    if (!recorded.ok) {
      result.problems.push(storeProblem(workspaceRoot, recorded.error, definition.id))
      return
    }
    input.emitRunEvent({ workspaceId: projectFolder.workspaceId, definition, run })

    const updated = await updateDefinitionAfterTriggerRun(input, run, Date.parse(completedAt), () => {
      state.triggerBlockedReasonByAutomationId = state.triggerBlockedReasonByAutomationId ?? {}
      state.triggerBlockedReasonByAutomationId[definition.id] = blockedReason
    })
    if (updated) result.fired.push({ workspaceRoot, automationId: definition.id, runId: run.id, status: run.status })
  } finally {
    input.inFlight.delete(inFlightKey)
  }
}

async function clearTriggerBlockedReason(input: PollingTriggerEvaluationInput): Promise<void> {
  const { definition, projectFolder, result, state, store } = input
  if (!state.triggerBlockedReasonByAutomationId?.[definition.id]) return
  clearTriggerBlockedReasonState(state, definition.id)
  const written = await store.writeState(state)
  if (!written.ok) result.problems.push(storeProblem(projectFolder.folderPath, written.error, definition.id))
}

// Deliberately does NOT honor `disableAfterRun`: this copy only records blocked
// polls, where no run was launched, so the once-off shot is not consumed. The
// pausing seam for launched trigger runs lives in trigger-event-runner.ts.
async function updateDefinitionAfterTriggerRun(
  input: PollingTriggerEvaluationInput,
  run: AutomationRun,
  updatedAt: number,
  mutateState: () => void
): Promise<boolean> {
  const { definition, projectFolder, result, state, store } = input
  const workspaceRoot = projectFolder.folderPath
  const updatedAtIso = new Date(updatedAt).toISOString()
  const updated = await store.updateDefinition({
    ...definition,
    nextRunAt: null,
    lastRunAt: run.completedAt ?? updatedAtIso,
    lastRunId: run.id,
    updatedAt: updatedAtIso,
  })
  if (!updated.ok) {
    result.problems.push(storeProblem(workspaceRoot, updated.error, definition.id))
    return false
  }

  state.nextRunAtByAutomationId[definition.id] = null
  mutateState()
  const stateWrite = await store.writeState(state)
  if (!stateWrite.ok) {
    result.problems.push(storeProblem(workspaceRoot, stateWrite.error, definition.id))
    return false
  }
  return true
}

function runRecord(
  input: PollingTriggerEvaluationInput,
  dueAt: string,
  fields: Pick<AutomationRun, 'status' | 'startedAt' | 'completedAt'> & Partial<AutomationRun>
): AutomationRun {
  return {
    id: input.createRunId({ workspaceRoot: input.projectFolder.folderPath, automationId: input.definition.id, dueAt }),
    automationId: input.definition.id,
    dueAt,
    ...fields,
  }
}

function storeProblem(workspaceRoot: string, error: AutomationStoreProblem, automationId?: string) {
  return {
    workspaceRoot,
    automationId,
    code: error.code,
    message: `${error.path}: ${error.message}`,
  }
}
