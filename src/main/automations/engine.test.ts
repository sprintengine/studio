import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  AutomationDefinition,
  AutomationRun,
  AutomationsRunEvent,
  ScheduleTriggerConfig,
} from '../../shared/automations/contracts'
import type { SwitchboardTaskRecord } from '../../shared/switchboard'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import { AutomationsEngine, projectFoldersFromWorkspaceSyncSnapshot } from './engine'
import { AutomationsStore, type AutomationStoreState } from './store'
import { computeNextRun, validateScheduleTriggerConfig } from './schedule'
import { createRepoEventTriggerProvider, REPO_EVENT_TRIGGER_KIND } from './triggers/repo-event'

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
  await assertStartupOverdueIsSkippedWithoutCatchup()
  await assertTickWaitsForStartupOverdueSkip()
  await assertRepoEventTriggerFiresOnceAndDedupesAcrossRestart()
  await assertRepoEventTriggerBlocksWhenSwitchboardUnsynced()
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

function repoEventDefinition(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return definition({
    id: 'repo-event-watch',
    name: 'Repo event watch',
    trigger: {
      kind: REPO_EVENT_TRIGGER_KIND,
      config: { kind: REPO_EVENT_TRIGGER_KIND, provider: 'github' },
    },
    nextRunAt: null,
    ...overrides,
  })
}

