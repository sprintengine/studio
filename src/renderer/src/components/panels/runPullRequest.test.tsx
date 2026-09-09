import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import { RunPullRequestViewChip, runPullRequestChipInk, shouldProbePullRequestOnOpen } from './runPullRequest'
import { PULL_REQUEST_TONE_VAR, pullRequestTone } from '../../../../shared/git/pull-request'

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
// A single-project chip is inked by its state like every other one. It used to
// stay a flat link accent whatever the state; once it draws its state's shape,
// the accent — which is the OPEN tone — would have argued with a merged mark.
assert.ok(single.includes('--accent-primary'), 'an OPEN single-project chip is the accent')
const singleMerged = renderToStaticMarkup(
  <RunPullRequestViewChip
    vcs={vcsWith([repo({ id: 'primary', pullRequestUrl: 'https://x/pull/1', pullRequestState: 'merged' })], {
      pullRequestUrl: 'https://x/pull/1',
      pullRequestState: 'merged',
    })}
    folderPath="/work/multicode"
  />,
)
assert.ok(singleMerged.includes('View pull request'), 'still the one chip, with the same words')
assert.ok(singleMerged.includes('var(--tone-merged)'), 'a merged single-project chip is inked merged')
assert.ok(!singleMerged.includes('var(--accent-primary)'), 'the colour never argues with the shape')

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

// ── The chips wear the pull request marks (epic pull-request-marks, dec. 12) ──
// Until 2026-09-09 these chips were words in a colour, so a merged project and
// an open one differed only by ink. They now lead with the state's own mark, and
// the ink comes from the ONE shared tone map rather than a private one — which
// is also how closed stopped being dimmed to `--text-muted`, a tone that read as
// "nothing happened" for the state that means the work was thrown away.

// The ink function IS the shared map, for every state and for the not-yet-read
// case. `null` is a pull request that exists and has not been read back, which
// is open (decision 3) — never a fourth state with a tone of its own.
for (const state of ['open', 'merged', 'closed'] as const) {
  assert.equal(runPullRequestChipInk(state), PULL_REQUEST_TONE_VAR[pullRequestTone(state)])
}
assert.equal(runPullRequestChipInk(null), runPullRequestChipInk('open'), 'unread means open, not unknown')
assert.equal(runPullRequestChipInk('closed'), 'var(--tone-error)', 'closed is the danger red, not a muted grey')
assert.equal(runPullRequestChipInk('merged'), 'var(--tone-merged)')
assert.equal(runPullRequestChipInk('open'), 'var(--accent-primary)')
assert.equal(
  new Set((['open', 'merged', 'closed'] as const).map(runPullRequestChipInk)).size,
  3,
  'three states, three inks',
)

// The rendered chips: each one draws its own state's mark. The three marks are
// told apart here by a node placement unique to each — merged is the only one
// whose third node sits at cy 8.5, and closed is the only one wearing the cross
// — so this fails if a chip renders the wrong drawing, not merely if it renders
// none.
const withState = (state: 'open' | 'merged' | 'closed') =>
  renderToStaticMarkup(
    <RunPullRequestViewChip
      vcs={vcsWith([
        repo({ id: 'primary', root: '.', pullRequestUrl: 'https://x/pull/1', pullRequestState: state }),
        repo({ id: 'mobile', root: '../multicode-mobile', pullRequestUrl: 'https://y/pull/2', pullRequestState: 'open' }),
      ])}
      folderPath="/work/multicode"
    />,
  )

const mergedChips = withState('merged')
assert.ok(mergedChips.includes('cy="8.5"'), 'the merged project draws the MERGED mark')
assert.ok(mergedChips.includes('var(--tone-merged)'), 'and inks it with the merged tone')

const closedChips = withState('closed')
assert.ok(closedChips.includes('M13.4 3.2 9.6 7'), 'the closed project draws the CLOSED mark, cross and all')
assert.ok(closedChips.includes('var(--tone-error)'), 'and inks it with the danger red')
assert.ok(!closedChips.includes('var(--text-muted)'), 'closed is never dimmed to muted any more')

const openChips = withState('open')
assert.ok(!openChips.includes('cy="8.5"') && !openChips.includes('M13.4 3.2 9.6 7'), 'an open project draws neither')
assert.ok(openChips.includes('M11.5 10.9V6.2'), 'it draws the OPEN mark: the arrow that has not gone in')

// The single-project chip is a link with one label, so its mark is decorative
// and the words carry the meaning.
assert.ok(single.includes('aria-hidden="true"'), 'the chip mark speaks through the label beside it')
assert.ok(single.includes('M11.5 10.9V6.2'), 'a single-project run wears the open mark too')

// A project with no pull request draws NO mark: nothing is drawn unless a pull
// request definitely exists (decision 3), and a "pending" chip is exactly that
// case.
const pendingOnly = renderToStaticMarkup(
  <RunPullRequestViewChip
    vcs={vcsWith([
      repo({ id: 'primary', root: '.', pullRequestUrl: 'https://x/pull/1', pullRequestState: 'open' }),
      repo({ id: 'auth', root: '../multiauth', pullRequestError: 'push rejected' }),
    ])}
    folderPath="/work/multicode"
  />,
)
assert.equal(
  (pendingOnly.match(/<svg/g) ?? []).length,
  1,
  'only the project that HAS a pull request wears a mark',
)

console.log('runPullRequest chips wear the pull request marks: all assertions passed')
