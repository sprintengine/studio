import assert from 'node:assert/strict'
import type { SprintEngineAutoState } from '../types/workspace'
import {
  sprintEngineAutomationInitialStateForMode,
  sprintEngineAutomationModeForRunOptions,
  sprintEngineAutomationShouldRun,
  transitionSprintEngineAutomation,
} from './sprintengineAutomationLifecycle'

function baseAutoState(overrides: Partial<SprintEngineAutoState> = {}): SprintEngineAutoState {
  return {
    desiredMode: 'manual',
    runtimeState: 'idle',
    reason: undefined,
    reasonMessage: undefined,
    reasonTaskId: undefined,
    reasonAgentId: undefined,
    changedAt: undefined,
    keepDoneAgentTerminals: false,
    cliPermissionPreset: 'default',
    maxConcurrentAgents: 3,
    pendingSpawns: [],
    deliveredAgentNotificationEventKeys: [],
    ...overrides,
  }
}

const runAgents = transitionSprintEngineAutomation(
  baseAutoState(),
  { type: 'user_set_mode', mode: 'run_agents' },
  100,
)
assert.equal(runAgents.desiredMode, 'run_agents')
assert.equal(runAgents.runtimeState, 'running')
assert.equal(sprintEngineAutomationShouldRun(runAgents), true)

const blocked = transitionSprintEngineAutomation(
  runAgents,
  { type: 'runner_blocked', message: 'T3 needs input.', taskId: 'T3' },
  200,
)
assert.equal(blocked.desiredMode, 'run_agents')
assert.equal(blocked.runtimeState, 'blocked')
assert.equal(blocked.reason, 'blocked_on_input')
assert.equal(blocked.reasonMessage, 'T3 needs input.')
assert.equal(blocked.reasonTaskId, 'T3')
assert.equal(sprintEngineAutomationShouldRun(blocked), false)

const resumed = transitionSprintEngineAutomation(blocked, { type: 'runner_started' }, 300)
assert.equal(resumed.desiredMode, 'run_agents')
assert.equal(resumed.runtimeState, 'running')
assert.equal(resumed.reason, undefined)
assert.equal(resumed.reasonMessage, undefined)
assert.equal(sprintEngineAutomationShouldRun(resumed), true)

const failed = transitionSprintEngineAutomation(
  resumed,
  { type: 'runner_failed', reason: 'spawn_failed', message: 'frontend failed.', agentId: 'frontend' },
  400,
)
assert.equal(failed.desiredMode, 'run_agents')
assert.equal(failed.runtimeState, 'failed')
assert.equal(failed.reason, 'spawn_failed')
assert.equal(failed.reasonAgentId, 'frontend')
assert.equal(sprintEngineAutomationShouldRun(failed), false)

const complete = transitionSprintEngineAutomation(resumed, { type: 'runner_complete' }, 500)
assert.equal(complete.desiredMode, 'run_agents')
assert.equal(complete.runtimeState, 'complete')
assert.equal(complete.reason, 'all_tasks_done')
assert.equal(sprintEngineAutomationShouldRun(complete), false)

const manual = transitionSprintEngineAutomation(
  { ...resumed, pendingSpawns: [{ taskId: 'T1', agentId: 'frontend' }] },
  { type: 'user_set_mode', mode: 'manual' },
  600,
)
assert.equal(manual.desiredMode, 'manual')
assert.equal(manual.runtimeState, 'idle')
assert.equal(manual.reason, 'user_selected_manual')
assert.deepEqual(manual.pendingSpawns, [])
assert.equal(sprintEngineAutomationShouldRun(manual), false)

assert.equal(
  sprintEngineAutomationModeForRunOptions({ startRunner: false, autoApproveArtifacts: false }),
  'manual',
)
assert.equal(
  sprintEngineAutomationModeForRunOptions({ startRunner: true, autoApproveArtifacts: false }),
  'run_agents',
)
assert.equal(
  sprintEngineAutomationModeForRunOptions({ startRunner: false, autoApproveArtifacts: true }),
  'run_agents_and_approve_artifacts',
)

const initialApprove = sprintEngineAutomationInitialStateForMode('run_agents_and_approve_artifacts', 700)
assert.equal(initialApprove.desiredMode, 'run_agents_and_approve_artifacts')
assert.equal(initialApprove.runtimeState, 'running')

console.log('sprintengineAutomationLifecycle.test.ts: ok')
