import assert from 'node:assert/strict'

import type { LayoutTemplate, Workspace } from '../types/workspace'
import { buildSprintEngineAgentRosterForState, createInitialSprintEngineState } from '../utils/sprintengine'
import { useWorkspaceStore } from '../store/workspaceStore'
import { bindSprintEngineRunStore, useSprintEngineRunStore } from '../modules/sprint-engine-run-store'
import { defaultAgent, defaultEditorState } from '../store/slices/agentsSlice'
import {
  createRunStateSlice,
  defaultSprintEngineAutoState,
  normalizeSprintEngineAutoState,
  normalizeSprintEngineRoleCliDefaults,
  reconcileSprintEngineAgents,
} from './sprint-engine-run-state'
import { sprintEngineRunSettingsKey } from '../store/slices/settingsSlice'
import { getSprintEngineModuleState, sprintEngineRunContext, sprintEngineRunState } from '../store/slices/workspaceModuleState'

bindSprintEngineRunStore((recipe) => {
  useWorkspaceStore.setState(recipe as never)
})

const standardTemplate: LayoutTemplate = {
  id: 'run-state-standard',
  name: 'Standard',
  description: 'Standard workspace test template',
  previewSlots: [],
  layout: {
    global: { tabSetEnableDrop: true, tabEnableClose: false },
    borders: [],
    layout: {
      type: 'row',
      children: [
        {
          type: 'tabset',
          weight: 100,
          children: [{ type: 'tab', name: 'Editor', component: 'editor' }],
        },
      ],
    },
  },
}

const sprintAuto = normalizeSprintEngineAutoState({
  desiredMode: 'run_agents_and_approve_artifacts',
  runtimeState: 'running',
  cliPermissionPreset: 'invalid' as never,
  maxConcurrentAgents: 99,
  deliveredAgentNotificationEventIds: [' EVT-1 ', '', 'EVT-2'],
})
assert.equal(sprintAuto.desiredMode, 'run_agents_and_approve_artifacts')
assert.equal(sprintAuto.runtimeState, 'running')
assert.equal(sprintAuto.cliPermissionPreset, 'manual')
assert.equal(sprintAuto.maxConcurrentAgents, 10)
assert.deepEqual(sprintAuto.deliveredAgentNotificationEventKeys, [' EVT-1 ', 'EVT-2'])
assert.equal(sprintAuto.completionTeardownAt, undefined)

// The one-shot completion-teardown marker survives normalization — this runs on
// every projection write, so dropping it would re-arm teardown each poll.
assert.equal(
  normalizeSprintEngineAutoState({ runtimeState: 'complete', completionTeardownAt: 1234 } as never)
    .completionTeardownAt,
  1234,
)
assert.equal(
  normalizeSprintEngineAutoState({ completionTeardownAt: 'bogus' as never } as never).completionTeardownAt,
  undefined,
)

assert.equal(normalizeSprintEngineRoleCliDefaults({ tester: 'claude-code' }).tester, 'claude-code')
assert.equal(normalizeSprintEngineRoleCliDefaults({ tester: 'bad' as never }).tester, 'bad')

const baseSprintState = createInitialSprintEngineState({
  goal: 'Validate run-state slice',
  name: 'Run State Team',
  roleCounts: { frontend: 1, tester: 1 },
})
// The lazy roster seeds only the architect; a live run mints worker seats. Seed
// frontend/tester seats explicitly so the reconcile paths below exercise workers.
const sprintState = {
  ...baseSprintState,
  sprintEngineAgents: {
    ...baseSprintState.sprintEngineAgents,
    frontend: { role: 'frontend' as const, status: 'idle' as const, currentTaskId: null },
    tester: { role: 'tester' as const, status: 'idle' as const, currentTaskId: null },
  },
}
const carrier: { workspaces: Workspace[] } = {
  workspaces: [
    {
      id: 'ws-direct-run-state',
      name: 'Run State Direct',
      mode: 'standard',
      folderPath: '/repo',
      templateId: 'run-state-standard',
      agents: {
        specialist: defaultAgent('specialist', 'Specialist', 'specialist'),
      },
      layoutModel: standardTemplate.layout,
      worktreeState: {
        containerPath: null,
        entries: {},
        updatedAt: null,
      },
      memory: { relativeRoot: null },
      editorState: defaultEditorState(),
      sprintEngineAutoState: defaultSprintEngineAutoState(),
      createdAt: 1,
    },
  ],
}
const runStateSlice = createRunStateSlice((mutator) => mutator(carrier))

