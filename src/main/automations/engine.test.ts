import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AutomationDefinition, ScheduleTriggerConfig } from '../../shared/automations/contracts'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import { AutomationsEngine, projectFoldersFromWorkspaceSyncSnapshot } from './engine'
import { AutomationsStore } from './store'
import { computeNextRun, validateScheduleTriggerConfig } from './schedule'

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})

async function main(): Promise<void> {
  assertIntervalDailyWeeklyNextRuns()
  assertDstRules()
  assertInvalidIntervalIsRejected()
  assertWorkspaceSnapshotFolderExtraction()
  await assertDueAutomationFiresOnceWithDuplicateGuard()
  await assertStartupOverdueIsSkippedWithoutCatchup()
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

async function assertDueAutomationFiresOnceWithDuplicateGuard(): Promise<void> {
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
  assert.deepEqual(duplicateTick.droppedInFlight, [{ workspaceRoot, automationId: 'nightly-review' }])
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
