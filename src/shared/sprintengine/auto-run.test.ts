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
  SprintEngineRoleId,
  SprintEngineRuntimeAgent,
  SprintEngineState,
  SprintEngineTask,
  SprintEngineWorkspaceView,
} from './run-types'
import {
  computeSprintEngineDemand,
  findSprintEngineWakeCandidateTaskForAgent,
  getSprintEngineWakeCandidateTasks,
  pickNextAutoRuns,
  pickSprintEngineBootstrapCandidate,
  planSprintEngineDispatch,
  resolveSprintEngineSessionCwd,
  sprintEngineDemandKey,
  sprintEngineRepoIdForSessionCwd,
  sprintEngineWakeRestrictionTaskId,
  sprintEngineWorkerRepoId,
} from './auto-run'
import { sprintEngineTaskRoutesToCoordinator } from './state'

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

  // A roleless task keys to its own stable group (MC-2057). It must never be
  // `String(undefined)`, and it must never merge with a named role's group — a
  // run staffing `developer` alone carries both kinds of task, and merging them
  // would spawn a developer session to serve work no developer is meant to take.
  const rolelessKey = sprintEngineDemandKey(task({ role: undefined, repo: 'primary' }))
  assert.equal(rolelessKey.includes('undefined'), false, 'the roleless key never stringifies undefined')
  assert.notEqual(rolelessKey, '', 'the roleless key is not the empty string that `worker_role` uses for "unknown"')
  assert.notEqual(rolelessKey, 'developer', 'the roleless key does not collide with a role id')
  assert.equal(
    sprintEngineDemandKey(task({ role: undefined, repo: '' })),
    rolelessKey,
    'the roleless key is stable across repo spellings of primary',
  )
  assert.equal(
    sprintEngineDemandKey(task({ role: undefined, repo: 'mobile' })),
    `${rolelessKey}@mobile`,
    'roleless work still groups per repo',
  )
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

// --- MC-1751: release / revive / retire consistency -------------------------

function testReleasedTaskGetsAFreshMint(): void {
  // The T11 wedge shape, replayed at the picker: a task released back to the
  // queue (unowned, ready column, publish/feedback history) among idle used
  // seats. Nothing binds it (no runtime carries it as lastOwnedTaskId), so the
  // pool must mint a fresh worker for it.
  const state = stateFixture({
    tasks: [
      task({
        id: 'T-released',
        role: 'developer',
        status: 'ready' as never,
        boardColumn: 'ready',
        ownerAgentId: null,
        lastImplementedByAgentId: 'developer-4',
        lastPublishedAt: '2026-07-22T12:25:45Z',
      } as never),
      task({ id: 'T-done-a', role: 'developer', status: 'done', boardColumn: 'done', ownerAgentId: null }),
    ],
    sprintEngineAgents: {
      'developer-4': { role: 'developer', status: 'idle', currentTaskId: null, lastOwnedTaskId: 'T-done-a' },
    },
  })

  const candidates = pickNextAutoRuns(workspaceFixture(), state, pickOptions())
  assert.equal(candidates.length, 1, `the released task is dispatched; candidates=${JSON.stringify(candidates)}`)
  assert.equal(candidates[0].taskId, 'T-released')
  assert.notEqual(candidates[0].agentId, 'developer-4', 'per_task: a used seat is never reused; a fresh id is minted')
}

function testUnownedNeedsInputTaskIsNotARevivalTarget(): void {
  // The live 14:18 defect: a DEPARTED worker whose retained lastOwnedTaskId
  // points at an UNOWNED needs_input task was revived for it ("developer still
  // has work to finish on T11") — but nobody owned that task; it awaited
  // triage. Revive must be owner-qualified.
  const state = stateFixture({
    tasks: [
      task({
        id: 'T-stranded',
        role: 'developer',
        status: 'needs_input',
        boardColumn: 'needs_input',
        ownerAgentId: null,
      }),
    ],
    sprintEngineAgents: {
      'developer-4': { role: 'developer', status: 'idle', currentTaskId: null, lastOwnedTaskId: 'T-stranded' },
    },
  })
  const workspace = workspaceFixture({
    agents: { 'developer-4': { id: 'developer-4', name: 'developer-4' } },
  } as never)

  const plan = planSprintEngineDispatch({
    workspace,
    sprintEngineState: state,
    now: Date.now(),
    runningAgentIds: new Set(),
    idleAgentIds: new Set(),
    continuationLedger: new Map(),
    dispatchLedger: new Map(),
    paths: new Set(['respawn'] as const) as never,
  })

  assert.deepEqual(
    plan.respawns.map((respawn) => respawn.agentId),
    [],
    `an unowned needs_input task revives nobody; respawns=${JSON.stringify(plan.respawns)}`,
  )
}

