import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import type { AgentCli } from '../../../types/workspace'
import { RosterAndRunSettings } from './WizardControls'

// RosterAndRunSettings has two consumers with different needs: the creation hub
// pages the team and the run apart (sections='roster' / 'run'), while the Guided
// Brief build handoff renders the whole surface and passes no `sections` at all.
// The split must therefore be a partition of the existing render, not a rewrite —
// these tests pin that, since a regression here silently changes Guided Brief.

// The markers below are the three blocks the component composes: the roster
// label, the caller-injected workflow panels, and the run-settings card.
const ROSTER_MARK = 'Roster'
const WORKFLOW_MARK = 'data-marker="workflow-section"'
const RUN_MARK = 'Run settings'

function render(sections?: 'all' | 'roster' | 'run'): string {
  return renderToStaticMarkup(
    <RosterAndRunSettings
      roleCounts={{ developer: 2, tester: 1 }}
      roleCliDefaults={{ developer: 'claude', tester: 'claude' } as unknown as never}
      cliOptions={[{ id: 'claude' as AgentCli, label: 'Claude' } as never]}
      registry={null}
      countDisabled={false}
      cliDisabled={false}
      onSetCount={() => {}}
      onSetCli={() => {}}
      totalAgents={3}
      automationMode={'manual' as never}
      onChangeAutomationMode={() => {}}
      cliPermissionPreset={'default' as never}
      onChangeCliPermissionPreset={() => {}}
      maxParallelAgents={3}
      onChangeMaxParallelAgents={() => {}}
      useWorktrees={false}
      onChangeUseWorktrees={() => {}}
      workflowSection={<div data-marker="workflow-section" />}
      sections={sections}
    />,
  )
}

// The Guided Brief handoff passes no `sections`. If the default ever stops being
// a byte-for-byte no-op, that surface changes without anyone editing it — so this
// is the regression canary, asserted on the markup rather than on the prop.
assert.equal(
  render(undefined),
  render('all'),
  "omitting `sections` renders exactly what sections='all' renders",
)

// 'all' keeps every block, in the order the wizard step reads: the team, then the
// workflow panels, then how the run behaves.
const all = render('all')
for (const mark of [ROSTER_MARK, WORKFLOW_MARK, RUN_MARK]) {
  assert.ok(all.includes(mark), `sections='all' renders ${mark}`)
}
assert.ok(
  all.indexOf(ROSTER_MARK) < all.indexOf(WORKFLOW_MARK) && all.indexOf(WORKFLOW_MARK) < all.indexOf(RUN_MARK),
  "sections='all' orders the blocks roster -> workflow -> run",
)

// 'roster' is the team page: the roster only, with no run surface leaking onto it.
const roster = render('roster')
assert.ok(roster.includes(ROSTER_MARK), "sections='roster' renders the roster")
assert.ok(!roster.includes(WORKFLOW_MARK), "sections='roster' withholds the workflow panels")
assert.ok(!roster.includes(RUN_MARK), "sections='roster' withholds Run settings")

// 'run' is the run page. workflowSection rides HERE, not with the roster: it
// carries self-review, reviewer runtime, and required sweeps, which describe how
// the run behaves rather than who is on the team.
const run = render('run')
assert.ok(run.includes(WORKFLOW_MARK), "sections='run' renders the workflow panels")
assert.ok(run.includes(RUN_MARK), "sections='run' renders Run settings")
assert.ok(!run.includes(ROSTER_MARK), "sections='run' withholds the roster")

console.log('WizardControls sections tests passed')
