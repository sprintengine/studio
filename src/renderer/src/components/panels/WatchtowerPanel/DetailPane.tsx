import { ActionStatusChip, type ActionStatus } from '../../ui/ActionFeedback'
import { Badge, DefinitionList, GhostButton, Input, OverflowMenu, PanelHeader, PrimaryButton, Select, StatusDot, Textarea, type Tone } from '../../ui'
import { CommentIcon, PriorityIcon, SpecialistActionIcon } from '../../AppIcons'
import type { SwitchboardTaskRecord } from '../../../../../shared/switchboard'
import { confidenceLabel, confidenceTone, formatRelativeTime, priorityLabel, shortIdentifier, sourceLabel } from '../../../utils/switchboardBoard'
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
      {/* The identity row is the shared primitive, so this pane sits at the same
          height as the inbox beside it. It used to hand-roll the band at
          `px-5 py-4` with a `text-title` heading, and carried five buttons plus
          two status chips in the action cluster (2112). One promote action stays
          here; the rest are the overflow menu, the chips moved to a band of
          their own, and the edit form's Cancel/Save moved down to the form. */}
      <PanelHeader
        title={task.title}
        subtitle={`${shortIdentifier(record)} · Inbox · ${formatRelativeTime(task.createdAt)}`}
        primaryAction={
          editing ? undefined : (
            <PrimaryButton onClick={onPromote} disabled={anyDetailMutation}>
              {isPromoting ? 'Promoting…' : 'Promote to Switchboard'}
            </PrimaryButton>
          )
        }
        overflow={
          editing ? undefined : (
            <OverflowMenu
              ariaLabel="Task actions"
              items={[
                {
                  id: 'view-file',
                  label: loadingFile ? 'Opening…' : 'View file',
                  onSelect: onOpenFile,
                  disabled: anyDetailMutation || loadingFile,
                },
                {
                  id: 'edit',
                  label: 'Edit',
                  onSelect: onStartEdit,
                  disabled: anyDetailMutation,
                },
                {
                  id: 'triage',
                  label: isTriaging ? 'Starting…' : 'Triage task',
                  onSelect: onTriageTask,
                  disabled: anyDetailMutation,
                },
                { kind: 'separator', id: 'sep-destructive' },
                {
                  id: 'cancel-task',
                  label: isCanceling ? 'Canceling…' : 'Cancel task',
                  onSelect: onCancelTask,
                  disabled: anyDetailMutation,
                  destructive: true,
                },
              ]}
            />
          )
        }
      />

      {detailStatus || fileError ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[color:var(--border-default)] px-3 py-2">
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
        </div>
      ) : null}

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
            // The title is editable with the rest of the fields now that the
            // header is the shared identity row rather than a form control.
            ...(editing
              ? [{
                  term: 'Title',
                  description: (
                    <Input
                      value={editForm.title}
                      onChange={(event) => onEditFormChange({ ...editForm, title: event.target.value })}
                      aria-label="Task title"
                      className="max-w-md"
                    />
                  ),
                }]
              : []),
            {
              term: 'Identifier',
              description: editing ? (
                <Input
                  value={editForm.identifier}
                  onChange={(event) => onEditFormChange({ ...editForm, identifier: event.target.value })}
                  aria-label="Task identifier"
                  fullWidth={false}
                  className="w-48 font-mono tabular-nums"
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
                  <PriorityIcon priority={task.priority} className="size-icon-sm shrink-0 text-[color:var(--text-muted)]" />
                  {priorityLabel(task.priority)}
                </span>
              ),
            },
            {
              term: 'Labels',
              description: editing ? (
                <Input
                  value={editForm.labels}
                  onChange={(event) => onEditFormChange({ ...editForm, labels: event.target.value })}
                  placeholder="bug, auth"
                  aria-label="Task labels"
                  className="max-w-md"
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
                <SpecialistActionIcon icon="architecture" className="size-icon-sm text-[color:var(--text-muted)]" />
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
            <Textarea
              value={editForm.description}
              onChange={(event) => onEditFormChange({ ...editForm, description: event.target.value })}
              aria-label="Task description"
              className="min-h-[140px]"
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

      {/* An edit session commits where it is entered — at the foot of the form,
          not from the identity row above it. */}
      {editing ? (
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[color:var(--border-default)] px-3 py-2">
          <GhostButton onClick={onCancelEdit} disabled={isEditing}>
            Cancel
          </GhostButton>
          <PrimaryButton onClick={onSaveEdit} disabled={isEditing}>
            {isEditing ? 'Saving…' : 'Save'}
          </PrimaryButton>
        </div>
      ) : null}

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
          <Textarea
            id="watchtower-comment-input"
            value={commentBody}
            onChange={(event) => onCommentChange(event.target.value)}
            placeholder="Note for triage, link a finding, or capture context..."
            rows={2}
            fullWidth={false}
            className="min-h-[44px] flex-1"
          />
          <PrimaryButton
            size="md"
            onClick={onAddComment}
            disabled={isCommenting || !commentBody.trim()}
            className="self-end"
          >
            {isCommenting ? 'Sending…' : 'Comment'}
          </PrimaryButton>
        </div>
      </footer>
    </div>
  )
}

// The kit's label badge in the confidence tone. No bullet inside it — a dot
// beside a tinted pill said the same thing twice — and no native `title`: the
// full label is the badge's accessible name.
function ConfidenceChip({ value, compact = false, title }: { value: number; compact?: boolean; title?: string }) {
  const label = confidenceLabel(value)
  return (
    <Badge tone={confidenceTone(value)} ariaLabel={title ? `${title}: ${label}` : label} className="shrink-0 tabular-nums">
      {compact ? `${value}%` : label}
    </Badge>
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

