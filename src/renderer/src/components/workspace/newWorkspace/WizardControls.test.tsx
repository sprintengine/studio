import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import type { AgentCli } from '../../../types/workspace'
import { AlsoChangesProjectsPanel, RosterAndRunSettings, cliPermissionOptions } from './WizardControls'

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

// "Also changes these projects" (MC-1613), rendered by the sprint wizard's
// Review & start page under the worktree toggle that gates it. A run can only
// span projects when each gets its own worktree — the engine refuses the pair —
// so the picker must not exist to be picked from until worktree mode is on.
const PROJECTS = [{ id: 'mobile', root: '../multicode-mobile', name: 'multicode-mobile' }]

function renderProjects(over: Partial<Parameters<typeof AlsoChangesProjectsPanel>[0]> = {}): string {
  return renderToStaticMarkup(
    <AlsoChangesProjectsPanel
      projects={PROJECTS}
      selectedProjectIds={[]}
      onToggleProject={() => {}}
      disabled={false}
      useWorktrees={true}
      {...over}
    />,
  )
}

const withProjects = renderProjects()
assert.ok(withProjects.includes('Also changes these projects'), 'worktree mode offers the sibling projects')
assert.ok(withProjects.includes('multicode-mobile'), 'a project is named by its folder, not its id or path')
assert.ok(!withProjects.includes('mobile"'), 'the declared id is never shown as the project name')

// Worktree mode off: no picker at all, rather than a dead control.
assert.ok(
  !renderProjects({ useWorktrees: false }).includes('Also changes these projects'),
  'without worktree mode the picker stays out of the way',
)
// A workspace with no sibling project has nothing to offer.
assert.ok(
  !renderProjects({ projects: [] }).includes('Also changes these projects'),
  'no sibling projects, no picker',
)
// Default is none: nothing is preselected, so a run stays single-project unless
// asked. A picked project carries the accent rail, so its absence is the check.
const SELECTED_ROW = 'bg-[color:var(--accent-primary-soft)]'
assert.ok(!withProjects.includes(SELECTED_ROW), 'no project is selected by default')
assert.ok(
  renderProjects({ selectedProjectIds: ['mobile'] }).includes(SELECTED_ROW),
  'a picked project reads as selected',
)
// Fixed once created: an existing team can read the projects but not change them.
const lockedProjects = renderProjects({ disabled: true, selectedProjectIds: ['mobile'] })
assert.ok(lockedProjects.includes('disabled=""'), 'an existing team cannot change the projects')
assert.ok(
  lockedProjects.includes('fixed when it is created'),
  'the locked picker says the set is fixed at creation, in plain words',
)
// No jargon reaches the user: never `repoId`, never `vcs`.
for (const jargon of ['repoId', 'vcs', 'repo id']) {
  assert.ok(!withProjects.includes(jargon), `the picker never shows "${jargon}"`)
}

console.log('WizardControls tests passed')
