import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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
import { AutomationsEngine, projectFoldersFromWorkspaceSyncSnapshot } from './engine'
import { openAutomationRunPullRequest, type CommandResult, type PullRequestDeps } from './pull-request'
import { runSignalPath } from './run-signal'
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
  await assertAgentBackedRunStaysRunningUntilFinalize()
  await assertRunEventDeliveryFailuresDoNotMutateRunTruth()
  await assertPollingTriggersUseProviderGetterAtEvaluationTime()
  await assertDeniedTriggerProviderIsInertBeforePolling()
  await assertWebhookReceiverOptInAuthAndDedupesDeliveredEvents()
  await assertWebhookDeliveryFailureRedactsProblemFromCaller()
  await assertWebhookReceiverRefreshSerializesAndFailsClosed()
  await assertStartupOverdueIsSkippedWithoutCatchup()
  await assertTickWaitsForStartupOverdueSkip()
  await assertSignalScanFinalizesCompletedRunSilently()
  await assertSignalScanFinalizesFailedRunAndEmitsEvent()
  await assertMalformedOrMissingSignalLeavesRunPending()
  await assertSignalScanIsIdempotentOnRescan()
  await assertStartupRebuildsRegistryFromStore()
  await assertManualFinalizeRemovesRunFromRegistry()
  await assertEmptySummarySignalAutoFinalizes()
  await assertSignalScanRecordsContainedReportPaths()
  await assertOutOfReportsPathsDropWithoutFailingFinalize()
  await assertConcurrentManualAndScanFinalizeOnce()
  await assertOversizeSignalStaysPending()
  await assertReviewOnlyFinalizeWithholdsUnexpectedChanges()
  await assertAllowChangesFinalizeStillPushesWorkingDiff()
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

async function assertAgentBackedRunStaysRunningUntilFinalize(): Promise<void> {
  const now = Date.parse('2026-06-17T10:00:00.000Z')
  const workspaceRoot = await createWorkspace()
  const store = new AutomationsStore(workspaceRoot)
  assert.equal((await store.createDefinition(definition({
    trigger: { kind: 'schedule', config: intervalConfig(10) },
    nextRunAt: new Date(now).toISOString(),
  }))).ok, true)

  const events: AutomationsRunEvent[] = []
  const removedWorktrees: string[] = []
  let prCalls = 0
  const engine = new AutomationsEngine({
    getProjectFolders: () => [{ workspaceId: 'ws-automations', folderPath: workspaceRoot }],
    now: () => now,
    createRunId: () => 'run-agent',
    onRunEvent: (event) => events.push(event),
    runAutomation: async () => ({
      status: 'running',
      workspaceId: 'ws-automations',
      agentId: 'agent-1',
      worktreePath: `${workspaceRoot}/.multi-code/automations/worktrees/run-agent`,
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

  const dispatched = await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })
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

// --- Agent-declared run-status signal-file auto-finalize (T4) ---

type AgentEngineHarness = {
  engine: AutomationsEngine
  events: AutomationsRunEvent[]
  removedWorktrees: string[]
  counters: { prCalls: number }
  worktreePath: string
}

async function setupAgentRun(
  now: number,
  overrides: Partial<ConstructorParameters<typeof AutomationsEngine>[0]> = {}
): Promise<{ workspaceRoot: string; store: AutomationsStore } & AgentEngineHarness> {
  const workspaceRoot = await createWorkspace()
  const store = new AutomationsStore(workspaceRoot)
  assert.equal((await store.createDefinition(definition({
    trigger: { kind: 'schedule', config: intervalConfig(10) },
    nextRunAt: new Date(now).toISOString(),
  }))).ok, true)
  const harness = agentEngine(workspaceRoot, now, overrides)
  return { workspaceRoot, store, ...harness }
}

function agentEngine(
  workspaceRoot: string,
  now: number,
  overrides: Partial<ConstructorParameters<typeof AutomationsEngine>[0]> = {}
): AgentEngineHarness {
  const events: AutomationsRunEvent[] = []
  const removedWorktrees: string[] = []
  const counters = { prCalls: 0 }
  const worktreePath = `${workspaceRoot}/.multi-code/automations/worktrees/run-agent`
  const engine = new AutomationsEngine({
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
      counters.prCalls += 1
      return { ok: true, url: 'https://github.com/acme/repo/pull/9', created: true }
    },
    removeRunWorktree: async (input) => {
      removedWorktrees.push(input.worktreePath)
    },
    ...overrides,
  })
  return { engine, events, removedWorktrees, counters, worktreePath }
}

async function writeRunSignal(worktreePath: string, body: string): Promise<void> {
  await mkdir(worktreePath, { recursive: true })
  await writeFile(runSignalPath(worktreePath), body, 'utf8')
}

async function readRunStatus(
  store: AutomationsStore,
  automationId: string,
  runId: string
): Promise<AutomationRun['status'] | undefined> {
  const result = await store.getRun(automationId, runId)
  return result.ok ? result.value.status : undefined
}

async function assertSignalScanFinalizesCompletedRunSilently(): Promise<void> {
  const now = Date.parse('2026-06-17T10:00:00.000Z')
  const { engine, workspaceRoot, store, events, removedWorktrees, counters, worktreePath } = await setupAgentRun(now)

  const dispatched = await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })
  assert.equal(dispatched.ok, true)
  assert.equal(dispatched.ok && dispatched.run.status, 'running')
  assert.equal(events.length, 0)

  await writeRunSignal(worktreePath, JSON.stringify({ status: 'completed', summary: 'Opened PR.' }))
  await engine.tick()

  const finalized = await store.getRun('nightly-review', 'run-agent')
  assert.equal(finalized.ok && finalized.value.status, 'completed')
  assert.equal(finalized.ok && finalized.value.pullRequestUrl, 'https://github.com/acme/repo/pull/9')
  assert.equal(counters.prCalls, 1, 'PR opened once')
  assert.equal(removedWorktrees.length, 1, 'worktree torn down')
  // A timer-driven completed finalize stays silent (no terminal run-event).
  assert.equal(events.length, 0, 'completed auto-finalize emits no run-event')

  // Re-scan after the run is terminal does nothing (registry already cleared).
  await engine.tick()
  assert.equal(counters.prCalls, 1, 'no second PR on re-tick')
}

