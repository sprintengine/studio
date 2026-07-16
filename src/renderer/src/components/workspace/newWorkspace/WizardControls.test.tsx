import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import type { AgentCli } from '../../../types/workspace'
import { RosterAndRunSettings, cliPermissionOptions } from './WizardControls'

// RosterAndRunSettings is the Guided Brief build handoff's roster + run
// surface (the sprint wizard's own pages moved to the SprintEngine*Panel
// components in MC-1646). These tests pin the surface the handoff renders:
// the roster table, an optional caller-injected workflow section between the
// roster and the settings card, and the run-settings card — in that order —
// so a wizard-side refactor cannot silently change Guided Brief.

const ROSTER_MARK = 'Roster'
const WORKFLOW_MARK = 'data-marker="workflow-section"'
const RUN_MARK = 'Run settings'

function render(withWorkflow: boolean): string {
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
      workflowSection={withWorkflow ? <div data-marker="workflow-section" /> : undefined}
    />,
  )
}

// The full surface renders every block in the order the handoff reads: the
// team, then the workflow panels, then how the run behaves.
const all = render(true)
for (const mark of [ROSTER_MARK, WORKFLOW_MARK, RUN_MARK]) {
  assert.ok(all.includes(mark), `renders ${mark}`)
}
assert.ok(
  all.indexOf(ROSTER_MARK) < all.indexOf(WORKFLOW_MARK) && all.indexOf(WORKFLOW_MARK) < all.indexOf(RUN_MARK),
  'orders the blocks roster -> workflow -> run',
)

// The workflow section is caller-owned and optional: the Guided Brief handoff
// passes none today, and the roster and run settings still render around the gap.
const withoutWorkflow = render(false)
assert.ok(withoutWorkflow.includes(ROSTER_MARK), 'roster renders without a workflow section')
assert.ok(withoutWorkflow.includes(RUN_MARK), 'run settings render without a workflow section')
assert.ok(!withoutWorkflow.includes(WORKFLOW_MARK), 'no workflow markup is invented')

// The run-settings card carries the permission preset row (with its hint) and
// the automation radiogroup — the two controls the handoff exposes.
assert.ok(withoutWorkflow.includes('Agent permissions'), 'permission preset row renders')
assert.ok(withoutWorkflow.includes('aria-label="Sprint automation mode"'), 'automation radiogroup renders')
assert.ok(
  withoutWorkflow.includes(cliPermissionOptions[0].hint),
  'the selected permission preset explains itself',
)

console.log('WizardControls tests passed')
