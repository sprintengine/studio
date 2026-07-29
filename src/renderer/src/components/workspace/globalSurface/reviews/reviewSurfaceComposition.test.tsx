import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ReviewIndexEntry } from '../../../../../../shared/electron-api'
import type { ReviewComment } from '../../../../../../shared/review'
import { reviewFixture } from '../../../panels/review/fixtures'
import { orderedSteps, statsChip } from '../../../panels/review/reviewSelectors'
import { synthesizeDegradedBrief } from '../../../panels/review/degradedBrief'
import type { ReviewSession } from '../../../panels/review/useReviewSession'
import { ReviewCanvas } from '../../../panels/review/ReviewCanvas'
import { TopBar } from '../../../panels/review/TopBar'
import { ReviewCanvasTools, buildReviewsSurfaceBar } from './ReviewSurfaceBar'
import { reviewGuideAgentId, resolveGuideTerminal } from './reviewGuideTerminal'

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
    guide: null,
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
    askGuide: async () => ({ ok: true }),
    trayController: { open: false, setOpen: NOOP },
    askController: { open: false, setOpen: NOOP, prefill: undefined, askFromCard: NOOP },
    openTray: NOOP,
    openAsk: NOOP,
    ...overrides,
  }
}

// The store-bound guide controls (runtime picker, "open its terminal") live in the
// door; this suite renders the canvas, so it passes the slot's shape, not its
// implementation — exactly the split that keeps the canvas store-free.
const guideActions = (
  <>
    <button type="button">Claude Code</button>
    <button type="button">Prepare walkthrough</button>
  </>
)

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

// Degraded (no guide brief): the bar keeps the one CTA (post/review), the canvas
// toolbar keeps the diff-view toggle — but there is no guide to re-run or ask,
// so those drop from the tools.
run('degraded: the bar keeps the post CTA, the canvas tools keep the diff toggle and drop guide actions', () => {
  const session = stubSession({ status: 'degraded', isDegraded: true, brief: degradedBrief, isPullRequest: true, pendingComments: 2, comments: [pendingComment, pendingComment] })
  const bar = buildReviewsSurfaceBar(entry, session)
  assert.ok(bar.actions, 'a degraded change still carries the review CTA')
  const barHtml = renderToStaticMarkup(<>{bar.statusChip}{bar.actions}</>)
  assert.match(barHtml, /Post review/, 'post-to-PR stays with no brief')
  assert.doesNotMatch(barHtml, /Side by side/, 'the diff toggle is canvas chrome, never title-bar chrome')
  const tools = renderToStaticMarkup(<ReviewCanvasTools session={session} />)
  assert.match(tools, /Side by side/, 'the diff-view toggle stays so both diff modes are reachable')
  assert.doesNotMatch(tools, /Ask the guide/, 'no guide to ask in degraded mode')
  assert.doesNotMatch(tools, /Re-run/, 'nothing to re-run without a guide walkthrough')
})

run('a ready pull-request review with pending comments shows the Post review CTA', () => {
  const session = stubSession({ isPullRequest: true, pendingComments: 3, comments: [pendingComment, pendingComment, pendingComment] })
  const bar = buildReviewsSurfaceBar(entry, session)
  const html = renderToStaticMarkup(<>{bar.statusChip}{bar.actions}</>)
  assert.match(html, /Post review/, 'the primary CTA is Post review')
  assert.match(html, /3 comments/, 'the CTA carries the pending count')
  assert.match(html, /In progress/, 'an unposted review reads as In progress')
  const tools = renderToStaticMarkup(<ReviewCanvasTools session={session} />)
  assert.match(tools, /Ask the guide/, 'Ask the guide rides the canvas toolbar')
  assert.match(tools, /Re-run/, 'so does Re-run')
  assert.match(tools, /Side by side/, 'with the diff-view toggle')
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
  const html = renderToStaticMarkup(<ReviewCanvas session={stubSession({})} guideActions={guideActions} />)
  // "Complexity" is rendered only by the walkthrough's own TopBar; its absence
  // proves the canvas suppressed it (hideTopBar), leaving a single surface bar.
  assert.doesNotMatch(html, /Complexity/, 'the walkthrough top bar is folded away')
  // The walkthrough itself still renders, keyed by this review.
  assert.match(html, /Walkthrough|In this step|review-pane-enter/, 'the walkthrough surface renders in the canvas')
})

