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
  sprintEngineAgentHasLiveRunWork(liveWorkState, baseAutoState(), 'developer-1'),
  true,
  'an active claimant close is an intervention'
)
assert.equal(
  sprintEngineAgentHasLiveRunWork(liveWorkState, baseAutoState(), 'developer-2'),
  false,
  'a worker whose task is in its publish→verdict window is routine teardown — MC-1444 disposes it by design'
)
assert.equal(
  sprintEngineAgentHasLiveRunWork(liveWorkState, baseAutoState(), 'tester-1'),
  true,
  'an agent whose owned task needs input still has a live session worth protecting'
)
assert.equal(
  sprintEngineAgentHasLiveRunWork(
    liveWorkState,
    baseAutoState({ pendingSpawns: [{ taskId: 'T9', agentId: 'developer-3', startedAt: 1 }] }),
    'developer-3'
  ),
  true,
  'a pending spawn counts as live work — projection lag must not misclassify an early close'
)
// Removed: the gate-claim ("reviewer holds a gate with no task claim") live-work
// case tested deleted gate machinery (MC-1542 single-owner tasks — currentGateId
// no longer exists; a task in its review phase is held via currentTaskId).
assert.equal(
  sprintEngineAgentHasLiveRunWork(liveWorkState, baseAutoState(), 'frontend'),
  true,
  'an active dispatch counts as live work before the claim lands'
)
assert.equal(sprintEngineAgentHasLiveRunWork(liveWorkState, baseAutoState(), undefined), false)
assert.equal(sprintEngineAgentHasLiveRunWork(null, baseAutoState(), 'developer-1'), false)

// The dormancy bit: only the terminal `complete` runtime state is dormant. Every
// other lifecycle state — including a finished-but-not-yet-reconciled run stuck in
// `paused` — is live and keeps its renderer activity sources running.
function dormancyWorkspace(runtimeState?: SprintEngineAutomationRuntimeState): Workspace {
  return { sprintEngineAutoState: runtimeState ? baseAutoState({ runtimeState }) : undefined } as unknown as Workspace
}
assert.equal(isSprintEngineWorkspaceDormant(dormancyWorkspace('complete')), true)
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
