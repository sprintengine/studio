import type { ReactNode } from 'react'

import type { ReviewChangeSet } from '../../../../../shared/review'
import { InlineNotice } from '../../ui/InlineNotice'
import { Spinner } from '../../ui/Spinner'
import { ReviewWalkthrough } from './ReviewWalkthrough'
import { FreshnessBanner } from './FreshnessBanner'
import { isPullRequestReviewSource } from './commentModel'
import { sourceIdentity } from './reviewSelectors'
import type { ReviewRunProgress, ReviewSession } from './useReviewSession'

// The Reviews-door canvas (MC-1708 T6): the selected review's walkthrough, minus
// its own top bar (the folded surface bar carries those actions). It renders the
// same honest load ladder the retired `ReviewPanel` did — loading, unreadable
// change set, no change yet, an invalid walkthrough, the degraded raw-change view
// (no guide brief), and the guided walkthrough itself — driven entirely by a
// `ReviewSession`. In the degraded state (T1) the walkthrough still renders the
// full diff, read-toggles, comments, and post-to-PR from a synthesized brief; a
// slim banner offers to prepare the guide walkthrough and surfaces a failed run.
// All the state, IPC, and mutation live in `useReviewSession`; this is the pure
// view, so it renders deterministically from a session object with no side effects.
// `guideActions` and `toolbar` are the slots it does not own: the preparation
// choices (how deep a walkthrough, which agent builds it) and the link into the
// guide's terminal need the plugin catalog, the persisted defaults, and the
// layout registry, which the Reviews door supplies (ReviewGuideControls) so this
// stays store-free. `toolbar` is the slim tools row (diff view, Re-run, Ask the
// guide) rendered over the walkthrough — it only appears once there is a
// walkthrough for those tools to act on.
export function ReviewCanvas({ session, guideActions, toolbar }: { session: ReviewSession; guideActions: ReactNode; toolbar?: ReactNode }): JSX.Element {
  const { status, changeset, run } = session

  // No review is selected — an explicit resting state, not a spinner that would
  // otherwise read as "loading…" forever when nothing is being loaded at all.
  if (status === 'idle') {
    return (
      <CenteredState>
        <div className="max-w-md text-center">
          <h3 className="mb-1.5 text-[15px] font-semibold text-[color:var(--text-strong)]">No review selected</h3>
          <p className="text-[12.5px] leading-5 text-[color:var(--text-muted)]">
            Choose a review from the list to open its walkthrough.
          </p>
        </div>
      </CenteredState>
    )
  }

  if (status === 'loading') {
    return (
      <CenteredState>
        <Spinner /> <span className="ml-2">Loading the change…</span>
      </CenteredState>
    )
  }

  if (status === 'error') {
    return (
      <CenteredState>
        <div className="max-w-md">
          <h3 className="mb-1.5 text-[15px] font-semibold text-[color:var(--text-strong)]">Couldn’t open this review</h3>
          <p className="text-[12.5px] leading-5 text-[color:var(--text-muted)]">
            {session.errorMessage ?? 'The change set could not be read.'}
          </p>
        </div>
      </CenteredState>
    )
  }

  if (status === 'no-change' || !changeset) {
    return (
      <CenteredState>
        <div className="max-w-md">
          <h3 className="mb-1.5 text-[15px] font-semibold text-[color:var(--text-strong)]">No change to review yet</h3>
          <p className="text-[12.5px] leading-5 text-[color:var(--text-muted)]">
            This review has no change loaded. Start a new one from a pull request, branch, or patch.
          </p>
        </div>
      </CenteredState>
    )
  }

  if (status === 'invalid-brief') {
    return (
      <PrepareShell changeset={changeset}>
        <InlineNotice tone="error" className="max-w-2xl">
          <span className="font-medium">The walkthrough didn’t pass its checks.</span>
          <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11.5px] leading-5">
            {session.invalidErrors}
          </pre>
        </InlineNotice>
        <div className="mt-3 flex flex-wrap items-center gap-2">{guideActions}</div>
        <RunLine run={run} />
      </PrepareShell>
    )
  }

  // status === 'ready' or 'degraded' — a brief to project. When ready it is the
  // guide's; when degraded it is the renderer-synthesized model (raw change, no
  // guide chrome). Both render the same walkthrough so the diff, read-toggles,
  // comments, and post-to-PR work identically; degraded just adds a banner and
  // hides the guide-only affordances (session.isDegraded drives that below).
  const brief = session.brief
  if (!brief) {
    return (
      <CenteredState>
        <Spinner /> <span className="ml-2">Loading the walkthrough…</span>
      </CenteredState>
    )
  }

  const bannerSlot = session.isDegraded ? (
    <DegradedBanner run={run} actions={guideActions} />
  ) : session.bannerModel ? (
    <FreshnessBanner model={session.bannerModel} refreshing={run.running} refreshPhase={run.phase} onRefresh={session.refresh} />
  ) : null

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {toolbar}
      <div className="min-h-0 flex-1">
        <ReviewWalkthrough
          changeset={changeset}
          brief={brief}
          isDegraded={session.isDegraded}
          readFiles={session.readFiles}
          diffView={session.diffView}
          activePaneId={session.activePaneId}
          monacoTheme={session.monacoTheme}
          rerunning={run.running}
          onSetActivePane={session.onSetActivePane}
          onSetDiffView={session.onSetDiffView}
          onToggleRead={session.onToggleRead}
          onRequestComment={NOOP}
          onAskGuide={session.askController.askFromCard}
          onRerun={session.refresh}
          bannerSlot={bannerSlot}
          comments={session.comments}
          onCreateComment={session.onCreateComment}
          onEditComment={session.onEditComment}
          onDeleteComment={session.onDeleteComment}
          onPostReview={isPullRequestReviewSource(changeset) ? session.onPostReview : undefined}
          postState={session.postState}
          onOpenAsk={session.openAsk}
          hideTopBar
          trayController={session.trayController}
        />
      </div>
    </div>
  )
}

