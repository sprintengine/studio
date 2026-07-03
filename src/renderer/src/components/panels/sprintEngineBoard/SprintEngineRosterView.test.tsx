import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import { SprintEngineRosterView } from './SprintEngineRosterView'
import type { AgentCli, AgentState, SprintEngineState } from '../../../types/workspace'
import type { RuntimeAgentView } from '../sprintEngineInspector'

// Static accessibility/affordance contracts for the roster control rows:
// every member row exposes a primary Open/Spawn action and a labeled row
// menu, pending spawns render a disabled "Starting…" state, and the
// CLI · model runtime summary is visible on the row meta line.

const sprintEngineState = {
  tasks: [
    { id: 'T1', title: 'Build the panel', role: 'developer', status: 'in_progress' },
  ],
} as unknown as SprintEngineState

const roster = [
  { id: 'architect', label: 'Architect', role: 'architect' as const },
  { id: 'developer-1', label: 'Developer 1', role: 'developer' as const },
  { id: 'frontend', label: 'Frontend Engineer', role: 'frontend' as const },
]

const agents = {
  architect: { name: 'Architect', cli: 'claude-code', cliStartRequested: true } as unknown as AgentState,
  'developer-1': { name: 'Dev One', cli: 'codex', cliModel: 'model-a' } as unknown as AgentState,
  // Spawn requested but no live terminal yet -> pending row state.
  frontend: { name: 'Frontend Engineer', cli: 'claude-code', cliStartRequested: true } as unknown as AgentState,
}

const runtimeAgents: RuntimeAgentView[] = [
  { agentId: 'architect', label: 'Architect', role: 'architect', status: 'running', currentTaskId: null },
  { agentId: 'developer-1', label: 'Developer 1', role: 'developer', status: 'idle', currentTaskId: 'T1' },
]

const liveAgentIds = new Set(['architect'])

const html = renderToStaticMarkup(
  <SprintEngineRosterView
    sprintEngineState={sprintEngineState}
    roster={roster}
    agents={agents}
    runtimeAgents={runtimeAgents}
    selectedAgentId={'architect'}
    onSelectAgent={() => {}}
    onAddRole={() => {}}
    addMemberOptions={[
      // Already-rostered roles are filtered out (MC-1450: same-role capacity
      // grows on demand); only not-yet-enabled roles render as add chips.
      { role: 'developer', label: 'Developer', summary: 'Builds things.', activeForRole: 1, openTasksForRole: 1 },
      { role: 'tester', label: 'Tester', summary: 'Verifies things.', activeForRole: 0, openTasksForRole: 0 },
    ]}
    isAgentTerminalLive={(agentId) => liveAgentIds.has(agentId)}
    runtimeSummaryFor={(agentId) =>
      agentId === 'developer-1' ? 'Codex · model-a' : agentId === 'architect' ? 'Claude Code' : null}
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

// Live member: primary action is Open, and the row menu is labeled.
assert.ok(html.includes('aria-label="Open Architect terminal"'), 'live row exposes a labeled Open action')
assert.ok(html.includes('aria-label="Architect actions"'), 'live row exposes a labeled row menu')

// Stopped member: primary action is Spawn.
assert.ok(html.includes('aria-label="Spawn Dev One"'), 'stopped row exposes a labeled Spawn action')
assert.ok(html.includes('Codex · model-a'), 'row meta line shows the CLI · model runtime summary')

// Spawn in flight: the primary action is a disabled pending state, never a
// second Spawn.
assert.ok(html.includes('aria-label="Frontend Engineer is starting"'), 'pending row announces the starting state')
assert.ok(/aria-label="Frontend Engineer is starting"[^>]*disabled/u.test(html) || /disabled[^>]*aria-label="Frontend Engineer is starting"/u.test(html), 'pending primary action is disabled')
assert.ok(html.includes('Starting…'), 'pending row shows the Starting label')

// Roster list and add-role affordances keep their accessible structure. An
// already-rostered role never renders an add chip (no "add another" — MC-1450).
assert.ok(html.includes('aria-label="Roster agents"'), 'roster list is labeled')
assert.ok(html.includes('aria-label="Add a role to the roster"'), 'add role section is labeled')
assert.ok(html.includes('aria-label="Add Tester"'), 'not-yet-enabled role chips are labeled with add intent')
assert.ok(!html.includes('Add another'), 'no add-another affordance for an already-rostered role')
assert.ok(!html.includes('aria-label="Add Developer"'), 'an already-rostered role renders no add chip')

// With every role already on the team, the Add-role section disappears
// entirely instead of rendering an empty shell.
const fullyRosteredHtml = renderToStaticMarkup(
  <SprintEngineRosterView
    sprintEngineState={sprintEngineState}
    roster={roster}
    agents={agents}
    runtimeAgents={runtimeAgents}
    selectedAgentId={'architect'}
    onSelectAgent={() => {}}
    onAddRole={() => {}}
    addMemberOptions={[
      { role: 'developer', label: 'Developer', summary: 'Builds things.', activeForRole: 1, openTasksForRole: 1 },
    ]}
    isAgentTerminalLive={(agentId) => liveAgentIds.has(agentId)}
    runtimeSummaryFor={() => null}
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
assert.ok(
  !fullyRosteredHtml.includes('aria-label="Add a role to the roster"'),
  'the Add-role section is hidden when every role is already rostered'
)

console.log('SprintEngineRosterView.test.tsx: ok')
