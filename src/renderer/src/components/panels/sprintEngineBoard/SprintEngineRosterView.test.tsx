import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import { SprintEngineRosterView } from './SprintEngineRosterView'
import type { AgentCli, AgentState, SprintEngineState } from '../../../types/workspace'
import type { SprintEngineAgentRosterItem } from '../../../utils/sprintengine'
import type { RuntimeAgentView } from '../sprintEngineInspector'

// Static accessibility/affordance contracts for the pool-sourced Agents table
// (MC-1593a): a slim header carries the census ("N working · M configured
// roles" — derived from the workers view + configuredRoles, never a seat
// headcount) and the two run-config controls, "Add a role" (roles the run does
// not yet configure) and "Add an agent" (raise the count for a configured
// role); each role renders as a band naming the role, its live/total count, and
// its editable model control (the shared quiet CliModelPickerButton — one per
// role, labeled "<Role> model"); agent rows are single-line entries listed
// newest-first under aria-label="<Role> agents"; the primary action splits Open
// (live, hover-revealed) / Resume (departed resumable) / Spawn (never-run,
// visible without hover); a live session whose launch stamp diverges from its
// reconciled runtime shows a muted "on <old model>" label, plus a Restart offer
// only while it is not working; and the row StatusDot stays decorative (status
// announced once via visually-hidden text). No rendered string says seat, lease,
// worker, or roster.

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
    onEnableRole={() => {}}
    onAddAgent={() => {}}
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

// Header: the pool census (workers view + configuredRoles) and the two
// run-config controls. Four roles are enabled (architect, developer, tester,
// security from roleCounts); one developer is running.
assert.ok(/1 working · 4 configured roles/.test(html), 'header shows the pool census')
assert.ok(html.includes('Add a role'), 'header exposes the enable-a-role control')
assert.ok(html.includes('Add an agent'), 'header exposes the raise-the-count control')
// The old seat-grammar copy is gone.
assert.ok(!/\d+ members/.test(html), 'no seat headcount census')
assert.ok(!/Add member/.test(html), 'no "Add member" control')
// No rendered string uses the retired seat/lease/worker/roster vocabulary.
assert.ok(!/\b(seat|lease|worker|roster)/i.test(html), 'no seat/lease/worker/roster copy renders')

// Role bands: role label + seat census + the in-place model control, one per
// role, labeled for the role. The picker trigger surfaces the configured model.
assert.ok(html.includes('aria-label="Architect model: Claude Code · Opus 4.8"'), 'architect band edits its model in place')
assert.ok(html.includes('aria-label="Developer model: Claude Code · Haiku 4.5"'), 'developer band edits its model in place')
assert.ok(/\d+ of \d+ active/.test(html), 'role bands show the seat census')

// The seat that holds the plan carries the coordination mark on a role-based run
// too — coordination is a job on the task, not a role (MC-2053/2055), and the
// design marks `architect-1` in its role-based panel as well.
assert.equal(
  (html.match(/aria-label="Coordinates this run"/g) ?? []).length,
  1,
  'exactly one seat — the architect — is marked as coordinating',
)

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

// Enabled-but-unstaffed role renders as a band with an honest empty state; the
// old add-chip tray is gone entirely.
assert.ok(html.includes('Security Specialist'), 'an enabled role with no agents still renders as a band')
assert.ok(html.includes('No agents yet'), 'an unstaffed band explains itself')
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
    onEnableRole={() => {}}
    onAddAgent={() => {}}
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
assert.ok(configuredHtml.includes('Performance Engineer'), 'a configured unstaffed role renders as a band')
assert.ok(
  configuredHtml.includes('aria-label="Performance Engineer model: codex"'),
  'a configured unstaffed role still gets an editable model control',
)
// Census derives from configuredRoles (3), not roster length; no addable roles
// leaves only the "Add an agent" control.
assert.ok(/0 working · 3 configured roles/.test(configuredHtml), 'census counts configured roles')
assert.ok(!configuredHtml.includes('Add a role'), 'no enable-a-role control when every role is configured')
assert.ok(configuredHtml.includes('Add an agent'), 'the raise-the-count control still renders')
assert.ok(!/\b(seat|lease|worker|roster)/i.test(configuredHtml), 'no seat/lease/worker/roster copy renders')

