import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
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
import { createDefinitionWriteCore } from './definition-write'
import {
  AutomationsEngine,
  projectFoldersFromWorkspaceSyncSnapshot,
  type AutomationConversationTurnEvent,
} from './engine'
import { allowAutomationProvider, createBuiltInAutomationProviderRegistry } from './provider-registry'
import { openAutomationRunPullRequest, type CommandResult, type PullRequestDeps } from './pull-request'
import { AutomationsStore, type AutomationStoreState } from './store'
import { computeNextRun, validateScheduleTriggerConfig } from './schedule'
import { executableTriggerProviders } from './provider-registry'
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
import { everyAutomationApproved } from '../../../tests/automation-approvals'
import { test } from 'vitest'

test('engine', async () => {
  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  async function main(): Promise<void> {
    assertIntervalDailyWeeklyNextRuns()
    assertDstRules()
    assertAtCadenceNextRuns()
    assertAtCadenceDstGapRule()
    assertAtCadenceValidationMatrix()
    await assertAtCadenceFiresExactlyOnceThroughTheEngine()
    await assertPastAtCadenceNeverFiresAndStaysQuiet()
    await assertCatalogueInstallIsScheduledByTheLiveEngine()
    await assertDisableAfterRunPausesScheduleAfterOneFire()
    await assertManualRunNowDoesNotConsumeOnceOffShot()
    await assertDisableAfterRunPausesTriggerEventAutomationAndBlocksSecondEvent()
    assertInvalidIntervalIsRejected()
    assertWorkspaceSnapshotFolderExtraction()
    await assertDueAutomationSkipsOverlappingTickAndPreservesSingleFlight()
    await assertRunEventsEmitForTimerAndManualTerminalStatuses()
    await assertAgentBackedRunStaysRunningUntilFinalize()
    await assertRunEventDeliveryFailuresDoNotMutateRunTruth()
    await assertPollingTriggersUseProviderGetterAtEvaluationTime()
    await assertDeniedTriggerProviderIsInertBeforePolling()
    await assertWebhookReceiverOptInAuthAndDedupesDeliveredEvents()
    await assertWebhookDeliveryFailureRedactsProblemFromCaller()
    await assertWebhookReceiverRefreshSerializesAndFailsClosed()
    await assertStartupOverdueIsSkippedWithoutCatchup()
    await assertTickWaitsForStartupOverdueSkip()
    await assertTurnEndFinalizesRunWithReplySummary()
    await assertTurnEndWithoutReplyUsesGenericSummary()
    await assertBackgroundAgentsDeferFinalize()
    await assertTurnEndBeforeAnyTurnStartIsIgnored()
    await assertNewTurnCancelsArmedSettleTimer()
    await assertTurnFailureFinalizesRunAsFailed()
    await assertRunWithoutWorktreeIsTrackedAndFinalizes()
    await assertTurnsOfOtherChatsAreInert()
    await assertTurnsOfAnotherSessionOfTheRunChatAreInert()
    await assertTurnsBeforeTheRunIsRecordedAreReplayed()
    await assertFirstSendFailureBeforeTheRunIsRecordedFailsIt()
    await assertMaxDurationSweepFailsOverlongRun()
    await assertStartupRebuildsRegistryFromStore()
    await assertManualFinalizeRemovesRunFromRegistry()
    await assertConcurrentManualAndAutoFinalizeOnce()
    await assertFinalizeDisposesSpawnedAgentAndToleratesDisposeFailure()
    await assertSessionCloseBeforeAnyTurnEndFinalizesFailed()
    await assertSessionCloseDuringSettleWindowUsesArmedOutcome()
    await assertSessionCloseDuringSummaryReadUsesArmedOutcome()
    await assertNewTurnDuringSummaryReadAbortsFinalize()
    await assertCloseAfterAbortedArmedFinalizeStillFails()
    await assertStopDuringSummaryReadAbortsFinalize()
    await assertSessionCloseCorrelatesOnWorkspaceAndAgentId()
    await assertSessionCloseForUnknownChatIsNoOp()
    await assertStartupReconcileForceFailsOrphanedAgentRun()
    await assertStartupReconcileLeavesStillLiveRunPending()
    await assertStartupReconcileNeverForceFailsSessionlessRun()
    await assertStopClearsArmedSettleTimers()
    await assertFinalizePublishesWorkingDiff()
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

  function atConfig(datetime: string, timezone = 'UTC'): ScheduleTriggerConfig {
    return {
      kind: 'schedule',
      timezone,
      cadence: { type: 'at', datetime },
    }
  }

  async function createWorkspace(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'sprintengine-automations-engine-'))
  }

  async function listenOnEphemeralPort(): Promise<{ server: Server; port: number }> {
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address !== 'object') throw new Error('Unable to read test server port.')
    return { server, port: address.port }
  }

  async function closeHttpServer(server: Server): Promise<void> {
    if (!server.listening) return
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  class InMemoryAutomationsStore extends AutomationsStore {
    state: AutomationStoreState = { nextRunAtByAutomationId: {}, lock: null }
    runs: AutomationRun[] = []

    constructor(definitionValue: AutomationDefinition) {
      super(join(tmpdir(), 'sprintengine-automations-engine-memory'))
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
    assert.equal(
      new Date(computeNextRun(dailyConfig('12:15', 'UTC'), after) ?? 0).toISOString(),
      '2026-06-17T12:15:00.000Z',
    )
    assert.equal(
      new Date(computeNextRun(dailyConfig('09:15', 'UTC'), after) ?? 0).toISOString(),
      '2026-06-18T09:15:00.000Z',
    )
    assert.equal(
      new Date(computeNextRun(weeklyConfig('08:00', [3]), Date.parse('2026-06-15T12:00:00.000Z')) ?? 0).toISOString(),
      '2026-06-17T08:00:00.000Z',
    )
  }

  function assertDstRules(): void {
    const nonexistentLocalTime = computeNextRun(
      dailyConfig('01:30', 'Europe/Dublin'),
      Date.parse('2026-03-28T12:00:00.000Z'),
    )
    assert.equal(new Date(nonexistentLocalTime ?? 0).toISOString(), '2026-03-29T01:00:00.000Z')

    const ambiguousLocalTime = computeNextRun(
      dailyConfig('01:30', 'Europe/Dublin'),
      Date.parse('2026-10-24T12:00:00.000Z'),
    )
    assert.equal(new Date(ambiguousLocalTime ?? 0).toISOString(), '2026-10-25T00:30:00.000Z')
  }

  function assertAtCadenceNextRuns(): void {
    const after = Date.parse('2026-06-17T10:00:00.000Z')

    // Strictly in the future → the configured instant, resolved in the config's
    // timezone (UTC here; a zoned case follows).
    assert.equal(
      new Date(computeNextRun(atConfig('2026-06-17T10:30'), after) ?? 0).toISOString(),
      '2026-06-17T10:30:00.000Z',
    )
    // Seconds are accepted and truncated to the minute (engine granularity).
    assert.equal(
      new Date(computeNextRun(atConfig('2026-06-17T10:30:45'), after) ?? 0).toISOString(),
      '2026-06-17T10:30:00.000Z',
    )
    // Exactly `after` and anything earlier never fire again — a past datetime is
    // valid config that simply has no upcoming run.
    assert.equal(computeNextRun(atConfig('2026-06-17T10:00'), after), null)
    assert.equal(computeNextRun(atConfig('2026-06-16T09:00'), after), null)
    assert.equal(validateScheduleTriggerConfig(atConfig('2026-06-16T09:00')).ok, true, 'a past datetime validates')

    // Wall-clock resolves in the configured timezone: 09:30 Dublin summer time
    // is 08:30 UTC.
    assert.equal(
      new Date(computeNextRun(atConfig('2026-07-09T09:30', 'Europe/Dublin'), after) ?? 0).toISOString(),
      '2026-07-09T08:30:00.000Z',
    )
  }

  function assertAtCadenceDstGapRule(): void {
    // Dublin springs forward 2026-03-29 01:00 → 02:00: 01:30 does not exist that
    // day. Pin the same resolution the daily helper uses — the first instant
    // after the gap (02:00 IST == 01:00Z).
    const resolved = computeNextRun(
      atConfig('2026-03-29T01:30', 'Europe/Dublin'),
      Date.parse('2026-03-28T12:00:00.000Z'),
    )
    assert.equal(new Date(resolved ?? 0).toISOString(), '2026-03-29T01:00:00.000Z')
  }

  function assertAtCadenceValidationMatrix(): void {
    const valid = ['2026-07-09T09:30', '2026-07-09T09:30:15', '2026-12-31T23:59']
    for (const datetime of valid) {
      const validation = validateScheduleTriggerConfig(atConfig(datetime))
      assert.equal(validation.ok, true, `"${datetime}" must validate`)
    }

    const malformed = [
      '',
      '2026-07-09',
      '09:30',
      '2026-07-09 09:30',
      '2026-07-09T24:00',
      '2026-07-09T09:30Z',
      '2026-07-09T09:30+01:00',
      '2026-07-09T09:30:15.000Z',
    ]
    for (const datetime of malformed) {
      const validation = validateScheduleTriggerConfig(atConfig(datetime))
      assert.equal(validation.ok, false, `"${datetime}" must be rejected`)
      assert.match(validation.ok ? '' : validation.error, /YYYY-MM-DDTHH:mm/, 'the message says what shape is expected')
      assert.equal(computeNextRun(atConfig(datetime), 0), null)
    }

    const impossibleDate = validateScheduleTriggerConfig(atConfig('2026-02-30T10:00'))
    assert.equal(impossibleDate.ok, false)
    assert.match(impossibleDate.ok ? '' : impossibleDate.error, /not a real calendar date/)
  }

  // Exactly-once through the real engine: fire → nextRunAt cleared to null (no
  // problem reported) → later ticks stay quiet. Regression for the null-next-run
  // path updateDefinitionAfterRun/persistNextRun special-case for one-shots.
  async function assertAtCadenceFiresExactlyOnceThroughTheEngine(): Promise<void> {
    const fireAt = Date.parse('2026-06-17T10:30:00.000Z')
    let now = fireAt + 30_000
    const root = await createWorkspace()
    const store = new AutomationsStore(root)
    assert.equal(
      (
        await store.createDefinition(
          definition({
            trigger: { kind: 'schedule', config: atConfig('2026-06-17T10:30') },
            nextRunAt: new Date(fireAt).toISOString(),
          }),
        )
      ).ok,
      true,
    )

    let runs = 0
    const engine = new AutomationsEngine({
      approvals: everyAutomationApproved,
      getProjectFolders: () => [{ workspaceId: 'ws-at-once', folderPath: root }],
      now: () => now,
      createRunId: () => `run-at-${runs}`,
      runAutomation: async () => {
        runs += 1
        return { status: 'completed', summary: 'One-shot completed.' }
      },
    })

    const first = await engine.tick()
    assert.equal(runs, 1, 'the one-shot fires at its time')
    assert.deepEqual(first.problems, [], 'firing a one-shot reports no problems')
    const fired = await store.getDefinition('nightly-review')
    assert.equal(fired.ok, true)
    if (fired.ok) {
      assert.equal(fired.value.nextRunAt, null, 'the fired one-shot has no upcoming run')
      assert.equal(fired.value.lastRunId, 'run-at-0', 'the fired run is recorded on the definition')
    }

    now += 5 * 60_000
    const second = await engine.tick()
    assert.equal(runs, 1, 'a fired one-shot never fires again')
    assert.deepEqual(second.problems, [], 'ticks after the fire stay quiet')
  }

  // The load-bearing claim of the marketplace install path: an automation added
  // while the app is running is scheduled by the live engine, with no restart.
  // It holds because every evaluation re-reads the store — there is no cached
  // definition set for a mid-session write to miss.
  async function assertCatalogueInstallIsScheduledByTheLiveEngine(): Promise<void> {
    let now = Date.parse('2026-06-17T01:00:00.000Z')
    const root = await createWorkspace()
    let runs = 0
    const engine = new AutomationsEngine({
      approvals: everyAutomationApproved,
      getProjectFolders: () => [{ workspaceId: 'ws-installed', folderPath: root }],
      now: () => now,
      createRunId: () => 'run-installed',
      runAutomation: async () => {
        runs += 1
        return { status: 'completed', summary: 'Installed automation ran.' }
      },
    })

    const beforeInstall = await engine.tick()
    assert.deepEqual(beforeInstall.problems, [], 'an empty project ticks quietly')
    assert.equal(runs, 0)

    const registry = createBuiltInAutomationProviderRegistry()
    const writeCore = createDefinitionWriteCore({
      createStore: (workspaceRoot) => new AutomationsStore(workspaceRoot),
      getTriggerProviderRegistrations: () => registry.listTriggerProviderRegistrations(),
      getActionProviderRegistrations: () => registry.listActionProviderRegistrations(),
      checkProviderPermission: allowAutomationProvider,
      now: () => now,
      // What this test is about is the live engine picking up a mid-session
      // install, not where the installing user is: the install resolves a
      // catalogue schedule into the host's zone (item 2039), so the host is
      // pinned here and the instant below stays exact wherever this runs.
      hostTimeZone: () => 'UTC',
    })
    const installed = await writeCore.installFromCatalogue(root, {
      payload: {
        name: 'Nightly dependency sweep',
        trigger: { kind: 'schedule', config: dailyConfig('02:00', 'UTC') },
        action: { kind: 'spawn-agent', config: { prompt: 'Check for outdated dependencies.' } },
      },
      sourceCatalogueId: 'sprintengine.nightly-sweep',
    })
    assert.equal(installed.ok, true, installed.ok ? '' : installed.message)
    if (!installed.ok) return
    assert.equal(installed.value.definition.nextRunAt, '2026-06-17T02:00:00.000Z', 'the install computed the next run')

    now = Date.parse('2026-06-17T02:00:30.000Z')
    const afterInstall = await engine.tick()
    assert.deepEqual(afterInstall.problems, [])
    assert.equal(runs, 1, 'the automation added mid-session fires on the next tick, with no app restart')
  }

  // A past-dated enabled one-shot is valid config that simply never fires — the
  // engine must not spawn it, and must not spam next_run_unavailable problems.
  async function assertPastAtCadenceNeverFiresAndStaysQuiet(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    const root = await createWorkspace()
    const store = new AutomationsStore(root)
    assert.equal(
      (
        await store.createDefinition(
          definition({
            trigger: { kind: 'schedule', config: atConfig('2026-06-16T09:00') },
            nextRunAt: null,
          }),
        )
      ).ok,
      true,
    )

    let runs = 0
    const engine = new AutomationsEngine({
      approvals: everyAutomationApproved,
      getProjectFolders: () => [{ workspaceId: 'ws-at-past', folderPath: root }],
      now: () => now,
      runAutomation: async () => {
        runs += 1
        return { status: 'completed' }
      },
    })
    const result = await engine.tick()
    assert.equal(runs, 0, 'a past-dated one-shot never fires')
    assert.deepEqual(result.problems, [], 'and its evaluation reports no problems')
  }

  // A `disableAfterRun` schedule automation fires once, then pauses
  // itself — the recurring cadence never produces a second run.
  async function assertDisableAfterRunPausesScheduleAfterOneFire(): Promise<void> {
    const firstDue = Date.parse('2026-06-17T10:00:00.000Z')
    let now = firstDue
    const root = await createWorkspace()
    const store = new AutomationsStore(root)
    assert.equal(
      (
        await store.createDefinition(
          definition({
            disableAfterRun: true,
            trigger: { kind: 'schedule', config: intervalConfig(5) },
            nextRunAt: new Date(firstDue).toISOString(),
          }),
        )
      ).ok,
      true,
    )

    let runs = 0
    const engine = new AutomationsEngine({
      approvals: everyAutomationApproved,
      getProjectFolders: () => [{ workspaceId: 'ws-once-schedule', folderPath: root }],
      now: () => now,
      createRunId: () => `run-once-${runs}`,
      runAutomation: async () => {
        runs += 1
        return { status: 'completed', summary: 'Once-off completed.' }
      },
    })

    const first = await engine.tick()
    assert.equal(runs, 1, 'the once-off fires its one run')
    assert.deepEqual(first.problems, [], 'the consuming fire reports no problems')
    assert.deepEqual(first.scheduled, [], 'a paused once-off is not rescheduled')
    const paused = await store.getDefinition('nightly-review')
    assert.equal(paused.ok, true)
    if (paused.ok) {
      assert.equal(paused.value.status, 'paused', 'one triggered fire pauses the definition')
      assert.equal(paused.value.nextRunAt, null, 'a paused once-off has no upcoming run')
      assert.equal(paused.value.lastRunId, 'run-once-0', 'the consuming run is recorded on the definition')
    }

    now += 10 * 60_000
    const second = await engine.tick()
    assert.equal(runs, 1, 'a paused once-off never fires again')
    assert.deepEqual(second.problems, [], 'and later ticks stay quiet')
  }

  // The once-off flag means "after one *triggered* fire" — a manual
  // "Run now" executes the action but never consumes the shot.
  async function assertManualRunNowDoesNotConsumeOnceOffShot(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    const root = await createWorkspace()
    const store = new AutomationsStore(root)
    assert.equal(
      (
        await store.createDefinition(
          definition({
            disableAfterRun: true,
            trigger: { kind: 'schedule', config: intervalConfig(60) },
            nextRunAt: new Date(now + 60 * 60_000).toISOString(),
          }),
        )
      ).ok,
      true,
    )

    let runs = 0
    const engine = new AutomationsEngine({
      approvals: everyAutomationApproved,
      getProjectFolders: () => [{ workspaceId: 'ws-once-manual', folderPath: root }],
      now: () => now,
      createRunId: () => 'run-once-manual',
      runAutomation: async () => {
        runs += 1
        return { status: 'completed', summary: 'Manual run completed.' }
      },
    })

    const manual = await engine.runNow({ workspaceRoot: root, automationId: 'nightly-review' })
    assert.equal(manual.ok, true, 'the manual run itself succeeds')
    assert.equal(runs, 1)
    const after = await store.getDefinition('nightly-review')
    assert.equal(after.ok, true)
    if (after.ok) {
      assert.equal(after.value.status, 'enabled', 'a manual run never consumes the once-off shot')
      assert.notEqual(after.value.nextRunAt, null, 'the schedule stays armed for the triggered fire')
    }
  }

  // The once-off pause covers the trigger-event path too — one delivered
  // event fires and pauses the automation, and a second matching event is refused
  // without enqueueing a run.
  async function assertDisableAfterRunPausesTriggerEventAutomationAndBlocksSecondEvent(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    const root = await createWorkspace()
    const store = new AutomationsStore(root)
    assert.equal(
      (
        await store.createDefinition(
          definition({
            disableAfterRun: true,
            trigger: { kind: 'test-event', config: {} },
            nextRunAt: null,
          }),
        )
      ).ok,
      true,
    )

    let runs = 0
    const engine = new AutomationsEngine({
      approvals: everyAutomationApproved,
      getProjectFolders: () => [{ workspaceId: 'ws-once-event', folderPath: root }],
      now: () => now,
      createRunId: () => `run-once-event-${runs}`,
      triggerProviders: [
        {
          kind: 'test-event',
          configSchema: {},
          subscribe: () => () => undefined,
        },
      ],
      runAutomation: async () => {
        runs += 1
        return { status: 'completed', summary: 'Event run completed.' }
      },
    })

    const first = await engine.deliverTriggerEvent({
      workspaceRoot: root,
      automationId: 'nightly-review',
      workspaceId: 'ws-once-event',
      event: { id: 'event-1', occurredAt: new Date(now).toISOString(), payload: {} },
    })
    assert.equal(first.ok, true, 'the first event fires')
    assert.equal(runs, 1)
    const paused = await store.getDefinition('nightly-review')
    assert.equal(paused.ok, true)
    if (paused.ok) {
      assert.equal(paused.value.status, 'paused', 'one triggered event pauses the definition')
      assert.equal(paused.value.nextRunAt, null)
    }

    const second = await engine.deliverTriggerEvent({
      workspaceRoot: root,
      automationId: 'nightly-review',
      workspaceId: 'ws-once-event',
      event: { id: 'event-2', occurredAt: new Date(now + 60_000).toISOString(), payload: {} },
    })
    assert.equal(second.ok, false, 'a second matching event is refused')
    assert.equal(second.ok ? '' : second.problem.code, 'automation_disabled')
    assert.equal(runs, 1, 'and it never enqueues a run')
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
    } as unknown as WorkspaceSyncSnapshot

    assert.deepEqual(projectFoldersFromWorkspaceSyncSnapshot(snapshot), [
      { workspaceId: 'ws-a', folderPath: '/repo/a' },
      { workspaceId: 'ws-d', folderPath: '/repo/d' },
    ])
  }

  async function assertDueAutomationSkipsOverlappingTickAndPreservesSingleFlight(): Promise<void> {
    const workspaceRoot = await createWorkspace()
    const store = new AutomationsStore(workspaceRoot)
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    assert.equal(
      (
        await store.createDefinition(
          definition({
            trigger: { kind: 'schedule', config: intervalConfig(5) },
            nextRunAt: new Date(now).toISOString(),
          }),
        )
      ).ok,
      true,
    )

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
      approvals: everyAutomationApproved,
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
    assert.equal(
      (
        await timerStore.createDefinition(
          definition({
            trigger: { kind: 'schedule', config: intervalConfig(5) },
            nextRunAt: new Date(now).toISOString(),
          }),
        )
      ).ok,
      true,
    )

    const events: AutomationsRunEvent[] = []
    const timerEngine = new AutomationsEngine({
      approvals: everyAutomationApproved,
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
    assert.equal(
      (
        await manualStore.createDefinition(
          definition({
            trigger: { kind: 'schedule', config: intervalConfig(10) },
            nextRunAt: new Date(now).toISOString(),
          }),
        )
      ).ok,
      true,
    )

    const manualEngine = new AutomationsEngine({
      approvals: everyAutomationApproved,
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

  async function assertAgentBackedRunStaysRunningUntilFinalize(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    const workspaceRoot = await createWorkspace()
    const store = new AutomationsStore(workspaceRoot)
    assert.equal(
      (
        await store.createDefinition(
          definition({
            trigger: { kind: 'schedule', config: intervalConfig(10) },
            nextRunAt: new Date(now).toISOString(),
          }),
        )
      ).ok,
      true,
    )

    const events: AutomationsRunEvent[] = []
    const removedWorktrees: string[] = []
    let prCalls = 0
    const engine = new AutomationsEngine({
      approvals: everyAutomationApproved,
      getProjectFolders: () => [{ workspaceId: 'ws-automations', folderPath: workspaceRoot }],
      now: () => now,
      createRunId: () => 'run-agent',
      onRunEvent: (event) => events.push(event),
      runAutomation: async () => ({
        status: 'running',
        workspaceId: 'ws-automations',
        agentId: 'agent-1',
        worktreePath: `${workspaceRoot}/.sprintengine/automations/worktrees/run-agent`,
        branch: 'automations/run-agent',
        summary: 'Launched; working…',
      }),
      openRunPullRequest: async () => {
        prCalls += 1
        return { ok: true, url: 'https://github.com/acme/repo/pull/9', created: true }
      },
      removeRunWorktree: async (input) => {
        removedWorktrees.push(input.worktreePath)
      },
    })

    const dispatched = await engine.runNow({
      workspaceRoot,
      automationId: 'nightly-review',
      workspaceId: 'ws-automations',
    })
    assert.equal(dispatched.ok, true)
    if (!dispatched.ok) return
    // Agent-backed run stays in-progress and emits no terminal event yet.
    assert.equal(dispatched.run.status, 'running')
    assert.equal(dispatched.run.completedAt, null)
    assert.equal(dispatched.run.agentId, 'agent-1')
    assert.equal(events.length, 0)

    // Finalize → opens PR, tears down worktree, records completed, emits event.
    const finalized = await engine.finalizeRun({
      workspaceRoot,
      automationId: 'nightly-review',
      runId: 'run-agent',
      outcome: 'completed',
    })
    assert.equal(finalized.ok, true)
    if (!finalized.ok) return
    assert.equal(finalized.run.status, 'completed')
    assert.equal(finalized.run.pullRequestUrl, 'https://github.com/acme/repo/pull/9')
    assert.equal(removedWorktrees.length, 1)
    assert.equal(events.length, 1)
    assert.equal(events[0]?.status, 'completed')

    // Idempotent: a second finalize neither re-opens a PR nor re-emits.
    const again = await engine.finalizeRun({
      workspaceRoot,
      automationId: 'nightly-review',
      runId: 'run-agent',
      outcome: 'completed',
    })
    assert.equal(again.ok, true)
    assert.equal(prCalls, 1)
    assert.equal(events.length, 1)
  }

  // --- Conversation-driven finalize: turn events, guards, settle window ---

  type AgentEngineHarness = {
    engine: AutomationsEngine
    events: AutomationsRunEvent[]
    removedWorktrees: string[]
    disposedAgents: Array<{ workspaceId: string; agentId: string }>
    counters: { prCalls: number }
    worktreePath: string
  }

  async function setupAgentRun(
    now: number,
    overrides: Partial<ConstructorParameters<typeof AutomationsEngine>[0]> = {},
  ): Promise<{ workspaceRoot: string; store: AutomationsStore } & AgentEngineHarness> {
    const workspaceRoot = await createWorkspace()
    const store = new AutomationsStore(workspaceRoot)
    assert.equal(
      (
        await store.createDefinition(
          definition({
            trigger: { kind: 'schedule', config: intervalConfig(10) },
            nextRunAt: new Date(now).toISOString(),
          }),
        )
      ).ok,
      true,
    )
    const harness = agentEngine(workspaceRoot, now, overrides)
    return { workspaceRoot, store, ...harness }
  }

  function agentEngine(
    workspaceRoot: string,
    now: number,
    overrides: Partial<ConstructorParameters<typeof AutomationsEngine>[0]> = {},
  ): AgentEngineHarness {
    const events: AutomationsRunEvent[] = []
    const removedWorktrees: string[] = []
    const disposedAgents: Array<{ workspaceId: string; agentId: string }> = []
    const counters = { prCalls: 0 }
    const worktreePath = `${workspaceRoot}/.sprintengine/automations/worktrees/run-agent`
    const engine = new AutomationsEngine({
      approvals: everyAutomationApproved,
      getProjectFolders: () => [{ workspaceId: 'ws-automations', folderPath: workspaceRoot }],
      now: () => now,
      createRunId: () => 'run-agent',
      // Short enough that a test waits it out for real without sleeping 15s, long
      // enough that a cancelling frame lands inside it deterministically.
      turnSettleMs: TEST_SETTLE_MS,
      onRunEvent: (event) => events.push(event),
      runAutomation: async () => ({
        status: 'running',
        workspaceId: 'ws-automations',
        agentId: 'agent-1',
        worktreePath,
        branch: 'automations/run-agent',
        summary: 'Launched; working…',
      }),
      openRunPullRequest: async () => {
        counters.prCalls += 1
        return { ok: true, url: 'https://github.com/acme/repo/pull/9', created: true }
      },
      removeRunWorktree: async (input) => {
        removedWorktrees.push(input.worktreePath)
      },
      disposeRunAgent: async (input) => {
        disposedAgents.push(input)
      },
      ...overrides,
    })
    return { engine, events, removedWorktrees, disposedAgents, counters, worktreePath }
  }

  const TEST_SETTLE_MS = 30

  // Like setupAgentRun, but the launched run carries the sessionId its launch
  // returned, as every real launch does; the startup reconcile correlates on it.
  async function setupAgentRunWithSessionId(
    now: number,
    sessionId: string,
    overrides: Partial<ConstructorParameters<typeof AutomationsEngine>[0]> = {},
  ): Promise<{ workspaceRoot: string; store: AutomationsStore } & AgentEngineHarness> {
    const workspaceRoot = await createWorkspace()
    const store = new AutomationsStore(workspaceRoot)
    assert.equal(
      (
        await store.createDefinition(
          definition({
            trigger: { kind: 'schedule', config: intervalConfig(10) },
            nextRunAt: new Date(now).toISOString(),
          }),
        )
      ).ok,
      true,
    )
    const worktreePath = `${workspaceRoot}/.sprintengine/automations/worktrees/run-agent`
    const harness = agentEngine(workspaceRoot, now, {
      runAutomation: async () => ({
        status: 'running',
        workspaceId: 'ws-automations',
        agentId: 'agent-1',
        sessionId,
        worktreePath,
        branch: 'automations/run-agent',
        summary: 'Launched; working…',
      }),
      ...overrides,
    })
    return { workspaceRoot, store, ...harness }
  }

  function turnEvent(overrides: Partial<AutomationConversationTurnEvent> = {}): AutomationConversationTurnEvent {
    return { type: 'turn_started', workspaceId: 'ws-automations', agentId: 'agent-1', sessionId: null, ...overrides }
  }

  // The agent is working: what every guarded turn-end must have seen first.
  function turnStarted(overrides: Partial<AutomationConversationTurnEvent> = {}): AutomationConversationTurnEvent {
    return turnEvent({ type: 'turn_started', ...overrides })
  }

  // A turn that really ended (a steered one is never routed as an end).
  function turnCompleted(overrides: Partial<AutomationConversationTurnEvent> = {}): AutomationConversationTurnEvent {
    return turnEvent({ type: 'turn_completed', ...overrides })
  }

  function turnFailed(overrides: Partial<AutomationConversationTurnEvent> = {}): AutomationConversationTurnEvent {
    return turnEvent({ type: 'turn_failed', ...overrides })
  }

  async function readRunStatus(
    store: AutomationsStore,
    automationId: string,
    runId: string,
  ): Promise<AutomationRun['status'] | undefined> {
    const result = await store.getRun(automationId, runId)
    return result.ok ? result.value.status : undefined
  }

  async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  // Wait out an armed settle window plus slack, then let the finalize it kicked
  // off (PR open, worktree teardown, store write) run to completion.
  async function settle(): Promise<void> {
    await sleep(TEST_SETTLE_MS * 3)
    await flushMicrotasks(50)
  }

  // The finalize a settle timer fires does real file I/O after the timer: the
  // run and definition reads, the run write. Microtask
  // flushes do not wait for any of it, so on a loaded machine the finalize lands
  // after settle() returns and a status read straight after it sees `running`.
  // A case that expects the finalize waits the window out and then for the
  // finalize's own result; a case that expects NO finalize keeps settle(),
  // since only a wait can show that nothing fired. On timeout this returns and
  // the caller's assertion reports what the run actually is.
  async function settleUntil(
    store: AutomationsStore,
    status: AutomationRun['status'],
    done: () => boolean = () => true,
  ): Promise<void> {
    await settle()
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if ((await readRunStatus(store, 'nightly-review', 'run-agent')) === status && done()) return
      await sleep(5)
    }
  }

  async function assertTurnEndFinalizesRunWithReplySummary(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    const summaryReads: Array<{ sessionId?: string; workspaceId?: string; agentId?: string }> = []
    const { engine, workspaceRoot, store, events, removedWorktrees, disposedAgents, counters } =
      await setupAgentRunWithSessionId(now, 'conv_1', {
        readRunConversationSummary: async (input) => {
          summaryReads.push(input)
          return 'Reviewed the repo and filed the report.'
        },
      })
    assert.equal(
      (await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
      true,
    )

    await engine.noteConversationTurn(turnStarted({ sessionId: 'conv_1' }))
    await engine.noteConversationTurn(turnCompleted({ sessionId: 'conv_1' }))

    // The turn-end only ARMS the finalize: nothing is destroyed until the settle
    // window has passed with no further work.
    assert.equal(
      await readRunStatus(store, 'nightly-review', 'run-agent'),
      'running',
      'no finalize inside the settle window',
    )
    assert.equal(counters.prCalls, 0, 'no PR opened inside the settle window')

    await settleUntil(store, 'completed')

    const finalized = await store.getRun('nightly-review', 'run-agent')
    assert.equal(finalized.ok && finalized.value.status, 'completed')
    assert.equal(
      finalized.ok && finalized.value.summary,
      'Reviewed the repo and filed the report. Opened pull request https://github.com/acme/repo/pull/9.',
      "summary comes from the agent's closing reply",
    )
    assert.deepEqual(summaryReads, [{ sessionId: 'conv_1', workspaceId: 'ws-automations', agentId: 'agent-1' }])
    assert.equal(counters.prCalls, 1, 'PR opened once')
    assert.equal(removedWorktrees.length, 1, 'worktree torn down')
    assert.deepEqual(disposedAgents, [{ workspaceId: 'ws-automations', agentId: 'agent-1' }], 'one-shot agent disposed')
    // A turn-driven completed finalize stays silent (no terminal run-event).
    assert.equal(events.length, 0, 'completed auto-finalize emits no run-event')

    // The run left the registry: a later turn of the same chat is inert.
    await engine.noteConversationTurn(turnCompleted({ sessionId: 'conv_1' }))
    await settle()
    assert.equal(counters.prCalls, 1, 'no second PR from a post-finalize turn')
  }

  async function assertTurnEndWithoutReplyUsesGenericSummary(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    const { engine, workspaceRoot, store, counters } = await setupAgentRun(now)
    assert.equal(
      (await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
      true,
    )

    // No summary reader wired: the summary degrades to a generic one and the
    // finalize proceeds regardless.
    await engine.noteConversationTurn(turnStarted())
    await engine.noteConversationTurn(turnCompleted())
    await settleUntil(store, 'completed')

    const finalized = await store.getRun('nightly-review', 'run-agent')
    assert.equal(finalized.ok && finalized.value.status, 'completed')
    assert.equal(
      finalized.ok && finalized.value.summary,
      'The agent finished, but left no summary of what it did. Opened pull request https://github.com/acme/repo/pull/9.',
    )
    assert.equal(counters.prCalls, 1)

    // A reader that fails is equally non-fatal.
    const {
      engine: engine2,
      workspaceRoot: root2,
      store: store2,
    } = await setupAgentRun(now, {
      readRunConversationSummary: async () => {
        throw new Error('transcript unreadable')
      },
    })
    assert.equal(
      (await engine2.runNow({ workspaceRoot: root2, automationId: 'nightly-review', workspaceId: 'ws-automations' }))
        .ok,
      true,
    )
    await engine2.noteConversationTurn(turnStarted())
    await engine2.noteConversationTurn(turnCompleted())
    await settleUntil(store2, 'completed')
    const finalized2 = await store2.getRun('nightly-review', 'run-agent')
    assert.equal(finalized2.ok && finalized2.value.status, 'completed', 'a failed summary read never blocks finalize')
    assert.equal(
      finalized2.ok && finalized2.value.summary?.startsWith('The agent finished, but left no summary of what it did.'),
      true,
    )
  }

  async function assertBackgroundAgentsDeferFinalize(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    const { engine, workspaceRoot, store, counters } = await setupAgentRun(now)
    assert.equal(
      (await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
      true,
    )

    // Background agents keep the conversation working past its turn: the turn
    // ending with some still running is not the run's end, and finalizing here
    // would open a PR from work still in progress.
    await engine.noteConversationTurn(turnStarted())
    await engine.noteConversationTurn(turnCompleted({ backgroundAgents: 2 }))
    await settle()

    assert.equal(
      await readRunStatus(store, 'nightly-review', 'run-agent'),
      'running',
      'a turn end with background agents running does not end the run',
    )
    assert.equal(counters.prCalls, 0)

    // When the last one reports back and nothing carries on, the run ends.
    await engine.noteConversationTurn(turnCompleted({ backgroundAgents: 0 }))
    await settleUntil(store, 'completed')
    assert.equal(await readRunStatus(store, 'nightly-review', 'run-agent'), 'completed')
  }

  async function assertTurnEndBeforeAnyTurnStartIsIgnored(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    const { engine, workspaceRoot, store, counters, disposedAgents } = await setupAgentRun(now)
    assert.equal(
      (await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
      true,
    )

    // A turn end the run never saw start is not the end of its own prompt, and
    // must not instantly finalize and dispose the agent.
    await engine.noteConversationTurn(turnCompleted())
    await settle()

    assert.equal(
      await readRunStatus(store, 'nightly-review', 'run-agent'),
      'running',
      'run with no observed work stays running',
    )
    assert.equal(counters.prCalls, 0)
    assert.deepEqual(disposedAgents, [], 'the live agent is not disposed')

    // Once it has actually worked, its next turn end finalizes.
    await engine.noteConversationTurn(turnStarted())
    await engine.noteConversationTurn(turnCompleted())
    await settleUntil(store, 'completed')
    assert.equal(await readRunStatus(store, 'nightly-review', 'run-agent'), 'completed')
  }

  async function assertNewTurnCancelsArmedSettleTimer(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    const { engine, workspaceRoot, store, counters } = await setupAgentRun(now)
    assert.equal(
      (await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
      true,
    )

    // The settle window covers an agent carrying on by itself after its turn
    // ended (a background agent reporting back, a hook continuing it). A new
    // turn inside the window disarms the finalize entirely.
    await engine.noteConversationTurn(turnStarted())
    await engine.noteConversationTurn(turnCompleted())
    await engine.noteConversationTurn(turnStarted())
    await settle()

    assert.equal(
      await readRunStatus(store, 'nightly-review', 'run-agent'),
      'running',
      'a carried-on turn cancels the armed finalize',
    )
    assert.equal(counters.prCalls, 0, 'no PR from a cancelled turn end')

    // The next real turn end still finalizes.
    await engine.noteConversationTurn(turnCompleted())
    await settleUntil(store, 'completed')
    assert.equal(await readRunStatus(store, 'nightly-review', 'run-agent'), 'completed')
    assert.equal(counters.prCalls, 1)
  }

  async function assertTurnFailureFinalizesRunAsFailed(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    const { engine, workspaceRoot, store, events, removedWorktrees, counters } = await setupAgentRun(now)
    assert.equal(
      (await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
      true,
    )

    // A failed turn (the provider errored, the turn was interrupted) finalizes
    // the run as failed, never completed with a PR.
    await engine.noteConversationTurn(turnStarted())
    await engine.noteConversationTurn(turnFailed())
    await settleUntil(store, 'failed', () => events.length > 0)

    const finalized = await store.getRun('nightly-review', 'run-agent')
    assert.equal(finalized.ok && finalized.value.status, 'failed', 'a failed turn is failed, not completed')
    assert.equal(finalized.ok && finalized.value.summary, 'The agent hit an error and stopped before it finished.')
    assert.equal(counters.prCalls, 0, 'a failed run opens no PR')
    assert.equal(removedWorktrees.length, 1, 'worktree torn down on failure')
    assert.equal(events.length, 1, 'a failed auto-finalize surfaces a run-event')
    assert.equal(events[0]?.status, 'failed')
    assert.equal(events[0]?.trigger, 'timer')
  }

  async function assertRunWithoutWorktreeIsTrackedAndFinalizes(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    // REGRESSION (bug 1): trackPendingAgentRun used to early-return unless the run
    // had a worktree, so every runInWorktree:false run was never registered and had
    // no finalize path at all — the runs that hung forever. This must fail against
    // the pre-change engine.
    const { engine, workspaceRoot, store, events, removedWorktrees, disposedAgents, counters } = await setupAgentRun(
      now,
      {
        runAutomation: async () => ({
          status: 'running',
          workspaceId: 'ws-automations',
          agentId: 'agent-1',
          summary: 'Launched; working…',
        }),
      },
    )
    assert.equal(
      (await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
      true,
    )

    await engine.noteConversationTurn(turnStarted())
    await engine.noteConversationTurn(turnCompleted())
    await settleUntil(store, 'completed')

    const finalized = await store.getRun('nightly-review', 'run-agent')
    assert.equal(finalized.ok && finalized.value.status, 'completed', 'a worktree-less run finalizes from its turn end')
    assert.equal(finalized.ok && finalized.value.summary, 'The agent finished, but left no summary of what it did.')
    assert.equal(counters.prCalls, 0, 'no worktree and no branch → nothing to open a PR from')
    assert.deepEqual(removedWorktrees, [], 'no worktree to tear down')
    assert.deepEqual(
      disposedAgents,
      [{ workspaceId: 'ws-automations', agentId: 'agent-1' }],
      'its agent is still disposed',
    )
    assert.equal(events.length, 0)
  }

  async function assertTurnsOfOtherChatsAreInert(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    const { engine, workspaceRoot, store, counters } = await setupAgentRun(now)
    assert.equal(
      (await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
      true,
    )

    // Every chat in the app emits these turns. Only the (workspaceId, agentId)
    // pair of a pending run may finalize one; a partial key matches nothing.
    await engine.noteConversationTurn(turnStarted({ agentId: 'agent-2' }))
    await engine.noteConversationTurn(turnCompleted({ agentId: 'agent-2' }))
    await engine.noteConversationTurn(turnStarted({ workspaceId: 'ws-other' }))
    await engine.noteConversationTurn(turnCompleted({ workspaceId: 'ws-other' }))
    await engine.noteConversationTurn(turnStarted({ workspaceId: null }))
    await engine.noteConversationTurn(turnCompleted({ workspaceId: null }))
    await settle()

    assert.equal(
      await readRunStatus(store, 'nightly-review', 'run-agent'),
      'running',
      "another chat's turn ending finalizes nothing",
    )
    assert.equal(counters.prCalls, 0)
  }

  async function assertTurnsOfAnotherSessionOfTheRunChatAreInert(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    const { engine, workspaceRoot, store, counters } = await setupAgentRunWithSessionId(now, 'conv_1')
    assert.equal(
      (await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
      true,
    )

    // A session the run did not start (the chat restarted from a window) is
    // not the run's conversation, even on the run's own chat.
    await engine.noteConversationTurn(turnStarted({ sessionId: 'conv_2' }))
    await engine.noteConversationTurn(turnCompleted({ sessionId: 'conv_2' }))
    await settle()
    assert.equal(await readRunStatus(store, 'nightly-review', 'run-agent'), 'running')
    assert.equal(counters.prCalls, 0)

    await engine.noteConversationTurn(turnStarted({ sessionId: 'conv_1' }))
    await engine.noteConversationTurn(turnCompleted({ sessionId: 'conv_1' }))
    await settleUntil(store, 'completed')
    assert.equal(await readRunStatus(store, 'nightly-review', 'run-agent'), 'completed')
  }

  async function assertTurnsBeforeTheRunIsRecordedAreReplayed(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    // The first message goes out as the session comes up, so the run's first
    // turn starts while the launch is still being recorded. That start must not
    // be lost, or the turn's end would be ignored as one never seen working.
    let engineRef: AutomationsEngine | undefined
    const { engine, workspaceRoot, store, counters } = await setupAgentRunWithSessionId(now, 'conv_1', {
      runAutomation: async () => {
        await engineRef!.noteConversationTurn(turnStarted({ sessionId: 'conv_1' }))
        await engineRef!.noteConversationTurn(turnStarted({ agentId: 'agent-2' }))
        return {
          status: 'running',
          workspaceId: 'ws-automations',
          agentId: 'agent-1',
          sessionId: 'conv_1',
          summary: 'Launched; working…',
        }
      },
    })
    engineRef = engine
    assert.equal(
      (await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
      true,
    )
    await flushMicrotasks(10)

    await engine.noteConversationTurn(turnCompleted({ sessionId: 'conv_1' }))
    await settleUntil(store, 'completed')
    assert.equal(
      await readRunStatus(store, 'nightly-review', 'run-agent'),
      'completed',
      'a turn that started before the run was recorded still finalizes it',
    )
    assert.equal(counters.prCalls, 0, 'no branch, no PR')
  }

  async function assertFirstSendFailureBeforeTheRunIsRecordedFailsIt(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    let engineRef: AutomationsEngine | undefined
    const { engine, workspaceRoot, store, events } = await setupAgentRunWithSessionId(now, 'conv_1', {
      runAutomation: async () => {
        await engineRef!.finalizeRunOnConversationEnd({
          reason: 'first_send_failed',
          workspaceId: 'ws-automations',
          agentId: 'agent-1',
          sessionId: 'conv_1',
          message: 'Attached skills could not be loaded.',
        })
        return {
          status: 'running',
          workspaceId: 'ws-automations',
          agentId: 'agent-1',
          sessionId: 'conv_1',
          summary: 'Launched; working…',
        }
      },
    })
    engineRef = engine
    assert.equal(
      (await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
      true,
    )
    await settleUntil(store, 'failed', () => events.length > 0)

    const finalized = await store.getRun('nightly-review', 'run-agent')
    assert.equal(finalized.ok && finalized.value.status, 'failed', 'a run whose first message was refused fails')
    assert.equal(
      finalized.ok && finalized.value.summary,
      'The agent never started on the task: Attached skills could not be loaded.',
    )
  }

  async function assertMaxDurationSweepFailsOverlongRun(): Promise<void> {
    const startedAt = Date.parse('2026-06-17T10:00:00.000Z')
    let clock = startedAt
    const { engine, workspaceRoot, store, events, removedWorktrees, counters } = await setupAgentRun(startedAt, {
      now: () => clock,
      maxAgentRunMs: 6 * 60 * 60 * 1000,
    })
    assert.equal(
      (await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
      true,
    )

    // A run still inside the cap is left alone for its turns.
    clock = startedAt + 5 * 60 * 60 * 1000
    await engine.tick()
    assert.equal(
      await readRunStatus(store, 'nightly-review', 'run-agent'),
      'running',
      'a younger run is untouched by the sweep',
    )

    // Past the cap it is failed rather than left Running forever — the backstop for
    // a conversation that hangs mid-turn, or whose turn end was lost.
    clock = startedAt + 6 * 60 * 60 * 1000 + 1
    await engine.tick()

    const swept = await store.getRun('nightly-review', 'run-agent')
    assert.equal(swept.ok && swept.value.status, 'failed')
    assert.equal(
      swept.ok && swept.value.summary,
      'The agent was still running after 6 hours, so SprintEngine stopped waiting and ended the run.',
    )
    assert.equal(counters.prCalls, 0, 'a swept run opens no PR')
    assert.equal(removedWorktrees.length, 1)
    assert.equal(events.length, 1)
    assert.equal(events[0]?.status, 'failed')
  }

  async function assertStartupRebuildsRegistryFromStore(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    // Engine A dispatches the run and records it as `running` in the store.
    const { engine: engineA, workspaceRoot, store } = await setupAgentRun(now)
    assert.equal(
      (await engineA.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
      true,
    )
    assert.equal(await readRunStatus(store, 'nightly-review', 'run-agent'), 'running')

    // Engine B is a fresh instance (empty in-memory registry) simulating a restart.
    // The seed rebuilds the registry from the persisted runs — which is what makes
    // (workspaceId, agentId) correlation survive a restart at all.
    const { engine: engineB, counters: countersB } = agentEngine(workspaceRoot, now)
    await engineB.handleStartup()
    await engineB.noteConversationTurn(turnStarted())
    await engineB.noteConversationTurn(turnCompleted())
    await settleUntil(store, 'completed')

    assert.equal(
      await readRunStatus(store, 'nightly-review', 'run-agent'),
      'completed',
      'restart-recovered run finalizes from its turns',
    )
    assert.equal(countersB.prCalls, 1)
  }

  async function assertManualFinalizeRemovesRunFromRegistry(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    const { engine, workspaceRoot, store, events, counters } = await setupAgentRun(now)
    assert.equal(
      (await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
      true,
    )

    // Manual finalize (IPC button) — emits even on completed, and clears the registry.
    const manual = await engine.finalizeRun({
      workspaceRoot,
      automationId: 'nightly-review',
      runId: 'run-agent',
      outcome: 'completed',
    })
    assert.equal(manual.ok, true)
    assert.equal(counters.prCalls, 1)
    assert.equal(events.length, 1, 'manual completed finalize emits a run-event')
    assert.equal(events[0]?.trigger, 'manual')

    // A later turn of that chat must not re-finalize: the run left the registry.
    await engine.noteConversationTurn(turnStarted())
    await engine.noteConversationTurn(turnCompleted())
    await settle()
    assert.equal(await readRunStatus(store, 'nightly-review', 'run-agent'), 'completed')
    assert.equal(counters.prCalls, 1, 'a turn does not touch a manually finalized run')
    assert.equal(events.length, 1, 'no extra event from the turn')
  }

  async function assertConcurrentManualAndAutoFinalizeOnce(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    const workspaceRoot = await createWorkspace()
    const store = new AutomationsStore(workspaceRoot)
    assert.equal(
      (
        await store.createDefinition(
          definition({
            trigger: { kind: 'schedule', config: intervalConfig(10) },
            nextRunAt: new Date(now).toISOString(),
          }),
        )
      ).ok,
      true,
    )

    const events: AutomationsRunEvent[] = []
    let prCalls = 0
    let removedWorktrees = 0
    let markPrStarted: () => void = () => undefined
    const prStarted = new Promise<void>((resolve) => {
      markPrStarted = resolve
    })
    let releasePr: () => void = () => undefined
    const prGate = new Promise<void>((resolve) => {
      releasePr = resolve
    })
    const worktreePath = `${workspaceRoot}/.sprintengine/automations/worktrees/run-agent`
    const engine = new AutomationsEngine({
      approvals: everyAutomationApproved,
      getProjectFolders: () => [{ workspaceId: 'ws-automations', folderPath: workspaceRoot }],
      now: () => now,
      createRunId: () => 'run-agent',
      onRunEvent: (event) => events.push(event),
      runAutomation: async () => ({
        status: 'running',
        workspaceId: 'ws-automations',
        agentId: 'agent-1',
        worktreePath,
        branch: 'automations/run-agent',
        summary: 'Launched; working…',
      }),
      openRunPullRequest: async () => {
        prCalls += 1
        markPrStarted()
        await prGate
        return { ok: true, url: 'https://github.com/acme/repo/pull/9', created: true }
      },
      removeRunWorktree: async () => {
        removedWorktrees += 1
      },
    })

    assert.equal(
      (await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
      true,
    )

    // Manual IPC finalize wins the lock and blocks mid-flight inside the PR open.
    const manual = engine.finalizeRun({
      workspaceRoot,
      automationId: 'nightly-review',
      runId: 'run-agent',
      outcome: 'completed',
    })
    await prStarted

    // A second finalize for the same run (what an auto-finalize would do) must hit
    // the per-run lock, not re-open a PR.
    const concurrent = await engine.finalizeRun({
      workspaceRoot,
      automationId: 'nightly-review',
      runId: 'run-agent',
      outcome: 'completed',
      eventTrigger: 'timer',
    })
    assert.equal(concurrent.ok && concurrent.run.status, 'running', 'concurrent caller gets the in-progress run')

    releasePr()
    const manualResult = await manual
    assert.equal(manualResult.ok && manualResult.run.status, 'completed')
    assert.equal(prCalls, 1, 'exactly one PR-open across interleaved finalize')
    assert.equal(removedWorktrees, 1, 'worktree torn down once')
    const terminalEvents = events.filter((event) => event.runId === 'run-agent')
    assert.equal(terminalEvents.length, 1, 'exactly one terminal run-event')
    assert.equal(await readRunStatus(store, 'nightly-review', 'run-agent'), 'completed')
  }

  // --- Conversation-end finalize + startup reconcile ---

  async function assertSessionCloseBeforeAnyTurnEndFinalizesFailed(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    const { engine, workspaceRoot, store, events, counters } = await setupAgentRunWithSessionId(now, 'conv_1')
    assert.equal(
      (await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
      true,
    )

    // The session closed with no turn end behind it: the agent never finished.
    await engine.noteConversationTurn(turnStarted({ sessionId: 'conv_1' }))
    await engine.finalizeRunOnConversationEnd({
      reason: 'session_closed',
      sessionId: 'conv_1',
      workspaceId: 'ws-automations',
      agentId: 'agent-1',
      message: 'the CLI exited',
    })

    const finalized = await store.getRun('nightly-review', 'run-agent')
    assert.equal(finalized.ok && finalized.value.status, 'failed')
    assert.equal(finalized.ok && finalized.value.summary, 'The agent stopped before it finished: the CLI exited')
    assert.equal(counters.prCalls, 0, 'failed run opens no PR')
    assert.equal(events.length, 1)
    assert.equal(events[0]?.status, 'failed')
    assert.equal(events[0]?.trigger, 'timer')
  }

  async function assertSessionCloseDuringSettleWindowUsesArmedOutcome(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    // A long settle window so the close lands while the turn-end is still armed.
    const { engine, workspaceRoot, store, counters, events } = await setupAgentRunWithSessionId(now, 'conv_1', {
      turnSettleMs: 60_000,
      readRunConversationSummary: async () => 'All done.',
    })
    assert.equal(
      (await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
      true,
    )

    // The agent finished its turn, then its session closed inside the settle
    // window. Recording that as failed would throw away a successful run — and its PR.
    await engine.noteConversationTurn(turnStarted({ sessionId: 'conv_1' }))
    await engine.noteConversationTurn(turnCompleted({ sessionId: 'conv_1' }))
    await engine.finalizeRunOnConversationEnd({ reason: 'session_closed', sessionId: 'conv_1' })

    const finalized = await store.getRun('nightly-review', 'run-agent')
    assert.equal(finalized.ok && finalized.value.status, 'completed', 'the armed turn-end outcome wins over the close')
    assert.equal(
      finalized.ok && finalized.value.summary,
      'All done. Opened pull request https://github.com/acme/repo/pull/9.',
    )
    assert.equal(counters.prCalls, 1)
    assert.equal(events.length, 0, 'completed finalize stays silent')

    // The settle timer was disarmed by the close, so nothing fires behind it.
    await settle()
    assert.equal(counters.prCalls, 1, 'no second finalize from the disarmed timer')
  }

  // A summary reader the test can hold open, to land events inside the armed
  // finalize's only await — which is where the settle-window races live.
  function heldSummaryRead(): {
    readRunConversationSummary: () => Promise<string | undefined>
    readStarted: Promise<void>
    release: (summary: string | undefined) => void
  } {
    let release!: (summary: string | undefined) => void
    let started!: () => void
    const readStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const result = new Promise<string | undefined>((resolve) => {
      release = resolve
    })
    return {
      readRunConversationSummary: () => {
        started()
        return result
      },
      readStarted,
      release,
    }
  }

  async function assertSessionCloseDuringSummaryReadUsesArmedOutcome(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    const read = heldSummaryRead()
    const { engine, workspaceRoot, store, counters, events } = await setupAgentRunWithSessionId(now, 'conv_1', {
      turnSettleMs: 0,
      readRunConversationSummary: read.readRunConversationSummary,
    })
    assert.equal(
      (await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
      true,
    )

    await engine.noteConversationTurn(turnStarted({ sessionId: 'conv_1' }))
    await engine.noteConversationTurn(turnCompleted({ sessionId: 'conv_1' }))
    // The settle timer has fired and the finalize is holding inside the summary
    // read when the session closes. The close must join that finalize, not
    // record `failed` over a run whose turn-end already stands.
    await read.readStarted
    const close = engine.finalizeRunOnConversationEnd({ reason: 'session_closed', sessionId: 'conv_1' })
    read.release('All done.')
    await close
    await flushMicrotasks(50)

    const finalized = await store.getRun('nightly-review', 'run-agent')
    assert.equal(
      finalized.ok && finalized.value.status,
      'completed',
      'the armed outcome wins over a close racing the summary read',
    )
    assert.equal(
      finalized.ok && finalized.value.summary,
      'All done. Opened pull request https://github.com/acme/repo/pull/9.',
    )
    assert.equal(counters.prCalls, 1, 'exactly one finalize, one PR')
    assert.equal(events.length, 0, 'no failed event recorded behind the completed run')
  }

  async function assertNewTurnDuringSummaryReadAbortsFinalize(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    const read = heldSummaryRead()
    const { engine, workspaceRoot, store, counters } = await setupAgentRun(now, {
      turnSettleMs: 0,
      readRunConversationSummary: read.readRunConversationSummary,
    })
    assert.equal(
      (await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
      true,
    )

    await engine.noteConversationTurn(turnStarted())
    await engine.noteConversationTurn(turnCompleted())
    // The agent carried on with a new turn while the finalize was inside the
    // summary read. The in-flight finalize must stand down — it would otherwise
    // dispose an agent that is working again.
    await read.readStarted
    await engine.noteConversationTurn(turnStarted())
    read.release('never recorded')
    await flushMicrotasks(50)

    assert.equal(
      await readRunStatus(store, 'nightly-review', 'run-agent'),
      'running',
      'a resumed agent is not finalized',
    )
    assert.equal(counters.prCalls, 0)

    // The abort is not sticky: the agent's next real turn-end still finalizes.
    await engine.noteConversationTurn(turnCompleted())
    await settleUntil(store, 'completed')
    assert.equal(
      await readRunStatus(store, 'nightly-review', 'run-agent'),
      'completed',
      'the next turn-end finalizes normally',
    )
    assert.equal(counters.prCalls, 1)
  }

  async function assertCloseAfterAbortedArmedFinalizeStillFails(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    const read = heldSummaryRead()
    const { engine, workspaceRoot, store, counters } = await setupAgentRunWithSessionId(now, 'conv_1', {
      turnSettleMs: 0,
      readRunConversationSummary: read.readRunConversationSummary,
    })
    assert.equal(
      (await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
      true,
    )

    await engine.noteConversationTurn(turnStarted({ sessionId: 'conv_1' }))
    await engine.noteConversationTurn(turnCompleted({ sessionId: 'conv_1' }))
    await read.readStarted
    // The close joins the in-flight armed finalize; then a straggler turn start
    // disarms it mid-read. The aborted finalize leaves the run pending — the
    // close must pick it back up as failed rather than drop it until the 6h sweep.
    const close = engine.finalizeRunOnConversationEnd({ reason: 'session_closed', sessionId: 'conv_1' })
    await flushMicrotasks(10)
    await engine.noteConversationTurn(turnStarted({ sessionId: 'conv_1' }))
    read.release('never recorded')
    await close
    await flushMicrotasks(50)

    const finalized = await store.getRun('nightly-review', 'run-agent')
    assert.equal(
      finalized.ok && finalized.value.status,
      'failed',
      'the close outcome lands once the armed finalize aborts',
    )
    assert.equal(finalized.ok && finalized.value.summary, 'The agent stopped before it finished.')
    assert.equal(counters.prCalls, 0)
  }

  async function assertStopDuringSummaryReadAbortsFinalize(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    const read = heldSummaryRead()
    const { engine, workspaceRoot, store, counters } = await setupAgentRun(now, {
      turnSettleMs: 0,
      readRunConversationSummary: read.readRunConversationSummary,
    })
    assert.equal(
      (await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
      true,
    )

    await engine.noteConversationTurn(turnStarted())
    await engine.noteConversationTurn(turnCompleted())
    // stop() lands while the armed finalize is inside the summary read: the
    // torn-down engine must not go on to open a PR and dispose the agent.
    await read.readStarted
    engine.stop()
    read.release('never recorded')
    await flushMicrotasks(50)

    assert.equal(
      await readRunStatus(store, 'nightly-review', 'run-agent'),
      'running',
      'a stopped engine finalizes nothing',
    )
    assert.equal(counters.prCalls, 0)
  }

  async function assertSessionCloseCorrelatesOnWorkspaceAndAgentId(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    // The run carries NO sessionId (a run recorded before sessions were kept).
    // The close's (workspaceId, agentId) still finds the pending run.
    const { engine, workspaceRoot, store } = await setupAgentRun(now)
    assert.equal(
      (await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
      true,
    )

    await engine.finalizeRunOnConversationEnd({
      reason: 'session_closed',
      sessionId: 'conv_9',
      workspaceId: 'ws-automations',
      agentId: 'agent-1',
    })
    assert.equal(
      await readRunStatus(store, 'nightly-review', 'run-agent'),
      'failed',
      'a close correlates without a recorded sessionId',
    )
  }

  async function assertSessionCloseForUnknownChatIsNoOp(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    const { engine, workspaceRoot, store, events, counters } = await setupAgentRunWithSessionId(now, 'conv_1')
    assert.equal(
      (await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
      true,
    )

    // Every other chat's close arrives here. None of them may finalize.
    await engine.finalizeRunOnConversationEnd({
      reason: 'session_closed',
      sessionId: 'conv_other',
      workspaceId: 'ws-automations',
      agentId: 'agent-2',
    })
    await engine.finalizeRunOnConversationEnd({
      reason: 'session_closed',
      sessionId: 'conv_other',
      workspaceId: 'ws-automations',
      agentId: 'agent-1',
    })
    await engine.finalizeRunOnConversationEnd({ reason: 'session_closed', sessionId: '   ' })
    await engine.finalizeRunOnConversationEnd({ reason: 'session_closed' })

    assert.equal(
      await readRunStatus(store, 'nightly-review', 'run-agent'),
      'running',
      'an unmatched close leaves the run pending',
    )
    assert.equal(counters.prCalls, 0)
    assert.equal(events.length, 0)
  }

  async function assertFinalizeDisposesSpawnedAgentAndToleratesDisposeFailure(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')

    // Normal completed finalize disposes the run's one-shot chat with its ids, so
    // it never outlives the torn-down worktree and is never typed into against it.
    {
      const { engine, workspaceRoot, store, disposedAgents } = await setupAgentRunWithSessionId(now, 'conv_1')
      assert.equal(
        (await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
        true,
      )
      assert.equal(
        (
          await engine.finalizeRun({
            workspaceRoot,
            automationId: 'nightly-review',
            runId: 'run-agent',
            outcome: 'completed',
          })
        ).ok,
        true,
      )
      assert.deepEqual(
        disposedAgents,
        [{ workspaceId: 'ws-automations', agentId: 'agent-1' }],
        'finalize disposes the spawned agent exactly once with its workspace/agent ids',
      )
      assert.equal(await readRunStatus(store, 'nightly-review', 'run-agent'), 'completed')
    }

    // The dispose is best-effort: a throwing disposer (e.g. the session is
    // already gone) must not fail the finalize — the terminal run is still recorded.
    {
      const { engine, workspaceRoot } = await setupAgentRunWithSessionId(now, 'conv_2', {
        disposeRunAgent: async () => {
          throw new Error('renderer unavailable')
        },
      })
      assert.equal(
        (await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
        true,
      )
      const result = await engine.finalizeRun({
        workspaceRoot,
        automationId: 'nightly-review',
        runId: 'run-agent',
        outcome: 'completed',
      })
      assert.equal(result.ok && result.run.status, 'completed', 'a failed dispose does not fail the finalize')
    }
  }

  async function assertStartupReconcileForceFailsOrphanedAgentRun(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    // Engine A dispatches a run that records `running` with sessionId 'conv_orphan'.
    const { engine: engineA, workspaceRoot, store } = await setupAgentRunWithSessionId(now, 'conv_orphan')
    assert.equal(
      (await engineA.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
      true,
    )
    assert.equal(await readRunStatus(store, 'nightly-review', 'run-agent'), 'running')

    // Engine B restart: the conversation is no longer live.
    const {
      engine: engineB,
      events,
      counters,
      disposedAgents,
    } = agentEngine(workspaceRoot, now, {
      getLiveConversationSessionIds: () => [],
    })
    await engineB.handleStartup()

    const finalized = await store.getRun('nightly-review', 'run-agent')
    assert.equal(finalized.ok && finalized.value.status, 'failed', 'orphaned run is force-failed')
    assert.equal(
      finalized.ok && finalized.value.summary,
      'The agent stopped while the app was closed, so this run never finished.',
    )
    assert.deepEqual(
      disposedAgents,
      [{ workspaceId: 'ws-automations', agentId: 'agent-1' }],
      'startup reconcile disposes the orphaned chat so nobody types into it against the removed worktree',
    )
    assert.equal(counters.prCalls, 0)
    assert.equal(events.length, 1)
    assert.equal(events[0]?.status, 'failed')
    assert.equal(events[0]?.trigger, 'timer')
  }

  async function assertStartupReconcileLeavesStillLiveRunPending(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    const { engine: engineA, workspaceRoot, store } = await setupAgentRunWithSessionId(now, 'conv_live')
    assert.equal(
      (await engineA.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
      true,
    )

    // Engine B restart, but the run's session is still live.
    const { engine: engineB, counters } = agentEngine(workspaceRoot, now, {
      getLiveConversationSessionIds: () => ['conv_live'],
    })
    await engineB.handleStartup()

    assert.equal(
      await readRunStatus(store, 'nightly-review', 'run-agent'),
      'running',
      'a still-live run is left pending',
    )
    assert.equal(counters.prCalls, 0)
  }

  async function assertStartupReconcileNeverForceFailsSessionlessRun(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    // setupAgentRun's default run carries NO sessionId.
    const { engine: engineA, workspaceRoot, store } = await setupAgentRun(now)
    assert.equal(
      (await engineA.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
      true,
    )

    // Engine B restart with no live sessions: nothing proves this run's agent is
    // gone, so it must not be force-failed — its turns (or the max-duration
    // sweep) still cover it.
    const { engine: engineB, counters } = agentEngine(workspaceRoot, now, {
      getLiveConversationSessionIds: () => [],
    })
    await engineB.handleStartup()

    assert.equal(await readRunStatus(store, 'nightly-review', 'run-agent'), 'running', 'sessionless run is untouched')
    assert.equal(counters.prCalls, 0)
  }

  async function assertStopClearsArmedSettleTimers(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    const { engine, workspaceRoot, store, counters } = await setupAgentRun(now)
    assert.equal(
      (await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
      true,
    )

    await engine.noteConversationTurn(turnStarted())
    await engine.noteConversationTurn(turnCompleted())
    // A settle timer that outlives the engine would open a PR and dispose an agent
    // for an app that has already torn the engine down.
    engine.stop()
    await settle()

    assert.equal(
      await readRunStatus(store, 'nightly-review', 'run-agent'),
      'running',
      'a stopped engine finalizes nothing',
    )
    assert.equal(counters.prCalls, 0)
  }

  function recordingGitDeps(statusStdout: string): { deps: PullRequestDeps; calls: string[][] } {
    const calls: string[][] = []
    const ok = (stdout = ''): CommandResult => ({ ok: true, stdout, stderr: '' })
    const deps: PullRequestDeps = {
      runGit: async (_cwd, args) => {
        calls.push(args)
        return args[0] === 'status' ? ok(statusStdout) : ok()
      },
      runGh: async (_cwd, args) => {
        calls.push(['gh', ...args])
        // `pr view` reports no existing PR; `pr create` returns the new URL.
        return args[0] === 'pr' && args[1] === 'view' ? ok('') : ok('https://github.com/acme/repo/pull/9')
      },
    }
    return { deps, calls }
  }

  function realOpenerEngine(input: {
    workspaceRoot: string
    worktreePath: string
    now: number
    deps: PullRequestDeps
    events: AutomationsRunEvent[]
    removed: { count: number }
  }): AutomationsEngine {
    return new AutomationsEngine({
      approvals: everyAutomationApproved,
      getProjectFolders: () => [{ workspaceId: 'ws-automations', folderPath: input.workspaceRoot }],
      now: () => input.now,
      createRunId: () => 'run-agent',
      turnSettleMs: TEST_SETTLE_MS,
      onRunEvent: (event) => input.events.push(event),
      runAutomation: async () => ({
        status: 'running',
        workspaceId: 'ws-automations',
        agentId: 'agent-1',
        worktreePath: input.worktreePath,
        branch: 'automations/run-agent',
        summary: 'Launched; working…',
      }),
      openRunPullRequest: (prInput) =>
        openAutomationRunPullRequest(
          {
            worktreePath: prInput.worktreePath,
            branch: prInput.branch,
            title: prInput.title,
            body: prInput.body,
          },
          input.deps,
        ),
      removeRunWorktree: async () => {
        input.removed.count += 1
      },
    })
  }

  async function assertFinalizePublishesWorkingDiff(): Promise<void> {
    // Every run may backstop-commit its diff. There is no mode that withholds one:
    // a working diff on the run's own branch is the expected output, and the
    // containment is the worktree, the branch, and a PR nothing merges by itself.
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    const workspaceRoot = await createWorkspace()
    const store = new AutomationsStore(workspaceRoot)
    assert.equal(
      (
        await store.createDefinition(
          definition({
            trigger: { kind: 'schedule', config: intervalConfig(10) },
            nextRunAt: new Date(now).toISOString(),
          }),
        )
      ).ok,
      true,
    )

    const { deps, calls } = recordingGitDeps(' M src/feature.ts\n')
    const events: AutomationsRunEvent[] = []
    const removed = { count: 0 }
    const worktreePath = `${workspaceRoot}/.sprintengine/automations/worktrees/run-agent`
    const engine = realOpenerEngine({ workspaceRoot, worktreePath, now, deps, events, removed })

    assert.equal(
      (await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok,
      true,
    )
    await engine.noteConversationTurn(turnStarted())
    await engine.noteConversationTurn(turnCompleted())
    await settleUntil(store, 'completed')

    // The diff is staged, committed, and pushed; a PR is opened.
    assert.deepEqual(calls.filter((args) => args[0] === 'add')[0], ['add', '-A'], 'finalize stages the diff')
    assert.equal(
      calls.some((args) => args[0] === 'commit'),
      true,
      'finalize commits',
    )
    assert.equal(
      calls.some((args) => args[0] === 'push'),
      true,
      'finalize pushes',
    )
    const finalized = await store.getRun('nightly-review', 'run-agent')
    assert.equal(finalized.ok && finalized.value.status, 'completed')
    assert.equal(
      finalized.ok && finalized.value.pullRequestUrl,
      'https://github.com/acme/repo/pull/9',
      'finalize links a PR',
    )
    assert.equal(finalized.ok && finalized.value.blockedReason, undefined, 'a published diff is not a blocked run')
    assert.equal(removed.count, 1, 'worktree torn down')
  }

  async function assertRunEventDeliveryFailuresDoNotMutateRunTruth(): Promise<void> {
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    const manualRoot = await createWorkspace()
    const manualStore = new AutomationsStore(manualRoot)
    assert.equal(
      (
        await manualStore.createDefinition(
          definition({
            trigger: { kind: 'schedule', config: intervalConfig(10) },
            nextRunAt: new Date(now).toISOString(),
          }),
        )
      ).ok,
      true,
    )

    let manualDeliveryAttempts = 0
    const manualEngine = new AutomationsEngine({
      approvals: everyAutomationApproved,
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
    assert.equal(
      (
        await timerStore.createDefinition(
          definition({
            trigger: { kind: 'schedule', config: intervalConfig(5) },
            nextRunAt: new Date(now).toISOString(),
          }),
        )
      ).ok,
      true,
    )

    let timerDeliveryAttempts = 0
    const timerEngine = new AutomationsEngine({
      approvals: everyAutomationApproved,
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
    assert.deepEqual(tick.fired, [
      {
        workspaceRoot: timerRoot,
        automationId: 'nightly-review',
        runId: 'run-timer-throw',
        status: 'completed',
      },
    ])

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
    assert.equal(
      (
        await store.createDefinition(
          definition({
            trigger: { kind: 'weather-deck.forecast-ready', config: { city: 'Dublin' } },
            action: { kind: 'spawn-agent', config: {} },
            nextRunAt: null,
          }),
        )
      ).ok,
      true,
    )

    const now = Date.parse('2026-06-17T10:00:00.000Z')
    let pollCount = 0
    let triggerProviders: AutomationTriggerProvider[] = []
    const engine = new AutomationsEngine({
      approvals: everyAutomationApproved,
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
    assert.deepEqual(tick.fired, [
      {
        workspaceRoot,
        automationId: 'nightly-review',
        runId: 'run-live-provider',
        status: 'completed',
      },
    ])
  }

  async function assertDeniedTriggerProviderIsInertBeforePolling(): Promise<void> {
    const workspaceRoot = await createWorkspace()
    const store = new AutomationsStore(workspaceRoot)
    assert.equal(
      (
        await store.createDefinition(
          definition({
            trigger: { kind: 'weather-deck.forecast-ready', config: { city: 'Dublin' } },
            action: { kind: 'spawn-agent', config: {} },
            nextRunAt: null,
          }),
        )
      ).ok,
      true,
    )

    let validateCalls = 0
    let pollCalls = 0
    let runCount = 0
    const thirdPartyTrigger: AutomationTriggerProvider = {
      kind: 'weather-deck.forecast-ready',
      configSchema: { type: 'object' },
      requiredIntegrations: ['module:weather-deck'],
      validateConfig: () => {
        validateCalls += 1
        throw new Error('denied trigger validateConfig must not run')
      },
      subscribe: () => () => undefined,
      poll: async () => {
        pollCalls += 1
        throw new Error('denied trigger poll must not run')
      },
    }
    const triggerProviders = executableTriggerProviders(
      [
        {
          providerId: 'weather-deck.weather-deck.forecast-ready',
          moduleId: 'weather-deck',
          providerType: 'trigger',
          kind: 'weather-deck.forecast-ready',
          configSchema: { type: 'object' },
          requiredIntegrations: ['module:weather-deck'],
          provider: thirdPartyTrigger,
        },
      ],
      () => ({ ok: false, reason: 'Module "weather-deck" is not trusted.' }),
    )
    const engine = new AutomationsEngine({
      approvals: everyAutomationApproved,
      getProjectFolders: () => [{ workspaceId: 'ws-denied-provider', folderPath: workspaceRoot }],
      triggerProviders,
      isIntegrationAvailable: () => false,
      now: () => Date.parse('2026-06-17T10:00:00.000Z'),
      createRunId: () => 'run-denied-provider',
      runAutomation: async () => {
        runCount += 1
        return { status: 'completed', summary: 'Denied provider should not run.' }
      },
    })

    const tick = await engine.tick()
    assert.equal(validateCalls, 0)
    assert.equal(pollCalls, 0)
    assert.equal(runCount, 0)
    assert.deepEqual(tick.problems, [])
    assert.deepEqual(tick.fired, [
      {
        workspaceRoot,
        automationId: 'nightly-review',
        runId: 'run-denied-provider',
        status: 'blocked',
      },
    ])

    const runs = await store.listRuns('nightly-review')
    assert.equal(runs.ok, true)
    assert.equal(runs.ok && runs.values.length, 1)
    assert.equal(runs.ok && runs.values[0]?.status, 'blocked')
    assert.match(runs.ok ? (runs.values[0]?.blockedReason ?? '') : '', /not trusted/)
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
      approvals: everyAutomationApproved,
      getProjectFolders: () => [{ workspaceId: 'ws-webhooks', folderPath: workspaceRoot }],
      triggerProviders: [createWebhookTriggerProvider()],
      now: () => now,
      createRunId: ({ automationId }) => `${automationId}-run-${(runIndex += 1)}`,
      runAutomation: async (input) => {
        triggerPayloads.push(input.triggerPayload)
        return { status: 'completed', summary: 'Webhook handled.' }
      },
    })
    const receiver = new AutomationWebhookReceiver({
      approvals: everyAutomationApproved,
      getProjectFolders: () => [{ workspaceId: 'ws-webhooks', folderPath: workspaceRoot }],
      deliverTriggerEvent: (input) => engine.deliverTriggerEvent(input),
      now: () => now,
    })

    try {
      const disabledStatus = await receiver.refresh()
      assert.equal(disabledStatus.state, 'stopped')
      assert.equal(disabledStatus.targetCount, 0)

      assert.equal(
        (
          await store.updateDefinition({
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
          })
        ).ok,
        true,
      )

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
      const unprefixed = await receiver.deliver({
        port: 0,
        path: '/incoming-review',
        headers: validHeaders,
        rawBody,
      })
      assert.equal(unprefixed.ok, false)
      assert.equal(unprefixed.ok ? '' : unprefixed.code, 'webhook_route_not_found')
      assert.equal(triggerPayloads.length, 0)

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
        state.ok &&
          state.value?.triggerEventDedupByAutomationId?.['webhook-review']?.['webhook:incoming-review:delivery-1'],
        '2026-06-17T10:00:00.000Z',
      )
    } finally {
      await receiver.stop()
    }
  }

  async function assertWebhookDeliveryFailureRedactsProblemFromCaller(): Promise<void> {
    const workspaceRoot = await createWorkspace()
    const store = new AutomationsStore(workspaceRoot)
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    const secret = 'test-webhook-secret-redacted'
    const sensitiveMessage = `${workspaceRoot}/.sprintengine/automations/state.json: disk full`
    const loggedMessages: string[] = []
    assert.equal(
      (
        await store.createDefinition(
          definition({
            id: 'webhook-redacted-failure',
            name: 'Webhook redacted failure',
            trigger: {
              kind: WEBHOOK_TRIGGER_KIND,
              config: {
                kind: WEBHOOK_TRIGGER_KIND,
                enabled: true,
                port: 0,
                path: 'redacted-failure',
                secret,
              },
            },
            nextRunAt: null,
          }),
        )
      ).ok,
      true,
    )

    const receiver = new AutomationWebhookReceiver({
      approvals: everyAutomationApproved,
      getProjectFolders: () => [{ workspaceId: 'ws-webhooks', folderPath: workspaceRoot }],
      deliverTriggerEvent: async () => ({
        ok: false,
        problem: {
          workspaceRoot,
          automationId: 'webhook-redacted-failure',
          code: 'state_write_failed',
          message: sensitiveMessage,
        },
      }),
      logDeliveryProblem: (problem) => {
        loggedMessages.push(problem.message)
      },
      now: () => now,
    })

    try {
      const status = await receiver.refresh()
      assert.equal(status.state, 'running')
      const rawBody = JSON.stringify({ eventType: 'push' })
      const delivered = await receiver.deliver({
        port: 0,
        path: webhookEndpointPath('redacted-failure'),
        headers: {
          'content-type': 'application/json',
          [WEBHOOK_DELIVERY_ID_HEADER]: 'delivery-redacted',
          [WEBHOOK_SIGNATURE_HEADER]: createWebhookSignature(secret, rawBody),
        },
        rawBody,
      })

      assert.equal(delivered.ok, false)
      assert.equal(delivered.ok ? 0 : delivered.statusCode, 500)
      assert.equal(delivered.ok ? '' : delivered.code, 'state_write_failed')
      assert.equal(delivered.ok ? '' : delivered.message, 'Webhook delivery failed.')
      assert.equal(JSON.stringify(delivered).includes(workspaceRoot), false)
      assert.equal(JSON.stringify(delivered).includes('.sprintengine/automations'), false)
      assert.deepEqual(loggedMessages, [sensitiveMessage])
    } finally {
      await receiver.stop()
    }
  }

  async function assertWebhookReceiverRefreshSerializesAndFailsClosed(): Promise<void> {
    const workspaceRoot = await createWorkspace()
    const store = new AutomationsStore(workspaceRoot)
    const secret = 'test-webhook-secret-serial'
    const enabled = definition({
      id: 'webhook-serial',
      name: 'Webhook serial',
      trigger: {
        kind: WEBHOOK_TRIGGER_KIND,
        config: {
          kind: WEBHOOK_TRIGGER_KIND,
          enabled: true,
          port: 0,
          path: 'first-route',
          secret,
        },
      },
      nextRunAt: null,
    })
    assert.equal((await store.createDefinition(enabled)).ok, true)

    const receiver = new AutomationWebhookReceiver({
      approvals: everyAutomationApproved,
      getProjectFolders: () => [{ workspaceId: 'ws-webhooks', folderPath: workspaceRoot }],
      deliverTriggerEvent: async () => {
        throw new Error('webhook serial refresh test should not deliver events')
      },
    })

    try {
      const firstRefresh = receiver.refresh()
      assert.equal(
        (
          await store.updateDefinition({
            ...enabled,
            trigger: {
              kind: WEBHOOK_TRIGGER_KIND,
              config: {
                kind: WEBHOOK_TRIGGER_KIND,
                enabled: true,
                port: 0,
                path: 'second-route',
                secret,
              },
            },
            updatedAt: '2026-06-17T10:01:00.000Z',
          })
        ).ok,
        true,
      )
      const secondRefresh = receiver.refresh()
      assert.equal(
        (
          await store.updateDefinition({
            ...enabled,
            trigger: {
              kind: WEBHOOK_TRIGGER_KIND,
              config: { kind: WEBHOOK_TRIGGER_KIND, enabled: false },
            },
            updatedAt: '2026-06-17T10:02:00.000Z',
          })
        ).ok,
        true,
      )
      const thirdRefresh = receiver.refresh()

      const refreshes = await Promise.allSettled([firstRefresh, secondRefresh, thirdRefresh])
      assert.equal(
        refreshes.every((result) => result.status === 'fulfilled'),
        true,
      )
      const finalStatus = receiver.status()
      assert.equal(finalStatus.state, 'stopped')
      assert.equal(finalStatus.targetCount, 0)

      for (const path of [webhookEndpointPath('first-route'), webhookEndpointPath('second-route')]) {
        const stale = await receiver.deliver({ port: 0, path, headers: {}, rawBody: '{}' })
        assert.equal(stale.ok, false)
        assert.equal(stale.ok ? '' : stale.code, 'webhook_route_not_found')
      }
    } finally {
      await receiver.stop()
    }

    const occupied = await listenOnEphemeralPort()
    const conflictReceiver = new AutomationWebhookReceiver({
      approvals: everyAutomationApproved,
      getProjectFolders: () => [{ workspaceId: 'ws-webhooks', folderPath: workspaceRoot }],
      deliverTriggerEvent: async () => {
        throw new Error('webhook conflict refresh test should not deliver events')
      },
    })
    try {
      assert.equal(
        (
          await store.updateDefinition({
            ...enabled,
            trigger: {
              kind: WEBHOOK_TRIGGER_KIND,
              config: {
                kind: WEBHOOK_TRIGGER_KIND,
                enabled: true,
                port: occupied.port,
                path: 'conflict-route',
                secret,
              },
            },
            updatedAt: '2026-06-17T10:03:00.000Z',
          })
        ).ok,
        true,
      )

      await assert.rejects(() => conflictReceiver.refresh(), /EADDRINUSE|address already in use|listen/u)
      const failedStatus = conflictReceiver.status()
      assert.equal(failedStatus.state, 'stopped')
      assert.equal(failedStatus.targetCount, 0)
      assert.match(failedStatus.error ?? '', /EADDRINUSE|address already in use|listen/u)
      const stale = await conflictReceiver.deliver({
        port: occupied.port,
        path: webhookEndpointPath('conflict-route'),
        headers: {},
        rawBody: '{}',
      })
      assert.equal(stale.ok, false)
      assert.equal(stale.ok ? '' : stale.code, 'webhook_route_not_found')
    } finally {
      await conflictReceiver.stop()
      await closeHttpServer(occupied.server)
    }
  }

  async function assertStartupOverdueIsSkippedWithoutCatchup(): Promise<void> {
    const workspaceRoot = await createWorkspace()
    const store = new AutomationsStore(workspaceRoot)
    const now = Date.parse('2026-06-17T10:00:00.000Z')
    assert.equal(
      (
        await store.createDefinition(
          definition({
            trigger: { kind: 'schedule', config: intervalConfig(15) },
            nextRunAt: '2026-06-17T09:00:00.000Z',
          }),
        )
      ).ok,
      true,
    )

    let runCount = 0
    const engine = new AutomationsEngine({
      approvals: everyAutomationApproved,
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
    const store = new InMemoryAutomationsStore(
      definition({
        trigger: { kind: 'schedule', config: intervalConfig(15) },
        nextRunAt: '2026-06-17T09:00:00.000Z',
      }),
    )

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
      approvals: everyAutomationApproved,
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
    const tickRace = await Promise.race([runnerStarted, flushMicrotasks(50).then(() => 'blocked' as const)])
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

  await suiteRun
})