function testFinishedTaskScopedWorkerIsTornDownOnFirstIdleTick(): void {
  // MC-1444 fast path pinned: a worker whose own task is done, observed live
  // and unclaimed-idle THIS tick, is torn down immediately — no 5-minute
  // idle window.
  const now = Date.now()
  const state = stateFixture({
    tasks: [
      task({ id: 'T-done', role: 'developer', status: 'done', boardColumn: 'done', ownerAgentId: null }),
      task({ id: 'T-other', role: 'frontend', status: 'in_progress', boardColumn: 'in_progress', ownerAgentId: 'frontend-1' }),
    ],
    sprintEngineAgents: {
      'developer-1': { role: 'developer', status: 'idle', currentTaskId: null, currentDispatch: null, lastOwnedTaskId: 'T-done' },
    },
  })
  const workspace = workspaceFixture()
  const idleClockKey = `${workspace.sprintEngineContext?.statePath}:developer-1`

  const plan = planSprintEngineDispatch({
    workspace,
    sprintEngineState: state,
    now,
    runningAgentIds: new Set(),
    idleAgentIds: new Set(['developer-1']),
    continuationLedger: new Map(),
    dispatchLedger: new Map(),
    idleClock: new Map([[idleClockKey, now]]),
    retirementCooldown: new Map(),
    taskScopedRetirementTaskIds: new Map(),
    paths: new Set(['idle_retire'] as const) as never,
  })

  assert.equal(plan.retirements.length, 1, `the finished worker is retired on the first idle tick; skips=${JSON.stringify(plan.skips)}`)
  assert.equal(plan.retirements[0].agentId, 'developer-1')
  assert.equal(plan.retirements[0].teardown, true, 'terminal-state retirement is a teardown, not a kill-in-place')
  assert.equal((plan.retirements[0].data as { reason?: string }).reason, 'task_scoped_terminal_state')
}

// --- MC-2050: dispatch routes on coordination, not on the role name ---------

/** A run that staffs NO roles: its coordinator seat carries no role at all. */
function rolelessStateFixture(overrides: Partial<SprintEngineState> = {}): SprintEngineState {
  return stateFixture({ configuredRoles: [], ...overrides })
}

/**
 * The live plan artifact whose `taskId` binding IS the coordination marker.
 * `path` is load-bearing (MC-2053): the predicate mirrors `find_plan_artifact`,
 * which counts only an `architect_plan` pointing at the run's OWN plan.md.
 */
function planArtifact(taskId: string): SprintEngineState['artifacts'][number] {
  return { id: 'A-plan', kind: 'architect_plan', title: 'Plan', path: 'plan.md', taskId, status: 'approved' } as never
}

function rolelessAgent(overrides: Record<string, unknown> = {}): SprintEngineRuntimeAgent {
  return { status: 'idle', currentTaskId: null, ...overrides } as SprintEngineRuntimeAgent
}

function testRolelessReadyTasksFanOutOneWorkerEach(): void {
  // The MC-2050 defect: on a roleless run every task carried the same (absent)
  // role as the coordinator, so every one took the coordination branch, resolved
  // to the single seated agent, and the whole graph ran strictly sequentially
  // (`first-run-without-a-wizard`: four independent tasks, five dispatches, all
  // to one id). Owned modules are DISJOINT on purpose — overlapping ownedPaths
  // serialise legitimately at claim time, which would prove nothing here.
  const state = rolelessStateFixture({
    tasks: [
      task({ id: 'T0', role: undefined, status: 'done', boardColumn: 'done' }),
      task({ id: 'T1', role: undefined, ownedPaths: ['src/a'] }),
      task({ id: 'T2', role: undefined, ownedPaths: ['src/b'] }),
      task({ id: 'T3', role: undefined, ownedPaths: ['src/c'] }),
    ],
    artifacts: [planArtifact('T0')],
    sprintEngineAgents: { coordinator: rolelessAgent({ lastOwnedTaskId: 'T0' }) },
  })

  const candidates = pickNextAutoRuns(workspaceFixture(), state, pickOptions())
  assert.deepEqual(
    candidates.map((candidate) => candidate.taskId).sort(),
    ['T1', 'T2', 'T3'],
    `every ready task is dispatched this pass; candidates=${JSON.stringify(candidates)}`,
  )
  assert.equal(
    new Set(candidates.map((candidate) => candidate.agentId)).size,
    3,
    `one distinct worker per task, not one id repeated; candidates=${JSON.stringify(candidates)}`,
  )
  assert.equal(
    candidates.some((candidate) => candidate.agentId === 'coordinator'),
    false,
    'work never queues behind the coordinator seat',
  )
  assert.equal(
    candidates.every((candidate) => candidate.role === undefined),
    true,
    'roleless work dispatches with no role, never a stand-in',
  )
}