run('the canvas surfaces the no-change and degraded states honestly', () => {
  const noChange = renderToStaticMarkup(<ReviewCanvas session={stubSession({ status: 'no-change', changeset: null, brief: null })} guideActions={guideActions} />)
  assert.match(noChange, /No change to review yet/)

  // Degraded: the raw change renders (file cards from the changeset, active step
  // is the synthesized "All files" step), framed by a banner that offers to prepare
  // the guide walkthrough. No guide ask is offered.
  const degraded = renderToStaticMarkup(
    <ReviewCanvas
      session={stubSession({ status: 'degraded', isDegraded: true, brief: degradedBrief, activePaneId: 'degraded-all' })}
      guideActions={guideActions}
    />,
  )
  assert.match(degraded, /viewing the raw change/, 'the banner frames the change as guide-less')
  assert.match(degraded, /Prepare walkthrough/, 'and offers to prepare the guide walkthrough')
  assert.match(degraded, /Claude Code/, 'the agent that will run the guide is pickable on the banner')
  assert.match(degraded, /prisma\/schema\.prisma/, 'every changed file still renders with no guide')
  assert.doesNotMatch(degraded, /Ask the guide/, 'the guide ask entry is hidden in degraded mode')
})

// A guide that is working says so, and the one action beside it is the way into
// the terminal it is working in — the run outlives this component, so a remount
// mid-run lands here (its phase seeded from the main process's own record).
run('a working guide reads as working, with its terminal as the action', () => {
  const working = renderToStaticMarkup(
    <ReviewCanvas
      session={stubSession({
        status: 'degraded',
        isDegraded: true,
        brief: degradedBrief,
        activePaneId: 'degraded-all',
        run: { running: true, phase: 'grouping', error: null },
      })}
      guideActions={<button type="button">Open the guide’s terminal</button>}
    />,
  )
  assert.match(working, /The guide is working on the walkthrough/, 'the running state names what is happening')
  assert.match(working, /Open the guide’s terminal/, 'and offers the terminal it is happening in')
  assert.doesNotMatch(working, /Prepare walkthrough/, 'no second start while a guide is already working')
  assert.match(working, /prisma\/schema\.prisma/, 'the change stays reviewable while the guide works')
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
      guideActions={<button type="button">Try again</button>}
    />,
  )
  assert.match(failed, /The guide couldn’t finish/, 'the failure is named')
  assert.match(failed, /Claude Code is not installed\./, 'with the underlying reason')
  assert.match(failed, /keep reviewing without it/, 'and reassures the change is still reviewable')
  assert.match(failed, /Try again/, 'the retry affordance is present')
  assert.match(failed, /prisma\/schema\.prisma/, 'the change still renders under the failure banner')
})

