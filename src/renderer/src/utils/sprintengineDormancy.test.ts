import assert from 'node:assert/strict'

import type {
  SprintEngineAutoState,
  SprintEngineAutomationEvent,
  SprintEngineState,
  Workspace,
} from '../types/workspace'
import {
  canStopPollingCompletedSprintEngineProjection,
  enterSprintEngineDormancy,
  refreshSprintEngineWorkspaceProjection,
  type SprintEngineDormancyPorts,
  type SprintEngineProjectionRefreshPorts,
} from './sprintengineProjectionRefresh'
import {
  isSprintEngineWorkspaceDormant,
  sprintEngineAutomationShouldRun,
} from './sprintengineAutomationLifecycle'
import {
  createAutoRunPollerController,
  enterDormancyIfRunComplete,
} from '../components/workspace/SprintEngineAutoRunSupervisor'
import {
  createProjectionPollLoop,
  sprintEngineWorkspacesNeedProjectionPolling,
} from '../components/workspace/SprintEngineProjectionSupervisor'
import { getTimerRegistrations } from './diagnostics/timerRegistry'

// T6 cross-module integration net for MC-1453 dormancy quiescence. Each block
// proves one seam that the per-file unit tests own individually, wired together
// through the REAL shared collaborators (the completion-teardown marker, the T1
// display-only refresh, the two supervisor "needs me" derivations, and the live
// diagnostics timer registry) so a regression in how the modules compose — not
// just how each behaves alone — fails here.

const PROJECTION_LABEL = 'SprintEngine projection poll'
const AUTO_RUN_LABEL = 'SprintEngine auto-run poll'
const FIXED_NOW = 4321

// The reconcile fires teardown without awaiting it; drain the microtask queue so
// the post-teardown marker write has landed before asserting.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

function labelCount(label: string): number {
  return getTimerRegistrations().filter((entry) => entry.label === label).length
}

function autoState(overrides: Partial<SprintEngineAutoState> = {}): SprintEngineAutoState {
  return {
    desiredMode: 'run_agents',
    runtimeState: 'running',
    cliPermissionPreset: 'default',
    maxConcurrentAgents: 1,
    pendingSpawns: [],
    deliveredAgentNotificationEventKeys: [],
    ...overrides,
  }
}

const HYDRATED_STATE = { name: 'Run', goal: '', tasks: [], artifacts: [] } as unknown as SprintEngineState

function sprintWorkspace(id: string, overrides: Partial<Workspace>): Workspace {
  return {
    id,
    name: id,
    folderPath: `/tmp/${id}`,
    mode: 'sprintengine',
    agents: {},
    sprintEngineContext: {
      statePath: `/tmp/${id}/.multi-code/sprintengine/${id}/run.yaml`,
      teamSlug: id,
      teamName: id,
    },
    ...overrides,
  } as unknown as Workspace
}

