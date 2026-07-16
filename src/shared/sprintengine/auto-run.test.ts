/**
 * Shared auto-run planner tests (MC-1592 / MC-1615). Covers the reconciler
 * seams that the pool-supervisor rewrite hardened: the single cwd choke point
 * (`resolveSprintEngineSessionCwd`), the demand grouping key function
 * (`sprintEngineDemandKey` / `computeSprintEngineDemand`), and the 2026-07-14
 * starvation projection replayed as a fixture — the reconciler must produce a
 * spawn from it.
 *
 * Runner: esbuild bundle -> node, `node:assert/strict`, hand-rolled `testXxx()`
 * (the shared-module convention; see state.test.ts).
 */
import assert from 'node:assert/strict'
import type {
  SprintEngineState,
  SprintEngineTask,
  SprintEngineWorkspaceView,
} from './run-types'
import {
  computeSprintEngineDemand,
  pickNextAutoRuns,
  resolveSprintEngineSessionCwd,
  sprintEngineDemandKey,
} from './auto-run'

function task(overrides: Partial<SprintEngineTask> = {}): SprintEngineTask {
  return {
    id: 'T1',
    title: 'A task',
    description: '',
    role: 'developer',
    status: 'todo',
    ownerAgentId: null,
    dependsOn: [],
    ownedPaths: [],
    acceptanceCriteria: [],
    implementationNotes: [],
    evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
    notes: [],
    comments: [],
    startedAt: null,
    completedAt: null,
    boardColumn: 'ready',
    ...overrides,
  } as SprintEngineTask
}

function stateFixture(overrides: Partial<SprintEngineState> = {}): SprintEngineState {
  return {
    name: 'team',
    goal: '',
    roleCounts: {},
    sprintEngineAgents: {},
    events: [],
    tasks: [],
    artifacts: [],
    ...overrides,
  } as SprintEngineState
}

function workspaceFixture(overrides: Partial<SprintEngineWorkspaceView> = {}): SprintEngineWorkspaceView {
  return {
    id: 'workspace-1',
    name: 'Auto-run workspace',
    folderPath: '/tmp/workspace',
    agents: {},
    sprintEngineContext: {
      teamSlug: 'team',
      statePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
    },
    ...overrides,
  } as SprintEngineWorkspaceView
}

function pickOptions(overrides: Partial<Parameters<typeof pickNextAutoRuns>[2]> = {}): Parameters<typeof pickNextAutoRuns>[2] {
  return {
    limit: 3,
    runningAgentIds: new Set<string>(),
    inFlightSpawns: new Set<string>(),
    ...overrides,
  }
}

// --- AC4: single cwd choke point -------------------------------------------

function testResolveSessionCwdWorktreeMode(): void {
  const state = stateFixture({
    vcs: { mode: 'run_worktree', worktreePath: '.multi-code/wt/run', branchName: 'run/main' },
  })
  const cwd = resolveSprintEngineSessionCwd(state, 'T1')
  assert.equal(cwd.executionMode, 'worktree')
  assert.equal(cwd.worktreeRelativePath, '.multi-code/wt/run', 'the worktree path is the run worktree, relative to the workspace folder')
}

function testResolveSessionCwdCurrentWorkspaceWhenNoWorktree(): void {
  const noVcs = resolveSprintEngineSessionCwd(stateFixture(), 'T1')
  assert.equal(noVcs.executionMode, 'current_workspace')
  assert.equal(noVcs.worktreeRelativePath, undefined)

  // A vcs block without run_worktree mode still means no worktree cwd.
  const otherMode = resolveSprintEngineSessionCwd(
    stateFixture({ vcs: { mode: 'other' } as unknown as SprintEngineState['vcs'] }),
    'T1',
  )
  assert.equal(otherMode.executionMode, 'current_workspace')
}

// --- AC5: demand grouping is a key function --------------------------------

function testDemandKeyIsRoleToday(): void {
  assert.equal(sprintEngineDemandKey(task({ role: 'developer' })), 'developer')
  assert.equal(sprintEngineDemandKey(task({ role: 'architect' })), 'architect')
}

function testComputeDemandGroupsReadyUnownedWorkByKey(): void {
  const state = stateFixture({
    tasks: [
      task({ id: 'D1', role: 'developer' }),
      task({ id: 'D2', role: 'developer' }),
      task({ id: 'A1', role: 'architect' }),
      // Owned work is a lease, never demand.
      task({ id: 'D3', role: 'developer', status: 'in_progress', ownerAgentId: 'developer-1', boardColumn: 'in_progress' }),
      // Done work is not demand.
      task({ id: 'D4', role: 'developer', status: 'done', boardColumn: 'done' }),
    ],
  })
  const demand = computeSprintEngineDemand(state)
  assert.equal(demand.size, 2, 'two demand groups: developer and architect')
  assert.deepEqual(demand.get('developer')?.map((t) => t.id), ['D1', 'D2'], 'only ready, unowned, launchable developer work')
  assert.deepEqual(demand.get('architect')?.map((t) => t.id), ['A1'])
}