function testRolelessCoordinationTaskKeepsThePersistentSeat(): void {
  // MC-1454 preserved for the right reason: the coordination task routes to the
  // seat because it IS the coordination job, so sequential coordination tasks
  // share one id — even though the seat has already owned a task, which is what
  // excludes an ordinary worker from a new claim.
  const state = rolelessStateFixture({
    tasks: [
      task({ id: 'T-gate', role: undefined, ownedPaths: [] }),
      task({ id: 'T-work', role: undefined, ownedPaths: ['src/a'] }),
    ],
    artifacts: [planArtifact('T-gate')],
    sprintEngineAgents: { coordinator: rolelessAgent({ lastOwnedTaskId: 'T-earlier' }) },
  })

  const candidates = pickNextAutoRuns(workspaceFixture(), state, pickOptions())
  assert.equal(
    candidates.find((candidate) => candidate.taskId === 'T-gate')?.agentId,
    'coordinator',
    `the coordination task keeps the persistent seat; candidates=${JSON.stringify(candidates)}`,
  )
  assert.notEqual(
    candidates.find((candidate) => candidate.taskId === 'T-work')?.agentId,
    'coordinator',
    'ordinary work beside it is still task-scoped',
  )
}

function testArchitectRunDispatchIsUnchanged(): void {
  // The named-role clause is what keeps a role-based run byte-identical: an
  // architect-assigned task that is NOT the plan gate still routes to the one
  // warm architect, never `architect-N`. Real runs on disk carry exactly that
  // shape (multi-repo-sprints T5/T11/T14, backlog-sourced-sprints T12).
  const state = stateFixture({
    configuredRoles: ['architect', 'developer'],
    tasks: [
      task({ id: 'T-signoff', role: 'architect', ownedPaths: ['docs'] }),
      task({ id: 'T-work', role: 'developer', ownedPaths: ['src'] }),
    ],
    artifacts: [planArtifact('T0')],
    sprintEngineAgents: {
      architect: { role: 'architect', status: 'idle', currentTaskId: null, lastOwnedTaskId: 'T0' } as SprintEngineRuntimeAgent,
    },
  })

  const candidates = pickNextAutoRuns(workspaceFixture(), state, pickOptions())
  assert.equal(
    candidates.find((candidate) => candidate.taskId === 'T-signoff')?.agentId,
    'architect',
    `a non-gate architect task stays on the warm architect; candidates=${JSON.stringify(candidates)}`,
  )
  assert.equal(
    candidates.find((candidate) => candidate.taskId === 'T-work')?.agentId,
    'developer-1',
    'specialist work is task-scoped and mints its own worker',
  )
}

