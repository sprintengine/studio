import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  AutomationDefinition,
  AutomationRun,
  AutomationTriggerProvider,
  AutomationsRunEvent,
  ScheduleTriggerConfig,
} from '../../shared/automations/contracts'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import { AutomationsEngine, projectFoldersFromWorkspaceSyncSnapshot } from './engine'
import { AutomationsStore, type AutomationStoreState } from './store'
import { computeNextRun, validateScheduleTriggerConfig } from './schedule'
import { AutomationWebhookReceiver } from './webhook-receiver'
import {
  createWebhookSignature,
  createWebhookTriggerProvider,
  webhookEndpointPath,
  WEBHOOK_DELIVERY_ID_HEADER,
  WEBHOOK_EVENT_TIME_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TRIGGER_KIND,
} from './triggers/webhook'

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})

async function main(): Promise<void> {
  assertIntervalDailyWeeklyNextRuns()
  assertDstRules()
  assertInvalidIntervalIsRejected()
  assertWorkspaceSnapshotFolderExtraction()
  await assertDueAutomationSkipsOverlappingTickAndPreservesSingleFlight()
  await assertRunEventsEmitForTimerAndManualTerminalStatuses()
  await assertRunEventDeliveryFailuresDoNotMutateRunTruth()
  await assertPollingTriggersUseProviderGetterAtEvaluationTime()
  await assertWebhookReceiverOptInAuthAndDedupesDeliveredEvents()
  await assertStartupOverdueIsSkippedWithoutCatchup()
  await assertTickWaitsForStartupOverdueSkip()
}

function definition(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: 'nightly-review',
    name: 'Nightly review',
    status: 'enabled',
    trigger: {
      kind: 'schedule',
      config: dailyConfig('02:00', 'UTC'),
    },
    action: {
      kind: 'spawn-agent',
      config: { prompt: 'Review the repository.' },
    },
    autonomyDefault: 'review_only',
    nextRunAt: '2026-06-17T02:00:00.000Z',
    lastRunAt: null,
    lastRunId: null,
    createdAt: '2026-06-17T00:00:00.000Z',
    updatedAt: '2026-06-17T00:00:00.000Z',
    ...overrides,
  }
}

function intervalConfig(everyMinutes: number): ScheduleTriggerConfig {
  return {
    kind: 'schedule',
    timezone: 'UTC',
    cadence: { type: 'interval', everyMinutes },
  }
}

function dailyConfig(timeLocal: string, timezone: string): ScheduleTriggerConfig {
  return {
    kind: 'schedule',
    timezone,
    cadence: { type: 'daily', timeLocal },
  }
}

function weeklyConfig(timeLocal: string, daysOfWeek: number[]): ScheduleTriggerConfig {
  return {
    kind: 'schedule',
    timezone: 'UTC',
    cadence: { type: 'weekly', timeLocal, daysOfWeek },
  }
}

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'multicode-automations-engine-'))
}

class InMemoryAutomationsStore extends AutomationsStore {
  state: AutomationStoreState = { nextRunAtByAutomationId: {}, lock: null }
  runs: AutomationRun[] = []

  constructor(definitionValue: AutomationDefinition) {
    super(join(tmpdir(), 'multicode-automations-engine-memory'))
    this.definitionValue = definitionValue
  }

  private definitionValue: AutomationDefinition
  private delayNextSkippedRun = false
  private skippedRunStarted: (() => void) | null = null
  private releaseSkippedRun: Promise<void> | null = null

  delaySkippedRunRecord(input: { started: () => void; release: Promise<void> }): void {
    this.delayNextSkippedRun = true
    this.skippedRunStarted = input.started
    this.releaseSkippedRun = input.release
  }

  async listDefinitions() {
    return { ok: true as const, values: [clone(this.definitionValue)] }
  }

  async readState() {
    return { ok: true as const, value: clone(this.state) }
  }

  async writeState(state: AutomationStoreState) {
    this.state = clone(state)
    return { ok: true as const, value: clone(this.state) }
  }

