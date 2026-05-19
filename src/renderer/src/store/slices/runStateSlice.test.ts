import assert from 'node:assert/strict'

import type { LayoutTemplate, MultiloopState, Workspace } from '../../types/workspace'
import { createInitialSprintEngineState } from '../../utils/sprintengine'
import { useWorkspaceStore } from '../workspaceStore'
import { defaultAgent, defaultEditorState } from './agentsSlice'
import {
  createRunStateSlice,
  defaultMultiloopAutoState,
  defaultSprintEngineAutoState,
  normalizeMultiloopAutoState,
  normalizeSprintEngineAutoState,
  normalizeSprintEngineRoleCliDefaults,
} from './runStateSlice'

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

function multiloopState(name = 'release-loop'): MultiloopState {
  return {
    schemaVersion: 1,
    loop: {
      name,
      displayName: 'Release Loop',
      finalGoal: 'Keep run state separated.',
      iteration: 1,
      status: 'active',
      currentMilestoneId: 'M1',
      createdAt: '2026-05-19T10:00:00Z',
      updatedAt: '2026-05-19T11:00:00Z',
    },
    roadmap: [
      {
        id: 'M1',
        title: 'Run State',
        goal: 'Validate run-state slice behavior.',
        status: 'active',
        entryCriteria: [],
        acceptanceCriteria: [],
        finalGoalContribution: 'Protects store decomposition.',
        learnedFacts: [],
        blockers: [],
        reviewVerdicts: [],
        sprintEngine: null,
      },
    ],
    tasks: [],
    artifacts: [],
    agents: {},
    decisions: [],
    blockers: [],
  }
}

const legacySprintAuto = normalizeSprintEngineAutoState({
  enabled: true,
  autoApproveArtifacts: true,
  keepDoneAgentTerminals: true,
  cliPermissionPreset: 'invalid' as never,
  maxConcurrentAgents: 99,
  pending: { taskId: 'T1', gateId: '', agentId: 'frontend', startedAt: 123 },
  deliveredAgentNotificationEventIds: [' EVT-1 ', '', 'EVT-2'],
})
assert.equal(legacySprintAuto.enabled, true)
assert.equal(legacySprintAuto.autoApproveArtifacts, true)
assert.equal(legacySprintAuto.keepDoneAgentTerminals, true)
assert.equal(legacySprintAuto.cliPermissionPreset, 'default')
assert.equal(legacySprintAuto.maxConcurrentAgents, 10)
assert.deepEqual(legacySprintAuto.pendingSpawns, [{ taskId: 'T1', agentId: 'frontend', startedAt: 123 }])
assert.deepEqual(legacySprintAuto.deliveredAgentNotificationEventKeys, [' EVT-1 ', 'EVT-2'])

const normalizedMultiloopAuto = normalizeMultiloopAutoState({
  enabled: true,
  cliPermissionPreset: 'bypass_all',
  maxConcurrentAgents: 9,
  coordinatorAutoSpawnKey: 'loop-1',
  pendingSpawns: [
    { role: 'coordinator', agentId: 'coordinator-1', taskId: null, startedAt: 1 },
    { role: 'not-a-role' as never, agentId: 'bad-agent', taskId: 'bad' },
  ],
})
assert.equal(normalizedMultiloopAuto.maxConcurrentAgents, 4)
assert.equal(normalizedMultiloopAuto.cliPermissionPreset, 'bypass_all')
assert.deepEqual(normalizedMultiloopAuto.pendingSpawns, [
  { role: 'coordinator', agentId: 'coordinator-1', taskId: null, startedAt: 1 },
])
assert.equal(normalizeSprintEngineRoleCliDefaults({ tester: 'claude' }).tester, 'claude')
assert.equal(normalizeSprintEngineRoleCliDefaults({ tester: 'bad' as never }).tester, 'codex')

const sprintState = createInitialSprintEngineState({
  goal: 'Validate run-state slice',
  name: 'Run State Team',
  roleCounts: { frontend: 1, tester: 1 },
})
const initialMultiloopState = multiloopState()
const carrier: { workspaces: Workspace[] } = {
  workspaces: [
    {
      id: 'ws-direct-run-state',
      name: 'Run State Direct',
      mode: 'standard',
      folderPath: '/repo',
      agents: {
        specialist: defaultAgent('specialist', 'Specialist', 'specialist'),
      },
      layoutModel: standardTemplate.layout,
      editorState: defaultEditorState(),
      sprintEngineState: null,
      sprintEngineAutoState: defaultSprintEngineAutoState(),
      multiloopState: null,
      multiloopAutoState: defaultMultiloopAutoState(),
    },
  ],
}
const runStateSlice = createRunStateSlice((mutator) => mutator(carrier))