function testRolelessRunBootstrapsItsCoordinatorSeat(): void {
  // The load-bearing fourth site: the bootstrap used to resolve its planner by
  // role, so a run staffing none stalled `no_planner` before dispatch was ever
  // reached — the epic would have appeared to fail for an unrelated reason.
  const bootstrapOptions = { runningAgentIds: new Set<string>(), inFlightSpawnKeys: new Set<string>() }
  const roleless = pickSprintEngineBootstrapCandidate(
    workspaceFixture(),
    rolelessStateFixture({ sprintEngineAgents: { coordinator: rolelessAgent() } }),
    bootstrapOptions,
  )
  assert.equal(roleless.kind, 'spawn', `a roleless run bootstraps rather than stalling; decision=${JSON.stringify(roleless)}`)
  if (roleless.kind === 'spawn') {
    assert.equal(roleless.candidate.agentId, 'coordinator')
    assert.equal(roleless.candidate.role, undefined, 'the seat carries no role into the spawn')
  }

  // A store that recorded no role set at all is legacy/headless, not roleless:
  // it keeps its architect seat.
  const legacy = pickSprintEngineBootstrapCandidate(
    workspaceFixture(),
    stateFixture({
      sprintEngineAgents: {
        architect: { role: 'architect', status: 'idle', currentTaskId: null } as SprintEngineRuntimeAgent,
      },
    }),
    bootstrapOptions,
  )
  assert.equal(legacy.kind, 'spawn')
  if (legacy.kind === 'spawn') assert.equal(legacy.candidate.agentId, 'architect')

  // A roster that seats its architect under a SUFFIXED id still bootstraps: a
  // named seat answers for `architect-1` too, which is why the lookup falls back
  // to the seat question rather than requiring the deterministic id.
  const suffixed = pickSprintEngineBootstrapCandidate(
    workspaceFixture(),
    stateFixture({
      configuredRoles: ['architect'],
      sprintEngineAgents: {
        'architect-1': { role: 'architect', status: 'idle', currentTaskId: null } as SprintEngineRuntimeAgent,
      },
    }),
    bootstrapOptions,
  )
  assert.equal(suffixed.kind, 'spawn', `a suffixed architect seat bootstraps; decision=${JSON.stringify(suffixed)}`)
  if (suffixed.kind === 'spawn') assert.equal(suffixed.candidate.agentId, 'architect-1')

  // A roster with neither is the broken store `no_planner` was written for.
  const noSeat = pickSprintEngineBootstrapCandidate(
    workspaceFixture(),
    rolelessStateFixture({
      sprintEngineAgents: { 'agent-1': rolelessAgent() },
    }),
    bootstrapOptions,
  )
  assert.deepEqual(noSeat, { kind: 'stall', reason: 'no_planner' }, 'a minted worker never bootstraps in the seat\'s place')
}

function testMintedRolelessWorkerIsTaskScopedForWakeAndRevival(): void {
  // A minted roleless worker carries no role, exactly like the roleless
  // coordinator — so only the SEAT (asked by id) may be exempt from MC-1444
  // task-scoping, or the worker would be woken for, and revived onto, work it
  // never owned.
  const state = rolelessStateFixture({
    tasks: [
      task({ id: 'T1', role: undefined, status: 'done', boardColumn: 'done' }),
      task({ id: 'T2', role: undefined, ownedPaths: ['src/b'] }),
    ],
    artifacts: [planArtifact('T0')],
    sprintEngineAgents: { 'agent-1': rolelessAgent({ lastOwnedTaskId: 'T1' }) },
  })
  assert.equal(
    sprintEngineWakeRestrictionTaskId('agent-1', state.sprintEngineAgents['agent-1'], state),
    'T1',
    'a used roleless worker is restricted to its own task',
  )
  assert.equal(
    sprintEngineWakeRestrictionTaskId('coordinator', rolelessAgent({ lastOwnedTaskId: 'T1' }), state),
    null,
    'the seat is unrestricted — the only difference from the worker above is its id',
  )

  const plan = planSprintEngineDispatch({
    workspace: workspaceFixture({ agents: { 'agent-1': { id: 'agent-1', name: 'agent-1' } } } as never),
    sprintEngineState: state,
    now: Date.now(),
    runningAgentIds: new Set(),
    idleAgentIds: new Set(),
    continuationLedger: new Map(),
    dispatchLedger: new Map(),
    paths: new Set(['respawn'] as const) as never,
  })
  assert.deepEqual(
    plan.respawns.map((respawn) => respawn.agentId),
    [],
    `a departed roleless worker is not revived onto another task's work; respawns=${JSON.stringify(plan.respawns)}`,
  )
}

function testDepartedCoordinatorIsRevivedOnlyForCoordinatorRoutedWork(): void {
  // The seat keeps its persistent revival (MC-1454) — and only for work that
  // routes to it. A role comparison would have revived the roleless coordinator
  // onto the first ready task of "its role", which on a roleless run is every
  // task in the graph.
  const state = rolelessStateFixture({
    tasks: [
      task({ id: 'T-work', role: undefined, ownedPaths: ['src/a'] }),
      task({ id: 'T-gate', role: undefined, ownedPaths: [] }),
    ],
    artifacts: [planArtifact('T-gate')],
    sprintEngineAgents: { coordinator: rolelessAgent({ lastOwnedTaskId: 'T-earlier' }) },
  })

  const plan = planSprintEngineDispatch({
    workspace: workspaceFixture({ agents: { coordinator: { id: 'coordinator', name: 'Coordinator' } } } as never),
    sprintEngineState: state,
    now: Date.now(),
    runningAgentIds: new Set(),
    idleAgentIds: new Set(),
    continuationLedger: new Map(),
    dispatchLedger: new Map(),
    paths: new Set(['respawn'] as const) as never,
  })
  assert.deepEqual(
    plan.respawns.map((respawn) => [respawn.agentId, respawn.taskId]),
    [['coordinator', 'T-gate']],
    `the seat is revived for the coordination task, never for the work task listed before it; respawns=${JSON.stringify(plan.respawns)}`,
  )
}

