import assert from 'node:assert/strict'

import { actionLabel, cadenceSummary } from './automationsFormat'
import type { AutomationDefinition } from '../../../../../shared/automations/contracts'

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

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`)
  process.exit(1)
}
console.log('\nall automation copy tests passed')