runStateSlice.setSprintEngineState('ws-direct-run-state', sprintState)
const directWorkspace = carrier.workspaces[0]
assert.equal(directWorkspace.mode, 'sprintengine')
assert.equal(sprintEngineRunState(directWorkspace)?.goal, 'Validate run-state slice')
assert.equal(
  getSprintEngineModuleState(directWorkspace)?.state,
  sprintEngineRunState(directWorkspace),
  'setSprintEngineState writes the bag entry as the only home of the projection',
)
{
  const bagCarrier: { workspaces: Workspace[] } = {
    workspaces: [{
      ...carrier.workspaces[0],
      id: 'ws-bag-lockstep',
      agents: {},
      // Clone the bag: the null write deletes the entry in place, and a
      // shared reference would corrupt the fixture workspace above.
      moduleState: { ...carrier.workspaces[0].moduleState },
    }],
  }
  const bagSlice = createRunStateSlice((mutator) => mutator(bagCarrier))
  bagSlice.setSprintEngineState('ws-bag-lockstep', null)
  assert.equal(sprintEngineRunState(bagCarrier.workspaces[0]), null, 'a null write clears the bag projection')
  assert.equal(
    bagCarrier.workspaces[0].moduleState,
    undefined,
    'a null write removes the bag entry, and an emptied bag drops entirely',
  )
}
assert.equal(sprintEngineRunContext(directWorkspace)?.teamSlug, 'run-state-team')
assert.ok(directWorkspace.agents.specialist, 'specialist agents should survive Sprint Engine roster reconciliation')
assert.ok(directWorkspace.agents.frontend, 'Sprint Engine roster agents should be reconciled into workspace agents')
const stableAgents = reconcileSprintEngineAgents(directWorkspace.agents, sprintState)
assert.equal(stableAgents, directWorkspace.agents, 'unchanged Sprint Engine reconcile should reuse the agents map')
for (const [agentId, agent] of Object.entries(directWorkspace.agents)) {
  assert.equal(stableAgents[agentId], agent, `unchanged Sprint Engine reconcile should reuse ${agentId}`)
}
const frontendRosterLabel = buildSprintEngineAgentRosterForState(sprintState)
  .find((agent) => agent.id === 'frontend')
  ?.label ?? 'frontend'
const defaultNamedSprintAgents = {
  frontend: {
    ...defaultAgent('frontend', frontendRosterLabel),
    cli: 'claude-code' as const,
  },
}
const renamedDefaultAgents = reconcileSprintEngineAgents(defaultNamedSprintAgents, sprintState)
assert.notEqual(
  renamedDefaultAgents.frontend?.name,
  frontendRosterLabel,
  'default Sprint Engine role labels should still migrate to generated display names'
)
const stableRenamedDefaultAgents = reconcileSprintEngineAgents(renamedDefaultAgents, sprintState)
assert.equal(
  stableRenamedDefaultAgents,
  renamedDefaultAgents,
  'migrated Sprint Engine names should be identity-stable on unchanged reconcile'
)
assert.equal(stableRenamedDefaultAgents.frontend, renamedDefaultAgents.frontend)

