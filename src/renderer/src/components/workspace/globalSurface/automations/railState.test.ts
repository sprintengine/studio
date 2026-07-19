import assert from 'node:assert/strict'

import type {
  AutomationDefinition,
  AutomationRun,
  AutomationStatus,
  AutomationsInstanceEntry,
} from '../../../../../../shared/automations/contracts'
import { SCHEDULER_OFF_NOTICE, automationRailState, enumerationProblemsNotice, projectLabel } from './railState'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const NOW = Date.parse('2026-07-19T12:00:00Z')

function def(status: AutomationStatus): AutomationDefinition {
  return { id: 'a', name: 'Nightly review', status } as unknown as AutomationDefinition
}

function lastRun(status: AutomationRun['status'], completedAt: string | null): AutomationRun {
  return { id: 'r', automationId: 'a', status, dueAt: completedAt ?? '2026-07-19T00:00:00Z', startedAt: completedAt, completedAt } as unknown as AutomationRun
}

function entry(over: Partial<AutomationsInstanceEntry> & { definition: AutomationDefinition }): AutomationsInstanceEntry {
  return {
    workspaceRoot: '/proj/app',
    workspaceId: 'ws-1',
    lastRun: null,
    isRunningNow: false,
    ...over,
  }
}

// The plain-language rail state line + tone (mockup §3), by salience.

run('a live run leads over everything else', () => {
  const state = automationRailState(entry({ definition: def('enabled'), isRunningNow: true, lastRun: lastRun('running', null) }), NOW)
  assert.deepEqual(state, { text: 'Running now', tone: 'accent', running: true })
})

run('an unresolved failure surfaces even on a paused automation', () => {
  const state = automationRailState(entry({ definition: def('paused'), lastRun: lastRun('failed', '2026-07-19T10:00:00Z') }), NOW)
  assert.equal(state.text, 'Last run failed')
  assert.equal(state.tone, 'warn')
  assert.equal(state.running, false)
})

run('a blocked last run reads as blocked, warn tone', () => {
  const state = automationRailState(entry({ definition: def('enabled'), lastRun: lastRun('blocked', null) }), NOW)
  assert.equal(state.text, 'Last run blocked')
  assert.equal(state.tone, 'warn')
})

run('a paused automation with no failure reads Paused, neutral tone', () => {
  const state = automationRailState(entry({ definition: def('paused'), lastRun: lastRun('completed', '2026-07-19T10:00:00Z') }), NOW)
  assert.deepEqual(state, { text: 'Paused', tone: 'neutral', running: false })
})

run('a blocked definition reads Blocked, warn tone', () => {
  const state = automationRailState(entry({ definition: def('blocked'), lastRun: null }), NOW)
  assert.deepEqual(state, { text: 'Blocked', tone: 'warn', running: false })
})

run('a passing last run reads "Ran <ago> · passed", good tone', () => {
  const state = automationRailState(entry({ definition: def('enabled'), lastRun: lastRun('completed', '2026-07-19T10:00:00Z') }), NOW)
  // Uses the real relative formatter ("2 hours ago"), not the mockup's stylized "2h".
  assert.equal(state.text, 'Ran 2 hours ago · passed')
  assert.equal(state.tone, 'good')
  assert.equal(state.running, false)
})

run('never-run reads "Never run", neutral tone', () => {
  const state = automationRailState(entry({ definition: def('enabled'), lastRun: null }), NOW)
  assert.deepEqual(state, { text: 'Never run', tone: 'neutral', running: false })
})

run('a skipped last run reads "Last run skipped", neutral tone', () => {
  const state = automationRailState(entry({ definition: def('enabled'), lastRun: lastRun('skipped', null) }), NOW)
  assert.deepEqual(state, { text: 'Last run skipped', tone: 'neutral', running: false })
})

// projectLabel: the folder basename naming which project an automation belongs to.
run('projectLabel is the folder basename, separator/trailing-slash tolerant', () => {
  assert.equal(projectLabel('/work/projects/checkout-service'), 'checkout-service')
  assert.equal(projectLabel('/work/projects/checkout-service/'), 'checkout-service')
  assert.equal(projectLabel('C:\\work\\billing'), 'billing')
  assert.equal(projectLabel('solo'), 'solo')
})

// Degraded-state copy is plain-language and never a raw error (quality-audit rule).
run('the scheduler-off notice is plain language with no raw error / code', () => {
  assert.ok(SCHEDULER_OFF_NOTICE.includes('scheduler is not running'))
  assert.ok(SCHEDULER_OFF_NOTICE.includes('run now still execute'), 'reassures that manual runs still work')
  assert.ok(!/Error|null|undefined|ECONN|\bcode\b/.test(SCHEDULER_OFF_NOTICE), 'no raw error text')
})

run('the enumeration-failure notice pluralizes and never masks the readable rest', () => {
  assert.equal(enumerationProblemsNotice(1), 'One project’s automations could not be read and are not listed. The rest are shown.')
  assert.equal(enumerationProblemsNotice(3), '3 projects’ automations could not be read and are not listed. The rest are shown.')
  assert.ok(enumerationProblemsNotice(2).includes('The rest are shown'), 'a bad store never masks the readable ones')
})

console.log('all automations rail-state tests passed')
