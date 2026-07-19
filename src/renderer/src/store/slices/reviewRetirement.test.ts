import assert from 'node:assert/strict'

import { collectReviewStateMigrations } from './workspacesSlice'
import { validateReviewWorkspaceState, type ReviewWorkspaceState } from '../../../../shared/review'
import type { Workspace } from '../../types/workspace'

// The `review` workspace type retired (MC-1708): reviews are instance-level disk
// objects. collectReviewStateMigrations is the pure half of the one-time
// migration — from the persisted workspaces it plans exactly which reviewer states
// must be lifted to `<reviewDir>/state.json` before the dead review-mode rows are
// dropped. These tests prove an in-flight review survives verbatim and that only
// the rows with something to preserve produce a lift.

// A minimal Workspace stub carrying just the fields the migration reads.
function reviewWorkspace(id: string, folderPath: string | null, reviewState: ReviewWorkspaceState | null): Workspace {
  return { id, name: id, mode: 'review', folderPath, reviewState } as unknown as Workspace
}

function standardWorkspace(id: string): Workspace {
  return { id, name: id, mode: 'standard', folderPath: '/repo', reviewState: null } as unknown as Workspace
}

// An in-flight review: read progress, an active step, a non-default view, and
// comments spanning every state that must survive — pending, posted (read-only),
// failed (retryable), and a 'moved' held comment.
function inFlightState(): ReviewWorkspaceState {
  return {
    schemaVersion: 1,
    changeSetId: 'cs_live',
    readFiles: ['src/a.ts', 'src/b.ts'],
    activeStepId: 'step-2',
    diffView: 'inline',
    comments: [
      { id: 'c1', path: 'src/a.ts', anchor: { side: 'new', startLine: 5, endLine: 6 }, body: 'unposted', createdAt: 't1', sync: { state: 'pending' } },
      { id: 'c2', path: 'src/b.ts', anchor: { side: 'new', startLine: 1, endLine: 1 }, body: 'posted', createdAt: 't2', sync: { state: 'posted', url: 'https://x/1', postedAt: 't3' } },
      { id: 'c3', path: 'src/a.ts', anchor: { side: 'old', startLine: 9, endLine: 9 }, body: 'failed', createdAt: 't4', sync: { state: 'failed', error: 'net' } },
      { id: 'c4', path: 'src/a.ts', anchor: { side: 'new', startLine: 40, endLine: 40 }, body: 'moved', createdAt: 't5', sync: { state: 'pending' }, anchorStatus: 'moved' },
    ],
  }
}

const tests: Array<{ name: string; body: () => void }> = []
function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

run('an in-flight review is lifted verbatim (comments, read progress, view, posted stays read-only)', () => {
  const state = inFlightState()
  const migrations = collectReviewStateMigrations([reviewWorkspace('rv_1', '/home/proj', state)])
  assert.equal(migrations.length, 1)
  assert.equal(migrations[0].reviewId, 'rv_1', 'the review id is the workspace id — it keys the on-disk dir')
  assert.equal(migrations[0].workspaceRoot, '/home/proj')
  assert.deepEqual(migrations[0].state, state, 'the reviewer state is carried verbatim')
  // The lifted state is exactly what writeReviewState will persist — it validates.
  const validation = validateReviewWorkspaceState(migrations[0].state)
  assert.ok(validation.ok, validation.ok ? '' : validation.errors.join('\n'))
  const posted = migrations[0].state.comments.find((c) => c.id === 'c2')
  assert.equal(posted?.sync.state, 'posted', 'a posted comment stays posted (read-only) through the lift')
})

run('a review row with no reviewer state or no folder yields no lift (safe to drop directly)', () => {
  const migrations = collectReviewStateMigrations([
    reviewWorkspace('rv_empty', '/home/proj', null),
    reviewWorkspace('rv_nofolder', null, inFlightState()),
  ])
  assert.deepEqual(migrations, [], 'nothing to preserve → no lift; the drop can remove these rows directly')
})

run('only review-mode rows are considered', () => {
  const migrations = collectReviewStateMigrations([
    standardWorkspace('std'),
    reviewWorkspace('rv_1', '/home/proj', inFlightState()),
  ])
  assert.deepEqual(migrations.map((m) => m.reviewId), ['rv_1'], 'a non-review workspace is never touched by the retirement')
})

run('multiple reviews across projects each produce their own lift', () => {
  const migrations = collectReviewStateMigrations([
    reviewWorkspace('rv_a', '/proj/a', inFlightState()),
    reviewWorkspace('rv_b', '/proj/b', inFlightState()),
  ])
  assert.deepEqual(
    migrations.map((m) => ({ reviewId: m.reviewId, workspaceRoot: m.workspaceRoot })),
    [
      { reviewId: 'rv_a', workspaceRoot: '/proj/a' },
      { reviewId: 'rv_b', workspaceRoot: '/proj/b' },
    ],
  )
})

let failed = false
for (const test of tests) {
  try {
    test.body()
    console.log(`ok - ${test.name}`)
  } catch (error) {
    failed = true
    console.error(`not ok - ${test.name}`)
    console.error(error)
  }
}
if (failed) process.exit(1)
console.log('reviewRetirement.test.ts: ok')