runStateSlice.setSprintEngineState('ws-direct-run-state', sprintState)
let directWorkspace = carrier.workspaces[0]
assert.equal(directWorkspace.mode, 'sprintengine')
assert.equal(directWorkspace.sprintEngineState?.goal, 'Validate run-state slice')
assert.equal(directWorkspace.sprintEngineContext?.teamSlug, 'run-state-team')
assert.ok(directWorkspace.agents.specialist, 'specialist agents should survive Sprint Engine roster reconciliation')
assert.ok(directWorkspace.agents.frontend, 'Sprint Engine roster agents should be reconciled into workspace agents')
assert.notEqual(directWorkspace.sprintEngineState, directWorkspace.multiloopState)

runStateSlice.setSprintEngineMaxConcurrentAgents('ws-direct-run-state', 0)
assert.equal(carrier.workspaces[0].sprintEngineAutoState?.maxConcurrentAgents, 1)
runStateSlice.setSprintEngineAutoPendingSpawns('ws-direct-run-state', [
  { taskId: 'T1', agentId: 'frontend', startedAt: 1 },
])
runStateSlice.setSprintEngineAutoEnabled('ws-direct-run-state', false)
assert.deepEqual(carrier.workspaces[0].sprintEngineAutoState?.pendingSpawns, [])
runStateSlice.markSprintEngineAgentNotificationDelivered('ws-direct-run-state', ' EVT-1 ')
runStateSlice.markSprintEngineAgentNotificationDelivered('ws-direct-run-state', 'EVT-1')
assert.deepEqual(carrier.workspaces[0].sprintEngineAutoState?.deliveredAgentNotificationEventKeys, ['EVT-1'])

const added = runStateSlice.addSprintEngineMember('ws-direct-run-state', 'tester')
assert.ok(added)
assert.ok(carrier.workspaces[0].sprintEngineState?.sprintEngineAgents[added.id])
assert.equal(carrier.workspaces[0].sprintEngineState?.events.at(-1)?.type, 'member_added')

runStateSlice.setMultiloopState('ws-direct-run-state', initialMultiloopState)
directWorkspace = carrier.workspaces[0]
assert.equal(directWorkspace.mode, 'multiloop')
assert.equal(directWorkspace.sprintEngineState?.name, 'Run State Team')
assert.equal(directWorkspace.multiloopState?.loop.name, 'release-loop')
assert.equal(directWorkspace.multiloopContext?.loopSlug, 'release-loop')
runStateSlice.setMultiloopAutoPendingSpawns('ws-direct-run-state', [
  { role: 'coordinator', agentId: 'coordinator-1', taskId: null },
  { role: 'invalid' as never, agentId: 'bad-agent', taskId: 'bad' },
])
assert.deepEqual(carrier.workspaces[0].multiloopAutoState?.pendingSpawns, [
  { role: 'coordinator', agentId: 'coordinator-1', taskId: null },
])
runStateSlice.setMultiloopAutoEnabled('ws-direct-run-state', false)
assert.deepEqual(carrier.workspaces[0].multiloopAutoState?.pendingSpawns, [])
runStateSlice.setMultiloopState('ws-direct-run-state', null)
assert.equal(carrier.workspaces[0].mode, 'sprintengine')
assert.equal(carrier.workspaces[0].multiloopState, null)

const storeWorkspaceId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
  name: 'Run State Store',
  folderPath: '/repo/store',
})
useWorkspaceStore.getState().setSprintEngineState(storeWorkspaceId, sprintState)
useWorkspaceStore.getState().setSprintEngineAutoApproveArtifacts(storeWorkspaceId, true)
useWorkspaceStore.getState().setSprintEngineCliPermissionPreset(storeWorkspaceId, 'bypass_all')
useWorkspaceStore.getState().setMultiloopState(storeWorkspaceId, initialMultiloopState)
useWorkspaceStore.getState().setMultiloopCoordinatorAutoSpawnKey(storeWorkspaceId, 'coordinator-key')

const storeWorkspace = useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === storeWorkspaceId)
assert.ok(storeWorkspace)
assert.equal(storeWorkspace.sprintEngineState?.goal, 'Validate run-state slice')
assert.equal(storeWorkspace.multiloopState?.loop.name, 'release-loop')
assert.equal(storeWorkspace.sprintEngineAutoState?.autoApproveArtifacts, true)
assert.equal(storeWorkspace.sprintEngineAutoState?.cliPermissionPreset, 'bypass_all')
assert.equal(storeWorkspace.multiloopAutoState?.coordinatorAutoSpawnKey, 'coordinator-key')

console.log('runStateSlice.test.ts: ok')