// --- MC-2050: wake asks the same routing rule dispatch does -----------------

/**
 * What wake asked before the routing rule reached it: role equality, with the
 * seat left unrestricted. Kept here as an executable statement of the old
 * behaviour so "the architect path is unchanged" is asserted against it rather
 * than against a remembered claim.
 */
function legacyWakeMatch(candidate: SprintEngineTask, role: SprintEngineRoleId | undefined): boolean {
  return candidate.role === role
}

function testRolelessWakeOffersTheSeatOnlyCoordinationWork(): void {
  // F2: on a roleless run the seat and every work task both carry NO role, so
  // `absent === absent` matched and the (deliberately unrestricted) seat was
  // offered ordinary work that dispatch fans out to task-scoped workers. The
  // work task is listed FIRST so a role-equality match would return it.
  const work = task({ id: 'T-work', role: undefined, ownedPaths: ['src/a'] })
  const gate = task({ id: 'T-gate', role: undefined, ownedPaths: [] })
  const state = rolelessStateFixture({
    tasks: [work, gate],
    artifacts: [planArtifact('T-gate')],
    sprintEngineAgents: {
      coordinator: rolelessAgent({ lastOwnedTaskId: 'T-earlier' }),
      'agent-1': rolelessAgent(),
    },
  })
  const wakeTasks = getSprintEngineWakeCandidateTasks(state)
  assert.deepEqual(wakeTasks.map((candidate) => candidate.id), ['T-work', 'T-gate'], 'both tasks are claimable wake work')

  const seatWake = (tasks: SprintEngineTask[]): string | undefined =>
    findSprintEngineWakeCandidateTaskForAgent(tasks, undefined, 'coordinator', new Set(), null, 'primary', state)?.id

  assert.equal(
    seatWake([work]),
    undefined,
    'the idle roleless coordinator is offered NO wake candidate for an unowned ordinary task',
  )
  assert.equal(legacyWakeMatch(work, undefined), true, 'and role equality is exactly what used to offer it')
  assert.equal(seatWake(wakeTasks), 'T-gate', 'it is still offered the coordination task, listed second')
  assert.equal(
    sprintEngineWakeRestrictionTaskId('coordinator', state.sprintEngineAgents.coordinator, state),
    null,
    'the seat stays unrestricted — MC-1454 revival for the next coordination task is untouched',
  )

  // The mirror image: coordination work is the seat's alone, so a minted worker
  // is never woken onto it. Wake now answers exactly what dispatch answers.
  const workerWake = (tasks: SprintEngineTask[]): string | undefined =>
    findSprintEngineWakeCandidateTaskForAgent(tasks, undefined, 'agent-1', new Set(), null, 'primary', state)?.id
  assert.equal(workerWake(wakeTasks), 'T-work', 'a minted roleless worker is offered the ordinary task')
  assert.equal(workerWake([gate]), undefined, 'and never the coordination task the seat owns')
  for (const candidate of wakeTasks) {
    assert.equal(
      seatWake([candidate]) !== undefined,
      sprintEngineTaskRoutesToCoordinator(candidate, state),
      `wake and dispatch agree on ${candidate.id}`,
    )
  }
}