  async recordRun(run: AutomationRun) {
    if (this.delayNextSkippedRun && run.status === 'skipped') {
      this.delayNextSkippedRun = false
      this.skippedRunStarted?.()
      await this.releaseSkippedRun
    }

    const nextRun = clone(run)
    this.runs = this.runs.filter((candidate) => candidate.id !== nextRun.id)
    this.runs.push(nextRun)
    return { ok: true as const, value: clone(nextRun) }
  }

  async updateDefinition(definitionValue: AutomationDefinition) {
    this.definitionValue = clone(definitionValue)
    return { ok: true as const, value: clone(this.definitionValue) }
  }

  async getDefinition() {
    return { ok: true as const, value: clone(this.definitionValue) }
  }

  async listRuns() {
    return { ok: true as const, values: this.runs.map((run) => clone(run)) }
  }
}

function assertIntervalDailyWeeklyNextRuns(): void {
  const after = Date.parse('2026-06-17T10:00:00.000Z')

  assert.equal(new Date(computeNextRun(intervalConfig(30), after) ?? 0).toISOString(), '2026-06-17T10:30:00.000Z')
  assert.equal(new Date(computeNextRun(dailyConfig('12:15', 'UTC'), after) ?? 0).toISOString(), '2026-06-17T12:15:00.000Z')
  assert.equal(new Date(computeNextRun(dailyConfig('09:15', 'UTC'), after) ?? 0).toISOString(), '2026-06-18T09:15:00.000Z')
  assert.equal(new Date(computeNextRun(weeklyConfig('08:00', [3]), Date.parse('2026-06-15T12:00:00.000Z')) ?? 0).toISOString(), '2026-06-17T08:00:00.000Z')
}

function assertDstRules(): void {
  const nonexistentLocalTime = computeNextRun(
    dailyConfig('01:30', 'Europe/Dublin'),
    Date.parse('2026-03-28T12:00:00.000Z')
  )
  assert.equal(new Date(nonexistentLocalTime ?? 0).toISOString(), '2026-03-29T01:00:00.000Z')

  const ambiguousLocalTime = computeNextRun(
    dailyConfig('01:30', 'Europe/Dublin'),
    Date.parse('2026-10-24T12:00:00.000Z')
  )
  assert.equal(new Date(ambiguousLocalTime ?? 0).toISOString(), '2026-10-25T00:30:00.000Z')
}

function assertInvalidIntervalIsRejected(): void {
  const validation = validateScheduleTriggerConfig(intervalConfig(4))
  assert.equal(validation.ok, false)
  assert.match(validation.ok ? '' : validation.error, /at least 5/)
  assert.equal(computeNextRun(intervalConfig(4), Date.parse('2026-06-17T10:00:00.000Z')), null)
}

function assertWorkspaceSnapshotFolderExtraction(): void {
  const snapshot = {
    sequence: 1,
    state: {
      activeWorkspaceId: 'ws-a',
      primaryWorkspaceWindowId: 'primary',
      workspaceWindows: [],
      workspaces: [
        { id: 'ws-a', folderPath: '/repo/a' },
        { id: 'ws-b', folderPath: '/repo/a/' },
        { id: 'ws-c', folderPath: null },
        { id: 'ws-d', folderPath: '/repo/d' },
      ],
    },
  } as WorkspaceSyncSnapshot

  assert.deepEqual(projectFoldersFromWorkspaceSyncSnapshot(snapshot), [
    { workspaceId: 'ws-a', folderPath: '/repo/a' },
    { workspaceId: 'ws-d', folderPath: '/repo/d' },
  ])
}

