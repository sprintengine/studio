import assert from 'node:assert/strict'

import {
  earlierPullRequests,
  groupPullRequests,
  primaryPullRequest,
  pullRequestStateLabel,
  pullRequestTone,
  PULL_REQUEST_TONE_VAR,
  type BranchPullRequest,
} from './pull-request'

// The rules a conversation's mark is drawn from (epic `pull-request-marks`,
// decisions 1, 2, 5 and 6). Pure functions over a list — no gh, no clock.

function pr(overrides: Partial<BranchPullRequest> & { number: number }): BranchPullRequest {
  return {
    url: `https://github.com/acme/app/pull/${overrides.number}`,
    title: `#${overrides.number}`,
    state: 'open',
    isDraft: false,
    openedAt: Date.parse('2026-09-01T00:00:00.000Z') + overrides.number * 60_000,
    stateAt: Date.parse('2026-09-09T00:00:00.000Z'),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Decision 5: one mark per conversation — the most recent pull request that is
// still open, or the newest of all once every one has landed or closed.
// ---------------------------------------------------------------------------
{
  assert.equal(primaryPullRequest([]), null, 'no pull requests, nothing drawn')

  const one = pr({ number: 7 })
  assert.equal(primaryPullRequest([one]), one)

  // The newest is merged; an older one is still open. The open one wears the mark.
  const merged = pr({ number: 9, state: 'merged' })
  const open = pr({ number: 8 })
  assert.equal(primaryPullRequest([merged, open]), open, 'an open one outranks a newer merged one')
  assert.equal(primaryPullRequest([open, merged]), open, 'and the input order does not matter')

  // Two open: the most recent wins.
  const olderOpen = pr({ number: 3 })
  const newerOpen = pr({ number: 12 })
  assert.equal(primaryPullRequest([olderOpen, newerOpen]), newerOpen)

  // Everything has landed or closed: the newest of all, whatever its state.
  const closedNewest = pr({ number: 20, state: 'closed' })
  assert.equal(
    primaryPullRequest([pr({ number: 4, state: 'merged' }), closedNewest]),
    closedNewest,
    'once nothing is open the newest of all wears the mark',
  )

  // Same instant: the higher number is the more recent pull request.
  const at = Date.parse('2026-09-05T00:00:00.000Z')
  const low = pr({ number: 30, openedAt: at })
  const high = pr({ number: 31, openedAt: at })
  assert.equal(primaryPullRequest([low, high]), high)
}

// ---------------------------------------------------------------------------
// Decision 6: the menu's groups — open, merged, closed, newest first in each,
// and no pull request is ever dropped from the record.
// ---------------------------------------------------------------------------
{
  const list = [
    pr({ number: 1, state: 'merged' }),
    pr({ number: 5 }),
    pr({ number: 3, state: 'closed' }),
    pr({ number: 9 }),
    pr({ number: 7, state: 'merged' }),
  ]
  const groups = groupPullRequests(list)
  assert.deepEqual(groups.open.map((entry) => entry.number), [9, 5])
  assert.deepEqual(groups.merged.map((entry) => entry.number), [7, 1])
  assert.deepEqual(groups.closed.map((entry) => entry.number), [3])
  assert.equal(
    groups.open.length + groups.merged.length + groups.closed.length,
    list.length,
    'every pull request lands in exactly one group',
  )
  assert.deepEqual(groupPullRequests([]), { open: [], merged: [], closed: [] })

  // The tooltip's "Earlier:" lines: everything but the one on the mark.
  assert.deepEqual(earlierPullRequests(list).map((entry) => entry.number), [7, 5, 3, 1])
  assert.deepEqual(earlierPullRequests([]), [])
  assert.deepEqual(earlierPullRequests([pr({ number: 2 })]), [], 'the only one is the primary, so nothing is earlier')
}

// ---------------------------------------------------------------------------
// Decisions 1 and 2: three states, three tones, and a draft that is an open
// pull request wearing a different word — never a fourth state.
// ---------------------------------------------------------------------------
{
  assert.equal(pullRequestTone('open'), 'accent')
  assert.equal(pullRequestTone('merged'), 'merged')
  assert.equal(pullRequestTone('closed'), 'error')
  assert.deepEqual(Object.keys(PULL_REQUEST_TONE_VAR).sort(), ['accent', 'error', 'merged'])

  assert.equal(pullRequestStateLabel({ state: 'open', isDraft: false }), 'open')
  assert.equal(pullRequestStateLabel({ state: 'open', isDraft: true }), 'open, draft')
  assert.equal(pullRequestStateLabel({ state: 'merged', isDraft: false }), 'merged')
  assert.equal(pullRequestStateLabel({ state: 'closed', isDraft: false }), 'closed')
  assert.equal(
    pullRequestStateLabel({ state: 'merged', isDraft: true }),
    'merged',
    'a stale draft flag never invents a state',
  )
}

console.log('shared/git/pull-request: all assertions passed')
