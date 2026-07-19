import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ReviewIndexEntry } from '../../../../../../shared/electron-api'
import type { ReviewComment } from '../../../../../../shared/review'
import { reviewFixture } from '../../../panels/review/fixtures'
import { orderedSteps } from '../../../panels/review/reviewSelectors'
import type { ReviewSession } from '../../../panels/review/useReviewSession'
import { ReviewCanvas } from '../../../panels/review/ReviewCanvas'
import { buildReviewsSurfaceBar } from './ReviewSurfaceBar'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const NOOP = (): void => {}

function stubSession(overrides: Partial<ReviewSession>): ReviewSession {
  return {
    reviewId: 'rv_1',
    workspaceRoot: '/proj/multicode',
    status: 'ready',
    changeset: reviewFixture.changeset,
    brief: reviewFixture.brief,
    errorMessage: null,
    invalidErrors: null,
    run: { running: false, phase: null, error: null },
    readFiles: new Set(reviewFixture.state.readFiles),
    diffView: 'side-by-side',
    activePaneId: orderedSteps(reviewFixture.brief)[0]?.id ?? 'overview',
    monacoTheme: 'vs-dark',
    comments: [],
    bannerModel: null,
    postState: { phase: 'idle' },
    isPullRequest: reviewFixture.changeset.source.kind === 'pull-request',
    pendingComments: 0,
    canPost: false,
    onSetActivePane: NOOP,
    onSetDiffView: NOOP,
    onToggleRead: NOOP,
    onCreateComment: NOOP,
    onEditComment: NOOP,
    onDeleteComment: NOOP,
    onPostReview: NOOP,
    startRun: NOOP,
    refresh: NOOP,
    trayController: { open: false, setOpen: NOOP },
    chatController: { open: false, setOpen: NOOP, prefill: undefined, askFromCard: NOOP },
    openTray: NOOP,
    openChat: NOOP,
    ...overrides,
  }
}

const entry: ReviewIndexEntry = {
  reviewId: 'rv_1',
  workspaceRoot: '/proj/multicode',
  projectName: 'multicode',
  title: reviewFixture.changeset.title,
  sourceKind: reviewFixture.changeset.source.kind,
  fetchedAt: '2026-07-19T00:00:00Z',
  fileCount: reviewFixture.changeset.stats.files,
  hasWalkthrough: true,
  stepCount: reviewFixture.brief.steps.length,
  readFileCount: 1,
  pendingComments: 0,
  postedComments: 0,
}

const postedComment = { sync: { state: 'posted' } } as unknown as ReviewComment
const pendingComment = { sync: { state: 'pending' } } as unknown as ReviewComment

// The folded surface bar carries the walkthrough's actions once, so its action
// cluster appears only when the walkthrough is ready.
run('the surface bar shows no walkthrough actions until the review is ready', () => {
  const bar = buildReviewsSurfaceBar(entry, stubSession({ status: 'prepare' }))
  assert.equal(bar.actions, undefined, 'no view/re-run/post controls before a walkthrough exists')
  assert.equal(bar.title, reviewFixture.changeset.title)
})

run('a ready pull-request review with pending comments shows the Post review CTA', () => {
  const bar = buildReviewsSurfaceBar(entry, stubSession({ isPullRequest: true, pendingComments: 3, comments: [pendingComment, pendingComment, pendingComment] }))
  const html = renderToStaticMarkup(<>{bar.statusChip}{bar.actions}</>)
  assert.match(html, /Post review/, 'the primary CTA is Post review')
  assert.match(html, /3 comments/, 'the CTA carries the pending count')
  assert.match(html, /Ask the guide/, 'Ask the guide is folded into the bar')
  assert.match(html, /Side by side/, 'the diff-view toggle is folded into the bar')
  assert.match(html, /In progress/, 'an unposted review reads as In progress')
})

run('a review with all comments posted reads as Posted, no Post CTA', () => {
  const bar = buildReviewsSurfaceBar(entry, stubSession({ isPullRequest: true, pendingComments: 0, comments: [postedComment] }))
  const html = renderToStaticMarkup(<>{bar.statusChip}{bar.actions}</>)
  assert.match(html, /Posted/, 'the chip reads Posted once the batch resolves')
  assert.doesNotMatch(html, /Post review ·/, 'no Post CTA when nothing is pending')
  assert.match(html, /Your review/, 'the review is still reachable via Your review')
})

// The canvas mounts the walkthrough chromeless — its own top bar is suppressed so
// the folded surface bar is the only bar (one bar, not two stacked).
run('the ready canvas mounts the walkthrough without its own top bar', () => {
  const html = renderToStaticMarkup(<ReviewCanvas session={stubSession({})} />)
  // "Complexity" is rendered only by the walkthrough's own TopBar; its absence
  // proves the canvas suppressed it (hideTopBar), leaving a single surface bar.
  assert.doesNotMatch(html, /Complexity/, 'the walkthrough top bar is folded away')
  // The walkthrough itself still renders, keyed by this review.
  assert.match(html, /Walkthrough|In this step|review-pane-enter/, 'the walkthrough surface renders in the canvas')
})

run('the canvas surfaces the no-change and prepare states honestly', () => {
  const noChange = renderToStaticMarkup(<ReviewCanvas session={stubSession({ status: 'no-change', changeset: null, brief: null })} />)
  assert.match(noChange, /No change to review yet/)
  const prepare = renderToStaticMarkup(<ReviewCanvas session={stubSession({ status: 'prepare', brief: null })} />)
  assert.match(prepare, /Prepare walkthrough/)
})

console.log('reviewSurfaceComposition tests passed')
