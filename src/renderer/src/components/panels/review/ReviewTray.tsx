import { useState } from 'react'

import type { ReviewChangeSet, ReviewComment } from '../../../../../shared/review'
import { PrimaryButton, GhostButton } from '../../ui/Buttons'
import {
  commentLocationLabel,
  commentsToMarkdown,
  hasPostedComments,
  isPullRequestReviewSource,
  pendingCommentCount,
  pullRequestLabel,
} from './commentModel'
import { CommentSyncBadge } from './CommentThread'

// The container owns the async post; the tray only renders its phase and calls
// back. 'error' carries the whole-batch failure copy (nothing posted).
export type ReviewPostPhase = { phase: 'idle' | 'posting' | 'error'; error?: string }

interface ReviewTrayProps {
  comments: ReviewComment[]
  changeset: ReviewChangeSet
  // Present only for pull-request sources the container can post (MC-1683). Absent
  // (branch/patch, or the read-only fixture harness) leaves Copy-as-markdown alone.
  onPost?: () => void
  postState?: ReviewPostPhase
}

// "Your review" — the pending-review tray: one row per comment, a Copy-as-markdown
// escape hatch that works for any source, and the Post action. For a pull-request
// source with pending comments the button posts them as one review under the
// reviewer's account; it shows posting / posted / failed as the batch resolves.
// Non-PR sources (branch / patch) have no remote, so they get Copy-as-markdown alone.
export function ReviewTray({ comments, changeset, onPost, postState }: ReviewTrayProps) {
  const [copied, setCopied] = useState(false)
  const pending = pendingCommentCount(comments)
  const isPr = isPullRequestReviewSource(changeset)
  const prLabel = pullRequestLabel(changeset)
  const posting = postState?.phase === 'posting'
  const postError = postState?.phase === 'error' ? postState.error : undefined
  // The button can post only when the container wired onPost and there is work to
  // send. Once everything has posted it settles to a disabled "Posted".
  const canPost = Boolean(onPost) && isPr && pending > 0 && !posting
  const settled = isPr && pending === 0 && hasPostedComments(comments)

  const copyMarkdown = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(commentsToMarkdown(comments))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard denied — leave the label unchanged rather than claim success.
    }
  }

  if (comments.length === 0) {
    return (
      <p className="px-1 py-2 text-[12px] leading-5 text-[color:var(--text-subtle)]">
        No comments yet. Hover any line in the walkthrough — added or removed — and click <span className="font-medium text-[color:var(--accent-primary)]">+</span> to leave one; they collect here as one review.
      </p>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {comments.map((comment) => (
          <div
            key={comment.id}
            className="flex gap-3 border-b border-[color:var(--border-subtle)] py-3 last:border-b-0"
          >
            <span
              className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[color:var(--bg-active)] text-[8.5px] font-semibold text-[color:var(--text-muted)]"
              aria-hidden="true"
            >
              You
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-mono text-[11px] text-[color:var(--text-subtle)]">
                  {commentLocationLabel(comment)}
                </span>
                <CommentSyncBadge comment={comment} />
              </div>
              <p className="mt-0.5 max-w-[76ch] whitespace-pre-wrap text-[12px] leading-5 text-[color:var(--text-default)]">
                {comment.body}
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 border-t border-[color:var(--border-subtle)] pt-3">
        <p className="mb-2 text-[11px] leading-4 text-[color:var(--text-subtle)]">
          {isPr && prLabel
            ? `Posts as you · one review on ${prLabel}`
            : 'No pull request to post to — copy the comments to paste anywhere.'}
        </p>
        <div className="flex items-center gap-2">
          <GhostButton onClick={copyMarkdown} disabled={comments.length === 0}>
            {copied ? 'Copied' : 'Copy as markdown'}
          </GhostButton>
          {isPr ? (
            settled ? (
              <PrimaryButton disabled>Posted</PrimaryButton>
            ) : (
              <PrimaryButton onClick={onPost} disabled={!canPost}>
                {posting
                  ? 'Posting…'
                  : `Post ${pending} ${pending === 1 ? 'comment' : 'comments'} to pull request`}
              </PrimaryButton>
            )
          ) : null}
        </div>
        {postError ? (
          <p className="mt-1.5 text-[11px] leading-4 text-[color:var(--tone-error)]">{postError}</p>
        ) : null}
      </div>
    </div>
  )
}

export default ReviewTray
