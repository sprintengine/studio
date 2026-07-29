import type { ReviewIndexEntry } from '../../../../../../shared/electron-api'
import { REVIEW_STATE_PRESENTATION } from '../../../../../../shared/review/review-state'
import { GhostButton, PrimaryButton } from '../../../ui/Buttons'
import { SegmentedControl } from '../../../ui/SegmentedControl'
import { Spinner } from '../../../ui/Spinner'
import { statsChip, sourceIdentity } from '../../../panels/review/reviewSelectors'
import { hasPostedComments } from '../../../panels/review/commentModel'
import type { GlobalSurfaceBar } from '../GlobalSurfaceShell'
import { BarStatusChip } from '../surfaceSubstrate'
import type { ReviewSession } from '../../../panels/review/useReviewSession'
import { StopGuideRunButton } from './ReviewGuideStop'

// The folded Reviews-door surface bar (MC-1708 T6, mockup §4). The bar stays
// informational plus the ONE primary action — the change title, an In progress /
// Posted status dot, the "repo · PR · +/−" sub, and the Your review / Post
// review CTA. The working tools (diff-view toggle, Re-run, Ask the guide) are a
// canvas toolbar (`ReviewCanvasTools`), not title-bar chrome: they act on the
// walkthrough below, so they live with it. The CTA appears once there is a
// change to work — a guide walkthrough ('ready') or the raw degraded change
// (T1). In degraded mode the guide-only tools (Re-run, Ask the guide) drop,
// since no guide has run; the diff-view toggle and the review/post controls stay
// so a reviewer can read every diff and post to the PR without a brief.

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
  return showPostCta ? (
    <PrimaryButton onClick={session.openTray} className="shrink-0">
      Post review<span className="tabular-nums"> · {pending} {pending === 1 ? 'comment' : 'comments'}</span>
    </PrimaryButton>
  ) : (
    <GhostButton onClick={session.openTray} className="shrink-0">
      Your review
      {pending > 0 ? <span className="font-medium tabular-nums text-[color:var(--accent-primary)]"> · {pending}</span> : null}
    </GhostButton>
  )
}

// The canvas tools that act on the walkthrough below, handed to ReviewCanvas as
// its `toolbar` slot. These are CONTROLS, not a row: the canvas owns the single
// chrome row they sit in and folds the guide's status line into that same row, so
// the walkthrough never carries a tools bar stacked on top of a status bar. Re-run
// and Ask the guide act on a guide walkthrough; with no guide (degraded) there is
// nothing to re-run and no guide to ask, so they drop and the diff-view toggle
// stands alone.
//
// While a re-run is in flight (MC-1804) the Re-run button is replaced by the live
// line plus Stop, rather than the disabled "Re-running…" button it used to become:
// with the walkthrough on screen this row is the only place the run is visible, so
// a disabled button was both the sole progress signal and the reason there was no
// way out of a runaway run.
export function ReviewCanvasTools({ session }: { session: ReviewSession }): JSX.Element {
  const guideActions = !session.isDegraded
  const running = session.run.running
  return (
    <span className="flex flex-wrap items-center justify-end gap-1.5">
      <SegmentedControl
        ariaLabel="Diff view"
        items={DIFF_VIEW_ITEMS}
        value={session.diffView}
        onChange={session.onSetDiffView}
        className="shrink-0"
      />
      {!guideActions ? null : running ? (
        <>
          <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-[color:var(--text-muted)]">
            <Spinner />
            Re-running…
          </span>
          <StopGuideRunButton session={session} />
        </>
      ) : (
        <GhostButton onClick={session.refresh} className="shrink-0">
          <svg viewBox="0 0 16 16" className="icon-sm" fill="none" aria-hidden="true">
            <path
              d="M13 8a5 5 0 1 1-1.46-3.54M13 3v2.5h-2.5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Re-run
        </GhostButton>
      )}
      {guideActions ? (
        <GhostButton onClick={session.openAsk} className="shrink-0">
          <svg viewBox="0 0 16 16" className="icon-sm text-[color:var(--accent-primary)]" fill="currentColor" aria-hidden="true">
            <path d="M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6z" />
          </svg>
          Ask the guide
        </GhostButton>
      ) : null}
    </span>
  )
}
