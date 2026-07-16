import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import { RunPullRequestViewChip, shouldProbePullRequestOnOpen } from './runPullRequest'

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

// ── Per-project chips (MC-1613) ──────────────────────────────────────────────
// A run spanning projects shows one chip per project; a run in one project shows
// exactly the single chip it always did.
const repo = (over: Record<string, unknown>) => ({
  id: 'x',
  root: '.',
  worktreePath: '.x/worktree',
  branchName: 'sprintengine/x',
  pullRequestUrl: null,
  pullRequestError: null,
  pullRequestState: null,
  ...over,
})
const vcsWith = (repos: unknown[], flat: Record<string, unknown> = {}) =>
  ({ mode: 'run_worktree', worktreePath: '.x/worktree', branchName: 'sprintengine/x', repos, ...flat }) as never

const single = renderToStaticMarkup(
  <RunPullRequestViewChip
    vcs={vcsWith([repo({ id: 'primary', pullRequestUrl: 'https://x/pull/1', pullRequestState: 'open' })], {
      pullRequestUrl: 'https://x/pull/1',
      pullRequestState: 'open',
    })}
    folderPath="/work/multicode"
  />,
)
assert.ok(single.includes('View pull request'), 'a single-project run keeps its one unchanged chip')
assert.ok(!single.includes('multicode'), 'a single-project chip is not renamed to the project')
assert.ok(single.includes('--accent-primary'), 'a single-project chip keeps the flat link accent')

const many = renderToStaticMarkup(
  <RunPullRequestViewChip
    vcs={vcsWith([
      repo({ id: 'primary', root: '.', pullRequestUrl: 'https://x/pull/1', pullRequestState: 'merged' }),
      repo({ id: 'mobile', root: '../multicode-mobile', pullRequestUrl: 'https://y/pull/2', pullRequestState: 'open' }),
      repo({ id: 'auth', root: '../multiauth', pullRequestError: 'push rejected' }),
    ])}
    folderPath="/work/multicode"
  />,
)
// Named by project, never by the id the run declared it under.
for (const name of ['multicode', 'multicode-mobile', 'multiauth']) {
  assert.ok(many.includes(name), `the ${name} project has a chip`)
}
assert.ok(!many.includes('>mobile<'), 'a chip never shows the declared repo id')
assert.ok(many.includes('View pull request') === false, 'per-project chips replace the generic label')
// Independent states: merged purple and open accent coexist in one row.
assert.ok(many.includes('--tone-merged'), "the merged project's chip carries the merged tone")
assert.ok(many.includes('--accent-primary'), "the open project's chip stays the link accent")
// A project whose PR failed is still listed, with the reason — never dropped.
assert.ok(many.includes('push rejected'), 'a failed project shows why it has no pull request')
assert.ok(!many.includes('repoId') && !many.includes('vcs'), 'no jargon reaches the chips')

console.log('runPullRequest per-project chips: all assertions passed')