async function assertDueAutomationSkipsOverlappingTickAndPreservesSingleFlight(): Promise<void> {
  const workspaceRoot = await createWorkspace()
  const store = new AutomationsStore(workspaceRoot)
  const now = Date.parse('2026-06-17T10:00:00.000Z')
  assert.equal((await store.createDefinition(definition({
    trigger: { kind: 'schedule', config: intervalConfig(5) },
    nextRunAt: new Date(now).toISOString(),
  }))).ok, true)

  let releaseRun: () => void = () => undefined
  let startedRun: () => void = () => undefined
  const runnerStarted = new Promise<void>((resolve) => {
    startedRun = resolve
  })
  const releaseRunner = new Promise<void>((resolve) => {
    releaseRun = resolve
  })
  let runCount = 0
  const engine = new AutomationsEngine({
    getProjectFolders: () => [{ workspaceId: 'ws-a', folderPath: workspaceRoot }],
    now: () => now,
    createRunId: () => 'run-due',
    runAutomation: async () => {
      runCount += 1
      startedRun()
      await releaseRunner
      return { status: 'completed', summary: 'completed by test runner' }
    },
  })

  const firstTick = engine.tick()
  await runnerStarted
  const duplicateTick = await engine.tick()
  assert.equal(duplicateTick.fired.length, 0)
  assert.deepEqual(duplicateTick.scheduled, [])
  assert.deepEqual(duplicateTick.skipped, [])
  assert.deepEqual(duplicateTick.droppedInFlight, [])
  assert.deepEqual(duplicateTick.problems, [])

  const runNowWhileTimerIsRunning = await engine.runNow({
    workspaceRoot,
    automationId: 'nightly-review',
  })
  assert.equal(runNowWhileTimerIsRunning.ok, false)
  assert.equal(runNowWhileTimerIsRunning.ok ? '' : runNowWhileTimerIsRunning.problem.code, 'in_flight')

  releaseRun()

  const firstResult = await firstTick
  assert.equal(runCount, 1)
  assert.equal(firstResult.fired.length, 1)
  assert.equal(firstResult.fired[0]?.runId, 'run-due')
  assert.deepEqual(firstResult.problems, [])

  const runs = await store.listRuns('nightly-review')
  assert.equal(runs.ok, true)
  assert.equal(runs.ok && runs.values.length, 1)
  assert.equal(runs.ok && runs.values[0]?.status, 'completed')

  const updatedDefinition = await store.getDefinition('nightly-review')
  assert.equal(updatedDefinition.ok, true)
  assert.equal(updatedDefinition.ok && updatedDefinition.value.lastRunId, 'run-due')
  assert.equal(updatedDefinition.ok && updatedDefinition.value.nextRunAt, '2026-06-17T10:05:00.000Z')
}

async function assertRunEventsEmitForTimerAndManualTerminalStatuses(): Promise<void> {
  const now = Date.parse('2026-06-17T10:00:00.000Z')
  const timerRoot = await createWorkspace()
  const timerStore = new AutomationsStore(timerRoot)
  assert.equal((await timerStore.createDefinition(definition({
    trigger: { kind: 'schedule', config: intervalConfig(5) },
    nextRunAt: new Date(now).toISOString(),
  }))).ok, true)

  const events: AutomationsRunEvent[] = []
  const timerEngine = new AutomationsEngine({
    getProjectFolders: () => [{ workspaceId: 'ws-automations-timer', folderPath: timerRoot }],
    now: () => now,
    createRunId: () => 'run-timer',
    onRunEvent: (event) => events.push(event),
    runAutomation: async () => ({
      status: 'blocked',
      blockedReason: 'Required integration is missing.',
      summary: 'Blocked by test.',
    }),
  })

  await timerEngine.tick()
  assert.deepEqual(events, [
    {
      automationId: 'nightly-review',
      runId: 'run-timer',
      workspaceId: 'ws-automations-timer',
      definitionName: 'Nightly review',
      status: 'blocked',
      trigger: 'timer',
    },
  ])

  const manualRoot = await createWorkspace()
  const manualStore = new AutomationsStore(manualRoot)
  assert.equal((await manualStore.createDefinition(definition({
    trigger: { kind: 'schedule', config: intervalConfig(10) },
    nextRunAt: new Date(now).toISOString(),
  }))).ok, true)

  const manualEngine = new AutomationsEngine({
    getProjectFolders: () => [{ workspaceId: 'ws-from-snapshot', folderPath: manualRoot }],
    now: () => now,
    createRunId: () => 'run-manual',
    onRunEvent: (event) => events.push(event),
    runAutomation: async () => ({
      status: 'completed',
      workspaceId: 'ws-action-target',
      agentId: 'agent-manual',
      summary: 'Manual run completed.',
    }),
  })

  const runNow = await manualEngine.runNow({
    workspaceRoot: manualRoot,
    automationId: 'nightly-review',
  })
  assert.equal(runNow.ok, true)
  assert.deepEqual(events[1], {
    automationId: 'nightly-review',
    runId: 'run-manual',
    workspaceId: 'ws-from-snapshot',
    agentId: 'agent-manual',
    definitionName: 'Nightly review',
    status: 'completed',
    trigger: 'manual',
  })
}

