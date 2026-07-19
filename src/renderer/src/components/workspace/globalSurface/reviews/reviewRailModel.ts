import type { ReviewIndexEntry } from '../../../../../../shared/electron-api'
import type { Tone } from '../../../ui/tokens'

// Pure projections for the Reviews-door rail (MC-1708 T6, mockup §4). Each review
// in the instance index becomes a rail row: a title, a one-line state ("multicode
// · 3 of 5 files read", "posted", "draft") and a single status dot. No React, no
// IPC — the rail rows and their tones derive here so a fixed index produces a
// deterministic rail and the state-line rules are unit-testable on their own.

export type ReviewRailStatus = 'draft' | 'in-progress' | 'posted'

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
    return { ...base, status: 'draft', tone: 'neutral', stateLine: `${entry.projectName} · draft`, dotLabel: 'Draft — no walkthrough yet' }
  }
  if (entry.postedComments > 0 && entry.pendingComments === 0) {
    return { ...base, status: 'posted', tone: 'good', stateLine: `${entry.projectName} · posted`, dotLabel: 'Posted to the pull request' }
  }
  return {
    ...base,
    status: 'in-progress',
    tone: 'accent',
    stateLine: `${entry.projectName} · ${readProgressLabel(entry)}`,
    dotLabel: 'In progress',
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