// MC-1450: every reconcile — seeded, minted, recycled — resolves cli/cliModel
// from the run's per-role `roleRuntimes` (run.yaml via the projection), so a
// freshly minted agent can never launch on the CLI's default model.
const runtimeSprintState = {
  ...sprintState,
  roleRuntimes: {
    frontend: { model: 'claude-opus-4-8', cli: 'claude-code' },
    tester: { cli: 'codex' },
  },
  sprintEngineAgents: {
    ...sprintState.sprintEngineAgents,
    'frontend-2': { role: 'frontend' as const, status: 'idle' as const, currentTaskId: null },
  },
}
const mintedAgents = reconcileSprintEngineAgents(directWorkspace.agents, runtimeSprintState)
assert.equal(
  mintedAgents['frontend-2']?.cliModel,
  'claude-opus-4-8',
  'a minted (brand-new) roster record must carry the role-configured model'
)
assert.equal(mintedAgents['frontend-2']?.cli, 'claude-code')
assert.equal(
  mintedAgents.tester?.cli,
  'codex',
  'an existing record must be re-resolved from role config on reconcile'
)
assert.equal(
  mintedAgents.tester?.cliModel,
  undefined,
  'a role configured without a model launches with no --model flag — not a substitute'
)
assert.equal(
  mintedAgents.frontend?.cliModel,
  'claude-opus-4-8',
  'a seeded record with a stale snapshot must be refreshed from role config'
)
// A role absent from the map (legacy run mid-flight) preserves what the record
// already has — never substitutes.
const legacyAgents = reconcileSprintEngineAgents(
  {
    frontend: {
      ...defaultAgent('frontend', 'Legacy Frontend'),
      cli: 'codex' as const,
      cliModel: 'legacy-model',
    },
  },
  sprintState
)
assert.equal(legacyAgents.frontend?.cli, 'codex')
assert.equal(legacyAgents.frontend?.cliModel, 'legacy-model')
// Config is static per run, so a repeat reconcile stays identity-stable.
const stableMintedAgents = reconcileSprintEngineAgents(mintedAgents, runtimeSprintState)
assert.equal(stableMintedAgents, mintedAgents, 'roleRuntimes-resolved reconcile must stay identity-stable')
// An explicit per-agent override (board mid-run picker / wizard per-agent CLI
// pick) outranks the role config and survives every reconcile — including
// `model: null`, which pins the CLI default over a role-configured model.
const overriddenAgents = reconcileSprintEngineAgents(
  {
    ...mintedAgents,
    frontend: {
      ...mintedAgents.frontend!,
      cli: 'codex' as const,
      cliModel: undefined,
      cliRuntimeOverride: { cli: 'codex' as const, model: null },
    },
  },
  runtimeSprintState
)
assert.equal(overriddenAgents.frontend?.cli, 'codex', 'per-agent CLI override outranks role config')
assert.equal(
  overriddenAgents.frontend?.cliModel,
  undefined,
  'override model:null pins the CLI default over the role-configured model'
)
const stableOverriddenAgents = reconcileSprintEngineAgents(overriddenAgents, runtimeSprintState)
assert.equal(stableOverriddenAgents, overriddenAgents, 'override-resolved reconcile stays identity-stable')

// MC-1885: the seat's reasoning-effort level resolves from `roleRuntimes` on the
// same reconcile, and a level-only change must NOT be swallowed by the
// reuse-if-unchanged identity check — a stale record there keeps launching the
// seat at the old effort (the MC-1450 model bug, one field over).
const effortSprintState = {
  ...runtimeSprintState,
  roleRuntimes: {
    ...runtimeSprintState.roleRuntimes,
    frontend: { model: 'claude-opus-4-8', cli: 'claude-code', reasoning: 'high' },
  },
}
const effortAgents = reconcileSprintEngineAgents(mintedAgents, effortSprintState)
assert.equal(effortAgents.frontend?.cliReasoning, 'high', 'the seat level resolves from roleRuntimes')
assert.notEqual(effortAgents.frontend, mintedAgents.frontend, 'a level-only change must produce a fresh record')
const raisedEffortAgents = reconcileSprintEngineAgents(effortAgents, {
  ...effortSprintState,
  roleRuntimes: {
    ...effortSprintState.roleRuntimes,
    frontend: { model: 'claude-opus-4-8', cli: 'claude-code', reasoning: 'max' },
  },
})
assert.equal(raisedEffortAgents.frontend?.cliReasoning, 'max', 'raising only the level still reaches the record')
const stableEffortAgents = reconcileSprintEngineAgents(effortAgents, effortSprintState)
assert.equal(stableEffortAgents, effortAgents, 'an unchanged level stays identity-stable')

