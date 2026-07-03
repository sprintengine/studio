import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import { SprintEngineRosterView } from './SprintEngineRosterView'
import type { AgentCli, AgentState, SprintEngineState } from '../../../types/workspace'
import type { SprintEngineAgentRosterItem } from '../../../utils/sprintengine'
import type { RuntimeAgentView } from '../sprintEngineInspector'

// Static accessibility/affordance contracts for the role-grouped roster:
// role header rows are aria-expanded buttons carrying a live-session count and
// newest-activity summary; expanded groups list their agents newest-first with
// aria-label="<Role> agents"; the persistent reviewer id is tagged distinctly
// from the per-task workers; enabled roles with no sessions render as collapsed
// empty groups (never add chips); each agent row keeps its labeled row menu,
// CLI · model summary, pending state, and task list; and the primary action
// splits three ways — Open (live), Resume (departed with a resumable recorded
// session), Spawn (never-run / not resumable) — while the row StatusDot is
// decorative (status announced once via the adjacent visible text).

const sprintEngineState = {
  // Enabled team roles (architect always on). code_reviewer is enabled but has
  // no sessions yet -> collapsed empty group.
  roleCounts: { architect: 1, frontend: 1, developer: 1, tester: 1, security: 1, code_reviewer: 1 },
  tasks: [
    // T1 is done -> its departed owner (developer-3) is resumable, not the run.
    { id: 'T1', title: 'Scaffold the panel', role: 'developer', status: 'done' },
    { id: 'T2', title: 'Wire the store', role: 'developer', status: 'in_progress' },
    { id: 'T3', title: 'Validate the flow', role: 'tester', status: 'in_progress' },
    { id: 'T5', title: 'Group the roster', role: 'frontend', status: 'in_progress' },
  ],
  // lastOwnedTaskId marks an id that was assigned an implementation task. The
  // bare `frontend` id owns T5 here (legacy pre-lazy seeding), so it must read
  // as a worker, not a reviewer, despite holding the bare role id. developer-3
  // owns the done T1 and is not live -> departed-resumable (Resume action);
  // tester-2 owns the still-open T3 -> not resumable (stays Spawn).
  sprintEngineAgents: {
    frontend: { role: 'frontend', status: 'running', currentTaskId: 'T5', lastOwnedTaskId: 'T5' },
    'developer-3': { role: 'developer', status: 'exited', currentTaskId: null, lastOwnedTaskId: 'T1' },
    'tester-2': { role: 'tester', status: 'needs_input', currentTaskId: 'T3', lastOwnedTaskId: 'T3' },
  },
} as unknown as SprintEngineState

// Ascending role-index order in; the view groups by role and reverses each
// group for newest-first display.
const roster: SprintEngineAgentRosterItem[] = [
  { id: 'architect', label: 'Architect', role: 'architect' },
  { id: 'frontend', label: 'Frontend', role: 'frontend' },
  { id: 'developer-1', label: 'Developer 1', role: 'developer' },
  { id: 'developer-2', label: 'Developer 2', role: 'developer' },
  { id: 'developer-3', label: 'Developer 3', role: 'developer' },
  { id: 'developer-4', label: 'Developer 4', role: 'developer' },
  { id: 'tester', label: 'Tester 1', role: 'tester' },
  { id: 'tester-2', label: 'Tester 2', role: 'tester' },
  { id: 'security-1', label: 'Security 1', role: 'security' },
]

const agents = {
  architect: { name: 'Architect', cli: 'claude-code' } as unknown as AgentState,
  frontend: { name: 'Frontend', cli: 'claude-code' } as unknown as AgentState,
  // Spawn requested but no live terminal yet -> pending row state.
  'developer-1': { name: 'Developer 1', cli: 'codex', cliStartRequested: true } as unknown as AgentState,
  'developer-2': { name: 'Developer 2', cli: 'codex', cliModel: 'model-a' } as unknown as AgentState,
  // Departed worker: no live terminal, willResumeAgent -> true (Resume).
  'developer-3': { name: 'Developer 3', cli: 'claude-code' } as unknown as AgentState,
  // Idle, post-completion, no recorded session: not live, willResumeAgent ->
  // false, so it must render Spawn (not Resume) — the inverse-of-FIND-1 case.
  'developer-4': { name: 'Developer 4', cli: 'claude-code' } as unknown as AgentState,
  tester: { name: 'Tester 1', cli: 'claude-code' } as unknown as AgentState,
  'tester-2': { name: 'Tester 2', cli: 'claude-code' } as unknown as AgentState,
  'security-1': { name: 'Security 1', cli: 'claude-code' } as unknown as AgentState,
}