async function assertRunEventDeliveryFailuresDoNotMutateRunTruth(): Promise<void> {
  const now = Date.parse('2026-06-17T10:00:00.000Z')
  const manualRoot = await createWorkspace()
  const manualStore = new AutomationsStore(manualRoot)
  assert.equal((await manualStore.createDefinition(definition({
    trigger: { kind: 'schedule', config: intervalConfig(10) },
    nextRunAt: new Date(now).toISOString(),
  }))).ok, true)

  let manualDeliveryAttempts = 0
  const manualEngine = new AutomationsEngine({
    getProjectFolders: () => [{ workspaceId: 'ws-manual-throw', folderPath: manualRoot }],
    now: () => now,
    createRunId: () => 'run-manual-throw',
    onRunEvent: () => {
      manualDeliveryAttempts += 1
      throw new Error('renderer delivery failed')
    },
    runAutomation: async () => ({
      status: 'completed',
      summary: 'Manual run completed despite renderer delivery failure.',
    }),
  })

  const runNow = await manualEngine.runNow({
    workspaceRoot: manualRoot,
    workspaceId: 'ws-manual-throw',
    automationId: 'nightly-review',
  })
  assert.equal(manualDeliveryAttempts, 1)
  assert.equal(runNow.ok, true)
  assert.equal(runNow.ok && runNow.run.status, 'completed')
  assert.equal(runNow.ok && runNow.definition.lastRunId, 'run-manual-throw')
  assert.equal(runNow.ok && runNow.definition.nextRunAt, '2026-06-17T10:10:00.000Z')

  const manualRuns = await manualStore.listRuns('nightly-review')
  assert.equal(manualRuns.ok, true)
  assert.equal(manualRuns.ok && manualRuns.values.length, 1)
  assert.equal(manualRuns.ok && manualRuns.values[0]?.status, 'completed')

  const timerRoot = await createWorkspace()
  const timerStore = new AutomationsStore(timerRoot)
  assert.equal((await timerStore.createDefinition(definition({
    trigger: { kind: 'schedule', config: intervalConfig(5) },
    nextRunAt: new Date(now).toISOString(),
  }))).ok, true)

  let timerDeliveryAttempts = 0
  const timerEngine = new AutomationsEngine({
    getProjectFolders: () => [{ workspaceId: 'ws-timer-throw', folderPath: timerRoot }],
    now: () => now,
    createRunId: () => 'run-timer-throw',
    onRunEvent: () => {
      timerDeliveryAttempts += 1
      throw new Error('renderer delivery failed')
    },
    runAutomation: async () => ({
      status: 'completed',
      summary: 'Timer run completed despite renderer delivery failure.',
    }),
  })

  const tick = await timerEngine.tick()
  assert.equal(timerDeliveryAttempts, 1)
  assert.deepEqual(tick.problems, [])
  assert.deepEqual(tick.fired, [{
    workspaceRoot: timerRoot,
    automationId: 'nightly-review',
    runId: 'run-timer-throw',
    status: 'completed',
  }])

  const timerRuns = await timerStore.listRuns('nightly-review')
  assert.equal(timerRuns.ok, true)
  assert.equal(timerRuns.ok && timerRuns.values.length, 1)
  assert.equal(timerRuns.ok && timerRuns.values[0]?.status, 'completed')

  const updatedTimerDefinition = await timerStore.getDefinition('nightly-review')
  assert.equal(updatedTimerDefinition.ok, true)
  assert.equal(updatedTimerDefinition.ok && updatedTimerDefinition.value.lastRunId, 'run-timer-throw')
  assert.equal(updatedTimerDefinition.ok && updatedTimerDefinition.value.nextRunAt, '2026-06-17T10:05:00.000Z')
}

