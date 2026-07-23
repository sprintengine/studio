import type { ReviewIndexEntry } from '../../../../../../shared/electron-api'
import { REVIEW_STATE_PRESENTATION } from '../../../../../../shared/review/review-state'
import { GhostButton, PrimaryButton } from '../../../ui/Buttons'
import { SegmentedControl } from '../../../ui/SegmentedControl'
import { statsChip, sourceIdentity } from '../../../panels/review/reviewSelectors'
import { hasPostedComments } from '../../../panels/review/commentModel'
import type { GlobalSurfaceBar } from '../GlobalSurfaceShell'
import { BarStatusChip } from '../surfaceSubstrate'
import type { ReviewSession } from '../../../panels/review/useReviewSession'

// The folded Reviews-door surface bar (MC-1708 T6, mockup §4). The walkthrough's
// own top-bar actions live here instead of stacking a second bar over the canvas:
// the change title, an In progress / Posted status dot, the "repo · PR · +/−" sub,
// then the diff-view toggle, Re-run, Ask the guide, and the Post review CTA. The
// action cluster appears once there is a change to work — a guide walkthrough
// ('ready') or the raw degraded change (T1). In degraded mode the guide-only
// actions (Re-run, Ask the guide) drop, since no guide has run; the diff-view
// toggle and the review/post controls stay so a reviewer can read every diff and
// post to the PR without a brief.

const DIFF_VIEW_ITEMS = [
  { value: 'side-by-side' as const, label: 'Side by side' },
  { value: 'inline' as const, label: 'Inline' },
]

// Build the shell bar for the currently selected review. `entry` (when the review
// is already in the index) seeds the title and sub while the change set is still
// loading, so the bar never flashes empty; a just-created review not yet re-scanned
// passes null and leans on the session's change set alone.
export function buildReviewsSurfaceBar(entry: ReviewIndexEntry | null, session: ReviewSession): GlobalSurfaceBar {
  const changeset = session.changeset
  const title = changeset?.title ?? entry?.title ?? 'Review'
  const stats = changeset ? statsChip(changeset) : null
  return {
    title,
    statusChip: <ReviewStatusChip session={session} entry={entry} />,
    contextSub: changeset && stats ? (
      <span className="font-mono">
        {sourceIdentity(changeset)} · <span className="tabular-nums">{stats.files}</span>{' '}
        {stats.files === 1 ? 'file' : 'files'} ·{' '}
        <span className="tabular-nums text-[color:var(--tone-good)]">+{stats.additions}</span>{' '}
        <span className="tabular-nums text-[color:var(--tone-error)]">−{stats.deletions}</span>
      </span>
    ) : (
      entry?.projectName ?? undefined
    ),
    actions:
      session.status === 'ready' || session.status === 'degraded' ? (
        <ReviewBarActions session={session} />
      ) : undefined,
  }
}

function ReviewStatusChip({ session, entry }: { session: ReviewSession; entry: ReviewIndexEntry | null }) {
  // Live comments win over the (possibly stale) index once loaded, so the chip
  // flips to Posted the moment the batch resolves without waiting on a re-scan.
  const posted =
    session.changeset !== null
      ? hasPostedComments(session.comments) && session.pendingComments === 0
      : entry !== null && entry.postedComments > 0 && entry.pendingComments === 0
  const state = REVIEW_STATE_PRESENTATION[posted ? 'posted' : 'in-progress']
  return <BarStatusChip tone={state.tone} label={state.label} />
}

function ReviewBarActions({ session }: { session: ReviewSession }) {
  const pending = session.pendingComments
  const showPostCta = session.isPullRequest && pending > 0
  // Re-run and Ask the guide act on a guide walkthrough; with no guide (degraded)
  // there is nothing to re-run and no guide to ask, so they drop from the cluster.
  const guideActions = !session.isDegraded
  return (
    <>
      <SegmentedControl
        ariaLabel="Diff view"
        items={DIFF_VIEW_ITEMS}
        value={session.diffView}
        onChange={session.onSetDiffView}
        className="shrink-0"
      />
      {guideActions ? (
        <GhostButton onClick={session.refresh} disabled={session.run.running} className="shrink-0">
          <svg viewBox="0 0 16 16" className="icon-sm" fill="none" aria-hidden="true">
            <path
              d="M13 8a5 5 0 1 1-1.46-3.54M13 3v2.5h-2.5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {session.run.running ? 'Re-running…' : 'Re-run'}
        </GhostButton>
      ) : null}
      {guideActions ? (
        <GhostButton onClick={session.openAsk} className="shrink-0">
          <svg viewBox="0 0 16 16" className="icon-sm text-[color:var(--accent-primary)]" fill="currentColor" aria-hidden="true">
            <path d="M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6z" />
          </svg>
          Ask the guide
        </GhostButton>
      ) : null}
      {showPostCta ? (
        <PrimaryButton onClick={session.openTray} className="shrink-0">
          Post review<span className="tabular-nums"> · {pending} {pending === 1 ? 'comment' : 'comments'}</span>
        </PrimaryButton>
      ) : (
        <GhostButton onClick={session.openTray} className="shrink-0">
          Your review
          {pending > 0 ? <span className="font-medium tabular-nums text-[color:var(--accent-primary)]"> · {pending}</span> : null}
        </GhostButton>
      )}
    </>
  )
}
