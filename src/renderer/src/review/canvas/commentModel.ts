// Pure model for the human's review comments. Comments live in
// ReviewWorkspaceState.comments (mutable reviewer state, OUTSIDE the immutable
// brief) so a guide re-run never loses them. Every mutation here is a plain,
// deterministic array transform — no React, no IPC, no clock — so the container
// supplies ids/timestamps and these stay unit-testable. The guide never calls
// any of this; comments only enter state through the composer's create action.

import type { ReviewAnchor, ReviewChangeSet, ReviewComment } from '../../../../shared/review'
import type { ReviewCommentPostOutcome } from '../../../../shared/electron-api'
import { anchorRangeLabel } from './anchorLabel'

// A comment is the reviewer's to edit or delete only while it is still local —
// once it has posted (or is posting) it lives on the pull request and is
// read-only here. A failed post stays local, so it is editable again for a retry.
export function isCommentEditable(comment: ReviewComment): boolean {
  return comment.sync.state === 'pending' || comment.sync.state === 'failed'
}

// Build a fresh pending comment. The caller owns identity and the clock so this
// stays pure: `id` (e.g. crypto.randomUUID()) and `createdAt` (ISO-8601) come in
// from the composer action. `anchoredAtSha` records the head the anchor was
// drawn against, so freshness re-runs (MC-1682) can re-project it.
export function newReviewComment(input: {
  id: string
  path: string
  anchor: ReviewAnchor
  body: string
  createdAt: string
  headSha?: string
}): ReviewComment {
  const anchor: ReviewAnchor = input.headSha
    ? { ...input.anchor, anchoredAtSha: input.headSha }
    : { ...input.anchor }
  return {
    id: input.id,
    path: input.path,
    anchor,
    body: input.body,
    createdAt: input.createdAt,
    sync: { state: 'pending' },
  }
}

export function addComment(comments: ReviewComment[], comment: ReviewComment): ReviewComment[] {
  return [...comments, comment]
}

// Edit is a no-op on a non-editable (posted/posting) comment — the guard keeps a
// stale UI from silently rewriting a comment that already lives on the PR.
export function editComment(comments: ReviewComment[], id: string, body: string): ReviewComment[] {
  return comments.map((comment) =>
    comment.id === id && isCommentEditable(comment) ? { ...comment, body } : comment,
  )
}

// Delete only removes an editable comment; a posted comment is not the local
// review's to drop (it is on the PR).
export function deleteComment(comments: ReviewComment[], id: string): ReviewComment[] {
  return comments.filter((comment) => !(comment.id === id && isCommentEditable(comment)))
}

export function commentsForFile(comments: ReviewComment[], path: string): ReviewComment[] {
  return comments.filter((comment) => comment.path === path)
}

// The comments that would post as the pending review: everything not already on
// the PR (pending, and failed retries). Drives the tray count and post label.
export function postableComments(comments: ReviewComment[]): ReviewComment[] {
  return comments.filter((comment) => comment.sync.state === 'pending' || comment.sync.state === 'failed')
}

export function pendingCommentCount(comments: ReviewComment[]): number {
  return postableComments(comments).length
}

// Whether the tray should offer Post: a pull-request source with at least one
// comment that would post (pending / failed retry). Branch/patch have no remote.
export function canPostReview(changeset: ReviewChangeSet, comments: ReviewComment[]): boolean {
  return isPullRequestReviewSource(changeset) && pendingCommentCount(comments) > 0
}

// Whether anything has already landed on the PR — drives the tray's settled
// "Posted" state once every comment has posted and nothing is left to send.
export function hasPostedComments(comments: ReviewComment[]): boolean {
  return comments.some((comment) => comment.sync.state === 'posted')
}

// ── Post-batch state transitions (MC-1683 wiring) ──────────────────────────────
// Pure transforms applied to the workspace-state comment list around a post. Each
// starts from the same pre-post snapshot, so the optimistic flip and the final
// apply never compound: the outcomes are authoritative over the original list.

