import { ActionStatusChip, type ActionStatus } from '../../ui/ActionFeedback'
import { DefinitionList, FOCUS_RING_CLASS, GhostButton, PrimaryButton, Select, StatusDot, type Tone } from '../../ui'
import { CommentIcon, PriorityIcon, SpecialistActionIcon } from '../../AppIcons'
import type { SwitchboardTaskRecord } from '../../../../../shared/switchboard'
import { confidenceLabel, confidenceToneClass, formatRelativeTime, priorityLabel, shortIdentifier, sourceLabel } from '../../../utils/switchboardBoard'
import type { DraftTask } from './types'
import { latestTriageComment, parseTriageImportance } from './types'

export function DetailPane({
  record,
  editing,
  editForm,
  onEditFormChange,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onPromote,
  onCancelTask,
  onTriageTask,
  onOpenFile,
  loadingFile,
  fileError,
  onDismissFileError,
  commentBody,
  onCommentChange,
  onAddComment,
  isEditing,
  isPromoting,
  isCanceling,
  isTriaging,
  isCommenting,
  detailStatus,
  commentStatus,
  onDismissDetailStatus,
  onDismissCommentStatus,
}: {
  record: SwitchboardTaskRecord
  editing: boolean
  editForm: DraftTask
  onEditFormChange: (next: DraftTask) => void
  onStartEdit: () => void
  onCancelEdit: () => void
  onSaveEdit: () => void
  onPromote: () => void
  onCancelTask: () => void
  onTriageTask: () => void
  onOpenFile: () => void
  loadingFile: boolean
  fileError: string | null
  onDismissFileError: () => void
  commentBody: string
  onCommentChange: (next: string) => void
  onAddComment: () => void
  isEditing: boolean
  isPromoting: boolean
  isCanceling: boolean
  isTriaging: boolean
  isCommenting: boolean
  detailStatus: ActionStatus | null
  commentStatus: ActionStatus | null
  onDismissDetailStatus: () => void
  onDismissCommentStatus: () => void
}) {
  const task = record.task
  const triageComment = latestTriageComment(record)
  const triageImportance = parseTriageImportance(triageComment)
  const triageTone: Tone =
    triageImportance === 'critical' ? 'error' :
    triageImportance === 'high' ? 'warn' :
    triageImportance === 'medium' ? 'neutral' :
    'neutral'
  const anyDetailMutation = isEditing || isPromoting || isCanceling || isTriaging
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[color:var(--border-default)] px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-micro text-[color:var(--text-muted)]">
            <span className="font-mono tabular-nums text-meta text-[color:var(--text-default)]">
              {shortIdentifier(record)}
            </span>
            <span aria-hidden="true">·</span>
            <span>Inbox</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{formatRelativeTime(task.createdAt)}</span>
          </div>
          {editing ? (
            <input
              value={editForm.title}
              onChange={(event) => onEditFormChange({ ...editForm, title: event.target.value })}
              className={`mt-2 block w-full bg-transparent text-title font-semibold text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
            />
          ) : (
            <h3 className="mt-2 text-title font-semibold leading-5 text-[color:var(--text-strong)]">
              {task.title}
            </h3>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {detailStatus ? (
            <ActionStatusChip
              status={detailStatus}
              onDismiss={detailStatus.tone === 'error' ? onDismissDetailStatus : undefined}
            />
          ) : null}
          {fileError ? (
            <ActionStatusChip
              status={{ tone: 'error', message: fileError, nonce: 0 }}
              onDismiss={onDismissFileError}
            />
          ) : null}
          {editing ? (
            <>
              <GhostButton onClick={onCancelEdit} disabled={isEditing}>
                Cancel
              </GhostButton>
              <PrimaryButton onClick={onSaveEdit} disabled={isEditing}>
                {isEditing ? 'Saving…' : 'Save'}
              </PrimaryButton>
            </>
          ) : (
            <>
              <GhostButton onClick={onOpenFile} disabled={anyDetailMutation || loadingFile}>
                {loadingFile ? 'Opening…' : 'View file'}
              </GhostButton>
              <GhostButton onClick={onStartEdit} disabled={anyDetailMutation}>
                Edit
              </GhostButton>
              <GhostButton onClick={onCancelTask} disabled={anyDetailMutation}>
                {isCanceling ? 'Canceling…' : 'Cancel task'}
              </GhostButton>
              <GhostButton onClick={onTriageTask} disabled={anyDetailMutation}>
                {isTriaging ? 'Starting…' : 'Triage task'}
              </GhostButton>
              <PrimaryButton onClick={onPromote} disabled={anyDetailMutation}>
                {isPromoting ? 'Promoting…' : 'Promote to Switchboard'}
              </PrimaryButton>
            </>
          )}
        </div>
      </header>

      {record.warnings.length > 0 ? (
        <div className="border-b border-[color:var(--border-default)] bg-[color:var(--tone-warn-soft)] px-5 py-2 text-meta leading-5 text-[color:var(--tone-warn)]">
          {record.warnings.map((warning, idx) => (
            <div key={idx}>{warning}</div>
          ))}
        </div>
      ) : null}

      <div className="flex-1 overflow-auto px-5 py-4">
        <DefinitionList
          layout="two-column"
          items={[
            {
              term: 'Identifier',
              description: editing ? (
                <input
                  value={editForm.identifier}
                  onChange={(event) => onEditFormChange({ ...editForm, identifier: event.target.value })}
                  className="block w-48 rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-2 py-1 font-mono tabular-nums text-meta text-[color:var(--text-strong)]"
                />
              ) : (
                <span className="font-mono tabular-nums">{task.identifier}</span>
              ),
            },
            {
              term: 'Priority',
              description: editing ? (
                <Select<string>
                  ariaLabel="Task priority"
                  items={[
                    { value: '', label: 'No priority' },
                    { value: '0', label: 'Urgent' },
                    { value: '1', label: 'High' },
                    { value: '2', label: 'Medium' },
                    { value: '3', label: 'Low' },
                  ]}
                  value={editForm.priority == null ? '' : String(editForm.priority)}
                  onChange={(value) => onEditFormChange({ ...editForm, priority: value === '' ? null : Number(value) })}
                />
              ) : (
                <span className="flex items-center gap-2">
                  <PriorityIcon priority={task.priority} className="h-3.5 w-3.5 shrink-0 text-[color:var(--text-muted)]" />
                  {priorityLabel(task.priority)}
                </span>
              ),
            },
            {
              term: 'Labels',
              description: editing ? (
                <input
                  value={editForm.labels}
                  onChange={(event) => onEditFormChange({ ...editForm, labels: event.target.value })}
                  placeholder="bug, auth"
                  className="block w-full max-w-md rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-2 py-1 text-meta text-[color:var(--text-strong)]"
                />
              ) : task.labels.length > 0 ? (
                <span className="flex flex-wrap gap-1.5">{task.labels.join(' · ')}</span>
              ) : (
                <span className="text-[color:var(--text-muted)]">None</span>
              ),
            },
            {
              term: 'Source',
              description: sourceLabel(record),
            },
            ...(typeof task.creationConfidencePct === 'number'
              ? [{
                  term: 'Legitimacy confidence',
                  description: <ConfidenceChip value={task.creationConfidencePct} />,
                }]
              : []),
            {
              term: 'Created',
              description: <span className="tabular-nums text-[color:var(--text-muted)]">{task.createdAt}</span>,
            },
          ]}
        />

        {triageComment ? (
          <div className="mt-4 rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-meta font-semibold text-[color:var(--text-strong)]">
                <SpecialistActionIcon icon="architecture" className="h-3.5 w-3.5 text-[color:var(--text-muted)]" />
                Architect triage
              </span>
              <span className="inline-flex items-center gap-1.5 text-micro text-[color:var(--text-muted)]">
                <StatusDot tone={triageTone} />
                {triageImportance ?? 'Triaged'}
              </span>
              {typeof triageComment.confidencePct === 'number' ? (
                <ConfidenceChip value={triageComment.confidencePct} compact title="Triage confidence" />
              ) : null}
              <span className="ml-auto text-micro tabular-nums text-[color:var(--text-muted)]">
                {formatRelativeTime(triageComment.createdAt)}
              </span>
            </div>
            <div className="mt-2 whitespace-pre-wrap text-body leading-6 text-[color:var(--text-default)]">
              {triageComment.body}
            </div>
          </div>
        ) : null}

        <div className="mt-4 border-t border-[color:var(--border-default)] pt-4">
          <div className="mb-2 text-meta font-semibold text-[color:var(--text-strong)]">Description</div>
          {editing ? (
            <textarea
              value={editForm.description}
              onChange={(event) => onEditFormChange({ ...editForm, description: event.target.value })}
              className={`min-h-[140px] w-full rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] p-2 text-body leading-6 text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
            />
          ) : task.description.trim() ? (
            <div className="whitespace-pre-wrap text-body leading-6 text-[color:var(--text-default)]">
              {task.description}
            </div>
          ) : (
            <div className="text-meta text-[color:var(--text-muted)]">No description provided.</div>
          )}
        </div>

        <CommentsSection record={record} />
      </div>

      <footer className="border-t border-[color:var(--border-default)] px-5 py-3">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="watchtower-comment-input" className="block text-meta font-semibold text-[color:var(--text-strong)]">
            Add comment
          </label>
          {commentStatus ? (
            <ActionStatusChip
              status={commentStatus}
              onDismiss={commentStatus.tone === 'error' ? onDismissCommentStatus : undefined}
            />
          ) : null}
        </div>
        <div className="mt-2 flex gap-2">
          <textarea
            id="watchtower-comment-input"
            value={commentBody}
            onChange={(event) => onCommentChange(event.target.value)}
            placeholder="Note for triage, link a finding, or capture context..."
            rows={2}
            className={`min-h-[44px] flex-1 rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] p-2 text-body leading-6 text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
          />
          <PrimaryButton
            onClick={onAddComment}
            disabled={isCommenting || !commentBody.trim()}
            className="self-end !h-8"
          >
            {isCommenting ? 'Sending…' : 'Comment'}
          </PrimaryButton>
        </div>
      </footer>
    </div>
  )
}

function ConfidenceChip({ value, compact = false, title }: { value: number; compact?: boolean; title?: string }) {
  const label = confidenceLabel(value)
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-[5px] border px-1.5 py-0.5 font-medium tabular-nums ${confidenceToneClass(value)} ${
        compact ? 'text-micro' : 'text-micro'
      }`}
      title={title ? `${title}: ${label}` : label}
      aria-label={title ? `${title}: ${label}` : label}
    >
      {/* design-tokens-allow: decorative bullet inheriting the chip text color; not a status dot. */}
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {compact ? `${value}%` : label}
    </span>
  )
}

