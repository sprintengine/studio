import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import { SprintEngineRosterView } from './SprintEngineRosterView'
import type { AgentCli, AgentState, SprintEngineState } from '../../../types/workspace'
import type { SprintEngineAgentRosterItem } from '../../../utils/sprintengine'
import type { RuntimeAgentView } from '../sprintEngineInspector'

// Static accessibility/affordance contracts for the team-table roster
// (MC-1516): a slim header carries the roster census and the single Add member
// control (the add-role chip tray is gone); each role renders as a band naming
// the role, its seat census, and its editable model control (the shared quiet
// CliModelPickerButton — one per role, labeled "<Role> model"); seat rows are
// single-line entries listed newest-first under aria-label="<Role> agents";
// the persistent reviewer stays tagged; the primary action splits Open (live,
// hover-revealed) / Resume (departed resumable) / Spawn (never-run, visible
// without hover); a live session whose launch stamp diverges from its
// reconciled runtime shows a muted "on <old model>" label, plus a Restart
// offer only while it is not working; and the row StatusDot stays decorative
// (status announced once via visually-hidden text).

const sprintEngineState = {
  roleCounts: { architect: 1, developer: 1, tester: 1, security: 1 },
  roleRuntimes: {
    architect: { cli: 'claude-code', model: 'claude-opus-4-8' },
    developer: { cli: 'claude-code', model: 'claude-haiku-4-5' },
  },
  tasks: [
    { id: 'T1', title: 'Scaffold the panel', role: 'developer', status: 'done' },
    { id: 'T2', title: 'Wire the store', role: 'developer', status: 'in_progress' },
  ],
  sprintEngineAgents: {
    'developer-3': { role: 'developer', status: 'exited', currentTaskId: null, lastOwnedTaskId: 'T1' },
    tester: { role: 'tester', status: 'idle', currentTaskId: null, lastOwnedTaskId: null },
  },
} as unknown as SprintEngineState

const roster: SprintEngineAgentRosterItem[] = [
  { id: 'architect', label: 'Architect', role: 'architect' },
  { id: 'developer-2', label: 'Developer 2', role: 'developer' },
  { id: 'developer-3', label: 'Developer 3', role: 'developer' },
  { id: 'developer-4', label: 'Developer 4', role: 'developer' },
  { id: 'tester', label: 'Tester 1', role: 'tester' },
]

const agents = {
  // Live architect whose session launched on Fable but whose reconciled
  // runtime is now Opus (post role edit): idle -> divergence label + Restart.
  architect: {
    name: 'Architect',
    cli: 'claude-code',
    cliModel: 'claude-opus-4-8',
    cliLaunchedRuntime: { cli: 'claude-code', model: 'claude-fable-5' },
  } as unknown as AgentState,
  // Live, working, and also diverged: label only, never a Restart offer.
  'developer-2': {
    name: 'Developer 2',
    cli: 'claude-code',
    cliModel: 'claude-haiku-4-5',
    cliLaunchedRuntime: { cli: 'claude-code', model: 'claude-sonnet-5' },
  } as unknown as AgentState,
  // Departed worker with a resumable recorded session -> Resume.
  'developer-3': { name: 'Developer 3', cli: 'claude-code' } as unknown as AgentState,
  // Spawn requested but no live terminal yet -> pending row state.
  'developer-4': { name: 'Developer 4', cli: 'claude-code', cliStartRequested: true } as unknown as AgentState,
  tester: { name: 'Tester 1', cli: 'claude-code' } as unknown as AgentState,
}

const runtimeAgents: RuntimeAgentView[] = [
  { agentId: 'architect', label: 'Architect', role: 'architect', status: 'idle', currentTaskId: null },
  { agentId: 'developer-2', label: 'Developer 2', role: 'developer', status: 'running', currentTaskId: 'T2' },
  { agentId: 'developer-3', label: 'Developer 3', role: 'developer', status: 'exited', currentTaskId: null },
  { agentId: 'developer-4', label: 'Developer 4', role: 'developer', status: 'idle', currentTaskId: null },
  { agentId: 'tester', label: 'Tester 1', role: 'tester', status: 'idle', currentTaskId: null },
]