const NOOP = (): void => {}

function CenteredState({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-[color:var(--bg-surface)] px-6 text-[13px] text-[color:var(--text-muted)]">
      {children}
    </div>
  )
}

// The prepare/failure shell keeps the source identity visible so the reviewer
// always knows what they are about to walk, even before a brief exists.
function PrepareShell({ changeset, children }: { changeset: ReviewChangeSet; children: ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-[color:var(--bg-surface)] px-6 py-6">
      <header className="mb-5">
        <h2 className="text-[17px] font-semibold leading-6 tracking-tight text-[color:var(--text-strong)]">
          {changeset.title}
        </h2>
        <p className="mt-1 font-mono text-[12px] text-[color:var(--text-subtle)]">
          {sourceIdentity(changeset)} · <span className="tabular-nums">{changeset.stats.files}</span>{' '}
          {changeset.stats.files === 1 ? 'file' : 'files'} ·{' '}
          <span className="tabular-nums text-[color:var(--tone-good)]">+{changeset.stats.additions}</span>{' '}
          <span className="tabular-nums text-[color:var(--tone-error)]">−{changeset.stats.deletions}</span>
        </p>
      </header>
      {children}
    </div>
  )
}

// The slim degraded banner under the surface bar: honest about the missing guide,
// with the one affordance that matters in each state. It carries three faces — a
// resting invite, a "the guide is working" line (the guide runs in its own
// terminal, so the action beside it is the way into that terminal), and a run
// failure ("keep reviewing without it") — so a failed guide run is never a dead
// end over a reviewable change. `actions` is the whole right-hand block, choices
// included (MC-1788), and lays itself out; the banner only places it.
function DegradedBanner({ run, actions }: { run: ReviewRunProgress; actions: ReactNode }) {
  const failed = Boolean(run.error)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-6 py-2.5">
      <span className="min-w-0 flex-1 text-[12px] leading-5 text-[color:var(--text-muted)]">
        {failed ? (
          <>
            <span className="font-medium text-[color:var(--tone-error)]">The guide couldn’t finish.</span>{' '}
            {run.error} You can keep reviewing without it.
          </>
        ) : run.running ? (
          <span className="inline-flex items-center gap-2">
            <Spinner />
            {RUN_PHASE_LABEL[run.phase ?? 'reading'] ?? RUN_PHASE_LABEL.grouping}
          </span>
        ) : (
          'No guide walkthrough yet — you’re viewing the raw change.'
        )}
      </span>
      {actions}
    </div>
  )
}

function RunLine({ run }: { run: ReviewRunProgress }) {
  if (run.error) {
    return <p className="mt-3 max-w-2xl text-[12px] leading-5 text-[color:var(--tone-error)]">{run.error}</p>
  }
  if (!run.running || !run.phase) return null
  return (
    <p className="mt-3 flex items-center gap-2 text-[12px] text-[color:var(--text-muted)]">
      <Spinner />
      {RUN_PHASE_LABEL[run.phase]}
    </p>
  )
}

// Phase copy for the terminal guide (MC-1783). `reading` now covers getting the
// guide's terminal up with the run prompt, and `grouping` is the guide itself
// working in that terminal — the labels say so rather than describing a
// generation step this process no longer performs.
const RUN_PHASE_LABEL: Record<string, string> = {
  reading: 'Starting the guide…',
  grouping: 'The guide is working on the walkthrough…',
  annotating: 'Checking the walkthrough…',
  writing: 'Saving the walkthrough…',
  done: 'Walkthrough ready',
  failed: 'The guide could not finish',
}

export default ReviewCanvas
