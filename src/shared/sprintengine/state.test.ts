import assert from 'node:assert/strict'

import {
  buildSprintEngineAgentRosterForState,
  deriveSprintEngineRepoMergeRollup,
  isCompletedSprintEngineRun,
  normalizeSprintEngineProjection,
  normalizeSprintEngineRoleRuntimes,
  resolveSprintEngineAgentRuntime,
  resolveSprintEngineRoleRuntime,
} from './state'
import type { SprintEngineTask, SprintEngineVcs } from './run-types'

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

function testVcsReposRoundTripWithoutFieldLoss(): void {
  // AC1: every field of a declared repo survives parse. `repos` is whitelisted
  // field-by-field, so a missed field would silently vanish here.
  const repos = [
    {
      id: 'primary',
      root: '.',
      worktreePath: '.multi-code/wt/app',
      branchName: 'run/main',
      baseRef: 'main',
      status: 'ready',
      lastCommitSha: 'abc1234',
      pullRequestUrl: 'https://github.com/acme/multicode/pull/1',
      pullRequestError: null,
      pullRequestState: 'open' as const,
    },
    {
      id: 'mobile',
      root: '../multicode-mobile',
      worktreePath: '.multi-code/wt/mobile',
      branchName: 'run/main',
      baseRef: 'main',
      status: 'committed',
      lastCommitSha: 'def5678',
      // Each project carries its own pull request and its own merge state.
      pullRequestUrl: 'https://github.com/acme/multicode-mobile/pull/9',
      pullRequestError: null,
      pullRequestState: 'merged' as const,
    },
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
  assert.deepEqual(state.vcs.repos, repos, 'declared repos round-trip with no field loss')
  // The flat fields still parse alongside the list they duplicate.
  assert.equal(state.vcs.worktreePath, '.multi-code/wt/app')
  assert.equal(state.vcs.branchName, 'run/main')
}

function testVcsFlatBlockReadsBackAsOneEntryRepoList(): void {
  // AC2: a run stored before `vcs.repos` existed describes its one repo with the
  // flat fields; readers only ever handle the list, so it derives entry zero.
  const projection = v3Projection({
    run: {
      name: 'Work Queue',
      goal: 'ship it',
      status: 'planning',
      vcs: {
        mode: 'run_worktree',
        worktreePath: '.multi-code/wt/app',
        branchName: 'run/main',
        baseRef: 'main',
        status: 'ready',
        lastCommitSha: 'abc1234',
      },
    },
  })
  const state = normalizeSprintEngineProjection(projection)
  assert.ok(state?.vcs)
  assert.deepEqual(
    state.vcs.repos,
    [
      {
        id: 'primary',
        root: '.',
        worktreePath: '.multi-code/wt/app',
        branchName: 'run/main',
        baseRef: 'main',
        status: 'ready',
        lastCommitSha: 'abc1234',
        pullRequestUrl: null,
        pullRequestError: null,
        pullRequestState: null,
      },
    ],
    'flat block reads back as the primary repo, values identical',
  )
}

function testVcsPrimaryPullRequestReadsBackOnBothShapes(): void {
  // The primary's pull request is stored twice: flat, where every surface that
  // predates `repos` reads it, and on entry zero. Both must carry it, or a chip
  // reads one shape and finds nothing.
  const projection = v3Projection({
    run: {
      name: 'Work Queue',
      goal: 'ship it',
      status: 'planning',
      vcs: {
        mode: 'run_worktree',
        worktreePath: '.multi-code/wt/app',
        branchName: 'run/main',
        pullRequestUrl: 'https://github.com/acme/multicode/pull/1',
        pullRequestState: 'merged',
        pullRequestError: 'stale',
      },
    },
  })
  const state = normalizeSprintEngineProjection(projection)
  assert.ok(state?.vcs)
  assert.equal(state.vcs.pullRequestUrl, 'https://github.com/acme/multicode/pull/1')
  assert.equal(state.vcs.pullRequestState, 'merged')
  assert.equal(state.vcs.pullRequestError, 'stale')
  assert.equal(state.vcs.repos[0].pullRequestUrl, 'https://github.com/acme/multicode/pull/1')
  assert.equal(state.vcs.repos[0].pullRequestState, 'merged')
  assert.equal(state.vcs.repos[0].pullRequestError, 'stale')
}

function testVcsPullRequestStateOfAnUnknownValueIsNull(): void {
  const projection = v3Projection({
    run: {
      name: 'Work Queue',
      goal: 'ship it',
      status: 'planning',
      vcs: {
        mode: 'run_worktree',
        worktreePath: '.multi-code/wt/app',
        branchName: 'run/main',
        repos: [
          {
            id: 'primary',
            root: '.',
            worktreePath: '.multi-code/wt/app',
            branchName: 'run/main',
            pullRequestState: 'draft',
          },
        ],
      },
    },
  })
  const state = normalizeSprintEngineProjection(projection)
  assert.ok(state?.vcs)
  assert.equal(state.vcs.repos[0].pullRequestState, null, 'an unknown merge state is not invented')
}

function testVcsReposUnresolvableEntriesDropped(): void {
  // An entry with no tree to resolve would silently scope work to the wrong
  // worktree; drop it and keep the repos that do resolve.
  const projection = v3Projection({
    run: {
      name: 'Work Queue',
      goal: 'ship it',
      status: 'planning',
      vcs: {
        mode: 'run_worktree',
        worktreePath: '.multi-code/wt/app',
        branchName: 'run/main',
        repos: [
          { id: 'primary', root: '.', worktreePath: '.multi-code/wt/app', branchName: 'run/main' },
          { id: 'broken', root: '../other', branchName: 'run/main' },
        ],
      },
    },
  })
  const state = normalizeSprintEngineProjection(projection)
  assert.ok(state?.vcs)
  assert.deepEqual(state.vcs.repos.map((repo) => repo.id), ['primary'], 'entry with no worktreePath dropped')
}

function mergeRollupState(repos: Record<string, unknown>[]): ReturnType<typeof normalizeSprintEngineProjection> {
  return normalizeSprintEngineProjection(
    v3Projection({
      run: {
        name: 'Work Queue',
        goal: 'ship it',
        status: 'planning',
        vcs: { mode: 'run_worktree', worktreePath: '.multi-code/wt/app', branchName: 'run/main', repos },
      },
    }),
  )
}

function testMergeRollupCountsDroppedDeclaredEntryAsUnmerged(): void {
  // Backlog 1722: the bug shape. A declared sibling that is incomplete (no
  // worktreePath) is dropped from `repos`, but it must still count toward the
  // rollup — otherwise `allMerged` flips true off the surviving primary alone and
  // the run-landed chain fires on an unmerged declared branch.
  const state = mergeRollupState([
    { id: 'primary', root: '.', worktreePath: '.multi-code/wt/app', branchName: 'run/main', pullRequestState: 'merged' },
    { id: 'mobile', root: '../mobile', branchName: 'run/main' },
  ])
  assert.ok(state?.vcs)
  assert.equal(state.vcs.repos.length, 1, 'the incomplete sibling is dropped from the survivor list')
  assert.equal(state.vcs.declaredRepoCount, 2, 'but two repos were declared')
  const rollup = deriveSprintEngineRepoMergeRollup(state.vcs)
  assert.ok(rollup)
  assert.equal(rollup.total, 2, 'the rollup counts the declared sibling, not just survivors')
  assert.equal(rollup.merged, 1)
  assert.equal(rollup.unmerged, 1)
  assert.equal(rollup.allMerged, false, 'fail closed: a dropped declared branch keeps the run unmerged')
}

function testMergeRollupAllMergedWhenEveryDeclaredRepoMerged(): void {
  const state = mergeRollupState([
    { id: 'primary', root: '.', worktreePath: '.multi-code/wt/app', branchName: 'run/main', pullRequestState: 'merged' },
    { id: 'mobile', root: '../mobile', worktreePath: '.multi-code/wt/mobile', branchName: 'run/main', pullRequestState: 'merged' },
  ])
  const rollup = deriveSprintEngineRepoMergeRollup(state?.vcs)
  assert.ok(rollup)
  assert.equal(rollup.total, 2)
  assert.equal(rollup.merged, 2)
  assert.equal(rollup.allMerged, true, 'every declared repo merged rolls up to allMerged')
}

function testMergeRollupOpenSiblingHoldsAllMergedFalse(): void {
  const state = mergeRollupState([
    { id: 'primary', root: '.', worktreePath: '.multi-code/wt/app', branchName: 'run/main', pullRequestState: 'merged' },
    { id: 'mobile', root: '../mobile', worktreePath: '.multi-code/wt/mobile', branchName: 'run/main', pullRequestState: 'open' },
  ])
  const rollup = deriveSprintEngineRepoMergeRollup(state?.vcs)
  assert.ok(rollup)
  assert.deepEqual(
    { total: rollup.total, merged: rollup.merged, unmerged: rollup.unmerged, allMerged: rollup.allMerged },
    { total: 2, merged: 1, unmerged: 1, allMerged: false },
  )
}

function testMergeRollupZeroCommitSiblingHasNoBranchToMerge(): void {
  // A fully provisioned sibling that delivered NOTHING (no commit on the run
  // branch, no PR — e.g. its only task was canceled, which is terminal under
  // MC-1749) has no branch to merge. The engine skips it (`vcs.pr` reports
  // `no_commits`) so its PR state can never advance; counting it would hold
  // `allMerged` false forever and wedge run-landed chaining + roadmap advance.
  const state = mergeRollupState([
    { id: 'primary', root: '.', worktreePath: '.multi-code/wt/app', branchName: 'run/main', lastCommitSha: 'abc123', pullRequestState: 'merged' },
    { id: 'mobile', root: '../mobile', worktreePath: '.multi-code/wt/mobile', branchName: 'run/main', lastCommitSha: null, status: 'ready' },
  ])
  const rollup = deriveSprintEngineRepoMergeRollup(state?.vcs)
  assert.ok(rollup)
  assert.deepEqual(
    { total: rollup.total, merged: rollup.merged, unmerged: rollup.unmerged, allMerged: rollup.allMerged },
    { total: 1, merged: 1, unmerged: 0, allMerged: true },
    'a zero-commit no-PR sibling is not a branch left to merge',
  )
  // A sibling with commits but no PR yet still counts — it has a branch to land.
  const committed = mergeRollupState([
    { id: 'primary', root: '.', worktreePath: '.multi-code/wt/app', branchName: 'run/main', lastCommitSha: 'abc123', pullRequestState: 'merged' },
    { id: 'mobile', root: '../mobile', worktreePath: '.multi-code/wt/mobile', branchName: 'run/main', lastCommitSha: 'def456' },
  ])
  const committedRollup = deriveSprintEngineRepoMergeRollup(committed?.vcs)
  assert.equal(committedRollup?.allMerged, false, 'a committed-but-unmerged sibling still holds the run open')
}

function testMergeRollupRunThatDeliveredNothingStaysUnlanded(): void {
  // Every leg delivered nothing: there is no landing to report, so the rollup
  // stays fail-closed rather than reading all-merged on an empty run.
  const state = mergeRollupState([
    { id: 'primary', root: '.', worktreePath: '.multi-code/wt/app', branchName: 'run/main', lastCommitSha: null },
  ])
  const rollup = deriveSprintEngineRepoMergeRollup(state?.vcs)
  assert.ok(rollup)
  assert.equal(rollup.allMerged, false, 'a run with nothing to merge never reads all-merged')
}

function testMergeRollupSingleRepoAndNullVcs(): void {
  // A single-repo run rolls up to total 1 — the flat field's answer.
  const single = mergeRollupState([
    { id: 'primary', root: '.', worktreePath: '.multi-code/wt/app', branchName: 'run/main', pullRequestState: 'merged' },
  ])
  const singleRollup = deriveSprintEngineRepoMergeRollup(single?.vcs)
  assert.deepEqual(
    { total: singleRollup?.total, merged: singleRollup?.merged, allMerged: singleRollup?.allMerged },
    { total: 1, merged: 1, allMerged: true },
  )
  // A `vcs` restored from state written before `declaredRepoCount` existed has no
  // count; the rollup floors on the survivor list rather than reading undefined.
  const legacy = deriveSprintEngineRepoMergeRollup({
    mode: 'run_worktree',
    worktreePath: '.multi-code/wt/app',
    branchName: 'run/main',
    pullRequestState: 'merged',
    repos: [],
  } as unknown as SprintEngineVcs)
  assert.deepEqual(
    { total: legacy?.total, merged: legacy?.merged, allMerged: legacy?.allMerged },
    { total: 1, merged: 1, allMerged: true },
    'a pre-field flat run still rolls up to a merged single repo',
  )
  assert.equal(deriveSprintEngineRepoMergeRollup(null), null, 'no vcs is no rollup')
}

function testCategoricalFindingsSurviveNormalization(): void {
  // `findingJson` is categorical-only ({kind, severity, area, title?}); prose
  // `title`/`detail` are optional. Findings without them must survive — the
  // run summary's review signals are built from these.
  const projection = v3Projection({
    tasks: [
      {
        id: 'T7',
        title: 'Surface work',
        role: 'frontend',
        status: 'done',
        feedback: {
          schemaVersion: 4,
          capturedAt: '2026-07-18T01:25:56Z',
          source: 'phase_advance_self_review',
          agentId: 'frontend-2',
          role: 'frontend',
          scores: { hallucinationRiskPct: 5 },
          findings: [
            { id: 'T7-F1', kind: 'other', severity: 'low', area: 'frontend', status: 'open' },
            { id: 'T7-F2', kind: 'code_bug', severity: 'medium', area: 'frontend', title: 'label only', status: 'open' },
            { id: 'bad', kind: 'not_a_kind', severity: 'low', area: 'frontend' },
          ],
        },
      },
    ],
  })
  const state = normalizeSprintEngineProjection(projection)
  const findings = state?.tasks[0]?.feedback?.findings ?? []
  assert.equal(findings.length, 2, 'categorical findings kept, invalid enum dropped')
  assert.equal(findings[0].title, undefined, 'absent prose stays absent, not fabricated')
  assert.equal(findings[1].title, 'label only')
}

function testBothReviewCharterMarkersSurviveProjection(): void {
  // MC-1818 added `review` alongside `integration_review`. The projection used
  // to whitelist only `integration_review`, so a planned review would reach the
  // board looking like ordinary work — in the one surface a human uses to check
  // that reviews were planned at all. Both markers must survive; anything else
  // must not become one.
  const state = normalizeSprintEngineProjection(
    v3Projection({
      tasks: [
        { id: 'T1', title: 'Build', role: 'developer', status: 'done' },
        { id: 'T2', title: 'Review T1', role: 'developer', status: 'todo', kind: 'review' },
        { id: 'T3', title: 'Prove the seams', role: 'developer', status: 'todo', kind: 'integration_review' },
        { id: 'T4', title: 'Explicit work', role: 'developer', status: 'todo', kind: 'work' },
        { id: 'T5', title: 'Nonsense marker', role: 'developer', status: 'todo', kind: 'sweep' },
      ],
    })
  )
  const kinds = (state?.tasks ?? []).map((task) => task.kind)
  assert.deepEqual(
    kinds,
    [undefined, 'review', 'integration_review', undefined, undefined],
    'both review markers survive; work and unknown markers carry no kind'
  )
}

// `backlogRef` is the identity the Epic tab's mapping column, the child→task
// link and the task header pointer all key on, so it must reach the renderer
// off the projection rather than being parsed out of run internals. Absent is
// the normal case — most tasks deliver no item, and a store written before the
// field existed carries none — and a record with no usable path must read as
// absent rather than as a pointer at nothing.
function testBacklogRefSurvivesProjectionAndToleratesAbsence(): void {
  const state = normalizeSprintEngineProjection(
    v3Projection({
      tasks: [
        {
          id: 'T1',
          title: 'Deliver the item',
          role: 'developer',
          status: 'todo',
          backlogRef: { projectRelativePath: 'backlog/2026-07-30-example.md', displayKey: 'MC-2020' },
        },
        { id: 'T2', title: 'Deliver no item', role: 'developer', status: 'todo' },
        { id: 'T3', title: 'Pointer at nothing', role: 'developer', status: 'todo', backlogRef: { displayKey: 'MC-2021' } },
        { id: 'T4', title: 'Not an object', role: 'developer', status: 'todo', backlogRef: 'backlog/x.md' },
      ],
    })
  )
  const refs = (state?.tasks ?? []).map((task) => task.backlogRef)
  assert.deepEqual(
    refs,
    [
      { projectRelativePath: 'backlog/2026-07-30-example.md', displayKey: 'MC-2020' },
      undefined,
      undefined,
      undefined,
    ],
    'a usable pointer survives whole; absent, path-less, and non-object records all read as absent'
  )
}

// Completion is done-or-canceled, mirroring the engine's recompute_phase
// rollup exactly. Strict every-done here while Python tolerates canceled
// produced a run whose state said "completed" but whose TS consumers
// (dormancy, chaining triggers, tracker write-back) never released.
function testCompletionToleratesCanceledTasks(): void {
  const task = (id: string, status: SprintEngineTask['status']) => ({ status, id }) as SprintEngineTask
  assert.equal(isCompletedSprintEngineRun({ tasks: [] }), false, 'empty run is never complete')
  assert.equal(isCompletedSprintEngineRun({ tasks: [task('T1', 'done')] }), true)
  assert.equal(
    isCompletedSprintEngineRun({ tasks: [task('T1', 'done'), task('T2', 'canceled')] }),
    true,
    'one canceled task must not hold completion open'
  )
  assert.equal(isCompletedSprintEngineRun({ tasks: [task('T1', 'done'), task('T2', 'in_progress')] }), false)
}

testCompletionToleratesCanceledTasks()
testCategoricalFindingsSurviveNormalization()
testBothReviewCharterMarkersSurviveProjection()
testBacklogRefSurvivesProjectionAndToleratesAbsence()
testWorkersViewPopulatedFromProjectionWorkers()
testWorkersFallBackToRosterBridgeWhenAbsent()
testRosterBuilderDerivesFromWorkers()
testBoardConsumersRenderUnchangedFromV3()
testWorkersOrphanRolelessEntriesDropped()
testVcsReposRoundTripWithoutFieldLoss()
testVcsFlatBlockReadsBackAsOneEntryRepoList()
testVcsPrimaryPullRequestReadsBackOnBothShapes()
testVcsPullRequestStateOfAnUnknownValueIsNull()
testVcsReposUnresolvableEntriesDropped()
testMergeRollupCountsDroppedDeclaredEntryAsUnmerged()
testMergeRollupAllMergedWhenEveryDeclaredRepoMerged()
testMergeRollupOpenSiblingHoldsAllMergedFalse()
testMergeRollupZeroCommitSiblingHasNoBranchToMerge()
testMergeRollupRunThatDeliveredNothingStaysUnlanded()
testMergeRollupSingleRepoAndNullVcs()
console.log('sprintengine state tests passed')

// --- MC-1885: the seat reasoning-effort level ------------------------------

// The projection is the ONLY source of a seat's runtime. A level written into
// `roleRuntimes` must survive normalization and resolve like the model does —
// trimmed, with a blank meaning "the CLI's own default effort" (no flag).
function testRoleRuntimeResolvesReasoningLevel(): void {
  const runtimes = normalizeSprintEngineRoleRuntimes({
    developer: { cli: 'claude-code', model: ' claude-opus-5 ', reasoning: ' high ' },
    tester: { cli: 'claude-code', reasoning: '   ' },
    architect: { cli: 'claude-code' },
    // A level with no cli and no model has no seat to launch: dropped whole.
    frontend: { reasoning: 'max' },
  })
  assert.deepEqual(
    runtimes?.developer,
    { model: 'claude-opus-5', cli: 'claude-code', reasoning: 'high' },
    'the level survives projection normalization beside the model',
  )
  assert.equal(runtimes?.tester?.reasoning, undefined, 'a blank level normalizes away')
  assert.equal(runtimes?.frontend, undefined, 'a level alone never mints a runtime entry')

  assert.equal(resolveSprintEngineRoleRuntime(runtimes ?? undefined, 'developer')?.cliReasoning, 'high')
  assert.equal(
    resolveSprintEngineRoleRuntime(runtimes ?? undefined, 'architect')?.cliReasoning,
    undefined,
    'a seat with no level resolves to no effort flag',
  )
  assert.equal(
    resolveSprintEngineRoleRuntime(runtimes ?? undefined, 'nuclear_reviewer'),
    null,
    'a role absent from the map resolves null so callers preserve what they have',
  )
}

// The level layers exactly like the model: per-agent override > role config >
// the existing record. Proven with a projection-only resolve (no record at all),
// so a level can never be sourced from renderer state stored on the engine.
function testAgentRuntimeLayersReasoningLikeModel(): void {
  const runtimes = normalizeSprintEngineRoleRuntimes({
    developer: { cli: 'claude-code', model: 'claude-opus-5', reasoning: 'high' },
  }) ?? undefined

  assert.deepEqual(
    resolveSprintEngineAgentRuntime(runtimes, 'developer', undefined),
    { cli: 'claude-code', cliModel: 'claude-opus-5', cliReasoning: 'high' },
    'the projection alone resolves the full seat runtime',
  )

  assert.equal(
    resolveSprintEngineAgentRuntime(runtimes, 'developer', {
      cli: 'claude-code',
      cliReasoning: 'low',
      cliRuntimeOverride: { cli: 'claude-code', reasoning: 'max' },
    }).cliReasoning,
    'max',
    'an explicit per-agent override outranks the role config',
  )
  assert.equal(
    resolveSprintEngineAgentRuntime(runtimes, 'developer', {
      cli: 'claude-code',
      cliRuntimeOverride: { cli: 'claude-code', reasoning: null },
    }).cliReasoning,
    undefined,
    'override reasoning: null pins the CLI default even when the role configures a level',
  )
  assert.equal(
    resolveSprintEngineAgentRuntime(runtimes, 'developer', {
      cli: 'claude-code',
      cliReasoning: 'low',
    }).cliReasoning,
    'high',
    'the role config outranks a stale record value',
  )
  assert.equal(
    resolveSprintEngineAgentRuntime(undefined, 'developer', {
      cli: 'claude-code',
      cliReasoning: 'low',
    }).cliReasoning,
    'low',
    'a legacy run with no roleRuntimes preserves the record, never substitutes',
  )
}

testRoleRuntimeResolvesReasoningLevel()
testAgentRuntimeLayersReasoningLikeModel()
console.log('sprintengine seat reasoning tests passed')
