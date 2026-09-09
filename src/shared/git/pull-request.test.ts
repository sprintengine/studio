import assert from 'node:assert/strict'

import {
  canonicalPullRequestUrlOf,
  earlierPullRequests,
  groupPullRequests,
  primaryPullRequest,
  pullRequestStateLabel,
  pullRequestRepository,
  pullRequestTone,
  PULL_REQUEST_TONE_VAR,
  unionPullRequests,
  type BranchPullRequest,
} from './pull-request'

// The rules a conversation's mark is drawn from (epic `pull-request-marks`,
// decisions 1, 2, 5 and 6). Pure functions over a list — no gh, no clock.

function pr(overrides: Partial<BranchPullRequest> & { number: number }): BranchPullRequest {
  return {
    url: `https://github.com/acme/app/pull/${overrides.number}`,
    repoKey: 'github.com/acme/app',
    repoName: 'app',
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
  assert.equal(pullRequestStateLabel({ state: 'open', isDraft: true }), 'open, a draft')
  assert.equal(pullRequestStateLabel({ state: 'merged', isDraft: false }), 'merged')
  assert.equal(pullRequestStateLabel({ state: 'closed', isDraft: false }), 'closed without merging')
  assert.equal(
    pullRequestStateLabel({ state: 'merged', isDraft: true }),
    'merged',
    'a stale draft flag never invents a state',
  )
}

// ---------------------------------------------------------------------------
// Decision 10: a pull request belongs to the repository its URL names — which
// is not always the one the conversation sits in — and that key is the one
// every clone of that repository shares.
// ---------------------------------------------------------------------------
{
  assert.deepEqual(pullRequestRepository('https://github.com/acme/app/pull/12'), {
    repoKey: 'github.com/acme/app',
    repoName: 'app',
  })
  assert.deepEqual(
    pullRequestRepository('https://github.com/Acme/App/pull/12/files?w=1'),
    { repoKey: 'github.com/acme/app', repoName: 'app' },
    'case and the URL\'s trailing cruft do not make a second repository',
  )
  assert.deepEqual(pullRequestRepository('https://ghe.corp.example.com/acme/app/pull/3'), {
    repoKey: 'ghe.corp.example.com/acme/app',
    repoName: 'app',
  })
  assert.equal(pullRequestRepository('https://bitbucket.org/acme/app/pull-requests/3'), null)
  assert.equal(pullRequestRepository('not a url'), null)

  assert.equal(
    canonicalPullRequestUrlOf('https://github.com/acme/app/pull/12/files?w=1'),
    'https://github.com/acme/app/pull/12',
  )
  assert.equal(canonicalPullRequestUrlOf('nonsense'), null)
}

// ---------------------------------------------------------------------------
// The snapshot's union (decision 10): what a conversation's branch has, plus
// what the conversation opened anywhere else, as one list.
// ---------------------------------------------------------------------------
{
  const onBranch = [pr({ number: 5 }), pr({ number: 3, state: 'merged' })]
  const captured = [
    { ...pr({ number: 9 }), url: 'https://github.com/acme/website/pull/9', repoKey: 'github.com/acme/website', repoName: 'website', openedBySessionId: 'session-a' },
  ]
  const union = unionPullRequests(onBranch, captured)
  assert.deepEqual(union.map((entry) => entry.number), [9, 5, 3], 'both sources, newest first')
  assert.deepEqual(
    [...new Set(union.map((entry) => entry.repoName))].sort(),
    ['app', 'website'],
    'a pull request opened in another repository is on the list, and says which',
  )

  // The same pull request reached both ways is one row, and the row that knows
  // more wins: the newer reading, and the session that opened it.
  const stale = { ...pr({ number: 7 }), stateAt: 100, openedBySessionId: 'session-a' }
  const fresh = { ...pr({ number: 7 }), stateAt: 200, state: 'merged' as const }
  const deduped = unionPullRequests([fresh], [stale])
  assert.equal(deduped.length, 1, 'one URL is one row')
  assert.equal(deduped[0].state, 'merged', 'the newer reading wins')
  assert.equal(deduped[0].openedBySessionId, 'session-a', 'and the session that opened it survives the merge')
  assert.deepEqual(unionPullRequests([], []), [])
}

console.log('shared/git/pull-request: all assertions passed')