const liveAgentIds = new Set(['architect', 'developer-2'])
const willResumeIds = new Set(['developer-3'])

const cliOptions = [
  {
    value: 'claude-code' as AgentCli,
    label: 'Claude Code',
    modelSelection: {
      options: [
        { id: 'claude-fable-5', label: 'Fable 5' },
        { id: 'claude-opus-4-8', label: 'Opus 4.8' },
        { id: 'claude-sonnet-5', label: 'Sonnet 5' },
        { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
      ],
      allowCustomId: false,
    },
  },
]

const html = renderToStaticMarkup(
  <SprintEngineRosterView
    sprintEngineState={sprintEngineState}
    roster={roster}
    agents={agents}
    runtimeAgents={runtimeAgents}
    onAddRole={() => {}}
    addMemberOptions={[
      { role: 'architect', label: 'Architect', summary: 'Plans.', activeForRole: 1, openTasksForRole: 0 },
      { role: 'developer', label: 'Developer', summary: 'Builds.', activeForRole: 3, openTasksForRole: 1 },
      { role: 'tester', label: 'Tester', summary: 'Validates.', activeForRole: 1, openTasksForRole: 0 },
      // Enabled but no sessions yet -> band with an empty state, never a chip.
      { role: 'security', label: 'Security Specialist', summary: 'Reviews.', activeForRole: 0, openTasksForRole: 0 },
      // Not enabled -> Add member menu entry only.
      { role: 'product', label: 'Product', summary: 'Shapes scope.', activeForRole: 0, openTasksForRole: 0 },
    ]}
    isAgentTerminalLive={(agentId) => liveAgentIds.has(agentId)}
    willResumeAgent={(agentId) => willResumeIds.has(agentId)}
    cliOptions={cliOptions}
    roleRuntimeCli={() => 'claude-code' as AgentCli}
    roleRuntimeModel={(role) =>
      (sprintEngineState.roleRuntimes?.[role]?.model as string | undefined) ?? undefined
    }
    onSelectRoleCli={() => {}}
    onSelectRoleModel={() => {}}
    agentRuntimeCli={(agentId) => (agents[agentId]?.cli ?? 'claude-code') as AgentCli}
    effectiveModelForAgent={(agentId) => agents[agentId]?.cliModel}
    onSelectAgentCli={() => {}}
    onSelectAgentModel={() => {}}
    onOpenAgent={() => {}}
    onSpawnAgent={() => {}}
    onRestartAgent={() => {}}
    onKillAgent={() => {}}
  />,
)

// Header: roster census + the single Add member control.
assert.ok(/5 members · 1 working/.test(html), 'header shows the roster census')
assert.ok(html.includes('Add member'), 'header exposes the Add member control')

// Role bands: role label + seat census + the in-place model control, one per
// role, labeled for the role. The picker trigger surfaces the configured model.
assert.ok(html.includes('aria-label="Architect model: Claude Code · Opus 4.8"'), 'architect band edits its model in place')
assert.ok(html.includes('aria-label="Developer model: Claude Code · Haiku 4.5"'), 'developer band edits its model in place')
assert.ok(/\d+ of \d+ active/.test(html), 'role bands show the seat census')

// Seat rows are single-line entries in a role-labeled list, newest-first.
assert.ok(html.includes('aria-label="Developer agents"'), 'developer seats render in a role-labeled list')
assert.ok(
  html.indexOf('Developer 4') < html.indexOf('Developer 3'),
  'seats render newest-first within a role',
)

// Divergence (MC-1516): the idle architect still runs its launch-stamped Fable
// session while the role config says Opus -> muted "on Fable 5" label plus an
// actionable Restart offer.
assert.ok(html.includes('on Fable 5'), 'a diverged idle session shows what it is still running')
assert.ok(html.includes('aria-label="Restart Architect on the new model"'), 'a diverged idle session offers Restart')

// A diverged but WORKING session is never offered an interrupting restart —
// the label renders, the restart does not.
assert.ok(html.includes('on Sonnet 5'), 'a diverged working session shows what it is still running')
assert.ok(!html.includes('aria-label="Restart Developer 2 on the new model"'), 'a working session gets no restart offer')

// An in-sync live session says nothing about its runtime.
assert.ok(!html.includes('on Opus 4.8'), 'an in-sync session renders no divergence label')

// Primary action split: live -> Open; departed resumable -> Resume; never-run
// -> Spawn; pending -> disabled Starting.
assert.ok(html.includes('aria-label="Open Developer 2 terminal"'), 'live row exposes a labeled Open action')
assert.ok(html.includes('aria-label="Resume Developer 3"'), 'a willResume row exposes a Resume action')
assert.ok(html.includes('aria-label="Spawn Tester 1"'), 'a never-run id renders Spawn, not Resume')
assert.ok(html.includes('aria-label="Developer 4 is starting"'), 'pending row announces the starting state')
assert.ok(
  /aria-label="Developer 4 is starting"[^>]*disabled/u.test(html)
    || /disabled[^>]*aria-label="Developer 4 is starting"/u.test(html),
  'pending primary action is disabled',
)
assert.ok(html.includes('Starting…'), 'pending row shows the Starting label')

// The activity line carries the seat's task; the labeled ⋮ menu survives the
// re-architecture. MC-1542: the persistent "Review seat" reviewer tag was
// retired along with the standalone reviewer roles.
assert.ok(html.includes('T2 · Wire the store'), 'a working seat shows its task on the activity line')
assert.ok(html.includes('aria-label="Developer 2 actions"'), 'rows expose a labeled row menu')

// The row StatusDot is decorative: status is announced once via the
// visually-hidden text, never re-emitted as a dot aria-label.
assert.ok(!html.includes('aria-label="Running"'), 'the row StatusDot sets no status aria-label')

// Enabled-but-unseated role renders as a band with an honest empty state; the
// old add-chip tray is gone entirely.
assert.ok(html.includes('Security Specialist'), 'an enabled role with no seats still renders as a band')
assert.ok(html.includes('No seats yet'), 'an unseated band explains itself')
assert.ok(!html.includes('aria-label="Add a role to the roster"'), 'the add-role chip tray is gone')
assert.ok(!html.includes('aria-label="Add Product"'), 'no per-role add chips render')

// configuredRoles (projected enabled-role set) still drives the bands: a
// configured reviewer that has never spawned renders as an empty band.
const configuredRolesState = {
  configuredRoles: ['architect', 'developer', 'performance'],
  roleCounts: { architect: 1, developer: 1 },
  tasks: [],
  sprintEngineAgents: {},
} as unknown as SprintEngineState
const configuredHtml = renderToStaticMarkup(
  <SprintEngineRosterView
    sprintEngineState={configuredRolesState}
    roster={[{ id: 'architect', label: 'Architect', role: 'architect' }]}
    agents={{}}
    runtimeAgents={[]}
    onAddRole={() => {}}
    addMemberOptions={[
      { role: 'architect', label: 'Architect', summary: 'Plans.', activeForRole: 1, openTasksForRole: 0 },
      { role: 'developer', label: 'Developer', summary: 'Builds.', activeForRole: 0, openTasksForRole: 0 },
      { role: 'performance', label: 'Performance Engineer', summary: 'Reviews.', activeForRole: 0, openTasksForRole: 0 },
    ]}
    isAgentTerminalLive={() => false}
    willResumeAgent={() => false}
    cliOptions={[]}
    roleRuntimeCli={() => 'codex' as AgentCli}
    roleRuntimeModel={() => undefined}
    onSelectRoleCli={() => {}}
    onSelectRoleModel={() => {}}
    agentRuntimeCli={() => 'codex' as AgentCli}
    effectiveModelForAgent={() => undefined}
    onSelectAgentCli={() => {}}
    onSelectAgentModel={() => {}}
    onOpenAgent={() => {}}
    onSpawnAgent={() => {}}
    onRestartAgent={() => {}}
    onKillAgent={() => {}}
  />,
)
assert.ok(configuredHtml.includes('Performance Engineer'), 'a configured unseated role renders as a band')
assert.ok(
  configuredHtml.includes('aria-label="Performance Engineer model: codex"'),
  'a configured unseated role still gets an editable model control',
)

console.log('SprintEngineRosterView.test.tsx: ok')
