import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ReviewIndexEntry } from '../../../../../../shared/electron-api'
import type { ReviewComment } from '../../../../../../shared/review'
import { reviewFixture } from '../../../panels/review/fixtures'
import { orderedSteps } from '../../../panels/review/reviewSelectors'
import { synthesizeDegradedBrief } from '../../../panels/review/degradedBrief'
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
    isDegraded: false,
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

// The synthesized raw-change model the degraded state renders — one flat step over
// the fixture's four files (below the folder-grouping threshold), no annotations.
const degradedBrief = synthesizeDegradedBrief(reviewFixture.changeset)

// The folded surface bar carries the walkthrough's actions once there is a change
// to work; before any change is loaded there is nothing to view, re-run, or post.
run('the surface bar shows no walkthrough actions before there is a change', () => {
  const bar = buildReviewsSurfaceBar(entry, stubSession({ status: 'no-change', changeset: null, brief: null }))
  assert.equal(bar.actions, undefined, 'no view/re-run/post controls with no change')
  assert.equal(bar.title, reviewFixture.changeset.title)
})

// Degraded (no guide brief): the reviewer still needs the diff-view toggle and the
// review/post controls, but there is no guide to re-run or ask, so those drop.
run('the degraded surface bar keeps diff-view + review controls and drops guide actions', () => {
  const bar = buildReviewsSurfaceBar(
    entry,
    stubSession({ status: 'degraded', isDegraded: true, brief: degradedBrief, isPullRequest: true, pendingComments: 2, comments: [pendingComment, pendingComment] }),
  )
  assert.ok(bar.actions, 'a degraded change still carries an action cluster')
  const html = renderToStaticMarkup(<>{bar.statusChip}{bar.actions}</>)
  assert.match(html, /Side by side/, 'the diff-view toggle stays so both diff modes are reachable')
  assert.match(html, /Post review/, 'post-to-PR stays with no brief')
  assert.doesNotMatch(html, /Ask the guide/, 'no guide to ask in degraded mode')
  assert.doesNotMatch(html, /Re-run/, 'nothing to re-run without a guide walkthrough')
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

run('the canvas surfaces the no-change and degraded states honestly', () => {
  const noChange = renderToStaticMarkup(<ReviewCanvas session={stubSession({ status: 'no-change', changeset: null, brief: null })} />)
  assert.match(noChange, /No change to review yet/)

  // Degraded: the raw change renders (file cards from the changeset, active step
  // is the synthesized "All files" step), framed by a banner that offers to prepare
  // the guide walkthrough. No guide chat is offered.
  const degraded = renderToStaticMarkup(
    <ReviewCanvas session={stubSession({ status: 'degraded', isDegraded: true, brief: degradedBrief, activePaneId: 'degraded-all' })} />,
  )
  assert.match(degraded, /viewing the raw change/, 'the banner frames the change as guide-less')
  assert.match(degraded, /Prepare walkthrough/, 'and offers to prepare the guide walkthrough')
  assert.match(degraded, /prisma\/schema\.prisma/, 'every changed file still renders with no guide')
  assert.doesNotMatch(degraded, /Ask the guide/, 'the guide chat entry is hidden in degraded mode')
})

// A failed guide run is surfaced in the degraded banner, never a dead-end screen —
// the reviewable change stays underneath it.
run('the degraded canvas surfaces a failed guide run without blocking the change', () => {
  const failed = renderToStaticMarkup(
    <ReviewCanvas
      session={stubSession({
        status: 'degraded',
        isDegraded: true,
        brief: degradedBrief,
        activePaneId: 'degraded-all',
        run: { running: false, phase: 'failed', error: 'Claude Code is not installed.' },
      })}
    />,
  )
  assert.match(failed, /The guide couldn’t finish/, 'the failure is named')
  assert.match(failed, /Claude Code is not installed\./, 'with the underlying reason')
  assert.match(failed, /keep reviewing without it/, 'and reassures the change is still reviewable')
  assert.match(failed, /Try again/, 'the retry affordance is present')
  assert.match(failed, /prisma\/schema\.prisma/, 'the change still renders under the failure banner')
})

console.log('reviewSurfaceComposition tests passed')