// ── No resident workspace: the door mount (MC-1800) ─────────────────────────
// The run's terminals live in a workspace that is gone. Every control that would
// need one is disabled and names the reason where it sits; the run-level control
// (add a role) is untouched, because it writes to the run.
const CLOSED = 'this sprint’s workspace is closed, so its agent terminals aren’t running'
const doorHtml = renderToStaticMarkup(
  <SprintEngineRosterView
    sprintEngineState={sprintEngineState}
    roster={roster}
    agents={agents}
    runtimeAgents={runtimeAgents}
    onEnableRole={() => {}}
    onAddAgent={() => {}}
    addMemberOptions={[
      { role: 'architect', label: 'Architect', summary: 'Plans.', activeForRole: 1, openTasksForRole: 0 },
      { role: 'developer', label: 'Developer', summary: 'Builds.', activeForRole: 3, openTasksForRole: 1 },
      { role: 'product', label: 'Product', summary: 'Shapes scope.', activeForRole: 0, openTasksForRole: 0 },
    ]}
    isAgentTerminalLive={(agentId) => liveAgentIds.has(agentId)}
    willResumeAgent={(agentId) => willResumeIds.has(agentId)}
    cliOptions={cliOptions}
    roleRuntimeCli={() => 'claude-code' as AgentCli}
    roleRuntimeModel={() => undefined}
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
    terminalActionsUnavailable={CLOSED}
  />,
)
assert.ok(
  doorHtml.includes(`aria-label="Open Architect terminal — unavailable: ${CLOSED}"`),
  'a live agent’s Open action is disabled and says why',
)
assert.ok(
  doorHtml.includes(`aria-label="Spawn Tester 1 — unavailable: ${CLOSED}"`),
  'a never-run agent’s Spawn action is disabled and says why',
)
assert.ok(
  doorHtml.includes(`aria-label="Resume Developer 3 — unavailable: ${CLOSED}"`),
  'and so is a departed agent’s Resume',
)
assert.equal(
  (doorHtml.match(/disabled=""/g) ?? []).length,
  roster.length + 1,
  'every row action plus Add an agent is disabled — and nothing else',
)
assert.ok(
  doorHtml.includes(`aria-label="Add an agent — unavailable: ${CLOSED}"`),
  'Add an agent is disabled: both its halves need the workspace',
)
assert.ok(!doorHtml.includes('actions"'), 'no row offers its ⋮ menu — every entry needs the workspace')
assert.ok(!doorHtml.includes('Restart'), 'and no restart offer, which would need a terminal to restart')
assert.ok(doorHtml.includes('Add a role'), 'adding a role is run-level, so it stays available')
assert.ok(
  !/Add a role — unavailable/.test(doorHtml),
  'and it is not disabled by the closed workspace',
)

// The narrower case: a run that keeps its whole team in the workspace record has
// nowhere to write a role either, and says so on that control too.
const legacyDoorHtml = renderToStaticMarkup(
  <SprintEngineRosterView
    sprintEngineState={sprintEngineState}
    roster={roster}
    agents={agents}
    runtimeAgents={runtimeAgents}
    onEnableRole={() => {}}
    onAddAgent={() => {}}
    addMemberOptions={[
      { role: 'product', label: 'Product', summary: 'Shapes scope.', activeForRole: 0, openTasksForRole: 0 },
    ]}
    isAgentTerminalLive={() => false}
    willResumeAgent={() => false}
    cliOptions={cliOptions}
    roleRuntimeCli={() => 'claude-code' as AgentCli}
    roleRuntimeModel={() => undefined}
    onSelectRoleCli={() => {}}
    onSelectRoleModel={() => {}}
    agentRuntimeCli={() => 'claude-code' as AgentCli}
    effectiveModelForAgent={() => undefined}
    onSelectAgentCli={() => {}}
    onSelectAgentModel={() => {}}
    onOpenAgent={() => {}}
    onSpawnAgent={() => {}}
    onRestartAgent={() => {}}
    onKillAgent={() => {}}
    terminalActionsUnavailable={CLOSED}
    roleConfigUnavailable="this sprint keeps its team in its workspace, and that workspace is closed"
  />,
)
assert.ok(
  legacyDoorHtml.includes('aria-label="Add a role — unavailable: this sprint keeps its team in its workspace'),
  'the run-level control explains its own, narrower reason',
)

// ── A roleless run (MC-2055) ────────────────────────────────────────────────
// The run configures no roles, so its agents carry none. Nothing may render a
// role, a band, or a stand-in for one: the seats sit flat, the census and the
// add control speak for the whole run, and the seat that holds the plan is
// marked on its own row.
const rolelessState = {
  roleCounts: {},
  configuredRoles: [],
  roleRuntimes: { '(roleless)': { cli: 'claude-code', model: 'claude-opus-4-8' } },
  tasks: [{ id: 'T1', title: 'Plan the sprint', status: 'in_progress' }],
  sprintEngineAgents: {
    coordinator: { status: 'running', currentTaskId: 'T1', lastOwnedTaskId: 'T1' },
    'agent-2': { status: 'idle', currentTaskId: null, lastOwnedTaskId: null },
  },
} as unknown as SprintEngineState