// ── 1. Dual-path teardown-once ────────────────────────────────────────────────
// A run first driven complete by the auto-run hard-completion gate
// (`enterDormancyIfRunComplete`) and then re-entered by the projection reconcile
// path (`enterSprintEngineDormancy`) fires `runner_complete` and tears its agents
// down EXACTLY ONCE — because both paths share the persisted completion-teardown
// marker on the same `sprintEngineAutoState`.
async function testDualPathTeardownRunsExactlyOnce(): Promise<void> {
  const state = { ...autoState({ runtimeState: 'running', completionTeardownAt: undefined }) }
  const workspace = { id: 'ws', sprintEngineAutoState: state } as Pick<
    Workspace,
    'id' | 'sprintEngineAutoState'
  >
  let applierCount = 0
  let teardownCount = 0
  const events: SprintEngineAutomationEvent[] = []
  const ports: SprintEngineDormancyPorts = {
    applySprintEngineAutomationEvent: (_workspaceId, event) => {
      applierCount += 1
      events.push(event)
      if (event.type === 'runner_complete') state.runtimeState = 'complete'
    },
    tearDownCompletedRunAgents: async () => {
      teardownCount += 1
    },
    setCompletionTeardownAt: (_workspaceId, at) => {
      state.completionTeardownAt = at
    },
    now: () => FIXED_NOW,
  }
  const completedRun = { tasks: [{ id: 'T1', status: 'done' }] } as unknown as SprintEngineState

  // Path A: the auto-run 4s poll detects completion first.
  const enteredA = enterDormancyIfRunComplete(workspace, completedRun, ports)
  await flushMicrotasks()
  assert.equal(enteredA, true, 'auto-run gate enters dormancy for a completed run')
  assert.equal(applierCount, 1, 'runner_complete fired once on the first entry')
  assert.equal(teardownCount, 1, 'agents torn down once on the first entry')
  assert.equal(state.completionTeardownAt, FIXED_NOW, 'shared teardown marker is set')
  assert.equal(events[0]?.type, 'runner_complete', 'the single event is the completion transition')

  // Path B: the projection reconcile re-enters dormancy on a later tick.
  enterSprintEngineDormancy(workspace, ports)
  await flushMicrotasks()
  assert.equal(applierCount, 1, 'runner_complete NOT re-fired via the projection path')
  assert.equal(teardownCount, 1, 'agents NOT re-torn-down via the projection path (marker gates it)')
}

// ── 2. Dormant is skipped by BOTH supervisor gates ────────────────────────────
// The projection skip predicate and the auto-run shouldRun gate both refuse a
// dormant run, and both still admit a live one, from the same lifecycle bit.
function testDormantRunSkippedByBothSupervisorGates(): void {
  const dormant = sprintWorkspace('dormant', {
    sprintEngineAutoState: autoState({ runtimeState: 'complete', completionTeardownAt: 500 }),
    sprintEngineState: HYDRATED_STATE,
  })
  const live = sprintWorkspace('live', {
    sprintEngineAutoState: autoState({ runtimeState: 'running' }),
    sprintEngineState: HYDRATED_STATE,
  })

  assert.equal(isSprintEngineWorkspaceDormant(dormant), true, 'complete run is dormant')
  assert.equal(isSprintEngineWorkspaceDormant(live), false, 'running run is not dormant')

  // Projection skip predicate (T1).
  assert.equal(
    canStopPollingCompletedSprintEngineProjection(dormant),
    true,
    'projection poller can stop on a dormant + hydrated + torn-down run',
  )
  assert.equal(
    canStopPollingCompletedSprintEngineProjection(live),
    false,
    'projection poller keeps polling a live run',
  )
  // A cold-restart dormant run (complete, marker set, but not yet hydrated) must
  // keep polling for its one hydration read.
  const coldDormant = sprintWorkspace('cold', {
    sprintEngineAutoState: autoState({ runtimeState: 'complete', completionTeardownAt: 500 }),
    sprintEngineState: null,
  })
  assert.equal(
    canStopPollingCompletedSprintEngineProjection(coldDormant),
    false,
    'a cold unhydrated dormant run still needs its one hydration read',
  )

  // Auto-run shouldRun gate (== isSprintEngineRunnerActive's derivation).
  assert.equal(
    sprintEngineAutomationShouldRun(dormant.sprintEngineAutoState),
    false,
    'auto-run gate refuses a dormant run',
  )
  assert.equal(
    sprintEngineAutomationShouldRun(live.sprintEngineAutoState),
    true,
    'auto-run gate admits a live non-manual run',
  )
  assert.equal(
    sprintEngineAutomationShouldRun(autoState({ desiredMode: 'manual', runtimeState: 'running' })),
    false,
    'auto-run gate refuses a manual run even while running',
  )
}

