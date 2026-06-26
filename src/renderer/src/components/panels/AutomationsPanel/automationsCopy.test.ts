import assert from 'node:assert/strict'

import {
  actionLabel,
  cadenceSummary,
  engineHealth,
  isEngineUnreachable,
  mergeFeedRuns,
  runDuration,
  triggerFamilyLabel,
  type AutomationFeedRun,
} from './automationsFormat'
import type { AutomationDefinition, AutomationRun } from '../../../../../shared/automations/contracts'

let failures = 0
function run(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

// Build just the trigger shape cadenceSummary reads, without a full definition.
function trigger(kind: string, config: unknown = {}): AutomationDefinition['trigger'] {
  return { kind, config }
}

// --- Action labels (T2 AC#1) -----------------------------------------------

run('maps every known action kind to a sentence-case label', () => {
  assert.equal(actionLabel('spawn-agent'), 'Spawn an agent')
  assert.equal(actionLabel('run-skill-loop'), 'Run a skill loop')
  assert.equal(actionLabel('watchtower-review'), 'Run a code review')
  assert.equal(actionLabel('sprint-engine-run'), 'Run a Sprint Engine pass')
  assert.equal(actionLabel('switchboard-runner-tick'), 'Advance the Switchboard queue')
})

run('falls back to the raw kind for an unknown third-party action', () => {
  assert.equal(actionLabel('vendor-x-custom-action'), 'vendor-x-custom-action')
})

// --- Non-schedule trigger summaries (T2 AC#4) ------------------------------

run('summarizes repo-event and webhook triggers as human strings, not the raw kind', () => {
  assert.equal(cadenceSummary(trigger('repo-event')), 'On GitHub/Jira event')
  assert.equal(cadenceSummary(trigger('webhook')), 'On webhook')
})

run('falls back to the raw kind for an unknown non-schedule trigger family', () => {
  assert.equal(cadenceSummary(trigger('vendor-x-trigger')), 'vendor-x-trigger')
})

// A schedule trigger whose config is missing/non-schedule must not be mistaken
// for a named family; it falls through to the raw-kind path.
run('does not apply a family summary to a schedule kind with a non-schedule config', () => {
  assert.equal(cadenceSummary(trigger('schedule', null)), 'schedule')
})

// --- Trigger family prefix (T3 AC#4) ---------------------------------------

run('labels the trigger family for the list supporting line', () => {
  assert.equal(triggerFamilyLabel(trigger('schedule', { kind: 'schedule' })), 'Schedule')
  assert.equal(triggerFamilyLabel(trigger('repo-event')), 'Event')
  assert.equal(triggerFamilyLabel(trigger('webhook')), 'Webhook')
})

run('falls back to the raw kind for an unknown trigger family', () => {
  assert.equal(triggerFamilyLabel(trigger('vendor-x-trigger')), 'vendor-x-trigger')
})

// --- Schedule cadences still summarize correctly (no regression) -----------

run('still renders schedule cadences for the four cadence types', () => {
  const schedule = (cadence: unknown): AutomationDefinition['trigger'] =>
    trigger('schedule', { kind: 'schedule', timezone: 'UTC', cadence })
  assert.equal(cadenceSummary(schedule({ type: 'interval', everyMinutes: 30 })), 'Every 30 min')
  assert.equal(cadenceSummary(schedule({ type: 'interval', everyMinutes: 120 })), 'Every 2h')
  assert.equal(cadenceSummary(schedule({ type: 'daily', timeLocal: '09:00' })), 'Daily at 09:00')
  assert.equal(cadenceSummary(schedule({ type: 'weekly', timeLocal: '08:30', daysOfWeek: [1, 3] })), 'Weekly · Mon, Wed at 08:30')
  assert.equal(cadenceSummary(schedule({ type: 'cron', expression: '0 9 * * 1' })), 'Cron · 0 9 * * 1')
})

// --- Operational overview (T6): engine health + runs feed -------------------

run('maps engine state to a glyph-led health label, surfacing the sidecar error', () => {
  assert.equal(engineHealth({ state: 'running' }).label, 'Scheduler active')
  assert.equal(engineHealth({ state: 'running' }).tone, 'default')
  const failed = engineHealth({ state: 'failed', error: 'webhook-receiver bind failed' })
  assert.equal(failed.label, 'Scheduler error')
  assert.equal(failed.detail, 'webhook-receiver bind failed')
  assert.equal(failed.tone, 'error')
  assert.equal(engineHealth({ state: 'unavailable' }).tone, 'warn')
  assert.equal(engineHealth(null).label, 'Scheduler status unknown')
})

run('treats only known not-running states as unreachable (null is unknown, not unreachable)', () => {
  assert.equal(isEngineUnreachable({ state: 'running' }), false)
  assert.equal(isEngineUnreachable({ state: 'starting' }), false)
  assert.equal(isEngineUnreachable(null), false)
  assert.equal(isEngineUnreachable({ state: 'unavailable' }), true)
  assert.equal(isEngineUnreachable({ state: 'failed' }), true)
  assert.equal(isEngineUnreachable({ state: 'stopped' }), true)
})

run('formats run duration from started→completed, null while running or unstarted', () => {
  const make = (over: Partial<AutomationRun>): AutomationRun => ({
    id: 'r', automationId: 'a', status: 'completed', dueAt: '2026-01-01T00:00:00Z',
    startedAt: null, completedAt: null, ...over,
  })
  assert.equal(runDuration(make({ startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:45Z' })), '45s')
  assert.equal(runDuration(make({ startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:02:05Z' })), '2m 5s')
  assert.equal(runDuration(make({ startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T01:30:00Z' })), '1h 30m')
  assert.equal(runDuration(make({ startedAt: '2026-01-01T00:00:00Z', completedAt: null })), null)
  assert.equal(runDuration(make({ startedAt: null, completedAt: null })), null)
})

run('merges feed runs newest-first and caps to the limit', () => {
  const feedRun = (id: string, dueAt: string, defId: string): AutomationFeedRun => ({
    run: { id, automationId: defId, status: 'completed', dueAt, startedAt: null, completedAt: null },
    definitionId: defId, definitionName: `Def ${defId}`, triggerKind: 'schedule',
  })
  const merged = mergeFeedRuns([
    [feedRun('a', '2026-01-01T00:00:00Z', 'd1'), feedRun('b', '2026-01-03T00:00:00Z', 'd1')],
    [feedRun('c', '2026-01-02T00:00:00Z', 'd2')],
  ])
  assert.deepEqual(merged.map((m) => m.run.id), ['b', 'c', 'a'], 'sorted by dueAt descending across definitions')
  const many = Array.from({ length: 70 }, (_, i) => feedRun(`r${i}`, `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`, 'd1'))
  assert.equal(mergeFeedRuns([many]).length, 50, 'capped to the 50-run window')
})

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`)
  process.exit(1)
}
console.log('\nall automation copy tests passed')
