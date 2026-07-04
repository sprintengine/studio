import assert from 'node:assert/strict'
import { prMergePollMode } from './runPullRequest'

const base = {
  statePath: '/run/state.yaml',
  hasVcs: true,
  prState: 'open' as const,
  shouldPoll: true,
  dormant: false,
}

// Live open run with a PR to watch → keep polling at 30s (unchanged behaviour).
assert.equal(prMergePollMode(base), 'poll')

// Dormant run (T1's terminal lifecycle bit): open PR is pending metadata, not a
// live merge target → refresh once on open, then stop. No interval.
assert.equal(prMergePollMode({ ...base, dormant: true }), 'once')

// A dormant run with no PR reason still never holds an interval.
assert.equal(prMergePollMode({ ...base, dormant: true, shouldPoll: false }), 'off')

// Terminal PR states stop the poll permanently, dormant or not.
for (const dormant of [false, true]) {
  assert.equal(prMergePollMode({ ...base, prState: 'merged', dormant }), 'off')
  assert.equal(prMergePollMode({ ...base, prState: 'closed', dormant }), 'off')
}

// Nothing to poll without a state path, without vcs, or with no poll reason.
assert.equal(prMergePollMode({ ...base, statePath: null }), 'off')
assert.equal(prMergePollMode({ ...base, hasVcs: false }), 'off')
assert.equal(prMergePollMode({ ...base, shouldPoll: false }), 'off')

// A null PR state on a live run (PR just created, state not yet known) polls.
assert.equal(prMergePollMode({ ...base, prState: null }), 'poll')

console.log('runPullRequest prMergePollMode: all assertions passed')
