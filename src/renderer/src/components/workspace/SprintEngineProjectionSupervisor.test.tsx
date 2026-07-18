import assert from 'node:assert/strict'

import type { SprintEngineState, Workspace } from '../../types/workspace'
import { getTimerRegistrations } from '../../utils/diagnostics/timerRegistry'
import {
  createProjectionPollLoop,
  sprintEngineWorkspacesNeedProjectionPolling,
} from './SprintEngineProjectionSupervisor'

// T2 regression: the projection supervisor must hold the poll interval ONLY while
// some sprint workspace still needs it, and must fully unregister the timer when
// none do (quiescence). Covers (1) the derived "needs polling" predicate across
// the dormancy/hydration states that gate it, and (2) the arm/tear-down/re-arm
// lifecycle proven through the diagnostics timer registry.

const POLL_LABEL = 'SprintEngine projection poll'
function pollRegistrations(): number {
  return getTimerRegistrations().filter((entry) => entry.label === POLL_LABEL).length
}

// Carries a done task: quiescence now requires the hydrated state to ITSELF
// read complete (isCompletedSprintEngineRun), not merely be non-null — a stale
// pre-completion snapshot froze the board at N-1/N (see
// canStopPollingCompletedSprintEngineProjection condition 2).
const HYDRATED_STATE = {
  name: 'Run',
  tasks: [{ id: 'T1', title: 'Done task', role: 'developer', status: 'done' }],
  artifacts: [],
} as unknown as SprintEngineState

function sprintWorkspace(id: string, overrides: Partial<Workspace>): Workspace {
  return {
    id,
    name: id,
    mode: 'sprintengine',
    agents: {},
    sprintEngineContext: { statePath: `/tmp/${id}/run.yaml`, teamSlug: id, teamName: id },
    ...overrides,
  } as unknown as Workspace
}

// ── Predicate ───────────────────────────────────────────────────────────────
// An actively-running sprint run always needs polling.
const activeRun = sprintWorkspace('active', {
  sprintEngineAutoState: { runtimeState: 'running' } as Workspace['sprintEngineAutoState'],
  sprintEngineState: HYDRATED_STATE,
})
// A finished, hydrated, torn-down run is skippable (dormant quiescent).
const dormantSkippable = sprintWorkspace('dormant', {
  sprintEngineAutoState: {
    runtimeState: 'complete',
    completionTeardownAt: 1000,
  } as Workspace['sprintEngineAutoState'],
  sprintEngineState: HYDRATED_STATE,
})
// A cold-restart dormant run (complete + torn down but board not yet rehydrated)
// still needs the one hydration read, so it must keep polling until hydrated.
const coldDormant = sprintWorkspace('cold', {
  sprintEngineAutoState: {
    runtimeState: 'complete',
    completionTeardownAt: 1000,
  } as Workspace['sprintEngineAutoState'],
  sprintEngineState: null,
})
const plainWorkspace = { id: 'plain', name: 'plain', mode: 'standard', agents: {} } as unknown as Workspace

const allIds = new Set(['active', 'dormant', 'cold', 'plain'])

assert.equal(
  sprintEngineWorkspacesNeedProjectionPolling([activeRun, dormantSkippable], allIds),
  true,
  'an active run keeps the poll needed',
)
assert.equal(
  sprintEngineWorkspacesNeedProjectionPolling([coldDormant, dormantSkippable], allIds),
  true,
  'a cold-restart dormant run needs its one hydration read',
)
assert.equal(
  sprintEngineWorkspacesNeedProjectionPolling([dormantSkippable], allIds),
  false,
  'a fully skippable dormant run needs no poll',
)
assert.equal(
  sprintEngineWorkspacesNeedProjectionPolling([plainWorkspace], allIds),
  false,
  'non-sprint workspaces never require the sprint projection poll',
)
assert.equal(
  sprintEngineWorkspacesNeedProjectionPolling([], allIds),
  false,
  'no workspaces => no poll',
)
assert.equal(
  sprintEngineWorkspacesNeedProjectionPolling([activeRun], new Set(['dormant'])),
  false,
  'a sprint run outside this window id set is ignored',
)
console.log('SprintEngineProjectionSupervisor.test.tsx: predicate transitions — ok')

// ── Loop lifecycle via the timer registry ────────────────────────────────────
assert.equal(pollRegistrations(), 0, 'no poll timer is registered before arming')

let ticks = 0
const cleared: number[] = []
let nextIntervalId = 1
const loop = createProjectionPollLoop({
  cadenceMs: 4000,
  runTick: () => {
    ticks += 1
  },
  setInterval: () => nextIntervalId++,
  clearInterval: (id) => cleared.push(id),
})

loop.sync(true)
assert.equal(pollRegistrations(), 1, 'arming registers exactly one poll timer')
assert.equal(ticks, 1, 'arming fires one immediate hydration tick before the interval')

loop.sync(true)
assert.equal(pollRegistrations(), 1, 're-syncing while needed is idempotent (no duplicate timer)')
assert.equal(ticks, 1, 'idempotent re-sync does not fire another immediate tick')

loop.sync(false)
assert.equal(pollRegistrations(), 0, 'quiescence unregisters the poll timer entirely')
assert.equal(cleared.length, 1, 'tearing down clears the interval')

loop.sync(true)
assert.equal(pollRegistrations(), 1, 'a later need re-arms the interval within one transition')
assert.equal(ticks, 2, 're-arming fires a fresh immediate tick')

loop.dispose()
assert.equal(pollRegistrations(), 0, 'dispose leaves no registered poll timer')
assert.equal(cleared.length, 2, 'dispose clears the live interval')
console.log('SprintEngineProjectionSupervisor.test.tsx: arm/teardown/re-arm via timer registry — ok')

console.log('SprintEngineProjectionSupervisor.test.tsx: ok')
