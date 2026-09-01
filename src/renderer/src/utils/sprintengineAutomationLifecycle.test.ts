import assert from 'node:assert/strict'
import type { SprintEngineAutomationRuntimeState, SprintEngineAutoState, Workspace } from '../types/workspace'
import {
  isSprintEngineWorkspaceDormant,
  sprintEngineAgentHasLiveRunWork,
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
    cliPermissionPreset: 'manual',
    maxConcurrentAgents: 3,
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

// Cancellation (MC-1604) is a terminal state mirroring `complete`: the run stops
// running, carries the `run_canceled` reason, and does not auto-resume.
const canceled = transitionSprintEngineAutomation(resumed, { type: 'runner_canceled' }, 700)
assert.equal(canceled.desiredMode, 'run_agents')
assert.equal(canceled.runtimeState, 'canceled')
assert.equal(canceled.reason, 'run_canceled')
assert.equal(sprintEngineAutomationShouldRun(canceled), false)

// Terminal like `complete`: the async terminal-close events from the cancel
// teardown must not demote it back to paused.
const canceledThenTerminalClosed = transitionSprintEngineAutomation(
  canceled,
  { type: 'runner_paused', reason: 'terminal_closed', message: 'An agent terminal was closed.', agentId: 'developer-1' },
  710,
)
assert.equal(canceledThenTerminalClosed.runtimeState, 'canceled')
assert.equal(canceledThenTerminalClosed.reason, 'run_canceled')
assert.equal(canceledThenTerminalClosed.changedAt, 700)
assert.equal(sprintEngineAutomationShouldRun(canceledThenTerminalClosed), false)

// A late spawn failure also cannot move a canceled run off its terminal state.
const canceledThenFailed = transitionSprintEngineAutomation(
  canceled,
  { type: 'runner_failed', reason: 'spawn_failed', message: 'late spawn failure', agentId: 'developer-2' },
  715,
)
assert.equal(canceledThenFailed.runtimeState, 'canceled')

// Re-selecting a mode is the only escape out of a canceled run.
const canceledThenResumed = transitionSprintEngineAutomation(
  canceled,
  { type: 'user_set_mode', mode: 'run_agents' },
  730,
)
assert.equal(canceledThenResumed.runtimeState, 'running')
assert.equal(canceledThenResumed.reason, undefined)
assert.equal(sprintEngineAutomationShouldRun(canceledThenResumed), true)

const manual = transitionSprintEngineAutomation(
  resumed,
  { type: 'user_set_mode', mode: 'manual' },
  600,
)
assert.equal(manual.desiredMode, 'manual')
assert.equal(manual.runtimeState, 'idle')
assert.equal(manual.reason, 'user_selected_manual')
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

// MC-1450 Phase 1b: an agent-terminal close only counts as an intervention
// (and pauses the run) when the closed agent holds live run work. Routine
// MC-1444 per-task teardown — the worker is 'left', its task done/reviewed —
// must be lifecycle-neutral.
const liveWorkState = {
  sprintEngineAgents: {
    'developer-1': { role: 'developer', status: 'running' as const, currentTaskId: 'T1' },
    'developer-2': { role: 'developer', status: 'idle' as const, currentTaskId: null },
    'tester-1': { role: 'tester', status: 'idle' as const, currentTaskId: null },
    // A dispatched agent may not have claimed yet.
    'frontend': {
      role: 'frontend',
      status: 'idle' as const,
      currentTaskId: null,
      currentDispatch: { dispatchId: 'DISP-1', reason: 'task_claimed' } as never,
    },
  },
  tasks: [
    { ownerAgentId: 'developer-1', status: 'in_progress' },
    { ownerAgentId: 'developer-2', status: 'review' },
    { ownerAgentId: 'tester-1', status: 'needs_input' },
  ] as never,
}
assert.equal(
  sprintEngineAgentHasLiveRunWork(liveWorkState,'developer-1'),
  true,
  'an active claimant close is an intervention'
)
assert.equal(
  sprintEngineAgentHasLiveRunWork(liveWorkState,'developer-2'),
  false,
  'a worker whose task is in its publish→verdict window is routine teardown — MC-1444 disposes it by design'
)
assert.equal(
  sprintEngineAgentHasLiveRunWork(liveWorkState,'tester-1'),
  true,
  'an agent whose owned task needs input still has a live session worth protecting'
)
// Removed: the pending-spawn live-work case tested deleted machinery (MC-1592
// pool reconciler — the persisted pending-spawn ledger no longer exists; a
// just-spawned worker is protected by its live session, not by store residue).
// Removed: the gate-claim ("reviewer holds a gate with no task claim") live-work
// case tested deleted gate machinery (MC-1542 single-owner tasks — currentGateId
// no longer exists; a task in its review phase is held via currentTaskId).
assert.equal(
  sprintEngineAgentHasLiveRunWork(liveWorkState,'frontend'),
  true,
  'an active dispatch counts as live work before the claim lands'
)
assert.equal(sprintEngineAgentHasLiveRunWork(liveWorkState, undefined), false)
assert.equal(sprintEngineAgentHasLiveRunWork(null, 'developer-1'), false)

// The dormancy bit: only the terminal `complete` runtime state is dormant. Every
// other lifecycle state — including a finished-but-not-yet-reconciled run stuck in
// `paused` — is live and keeps its renderer activity sources running.
function dormancyWorkspace(runtimeState?: SprintEngineAutomationRuntimeState): Workspace {
  return { sprintEngineAutoState: runtimeState ? baseAutoState({ runtimeState }) : undefined } as unknown as Workspace
}
assert.equal(isSprintEngineWorkspaceDormant(dormancyWorkspace('complete')), true)
assert.equal(
  isSprintEngineWorkspaceDormant(dormancyWorkspace('canceled')),
  true,
  'a canceled run is terminal and dormant — polling stops',
)
for (const runtimeState of ['idle', 'running', 'paused', 'blocked', 'failed'] as const) {
  assert.equal(
    isSprintEngineWorkspaceDormant(dormancyWorkspace(runtimeState)),
    false,
    `runtimeState=${runtimeState} is not dormant`,
  )
}
assert.equal(isSprintEngineWorkspaceDormant(dormancyWorkspace()), false, 'no auto-state is not dormant')
assert.equal(isSprintEngineWorkspaceDormant(null), false)
assert.equal(isSprintEngineWorkspaceDormant(undefined), false)

console.log('sprintengineAutomationLifecycle.test.ts: ok')