runStateSlice.setSprintEngineMaxConcurrentAgents('ws-direct-run-state', 0)
assert.equal(carrier.workspaces[0].sprintEngineAutoState?.maxConcurrentAgents, 1)
runStateSlice.setSprintEngineAutomationMode('ws-direct-run-state', 'manual')
assert.equal(carrier.workspaces[0].sprintEngineAutoState?.desiredMode, 'manual')
assert.equal(carrier.workspaces[0].sprintEngineAutoState?.runtimeState, 'idle')
runStateSlice.setSprintEngineAutomationMode('ws-direct-run-state', 'run_agents')
runStateSlice.applySprintEngineAutomationEvent('ws-direct-run-state', {
  type: 'runner_blocked',
  message: 'Task T1 needs user input.',
  taskId: 'T1',
})
assert.equal(carrier.workspaces[0].sprintEngineAutoState?.desiredMode, 'run_agents')
assert.equal(carrier.workspaces[0].sprintEngineAutoState?.runtimeState, 'blocked')
assert.equal(carrier.workspaces[0].sprintEngineAutoState?.reason, 'blocked_on_input')
assert.equal(carrier.workspaces[0].sprintEngineAutoState?.reasonTaskId, 'T1')
runStateSlice.applySprintEngineAutomationEvent('ws-direct-run-state', {
  type: 'runner_failed',
  reason: 'spawn_failed',
  message: 'frontend could not be started.',
  agentId: 'frontend',
})
assert.equal(carrier.workspaces[0].sprintEngineAutoState?.desiredMode, 'run_agents')
assert.equal(carrier.workspaces[0].sprintEngineAutoState?.runtimeState, 'failed')
assert.equal(carrier.workspaces[0].sprintEngineAutoState?.reason, 'spawn_failed')
assert.equal(carrier.workspaces[0].sprintEngineAutoState?.reasonAgentId, 'frontend')
// A completed run stays `complete` when the end-of-run agent terminal closes
// fire `runner_paused{ terminal_closed }` after the completion transition.
runStateSlice.applySprintEngineAutomationEvent('ws-direct-run-state', { type: 'runner_started' })
runStateSlice.applySprintEngineAutomationEvent('ws-direct-run-state', { type: 'runner_complete' })
assert.equal(carrier.workspaces[0].sprintEngineAutoState?.runtimeState, 'complete')
runStateSlice.applySprintEngineAutomationEvent('ws-direct-run-state', {
  type: 'runner_paused',
  reason: 'terminal_closed',
  message: 'An agent terminal was closed.',
  agentId: 'frontend',
})
assert.equal(carrier.workspaces[0].sprintEngineAutoState?.runtimeState, 'complete')
assert.equal(carrier.workspaces[0].sprintEngineAutoState?.reason, 'all_tasks_done')

runStateSlice.markSprintEngineAgentNotificationDelivered('ws-direct-run-state', ' EVT-1 ')
runStateSlice.markSprintEngineAgentNotificationDelivered('ws-direct-run-state', 'EVT-1')
assert.deepEqual(carrier.workspaces[0].sprintEngineAutoState?.deliveredAgentNotificationEventKeys, ['EVT-1'])

const added = runStateSlice.addSprintEngineMember('ws-direct-run-state', 'tester')
assert.ok(added)
assert.ok(sprintEngineRunState(carrier.workspaces[0])?.sprintEngineAgents[added.id])
assert.equal(sprintEngineRunState(carrier.workspaces[0])?.events.at(-1)?.type, 'member_added')

const storeWorkspaceId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
  name: 'Run State Store',
  folderPath: '/repo/store',
})
useSprintEngineRunStore.getState().setSprintEngineState(storeWorkspaceId, sprintState)
useSprintEngineRunStore.getState().setSprintEngineAutomationMode(storeWorkspaceId, 'run_agents_and_approve_artifacts')
const originalDateNow = Date.now
Date.now = () => 1780801560320
try {
  useSprintEngineRunStore.getState().setSprintEngineCliPermissionPreset(storeWorkspaceId, 'bypass')
} finally {
  Date.now = originalDateNow
}
useSprintEngineRunStore.getState().setSprintEngineCompletionTeardownAt(storeWorkspaceId, 4321)
assert.equal(
  useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === storeWorkspaceId)
    ?.sprintEngineAutoState?.completionTeardownAt,
  4321,
)
// The marker must survive a projection write (setSprintEngineState re-normalizes
// the auto state on every poll).
useSprintEngineRunStore.getState().setSprintEngineState(storeWorkspaceId, sprintState)
assert.equal(
  useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === storeWorkspaceId)
    ?.sprintEngineAutoState?.completionTeardownAt,
  4321,
)
useSprintEngineRunStore.getState().setSprintEngineCompletionTeardownAt(storeWorkspaceId, undefined)
assert.equal(
  useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === storeWorkspaceId)
    ?.sprintEngineAutoState?.completionTeardownAt,
  undefined,
)
const storeWorkspace = useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === storeWorkspaceId)
assert.ok(storeWorkspace)
assert.equal(sprintEngineRunState(storeWorkspace)?.goal, 'Validate run-state slice')
assert.equal(storeWorkspace.sprintEngineAutoState?.desiredMode, 'run_agents_and_approve_artifacts')
assert.equal(storeWorkspace.sprintEngineAutoState?.cliPermissionPreset, 'bypass')
assert.equal(storeWorkspace.sprintEngineAutoState?.changedAt, 1780801560320)
assert.equal(
  useWorkspaceStore.getState().appSettings.sprintEngineRunSettings[
    sprintEngineRunSettingsKey(sprintEngineRunContext(storeWorkspace)?.statePath)
  ]?.cliPermissionPreset,
  'bypass',
)

