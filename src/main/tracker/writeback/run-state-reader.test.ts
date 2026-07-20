import assert from 'node:assert/strict'

import type { SprintEngineProjectionReadResult } from '../../../shared/electron-api'
import { createRunStateReader } from './run-state-reader'

// Verifies the honesty adapter (MC-1640 / T10): completion is judged from a
// freshly-read run projection via the canonical predicate (never a stale
// projection), a canceled run is not completed, "started" tracks a planned run,
// PR urls are collected from the run's vcs record, the run id is stable, and an
// unreadable run yields no facts (⇒ no posts).

const STATE_PATH = '/ws/.multi-code/sprintengine/team/run.yaml'

async function main(): Promise<void> {
  await testCompletedOnlyWhenEveryTaskDone()
  await testCanceledRunIsNotCompleted()
  await testStartedTracksPlannedRun()
  await testCollectsPullRequestUrls()
  await testUnreadableRunYieldsNull()
  await testStableRunId()

  console.log('tracker-writeback-run-state-reader tests passed')
}

async function testCompletedOnlyWhenEveryTaskDone(): Promise<void> {
  const allDone = await read(projection({ tasks: [{ status: 'done' }, { status: 'done' }] }))
  assert.equal(allDone?.completed, true)

  const oneOpen = await read(projection({ tasks: [{ status: 'done' }, { status: 'in_progress' }] }))
  assert.equal(oneOpen?.completed, false, 'a single non-done task means not completed — the honesty gate')
}

async function testCanceledRunIsNotCompleted(): Promise<void> {
  // Every task done, but the run is canceled ⇒ decided, not completed.
  const facts = await read(projection({ status: 'canceled', tasks: [{ status: 'done' }] }))
  assert.equal(facts?.canceled, true)
  assert.equal(facts?.completed, false)
}

async function testStartedTracksPlannedRun(): Promise<void> {
  const planned = await read(projection({ tasks: [{ status: 'in_progress' }] }))
  assert.equal(planned?.started, true)

  const empty = await read(projection({ tasks: [] }))
  assert.equal(empty?.started, false, 'a run with no tasks has not started work yet')
}

async function testCollectsPullRequestUrls(): Promise<void> {
  const facts = await read(
    projection({
      tasks: [{ status: 'done' }],
      vcs: { mode: 'run_worktree', worktreePath: 'wt', branchName: 'b', pullRequestUrl: 'https://h/pull/42' },
    }),
  )
  assert.deepEqual(facts?.pullRequestUrls, ['https://h/pull/42'])
}

async function testUnreadableRunYieldsNull(): Promise<void> {
  const reader = createRunStateReader({ readProjection: async () => ({ ok: false, message: 'gone' }) })
  assert.equal(await reader.readRunFacts({ statePath: STATE_PATH }), null)

  // A read that throws is also contained as "no facts", never a rejection.
  const throwing = createRunStateReader({
    readProjection: async () => {
      throw new Error('disk error')
    },
  })
  assert.equal(await throwing.readRunFacts({ statePath: STATE_PATH }), null)
}

async function testStableRunId(): Promise<void> {
  const facts = await read(projection({ tasks: [{ status: 'done' }] }))
  assert.match(facts?.runId ?? '', /^team:[0-9a-f]{16}$/, 'run id = <team>:<16-hex fingerprint>')
}

function projection(input: { status?: string; tasks: Array<{ status: string }>; vcs?: unknown }): unknown {
  return {
    run: {
      name: 'External trackers',
      goal: 'Ship write-back',
      ...(input.status ? { status: input.status } : {}),
      creation: { createdAt: '2026-07-19T10:00:00.000Z' },
      ...(input.vcs ? { vcs: input.vcs } : {}),
    },
    tasks: input.tasks.map((task, index) => ({
      id: `T${index}`,
      title: `Task ${index}`,
      role: 'developer',
      status: task.status,
    })),
    artifacts: [],
    activity: [],
  }
}

async function read(data: unknown) {
  const reader = createRunStateReader({ readProjection: async () => okRead(data) })
  return reader.readRunFacts({ statePath: STATE_PATH })
}

function okRead(data: unknown): SprintEngineProjectionReadResult {
  return { ok: true, data }
}

void main()
