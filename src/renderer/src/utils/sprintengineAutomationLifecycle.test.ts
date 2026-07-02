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

// `complete` is terminal: the async agent-terminal-close events that follow a
// finished run must not demote it back to paused/failed.
const completeThenTerminalClosed = transitionSprintEngineAutomation(
  complete,
  { type: 'runner_paused', reason: 'terminal_closed', message: 'An agent terminal was closed.', agentId: 'frontend' },
  600,
)
assert.equal(completeThenTerminalClosed.runtimeState, 'complete')
assert.equal(completeThenTerminalClosed.reason, 'all_tasks_done')
assert.equal(completeThenTerminalClosed.changedAt, 500)
assert.equal(sprintEngineAutomationShouldRun(completeThenTerminalClosed), false)

const completeThenFailed = transitionSprintEngineAutomation(
  complete,
  { type: 'runner_failed', reason: 'spawn_failed', message: 'late spawn failure', agentId: 'backend' },
  610,
)
assert.equal(completeThenFailed.runtimeState, 'complete')

// Lifecycle-neutral pending-spawn bookkeeping still passes through `complete`
// without moving the runtime state.
const completeThenPendingSpawns = transitionSprintEngineAutomation(
  complete,
  { type: 'pending_spawns_changed', pendingSpawns: [{ taskId: 'T9', agentId: 'frontend' }] },
  615,
)
assert.equal(completeThenPendingSpawns.runtimeState, 'complete')
assert.deepEqual(completeThenPendingSpawns.pendingSpawns, [{ taskId: 'T9', agentId: 'frontend' }])

// Re-selecting an automation mode is the explicit escape hatch out of complete.
const completeThenResumed = transitionSprintEngineAutomation(
  complete,
  { type: 'user_set_mode', mode: 'run_agents' },
  620,
)
assert.equal(completeThenResumed.runtimeState, 'running')
assert.equal(completeThenResumed.desiredMode, 'run_agents')
assert.equal(completeThenResumed.reason, undefined)
assert.equal(sprintEngineAutomationShouldRun(completeThenResumed), true)

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