// ── 3. Refresh is display-only on a dormant run ───────────────────────────────
// A forced refresh (the board Refresh / add-member path) on a dormant workspace
// hydrates the display but runs NO lifecycle — no reconcile event, teardown,
// marker write, or backlog-link mutation.
async function testForcedRefreshIsDisplayOnlyOnDormantRun(): Promise<void> {
  const applied: SprintEngineState[] = []
  const events: SprintEngineAutomationEvent[] = []
  const teardowns: string[] = []
  const markerWrites: number[] = []
  const backlogMutations: string[] = []
  const dormant = sprintWorkspace('dormant-refresh', {
    sprintEngineAutoState: autoState({ runtimeState: 'complete', completionTeardownAt: 500 }),
    sprintEngineState: HYDRATED_STATE,
  })
  const projectionData = {
    ok: true,
    projectionVersion: 1,
    source: 'folder_store',
    generatedAt: '2026-06-07T15:00:00Z',
    updatedAt: '2026-06-07T15:00:00Z',
    run: { id: 'dormant-refresh', name: 'Dormant', goal: '', status: 'complete', rosterConfigured: true },
    roster: {},
    tasks: [{ id: 'T1', title: 'Done', role: 'developer', status: 'done', dependsOn: [], qualityGates: [], activity: [] }],
    artifacts: [],
    activity: [],
  }
  const ports: SprintEngineProjectionRefreshPorts = {
    readSprintEngineProjection: async () => ({ ok: true, data: projectionData, token: 'tok-1' }),
    setSprintEngineState: (_workspaceId, state) => {
      if (state) applied.push(state)
    },
    applySprintEngineAutomationEvent: (_workspaceId, event) => {
      events.push(event)
    },
    readBacklogObjectStore: async () => ({ ok: true, store: { schemaVersion: 1, items: [] } }),
    addOrUpdateBacklogLink: async (args) => {
      backlogMutations.push(args.relativePath)
      return { ok: true, store: { schemaVersion: 1, items: [] } }
    },
    publishDiagnostic: () => {},
    tearDownCompletedRunAgents: async (workspaceId) => {
      teardowns.push(workspaceId)
    },
    setCompletionTeardownAt: (_workspaceId, at) => {
      if (at !== undefined) markerWrites.push(at)
    },
    now: () => FIXED_NOW,
  }

  const result = await refreshSprintEngineWorkspaceProjection({
    workspace: dormant,
    tokens: new Map(),
    cause: 'manual',
    force: true,
    ports,
  })
  await flushMicrotasks()

  assert.equal(result.status, 'changed', 'the projection is read and applied')
  assert.equal(applied.length, 1, 'the board display is hydrated on a dormant refresh')
  assert.deepEqual(events, [], 'no lifecycle/reconcile event on a dormant refresh')
  assert.deepEqual(teardowns, [], 'no agent teardown on a dormant refresh')
  assert.deepEqual(markerWrites, [], 'no completion-marker write on a dormant refresh')
  assert.deepEqual(backlogMutations, [], 'no backlog-link mutation on a dormant refresh')
}