function testRolelessCoordinatorIsNotWokenForOrdinaryWorkEndToEnd(): void {
  // The planner-level statement of the same thing: the symptom F2 reported was a
  // wake PASTE landing in the persistent seat's terminal for another task's work.
  // The shape is a run mid-flight — the gate is done, its plan artifact still
  // live, and the seat idle beside ready implementation work.
  const now = Date.now()
  const state = rolelessStateFixture({
    tasks: [
      task({ id: 'T-gate', role: undefined, status: 'done', boardColumn: 'done' }),
      task({ id: 'T-work', role: undefined, ownedPaths: ['src/a'] }),
    ],
    artifacts: [planArtifact('T-gate')],
    sprintEngineAgents: { coordinator: rolelessAgent({ lastOwnedTaskId: 'T-earlier' }) },
  })
  const plan = planSprintEngineDispatch({
    workspace: workspaceFixture({ agents: { coordinator: { id: 'coordinator', name: 'Coordinator' } } } as never),
    sprintEngineState: state,
    now,
    runningAgentIds: new Set(),
    idleAgentIds: new Set(['coordinator']),
    continuationLedger: new Map(),
    dispatchLedger: new Map(),
    paths: new Set(['task_wake'] as const) as never,
  })
  assert.deepEqual(
    plan.pastes.map((paste) => paste.agentId),
    [],
    `no wake paste re-serialises ordinary work onto the seat; pastes=${JSON.stringify(plan.pastes)}`,
  )
}

function testArchitectRunWakeIsUnchanged(): void {
  // Acceptance: the architect path answers exactly as it did before, asserted
  // against `legacyWakeMatch` rather than against re-stated expectations. The
  // named clause is what makes the two agree there — the seat's role IS
  // `architect`, so role equality and the routing rule select the same work.
  // The GATE is in the matrix too, and it is the one shape where the two rules
  // could disagree: a coordination task routes to the seat whatever role it
  // wears, so a plan-bound task wearing `developer` would be offered to the
  // architect where role equality would not have offered it. That state is
  // unreachable — `ensure_plan_approval_gate` writes the gate with the SEAT's
  // role, which on an architect run is `architect` — so the gate is pinned here
  // in the shape the engine actually produces.
  const gate = task({ id: 'T-gate', role: 'architect', ownedPaths: [] })
  const signoff = task({ id: 'T-signoff', role: 'architect', ownedPaths: ['docs'] })
  const work = task({ id: 'T-work', role: 'developer', ownedPaths: ['src'] })
  const state = stateFixture({
    configuredRoles: ['architect', 'developer'],
    tasks: [gate, signoff, work],
    artifacts: [planArtifact('T-gate')],
    sprintEngineAgents: {
      architect: { role: 'architect', status: 'idle', currentTaskId: null, lastOwnedTaskId: 'T0' } as SprintEngineRuntimeAgent,
      'developer-1': { role: 'developer', status: 'idle', currentTaskId: null } as SprintEngineRuntimeAgent,
    },
  })
  assert.equal(sprintEngineTaskRoutesToCoordinator(gate, state), true, 'the gate is the coordination task on this run')
  const agents: [string, SprintEngineRoleId | undefined][] = [
    ['architect', 'architect'],
    ['architect-2', 'architect'],
    ['developer-1', 'developer'],
  ]
  for (const [agentId, role] of agents) {
    for (const candidate of [gate, signoff, work]) {
      assert.equal(
        findSprintEngineWakeCandidateTaskForAgent([candidate], role, agentId, new Set(), null, 'primary', state) !== undefined,
        legacyWakeMatch(candidate, role),
        `${agentId} on ${candidate.id} answers exactly as the pre-change role comparison did`,
      )
    }
  }
}

// --- MC-2057: coordinator engagement asks the seat, not the role name -------

/**
 * The idle_retire skip that keeps the triage seat alive. Returns the plan for a
 * run whose only blocker is one architect-KIND `needs_input` task, with
 * `seatAgentId` live, idle, unclaimed, and well past the 5-minute window.
 */
function triageRetirementPlan(input: {
  configuredRoles?: string[]
  seatAgentId: string
  seatRole?: string
}): ReturnType<typeof planSprintEngineDispatch> {
  const now = Date.now()
  const state = stateFixture({
    ...(input.configuredRoles ? { configuredRoles: input.configuredRoles as never } : {}),
    tasks: [
      task({
        id: 'T-blocked',
        role: undefined,
        status: 'needs_input',
        boardColumn: 'needs_input',
        ownerAgentId: 'worker-1',
        needsInput: { kind: 'architect', reason: 'plan ambiguity' },
      } as never),
    ],
    sprintEngineAgents: {
      [input.seatAgentId]: {
        ...(input.seatRole ? { role: input.seatRole } : {}),
        status: 'idle',
        currentTaskId: null,
        currentDispatch: null,
      },
    } as never,
  })
  const workspace = workspaceFixture({
    agents: { [input.seatAgentId]: { id: input.seatAgentId, name: input.seatAgentId } },
  } as never)

  return planSprintEngineDispatch({
    workspace,
    sprintEngineState: state,
    now,
    runningAgentIds: new Set(),
    idleAgentIds: new Set([input.seatAgentId]),
    continuationLedger: new Map(),
    dispatchLedger: new Map(),
    idleClock: new Map([[`${workspace.sprintEngineContext?.statePath}:${input.seatAgentId}`, now - 60 * 60_000]]),
    retirementCooldown: new Map(),
    taskScopedRetirementTaskIds: new Map(),
    paths: new Set(['idle_retire'] as const) as never,
  })
}

