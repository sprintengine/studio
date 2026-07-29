import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// The stale-closure regression net (MC-1717 / T3). `onPostReview` used to capture
// a pre-post snapshot and, after the IPC round-trip, write it back verbatim —
// silently dropping a comment composed mid-post and reverting files-read toggles.
// Every other review test in this repo is a static renderToStaticMarkup, which
// cannot span an await; a stale closure IS a timing bug, so this suite stands up a
// real DOM and drives a post with an edit landing while the batch is in flight.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})

const anyGlobal = globalThis as unknown as Record<string, unknown>
anyGlobal.document = dom.window.document
anyGlobal.navigator = dom.window.navigator
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.Node = dom.window.Node
anyGlobal.getComputedStyle = dom.window.getComputedStyle
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
dom.window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
})) as unknown as typeof dom.window.matchMedia

async function main(): Promise<void> {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { useReviewSession } = await import('./useReviewSession')
  const { fixtureChangeSet, fixtureBrief } = await import('./fixtures')
  type ReviewSession = import('./useReviewSession').ReviewSession
  type ReviewBrief = import('../../../../../shared/review').ReviewBrief
  type ReviewComment = import('../../../../../shared/review').ReviewComment
  type ReviewWorkspaceState = import('../../../../../shared/review').ReviewWorkspaceState
  type ReviewBriefRunDepth = import('../../../../../shared/electron-api').ReviewBriefRunDepth
  type ReviewBriefRunEvent = import('../../../../../shared/electron-api').ReviewBriefRunEvent
  type ReviewGuideRunStatus = import('../../../../../shared/electron-api').ReviewGuideRunStatus
  type ReviewPostReviewResult = import('../../../../../shared/electron-api').ReviewPostReviewResult
  type ReviewCommentPostOutcome = import('../../../../../shared/electron-api').ReviewCommentPostOutcome

  const pending = (id: string, path: string, line: number, body: string): ReviewComment => ({
    id,
    path,
    anchor: { side: 'new', startLine: line, endLine: line },
    body,
    createdAt: '2026-07-20T00:00:00.000Z',
    sync: { state: 'pending' },
  })

  // A fresh session harness for one scenario: two pending comments already stored
  // against the fixture PR change set, a controllable post, and captured writes.
  // `runStatus` is the main process's record of the guide run (MC-1784) that a
  // mount seeds from; `starts` counts every start IPC so a second one is visible.
  function setup(seedComments: ReviewComment[], runStatus: ReviewGuideRunStatus | null = null) {
    let stored: ReviewWorkspaceState = {
      schemaVersion: 1,
      changeSetId: fixtureChangeSet.id,
      readFiles: [],
      diffView: 'side-by-side',
      comments: seedComments,
    }
    let resolvePost: ((result: ReviewPostReviewResult) => void) | null = null
    // The brief on disk — null (degraded) until a scenario lands one; every
    // `reviewReadBrief` reads the current value, so a re-read after a run 'done'
    // sees the upgrade. The run-event callback is captured so a scenario can fire
    // the guide-run lifecycle the hook subscribes to.
    let briefValue: ReviewBrief | null = null
    let runEventCb: ((event: ReviewBriefRunEvent) => void) | null = null
    const starts: { cli?: string; depth?: string; restart?: boolean; hostWorkspaceId?: string }[] = []
    const api = {
      reviewReadState: async () => ({ ok: true, state: stored }),
      reviewReadChangeset: async () => ({ ok: true, changeset: fixtureChangeSet }),
      reviewReadBrief: async () => ({ ok: true, brief: briefValue }),
      reviewWriteState: async (_t: unknown, next: ReviewWorkspaceState) => {
        stored = next
        return { ok: true }
      },
      reviewPostReview: () => new Promise<ReviewPostReviewResult>((res) => (resolvePost = res)),
      onReviewBriefRunEvent: (cb: (event: ReviewBriefRunEvent) => void) => {
        runEventCb = cb
        return () => {}
      },
      reviewBriefRunStatus: async () => runStatus,
      // A freshness re-run re-ingests before it restarts the guide. The fixture PR
      // is re-fetched unchanged; what this suite watches is the start that follows.
      reviewIngestSource: async () => ({ ok: true, changeset: fixtureChangeSet }),
      // The terminal guide (MC-1783): `ok` means its terminal has the prompt, not
      // that a walkthrough exists — the brief arrives later as a `done` event.
      reviewStartBriefRun: async (
        input: { cli?: string; depth?: string; restart?: boolean; hostWorkspaceId?: string },
      ) => {
        starts.push({
          cli: input.cli,
          depth: input.depth,
          restart: input.restart,
          hostWorkspaceId: input.hostWorkspaceId,
        })
        return {
          ok: true,
          guide: { workspaceId: 'ws-1', agentId: 'review-guide-r1', sessionId: 'review-guide-r1', cli: input.cli ?? 'codex' },
        }
      },
    }
    anyGlobal.window = new Proxy(dom.window, {
      get(target, prop) {
        if (prop === 'api') {
          return new Proxy(api, {
            get: (a, p) => (p in a ? (a as Record<string | symbol, unknown>)[p] : async () => null),
          })
        }
        const value = (target as unknown as Record<string | symbol, unknown>)[prop]
        return typeof value === 'function' ? value.bind(target) : value
      },
    })

    let session: ReviewSession | null = null
    // Depth is a required prop now (MC-1788) — the reviewer picks it on the
    // prepare banner, so the harness renders it the way the door does rather than
    // leaning on a default the hook no longer has.
    function Harness({ depth }: { depth: ReviewBriefRunDepth }): null {
      session = useReviewSession({
        reviewId: 'r1',
        workspaceRoot: '/repo',
        depth,
        guideCli: 'codex',
        // The door resolves-or-creates the project's Reviews host at start time
        // (MC-1911); the hook only has to carry whatever it answers.
        resolveHostWorkspaceId: () => 'ws-reviews-repo',
      })
      return null
    }
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    return {
      root,
      current: () => {
        assert.ok(session, 'the session must have rendered')
        return session
      },
      // Two passes: the mount, then a flush for the loads it chains (change set →
      // brief, and the run-status seed), so assertions see a settled session.
      render: async (depth: ReviewBriefRunDepth = 'standard') => {
        await act(async () => root.render(React.createElement(Harness, { depth })))
        await act(async () => {})
      },
      resolvePost: (result: ReviewPostReviewResult) =>
        act(async () => {
          assert.ok(resolvePost, 'a post must be in flight before it can resolve')
          resolvePost(result)
        }),
      // Land a brief on disk (as a guide run would), then fire the run 'done' event
      // the hook listens for; it re-reads the brief and upgrades in place. The
      // trailing empty act flushes the async reload the event handler kicks off.
      landBrief: async (brief: ReviewBrief) => {
        briefValue = brief
        await act(async () => {
          assert.ok(runEventCb, 'the session must have subscribed to run events')
          runEventCb({ workspaceId: 'r1', phase: 'done' })
        })
        await act(async () => {})
      },
      // Fire one non-terminal run phase, as the guide's terminal service does.
      emitPhase: (phase: ReviewBriefRunEvent['phase'], detail?: string) =>
        act(async () => {
          assert.ok(runEventCb, 'the session must have subscribed to run events')
          runEventCb(detail ? { workspaceId: 'r1', phase, detail } : { workspaceId: 'r1', phase })
        }),
      starts: () => starts,
      finalStored: () => stored,
    }
  }

  const okOutcome = (id: string, url: string): ReviewCommentPostOutcome => ({
    id,
    sync: { state: 'posted', url, postedAt: '2026-07-20T01:00:00.000Z' },
  })

  async function successPreservesMidPostEdits(): Promise<void> {
    const h = setup([
      pending('c-1', 'prisma/schema.prisma', 37, 'Cap at MEMBER?'),
      pending('c-2', 'src/server/api/invitations.ts', 63, '404 vs 400?'),
    ])
    await h.render()
    assert.equal(h.current().comments.length, 2, 'both stored comments load')
    assert.equal(h.current().canPost, true, 'a PR with pending comments can post')

    // Start the post; it stays in flight (reviewPostReview is deferred).
    await act(async () => {
      void h.current().onPostReview()
    })
    assert.equal(h.current().postState.phase, 'posting')
    assert.deepEqual(
      h.current().comments.map((c) => c.sync.state),
      ['posting', 'posting'],
      'both batch comments flip to posting',
    )

    // A reviewer composes a third comment and marks a file read WHILE posting —
    // two discrete actions (separate ticks), as a person would trigger them.
    await act(async () => {
      h.current().onCreateComment('src/server/api/invitations.ts', { side: 'new', startLine: 70, endLine: 70 }, 'One more thought')
    })
    await act(async () => {
      h.current().onToggleRead('prisma/schema.prisma')
    })
    await act(async () => {
      h.current().onSetActivePane('step-api')
    })
    assert.equal(h.current().comments.length, 3, 'the mid-post comment is present before the post resolves')

    // The batch returns success — outcomes cover ONLY the two comments it sent.
    await h.resolvePost({ ok: true, reviewUrl: 'https://x/pull/482#r', outcomes: [okOutcome('c-1', 'u1'), okOutcome('c-2', 'u2')] })

    const final = h.finalStored()
    const byId = new Map(final.comments.map((c) => [c.id, c]))
    assert.equal(final.comments.length, 3, 'nothing was lost — the mid-post comment survived')
    assert.equal(byId.get('c-1')!.sync.state, 'posted', 'first batch comment landed its posted stamp')
    assert.equal(byId.get('c-2')!.sync.state, 'posted', 'second batch comment landed its posted stamp')
    const midPost = final.comments.find((c) => c.id !== 'c-1' && c.id !== 'c-2')!
    assert.equal(midPost.sync.state, 'pending', 'the comment composed mid-post is untouched, still pending')
    assert.equal(midPost.body, 'One more thought')
    assert.deepEqual(final.readFiles, ['prisma/schema.prisma'], 'the mid-post files-read toggle survived')
    assert.equal(final.activeStepId, 'step-api', 'the active step chosen mid-post survived')
    assert.equal(h.current().postState.phase, 'idle')
    h.root.unmount()
    console.log('ok - a comment and a files-read toggle composed mid-post survive a successful post')
  }

  async function failureSparesMidPostComment(): Promise<void> {
    const h = setup([pending('c-1', 'prisma/schema.prisma', 37, 'Cap at MEMBER?')])
    await h.render()
    await act(async () => {
      void h.current().onPostReview()
    })
    await act(async () => {
      h.current().onCreateComment('src/server/api/invitations.ts', { side: 'new', startLine: 70, endLine: 70 }, 'Mid-post note')
    })
    await act(async () => {
      h.current().onToggleRead('prisma/schema.prisma')
    })
    await h.resolvePost({ ok: false, error: 'GitHub denied the request (403).' })

    const final = h.finalStored()
    const byId = new Map(final.comments.map((c) => [c.id, c]))
    assert.equal(final.comments.length, 2, 'the mid-post comment survives a batch failure')
    assert.equal(byId.get('c-1')!.sync.state, 'failed', 'the sent comment is a retryable failure')
    const midPost = final.comments.find((c) => c.id !== 'c-1')!
    assert.equal(midPost.sync.state, 'pending', 'a comment outside the batch is NOT marked failed')
    assert.deepEqual(final.readFiles, ['prisma/schema.prisma'], 'the files-read toggle survived the error path')
    assert.equal(h.current().postState.phase, 'error')
    h.root.unmount()
    console.log('ok - a mid-post comment is spared (stays pending) when the batch fails')
  }

  // T1: with no brief the review is degraded — a synthesized model renders the raw
  // change while the human keeps commenting. When a guide run later lands a real
  // brief, the view upgrades in place and the reviewer's comments (keyed by
  // changeSetId, which does not change) survive untouched.
  async function degradedUpgradesInPlaceWithCommentsIntact(): Promise<void> {
    const h = setup([pending('c-1', 'prisma/schema.prisma', 37, 'Cap at MEMBER?')])
    await h.render()
    assert.equal(h.current().status, 'degraded', 'no brief on disk → degraded')
    assert.equal(h.current().isDegraded, true)
    assert.ok(h.current().brief, 'a synthesized brief is exposed so the raw change renders')
    assert.equal(h.current().brief!.changeSetId, fixtureChangeSet.id, 'the synth brief walks this changeset')
    assert.equal(h.current().canPost, true, 'a PR review can post with no guide')
    assert.equal(h.current().comments.length, 1, 'the comment exists in the degraded state')

    // A guide run lands a real brief and signals done.
    await h.landBrief(fixtureBrief)

    assert.equal(h.current().status, 'ready', 'the review upgrades to the guided walkthrough')
    assert.equal(h.current().isDegraded, false)
    assert.equal(h.current().brief!.steps.length, fixtureBrief.steps.length, 'the real brief is now in effect')
    assert.equal(h.current().comments.length, 1, 'the comment survived the upgrade — nothing migrated')
    assert.equal(h.current().comments[0].id, 'c-1', 'the same comment, untouched')
    h.root.unmount()
    console.log('ok - a no-brief degraded review upgrades in place when a brief lands, comments intact')
  }

  // T6: the guide runs in a terminal that outlives this component. A remount in
  // the middle of a run must read the live phase back from the main process — and
  // pressing Prepare against it must NOT start a second guide.
  async function remountMidRunSeedsWithoutRestarting(): Promise<void> {
    const h = setup([], { running: true, phase: 'grouping', detail: 'codex', startedAt: '2026-07-22T00:00:00.000Z' })
    await h.render()

    assert.equal(h.current().run.running, true, 'the live run is seeded from the main process, not from this mount')
    assert.equal(h.current().run.phase, 'grouping', 'with the phase the guide is actually in')
    assert.equal(h.current().status, 'degraded', 'and the raw change stays reviewable while it works')

    // The one-writer guard: Prepare during a live run joins it.
    await act(async () => {
      h.current().startRun()
    })
    assert.deepEqual(h.starts(), [], 'no second start IPC fired against a run already in flight')
    assert.equal(h.current().run.running, true, 'and the live run is left alone')

    // The guide finishes: the brief lands and the review upgrades in place.
    await h.landBrief(fixtureBrief)
    assert.equal(h.current().status, 'ready')
    assert.equal(h.current().run.running, false)
    h.root.unmount()
    console.log('ok - a remount mid-run seeds the live phase and Prepare joins instead of starting again')
  }

  // The full degraded → working → ready walk on a fresh review, where the start
  // IPC resolves when the TERMINAL has the prompt, not when a brief exists.
  async function degradedToWorkingToReady(): Promise<void> {
    const h = setup([])
    await h.render()
    assert.equal(h.current().status, 'degraded', 'no brief on disk → degraded')
    assert.equal(h.current().run.running, false, 'and no run seeded — this review has never run one')

    await act(async () => {
      h.current().startRun()
    })
    assert.deepEqual(
      h.starts(),
      [{ cli: 'codex', depth: 'standard', restart: undefined, hostWorkspaceId: 'ws-reviews-repo' }],
      'the picked agent CLI, depth, and guide host ride the start; a fresh start never restarts',
    )
    assert.equal(h.current().run.running, true, 'the run stays open after the start resolves — the brief is not there yet')
    assert.equal(h.current().status, 'degraded', 'the raw change is still what renders')
    assert.equal(h.current().guide?.agentId, 'review-guide-r1', 'the guide terminal it reported is exposed for the focus link')

    await h.emitPhase('grouping')
    assert.equal(h.current().run.phase, 'grouping', 'live phases from the guide keep the working state honest')
    assert.equal(h.current().run.running, true)

    await h.landBrief(fixtureBrief)
    assert.equal(h.current().status, 'ready', 'the walkthrough renders once the guide delivers it')
    assert.equal(h.current().run.running, false)
    assert.equal(h.current().run.phase, 'done')
    h.root.unmount()
    console.log('ok - degraded → working → ready: the run ends on the guide’s event, not on the start call')
  }

  // A retained terminal phase (MC-1784) explains the last failure on a remount,
  // instead of dropping back to a bare prepare button that hides what happened.
  async function remountAfterFailureExplainsIt(): Promise<void> {
    const h = setup([], {
      running: false,
      phase: 'failed',
      detail: 'The guide session ended without delivering a walkthrough.',
      startedAt: '2026-07-22T00:00:00.000Z',
    })
    await h.render()
    assert.equal(h.current().run.running, false)
    assert.equal(h.current().run.phase, 'failed')
    assert.match(h.current().run.error ?? '', /without delivering a walkthrough/, 'the reason survives the remount')
    assert.equal(h.current().status, 'degraded', 'and the change is still reviewable underneath it')
    h.root.unmount()
    console.log('ok - a remount after a failed run still explains why it failed')
  }

  // MC-1788: depth is the reviewer's choice on the prepare banner, so it must ride
  // every guide invocation from the UI value — never a default inside the hook.
  // Changing the control and pressing Prepare has to change what the IPC carries,
  // and a freshness re-run has to reuse the same choice without asking again.
  async function chosenDepthRidesEveryGuideInvocation(): Promise<void> {
    const h = setup([])
    await h.render('thorough')
    await act(async () => {
      h.current().startRun()
    })
    assert.equal(h.starts()[0]?.depth, 'thorough', 'the depth the reviewer chose is what the start IPC carries')

    // The reviewer moves the control to Overview before the next invocation.
    await h.render('brief')
    await act(async () => {
      h.current().refresh()
    })
    assert.equal(h.starts().length, 2, 'the freshness re-run started the guide again')
    assert.equal(h.starts()[1]?.depth, 'brief', 'the re-run silently reuses the current choice, not the first one')
    assert.equal(h.starts()[1]?.restart, true, 'and it replaces the run in flight, as a re-run must')
    // MC-1911: the guide's terminal belongs in the project's Reviews host, not in
    // whatever workspace the reviewer happens to have open.
    assert.deepEqual(
      h.starts().map((start) => start.hostWorkspaceId),
      ['ws-reviews-repo', 'ws-reviews-repo'],
      'every guide invocation names the workspace its terminal belongs in',
    )
    h.root.unmount()
    console.log('ok - the chosen depth rides both the first start and a freshness re-run')
  }

  await successPreservesMidPostEdits()
  await failureSparesMidPostComment()
  await degradedUpgradesInPlaceWithCommentsIntact()
  await remountMidRunSeedsWithoutRestarting()
  await degradedToWorkingToReady()
  await remountAfterFailureExplainsIt()
  await chosenDepthRidesEveryGuideInvocation()
  console.log('all useReviewSession concurrency tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