// ── 4. All-dormant ⇒ both supervisor intervals + registered timers are gone ──
// The two "needs me" derivations both return false when every run is dormant, so
// neither supervisor holds a live interval and NEITHER label remains in the live
// diagnostics timer registry. Flipping one run live re-arms both; going dormant
// again empties the registry. This is the observable quiescence signal.
function testAllDormantEmptiesBothTimerRegistrations(): void {
  const runs: Workspace[] = [
    sprintWorkspace('r1', {
      sprintEngineAutoState: autoState({ runtimeState: 'complete', completionTeardownAt: 500 }),
      sprintEngineState: HYDRATED_STATE,
    }),
    sprintWorkspace('r2', {
      sprintEngineAutoState: autoState({ runtimeState: 'complete', completionTeardownAt: 500 }),
      sprintEngineState: HYDRATED_STATE,
    }),
  ]
  const ids = new Set(runs.map((run) => run.id))
  const projectionNeeded = (): boolean => sprintEngineWorkspacesNeedProjectionPolling(runs, ids)
  const autoRunNeeded = (): boolean =>
    runs.some((run) => sprintEngineAutomationShouldRun(run.sprintEngineAutoState))

  // Injected timer ops so no real interval runs, but the REAL registerTimer is
  // used so the assertions read the live registry.
  let nextId = 0
  const projectionLoop = createProjectionPollLoop({
    cadenceMs: 4000,
    runTick: () => {},
    setInterval: () => (nextId += 1),
    clearInterval: () => {},
  })
  const autoRunController = createAutoRunPollerController({
    isPollerNeeded: autoRunNeeded,
    tick: () => {},
    setInterval: () => (nextId += 1),
    clearInterval: () => {},
  })

  try {
    // All dormant: both derivations false, nothing armed, registry empty for both.
    assert.equal(projectionNeeded(), false, 'projection supervisor needs nothing when all runs dormant')
    assert.equal(autoRunNeeded(), false, 'auto-run supervisor needs nothing when all runs dormant')
    projectionLoop.sync(projectionNeeded())
    autoRunController.sync()
    assert.equal(labelCount(PROJECTION_LABEL), 0, 'no projection poll timer while all dormant')
    assert.equal(labelCount(AUTO_RUN_LABEL), 0, 'no auto-run poll timer while all dormant')

    // A user resumes r1 to a running mode: both derivations flip true, both re-arm.
    runs[0].sprintEngineAutoState = autoState({ runtimeState: 'running' })
    assert.equal(projectionNeeded(), true, 'a resumed run re-arms projection demand')
    assert.equal(autoRunNeeded(), true, 'a resumed run re-arms auto-run demand')
    projectionLoop.sync(projectionNeeded())
    autoRunController.sync()
    assert.equal(labelCount(PROJECTION_LABEL), 1, 'projection poll timer re-registered on demand')
    assert.equal(labelCount(AUTO_RUN_LABEL), 1, 'auto-run poll timer re-registered on demand')

    // The run finishes again → back to dormant → both registrations disappear.
    runs[0].sprintEngineAutoState = autoState({ runtimeState: 'complete', completionTeardownAt: 500 })
    projectionLoop.sync(projectionNeeded())
    autoRunController.sync()
    assert.equal(labelCount(PROJECTION_LABEL), 0, 'projection poll timer unregistered on re-dormancy')
    assert.equal(labelCount(AUTO_RUN_LABEL), 0, 'auto-run poll timer unregistered on re-dormancy')
  } finally {
    projectionLoop.dispose()
    autoRunController.dispose()
  }
  assert.equal(labelCount(PROJECTION_LABEL), 0, 'dispose leaves no projection registration')
  assert.equal(labelCount(AUTO_RUN_LABEL), 0, 'dispose leaves no auto-run registration')
}

