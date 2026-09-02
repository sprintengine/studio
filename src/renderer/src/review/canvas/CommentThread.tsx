import { useState } from 'react'

import type { ReviewComment } from '../../../../shared/review'
import { GhostButton } from '../../components/ui/Buttons'
import { InlineNotice } from '../../components/ui/InlineNotice'
import { StatusDot } from '../../components/ui/StatusDot'
import { ZONE_CONTENT_INSET } from './annotationZones'
import { commentSyncChip, isCommentEditable } from './commentModel'
import { CommentComposer } from './CommentComposer'

// The sync status: one status idiom — the 6px status dot + short word, never a
// competing tinted pill. `context` adds the thread's "· will post to PR" tail;
// the tray shows the word bare.
export function CommentSyncBadge({ comment, context }: { comment: ReviewComment; context?: string }) {
  const chip = commentSyncChip(comment)
  return (
    <span className="inline-flex items-center gap-1.5 text-micro text-[color:var(--text-subtle)]">
      <StatusDot tone={chip.tone} />
      <span>
        {chip.label}
        {context ? <span className="text-[color:var(--text-subtle)]"> · {context}</span> : null}
      </span>
    </span>
  )
}

interface CommentThreadProps {
  comment: ReviewComment
  onEdit: (id: string, body: string) => void
  onDelete: (id: string) => void
}

// One comment's thread block under a diff line: "You" byline + sync status, then
// the body. While the comment is still local (pending / failed) it can be edited
// or deleted in place; once posted it is read-only here — it lives on the PR.
export function CommentThread({ comment, onEdit, onDelete }: CommentThreadProps) {
  const [editing, setEditing] = useState(false)
  const editable = isCommentEditable(comment)

  if (editing) {
    return (
      <CommentComposer
        submitLabel="Save"
        placeholder="Edit your comment…"
        initialBody={comment.body}
        onSubmit={(body) => {
          onEdit(comment.id, body)
          setEditing(false)
        }}
        onCancel={() => setEditing(false)}
      />
    )
  }

  return (
    <div className={`border-t border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] py-2.5 ${ZONE_CONTENT_INSET} pr-4`}>
      <div className="mb-1 flex items-center gap-2">
        {/* No avatar: it said "You" beside a label that already says "You". */}
        <span className="text-micro font-medium text-[color:var(--text-strong)]">You</span>
        <CommentSyncBadge comment={comment} context={comment.sync.state === 'pending' ? 'will post to PR' : undefined} />
      </div>
      <p className="max-w-[72ch] whitespace-pre-wrap text-body leading-5 text-[color:var(--text-default)]">
        {comment.body}
      </p>
      {/* A failed post is the shared error card, never red ink alone: the glyph
          and the role carry the failure, and the recovery — Edit, Delete, or
          posting the review again from the tray — is right here. */}
      {comment.sync.state === 'failed' ? (
        <InlineNotice tone="error" className="mt-1.5 max-w-[72ch]">
          {comment.sync.error}
        </InlineNotice>
      ) : null}
      {editable ? (
        <div className="mt-1.5 flex gap-1">
          <GhostButton onClick={() => setEditing(true)}>Edit</GhostButton>
          <GhostButton onClick={() => onDelete(comment.id)}>Delete</GhostButton>
        </div>
      ) : null}
    </div>
  )
}

export default CommentThread