const runtimeAgents: RuntimeAgentView[] = [
  { agentId: 'architect', label: 'Architect', role: 'architect', status: 'running', currentTaskId: null },
  { agentId: 'frontend', label: 'Frontend', role: 'frontend', status: 'running', currentTaskId: 'T5' },
  { agentId: 'developer-1', label: 'Developer 1', role: 'developer', status: 'idle', currentTaskId: null },
  { agentId: 'developer-2', label: 'Developer 2', role: 'developer', status: 'running', currentTaskId: 'T2' },
  { agentId: 'developer-3', label: 'Developer 3', role: 'developer', status: 'exited', currentTaskId: null },
  { agentId: 'developer-4', label: 'Developer 4', role: 'developer', status: 'exited', currentTaskId: null },
  { agentId: 'tester', label: 'Tester 1', role: 'tester', status: 'idle', currentTaskId: null },
  { agentId: 'tester-2', label: 'Tester 2', role: 'tester', status: 'needs_input', currentTaskId: 'T3' },
  { agentId: 'security-1', label: 'Security 1', role: 'security', status: 'idle', currentTaskId: null },
]

// Live terminals: architect, frontend, developer-2. tester-2 is needs_input
// (not live) so its group still auto-expands on the attention state.
const liveAgentIds = new Set(['architect', 'frontend', 'developer-2'])

// The spawn container's resolved resume gate (matches spawnAgent). Only
// developer-3 has a resumable recorded session; every other non-live id (idle
// developer-4, mid-task tester-2) would spawn fresh -> Spawn label.
const willResumeIds = new Set(['developer-3'])

const html = renderToStaticMarkup(
  <SprintEngineRosterView
    sprintEngineState={sprintEngineState}
    roster={roster}
    agents={agents}
    runtimeAgents={runtimeAgents}
    selectedAgentId={'developer-2'}
    onSelectAgent={() => {}}
    onAddRole={() => {}}
    addMemberOptions={[
      { role: 'architect', label: 'Architect', summary: 'Plans.', activeForRole: 1, openTasksForRole: 0 },
      { role: 'frontend', label: 'Frontend', summary: 'Builds UI.', activeForRole: 1, openTasksForRole: 1 },
      { role: 'developer', label: 'Developer', summary: 'Builds.', activeForRole: 2, openTasksForRole: 1 },
      { role: 'tester', label: 'Tester', summary: 'Validates.', activeForRole: 2, openTasksForRole: 1 },
      { role: 'security', label: 'Security', summary: 'Hardens.', activeForRole: 1, openTasksForRole: 0 },
      // Enabled but no sessions yet -> group, not an add chip.
      { role: 'code_reviewer', label: 'Code Reviewer', summary: 'Reviews.', activeForRole: 0, openTasksForRole: 0 },
      // Not enabled -> add chip.
      { role: 'product', label: 'Product', summary: 'Shapes scope.', activeForRole: 0, openTasksForRole: 0 },
    ]}
    isAgentTerminalLive={(agentId) => liveAgentIds.has(agentId)}
    willResumeAgent={(agentId) => willResumeIds.has(agentId)}
    runtimeSummaryFor={(agentId) => (agentId === 'developer-2' ? 'Codex · model-a' : null)}
    cliOptions={[]}
    agentRuntimeCli={(agentId) => (agents[agentId]?.cli ?? 'codex') as AgentCli}
    effectiveModelForAgent={(agentId) => agents[agentId]?.cliModel}
    onSelectAgentCli={() => {}}
    onSelectAgentModel={() => {}}
    onOpenAgent={() => {}}
    onSpawnAgent={() => {}}
    onRestartAgent={() => {}}
    onKillAgent={() => {}}
    inspectorContent={null}
    inspectorExpanded={false}
  />,
)

// Role header rows are aria-expanded buttons; both states are present (live /
// needs_input roles expanded, quiet roles collapsed).
assert.ok(html.includes('aria-expanded="true"'), 'an attention role group renders expanded')
assert.ok(html.includes('aria-expanded="false"'), 'a quiet role group renders collapsed')