async function assertPollingTriggersUseProviderGetterAtEvaluationTime(): Promise<void> {
  const workspaceRoot = await createWorkspace()
  const store = new AutomationsStore(workspaceRoot)
  assert.equal((await store.createDefinition(definition({
    trigger: { kind: 'weather-deck.forecast-ready', config: { city: 'Dublin' } },
    action: { kind: 'spawn-agent', config: {} },
    nextRunAt: null,
  }))).ok, true)

  const now = Date.parse('2026-06-17T10:00:00.000Z')
  let pollCount = 0
  let triggerProviders: AutomationTriggerProvider[] = []
  const engine = new AutomationsEngine({
    getProjectFolders: () => [{ workspaceId: 'ws-live-provider', folderPath: workspaceRoot }],
    getTriggerProviders: () => triggerProviders,
    now: () => now,
    createRunId: () => 'run-live-provider',
    runAutomation: async () => ({ status: 'completed', summary: 'Live provider ran.' }),
  })
  triggerProviders = [
    {
      kind: 'weather-deck.forecast-ready',
      configSchema: { type: 'object' },
      subscribe: () => () => undefined,
      poll: async () => {
        pollCount += 1
        return {
          ok: true,
          events: [
            {
              id: 'forecast-1',
              occurredAt: new Date(now).toISOString(),
              payload: { city: 'Dublin' },
            },
          ],
        }
      },
    },
  ]

  const tick = await engine.tick()
  assert.equal(pollCount, 1)
  assert.deepEqual(tick.problems, [])
  assert.deepEqual(tick.fired, [{
    workspaceRoot,
    automationId: 'nightly-review',
    runId: 'run-live-provider',
    status: 'completed',
  }])
}

