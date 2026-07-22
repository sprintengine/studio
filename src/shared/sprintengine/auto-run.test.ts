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
  sprintEngineRepoIdForSessionCwd,
  sprintEngineWorkerRepoId,
} from './auto-run'

function task(overrides: Partial<SprintEngineTask> = {}): SprintEngineTask {
  return {
    id: 'T1',
    title: 'A task',
    description: '',
    role: 'developer',
    repo: 'primary',
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

/** A two-repo run: primary + a declared `mobile` sibling, each with its own worktree. */
function twoRepoVcs(): SprintEngineState['vcs'] {
  return {
    mode: 'run_worktree',
    worktreePath: '.multi-code/wt/run',
    branchName: 'run/main',
    repos: [
      { id: 'primary', root: '.', worktreePath: '.multi-code/wt/run', branchName: 'run/main' },
      { id: 'mobile', root: '../mobile', worktreePath: '.multi-code/wt/run-mobile', branchName: 'run/main' },
    ],
  } as SprintEngineState['vcs']
}

// --- AC4: single cwd choke point -------------------------------------------

function testResolveSessionCwdWorktreeMode(): void {
  const state = stateFixture({
    vcs: {
      mode: 'run_worktree',
      worktreePath: '.multi-code/wt/run',
      branchName: 'run/main',
      repos: [{ id: 'primary', root: '.', worktreePath: '.multi-code/wt/run', branchName: 'run/main' }],
    },
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

// --- MC-1610: a session opens in the worktree of the repo its task targets ---

function testResolveSessionCwdSelectsTheTasksRepoWorktree(): void {
  const state = stateFixture({
    vcs: twoRepoVcs(),
    tasks: [task({ id: 'D1', repo: 'primary' }), task({ id: 'M1', repo: 'mobile' })],
  })
  assert.equal(resolveSprintEngineSessionCwd(state, 'D1').worktreeRelativePath, '.multi-code/wt/run')
  assert.equal(
    resolveSprintEngineSessionCwd(state, 'M1').worktreeRelativePath,
    '.multi-code/wt/run-mobile',
    'a task targeting the mobile repo spawns its session in the mobile worktree',
  )
  // A repo id routes directly, and an unknown key lands in the primary worktree
  // rather than guessing a sibling.
  assert.equal(resolveSprintEngineSessionCwd(state, 'mobile').worktreeRelativePath, '.multi-code/wt/run-mobile')
  assert.equal(resolveSprintEngineSessionCwd(state, 'nope').worktreeRelativePath, '.multi-code/wt/run')
  assert.equal(resolveSprintEngineSessionCwd(state, null).worktreeRelativePath, '.multi-code/wt/run')
}

function testResolveSessionCwdSkipsSiblingMissingItsWorktree(): void {
  // Backlog 1722: a task targets a sibling repo that is not resolvable in
  // `vcs.repos` (its entry was dropped as incomplete, or was never declared).
  // The session skips to the main checkout — it must never borrow the primary
  // tree, which would silently run the sibling task against the wrong repo.
  const state = stateFixture({
    vcs: {
      mode: 'run_worktree',
      worktreePath: '.multi-code/wt/run',
      branchName: 'run/main',
      repos: [{ id: 'primary', root: '.', worktreePath: '.multi-code/wt/run', branchName: 'run/main' }],
    },
    tasks: [task({ id: 'M1', repo: 'mobile' })],
  })
  const cwd = resolveSprintEngineSessionCwd(state, 'M1')
  assert.equal(cwd.executionMode, 'current_workspace', 'an unresolvable sibling skips rather than binding to primary')
  assert.equal(cwd.worktreeRelativePath, undefined)
  // The primary repo still resolves to the run worktree via the flat fallback.
  assert.equal(resolveSprintEngineSessionCwd(state, 'primary').worktreeRelativePath, '.multi-code/wt/run')
  assert.equal(resolveSprintEngineSessionCwd(state, null).worktreeRelativePath, '.multi-code/wt/run')
}

function testWorkerRepoIdPrefersSessionCwdOverPrimary(): void {
  // Backlog 1722: a lease-less worker with no owned task can still have a session
  // spawned into a repo's worktree; prefer that session's repo over the primary
  // default, or the worker is woken for primary work its sibling-repo session
  // cannot claim (no-op wake spam). Precedence: lease > owned task > session cwd.
  const state = stateFixture({
    vcs: twoRepoVcs(),
    sprintEngineAgents: { 'developer-9': { role: 'developer', status: 'idle', currentTaskId: null } },
  })
  assert.equal(sprintEngineWorkerRepoId(state, 'developer-9'), 'primary', 'no lease, task, or session evidence defaults to primary')
  assert.equal(sprintEngineWorkerRepoId(state, 'developer-9', 'mobile'), 'mobile', 'the session cwd repo is preferred over the primary default')

  const leased = stateFixture({
    workers: { 'developer-9': { role: 'developer', status: 'running', currentTaskId: 'M1', repo: 'mobile' } },
    sprintEngineAgents: { 'developer-9': { role: 'developer', status: 'running', currentTaskId: 'M1' } },
    tasks: [task({ id: 'M1', repo: 'mobile' })],
  } as Partial<SprintEngineState>)
  assert.equal(sprintEngineWorkerRepoId(leased, 'developer-9', 'primary'), 'mobile', 'the active lease repo wins over a session cwd')

  const owned = stateFixture({
    sprintEngineAgents: { 'developer-9': { role: 'developer', status: 'idle', currentTaskId: null, lastOwnedTaskId: 'M1' } },
    tasks: [task({ id: 'M1', repo: 'mobile' })],
  })
  assert.equal(sprintEngineWorkerRepoId(owned, 'developer-9', 'primary'), 'mobile', 'the owned task repo wins over a session cwd')
}

function testResolveSessionRepoIdFromSessionCwd(): void {
  const state = stateFixture({ vcs: twoRepoVcs() })
  assert.equal(sprintEngineRepoIdForSessionCwd(state, '/proj', '/proj/.multi-code/wt/run-mobile'), 'mobile')
  assert.equal(sprintEngineRepoIdForSessionCwd(state, '/proj', '/proj/.multi-code/wt/run'), 'primary')
  // No repo evidence is null, never a guess at primary.
  assert.equal(sprintEngineRepoIdForSessionCwd(state, '/proj', '/proj'), null)
  assert.equal(sprintEngineRepoIdForSessionCwd(state, '/proj', undefined), null)
  assert.equal(sprintEngineRepoIdForSessionCwd(stateFixture(), '/proj', '/proj/x'), null)
}

// --- AC5: demand grouping is a key function --------------------------------

function testDemandKeyIsRoleAndRepo(): void {
  assert.equal(sprintEngineDemandKey(task({ role: 'developer', repo: 'mobile' })), 'developer@mobile')
  assert.equal(sprintEngineDemandKey(task({ role: 'architect', repo: 'mobile' })), 'architect@mobile')
  // The primary repo keys to the bare role, so a single-repo run's groups —
  // and therefore its spawning — are exactly what they were before repo joined
  // the key. An unset repo reads as primary for the same reason.
  assert.equal(sprintEngineDemandKey(task({ role: 'developer', repo: 'primary' })), 'developer')
  assert.equal(sprintEngineDemandKey(task({ role: 'developer', repo: '' })), 'developer')
  assert.equal(sprintEngineDemandKey({ role: 'developer' } as SprintEngineTask), 'developer')
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

function testComputeDemandGroupsByRoleAndRepo(): void {
  const state = stateFixture({
    vcs: twoRepoVcs(),
    tasks: [
      task({ id: 'D1', role: 'developer', repo: 'primary' }),
      task({ id: 'M1', role: 'developer', repo: 'mobile' }),
      task({ id: 'M2', role: 'developer', repo: 'mobile' }),
    ],
  })
  const demand = computeSprintEngineDemand(state)
  assert.deepEqual([...demand.keys()].sort(), ['developer', 'developer@mobile'], 'same role in two repos is two demand groups')
  assert.deepEqual(demand.get('developer@mobile')?.map((t) => t.id), ['M1', 'M2'])
}

function testComputeDemandHonoursACustomKeyFunction(): void {
  // The key stays injectable (MC-1615's seam): the reconciler groups by whatever
  // key it is handed, and the default is the only thing that spells (role, repo).
  const state = stateFixture({
    tasks: [
      task({ id: 'D1', role: 'developer', repo: 'primary' }),
      task({ id: 'D2', role: 'developer', repo: 'mobile' }),
    ],
  })
  const oneGroup = computeSprintEngineDemand(state, (t) => t.role)
  assert.deepEqual([...oneGroup.keys()], ['developer'], 'a role-only key collapses both repos into one group')
}

function testDemandKeyChangesSpawnGrouping(): void {
  // The wiring proof (MC-1592 review): the demand key must change SPAWNING, not
  // just telemetry. Three ready developer tasks across two repos with two slots.
  // Keyed by (role, repo) — the default now — they form two groups drained
  // round-robin, so the mobile repo gets a session before primary doubles up;
  // a role-only key would cover the two oldest primary tasks and leave mobile
  // with no session at all.
  const state = stateFixture({
    vcs: twoRepoVcs(),
    tasks: [
      task({ id: 'A1', role: 'developer', repo: 'primary' }),
      task({ id: 'A2', role: 'developer', repo: 'primary' }),
      task({ id: 'B1', role: 'developer', repo: 'mobile' }),
    ],
  })

  const byRole = pickNextAutoRuns(workspaceFixture(), state, pickOptions({ limit: 2, demandKeyFn: (t) => t.role }))
  assert.deepEqual(byRole.map((run) => run.taskId), ['A1', 'A2'], 'role key: one group, oldest two tasks covered')

  const byRepo = pickNextAutoRuns(workspaceFixture(), state, pickOptions({ limit: 2 }))
  assert.deepEqual(byRepo.map((run) => run.taskId), ['A1', 'B1'], '(role, repo) key: both repos get a session before primary doubles up')
  assert.equal(new Set(byRepo.map((run) => run.agentId)).size, 2, 'each pool spawn mints its own fresh worker id')
}

function testRepoIsAFilterNotAPerRepoBudget(): void {
  // Concurrency stays GLOBAL: repo splits the queue, it never buys extra slots.
  // Four ready tasks across two repos with two slots yields two sessions total,
  // exactly as a single-repo run with two slots would.
  const state = stateFixture({
    vcs: twoRepoVcs(),
    tasks: [
      task({ id: 'A1', role: 'developer', repo: 'primary' }),
      task({ id: 'A2', role: 'developer', repo: 'primary' }),
      task({ id: 'B1', role: 'developer', repo: 'mobile' }),
      task({ id: 'B2', role: 'developer', repo: 'mobile' }),
    ],
  })
  assert.equal(pickNextAutoRuns(workspaceFixture(), state, pickOptions({ limit: 2 })).length, 2)
  assert.equal(pickNextAutoRuns(workspaceFixture(), state, pickOptions({ limit: 1 })).length, 1)
}

function testBootingSiblingRepoSessionCoversOnlyItsOwnGroup(): void {
  // A booting session is per-key supply. With its exemplar task gone, it keys
  // through the repo it was SPAWNED into: a booting mobile session must not
  // cover primary demand (which would leave the primary task unspawned), and
  // must cover its own (which would otherwise be double-spawned).
  const state = stateFixture({
    vcs: twoRepoVcs(),
    tasks: [
      task({ id: 'A1', role: 'developer', repo: 'primary' }),
      task({ id: 'B1', role: 'developer', repo: 'mobile' }),
    ],
  })
  const booting = [{ agentId: 'developer-9', role: 'developer', taskId: null, repo: 'mobile' }]
  const picked = pickNextAutoRuns(workspaceFixture(), state, pickOptions({ limit: 3, unboundLiveWorkers: booting }))
  assert.deepEqual(picked.map((run) => run.taskId), ['A1'], 'the booting mobile session covers B1 only; A1 still needs one')
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
  testResolveSessionCwdSelectsTheTasksRepoWorktree()
  testResolveSessionCwdSkipsSiblingMissingItsWorktree()
  testWorkerRepoIdPrefersSessionCwdOverPrimary()
  testResolveSessionRepoIdFromSessionCwd()
  testDemandKeyIsRoleAndRepo()
  testComputeDemandGroupsReadyUnownedWorkByKey()
  testComputeDemandGroupsByRoleAndRepo()
  testComputeDemandHonoursACustomKeyFunction()
  testDemandKeyChangesSpawnGrouping()
  testRepoIsAFilterNotAPerRepoBudget()
  testBootingSiblingRepoSessionCoversOnlyItsOwnGroup()
  testReconcilerSpawnsFromStarvationFixture()
  console.log('auto-run.test.ts: all tests passed')
}

main()