// MC-1804. With a walkthrough on screen the canvas tools row is the only place a
// re-run is visible, so it is where the run has to be stoppable. The row used to
// answer a live run with a DISABLED "Re-running…" button — a status wearing a
// control's clothes, and no way out of a runaway guide.
run('a re-run in flight reads as running in the canvas tools, with Stop as the way out', () => {
  const running = renderToStaticMarkup(
    <ReviewCanvasTools session={stubSession({ run: { running: true, phase: 'grouping', error: null } })} />,
  )
  assert.match(running, /Re-running…/, 'the row still says the guide is working')
  assert.match(running, />Stop</, 'and offers the stop the run never had a caller for')
  // The attribute, not the `disabled:` Tailwind variants every button carries.
  assert.doesNotMatch(running, /disabled="/, 'the running state is a live line, not a disabled button')
  assert.match(running, /Ask the guide/, 'a running guide can still be asked')

  const resting = renderToStaticMarkup(<ReviewCanvasTools session={stubSession({})} />)
  assert.match(resting, /Re-run/, 'at rest the row is back to Re-run')
  assert.doesNotMatch(resting, />Stop</, 'and offers no stop for a run that is not happening')
})

// MC-1815. Complexity is the guide's reading-effort judgment; the degraded model
// states none. The top bar renders the rest of its identity row without it rather
// than printing a hardcoded word over a change nobody judged.
run('the walkthrough top bar renders with and without a complexity', () => {
  const bar = (complexity?: 'low' | 'medium' | 'high') =>
    renderToStaticMarkup(
      <TopBar
        title={reviewFixture.changeset.title}
        source="multicode · main…invitations"
        stats={statsChip(reviewFixture.changeset)}
        {...(complexity ? { complexity } : {})}
        diffView="side-by-side"
        onSetDiffView={NOOP}
        onRerun={NOOP}
        rerunning={false}
      />,
    )
  const judged = bar('high')
  assert.match(judged, /Complexity/, 'a guide’s judgment is shown')
  assert.match(judged, />high</, 'as the word it is')

  const unjudged = bar()
  assert.doesNotMatch(unjudged, /Complexity/, 'no guide judged, so no complexity is claimed')
  assert.match(unjudged, /Side by side/, 'the rest of the bar renders unchanged')
  assert.match(unjudged, /Re-run/, 'including its actions')
})

// Guide-terminal coordinates. The live session wins — it is the terminal that
// actually exists — and a reported handle covers the gap before its snapshot
// arrives, because the run-status IPC answers "is a run open" and never says
// where. A remount still has to produce a working link.
run('the guide terminal resolves from its live session, else from a reported handle', () => {
  const guideSession = (overrides: Record<string, unknown> = {}) => ({
    sessionId: 'a1b2c3d4-0000-4000-8000-000000000001',
    processAlive: true,
    kind: 'agent',
    workspaceId: 'ws-reviews-multicode',
    agentId: reviewGuideAgentId('rv_1'),
    cli: 'claude-code',
    visible: false,
    suspended: false,
    reapExempt: false,
    startedAt: 1,
    lastOutputAt: null,
    lastInputAt: null,
    lastVisibleAt: null,
    exitedAt: null,
    outputBufferLength: 0,
    retainedOutputBytes: 0,
    activity: { kind: 'idle', since: 1 },
    ...overrides,
  }) as never

  const sessions = [
    guideSession({ agentId: 'agent-1', sessionId: 'other', workspaceId: 'ws-multicode' }),
    guideSession(),
  ]
  assert.deepEqual(
    resolveGuideTerminal({ reviewId: 'rv_1', guide: null, sessions }),
    {
      workspaceId: 'ws-reviews-multicode',
      agentId: reviewGuideAgentId('rv_1'),
      sessionId: 'a1b2c3d4-0000-4000-8000-000000000001',
      cli: 'claude-code',
    },
    'the guide is found by its per-review agent id, and reports the pty a tab attaches to',
  )

  // The pty id is minted per spawn, so a handle is the only way to know it
  // before the session snapshot lands.
  assert.deepEqual(
    resolveGuideTerminal({
      reviewId: 'rv_1',
      guide: {
        workspaceId: 'ws-reviews-multicode',
        agentId: reviewGuideAgentId('rv_1'),
        sessionId: 'a1b2c3d4-0000-4000-8000-000000000009',
        cli: 'codex',
      },
      sessions: [],
    }),
    {
      workspaceId: 'ws-reviews-multicode',
      agentId: reviewGuideAgentId('rv_1'),
      sessionId: 'a1b2c3d4-0000-4000-8000-000000000009',
      cli: 'codex',
    },
  )

  assert.equal(
    resolveGuideTerminal({ reviewId: 'rv_2', guide: null, sessions }),
    null,
    'a review with no guide terminal running has none to focus',
  )
})

console.log('reviewSurfaceComposition tests passed')