// ── 5. Interrupted-teardown non-quiescence heals on reload (T9) ───────────────
// An app quit during the fire-and-forget completion teardown persists
// `runtimeState:'complete'` with `completionTeardownAt:undefined` and a nulled
// `sprintEngineState`. On reload the run is already dormant, so the refresh takes
// its display-only branch — but that branch must still complete the pending
// teardown ONCE and set the marker, after which the projection poller quiesces.
// A dormant run whose marker is already set must stay a strict no-op.
async function testInterruptedTeardownHealsOnReload(): Promise<void> {
  const teardowns: string[] = []
  const markerWrites: number[] = []
  const events: SprintEngineAutomationEvent[] = []
  const backlogMutations: string[] = []
  // Interrupted: complete + marker unset + not yet hydrated (cold reload).
  const autoStateRef = autoState({ runtimeState: 'complete', completionTeardownAt: undefined })
  const interrupted = sprintWorkspace('interrupted', {
    sprintEngineAutoState: autoStateRef,
    sprintEngineState: null,
  })
  const projectionData = {
    ok: true,
    projectionVersion: 1,
    source: 'folder_store',
    generatedAt: '2026-06-07T15:00:00Z',
    updatedAt: '2026-06-07T15:00:00Z',
    run: { id: 'interrupted', name: 'Done', goal: '', status: 'complete', rosterConfigured: true },
    roster: {},
    tasks: [{ id: 'T1', title: 'Done', role: 'developer', status: 'done', dependsOn: [], qualityGates: [], activity: [] }],
    artifacts: [],
    activity: [],
  }
  const ports: SprintEngineProjectionRefreshPorts = {
    readSprintEngineProjection: async () => ({ ok: true, data: projectionData, token: 'tok-1' }),
    setSprintEngineState: (_workspaceId, state) => {
      if (state) interrupted.sprintEngineState = state
    },
    applySprintEngineAutomationEvent: (_workspaceId, event) => {
      events.push(event)
    },
    readBacklogObjectStore: async () => ({ ok: true, store: { schemaVersion: 1, items: [] } }),
    addOrUpdateBacklogLink: async (args) => {
      backlogMutations.push(args.relativePath)
      return { ok: true, store: { schemaVersion: 1, items: [] } }
    },
    publishDiagnostic: () => {},
    tearDownCompletedRunAgents: async (workspaceId) => {
      teardowns.push(workspaceId)
    },
    setCompletionTeardownAt: (_workspaceId, at) => {
      autoStateRef.completionTeardownAt = at
      if (at !== undefined) markerWrites.push(at)
    },
    now: () => FIXED_NOW,
  }

  const first = await refreshSprintEngineWorkspaceProjection({
    workspace: interrupted,
    tokens: new Map(),
    cause: 'manual',
    force: true,
    ports,
  })
  await flushMicrotasks()

  assert.equal(first.status, 'changed', 'the cold projection is read and applied')
  assert.deepEqual(events, [], 'no lifecycle event re-fired on an already-complete run')
  assert.deepEqual(teardowns, ['interrupted'], 'the interrupted teardown runs exactly once on reload')
  assert.deepEqual(markerWrites, [FIXED_NOW], 'the completion-teardown marker is healed once')
  assert.deepEqual(backlogMutations, [], 'display-only contract intact: no backlog writes')
  // With the marker now set + state hydrated, the poller can quiesce.
  assert.equal(
    canStopPollingCompletedSprintEngineProjection(interrupted),
    true,
    'poller can stop once the interrupted teardown is healed',
  )

  // A second refresh on the now-fully-dormant run is a strict no-op.
  const second = await refreshSprintEngineWorkspaceProjection({
    workspace: interrupted,
    tokens: new Map(),
    cause: 'manual',
    force: true,
    ports,
  })
  await flushMicrotasks()
  assert.equal(second.status, 'changed', 'the second forced read still applies')
  assert.deepEqual(teardowns, ['interrupted'], 'no second teardown once the marker is set')
  assert.deepEqual(markerWrites, [FIXED_NOW], 'no second marker write once the marker is set')
}

async function main(): Promise<void> {
  await testDualPathTeardownRunsExactlyOnce()
  console.log('sprintengineDormancy: dual-path teardown-once — ok')
  testDormantRunSkippedByBothSupervisorGates()
  console.log('sprintengineDormancy: dormant skipped by both supervisor gates — ok')
  await testForcedRefreshIsDisplayOnlyOnDormantRun()
  console.log('sprintengineDormancy: forced refresh display-only on dormant — ok')
  testAllDormantEmptiesBothTimerRegistrations()
  console.log('sprintengineDormancy: all-dormant empties both timer registrations — ok')
  await testInterruptedTeardownHealsOnReload()
  console.log('sprintengineDormancy: interrupted teardown heals on reload — ok')
  console.log('sprintengineDormancy.test.ts: ok')
}

void main()