function testComputeDemandHonoursACustomKeyFunction(): void {
  // The MC-1610 one-line change: swapping the key from role to (role,repo)
  // regroups demand without touching the reconciler. Prove the seam by keying
  // on a per-task attribute here.
  const state = stateFixture({
    tasks: [
      task({ id: 'D1', role: 'developer', ownedPaths: ['repo-a/x'] }),
      task({ id: 'D2', role: 'developer', ownedPaths: ['repo-b/y'] }),
    ],
  })
  const byRepo = computeSprintEngineDemand(state, (t) => `${t.role}:${t.ownedPaths[0]?.split('/')[0] ?? 'root'}`)
  assert.deepEqual([...byRepo.keys()].sort(), ['developer:repo-a', 'developer:repo-b'])
}

function testCustomDemandKeyChangesSpawnGrouping(): void {
  // The wiring proof (MC-1592 review): the demand key must change SPAWNING,
  // not just telemetry. Three ready developer tasks across two repos with two
  // slots: keyed by role they form one group and the two oldest tasks are
  // covered; keyed by (role, repo) they form two groups drained round-robin,
  // so each repo gets a session before repo-a doubles up.
  const state = stateFixture({
    tasks: [
      task({ id: 'A1', role: 'developer', ownedPaths: ['repo-a/x'] }),
      task({ id: 'A2', role: 'developer', ownedPaths: ['repo-a/y'] }),
      task({ id: 'B1', role: 'developer', ownedPaths: ['repo-b/z'] }),
    ],
  })

  const byRole = pickNextAutoRuns(workspaceFixture(), state, pickOptions({ limit: 2 }))
  assert.deepEqual(byRole.map((run) => run.taskId), ['A1', 'A2'], 'role key: one group, oldest two tasks covered')

  const byRepo = pickNextAutoRuns(workspaceFixture(), state, pickOptions({
    limit: 2,
    demandKeyFn: (t) => `${t.role}:${t.ownedPaths[0]?.split('/')[0] ?? 'root'}`,
  }))
  assert.deepEqual(byRepo.map((run) => run.taskId), ['A1', 'B1'], '(role, repo) key: both repos get a session before repo-a doubles up')
  assert.equal(new Set(byRepo.map((run) => run.agentId)).size, 2, 'each pool spawn mints its own fresh worker id')
}

// --- AC3: the 2026-07-14 starvation projection, replayed -------------------

function testReconcilerSpawnsFromStarvationFixture(): void {
  // The 2026-07-14 starvation shape (mirrors the Python regression
  // `test_a_spent_planner_id_never_starves_a_successor`): a role's previous
  // worker owns a now-`done` task and carries that id as `lastOwnedTaskId`,
  // while a ready, unowned, same-role task waits. The old seat-ledger flow
  // starved this (replenish pre-mint was tick-fatal before candidate picking);
  // the reconciler must produce a spawn for the ready task, minting a fresh
  // worker id because the spent id is never reusable for a new claim.
  const state = stateFixture({
    tasks: [
      task({ id: 'T-done', role: 'developer', status: 'done', boardColumn: 'done', ownerAgentId: 'developer-1', lastImplementedByAgentId: 'developer-1' }),
      task({ id: 'T-open', role: 'developer', status: 'todo', boardColumn: 'ready', ownerAgentId: null }),
    ],
    sprintEngineAgents: {
      'developer-1': { role: 'developer', status: 'idle', currentTaskId: null, lastOwnedTaskId: 'T-done' },
    },
  })

  const candidates = pickNextAutoRuns(workspaceFixture(), state, pickOptions())
  assert.equal(candidates.length, 1, `the reconciler produces a spawn for the starved ready task; candidates=${JSON.stringify(candidates)}`)
  assert.equal(candidates[0].taskId, 'T-open', 'the ready task is the one dispatched')
  assert.equal(candidates[0].role, 'developer')
  assert.notEqual(candidates[0].agentId, 'developer-1', 'a fresh worker id is minted — the spent owner id is not reused for a new claim')

  // The demand model agrees: exactly one ungrouped developer demand.
  const demand = computeSprintEngineDemand(state)
  assert.deepEqual(demand.get('developer')?.map((t) => t.id), ['T-open'])
}

function main(): void {
  testResolveSessionCwdWorktreeMode()
  testResolveSessionCwdCurrentWorkspaceWhenNoWorktree()
  testDemandKeyIsRoleToday()
  testComputeDemandGroupsReadyUnownedWorkByKey()
  testComputeDemandHonoursACustomKeyFunction()
  testCustomDemandKeyChangesSpawnGrouping()
  testReconcilerSpawnsFromStarvationFixture()
  console.log('auto-run.test.ts: all tests passed')
}

main()