const rolelessRoster: SprintEngineAgentRosterItem[] = [
  { id: 'coordinator', label: 'Coordinator' },
  { id: 'agent-2', label: 'Agent 2' },
]

const rolelessHtml = renderToStaticMarkup(
  <SprintEngineRosterView
    sprintEngineState={rolelessState}
    roster={rolelessRoster}
    agents={{}}
    runtimeAgents={[
      { agentId: 'coordinator', status: 'running', currentTaskId: 'T1' },
      { agentId: 'agent-2', status: 'idle', currentTaskId: null },
    ] as unknown as RuntimeAgentView[]}
    onEnableRole={() => {}}
    onAddAgent={() => {}}
    addMemberOptions={[
      { role: 'developer', label: 'Developer', summary: 'Builds.', activeForRole: 0, openTasksForRole: 0 },
    ]}
    isAgentTerminalLive={(agentId) => agentId === 'coordinator'}
    willResumeAgent={() => false}
    cliOptions={cliOptions}
    roleRuntimeCli={() => 'claude-code' as AgentCli}
    roleRuntimeModel={() => undefined}
    onSelectRoleCli={() => {}}
    onSelectRoleModel={() => {}}
    agentRuntimeCli={() => 'claude-code' as AgentCli}
    effectiveModelForAgent={() => undefined}
    onSelectAgentCli={() => {}}
    onSelectAgentModel={() => {}}
    onOpenAgent={() => {}}
    onSpawnAgent={() => {}}
    onRestartAgent={() => {}}
    onKillAgent={() => {}}
  />,
)

// No role, and nothing standing in for one.
assert.ok(!/No role|Unknown role|General|\(roleless\)/i.test(rolelessHtml), 'no role placeholder renders anywhere')
assert.ok(!/configured role/.test(rolelessHtml), 'the census does not count roles this run does not have')
assert.ok(!rolelessHtml.includes('Add a role'), 'a run with no roles is not asked to add one')
// The run-level facts, in the header.
assert.ok(/1 of 2 active/.test(rolelessHtml), 'the census reads across the run')
assert.ok(rolelessHtml.includes('Add an agent'), 'the header adds an agent directly — there is no role to pick')
// Flat seats, both of them, named by their own ids.
assert.ok(rolelessHtml.includes('aria-label="Agents"'), 'seats are one flat list')
assert.ok(!/aria-label="[^"]+ agents"/.test(rolelessHtml), 'no per-role agent list, because there is no role')
assert.ok(rolelessHtml.includes('Coordinator') && rolelessHtml.includes('Agent 2'), 'every seat renders')
// The plan-holder is marked, and only it.
assert.equal(
  (rolelessHtml.match(/aria-label="Coordinates this run"/g) ?? []).length,
  1,
  'exactly one seat carries the coordination mark',
)

// An empty roleless run keys its empty state off the agents, never the roles.
const rolelessEmptyHtml = renderToStaticMarkup(
  <SprintEngineRosterView
    sprintEngineState={rolelessState}
    roster={[]}
    agents={{}}
    runtimeAgents={[]}
    onEnableRole={() => {}}
    onAddAgent={() => {}}
    addMemberOptions={[]}
    isAgentTerminalLive={() => false}
    willResumeAgent={() => false}
    cliOptions={cliOptions}
    roleRuntimeCli={() => 'claude-code' as AgentCli}
    roleRuntimeModel={() => undefined}
    onSelectRoleCli={() => {}}
    onSelectRoleModel={() => {}}
    agentRuntimeCli={() => 'claude-code' as AgentCli}
    effectiveModelForAgent={() => undefined}
    onSelectAgentCli={() => {}}
    onSelectAgentModel={() => {}}
    onOpenAgent={() => {}}
    onSpawnAgent={() => {}}
    onRestartAgent={() => {}}
    onKillAgent={() => {}}
  />,
)
assert.ok(
  rolelessEmptyHtml.includes('No agents yet — one starts when there is work.'),
  'the empty state speaks about agents, not roles',
)
assert.ok(
  !rolelessEmptyHtml.includes('No roles configured yet'),
  'and never claims a roleless run forgot to configure its roles',
)

console.log('SprintEngineRosterView.test.tsx: ok')