function testRolelessCoordinatorIsNotRetiredWhileTriageWorkIsPending(): void {
  // The F1 gap: the skip was `runtimeAgent.role === 'architect'`, so a roleless
  // coordinator was retired WHILE its own architect-KIND blocker waited. A
  // needs_input task carries an owner, so nothing re-engages anyone afterwards
  // — the blocker stuck permanently.
  const plan = triageRetirementPlan({ configuredRoles: [], seatAgentId: 'coordinator' })

  assert.deepEqual(
    plan.retirements.map((retirement) => retirement.agentId),
    [],
    `the roleless seat survives its own pending triage; retirements=${JSON.stringify(plan.retirements)}`,
  )
  assert.ok(
    plan.skips.some((skip) => (skip.data as { agentId?: string; reason?: string }).reason === 'architect-triage-work'),
    `and states why; skips=${JSON.stringify(plan.skips)}`,
  )
}

function testArchitectSeatRetirementSkipIsUnchanged(): void {
  // The named seat answers the same on both id shapes it is seated into, which
  // is what the role comparison used to cover.
  for (const agentId of ['architect', 'architect-2']) {
    const plan = triageRetirementPlan({
      configuredRoles: ['architect', 'developer'],
      seatAgentId: agentId,
      seatRole: 'architect',
    })
    assert.deepEqual(
      plan.retirements.map((retirement) => retirement.agentId),
      [],
      `${agentId} still holds its triage work; retirements=${JSON.stringify(plan.retirements)}`,
    )
  }

  // A task-scoped worker on the same run is NOT the seat and is still retired.
  const workerPlan = triageRetirementPlan({
    configuredRoles: ['architect', 'developer'],
    seatAgentId: 'developer-1',
    seatRole: 'developer',
  })
  assert.deepEqual(
    workerPlan.retirements.map((retirement) => retirement.agentId),
    ['developer-1'],
    `a non-seat idle worker is unaffected by pending triage; skips=${JSON.stringify(workerPlan.skips)}`,
  )
}

function testMintedRolelessWorkerIsRetiredWhileTriageWorkIsPending(): void {
  // The mistake the id-aware seat test exists to prevent: `agent-1` must never
  // read as the roleless seat, or every idle worker on a blocked run would be
  // kept alive forever.
  const plan = triageRetirementPlan({ configuredRoles: [], seatAgentId: 'agent-1' })
  assert.deepEqual(
    plan.retirements.map((retirement) => retirement.agentId),
    ['agent-1'],
    `a minted roleless worker is not mistaken for the seat; skips=${JSON.stringify(plan.skips)}`,
  )
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
  testReleasedTaskGetsAFreshMint()
  testUnownedNeedsInputTaskIsNotARevivalTarget()
  testFinishedTaskScopedWorkerIsTornDownOnFirstIdleTick()
  testRolelessReadyTasksFanOutOneWorkerEach()
  testRolelessCoordinationTaskKeepsThePersistentSeat()
  testArchitectRunDispatchIsUnchanged()
  testRolelessRunBootstrapsItsCoordinatorSeat()
  testMintedRolelessWorkerIsTaskScopedForWakeAndRevival()
  testRolelessWakeOffersTheSeatOnlyCoordinationWork()
  testRolelessCoordinatorIsNotWokenForOrdinaryWorkEndToEnd()
  testArchitectRunWakeIsUnchanged()
  testDepartedCoordinatorIsRevivedOnlyForCoordinatorRoutedWork()
  testRolelessCoordinatorIsNotRetiredWhileTriageWorkIsPending()
  testArchitectSeatRetirementSkipIsUnchanged()
  testMintedRolelessWorkerIsRetiredWhileTriageWorkIsPending()
  console.log('auto-run.test.ts: all tests passed')
}

main()
