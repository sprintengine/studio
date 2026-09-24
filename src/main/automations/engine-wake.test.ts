import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { AutomationsEngineEvaluationResult } from './engine'
import { AutomationsEngine, nextAutomationsWakeDelayMs } from './engine'
import { AutomationsStore } from './store'

const MINUTE = 60_000
const NOW = Date.parse('2026-06-17T09:00:00.000Z')

function result(overrides: Partial<AutomationsEngineEvaluationResult> = {}): AutomationsEngineEvaluationResult {
  return { scheduled: [], fired: [], skipped: [], droppedInFlight: [], problems: [], ...overrides }
}

function scheduledAt(offsetMs: number) {
  return { workspaceRoot: '/Users/dev/app', automationId: 'nightly', nextRunAt: new Date(NOW + offsetMs).toISOString() }
}

const base = {
  now: NOW,
  polledTriggers: false,
  pendingRunDeadlines: [] as number[],
  pollIntervalMs: MINUTE,
  maxSleepMs: 15 * MINUTE,
}

test('with nothing to do the scheduler sleeps for the cap, not a minute', () => {
  assert.equal(nextAutomationsWakeDelayMs({ ...base, result: result() }), 15 * MINUTE)
})

test('it wakes for the soonest scheduled run', () => {
  const delay = nextAutomationsWakeDelayMs({
    ...base,
    result: result({ scheduled: [scheduledAt(9 * MINUTE), scheduledAt(3 * MINUTE + 250)] }),
  })
  assert.equal(delay, 3 * MINUTE + 250, 'on time, rather than up to a minute late')
})

test('a pending run wakes it for its max-duration deadline', () => {
  const delay = nextAutomationsWakeDelayMs({
    ...base,
    result: result({ scheduled: [scheduledAt(10 * MINUTE)] }),
    pendingRunDeadlines: [NOW + 2 * MINUTE],
  })
  assert.equal(delay, 2 * MINUTE)
})

test('work with no due time keeps the poll cadence', () => {
  assert.equal(nextAutomationsWakeDelayMs({ ...base, result: result(), polledTriggers: true }), MINUTE)
  assert.equal(
    nextAutomationsWakeDelayMs({
      ...base,
      result: result({ droppedInFlight: [{ workspaceRoot: '/Users/dev/app', automationId: 'nightly' }] }),
    }),
    MINUTE,
    'a run skipped because the last one was still going is retried on the cadence',
  )
  assert.equal(nextAutomationsWakeDelayMs({ ...base, result: null }), MINUTE, 'a failed evaluation retries')
  assert.equal(
    nextAutomationsWakeDelayMs({
      ...base,
      result: result({ problems: [{ code: 'workspace_snapshot_failed', message: 'no snapshot' }] }),
    }),
    MINUTE,
  )
  assert.equal(
    nextAutomationsWakeDelayMs({
      ...base,
      result: result({
        problems: [{ workspaceRoot: '/Users/dev/app', automationId: 'x', code: 'invalid_schedule', message: 'bad' }],
      }),
    }),
    15 * MINUTE,
    'a definition that is simply broken stays broken; re-reading it every minute changes nothing',
  )
})

test('a due time already past never becomes a tight loop', () => {
  assert.equal(nextAutomationsWakeDelayMs({ ...base, result: result({ scheduled: [scheduledAt(-5_000)] }) }), MINUTE)
  assert.equal(nextAutomationsWakeDelayMs({ ...base, result: result({ scheduled: [scheduledAt(10)] }) }), 1_000)
})