// Expanded groups label their agent list per role.
assert.ok(html.includes('aria-label="Developer agents"'), 'developer group list is role-labeled')
assert.ok(html.includes('aria-label="Tester agents"'), 'tester group list is role-labeled')

// Live-session count badge on the role header.
assert.ok(html.includes('1 active'), 'role header shows the live-session count')

// Newest-first ordering within a group: developer-2 before developer-1.
assert.ok(
  html.indexOf('Developer 2') < html.indexOf('Developer 1'),
  'group entries render newest-first',
)

// Persistent reviewer (bare `tester`, never assigned a task) is tagged; the
// bare `frontend` id owns T5 so it stays a worker, and no per-task worker is
// tagged -> exactly one Reviewer tag.
assert.equal((html.match(/>Reviewer</g) || []).length, 1, 'only the persistent reviewer entry is tagged')

// Primary action splits three ways by liveness + resumability.
// Live member: Open, and the row menu is labeled.
assert.ok(html.includes('aria-label="Open Developer 2 terminal"'), 'live row exposes a labeled Open action')
assert.ok(html.includes('aria-label="Developer 2 actions"'), 'live row exposes a labeled row menu')

// Departed id whose spawn-side resume gate (willResumeAgent) is true -> Resume;
// the click still routes through the spawn handler, which resumes the recorded
// conversation. No live terminal here.
assert.ok(html.includes('aria-label="Resume Developer 3"'), 'a willResume row exposes a Resume action')
assert.ok(html.includes('>Resume<'), 'a willResume primary action reads Resume, not Spawn')

// Inverse-of-FIND-1 guard: a not-live id whose resume gate is false must render
// Spawn, never Resume — covers the idle/post-completion no-session id
// (developer-4) and the mid-task id (tester-2). The label follows willResumeAgent
// exactly, so it can't claim Resume for an id that would fresh-spawn.
assert.ok(html.includes('aria-label="Spawn Developer 4"'), 'an idle no-session id renders Spawn, not Resume')
assert.ok(html.includes('aria-label="Spawn Tester 2"'), 'a mid-task not-resumable id keeps Spawn')

// CLI · model runtime summary on the row meta line.
assert.ok(html.includes('Codex · model-a'), 'row meta line shows the CLI · model runtime summary')

// FIND-2: the row StatusDot is decorative (no label -> aria-hidden), so a
// running row announces its state once via the adjacent visible text, not
// twice. The dot must not re-emit the status as an aria-label.
assert.ok(html.includes('>Running<'), 'running status is announced via the visible row text')
assert.ok(!html.includes('aria-label="Running"'), 'the row StatusDot sets no status aria-label')

// Spawn in flight: the primary action is a disabled pending state.
assert.ok(html.includes('aria-label="Developer 1 is starting"'), 'pending row announces the starting state')
assert.ok(
  /aria-label="Developer 1 is starting"[^>]*disabled/u.test(html)
    || /disabled[^>]*aria-label="Developer 1 is starting"/u.test(html),
  'pending primary action is disabled',
)
assert.ok(html.includes('Starting…'), 'pending row shows the Starting label')

// Task association renders as a list (works for 0/1/many). The owned task id
// and title appear for an active worker.
assert.ok(html.includes('<ul'), 'owned tasks render as a list')
assert.ok(html.includes('T3') && html.includes('Validate the flow'), 'owned task id and title render')

// Enabled-but-empty role renders as a group (its label shows), never an add
// chip, and without an agent list while collapsed.
assert.ok(html.includes('Code Reviewer'), 'an enabled role with no sessions still renders as a group')
assert.ok(!html.includes('aria-label="Code Reviewer agents"'), 'a collapsed empty group renders no agent list')
assert.ok(!html.includes('aria-label="Add Code Reviewer"'), 'an enabled empty role is not an add chip')

// A quiet (idle-only) enabled role collapses, hiding its entries.
assert.ok(!html.includes('Security 1'), 'a collapsed quiet group hides its agent entries')

// Add-role chips remain for roles not yet enabled on the team.
assert.ok(html.includes('aria-label="Add a role to the roster"'), 'add role section is labeled')
assert.ok(html.includes('aria-label="Add Product"'), 'a not-yet-enabled role renders an add chip')

console.log('SprintEngineRosterView.test.tsx: ok')