function CommentsSection({ record }: { record: SwitchboardTaskRecord }) {
  const comments = record.task.comments
  return (
    <div className="mt-4 border-t border-[color:var(--border-default)] pt-4">
      <div className="mb-2 flex items-baseline gap-1.5">
        <span className="text-meta font-semibold text-[color:var(--text-strong)]">Activity</span>
        <span className="tabular-nums text-micro text-[color:var(--text-muted)]">{comments.length}</span>
      </div>
      {comments.length === 0 ? (
        <div className="text-meta text-[color:var(--text-muted)]">No comments yet.</div>
      ) : (
        <ul className="space-y-3">
          {comments.map((comment) => (
            <li key={comment.id} className="border-l border-[color:var(--border-default)] pl-3">
              <div className="flex items-baseline gap-2 text-micro text-[color:var(--text-muted)]">
                <span className="font-medium text-[color:var(--text-default)]">
                  {comment.author.name ?? comment.author.type}
                </span>
                <span aria-hidden="true">·</span>
                <span>{comment.kind}</span>
                {typeof comment.confidencePct === 'number' ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <ConfidenceChip value={comment.confidencePct} compact />
                  </>
                ) : null}
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">{formatRelativeTime(comment.createdAt)}</span>
                {comment.kind === 'comment' ? (
                  <CommentIcon className="ml-1 h-3 w-3 shrink-0 text-[color:var(--text-muted)]" />
                ) : null}
              </div>
              <div className="mt-1 whitespace-pre-wrap text-body leading-6 text-[color:var(--text-default)]">
                {comment.body}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

