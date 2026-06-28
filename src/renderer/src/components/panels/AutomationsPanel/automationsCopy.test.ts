import assert from 'node:assert/strict'

import {
  actionLabel,
  aggregateFeedRuns,
  cadenceSummary,
  engineHealth,
  isEngineUnreachable,
  mergeFeedRuns,
  runDuration,
  triggerDetail,
  triggerFamilyLabel,
  type AutomationFeedRun,
} from './automationsFormat'
import type {
  AutomationDefinition,
  AutomationRun,
  AutomationsRunsListResult,
} from '../../../../../shared/automations/contracts'

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

async function runAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
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
  assert.equal(actionLabel('sprint-engine-run'), 'Run a sprint')
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

// --- List supporting-line detail (T11 F2): no family double-say ------------
// triggerDetail is the family-prefix-aware detail; it must not restate the
// family word ('Event · On GitHub/Jira event' / 'Webhook · On webhook').

run('schedule rows keep their cadence summary as the detail', () => {
  const schedule = (cadence: unknown): AutomationDefinition['trigger'] =>
    trigger('schedule', { kind: 'schedule', timezone: 'UTC', cadence })
  assert.equal(triggerDetail(schedule({ type: 'interval', everyMinutes: 120 })), 'Every 2h')
  assert.equal(triggerDetail(schedule({ type: 'daily', timeLocal: '09:00' })), 'Daily at 09:00')
})

run('repo-event detail is config-specific (provider + events), not the family word', () => {
  assert.equal(triggerDetail(trigger('repo-event', { kind: 'repo-event', provider: 'github', eventTypes: ['created'] })), 'GitHub created')
  assert.equal(triggerDetail(trigger('repo-event', { kind: 'repo-event', provider: 'jira', eventTypes: ['created', 'updated'] })), 'Jira created, updated')
  // Provider with no event filter reads as the source alone, never 'On GitHub/Jira event'.
  assert.equal(triggerDetail(trigger('repo-event', { kind: 'repo-event', provider: 'any' })), 'Any source')
})

run('webhook detail is the delivery path, or null when none is set', () => {
  assert.equal(triggerDetail(trigger('webhook', { kind: 'webhook', path: 'deploy' })), '/deploy')
  assert.equal(triggerDetail(trigger('webhook', { kind: 'webhook', path: '/ci/build' })), '/ci/build')
  // No path → null so the row shows 'Webhook' alone, not a redundant summary.
  assert.equal(triggerDetail(trigger('webhook', { kind: 'webhook' })), null)
})

run('returns null detail for an unknown non-schedule family (family label stands alone)', () => {
  assert.equal(triggerDetail(trigger('vendor-x-trigger')), null)
  // A schedule kind with a non-schedule config has no cadence to summarize.
  assert.equal(triggerDetail(trigger('schedule', null)), null)
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

// --- Feed ordering matches the displayed stamp (T11 F4) --------------------
// Rows display completedAt ?? startedAt ?? dueAt; the merge must sort by the
// same expression so order matches the shown timestamp, not dueAt alone.

run('orders the feed by the displayed stamp (completedAt ?? startedAt ?? dueAt), not dueAt', () => {
  const make = (id: string, over: Partial<AutomationRun>): AutomationFeedRun => ({
    run: { id, automationId: 'd', status: 'completed', dueAt: '2026-01-01T00:00:00Z', startedAt: null, completedAt: null, ...over },
    definitionId: 'd', definitionName: 'Def d', triggerKind: 'schedule',
  })
  // Same dueAt for all; completion time decides order (newer completion first).
  const byCompletion = mergeFeedRuns([[
    make('older-completion', { completedAt: '2026-01-02T00:00:00Z' }),
    make('newer-completion', { completedAt: '2026-01-05T00:00:00Z' }),
  ]])
  assert.deepEqual(byCompletion.map((m) => m.run.id), ['newer-completion', 'older-completion'])
  // A running row (startedAt, no completedAt) orders by startedAt — above a
  // completed run whose later dueAt would have won under the old dueAt-only sort.
  const mixed = mergeFeedRuns([[
    make('completed-earlier', { dueAt: '2026-01-09T00:00:00Z', completedAt: '2026-01-03T00:00:00Z' }),
    make('running-later', { dueAt: '2026-01-01T00:00:00Z', startedAt: '2026-01-06T00:00:00Z', status: 'running' }),
  ]])
  assert.deepEqual(mixed.map((m) => m.run.id), ['running-later', 'completed-earlier'])
})

// --- Runs-feed fan-out timeout robustness (T11 I1) -------------------------
// A hung per-definition load must not strand the feed: aggregateFeedRuns settles
// each call against a timeout, skipping-and-counting the slow definition.

async function main(): Promise<void> {
  const def = (id: string): AutomationDefinition =>
    ({ id, name: `Def ${id}`, trigger: { kind: 'schedule', config: {} } } as unknown as AutomationDefinition)
  const runFor = (id: string): AutomationRun => ({
    id: `run-${id}`, automationId: id, status: 'completed',
    dueAt: '2026-01-01T00:00:00Z', startedAt: null, completedAt: null,
  })
  const okResult = (id: string): AutomationsRunsListResult => ({ ok: true, value: [runFor(id)] })

  await runAsync('settles a hung per-definition load: feed still reaches a result, slow definition counted partial', async () => {
    const loader = (d: AutomationDefinition): Promise<AutomationsRunsListResult> =>
      d.id === 'hung'
        ? new Promise<AutomationsRunsListResult>(() => {}) // never settles
        : Promise.resolve(okResult(d.id))
    const { runs, partialCount } = await aggregateFeedRuns([def('ok'), def('hung')], loader, 20)
    assert.equal(partialCount, 1, 'the hung definition is skipped and counted, not awaited forever')
    assert.deepEqual(runs.map((r) => r.run.id), ['run-ok'], 'the healthy definition still contributes its runs')
  })

  await runAsync('counts handled failures and thrown rejections as partial alongside the healthy load', async () => {
    const loader = (d: AutomationDefinition): Promise<AutomationsRunsListResult> => {
      if (d.id === 'fail') return Promise.resolve({ ok: false, code: 'eio', message: 'nope' })
      if (d.id === 'throw') return Promise.reject(new Error('boom'))
      return Promise.resolve(okResult(d.id))
    }
    const { runs, partialCount } = await aggregateFeedRuns([def('ok'), def('fail'), def('throw')], loader, 1000)
    assert.equal(partialCount, 2)
    assert.deepEqual(runs.map((r) => r.run.id), ['run-ok'])
  })

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`)
    process.exit(1)
  }
  console.log('\nall automation copy tests passed')
}

void main()
