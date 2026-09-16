import assert from 'node:assert/strict'
import { getCommandDefinition } from './commandRegistry'
import {
  isCommandAvailable,
  isCommandEnabled,
  isCommandIdEnabled,
  isCommandInScope,
  type CommandAvailabilityContext,
} from './availability'
import type { CommandScope } from './types'

function def(id: string) {
  const command = getCommandDefinition(id)
  assert.ok(command, `expected registry command ${id}`)
  return command
}

// Commands with no preconditions are always available regardless of context.
assert.equal(isCommandAvailable(def('sprintengine.goto.inbox'), { sprintengineWorkspace: true }), true)
assert.equal(isCommandAvailable({ availability: undefined }, {}), true)
assert.equal(isCommandAvailable({ availability: [] }, {}), true)

// ANDed preconditions: every declared condition must hold.
assert.equal(
  isCommandAvailable(def('sprintengine.verify.progress'), { sprintengineWorkspace: true }),
  false,
)
assert.equal(
  isCommandAvailable(def('sprintengine.verify.progress'), {
    sprintengineWorkspace: true,
    sprintengineHasArchitect: true,
  }),
  true,
)

// Scope membership gate (open panel:* family — module-derived scopes match
// by string identity like the named ones).
assert.equal(isCommandInScope({ scopes: ['panel:notebook'] }, ['panel:notebook']), true)
assert.equal(isCommandInScope({ scopes: ['panel:notebook'] }, ['panel:calendar']), false)
assert.equal(isCommandInScope({ scopes: ['panel:calendar'] }, ['panel:calendar']), true)

// Sprint Engine: verify-progress needs an architect; navigation needs only the
// workspace. The scope gate refuses the command outside a Sprint Engine panel
// even when preconditions are otherwise met.
const sprintEngineScopes: CommandScope[] = ['global', 'workspace', 'workspace-navigation', 'panel:sprintengine']
const sprintEngineContext: CommandAvailabilityContext = { activeWorkspace: true, sprintengineWorkspace: true }
assert.equal(isCommandIdEnabled('sprintengine.verify.progress', sprintEngineScopes, sprintEngineContext), false)
assert.equal(
  isCommandIdEnabled('sprintengine.verify.progress', sprintEngineScopes, {
    ...sprintEngineContext,
    sprintengineHasArchitect: true,
  }),
  true,
)
assert.equal(isCommandIdEnabled('sprintengine.goto.roster', sprintEngineScopes, sprintEngineContext), true)
assert.equal(isCommandIdEnabled('sprintengine.goto.roster', ['global', 'workspace'], sprintEngineContext), false)
assert.equal(
  isCommandIdEnabled('sprintengine.focus.agent', sprintEngineScopes, sprintEngineContext),
  false,
)
assert.equal(
  isCommandIdEnabled('sprintengine.focus.agent', sprintEngineScopes, {
    ...sprintEngineContext,
    sprintengineFocusAgentVisible: true,
  }),
  true,
)

// A capability module's commands ride module command contributions, not the
// shell registry (MC-1533). Those contribution shapes are exercised here
// directly: an availability predicate evaluates against the published
// ModuleCommandContext view (fail-closed with no context), and scope-only
// commands stay scope-gated.
const refreshBoard = {
  scopes: ['panel:notebook'] as const,
  availabilityPredicate: (context: { activeWorkspaceMode: string | null }) =>
    context.activeWorkspaceMode === 'notebook',
}
const moduleScopes: CommandScope[] = ['global', 'workspace', 'workspace-navigation', 'panel:notebook', 'panel:calendar']
assert.equal(
  isCommandEnabled(refreshBoard, moduleScopes, {}, { activeWorkspaceId: 'ws-1', activeWorkspaceMode: 'notebook' }),
  true,
)
assert.equal(
  isCommandEnabled(refreshBoard, moduleScopes, {}, { activeWorkspaceId: 'ws-1', activeWorkspaceMode: 'standard' }),
  false,
)
assert.equal(isCommandEnabled(refreshBoard, moduleScopes, {}), false, 'no context wired fails closed')
// A throwing predicate fails closed instead of unwinding the caller.
assert.equal(
  isCommandAvailable(
    { availabilityPredicate: () => { throw new Error('module bug') } },
    {},
    { activeWorkspaceId: 'ws-1', activeWorkspaceMode: 'notebook' },
  ),
  false,
)
// Scope-only module commands stay scope-gated.
assert.equal(isCommandEnabled({ scopes: ['panel:calendar'] as const }, moduleScopes, {}), true)
assert.equal(isCommandEnabled({ scopes: ['panel:calendar'] as const }, ['global', 'workspace'], {}), false)