function switchboardTaskRecord(overrides: Partial<SwitchboardTaskRecord['task']> = {}): SwitchboardTaskRecord {
  const task = {
    schemaVersion: 1 as const,
    id: 'task-1',
    identifier: 'GH-1',
    title: 'Fix issue',
    description: 'Synced from GitHub.',
    priority: null,
    state: 'todo' as const,
    branchName: null,
    url: 'https://github.com/acme/repo/issues/1',
    labels: ['bug'],
    blockedBy: [],
    source: {
      type: 'github' as const,
      externalId: 'github-node-1',
      externalKey: 'acme/repo#1',
      externalUrl: 'https://github.com/acme/repo/issues/1',
    },
    claim: null,
    execution: {
      attempts: [],
      worktreePath: null,
      activeSessionId: null,
    },
    evidence: {
      summary: '',
      artifacts: [],
      commandsRun: [],
      touchedFiles: [],
    },
    comments: [],
    createdAt: '2026-06-17T09:00:00.000Z',
    updatedAt: '2026-06-17T09:00:00.000Z',
    ...overrides,
  }

  return {
    task,
    location: {
      folderStatus: 'todo',
      path: `.multi-code/switchboard/todo/${task.id}.json`,
    },
    warnings: [],
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

async function assertRepoEventTriggerFiresOnceAndDedupesAcrossRestart(): Promise<void> {
  const workspaceRoot = await createWorkspace()
  const store = new AutomationsStore(workspaceRoot)
  const now = Date.parse('2026-06-17T10:00:00.000Z')
  assert.equal((await store.createDefinition(repoEventDefinition())).ok, true)

  let syncedTasks = [switchboardTaskRecord()]
  const provider = createRepoEventTriggerProvider({
    readAllTasks: async (input) => ({
      ok: true,
      workspaceRoot: input.workspaceRoot,
      switchboardRoot: '/switchboard',
      tasks: syncedTasks,
      problems: [],
    }),
  })
  const triggerPayloads: Record<string, unknown>[] = []
  let runIndex = 0
  const createEngine = () =>
    new AutomationsEngine({
      getProjectFolders: () => [{ workspaceId: 'ws-repo-events', folderPath: workspaceRoot }],
      triggerProviders: [provider],
      isIntegrationAvailable: (id) => id === 'module:switchboard',
      now: () => now,
      createRunId: () => `repo-event-run-${runIndex += 1}`,
      runAutomation: async (input) => {
        triggerPayloads.push(input.triggerPayload)
        return { status: 'completed', summary: 'Repo event handled.' }
      },
    })

  const firstEngine = createEngine()
  const firstTick = await firstEngine.tick()
  assert.equal(firstTick.fired.length, 1)
  assert.equal(firstTick.fired[0]?.runId, 'repo-event-run-1')
  assert.equal(triggerPayloads.length, 1)
  assert.equal(triggerPayloads[0]?.kind, REPO_EVENT_TRIGGER_KIND)
  assert.equal(triggerPayloads[0]?.provider, 'github')
  assert.equal(triggerPayloads[0]?.externalKey, 'acme/repo#1')

  const duplicateTick = await firstEngine.tick()
  assert.equal(duplicateTick.fired.length, 0)
  assert.equal(triggerPayloads.length, 1)

  const restartedEngine = createEngine()
  const afterRestart = await restartedEngine.tick()
  assert.equal(afterRestart.fired.length, 0)
  assert.equal(triggerPayloads.length, 1)

  syncedTasks = [
    switchboardTaskRecord({
      id: 'task-2',
      identifier: 'GH-2',
      title: 'New issue',
      source: {
        type: 'github',
        externalId: 'github-node-2',
        externalKey: 'acme/repo#2',
        externalUrl: 'https://github.com/acme/repo/issues/2',
      },
      url: 'https://github.com/acme/repo/issues/2',
      createdAt: '2026-06-17T09:30:00.000Z',
      updatedAt: '2026-06-17T09:30:00.000Z',
    }),
  ]
  const newEventTick = await restartedEngine.tick()
  assert.equal(newEventTick.fired.length, 1)
  assert.equal(newEventTick.fired[0]?.runId, 'repo-event-run-2')
  assert.equal(triggerPayloads.length, 2)
  assert.equal(triggerPayloads[1]?.externalKey, 'acme/repo#2')

  const runs = await store.listRuns('repo-event-watch')
  assert.equal(runs.ok, true)
  assert.equal(runs.ok && runs.values.length, 2)

  const state = await store.readState()
  assert.equal(state.ok, true)
  assert.equal(
    state.ok && Object.keys(state.value?.repoEventDedupByAutomationId?.['repo-event-watch'] ?? {}).length,
    2
  )
}

async function assertRepoEventTriggerBlocksWhenSwitchboardUnsynced(): Promise<void> {
  const workspaceRoot = await createWorkspace()
  const store = new AutomationsStore(workspaceRoot)
  const now = Date.parse('2026-06-17T10:00:00.000Z')
  assert.equal((await store.createDefinition(repoEventDefinition())).ok, true)

  const provider = createRepoEventTriggerProvider({
    readAllTasks: async (input) => ({
      ok: true,
      workspaceRoot: input.workspaceRoot,
      switchboardRoot: '/switchboard',
      tasks: [],
      problems: [],
    }),
  })
  let runAutomationCalled = 0
  const engine = new AutomationsEngine({
    getProjectFolders: () => [{ workspaceId: 'ws-unsynced', folderPath: workspaceRoot }],
    triggerProviders: [provider],
    isIntegrationAvailable: (id) => id === 'module:switchboard',
    now: () => now,
    createRunId: () => 'repo-event-blocked',
    runAutomation: async () => {
      runAutomationCalled += 1
      return { status: 'completed' }
    },
  })

  const firstTick = await engine.tick()
  assert.equal(firstTick.fired.length, 1)
  assert.equal(firstTick.fired[0]?.status, 'blocked')
  assert.equal(runAutomationCalled, 0)
  assert.deepEqual(firstTick.problems, [])

  const secondTick = await engine.tick()
  assert.equal(secondTick.fired.length, 0)
  assert.equal(runAutomationCalled, 0)

  const runs = await store.listRuns('repo-event-watch')
  assert.equal(runs.ok, true)
  assert.equal(runs.ok && runs.values.length, 1)
  assert.equal(runs.ok && runs.values[0]?.status, 'blocked')
  assert.match(runs.ok ? runs.values[0]?.blockedReason ?? '' : '', /no github sync state/)
}

async function flushMicrotasks(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve()
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