async function assertWebhookReceiverOptInAuthAndDedupesDeliveredEvents(): Promise<void> {
  const workspaceRoot = await createWorkspace()
  const store = new AutomationsStore(workspaceRoot)
  const now = Date.parse('2026-06-17T10:00:00.000Z')
  const secret = 'test-webhook-secret-0001'
  const webhookAutomation = definition({
    id: 'webhook-review',
    name: 'Webhook review',
    trigger: {
      kind: WEBHOOK_TRIGGER_KIND,
      config: { kind: WEBHOOK_TRIGGER_KIND, enabled: false },
    },
    nextRunAt: null,
  })
  assert.equal((await store.createDefinition(webhookAutomation)).ok, true)

  const triggerPayloads: Record<string, unknown>[] = []
  let runIndex = 0
  const engine = new AutomationsEngine({
    getProjectFolders: () => [{ workspaceId: 'ws-webhooks', folderPath: workspaceRoot }],
    triggerProviders: [createWebhookTriggerProvider()],
    now: () => now,
    createRunId: ({ automationId }) => `${automationId}-run-${runIndex += 1}`,
    runAutomation: async (input) => {
      triggerPayloads.push(input.triggerPayload)
      return { status: 'completed', summary: 'Webhook handled.' }
    },
  })
  const receiver = new AutomationWebhookReceiver({
    getProjectFolders: () => [{ workspaceId: 'ws-webhooks', folderPath: workspaceRoot }],
    deliverTriggerEvent: (input) => engine.deliverTriggerEvent(input),
    now: () => now,
  })

  try {
    const disabledStatus = await receiver.refresh()
    assert.equal(disabledStatus.state, 'stopped')
    assert.equal(disabledStatus.targetCount, 0)

    assert.equal((await store.updateDefinition({
      ...webhookAutomation,
      trigger: {
        kind: WEBHOOK_TRIGGER_KIND,
        config: {
          kind: WEBHOOK_TRIGGER_KIND,
          enabled: true,
          port: 0,
          path: 'incoming-review',
          secret,
          eventType: 'push',
        },
      },
      updatedAt: '2026-06-17T10:00:00.000Z',
    })).ok, true)

    const enabledStatus = await receiver.refresh()
    assert.equal(enabledStatus.state, 'running')
    assert.equal(enabledStatus.targetCount, 1)

    const rawBody = JSON.stringify({ eventType: 'push', repository: 'acme/repo' })
    const baseHeaders = {
      'content-type': 'application/json',
      [WEBHOOK_DELIVERY_ID_HEADER]: 'delivery-1',
      [WEBHOOK_EVENT_TIME_HEADER]: '2026-06-17T09:59:00.000Z',
    }
    const malformed = await receiver.deliver({
      port: 0,
      path: webhookEndpointPath('incoming-review'),
      headers: {
        ...baseHeaders,
        [WEBHOOK_SIGNATURE_HEADER]: createWebhookSignature(secret, '{bad json'),
      },
      rawBody: '{bad json',
    })
    assert.equal(malformed.ok, false)
    assert.equal(malformed.ok ? '' : malformed.code, 'malformed_json')
    assert.equal(triggerPayloads.length, 0)

    const unauthorized = await receiver.deliver({
      port: 0,
      path: webhookEndpointPath('incoming-review'),
      headers: {
        ...baseHeaders,
        [WEBHOOK_SIGNATURE_HEADER]: createWebhookSignature('wrong-secret-0001', rawBody),
      },
      rawBody,
    })
    assert.equal(unauthorized.ok, false)
    assert.equal(unauthorized.ok ? '' : unauthorized.code, 'webhook_unauthorized')
    assert.equal(triggerPayloads.length, 0)

    const validHeaders = {
      ...baseHeaders,
      [WEBHOOK_SIGNATURE_HEADER]: createWebhookSignature(secret, rawBody),
    }
    const delivered = await receiver.deliver({
      port: 0,
      path: webhookEndpointPath('incoming-review'),
      headers: validHeaders,
      rawBody,
    })
    assert.equal(delivered.ok, true)
    assert.equal(delivered.ok && delivered.status, 'delivered')
    assert.equal(delivered.ok && delivered.fired, 1)
    assert.deepEqual(delivered.ok && delivered.runIds, ['webhook-review-run-1'])
    assert.equal(triggerPayloads.length, 1)
    assert.equal(triggerPayloads[0]?.kind, WEBHOOK_TRIGGER_KIND)
    assert.equal(triggerPayloads[0]?.deliveryId, 'delivery-1')
    assert.equal(triggerPayloads[0]?.eventType, 'push')
    assert.equal((triggerPayloads[0]?.body as Record<string, unknown> | undefined)?.repository, 'acme/repo')

    const duplicate = await receiver.deliver({
      port: 0,
      path: webhookEndpointPath('incoming-review'),
      headers: validHeaders,
      rawBody,
    })
    assert.equal(duplicate.ok, true)
    assert.equal(duplicate.ok && duplicate.status, 'duplicate')
    assert.equal(duplicate.ok && duplicate.duplicates, 1)
    assert.equal(triggerPayloads.length, 1)

    const ignoredBody = JSON.stringify({ eventType: 'pull_request', repository: 'acme/repo' })
    const ignored = await receiver.deliver({
      port: 0,
      path: webhookEndpointPath('incoming-review'),
      headers: {
        ...baseHeaders,
        [WEBHOOK_DELIVERY_ID_HEADER]: 'delivery-2',
        [WEBHOOK_SIGNATURE_HEADER]: createWebhookSignature(secret, ignoredBody),
      },
      rawBody: ignoredBody,
    })
    assert.equal(ignored.ok, true)
    assert.equal(ignored.ok && ignored.status, 'ignored')
    assert.equal(triggerPayloads.length, 1)

    const runs = await store.listRuns('webhook-review')
    assert.equal(runs.ok, true)
    assert.equal(runs.ok && runs.values.length, 1)
    assert.equal(runs.ok && runs.values[0]?.status, 'completed')

    const state = await store.readState()
    assert.equal(state.ok, true)
    assert.equal(
      state.ok && state.value?.triggerEventDedupByAutomationId?.['webhook-review']?.['webhook:incoming-review:delivery-1'],
      '2026-06-17T10:00:00.000Z'
    )
  } finally {
    await receiver.stop()
  }
}

