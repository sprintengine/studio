import assert from 'node:assert/strict'
import { shouldProbePullRequestOnOpen } from './runPullRequest'

const base = {
  statePath: '/run/state.yaml',
  hasVcs: true,
  prState: 'open' as const,
  shouldPoll: true,
}

// An open run with a PR to watch → probe once on open (the snappy on-surface
// refresh). Periodic polling now belongs to the window-level supervisor.
assert.equal(shouldProbePullRequestOnOpen(base), true)

// A PR whose state is not yet known (just created) still probes on open.
assert.equal(shouldProbePullRequestOnOpen({ ...base, prState: null }), true)

// Terminal PR states never probe — the glyph is already correct.
assert.equal(shouldProbePullRequestOnOpen({ ...base, prState: 'merged' }), false)
assert.equal(shouldProbePullRequestOnOpen({ ...base, prState: 'closed' }), false)

// Nothing to probe without a state path, without vcs, or with no poll reason.
assert.equal(shouldProbePullRequestOnOpen({ ...base, statePath: null }), false)
assert.equal(shouldProbePullRequestOnOpen({ ...base, hasVcs: false }), false)
assert.equal(shouldProbePullRequestOnOpen({ ...base, shouldPoll: false }), false)

console.log('runPullRequest shouldProbePullRequestOnOpen: all assertions passed')
