import type { ReactNode } from 'react'

import type { ReviewChangeSet } from '../../../../../shared/review'
import { InlineNotice } from '../../ui/InlineNotice'
import { PrimaryButton } from '../../ui/Buttons'
import { Spinner } from '../../ui/Spinner'
import { ReviewWalkthrough } from './ReviewWalkthrough'
import { FreshnessBanner } from './FreshnessBanner'
import { isPullRequestReviewSource } from './commentModel'
import { sourceIdentity } from './reviewSelectors'
import type { ReviewRunProgress, ReviewSession } from './useReviewSession'

// The Reviews-door canvas (MC-1708 T6): the selected review's walkthrough, minus
// its own top bar (the folded surface bar carries those actions). It renders the
// same honest load ladder the retired `ReviewPanel` did — loading, unreadable
// change set, no change yet, an invalid walkthrough, the prepare invitation, and
// the walkthrough itself — driven entirely by a `ReviewSession`. All the state,
// IPC, and mutation live in `useReviewSession`; this is the pure view, so it
// renders deterministically from a session object with no side effects of its own.
export function ReviewCanvas({ session }: { session: ReviewSession }): JSX.Element {
  const { status, changeset, run } = session

  if (status === 'idle' || status === 'loading') {
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
        <div className="mt-3">
          <PrimaryButton onClick={session.startRun} disabled={run.running}>
            {run.running ? 'Preparing…' : 'Try again'}
          </PrimaryButton>
        </div>
        <RunLine run={run} />
      </PrepareShell>
    )
  }

  if (status === 'prepare') {
    const preparing = run.running
    return (
      <PrepareShell changeset={changeset}>
        <p className="max-w-xl text-[13px] leading-6 text-[color:var(--text-muted)]">
          The guide hasn’t walked this change yet. Prepare the walkthrough to group the files into steps ordered for
          understanding, with a short note on why each one changed.
        </p>
        <div className="mt-3">
          <PrimaryButton onClick={session.startRun} disabled={preparing}>
            {preparing ? 'Preparing…' : 'Prepare walkthrough'}
          </PrimaryButton>
        </div>
        <RunLine run={run} />
      </PrepareShell>
    )
  }

  // status === 'ready' — the brief is present.
  const brief = session.brief
  if (!brief) {
    return (
      <CenteredState>
        <Spinner /> <span className="ml-2">Loading the walkthrough…</span>
      </CenteredState>
    )
  }

  const bannerSlot = session.bannerModel ? (
    <FreshnessBanner model={session.bannerModel} refreshing={run.running} refreshPhase={run.phase} onRefresh={session.refresh} />
  ) : null

  return (
    <ReviewWalkthrough
      changeset={changeset}
      brief={brief}
      readFiles={session.readFiles}
      diffView={session.diffView}
      activePaneId={session.activePaneId}
      monacoTheme={session.monacoTheme}
      rerunning={run.running}
      onSetActivePane={session.onSetActivePane}
      onSetDiffView={session.onSetDiffView}
      onToggleRead={session.onToggleRead}
      onRequestComment={NOOP}
      onAskGuide={NOOP}
      onRerun={session.refresh}
      bannerSlot={bannerSlot}
      comments={session.comments}
      onCreateComment={session.onCreateComment}
      onEditComment={session.onEditComment}
      onDeleteComment={session.onDeleteComment}
      onPostReview={isPullRequestReviewSource(changeset) ? session.onPostReview : undefined}
      postState={session.postState}
      workspaceId={session.reviewId ?? undefined}
      workspaceRoot={session.workspaceRoot ?? undefined}
      hideTopBar
      trayController={session.trayController}
      chatController={session.chatController}
    />
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

const RUN_PHASE_LABEL: Record<string, string> = {
  reading: 'Reading the change…',
  grouping: 'Grouping the change into steps…',
  annotating: 'Checking the walkthrough…',
  writing: 'Saving the walkthrough…',
  done: 'Walkthrough ready',
  failed: 'The guide could not finish',
}

export default ReviewCanvas