// Git / terminal: workspace-scoped, gated on an active workspace.
const workspaceScopes: CommandScope[] = ['global', 'workspace', 'workspace-navigation']
assert.equal(isCommandIdEnabled('panel.git.toggle', workspaceScopes, { activeWorkspace: true }), true)
assert.equal(isCommandIdEnabled('panel.git.toggle', workspaceScopes, {}), false)
assert.equal(isCommandIdEnabled('terminal.new', workspaceScopes, { activeWorkspace: true }), true)
assert.equal(isCommandIdEnabled('terminal.new', ['global'], { activeWorkspace: true }), false)

// Git refresh/fetch/commit run real Git-panel handlers — only available while
// the Git panel is mounted (gitPanelActive), in addition to an active workspace.
for (const id of ['git.refresh', 'git.fetch', 'git.commit']) {
  assert.equal(isCommandIdEnabled(id, workspaceScopes, { activeWorkspace: true }), false)
  assert.equal(isCommandIdEnabled(id, workspaceScopes, { activeWorkspace: true, gitPanelActive: true }), true)
  assert.equal(isCommandIdEnabled(id, ['global'], { activeWorkspace: true, gitPanelActive: true }), false)
}

// Terminal focus/stop need a live terminal session (terminalActive); new does not.
// terminalActive is the exact precondition both real handlers require — focus
// targets the workspace's live terminal, and stop deterministically stops the
// focused terminal tab or, failing that, the workspace's first live terminal —
// so the command is never offered in a context where runCommand returns false.
for (const id of ['terminal.focus', 'terminal.stop']) {
  assert.equal(isCommandIdEnabled(id, workspaceScopes, { activeWorkspace: true }), false)
  assert.equal(isCommandIdEnabled(id, workspaceScopes, { activeWorkspace: true, terminalActive: true }), true)
  // Scope still gates it: a live terminal alone does not enable the command.
  assert.equal(isCommandIdEnabled(id, ['global'], { activeWorkspace: true, terminalActive: true }), false)
}

// Unknown ids never enable.
assert.equal(isCommandIdEnabled('does.not.exist', sprintEngineScopes, sprintEngineContext), false)

assert.equal(
  isCommandIdEnabled('specialist.spawn.architect', workspaceScopes, { activeWorkspace: true }),
  false,
)
assert.equal(
  isCommandIdEnabled('specialist.spawn.architect', workspaceScopes, {
    activeWorkspace: true,
    workflowRolesInstalled: true,
  }),
  true,
)
assert.equal(
  isCommandIdEnabled('sprintengine.add.role', sprintEngineScopes, sprintEngineContext),
  false,
)
assert.equal(
  isCommandIdEnabled('sprintengine.add.role', sprintEngineScopes, {
    ...sprintEngineContext,
    workflowRolesInstalled: true,
  }),
  true,
)

// isCommandEnabled mirrors isCommandIdEnabled for a resolved definition.
assert.equal(
  isCommandEnabled(def('terminal.new'), workspaceScopes, { activeWorkspace: true }),
  true,
)

console.log('availability.test.ts passed')
