import assert from 'node:assert/strict'

import type { ReviewIndexEntry } from '../../../../../../shared/electron-api'
import { orderReviewRail, resolveReviewAutoSelect, reviewRailRow } from './reviewRailModel'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

function entry(overrides: Partial<ReviewIndexEntry>): ReviewIndexEntry {
  return {
    reviewId: 'rv_1',
    workspaceRoot: '/proj/multicode',
    projectName: 'multicode',
    title: 'A change',
    sourceKind: 'pull-request',
    fetchedAt: '2026-07-19T00:00:00Z',
    fileCount: 5,
    hasWalkthrough: true,
    stepCount: 5,
    readFileCount: 3,
    pendingComments: 0,
    postedComments: 0,
    ...overrides,
  }
}

// The three mockup states, by precedence: draft (no walkthrough), posted (all
// comments posted, none pending), and in progress (reading count) otherwise.
run('a review with no walkthrough reads as a draft with the neutral dot', () => {
  const row = reviewRailRow(entry({ hasWalkthrough: false, stepCount: 0, readFileCount: 0 }))
  assert.equal(row.status, 'draft')
  assert.equal(row.tone, 'neutral')
  assert.equal(row.stateLine, 'multicode · draft')
})

run('a review with posted comments and none pending reads as posted with the good dot', () => {
  const row = reviewRailRow(entry({ postedComments: 3, pendingComments: 0 }))
  assert.equal(row.status, 'posted')
  assert.equal(row.tone, 'good')
  assert.equal(row.stateLine, 'multicode · posted')
})

run('an in-progress review shows reading progress with the accent dot', () => {
  const row = reviewRailRow(entry({ fileCount: 5, readFileCount: 3, pendingComments: 0, postedComments: 0 }))
  assert.equal(row.status, 'in-progress')
  assert.equal(row.tone, 'accent')
  assert.equal(row.stateLine, 'multicode · 3 of 5 files read')
})

run('a partly-posted review with comments still pending is not "posted"', () => {
  // Posted requires zero pending; a mixed batch is still in progress.
  const row = reviewRailRow(entry({ postedComments: 2, pendingComments: 1 }))
  assert.equal(row.status, 'in-progress')
})

run('reading count is clamped to the changed-file universe', () => {
  // A stale path in the reviewer's read list cannot push the count past total.
  const row = reviewRailRow(entry({ fileCount: 4, readFileCount: 9 }))
  assert.equal(row.stateLine, 'multicode · all files read')
})

run('a review with no changed files does not divide-by-zero the reading line', () => {
  const row = reviewRailRow(entry({ fileCount: 0, readFileCount: 0 }))
  assert.equal(row.stateLine, 'multicode · no files')
})

// Rail order: in-progress first (attention), then drafts, then posted (done).
// Within a bucket the input order is preserved.
run('the rail orders in-progress, then drafts, then posted, stable within a bucket', () => {
  const rows = orderReviewRail([
    entry({ reviewId: 'posted', postedComments: 1, pendingComments: 0 }),
    entry({ reviewId: 'draft-a', hasWalkthrough: false }),
    entry({ reviewId: 'progress', readFileCount: 1 }),
    entry({ reviewId: 'draft-b', hasWalkthrough: false }),
  ])
  assert.deepEqual(
    rows.map((row) => row.reviewId),
    ['progress', 'draft-a', 'draft-b', 'posted'],
  )
})

// Reopening the door (MC-1785): the remembered review wins over the
// attention-first first row while the index still has it; a remembered review
// the index lost is a dead preference to clear, not a selection to honor.
const REOPEN_INDEX = [
  entry({ reviewId: 'rv_a', readFileCount: 1 }),
  entry({ reviewId: 'rv_b', hasWalkthrough: false }),
]
const REOPEN_ROWS = orderReviewRail(REOPEN_INDEX)

run('reopening restores the remembered review even when it is not the first row', () => {
  // rv_b is a draft, so the attention-first rail puts rv_a first — the remembered
  // pick must still win, which is the whole bug (the door snapped back to rv_a).
  assert.equal(REOPEN_ROWS[0].reviewId, 'rv_a', 'the rail really does order rv_a first')
  const decision = resolveReviewAutoSelect(REOPEN_INDEX, REOPEN_ROWS, {
    reviewId: 'rv_b',
    workspaceRoot: '/proj/multicode',
  })
  assert.deepEqual(decision.select, { reviewId: 'rv_b', workspaceRoot: '/proj/multicode' })
  assert.equal(decision.clearRemembered, false, 'a live preference is kept')
})

run('a remembered review the index lost falls back to attention-first and is cleared', () => {
  const decision = resolveReviewAutoSelect(REOPEN_INDEX, REOPEN_ROWS, {
    reviewId: 'rv_deleted',
    workspaceRoot: '/proj/multicode',
  })
  assert.deepEqual(decision.select, { reviewId: 'rv_a', workspaceRoot: '/proj/multicode' })
  assert.equal(decision.clearRemembered, true, 'the dead preference is dropped')
})

run('no remembered review opens the first row and clears nothing', () => {
  const decision = resolveReviewAutoSelect(REOPEN_INDEX, REOPEN_ROWS, null)
  assert.deepEqual(decision.select, { reviewId: 'rv_a', workspaceRoot: '/proj/multicode' })
  assert.equal(decision.clearRemembered, false, 'there was no preference to clear')
})

run('a remembered pair pointing at another project is not matched by id alone', () => {
  // The stored identity is the whole pair, so a remembered review whose root no
  // longer holds it does not resolve against a same-id dir in another checkout.
  const decision = resolveReviewAutoSelect(REOPEN_INDEX, REOPEN_ROWS, {
    reviewId: 'rv_b',
    workspaceRoot: '/proj/other',
  })
  assert.deepEqual(decision.select, { reviewId: 'rv_a', workspaceRoot: '/proj/multicode' })
  assert.equal(decision.clearRemembered, true)
})

run('an empty index selects nothing and still clears a dead preference', () => {
  const decision = resolveReviewAutoSelect([], [], { reviewId: 'rv_gone', workspaceRoot: '/proj/multicode' })
  assert.equal(decision.select, null, 'nothing to open, so the empty state stands')
  assert.equal(decision.clearRemembered, true)
})

console.log('reviewRailModel tests passed')
