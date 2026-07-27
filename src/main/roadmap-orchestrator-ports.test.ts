import assert from 'node:assert/strict'
import test from 'node:test'

import { createRoadmapOrchestratorPorts } from './roadmap-orchestrator-ports'
import type { SprintEngineAutomationFrontDoors } from './automations/actions/sprint-engine'

// The two reads the orchestrator's completed-on-merge write and its merge-park
// message actually depend on, exercised against real projection payloads:
//
// - `readRunItemOutcomes` derives WHICH backlog items a delivered run addressed
//   from the run's own terminal task state (`sourceDocs` + task status). This is
//   MC-1904's honesty constraint in code: get it wrong and a skipped member reads
//   `completed`, which the item calls the worse lie.
// - `mergePullRequest` names the project and branch a refusal was for, which is
//   what turns MC-1909's unactionable "a merge could not complete" into something
//   a person away from their machine can act on.

const STATE_PATH = '/w/home/.multi-code/sprintengine/alpha/run.yaml'

type Task = { id: string; role: string; status: string; sourceDocs?: string[] }

function projection(input: { tasks: Task[]; repos?: Array<Record<string, unknown>> }): unknown {
  return {
    // `vcs` rides under `run`, exactly where the engine's projection writer puts it
    // (sprintengine_core/store.py) and where `observeRun` reads it from.
    run: {
      name: 'alpha',
      goal: 'Deliver the epic',
      status: 'active',
      vcs: {
        mode: 'run_worktree',
        // The engine mirrors the primary repo's fields FLAT onto `vcs` as well as
        // into `repos[0]` (repo_model._PRIMARY_MIRRORED_KEYS); the app's normalizer
        // derives entry zero from the flat block, so a fixture without it
        // normalizes to no vcs at all.
        worktreePath: '.multi-code/sprintengine/alpha/worktree',
        branchName: 'sprintengine/alpha',
        baseRef: 'main',
        repos: input.repos ?? [
          {
            id: 'primary',
            root: '.',
            worktreePath: '.multi-code/sprintengine/alpha/worktree',
            branchName: 'sprintengine/alpha',
            baseRef: 'main',
          },
        ],
      },
    },
    tasks: input.tasks.map((task) => ({
      id: task.id,
      title: task.id,
      role: task.role,
      status: task.status,
      dependsOn: [],
      ownedPaths: [],
      acceptanceCriteria: [],
      implementationNotes: [],
      evidence: {},
      ...(task.sourceDocs ? { sourceDocs: task.sourceDocs } : {}),
    })),
  }
}

function ports(options: {
  projectionData?: unknown
  projectionOk?: boolean
  mergeOk?: boolean
  mergeMessage?: string
}): ReturnType<typeof createRoadmapOrchestratorPorts> {
  const frontDoors = {
    readProjection: async () =>
      options.projectionOk === false
        ? { ok: false as const, message: 'run store is gone' }
        : { ok: true as const, data: options.projectionData },
    mergePullRequest: async () =>
      options.mergeOk === false
        ? { ok: false as const, message: options.mergeMessage ?? 'gh: merge conflict' }
        : { ok: true as const },
  } as unknown as SprintEngineAutomationFrontDoors
  return createRoadmapOrchestratorPorts({
    frontDoors,
    delegateToRenderer: async () => ({ ok: true }) as never,
    getHomeProjectRoot: () => '/w/home',
    getWorkspaceRoots: () => ['/w/home'],
    notify: () => undefined,
  })
}

const runRef = { statePath: STATE_PATH, teamSlug: 'alpha' }

test('a member whose every task finished reads delivered', async () => {
  const outcomes = await ports({
    projectionData: projection({
      tasks: [
        { id: 'T1', role: 'developer', status: 'done', sourceDocs: ['backlog/login.md'] },
        { id: 'T2', role: 'developer', status: 'done', sourceDocs: ['backlog/login.md'] },
      ],
    }),
  }).readRunItemOutcomes(runRef)
  assert.equal(outcomes.get('backlog/login.md'), 'delivered')
})

test('one unfinished task withholds the whole member, whatever order it is read in', async () => {
  // `canceled` is terminal in a COMPLETED run — it is how a sprint records work it
  // dropped. A member with one of those must never come back `delivered`, and the
  // downgrade must not depend on which task the loop sees first.
  const doneFirst = await ports({
    projectionData: projection({
      tasks: [
        { id: 'T1', role: 'developer', status: 'done', sourceDocs: ['backlog/logout.md'] },
        { id: 'T2', role: 'developer', status: 'canceled', sourceDocs: ['backlog/logout.md'] },
      ],
    }),
  }).readRunItemOutcomes(runRef)
  assert.equal(doneFirst.get('backlog/logout.md'), 'skipped')

  const canceledFirst = await ports({
    projectionData: projection({
      tasks: [
        { id: 'T1', role: 'developer', status: 'canceled', sourceDocs: ['backlog/logout.md'] },
        { id: 'T2', role: 'developer', status: 'done', sourceDocs: ['backlog/logout.md'] },
      ],
    }),
  }).readRunItemOutcomes(runRef)
  assert.equal(canceledFirst.get('backlog/logout.md'), 'skipped')
})

test('a member no task names is absent, so the caller falls back to "the brief was the whole step"', async () => {
  const outcomes = await ports({
    projectionData: projection({
      tasks: [{ id: 'T1', role: 'developer', status: 'done', sourceDocs: ['backlog/login.md'] }],
    }),
  }).readRunItemOutcomes(runRef)
  assert.equal(outcomes.has('backlog/logout.md'), false)
})

test('source doc paths normalize, so a leading slash or backslashes still match the plan', async () => {
  const outcomes = await ports({
    projectionData: projection({
      tasks: [{ id: 'T1', role: 'developer', status: 'canceled', sourceDocs: ['/backlog\\logout.md'] }],
    }),
  }).readRunItemOutcomes(runRef)
  assert.equal(outcomes.get('backlog/logout.md'), 'skipped')
})

test('an unreadable run yields no outcomes rather than a wrong one', async () => {
  const outcomes = await ports({ projectionOk: false }).readRunItemOutcomes(runRef)
  assert.equal(outcomes.size, 0)
})

test('a merge refusal names the project and the branch it was refused for', async () => {
  const result = await ports({
    mergeOk: false,
    mergeMessage: 'gh: base branch was modified',
    projectionData: projection({ tasks: [] }),
  }).mergePullRequest(STATE_PATH)
  assert.equal(result.ok, false)
  assert.equal(result.message, 'gh: base branch was modified')
  // The workspace folder is the project a person recognizes; the branch is the one
  // the run delivered on.
  assert.equal(result.repo, 'home')
  assert.equal(result.branch, 'sprintengine/alpha')
})

test('a successful merge reports no failure target', async () => {
  const result = await ports({ projectionData: projection({ tasks: [] }) }).mergePullRequest(STATE_PATH)
  assert.deepEqual(result, { ok: true })
})

test('a merge refusal whose run store will not read still carries the engine reason', async () => {
  const result = await ports({ mergeOk: false, projectionOk: false }).mergePullRequest(STATE_PATH)
  assert.equal(result.ok, false)
  assert.equal(result.message, 'gh: merge conflict')
  assert.equal(result.repo, undefined)
})
