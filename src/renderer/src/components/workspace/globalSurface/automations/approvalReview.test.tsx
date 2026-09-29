import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import type {
  AutomationApproval,
  AutomationDefinition,
  AutomationsInstanceEntry,
} from '../../../../../../shared/automations/contracts'
import { AutomationApprovalReview } from './AutomationApprovalReview'
import { approvalReviewFacts, waitingInProject } from './approvalReview'
import { test } from 'vitest'

function definition(over: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: 'shipped',
    name: 'Shipped review',
    status: 'enabled',
    trigger: {
      kind: 'schedule',
      config: { kind: 'schedule', timezone: 'UTC', cadence: { type: 'interval', everyMinutes: 10 } },
    },
    action: { kind: 'spawn-agent', config: { prompt: 'Review the repository.' } },
    nextRunAt: null,
    lastRunAt: null,
    lastRunId: null,
    createdAt: '2026-07-19T00:00:00Z',
    updatedAt: '2026-07-19T00:00:00Z',
    ...over,
  }
}

const WAITING: AutomationApproval = { state: 'needs-approval', fingerprint: 'sha256:a', reason: 'unreviewed' }

function entry(over: Partial<AutomationsInstanceEntry> = {}): AutomationsInstanceEntry {
  return {
    workspaceRoot: '/Users/dev/acme-app',
    workspaceId: 'ws-1',
    definition: definition(),
    lastRun: null,
    isRunningNow: false,
    approval: WAITING,
    ...over,
  }
}

function render(props: Partial<Parameters<typeof AutomationApprovalReview>[0]> = {}): string {
  return renderToStaticMarkup(
    <AutomationApprovalReview
      entry={entry()}
      waitingInProject={1}
      busy={false}
      cliLabel={(cli) => (cli === 'claude-code' ? 'Claude Code' : cli)}
      onAllow={() => undefined}
      onAllowAll={() => undefined}
      {...props}
    />,
  )
}

test('a file that names no preset is reviewed as the bypass it will run on', () => {
  const facts = approvalReviewFacts(definition())
  assert.equal(facts.permission, 'bypass')
  assert.equal(facts.permissionIsDefault, true)
  assert.equal(facts.runsInWorktree, true)
  assert.equal(facts.cli, null)
})

test('the review reads presets and isolation the way the run does', () => {
  const legacy = approvalReviewFacts(
    definition({
      action: { kind: 'spawn-agent', config: { prompt: 'x', permissionPreset: 'bypass_all', cli: 'codex' } },
      runInWorktree: false,
    }),
  )
  assert.equal(legacy.permission, 'bypass')
  assert.equal(legacy.permissionIsDefault, false)
  assert.equal(legacy.runsInWorktree, false)
  assert.equal(legacy.cli, 'codex')
  assert.equal(
    approvalReviewFacts(
      definition({ action: { kind: 'spawn-agent', config: { prompt: 'x', permissionPreset: 'auto' } } }),
    ).permission,
    'none',
  )
  assert.equal(
    approvalReviewFacts(
      definition({ action: { kind: 'spawn-agent', config: { prompt: 'x', permissionPreset: 'yolo' } } }),
    ).permission,
    null,
  )
})

test('an action this screen cannot describe is shown whole', () => {
  const facts = approvalReviewFacts(
    definition({ action: { kind: 'acme.deploy', config: { target: 'production', script: './ship.sh' } } }),
  )
  assert.equal(facts.agentBacked, false)
  assert.equal(facts.permission, null)
  assert.match(facts.rawConfig ?? '', /"script": "\.\/ship\.sh"/)
})

test('the card calls out bypass and a run in the checkout, and offers Allow', () => {
  const html = render({
    entry: entry({
      definition: definition({
        action: { kind: 'spawn-agent', config: { prompt: 'x', cli: 'claude-code' } },
        runInWorktree: false,
      }),
    }),
  })
  assert.match(html, /not made in this app on this machine/)
  assert.match(html, /Bypass/)
  assert.match(html, /Skips every approval prompt/)
  assert.match(html, /Your checkout/)
  assert.match(html, /Claude Code/)
  assert.match(html, />Allow</)
  assert.doesNotMatch(html, /Allow all/)
})

test('a changed automation says so, and Allow all appears only with company', () => {
  const html = render({ entry: entry({ approval: { ...WAITING, reason: 'changed' } }), waitingInProject: 3 })
  assert.match(html, /changed since you allowed it/)
  assert.match(html, /Allow all 3 in acme-app/)
})

test('an approved automation shows no review', () => {
  const html = render({
    entry: entry({
      approval: { state: 'approved', fingerprint: 'sha256:a', source: 'app', approvedAt: '2026-07-19T00:00:00Z' },
    }),
  })
  assert.equal(html, '')
})

test('Allow all counts only the waiting automations of the same project', () => {
  const entries = [
    entry(),
    entry({ definition: definition({ id: 'other' }) }),
    entry({
      definition: definition({ id: 'mine' }),
      approval: { ...WAITING, state: 'approved', source: 'app', approvedAt: '' } as AutomationApproval,
    }),
    entry({ workspaceRoot: '/Users/dev/elsewhere', definition: definition({ id: 'far' }) }),
  ]
  assert.deepEqual(
    waitingInProject(entries, '/Users/dev/acme-app').map((candidate) => candidate.definition.id),
    ['shipped', 'other'],
  )
})