useWorkspaceStore.getState().setLastAgentSpawnPermissionPreset('bypass')
const inheritedPermissionWorkspaceId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
  name: 'Inherited Sprint Permission',
  folderPath: '/repo/inherited',
  sprintEngineModule: { state: sprintState },
})
const inheritedPermissionWorkspace = useWorkspaceStore.getState().workspaces.find(
  (workspace) => workspace.id === inheritedPermissionWorkspaceId,
)
assert.equal(
  inheritedPermissionWorkspace?.sprintEngineAutoState?.cliPermissionPreset,
  'bypass',
  'new Sprint Engine workspaces inherit the app-level permission default when no run override exists',
)

// Task 3 — no-op `setSprintEngineState` writes must not churn the `workspaces`
// array reference (which fans a re-render out to every subscriber). A logically
// identical projection re-apply leaves the reference equal; a real change moves
// it.
const noopWorkspaceId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
  name: 'No-op Projection',
  folderPath: '/repo/noop',
})
useSprintEngineRunStore.getState().setSprintEngineState(noopWorkspaceId, sprintState)
const afterFirstSet = useWorkspaceStore.getState().workspaces
const noopWorkspaceAfterFirstSet = afterFirstSet.find((workspace) => workspace.id === noopWorkspaceId)
assert.ok(sprintEngineRunState(noopWorkspaceAfterFirstSet!), 'sprint engine state should be applied')

// Re-apply the identical state: array, workspace object, and nested projection
// fields must all keep their identity so `useShallow`/array selectors skip.
useSprintEngineRunStore.getState().setSprintEngineState(noopWorkspaceId, sprintState)
const afterIdenticalSet = useWorkspaceStore.getState().workspaces
assert.equal(
  afterIdenticalSet,
  afterFirstSet,
  'identical setSprintEngineState must preserve the workspaces array reference',
)
const noopWorkspaceAfterIdenticalSet = afterIdenticalSet.find((workspace) => workspace.id === noopWorkspaceId)
assert.equal(
  noopWorkspaceAfterIdenticalSet,
  noopWorkspaceAfterFirstSet,
  'identical setSprintEngineState must preserve the workspace object reference',
)
assert.equal(
  sprintEngineRunState(noopWorkspaceAfterIdenticalSet!),
  sprintEngineRunState(noopWorkspaceAfterFirstSet!),
  'identical setSprintEngineState must preserve the bag projection identity',
)
assert.equal(
  noopWorkspaceAfterIdenticalSet?.agents,
  noopWorkspaceAfterFirstSet?.agents,
  'identical setSprintEngineState must preserve the agents map identity',
)

// A real change must move the array reference and update the projection.
const changedSprintState = createInitialSprintEngineState({
  goal: 'Changed projection goal',
  name: 'Run State Team',
  roleCounts: { frontend: 1, tester: 1 },
})
useSprintEngineRunStore.getState().setSprintEngineState(noopWorkspaceId, changedSprintState)
const afterChangedSet = useWorkspaceStore.getState().workspaces
assert.notEqual(
  afterChangedSet,
  afterIdenticalSet,
  'a changed setSprintEngineState must produce a new workspaces array reference',
)
assert.equal(
  sprintEngineRunState(afterChangedSet.find((workspace) => workspace.id === noopWorkspaceId)!)?.goal,
  'Changed projection goal',
  'a changed setSprintEngineState must apply the new projection',
)

// Clearing the projection (normalized === null) must also move the reference and
// reset mode to standard.
useSprintEngineRunStore.getState().setSprintEngineState(noopWorkspaceId, null)
const afterClearSet = useWorkspaceStore.getState().workspaces
assert.notEqual(
  afterClearSet,
  afterChangedSet,
  'clearing setSprintEngineState must produce a new workspaces array reference',
)
const noopWorkspaceAfterClear = afterClearSet.find((workspace) => workspace.id === noopWorkspaceId)
assert.equal(sprintEngineRunState(noopWorkspaceAfterClear!), null, 'cleared projection should be null')
assert.equal(noopWorkspaceAfterClear?.mode, 'standard', 'cleared projection should reset mode to standard')

// Re-clearing an already-cleared projection is itself a no-op.
useSprintEngineRunStore.getState().setSprintEngineState(noopWorkspaceId, null)
assert.equal(
  useWorkspaceStore.getState().workspaces,
  afterClearSet,
  're-clearing an already-standard workspace must preserve the workspaces array reference',
)

console.log('runStateSlice.test.ts: ok')