async function assertStartupOverdueIsSkippedWithoutCatchup(): Promise<void> {
  const workspaceRoot = await createWorkspace()
  const store = new AutomationsStore(workspaceRoot)
  const now = Date.parse('2026-06-17T10:00:00.000Z')
  assert.equal((await store.createDefinition(definition({
    trigger: { kind: 'schedule', config: intervalConfig(15) },
    nextRunAt: '2026-06-17T09:00:00.000Z',
  }))).ok, true)

  let runCount = 0
  const engine = new AutomationsEngine({
    getProjectFolders: () => [{ workspaceId: 'ws-a', folderPath: workspaceRoot }],
    now: () => now,
    createRunId: () => 'run-overdue',
    runAutomation: async () => {
      runCount += 1
      return { status: 'completed' }
    },
  })

  const startup = await engine.handleStartup()
  assert.equal(runCount, 0)
  assert.equal(startup.skipped.length, 1)
  assert.equal(startup.skipped[0]?.status, 'skipped')
  assert.deepEqual(startup.problems, [])

  const runs = await store.listRuns('nightly-review')
  assert.equal(runs.ok, true)
  assert.equal(runs.ok && runs.values.length, 1)
  assert.equal(runs.ok && runs.values[0]?.status, 'skipped')
  assert.equal(runs.ok && runs.values[0]?.blockedReason, 'overdue_not_replayed')

  const updatedDefinition = await store.getDefinition('nightly-review')
  assert.equal(updatedDefinition.ok, true)
  assert.equal(updatedDefinition.ok && updatedDefinition.value.nextRunAt, '2026-06-17T10:15:00.000Z')
  assert.equal(updatedDefinition.ok && updatedDefinition.value.lastRunId, 'run-overdue')

  const secondStartup = await engine.handleStartup()
  assert.equal(secondStartup.skipped.length, 0)
  assert.equal(secondStartup.fired.length, 0)
  const afterSecondStartup = await store.listRuns('nightly-review')
  assert.equal(afterSecondStartup.ok, true)
  assert.equal(afterSecondStartup.ok && afterSecondStartup.values.length, 1)
}

async function assertTickWaitsForStartupOverdueSkip(): Promise<void> {
  const now = Date.parse('2026-06-17T10:00:00.000Z')
  const store = new InMemoryAutomationsStore(definition({
    trigger: { kind: 'schedule', config: intervalConfig(15) },
    nextRunAt: '2026-06-17T09:00:00.000Z',
  }))

  let releaseSkippedRun: () => void = () => undefined
  const skippedRunRelease = new Promise<void>((resolve) => {
    releaseSkippedRun = resolve
  })
  let markSkippedRunStarted: () => void = () => undefined
  const skippedRunStarted = new Promise<void>((resolve) => {
    markSkippedRunStarted = resolve
  })
  store.delaySkippedRunRecord({
    started: markSkippedRunStarted,
    release: skippedRunRelease,
  })

  let markRunnerStarted: () => void = () => undefined
  const runnerStarted = new Promise<'fired'>((resolve) => {
    markRunnerStarted = () => resolve('fired')
  })
  let runCount = 0
  const engine = new AutomationsEngine({
    getProjectFolders: () => [{ workspaceId: 'ws-a', folderPath: '/repo/race' }],
    createStore: () => store,
    now: () => now,
    createRunId: () => 'run-overdue-race',
    pollIntervalMs: 1_000_000,
    runAutomation: async () => {
      runCount += 1
      markRunnerStarted()
      return { status: 'completed' }
    },
  })

  engine.start()
  assert.equal(engine.isRunning(), true)
  await skippedRunStarted

  const tickDuringStartup = engine.tick()
  const tickRace = await Promise.race([
    runnerStarted,
    flushMicrotasks(50).then(() => 'blocked' as const),
  ])
  assert.equal(tickRace, 'blocked')
  assert.equal(runCount, 0)

  releaseSkippedRun()
  const tickResult = await tickDuringStartup
  engine.stop()

  assert.equal(tickResult.fired.length, 0)
  assert.equal(tickResult.skipped.length, 0)
  assert.equal(tickResult.scheduled.length, 1)
  assert.equal(runCount, 0)
  assert.equal(store.runs.length, 1)
  assert.equal(store.runs[0]?.status, 'skipped')
  assert.equal(store.runs[0]?.blockedReason, 'overdue_not_replayed')
}

async function flushMicrotasks(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve()
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