// Optimistic flip: every postable comment shows "Posting…" while the batch is in
// flight. Only pending/failed comments move; posted ones are already on the PR.
export function markCommentsPosting(comments: ReviewComment[]): ReviewComment[] {
  return comments.map((comment) =>
    comment.sync.state === 'pending' || comment.sync.state === 'failed'
      ? { ...comment, sync: { state: 'posting' } }
      : comment,
  )
}

// Apply a successful batch's per-comment outcomes. Each outcome flips its comment
// to the returned sync state; `anchorStatus: 'moved'` marks a held comment (kept
// pending, never posted to a guessed line). A comment with no outcome (already
// posted, or not in the batch) is left untouched, and a prior 'moved' flag is
// cleared unless the outcome re-sets it.
export function applyPostOutcomes(
  comments: ReviewComment[],
  outcomes: ReviewCommentPostOutcome[],
): ReviewComment[] {
  const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]))
  return comments.map((comment) => {
    const outcome = byId.get(comment.id)
    if (!outcome) return comment
    const { anchorStatus: _prior, ...rest } = comment
    return outcome.anchorStatus
      ? { ...rest, sync: outcome.sync, anchorStatus: outcome.anchorStatus }
      : { ...rest, sync: outcome.sync }
  })
}

// A whole-batch failure (auth/transport/not-a-PR): GitHub's create-review is
// atomic, so nothing posted. Scoped to `postedIds` — the exact comments this post
// sent — so each flips to a retryable 'failed' carrying the error and stays
// editable, while a comment composed while the post was in flight is not in the
// batch and keeps its own state. Symmetric with applyPostOutcomes' id merge.
export function applyPostFailure(
  comments: ReviewComment[],
  postedIds: readonly string[],
  error: string,
): ReviewComment[] {
  const batch = new Set(postedIds)
  return comments.map((comment) =>
    batch.has(comment.id) ? { ...comment, sync: { state: 'failed', error } } : comment,
  )
}

export type CommentSyncTone = 'neutral' | 'good' | 'error'

export interface CommentSyncChip {
  label: string
  tone: CommentSyncTone
}

// One status idiom per the design bar: a short word, no competing pill copy. The
// thread adds "· will post to PR" context around this; the tray shows it bare.
export function commentSyncChip(comment: ReviewComment): CommentSyncChip {
  switch (comment.sync.state) {
    case 'posted':
      return { label: 'Posted', tone: 'good' }
    case 'posting':
      return { label: 'Posting…', tone: 'neutral' }
    case 'failed':
      return { label: 'Failed', tone: 'error' }
    case 'pending':
    default:
      return { label: 'Pending', tone: 'neutral' }
  }
}

// Human location: `path · L37` / `path · L63–66`, matching the anchor label the
// annotations use so a line range reads the same everywhere.
export function commentLocationLabel(comment: ReviewComment): string {
  return `${comment.path} · ${anchorRangeLabel(comment.anchor)}`
}

// A copy-paste line reference for the markdown export: colon form (`path:L37`)
// that reads as a location in any PR UI or editor.
export function commentCitation(comment: ReviewComment): string {
  const { anchor } = comment
  const lines = anchor.startLine === anchor.endLine ? `L${anchor.startLine}` : `L${anchor.startLine}-${anchor.endLine}`
  return `${comment.path}:${lines}`
}

// Copy-as-markdown: the escape hatch that works for branch/patch sources with no
// PR. One `path:line` code span per comment followed by its body, blocks
// separated by a blank line — suitable for pasting into any review UI.
export function commentsToMarkdown(comments: ReviewComment[]): string {
  return comments
    .map((comment) => `\`${commentCitation(comment)}\`\n${comment.body.trim()}`)
    .join('\n\n')
}

// Only pull-request sources can post a review; branch and patch reviews have no
// remote, so the tray shows Copy-as-markdown as the only export for those.
export function isPullRequestReviewSource(changeset: ReviewChangeSet): boolean {
  return changeset.source.kind === 'pull-request'
}

// "owner/repo #number" for the tray's "posts as you · one review on …" note.
// Null for non-PR sources.
export function pullRequestLabel(changeset: ReviewChangeSet): string | null {
  const { source } = changeset
  return source.kind === 'pull-request' ? `${source.owner}/${source.repo} #${source.number}` : null
}