async function assertSignalScanFinalizesFailedRunAndEmitsEvent(): Promise<void> {
  const now = Date.parse('2026-06-17T10:00:00.000Z')
  const { engine, workspaceRoot, store, events, removedWorktrees, counters, worktreePath } = await setupAgentRun(now)

  assert.equal((await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok, true)
  await writeRunSignal(worktreePath, JSON.stringify({ status: 'failed', summary: 'Could not finish.' }))
  await engine.tick()

  const finalized = await store.getRun('nightly-review', 'run-agent')
  assert.equal(finalized.ok && finalized.value.status, 'failed')
  assert.equal(counters.prCalls, 0, 'failed run opens no PR')
  assert.equal(removedWorktrees.length, 1, 'worktree torn down on failure')
  // A timer-driven failed finalize surfaces a failed run-event.
  assert.equal(events.length, 1)
  assert.equal(events[0]?.status, 'failed')
  assert.equal(events[0]?.trigger, 'timer')
}

async function assertMalformedOrMissingSignalLeavesRunPending(): Promise<void> {
  const now = Date.parse('2026-06-17T10:00:00.000Z')
  const { engine, workspaceRoot, store, counters, worktreePath } = await setupAgentRun(now)
  assert.equal((await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok, true)

  // Missing signal file: run stays pending.
  await engine.tick()
  assert.equal((await readRunStatus(store, 'nightly-review', 'run-agent')), 'running')
  assert.equal(counters.prCalls, 0)

  // Malformed / unrecognized signal: still pending, never coerced.
  await writeRunSignal(worktreePath, '{ not json')
  await engine.tick()
  assert.equal((await readRunStatus(store, 'nightly-review', 'run-agent')), 'running')
  await writeRunSignal(worktreePath, JSON.stringify({ status: 'queued' }))
  await engine.tick()
  assert.equal((await readRunStatus(store, 'nightly-review', 'run-agent')), 'running')
  assert.equal(counters.prCalls, 0, 'no finalize on invalid signal')

  // A valid signal later finalizes it, proving the run was still tracked.
  await writeRunSignal(worktreePath, JSON.stringify({ status: 'completed' }))
  await engine.tick()
  assert.equal((await readRunStatus(store, 'nightly-review', 'run-agent')), 'completed')
  assert.equal(counters.prCalls, 1)
}

async function assertSignalScanIsIdempotentOnRescan(): Promise<void> {
  const now = Date.parse('2026-06-17T10:00:00.000Z')
  const { engine, workspaceRoot, store, counters, worktreePath } = await setupAgentRun(now)
  assert.equal((await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok, true)
  await writeRunSignal(worktreePath, JSON.stringify({ status: 'completed' }))

  await engine.tick()
  await engine.tick()
  await engine.tick()
  assert.equal((await readRunStatus(store, 'nightly-review', 'run-agent')), 'completed')
  assert.equal(counters.prCalls, 1, 'finalize/PR happens exactly once across repeated scans')
}

async function assertStartupRebuildsRegistryFromStore(): Promise<void> {
  const now = Date.parse('2026-06-17T10:00:00.000Z')
  // Engine A dispatches the run and records it as `running` in the store.
  const { engine: engineA, workspaceRoot, store, worktreePath } = await setupAgentRun(now)
  assert.equal((await engineA.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok, true)
  assert.equal((await readRunStatus(store, 'nightly-review', 'run-agent')), 'running')

  // Engine B is a fresh instance (empty in-memory registry) simulating a restart.
  const { engine: engineB, counters: countersB } = agentEngine(workspaceRoot, now)
  await writeRunSignal(worktreePath, JSON.stringify({ status: 'completed' }))
  // Startup seeds the registry from disk, then the scan finalizes the run.
  await engineB.handleStartup()
  assert.equal((await readRunStatus(store, 'nightly-review', 'run-agent')), 'completed')
  assert.equal(countersB.prCalls, 1, 'restart-recovered run finalized via startup seed')
}

async function assertManualFinalizeRemovesRunFromRegistry(): Promise<void> {
  const now = Date.parse('2026-06-17T10:00:00.000Z')
  const { engine, workspaceRoot, store, events, counters, worktreePath } = await setupAgentRun(now)
  assert.equal((await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok, true)

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

  // A subsequent signal scan must not re-finalize: the run left the registry.
  await writeRunSignal(worktreePath, JSON.stringify({ status: 'failed' }))
  await engine.tick()
  assert.equal((await readRunStatus(store, 'nightly-review', 'run-agent')), 'completed')
  assert.equal(counters.prCalls, 1, 'scan does not touch a manually finalized run')
  assert.equal(events.length, 1, 'no extra event from the scan')
}

async function assertEmptySummarySignalAutoFinalizes(): Promise<void> {
  const now = Date.parse('2026-06-17T10:00:00.000Z')
  const { engine, workspaceRoot, store, counters, worktreePath } = await setupAgentRun(now)
  assert.equal((await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok, true)

  // A valid completed declaration with an empty summary must still finalize
  // (regression guard for the stranded-run bug, F1) — not stay 'running' forever.
  await writeRunSignal(worktreePath, JSON.stringify({ status: 'completed', summary: '' }))
  await engine.tick()

  const finalized = await store.getRun('nightly-review', 'run-agent')
  assert.equal(finalized.ok && finalized.value.status, 'completed', 'empty-summary completed signal finalizes')
  assert.equal(counters.prCalls, 1, 'PR opened for empty-summary completed run')
}

async function assertSignalScanRecordsContainedReportPaths(): Promise<void> {
  const now = Date.parse('2026-06-17T10:00:00.000Z')
  const { engine, workspaceRoot, store, worktreePath } = await setupAgentRun(now)
  assert.equal((await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok, true)

  // The signal threads its reports into finalize. A mix of a valid path, an
  // exact duplicate, a traversal escape, and an out-of-reports path collapses to
  // the contained, de-duped survivors recorded on the run.
  await writeRunSignal(worktreePath, JSON.stringify({
    status: 'completed',
    summary: 'Wrote the review.',
    reports: [
      'reports/2026-06-17-review.md',
      'reports/2026-06-17-review.md',
      '../secret.md',
      'notes/leak.md',
      'reports/sub/extra.html',
    ],
  }))
  await engine.tick()

  const finalized = await store.getRun('nightly-review', 'run-agent')
  assert.equal(finalized.ok && finalized.value.status, 'completed')
  assert.deepEqual(
    finalized.ok ? finalized.value.reportPaths : undefined,
    ['reports/2026-06-17-review.md', 'reports/sub/extra.html'],
    'only contained, de-duped report paths recorded',
  )
}

async function assertOutOfReportsPathsDropWithoutFailingFinalize(): Promise<void> {
  const now = Date.parse('2026-06-17T10:00:00.000Z')
  const { engine, workspaceRoot, store, counters, worktreePath } = await setupAgentRun(now)
  assert.equal((await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok, true)

  // Every declared path escapes reports/ — they all drop, but the completed
  // outcome still finalizes (and opens its PR); reportPaths stays absent.
  await writeRunSignal(worktreePath, JSON.stringify({
    status: 'completed',
    reports: ['../secret.md', 'notes/leak.md', '/etc/passwd'],
  }))
  await engine.tick()

  const finalized = await store.getRun('nightly-review', 'run-agent')
  assert.equal(finalized.ok && finalized.value.status, 'completed', 'finalize still completes')
  assert.equal(finalized.ok && finalized.value.reportPaths, undefined, 'no contained paths → reportPaths absent')
  assert.equal(counters.prCalls, 1)
}

async function assertConcurrentManualAndScanFinalizeOnce(): Promise<void> {
  const now = Date.parse('2026-06-17T10:00:00.000Z')
  const workspaceRoot = await createWorkspace()
  const store = new AutomationsStore(workspaceRoot)
  assert.equal((await store.createDefinition(definition({
    trigger: { kind: 'schedule', config: intervalConfig(10) },
    nextRunAt: new Date(now).toISOString(),
  }))).ok, true)

  const events: AutomationsRunEvent[] = []
  let prCalls = 0
  let removedWorktrees = 0
  let markPrStarted: () => void = () => undefined
  const prStarted = new Promise<void>((resolve) => { markPrStarted = resolve })
  let releasePr: () => void = () => undefined
  const prGate = new Promise<void>((resolve) => { releasePr = resolve })
  const worktreePath = `${workspaceRoot}/.multi-code/automations/worktrees/run-agent`
  const engine = new AutomationsEngine({
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
    removeRunWorktree: async () => { removedWorktrees += 1 },
  })

  assert.equal((await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok, true)

  // Manual IPC finalize wins the lock and blocks mid-flight inside the PR open.
  const manual = engine.finalizeRun({
    workspaceRoot,
    automationId: 'nightly-review',
    runId: 'run-agent',
    outcome: 'completed',
  })
  await prStarted

  // Second caller mirrors the per-tick scan's internal finalize for the same run
  // (eventTrigger 'timer'). It must hit the per-run lock, not re-open a PR.
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
  assert.equal((await readRunStatus(store, 'nightly-review', 'run-agent')), 'completed')
}

async function assertOversizeSignalStaysPending(): Promise<void> {
  const now = Date.parse('2026-06-17T10:00:00.000Z')
  const { engine, workspaceRoot, store, counters, worktreePath } = await setupAgentRun(now)
  assert.equal((await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok, true)

  // An oversize signal (> 64 KB) is treated as malformed: never loaded, run stays
  // pending (F5/L1) — and importantly not dropped from the registry.
  const oversize = JSON.stringify({ status: 'completed', summary: 'x'.repeat(70 * 1024) })
  assert.equal(oversize.length > 64 * 1024, true)
  await writeRunSignal(worktreePath, oversize)
  await engine.tick()
  assert.equal((await readRunStatus(store, 'nightly-review', 'run-agent')), 'running', 'oversize signal ignored; run pending')
  assert.equal(counters.prCalls, 0, 'oversize signal opens no PR')

  // A later in-bound signal still finalizes — proving the run was never dropped.
  await writeRunSignal(worktreePath, JSON.stringify({ status: 'completed' }))
  await engine.tick()
  assert.equal((await readRunStatus(store, 'nightly-review', 'run-agent')), 'completed')
  assert.equal(counters.prCalls, 1)
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
    getProjectFolders: () => [{ workspaceId: 'ws-automations', folderPath: input.workspaceRoot }],
    now: () => input.now,
    createRunId: () => 'run-agent',
    onRunEvent: (event) => input.events.push(event),
    runAutomation: async () => ({
      status: 'running',
      workspaceId: 'ws-automations',
      agentId: 'agent-1',
      worktreePath: input.worktreePath,
      branch: 'automations/run-agent',
      summary: 'Launched; working…',
    }),
    openRunPullRequest: (prInput) => openAutomationRunPullRequest({
      worktreePath: prInput.worktreePath,
      branch: prInput.branch,
      title: prInput.title,
      body: prInput.body,
      autonomy: prInput.autonomy,
    }, input.deps),
    removeRunWorktree: async () => { input.removed.count += 1 },
  })
}

async function assertReviewOnlyFinalizeWithholdsUnexpectedChanges(): Promise<void> {
  const now = Date.parse('2026-06-17T10:00:00.000Z')
  const workspaceRoot = await createWorkspace()
  const store = new AutomationsStore(workspaceRoot)
  assert.equal((await store.createDefinition(definition({
    trigger: { kind: 'schedule', config: intervalConfig(10) },
    nextRunAt: new Date(now).toISOString(),
    autonomyDefault: 'review_only',
  }))).ok, true)

  // The agent left an extra uncommitted file (the signal file is git-excluded, so
  // it never appears in `git status --porcelain`).
  const { deps, calls } = recordingGitDeps(' M src/stray.ts\n')
  const events: AutomationsRunEvent[] = []
  const removed = { count: 0 }
  const worktreePath = `${workspaceRoot}/.multi-code/automations/worktrees/run-agent`
  const engine = realOpenerEngine({ workspaceRoot, worktreePath, now, deps, events, removed })

  assert.equal((await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok, true)
  await writeRunSignal(worktreePath, JSON.stringify({ status: 'completed', summary: 'Reviewed; suggested a fix.' }))
  await engine.tick()

  // The stray file is never staged, committed, or pushed, and no PR is opened.
  const mutating = calls.filter((args) => args[0] === 'add' || args[0] === 'commit' || args[0] === 'push')
  assert.deepEqual(mutating, [], 'review_only finalize must not stage/commit/push the working diff')
  assert.deepEqual(calls.filter((args) => args[0] === 'gh'), [], 'review_only finalize opens no PR for unexpected changes')

  // The run still finalizes (not stranded) with a clear withheld-changes reason.
  const finalized = await store.getRun('nightly-review', 'run-agent')
  assert.equal(finalized.ok && finalized.value.status, 'completed')
  assert.equal(finalized.ok && finalized.value.pullRequestUrl, undefined, 'no PR linked for withheld changes')
  assert.match(finalized.ok ? finalized.value.blockedReason ?? '' : '', /unexpected uncommitted changes/i)
  assert.match(finalized.ok ? finalized.value.summary ?? '' : '', /No pull request linked/i)
  assert.equal(removed.count, 1, 'worktree still torn down')
}

async function assertAllowChangesFinalizeStillPushesWorkingDiff(): Promise<void> {
  const now = Date.parse('2026-06-17T10:00:00.000Z')
  const workspaceRoot = await createWorkspace()
  const store = new AutomationsStore(workspaceRoot)
  assert.equal((await store.createDefinition(definition({
    trigger: { kind: 'schedule', config: intervalConfig(10) },
    nextRunAt: new Date(now).toISOString(),
    autonomyDefault: 'allow_changes',
  }))).ok, true)

  // Same dirty working tree, but allow_changes must keep the backstop behavior.
  const { deps, calls } = recordingGitDeps(' M src/feature.ts\n')
  const events: AutomationsRunEvent[] = []
  const removed = { count: 0 }
  const worktreePath = `${workspaceRoot}/.multi-code/automations/worktrees/run-agent`
  const engine = realOpenerEngine({ workspaceRoot, worktreePath, now, deps, events, removed })

  assert.equal((await engine.runNow({ workspaceRoot, automationId: 'nightly-review', workspaceId: 'ws-automations' })).ok, true)
  await writeRunSignal(worktreePath, JSON.stringify({ status: 'completed', summary: 'Implemented the change.' }))
  await engine.tick()

  // The diff is staged, committed, and pushed; a PR is opened.
  assert.deepEqual(calls.filter((args) => args[0] === 'add')[0], ['add', '-A'], 'allow_changes still stages the diff')
  assert.equal(calls.some((args) => args[0] === 'commit'), true, 'allow_changes still commits')
  assert.equal(calls.some((args) => args[0] === 'push'), true, 'allow_changes still pushes')
  const finalized = await store.getRun('nightly-review', 'run-agent')
  assert.equal(finalized.ok && finalized.value.status, 'completed')
  assert.equal(finalized.ok && finalized.value.pullRequestUrl, 'https://github.com/acme/repo/pull/9', 'allow_changes links a PR')
  assert.equal(finalized.ok && finalized.value.blockedReason, undefined, 'no withheld-changes reason for allow_changes')
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

async function assertDeniedTriggerProviderIsInertBeforePolling(): Promise<void> {
  const workspaceRoot = await createWorkspace()
  const store = new AutomationsStore(workspaceRoot)
  assert.equal((await store.createDefinition(definition({
    trigger: { kind: 'weather-deck.forecast-ready', config: { city: 'Dublin' } },
    action: { kind: 'spawn-agent', config: {} },
    nextRunAt: null,
  }))).ok, true)

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
    [{
      providerId: 'weather-deck.weather-deck.forecast-ready',
      moduleId: 'weather-deck',
      providerType: 'trigger',
      kind: 'weather-deck.forecast-ready',
      configSchema: { type: 'object' },
      requiredIntegrations: ['module:weather-deck'],
      provider: thirdPartyTrigger,
    }],
    () => ({ ok: false, reason: 'Module "weather-deck" is not trusted.' })
  )
  const engine = new AutomationsEngine({
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
  assert.deepEqual(tick.fired, [{
    workspaceRoot,
    automationId: 'nightly-review',
    runId: 'run-denied-provider',
    status: 'blocked',
  }])

  const runs = await store.listRuns('nightly-review')
  assert.equal(runs.ok, true)
  assert.equal(runs.ok && runs.values.length, 1)
  assert.equal(runs.ok && runs.values[0]?.status, 'blocked')
  assert.match(runs.ok ? runs.values[0]?.blockedReason ?? '' : '', /not trusted/)
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
      state.ok && state.value?.triggerEventDedupByAutomationId?.['webhook-review']?.['webhook:incoming-review:delivery-1'],
      '2026-06-17T10:00:00.000Z'
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
  const sensitiveMessage = `${workspaceRoot}/.multi-code/automations/state.json: disk full`
  const loggedMessages: string[] = []
  assert.equal((await store.createDefinition(definition({
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
  }))).ok, true)

  const receiver = new AutomationWebhookReceiver({
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
    assert.equal(JSON.stringify(delivered).includes('.multi-code/automations'), false)
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
    getProjectFolders: () => [{ workspaceId: 'ws-webhooks', folderPath: workspaceRoot }],
    deliverTriggerEvent: async () => {
      throw new Error('webhook serial refresh test should not deliver events')
    },
  })

  try {
    const firstRefresh = receiver.refresh()
    assert.equal((await store.updateDefinition({
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
    })).ok, true)
    const secondRefresh = receiver.refresh()
    assert.equal((await store.updateDefinition({
      ...enabled,
      trigger: {
        kind: WEBHOOK_TRIGGER_KIND,
        config: { kind: WEBHOOK_TRIGGER_KIND, enabled: false },
      },
      updatedAt: '2026-06-17T10:02:00.000Z',
    })).ok, true)
    const thirdRefresh = receiver.refresh()

    const refreshes = await Promise.allSettled([firstRefresh, secondRefresh, thirdRefresh])
    assert.equal(refreshes.every((result) => result.status === 'fulfilled'), true)
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
    getProjectFolders: () => [{ workspaceId: 'ws-webhooks', folderPath: workspaceRoot }],
    deliverTriggerEvent: async () => {
      throw new Error('webhook conflict refresh test should not deliver events')
    },
  })
  try {
    assert.equal((await store.updateDefinition({
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
    })).ok, true)

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
