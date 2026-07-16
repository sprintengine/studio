import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import type { AgentCli } from '../../../types/workspace'
import { RosterAndRunSettings } from './WizardControls'

// RosterAndRunSettings has two consumers with different needs: the creation hub
// pages the team and the run apart (sections='roster' / 'run'), while the Guided
// Brief build handoff renders the whole surface and passes no `sections` at all.
// The split must therefore be a partition of the existing render, not a rewrite —
// these tests pin that, since a regression here silently changes Guided Brief.

type ProjectPickerProps = {
  projectOptions: readonly { id: string; root: string; name: string }[]
  selectedProjectIds: readonly string[]
  onToggleProject: (id: string, on: boolean) => void
  projectsDisabled: boolean
  useWorktrees: boolean
}

// The markers below are the three blocks the component composes: the roster
// label, the caller-injected workflow panels, and the run-settings card.
const ROSTER_MARK = 'Roster'
const WORKFLOW_MARK = 'data-marker="workflow-section"'
const RUN_MARK = 'Run settings'

function render(sections?: 'all' | 'roster' | 'run', projects?: Partial<ProjectPickerProps>): string {
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
      {...(projects ?? {})}
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

// "Also changes these projects" (MC-1613). A run can only span projects when each
// gets its own worktree — the engine refuses the pair — so the picker must not
// exist to be picked from until worktree mode is on.
const PROJECTS = [{ id: 'mobile', root: '../multicode-mobile', name: 'multicode-mobile' }]
const pickerProps = (over: Partial<ProjectPickerProps> = {}): Partial<ProjectPickerProps> => ({
  projectOptions: PROJECTS,
  selectedProjectIds: [],
  onToggleProject: () => {},
  projectsDisabled: false,
  useWorktrees: true,
  ...over,
})

const withProjects = render('run', pickerProps())
assert.ok(withProjects.includes('Also changes these projects'), 'worktree mode offers the sibling projects')
assert.ok(withProjects.includes('multicode-mobile'), 'a project is named by its folder, not its id or path')
assert.ok(!withProjects.includes('mobile"'), 'the declared id is never shown as the project name')

// Worktree mode off: no picker at all, rather than a dead control.
assert.ok(
  !render('run', pickerProps({ useWorktrees: false })).includes('Also changes these projects'),
  'without worktree mode the picker stays out of the way',
)
// A workspace with no sibling project has nothing to offer.
assert.ok(
  !render('run', pickerProps({ projectOptions: [] })).includes('Also changes these projects'),
  'no sibling projects, no picker',
)
// Default is none: nothing is preselected, so a run stays single-project unless
// asked. A picked project carries the accent rail, so its absence is the check
// (the run-settings card has other checkboxes, incl. the worktree toggle above).
const SELECTED_ROW = 'bg-[color:var(--accent-primary-soft)]'
assert.ok(!withProjects.includes(SELECTED_ROW), 'no project is selected by default')
assert.ok(
  render('run', pickerProps({ selectedProjectIds: ['mobile'] })).includes(SELECTED_ROW),
  'a picked project reads as selected',
)
// Fixed once created: an existing team can read the projects but not change them.
const lockedProjects = render('run', pickerProps({ projectsDisabled: true, selectedProjectIds: ['mobile'] }))
assert.ok(lockedProjects.includes('disabled=""'), 'an existing team cannot change the projects')
assert.ok(
  lockedProjects.includes('fixed when it is created'),
  'the locked picker says the set is fixed at creation, in plain words',
)
// No jargon reaches the user: never `repoId`, never `vcs`.
for (const jargon of ['repoId', 'vcs', 'repo id']) {
  assert.ok(!withProjects.includes(jargon), `the picker never shows "${jargon}"`)
}

console.log('WizardControls sections tests passed')
