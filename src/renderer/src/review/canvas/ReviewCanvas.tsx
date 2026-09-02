import type { ReactNode } from 'react'

import type { ReviewChangeSet } from '../../../../shared/review'
import { GhostButton } from '../../components/ui/Buttons'
import { EmptyState } from '../../components/ui/EmptyState'
import { InlineNotice } from '../../components/ui/InlineNotice'
import { Spinner } from '../../components/ui/Spinner'
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
export function ReviewCanvas({ session, guideActions }: { session: ReviewSession; guideActions: ReactNode }): JSX.Element {
  const { status, changeset, run } = session

  // No review is selected — an explicit resting state, not a spinner that would
  // otherwise read as "loading…" forever when nothing is being loaded at all.
  if (status === 'idle') {
    return (
      <CenteredState>
        <EmptyState title="No review selected" body="Choose a review from the list to open its walkthrough." />
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
        {/* A failure with no way out was the one state here that broke the notice
            contract (MC-2115): reloading the change is the recovery, and it
            exists — it just was not offered. */}
        <InlineNotice
          tone="error"
          className="max-w-md"
          title="Couldn’t open this review"
          hint={session.errorMessage ?? 'The change set could not be read.'}
          action={<GhostButton onClick={session.reloadChangeset}>Try again</GhostButton>}
        />
      </CenteredState>
    )
  }

  if (status === 'no-change' || !changeset) {
    return (
      <CenteredState>
        <EmptyState
          title="No change to review yet"
          body="This review has no change loaded. Start a new one from a pull request, branch, or patch."
        />
      </CenteredState>
    )
  }

  if (status === 'invalid-brief') {
    return (
      <PrepareShell changeset={changeset}>
        {/* The validator's raw output goes behind the disclosure, where the
            notice contract puts every raw technical string. */}
        <InlineNotice
          tone="error"
          className="max-w-2xl"
          title="The walkthrough didn’t pass its checks."
          detail={session.invalidErrors ?? undefined}
        />
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

  // NO chrome row above the walkthrough (owner, 2026-07-30). The guide's
  // controls and the walkthrough's tools moved into the door's own bar in the
  // app strip, so this canvas opens on the change itself. What the row used to
  // say on the left went with it: "No guide walkthrough yet — you're viewing the
  // raw change" narrated a screen the reviewer is looking at. A freshness banner
  // is a different animal — a notice about the change, with its own action — so
  // it keeps its band.
  const bannerSlot = (
    <>
      {!session.isDegraded && session.bannerModel ? (
        <FreshnessBanner model={session.bannerModel} refreshing={run.running} refreshPhase={run.phase} onRefresh={session.refresh} />
      ) : null}
      {/* A failed guide run still has to be visible, and a failure is a notice
          about the change — not chrome — so it keeps its own band with the
          reason and the reassurance that the change below is reviewable without
          it. The retry lives with the other guide controls, in the door bar. */}
      {run.error ? (
        <div className="shrink-0 px-5 pt-3">
          <InlineNotice tone="error">
            <span className="font-medium">The guide couldn’t finish.</span> {run.error} You can keep reviewing without it.
          </InlineNotice>
        </div>
      ) : null}
    </>
  )

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
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
    <div className="flex h-full w-full items-center justify-center bg-[color:var(--bg-surface)] px-5 text-body text-[color:var(--text-muted)]">
      {children}
    </div>
  )
}

// The prepare/failure shell keeps the source identity visible so the reviewer
// always knows what they are about to walk, even before a brief exists.
function PrepareShell({ changeset, children }: { changeset: ReviewChangeSet; children: ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-[color:var(--bg-surface)] px-5 py-6">
      <header className="mb-5">
        <h2 className="text-title font-semibold leading-6 tracking-tight text-[color:var(--text-strong)]">
          {changeset.title}
        </h2>
        <p className="mt-1 font-mono text-meta text-[color:var(--text-subtle)]">
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

function RunLine({ run }: { run: ReviewRunProgress }) {
  if (run.error) {
    // The shared error card, never red ink alone. The retry is the guide
    // controls rendered right above this line.
    return (
      <InlineNotice tone="error" className="mt-3 max-w-2xl">
        {run.error}
      </InlineNotice>
    )
  }
  if (!run.running || !run.phase) return null
  return (
    <p className="mt-3 flex items-center gap-2 text-meta text-[color:var(--text-muted)]">
      <Spinner />
      {RUN_PHASE_LABEL[run.phase]}
    </p>
  )
}

// Phase copy for the terminal guide (MC-1783). Exported: the guide's controls
// ride the door bar now, so the phase label renders beside them there.
// `reading` now covers getting the
// guide's terminal up with the run prompt, and `grouping` is the guide itself
// working in that terminal — the labels say so rather than describing a
// generation step this process no longer performs.
export const RUN_PHASE_LABEL: Record<string, string> = {
  reading: 'Starting the guide…',
  grouping: 'The guide is working on the walkthrough…',
  annotating: 'Checking the walkthrough…',
  writing: 'Saving the walkthrough…',
  done: 'Walkthrough ready',
  failed: 'The guide could not finish',
}

export default ReviewCanvas