test('the engine arms one timer from each evaluation, and wake re-evaluates at once', async () => {
  const armed: number[] = []
  let pending: (() => void) | null = null
  const store = {
    listDefinitions: async () => ({ ok: true, values: [] }),
    readState: async () => ({ ok: true, value: null }),
  } as unknown as AutomationsStore
  let evaluations = 0
  const engine = new AutomationsEngine({
    getProjectFolders: () => {
      evaluations += 1
      return [{ workspaceId: 'ws-a', folderPath: '/Users/dev/app' }]
    },
    createStore: () => store,
    now: () => NOW,
    runAutomation: async () => ({ status: 'completed' }),
    timers: {
      setTimeout: (handler, ms) => {
        armed.push(ms)
        pending = handler
        return armed.length
      },
      clearTimeout: () => {
        pending = null
      },
    },
  })

  const settle = async () => {
    for (let index = 0; index < 50; index += 1) await Promise.resolve()
  }

  engine.start()
  await settle()
  assert.equal(evaluations, 1, 'the startup evaluation')
  assert.deepEqual(armed, [15 * 60_000], 'no automations: one wake per quarter hour')

  // The timer firing evaluates and re-arms.
  const fire = pending as (() => void) | null
  assert.ok(fire)
  fire()
  await settle()
  assert.equal(evaluations, 2)
  assert.equal(armed.length, 2)

  // A definition write (or a wake from sleep) does not wait for the timer.
  engine.wake()
  await settle()
  assert.equal(evaluations, 3)
  assert.equal(armed.length, 3)

  engine.stop()
  assert.equal(pending, null, 'stop clears the armed timer')
  engine.wake()
  await settle()
  assert.equal(evaluations, 3, 'a stopped engine does not wake')
})

async function manualRunEngine(maxAgentRunMs: number) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-automations-wake-'))
  const store = new AutomationsStore(workspaceRoot)
  const created = await store.createDefinition({
    id: 'review',
    name: 'Review',
    status: 'enabled',
    trigger: {
      kind: 'schedule',
      config: { kind: 'schedule', timezone: 'UTC', cadence: { type: 'interval', everyMinutes: 60 * 24 } },
    },
    action: { kind: 'spawn-agent', config: { prompt: 'Review the repository.' } },
    // Far enough out that the quarter-hour cap is what the startup evaluation arms.
    nextRunAt: new Date(NOW + 24 * 60 * MINUTE).toISOString(),
    lastRunAt: null,
    lastRunId: null,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  })
  assert.equal(created.ok, true)
  const armed: number[] = []
  let cleared = 0
  const engine = new AutomationsEngine({
    getProjectFolders: () => [{ workspaceId: 'ws-a', folderPath: workspaceRoot }],
    now: () => NOW,
    maxAgentRunMs,
    runAutomation: async () => ({ status: 'running', workspaceId: 'ws-a', agentId: 'agent-1' }),
    timers: {
      setTimeout: (_handler, ms) => {
        armed.push(ms)
        return armed.length
      },
      clearTimeout: () => {
        cleared += 1
      },
    },
  })
  engine.start()
  await engine.handleStartup()
  for (let index = 0; index < 50; index += 1) await Promise.resolve()
  return { engine, workspaceRoot, armed, cleared: () => cleared }
}

test('a manual run pulls the wake in to its max-duration deadline', async () => {
  const { engine, workspaceRoot, armed, cleared } = await manualRunEngine(5 * MINUTE)
  assert.deepEqual(armed, [15 * MINUTE], 'startup arms the quarter-hour cap')

  const ran = await engine.runNow({ workspaceRoot, automationId: 'review', workspaceId: 'ws-a' })
  assert.equal(ran.ok, true)
  // Before, the pending run's deadline was only seen at the next wake, up to
  // fifteen minutes past the limit.
  assert.deepEqual(armed, [15 * MINUTE, 5 * MINUTE], 'the deadline re-arms the timer')
  assert.equal(cleared(), 1, 'the later timer is replaced, not doubled')
  engine.stop()
})

test('a manual run whose deadline is past the armed wake leaves the timer alone', async () => {
  const { engine, workspaceRoot, armed, cleared } = await manualRunEngine(6 * 60 * MINUTE)
  const ran = await engine.runNow({ workspaceRoot, automationId: 'review', workspaceId: 'ws-a' })
  assert.equal(ran.ok, true)
  assert.deepEqual(armed, [15 * MINUTE])
  assert.equal(cleared(), 0)
  engine.stop()
})
