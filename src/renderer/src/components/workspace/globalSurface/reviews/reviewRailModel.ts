import type { ReviewIndexEntry } from '../../../../../../shared/electron-api'
import { REVIEW_STATE_PRESENTATION, type ReviewProgressState } from '../../../../../../shared/review/review-state'
import type { LastSelectedReview } from '../../../../types/workspace'
import type { Tone } from '../../../ui/tokens'

// Pure projections for the Reviews-door rail (MC-1708 T6, mockup §4). Each review
// in the instance index becomes a rail row: a title, a one-line state ("multicode
// · 3 of 5 files read", "posted", "draft") and a single status dot. No React, no
// IPC — the rail rows and their tones derive here so a fixed index produces a
// deterministic rail and the state-line rules are unit-testable on their own.

export type ReviewRailStatus = ReviewProgressState

export interface ReviewRailRow {
  reviewId: string
  workspaceRoot: string
  title: string
  status: ReviewRailStatus
  stateLine: string
  tone: Tone
  dotLabel: string
}

// One review's status + state line. Precedence, matching the mockup's three rail
// states: a review with no walkthrough yet is a draft; a review whose comments are
// all posted (and none pending) reads as posted; anything else is in progress and
// shows its reading progress. Read counts are clamped to the changed-file universe
// so a stale path in the reviewer's read list can never push it past the total.
export function reviewRailRow(entry: ReviewIndexEntry): ReviewRailRow {
  const base = { reviewId: entry.reviewId, workspaceRoot: entry.workspaceRoot, title: entry.title }
  if (!entry.hasWalkthrough) {
    const p = REVIEW_STATE_PRESENTATION.draft
    return { ...base, status: 'draft', tone: p.tone, stateLine: `${entry.projectName} · draft`, dotLabel: p.dotLabel }
  }
  if (entry.postedComments > 0 && entry.pendingComments === 0) {
    const p = REVIEW_STATE_PRESENTATION.posted
    return { ...base, status: 'posted', tone: p.tone, stateLine: `${entry.projectName} · posted`, dotLabel: p.dotLabel }
  }
  const p = REVIEW_STATE_PRESENTATION['in-progress']
  return {
    ...base,
    status: 'in-progress',
    tone: p.tone,
    stateLine: `${entry.projectName} · ${readProgressLabel(entry)}`,
    dotLabel: p.dotLabel,
  }
}

function readProgressLabel(entry: ReviewIndexEntry): string {
  const total = entry.fileCount
  if (total === 0) return 'no files'
  const read = Math.min(Math.max(entry.readFileCount, 0), total)
  if (read >= total) return 'all files read'
  return `${read} of ${total} files read`
}

// Rail order (mockup §4): in-progress first (the reviews asking for attention),
// then drafts, then posted (done). Reviews within a bucket keep the index order —
// the caller passes a stable enumeration, so ties never reshuffle between renders.
const STATUS_ORDER: Record<ReviewRailStatus, number> = { 'in-progress': 0, draft: 1, posted: 2 }

export function orderReviewRail(entries: ReviewIndexEntry[]): ReviewRailRow[] {
  return entries
    .map((entry, index) => ({ row: reviewRailRow(entry), index }))
    .sort((a, b) => STATUS_ORDER[a.row.status] - STATUS_ORDER[b.row.status] || a.index - b.index)
    .map((wrapped) => wrapped.row)
}

export interface ReviewAutoSelectDecision {
  /** The review the door should open, or null when the index holds none. */
  select: LastSelectedReview | null
  /** True when `remembered` named a review this index does not have, so the
   *  stored preference is dead and must be cleared. */
  clearRemembered: boolean
}

// Which review a freshly loaded door opens when the reviewer has not chosen one
// this session (MC-1785). The remembered review wins while it is still in the
// index. Matched on the WHOLE {reviewId, workspaceRoot} pair — not the id alone
// — because that pair is the review's stored identity and the key
// `useReviewSession` loads by, so a review dir copied into another checkout
// restores against the project it was actually remembered in. (Ids are
// `rv_<uuid>`, so this is about resolving to the right checkout, not collisions.)
// A remembered review the index does not have was deleted externally: the door
// falls back to the first (attention-ordered) row and reports that the dead
// preference should be cleared, so it can never pin a review that is gone.
export function resolveReviewAutoSelect(
  entries: readonly ReviewIndexEntry[],
  rows: readonly ReviewRailRow[],
  remembered: LastSelectedReview | null,
): ReviewAutoSelectDecision {
  const match = remembered
    ? entries.find(
        (entry) =>
          entry.reviewId === remembered.reviewId && entry.workspaceRoot === remembered.workspaceRoot,
      )
    : undefined
  if (match) {
    return {
      select: { reviewId: match.reviewId, workspaceRoot: match.workspaceRoot },
      clearRemembered: false,
    }
  }
  const first = rows[0]
  return {
    select: first ? { reviewId: first.reviewId, workspaceRoot: first.workspaceRoot } : null,
    clearRemembered: remembered !== null,
  }
}
