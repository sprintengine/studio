import type {
  AutomationDefinition,
  AutomationRun,
  AutomationTriggerPollEvent,
  AutomationTriggerProvider,
} from '../../shared/automations/contracts'
import type { AutomationRunExecutor, AutomationsEngineEvaluationResult, AutomationsProjectFolder } from './engine'
import { AutomationsStore, type AutomationStoreProblem, type AutomationStoreState } from './store'

export type PollingTriggerEvaluationInput = {
  store: AutomationsStore
  state: AutomationStoreState
  projectFolder: AutomationsProjectFolder
  definition: AutomationDefinition
  triggerProvidersByKind: ReadonlyMap<string, AutomationTriggerProvider>
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
    if (input.state.triggerEventDedupByAutomationId?.[definition.id]?.[event.id]) continue
    await fireTriggerEventRun(input, event)
  }
}

async function fireTriggerEventRun(
  input: PollingTriggerEvaluationInput,
  event: AutomationTriggerPollEvent
): Promise<void> {
  const { definition, projectFolder, result, store } = input
  const workspaceRoot = projectFolder.folderPath
  const inFlightKey = triggerInFlightKey(workspaceRoot, definition.id)
  if (input.inFlight.has(inFlightKey)) {
    result.droppedInFlight.push({ workspaceRoot, automationId: definition.id })
    return
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
    if (!started.ok) {
      result.problems.push(storeProblem(workspaceRoot, started.error, definition.id))
      return
    }

    const patch = await input.runAutomation({
      workspaceRoot,
      definition,
      run,
      triggerPayload: event.payload,
    })
    const completedAt = patch.completedAt ?? new Date(input.now()).toISOString()
    const finalRun = completeRun(run, patch, completedAt)
    const completed = await store.recordRun(finalRun)
    if (!completed.ok) {
      result.problems.push(storeProblem(workspaceRoot, completed.error, definition.id))
      return
    }
    input.emitRunEvent({ workspaceId: projectFolder.workspaceId, definition, run: finalRun })

    const updated = await updateDefinitionAfterTriggerRun(input, finalRun, Date.parse(completedAt), () => {
      markTriggerEventSeen(input.state, definition.id, event.id, completedAt)
      clearTriggerBlockedReasonState(input.state, definition.id)
    })
    if (updated) result.fired.push({ workspaceRoot, automationId: definition.id, runId: finalRun.id, status: finalRun.status })
  } catch (error) {
    const failedAt = new Date(input.now()).toISOString()
    const failedRun = completeRun(run, {
      status: 'failed',
      completedAt: failedAt,
      summary: error instanceof Error ? error.message : 'Automation action failed.',
    }, failedAt)
    const recorded = await store.recordRun(failedRun)
    if (!recorded.ok) {
      result.problems.push(storeProblem(workspaceRoot, recorded.error, definition.id))
      return
    }
    input.emitRunEvent({ workspaceId: projectFolder.workspaceId, definition, run: failedRun })

    const updated = await updateDefinitionAfterTriggerRun(input, failedRun, Date.parse(failedAt), () => {
      markTriggerEventSeen(input.state, definition.id, event.id, failedAt)
      clearTriggerBlockedReasonState(input.state, definition.id)
    })
    if (updated) result.fired.push({ workspaceRoot, automationId: definition.id, runId: failedRun.id, status: failedRun.status })
  } finally {
    input.inFlight.delete(inFlightKey)
  }
}

async function recordBlockedTriggerRun(input: PollingTriggerEvaluationInput, blockedReason: string): Promise<void> {
  const { definition, projectFolder, result, state, store } = input
  const workspaceRoot = projectFolder.folderPath
  if (state.triggerBlockedReasonByAutomationId?.[definition.id] === blockedReason) return

  const inFlightKey = triggerInFlightKey(workspaceRoot, definition.id)
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

function completeRun(run: AutomationRun, patch: Partial<AutomationRun>, completedAt: string): AutomationRun {
  return {
    ...run,
    status: patch.status ?? 'completed',
    completedAt,
    blockedReason: patch.blockedReason,
    workspaceId: patch.workspaceId,
    agentId: patch.agentId,
    promptFingerprint: patch.promptFingerprint,
    touchedFiles: patch.touchedFiles,
    commandsRan: patch.commandsRan,
    summary: patch.summary,
  }
}

function markTriggerEventSeen(
  state: AutomationStoreState,
  automationId: string,
  eventId: string,
  seenAt: string
): void {
  state.triggerEventDedupByAutomationId = state.triggerEventDedupByAutomationId ?? {}
  state.triggerEventDedupByAutomationId[automationId] = state.triggerEventDedupByAutomationId[automationId] ?? {}
  state.triggerEventDedupByAutomationId[automationId][eventId] = seenAt
}

function clearTriggerBlockedReasonState(state: AutomationStoreState, automationId: string): void {
  if (!state.triggerBlockedReasonByAutomationId) return
  delete state.triggerBlockedReasonByAutomationId[automationId]
}

function triggerInFlightKey(workspaceRoot: string, automationId: string): string {
  return `${workspaceRoot}\u0000${automationId}`
}

function normalizedIso(value: string): string | null {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function storeProblem(workspaceRoot: string, error: AutomationStoreProblem, automationId?: string) {
  return {
    workspaceRoot,
    automationId,
    code: error.code,
    message: `${error.path}: ${error.message}`,
  }
}
