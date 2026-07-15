import assert from 'node:assert/strict'

import { buildSprintEngineAgentRosterForState, normalizeSprintEngineProjection } from './state'

// A minimal v3 (`projection.workers` + `projection.roster` bridge) projection
// payload as it lands off disk. The engine derives both the canonical `workers`
// view and the `roster` bridge from the same lease-derived worker views, so
// their keys and shared runtime-agent fields never disagree.
function v3Projection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const worker = {
    role: 'developer',
    status: 'running',
    currentTaskId: 'T2',
    lastOwnedTaskId: 'T1',
    ownedTaskIds: ['T1', 'T2'],
    sessionId: 'sess-dev-1',
    currentDispatch: null,
  }
  return {
    ok: true,
    projectionVersion: 1,
    source: 'folder_store',
    updatedAt: '2026-07-15T00:00:00Z',
    run: { name: 'Work Queue', goal: 'ship it', status: 'planning' },
    tasks: [],
    artifacts: [],
    activity: [],
    workers: { 'developer-1': worker },
    // The bridge drops the worker-only fields (sessionId), matching the Python
    // `_roster_entry_from_worker` projection.
    roster: {
      'developer-1': {
        role: 'developer',
        status: 'running',
        currentTaskId: 'T2',
        lastOwnedTaskId: 'T1',
        ownedTaskIds: ['T1', 'T2'],
        currentDispatch: null,
      },
    },
    ...overrides,
  }
}

function testWorkersViewPopulatedFromProjectionWorkers(): void {
  const state = normalizeSprintEngineProjection(v3Projection())
  assert.ok(state, 'projection should parse')
  assert.ok(state.workers, 'workers view should be populated')
  const worker = state.workers['developer-1']
  assert.ok(worker, 'developer-1 worker present')
  assert.equal(worker.role, 'developer')
  assert.equal(worker.status, 'running')
  assert.equal(worker.currentTaskId, 'T2')
  assert.equal(worker.lastOwnedTaskId, 'T1')
  // Worker-only fields the roster bridge does not carry.
  assert.equal(worker.sessionId, 'sess-dev-1')
  assert.deepEqual(worker.ownedTaskIds, ['T1', 'T2'])
}

function testWorkersFallBackToRosterBridgeWhenAbsent(): void {
  // A pre-v3 projection carries `roster` but no `workers`.
  const projection = v3Projection()
  delete projection.workers
  const state = normalizeSprintEngineProjection(projection)
  assert.ok(state?.workers, 'workers view should fall back to the roster bridge')
  const worker = state.workers['developer-1']
  assert.ok(worker, 'developer-1 derived from roster bridge')
  assert.equal(worker.role, 'developer')
  assert.equal(worker.currentTaskId, 'T2')
  // The bridge has no session; the fallback leaves it unset rather than inventing one.
  assert.equal(worker.sessionId, undefined)
  assert.deepEqual(worker.ownedTaskIds, ['T1', 'T2'])
}

function testRosterBuilderDerivesFromWorkers(): void {
  const state = normalizeSprintEngineProjection(v3Projection())
  const rows = buildSprintEngineAgentRosterForState(state)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'developer-1')
  assert.equal(rows[0].role, 'developer')
}

function testBoardConsumersRenderUnchangedFromV3(): void {
  // AC2: existing board/tab consumers render unchanged against a v3 projection.
  // The rows derived from the canonical workers view must equal the rows that
  // the legacy roster-bridge path would have produced (both share role + id).
  const state = normalizeSprintEngineProjection(v3Projection())
  assert.ok(state)
  const fromWorkers = buildSprintEngineAgentRosterForState(state)
  const fromRosterOnly = buildSprintEngineAgentRosterForState({
    roleCounts: state.roleCounts,
    sprintEngineAgents: state.sprintEngineAgents,
    // No workers view: force the sprintEngineAgents (roster-bridge) fallback.
  })
  assert.deepEqual(fromWorkers, fromRosterOnly)
}

function testWorkersOrphanRolelessEntriesDropped(): void {
  const projection = v3Projection({
    workers: {
      'developer-1': { role: 'developer', status: 'running', currentTaskId: 'T2', currentDispatch: null },
      'ghost-1': { status: 'idle', currentTaskId: null, currentDispatch: null },
    },
  })
  const state = normalizeSprintEngineProjection(projection)
  assert.ok(state?.workers)
  assert.ok(state.workers['developer-1'], 'roled worker kept')
  assert.equal(state.workers['ghost-1'], undefined, 'roleless worker dropped')
}

function testVcsReposPassThroughPreserved(): void {
  // AC3: an unknown `vcs.repos` array survives parse verbatim (MC-1615 seam).
  const repos = [
    { id: 'app', worktreePath: '.multi-code/wt/app', branchName: 'run/app' },
    { id: 'sdk', worktreePath: '.multi-code/wt/sdk', branchName: 'run/sdk' },
  ]
  const projection = v3Projection({
    run: {
      name: 'Work Queue',
      goal: 'ship it',
      status: 'planning',
      vcs: {
        mode: 'run_worktree',
        worktreePath: '.multi-code/wt/app',
        branchName: 'run/main',
        repos,
      },
    },
  })
  const state = normalizeSprintEngineProjection(projection)
  assert.ok(state?.vcs, 'vcs parsed')
  assert.deepEqual(state.vcs.repos, repos, 'repos preserved verbatim')
  // Existing single-worktree fields still parse alongside the pass-through.
  assert.equal(state.vcs.worktreePath, '.multi-code/wt/app')
  assert.equal(state.vcs.branchName, 'run/main')
}

function testVcsReposAbsentWhenNotProvided(): void {
  const projection = v3Projection({
    run: {
      name: 'Work Queue',
      goal: 'ship it',
      status: 'planning',
      vcs: { mode: 'run_worktree', worktreePath: '.multi-code/wt/app', branchName: 'run/main' },
    },
  })
  const state = normalizeSprintEngineProjection(projection)
  assert.ok(state?.vcs)
  assert.equal(state.vcs.repos, undefined, 'no repos key synthesized when absent')
}

testWorkersViewPopulatedFromProjectionWorkers()
testWorkersFallBackToRosterBridgeWhenAbsent()
testRosterBuilderDerivesFromWorkers()
testBoardConsumersRenderUnchangedFromV3()
testWorkersOrphanRolelessEntriesDropped()
testVcsReposPassThroughPreserved()
testVcsReposAbsentWhenNotProvided()
console.log('sprintengine state tests passed')
