import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AutomationDefinition, AutomationRun } from '../../../shared/automations/contracts'
import {
  automationRecentRunsMax,
  automationRunTextMaxChars,
  automationsPerProjectMax,
  validateMobileControlSnapshot,
  mobileControlProtocolVersion,
} from '../../../shared/mobile-control/protocol'
import { AutomationsStore } from '../../automations/store'
import { readMobileAutomationSnapshots } from './automations'
import { deriveWorkspaceId } from './workspace-id'

const generatedAt = '2026-07-14T12:00:00.000Z'

function definitionOf(overrides: Partial<AutomationDefinition> & Pick<AutomationDefinition, 'id'>): AutomationDefinition {
  return {
    name: `Automation ${overrides.id}`,
    status: 'enabled',
    trigger: { kind: 'schedule', config: { kind: 'schedule', cadence: { type: 'interval', everyMinutes: 30 }, timezone: 'UTC' } },
    action: { kind: 'agent-run', config: { prompt: 'do the thing' } },
    autonomyDefault: 'review_only',
    nextRunAt: null,
    lastRunAt: null,
    lastRunId: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

function runOf(overrides: Partial<AutomationRun> & Pick<AutomationRun, 'id' | 'automationId'>): AutomationRun {
  return {
    status: 'completed',
    dueAt: '2026-07-13T09:00:00.000Z',
    startedAt: '2026-07-13T09:00:01.000Z',
    completedAt: '2026-07-13T09:04:00.000Z',
    ...overrides,
  }
}

async function withWorkspace(
  seed: (store: AutomationsStore) => Promise<void>,
  assertions: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'multicode-mobile-automations-'))
  try {
    await seed(new AutomationsStore(root))
    await assertions(root)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
}

const tests: Array<{ name: string; body: () => Promise<void> }> = []
function run(name: string, body: () => Promise<void>): void {
  tests.push({ name, body })
}

run('projects the monitor view: grouped by projectKey, cadence pre-rendered, no provider config on the wire', async () => {
  await withWorkspace(
    async (store) => {
      await store.createDefinition(
        definitionOf({
          id: 'nightly-sweep',
          name: 'Nightly sweep',
          status: 'paused',
          lastRunAt: '2026-07-13T09:04:00.000Z',
          lastRunId: 'run-2',
        }),
      )
      await store.recordRun(runOf({ id: 'run-1', automationId: 'nightly-sweep', dueAt: '2026-07-12T09:00:00.000Z', startedAt: '2026-07-12T09:00:01.000Z', completedAt: '2026-07-12T09:03:00.000Z' }))
      await store.recordRun(runOf({ id: 'run-2', automationId: 'nightly-sweep' }))
    },
    async (root) => {
      const automations = await readMobileAutomationSnapshots(root, generatedAt)
      assert.equal(automations.length, 1)
      const automation = automations[0]

      assert.equal(automation.automationId, 'nightly-sweep')
      assert.equal(automation.name, 'Nightly sweep')
      // Three states, never flattened to a boolean.
      assert.equal(automation.status, 'paused')
      assert.equal(automation.triggerKind, 'schedule')
      assert.equal(automation.projectKey, deriveWorkspaceId(root))
      // Rendered on the desktop: the phone never sees the cadence union.
      assert.equal(automation.cadence, 'Every 30 min')
      assert.equal(automation.lastRunStatus, 'completed')

      // Newest first.
      assert.deepEqual(automation.recentRuns?.map((entry) => entry.runId), ['run-2', 'run-1'])

      // Nothing about the action, prompt, worktree or connector rides the wire.
      const serialized = JSON.stringify(automation)
      assert.equal(serialized.includes('do the thing'), false)
      assert.equal(serialized.includes('agent-run'), false)
    },
  )
})

run('a long-running run is age-qualifiable: startedAt rides the wire, a null completedAt is omitted not nulled', async () => {
  // The real shape in this repo today: permission-blocked runs have no finalize
  // channel and sit `running` with completedAt: null for hours. The phone can only
  // separate that from healthy progress by elapsed time, so startedAt must survive.
  await withWorkspace(
    async (store) => {
      await store.createDefinition(definitionOf({ id: 'stuck', lastRunId: 'run-stuck', lastRunAt: '2026-07-14T03:00:00.000Z' }))
      await store.recordRun(
        runOf({
          id: 'run-stuck',
          automationId: 'stuck',
          status: 'running',
          dueAt: '2026-07-14T03:00:00.000Z',
          startedAt: '2026-07-14T03:00:02.000Z',
          completedAt: null,
        }),
      )
    },
    async (root) => {
      const [automation] = await readMobileAutomationSnapshots(root, generatedAt)
      const [latest] = automation.recentRuns ?? []

      assert.equal(automation.lastRunStatus, 'running')
      assert.equal(latest.status, 'running')
      assert.equal(latest.startedAt, '2026-07-14T03:00:02.000Z')
      // Not `completedAt: null` — the snapshot validator rejects an explicit null and
      // would take the WHOLE snapshot down with it.
      assert.equal('completedAt' in latest, false)

      const validation = validateMobileControlSnapshot({
        protocolVersion: mobileControlProtocolVersion,
        generatedAt,
        desktopSessionId: 'desktop-1',
        sprintEngines: [],
        automations: [automation],
      })
      assert.equal(validation.ok, true)
    },
  )
})

run('capped by construction: 24 automations per project, 5 newest runs, 160-char run text', async () => {
  const overCap = automationsPerProjectMax + 6
  const overRuns = automationRecentRunsMax + 4

  await withWorkspace(
    async (store) => {
      for (let index = 0; index < overCap; index += 1) {
        // Ascending updatedAt: the newest `automationsPerProjectMax` survive the cap.
        const day = String(index + 1).padStart(2, '0')
        await store.createDefinition(definitionOf({ id: `a-${String(index).padStart(2, '0')}`, updatedAt: `2026-06-${day}T00:00:00.000Z` }))
      }
      for (let index = 0; index < overRuns; index += 1) {
        const minute = String(index).padStart(2, '0')
        await store.recordRun(
          runOf({
            id: `run-${minute}`,
            automationId: `a-${String(overCap - 1).padStart(2, '0')}`,
            status: 'blocked',
            dueAt: `2026-07-13T10:${minute}:00.000Z`,
            startedAt: `2026-07-13T10:${minute}:01.000Z`,
            completedAt: `2026-07-13T10:${minute}:30.000Z`,
            blockedReason: 'b'.repeat(400),
            summary: `${'s'.repeat(400)}`,
          }),
        )
      }
    },
    async (root) => {
      const automations = await readMobileAutomationSnapshots(root, generatedAt)
      assert.equal(automations.length, automationsPerProjectMax)
      // The most recently changed survive; the oldest are the ones dropped.
      assert.equal(automations.some((automation) => automation.automationId === `a-${String(overCap - 1).padStart(2, '0')}`), true)
      assert.equal(automations.some((automation) => automation.automationId === 'a-00'), false)

      const withRuns = automations.find((automation) => automation.automationId === `a-${String(overCap - 1).padStart(2, '0')}`)
      assert.equal(withRuns?.recentRuns?.length, automationRecentRunsMax)
      // Newest first, so the cap keeps the newest runs rather than the first written.
      assert.equal(withRuns?.recentRuns?.[0]?.runId, `run-0${overRuns - 1}`)

      const run = withRuns?.recentRuns?.[0]
      assert.equal(run?.summary?.length, automationRunTextMaxChars)
      assert.equal(run?.summary?.endsWith('…'), true)
      assert.equal(run?.blockedReason?.length, automationRunTextMaxChars)
    },
  )
})

run('cadence: wall-clock cadences carry their zone; a cadence the engine rejects is omitted, not guessed', async () => {
  await withWorkspace(
    async (store) => {
      await store.createDefinition(
        definitionOf({
          id: 'daily',
          trigger: { kind: 'schedule', config: { kind: 'schedule', cadence: { type: 'daily', timeLocal: '09:00' }, timezone: 'Asia/Kolkata' } },
        }),
      )
      await store.createDefinition(
        definitionOf({
          id: 'cronish',
          // Declared in the contract but unimplemented: validateScheduleTriggerConfig
          // has no cron branch, so the engine can never schedule this.
          trigger: { kind: 'schedule', config: { kind: 'schedule', cadence: { type: 'cron', expression: '0 9 * * 1' }, timezone: 'UTC' } },
        }),
      )
      await store.createDefinition(
        definitionOf({ id: 'hooked', status: 'blocked', trigger: { kind: 'webhook', config: { kind: 'webhook', path: '/deploy' } } }),
      )
    },
    async (root) => {
      const automations = await readMobileAutomationSnapshots(root, generatedAt)
      const byId = new Map(automations.map((automation) => [automation.automationId, automation]))

      // The zone is what makes a wall-clock cadence readable to a phone that does not
      // share the desktop's clock.
      assert.equal(byId.get('daily')?.cadence, 'Daily at 09:00 GMT+5:30')
      assert.equal(byId.get('cronish')?.cadence, undefined)
      // A webhook fires on an event: no cadence, and the kind stays readable.
      assert.equal(byId.get('hooked')?.cadence, undefined)
      assert.equal(byId.get('hooked')?.triggerKind, 'webhook')
      assert.equal(byId.get('hooked')?.status, 'blocked')
      assert.equal(JSON.stringify(automations).includes('/deploy'), false)
    },
  )
})

run('nextRunAt resolves the way the engine resolves it: definition first, then store state', async () => {
  await withWorkspace(
    async (store) => {
      await store.createDefinition(definitionOf({ id: 'on-definition', nextRunAt: '2026-07-15T09:00:00.000Z' }))
      await store.createDefinition(definitionOf({ id: 'on-state' }))
      await store.createDefinition(definitionOf({ id: 'never', nextRunAt: null }))
      await store.writeState({
        nextRunAtByAutomationId: { 'on-state': '2026-07-16T09:00:00.000Z', never: null },
        lock: null,
      })
    },
    async (root) => {
      const byId = new Map((await readMobileAutomationSnapshots(root, generatedAt)).map((entry) => [entry.automationId, entry]))

      assert.equal(byId.get('on-definition')?.nextRunAt, '2026-07-15T09:00:00.000Z')
      // Without the state fallback the phone would show "no upcoming run" for an
      // automation the engine has already scheduled.
      assert.equal(byId.get('on-state')?.nextRunAt, '2026-07-16T09:00:00.000Z')
      assert.equal('nextRunAt' in (byId.get('never') ?? {}), false)
    },
  )
})

// The run-now gate (item 47). `engine.runNow` rejects a second run with `in_flight`,
// so the phone must be able to see that a run is already going and not draw a button
// guaranteed to fail. This is why in-flight is a FIELD and not something the phone
// infers from `recentRuns`: recentRuns is the first automations field the shedding
// ladder drops, and its absence is ambiguous anyway (the producer also omits it for
// an automation that has never run — exactly the case where run-now IS allowed).
run('carries runInFlight so the phone can gate run-now on what the engine will accept', async () => {
  await withWorkspace(
    async (store) => {
      await store.createDefinition(definitionOf({ id: 'running-now' }))
      await store.recordRun(runOf({ id: 'run-live', automationId: 'running-now', status: 'running', completedAt: null }))

      await store.createDefinition(definitionOf({ id: 'queued-now' }))
      await store.recordRun(runOf({ id: 'run-queued', automationId: 'queued-now', status: 'queued', startedAt: null, completedAt: null }))

      await store.createDefinition(definitionOf({ id: 'idle', lastRunId: 'run-done' }))
      await store.recordRun(runOf({ id: 'run-done', automationId: 'idle' }))

      await store.createDefinition(definitionOf({ id: 'never-run' }))
    },
    async (root) => {
      const byId = new Map((await readMobileAutomationSnapshots(root, generatedAt)).map((entry) => [entry.automationId, entry]))

      assert.equal(byId.get('running-now')?.runInFlight, true)
      assert.equal(byId.get('queued-now')?.runInFlight, true)
      // Omitted rather than false when nothing is in flight: this is the state in
      // which the phone MAY offer run-now, and it must be distinguishable from the
      // never-run automation below, which is equally runnable.
      assert.equal('runInFlight' in (byId.get('idle') ?? {}), false)
      assert.equal('runInFlight' in (byId.get('never-run') ?? {}), false)
      // The finished run is still reported — runInFlight is about the run, not about
      // whether history exists.
      assert.equal(byId.get('idle')?.lastRunStatus, 'completed')
    },
  )
})

run('resolves runInFlight against every run, not just the ones that ride the wire', async () => {
  // The cap keeps only the newest `automationRecentRunsMax` runs on the wire. If the
  // flag were derived from that slice, an in-flight run pushed out of the window by
  // newer records would read as idle and the phone would offer a doomed run-now.
  await withWorkspace(
    async (store) => {
      await store.createDefinition(definitionOf({ id: 'busy' }))
      await store.recordRun(runOf({
        id: 'run-old-but-live',
        automationId: 'busy',
        status: 'running',
        dueAt: '2026-07-01T09:00:00.000Z',
        startedAt: '2026-07-01T09:00:01.000Z',
        completedAt: null,
      }))
      for (let index = 0; index < automationRecentRunsMax + 2; index += 1) {
        await store.recordRun(runOf({
          id: `run-newer-${index}`,
          automationId: 'busy',
          dueAt: `2026-07-1${index % 3 + 1}T09:00:00.000Z`,
          completedAt: `2026-07-1${index % 3 + 1}T09:04:00.000Z`,
        }))
      }
    },
    async (root) => {
      const [automation] = await readMobileAutomationSnapshots(root, generatedAt)
      assert.equal(automation?.recentRuns?.length, automationRecentRunsMax)
      assert.equal(
        automation?.recentRuns?.some((entry) => entry.runId === 'run-old-but-live'),
        false,
        'fixture must push the live run out of the capped window, or this proves nothing',
      )
      assert.equal(automation?.runInFlight, true)
    },
  )
})

run('a workspace with no automations store contributes nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multicode-mobile-automations-empty-'))
  try {
    assert.deepEqual(await readMobileAutomationSnapshots(root, generatedAt), [])
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

async function main(): Promise<void> {
  for (const test of tests) {
    try {
      await test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      console.error(`not ok - ${test.name}`)
      throw error
    }
  }
  console.log('mobile/sprintengine/automations.test.ts: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
