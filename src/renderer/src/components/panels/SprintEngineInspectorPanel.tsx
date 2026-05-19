// Sprint Engine inspector — the right-hand detail pane for tasks, artifacts,
// agents, and artifact previews. Extracted from SprintEngineBoardPanel.tsx so
// the orchestrator stays focused on state coordination and IPC plumbing while
// the inspector owns its own rendering, sub-components, and detail formatting.
//
// Task-mode layout (after the 2026-05 redesign):
//   header → owner line → conditional callouts (blocker / needs input /
//   open findings) → description + AC → quality gates (with inline
//   reviewer terminal) → scores line → activity feed (filter chips +
//   chronological timeline) → compact details.
//
// Data shaping lives next door in `sprintEngineInspector.ts`; the orchestrator
// passes hydrated derived values via props rather than letting the inspector
// reach back into the store directly.

import React, { useCallback, useId, useMemo, useState } from 'react'
import type {
  SprintEngineArtifact,
  SprintEngineQualityGate,
  SprintEngineQualityGateAttempt,
  SprintEngineQualityGatePhase,
  SprintEngineTask,
  SprintEngineTaskActivityEntry,
  SprintEngineTaskActivityType,
  SprintEngineTaskBoardColumn,
  SprintEngineTaskComment,
  SprintEngineTaskDiff,
  SprintEngineTaskDiffLine,
  SprintEngineTaskFeedbackFinding,
  SprintEngineTaskFeedbackIssue,
} from '../../types/workspace'
import {
  feedbackFindingAreaLabels,
  feedbackFindingKindLabels,
  feedbackFindingSeverityLabels,
  feedbackIssueCategoryLabels,
  feedbackIssueSeverityLabels,
} from '../../utils/sprintengineRunSummary'
import {
  getOpenSprintEngineFeedbackComments,
  getOpenSprintEngineFeedbackFindings,
  getOpenSprintEngineFeedbackIssues,
  getSprintEngineArtifactAutoApprovalEligibility,
  getSprintEngineArtifactDependencyBlockers,
  getSprintEngineTaskActivityDescending,
  getSprintEngineTaskQualityGates,
  sprintEngineArtifactKindLabels,
  sprintEngineArtifactStatusLabels,
  sprintEngineQualityGateStatusLabels,
  sprintEngineRoleLabels,
  sprintEngineTaskBoardColumns,
  sprintEngineTaskCommentTypeLabels,
} from '../../utils/sprintengine'
import { formatRelativeTime } from '../../utils/switchboardBoard'
import {
  CloseIconButton,
  DefinitionList,
  FilePreviewPane,
  FOCUS_RING_CLASS,
  GhostButton,
  IconButton,
  InboxRow,
  PrimaryButton,
  RoleAvatar,
  StatusDot,
  TabPanel,
  Tabs,
  type DefinitionItem,
  type TabItem,
  type Tone,
} from '../ui'
import {
  SOURCE_HANDOFF_ARTIFACT_ID,
  artifactStatusTone,
  formatArtifactBlockerSummary,
  formatArtifactSummary,
  formatMobileArtifactDecision,
  formatTaskSourceLabel,
  formatTaskSyncStatusDescription,
  formatTaskSyncStatusLabel,
  formatTimestamp,
  getMobileArtifactDecision,
  runtimeStatusTone,
  sprintEngineInboxRowSupporting,
  sprintEngineInboxRowTone,
  type ArtifactActionState,
  type RuntimeAgentView,
  type SprintEngineInspectorSelection,
} from './sprintEngineInspector'

export function SprintEngineTaskStatusIcon({
  column,
  className,
}: {
  column: SprintEngineTaskBoardColumn
  className?: string
}) {
  const label = sprintEngineTaskBoardColumns.find((item) => item.key === column)?.label ?? column

  if (column === 'done') {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" role="img" aria-label={label}>
        <title>{label}</title>
        <circle cx="12" cy="12" r="6.4" fill="var(--tone-good)" />
        <path
          d="M9.25 12L11.25 14L14.75 10.25"
          stroke="var(--tone-good-soft)"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }

  if (column === 'needs_input') {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" role="img" aria-label={label}>
        <title>{label}</title>
        <circle cx="12" cy="12" r="6.4" stroke="var(--tone-warn)" strokeWidth="1.7" strokeDasharray="2 1.6" />
        <path d="M12 7.6V12.4" stroke="var(--tone-warn)" strokeWidth="1.7" strokeLinecap="round" />
        <circle cx="12" cy="15.4" r="0.95" fill="var(--tone-warn)" />
      </svg>
    )
  }

  if (column === 'ready') {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" role="img" aria-label={label}>
        <title>{label}</title>
        <circle cx="12" cy="12" r="6.4" stroke="var(--tone-good)" strokeWidth="1.7" />
        <circle cx="12" cy="12" r="2" fill="var(--tone-good)" />
      </svg>
    )
  }

  if (column === 'in_progress') {
    const radius = 5.4
    const cx = 12
    const cy = 12
    const sweep = 0.5
    const angle = sweep * 2 * Math.PI
    const endX = cx + radius * Math.sin(angle)
    const endY = cy - radius * Math.cos(angle)
    const wedgePath = `M ${cx} ${cy} L ${cx} ${cy - radius} A ${radius} ${radius} 0 0 1 ${endX.toFixed(2)} ${endY.toFixed(2)} Z`

    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" role="img" aria-label={label}>
        <title>{label}</title>
        <circle cx={cx} cy={cy} r="6.4" stroke="var(--tone-warn)" strokeWidth="1.7" />
        <path d={wedgePath} fill="var(--tone-warn)" opacity="0.85" />
      </svg>
    )
  }

  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" role="img" aria-label={label}>
      <title>{label}</title>
      <circle cx="12" cy="12" r="6.4" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  )
}

function boardColumnTone(column: SprintEngineTaskBoardColumn | null): Tone {
  switch (column) {
    case 'done':
      return 'good'
    case 'in_progress':
    case 'needs_input':
      return 'warn'
    case 'ready':
      return 'accent'
    default:
      return 'neutral'
  }
}

function SectionList({
  title,
  items,
  emptyLabel,
}: {
  title: string
  items: string[]
  emptyLabel: string
}) {
  return (
    <div>
      <div className="mb-2 text-[11px] font-semibold text-[color:var(--text-muted)]">{title}</div>
      {items.length > 0 ? (
        <ul className="space-y-1.5 text-[color:var(--text-default)]">
          {items.map((item) => (
            <li key={item} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
              <span className="mt-[0.65rem] h-1 w-1 rounded-full bg-[color:var(--text-disabled)]" aria-hidden="true" />
              <span className="[overflow-wrap:anywhere]">{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-[12px] text-[color:var(--text-disabled)]">{emptyLabel}</div>
      )}
    </div>
  )
}

function qualityGateStatusTone(status: SprintEngineQualityGate['status']): Tone {
  switch (status) {
    case 'approved':
      return 'good'
    case 'in_progress':
      return 'warn'
    case 'changes_requested':
    case 'blocked':
      return 'warn'
    case 'skipped':
      return 'neutral'
    default:
      return 'neutral'
  }
}

// Gate attempt glyph trail — shows the rework story (changes_requested →
// approved) without repeating the verdict text. Tone-warn highlights only the
// rework leg; approvals stay muted so a clean first-pass reads as calm.
function GateAttemptGlyph({
  attempt,
  className,
}: {
  attempt: SprintEngineQualityGateAttempt
  className?: string
}) {
  const inFlight = Boolean(attempt.startedAt) && !attempt.completedAt
  const verdict = inFlight ? 'in_flight' : (attempt.verdict ?? attempt.status ?? 'in_flight')

  if (verdict === 'approved') {
    return (
      <svg className={className} viewBox="0 0 12 12" fill="none" role="img" aria-label="approved">
        <title>approved</title>
        <path
          d="M2.8 6.4 L5 8.4 L9.2 4.2"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }

  if (verdict === 'changes_requested') {
    return (
      <svg
        className={className}
        viewBox="0 0 12 12"
        fill="none"
        role="img"
        aria-label="changes requested"
      >
        <title>changes requested</title>
        <path
          d="M9.2 6.4 a3.2 3.2 0 1 1 -1.1 -2.4"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
        <path
          d="M8.1 2.4 L8.1 4.0 L6.5 4.0"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }

  if (verdict === 'blocked') {
    return (
      <svg className={className} viewBox="0 0 12 12" fill="none" role="img" aria-label="blocked">
        <title>blocked</title>
        <circle cx="6" cy="6" r="3.5" stroke="currentColor" strokeWidth="1.4" />
        <path
          d="M3.6 8.4 L8.4 3.6"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    )
  }

  return (
    <svg className={className} viewBox="0 0 12 12" fill="none" role="img" aria-label="in review">
      <title>in review</title>
      <circle
        cx="6"
        cy="6"
        r="3.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeDasharray="1.5 1.4"
      />
    </svg>
  )
}

function gateAttemptToneClass(attempt: SprintEngineQualityGateAttempt): string {
  const inFlight = Boolean(attempt.startedAt) && !attempt.completedAt
  if (inFlight) return 'text-[color:var(--text-muted)]'
  const verdict = attempt.verdict ?? attempt.status
  if (verdict === 'changes_requested' || verdict === 'blocked') {
    return 'text-[color:var(--tone-warn)]'
  }
  return 'text-[color:var(--text-disabled)]'
}

function AcceptanceCheckbox({ checked }: { checked: boolean }) {
  if (checked) {
    return (
      <svg
        className="icon-xs text-[color:var(--tone-good)]"
        viewBox="0 0 12 12"
        fill="none"
        role="img"
        aria-label="met"
      >
        <title>met</title>
        <circle cx="6" cy="6" r="5" fill="currentColor" opacity="0.18" />
        <path
          d="M3.6 6.3 L5.4 8 L8.6 4.4"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  return (
    <svg
      className="icon-xs text-[color:var(--text-disabled)]"
      viewBox="0 0 12 12"
      fill="none"
      role="img"
      aria-label="pending"
    >
      <title>pending</title>
      <circle cx="6" cy="6" r="4.6" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  )
}

function GateAttemptTrail({ attempts }: { attempts: SprintEngineQualityGateAttempt[] }) {
  if (attempts.length === 0) return null
  return (
    <span
      className="inline-flex items-center gap-1"
      aria-label={`${attempts.length} attempt${attempts.length === 1 ? '' : 's'}`}
    >
      {attempts.map((attempt, index) => (
        <GateAttemptGlyph
          key={attempt.id ?? `attempt-${index}`}
          attempt={attempt}
          className={`icon-xs ${gateAttemptToneClass(attempt)}`}
        />
      ))}
    </span>
  )
}

function TaskCommentRow({ comment }: { comment: SprintEngineTaskComment }) {
  const label = comment.type ? sprintEngineTaskCommentTypeLabels[comment.type] : 'Comment'
  const authorLabel = comment.authorAgentId ?? comment.actor
  const absolute = comment.createdAt ? new Date(comment.createdAt).toLocaleString() : undefined
  const relative = comment.createdAt ? formatRelativeTime(comment.createdAt) : '—'
  const [expanded, setExpanded] = useState(false)
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11px]">
        <span className="font-mono text-[10px] uppercase tracking-normal text-[color:var(--text-muted)]">{label}</span>
        <span className="font-mono text-[11px] text-[color:var(--text-muted)]">{authorLabel}</span>
        {comment.authorRole ? (
          <span className="text-[color:var(--text-disabled)]">{sprintEngineRoleLabels[comment.authorRole]}</span>
        ) : null}
        <span
          title={absolute}
          className="ml-auto tabular-nums font-mono text-[10px] text-[color:var(--text-disabled)]"
        >
          {relative}
        </span>
      </div>
      <CollapsibleMessage
        message={comment.body}
        expanded={expanded}
        onToggle={() => setExpanded((prev) => !prev)}
        className="mt-1 text-[12px] leading-5 text-[color:var(--text-default)] [overflow-wrap:anywhere]"
      />
      {comment.paths && comment.paths.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1">
          {comment.paths.map((path) => (
            <span key={path} className="font-mono text-[11px] text-[color:var(--text-muted)] [overflow-wrap:anywhere]">
              {path}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ConfidenceDial({ value, size = 14, label }: { value: number; size?: number; label?: string }) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)))
  const stroke = 1.5
  const radius = size / 2 - stroke / 2 - 0.5
  const cx = size / 2
  const cy = size / 2
  const tone = clamped >= 80 ? 'var(--tone-good)' : clamped >= 50 ? 'var(--tone-warn)' : 'var(--tone-error)'
  const trackTone = 'var(--border-strong)'
  const ariaLabel = label ? `${label}: ${clamped}% confidence` : `${clamped}% confidence`

  let arc: React.ReactNode = null
  if (clamped >= 100) {
    arc = <circle cx={cx} cy={cy} r={radius} stroke={tone} strokeWidth={stroke} fill="none" />
  } else if (clamped > 0) {
    const angle = (clamped / 100) * 2 * Math.PI
    const endX = cx + radius * Math.sin(angle)
    const endY = cy - radius * Math.cos(angle)
    const largeArc = clamped > 50 ? 1 : 0
    arc = (
      <path
        d={`M ${cx} ${cy - radius} A ${radius} ${radius} 0 ${largeArc} 1 ${endX} ${endY}`}
        stroke={tone}
        strokeWidth={stroke}
        strokeLinecap="round"
        fill="none"
      />
    )
  }

  return (
    <span className="inline-flex shrink-0 items-center" title={ariaLabel} aria-label={ariaLabel} role="img">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={cx} cy={cy} r={radius} stroke={trackTone} strokeWidth={stroke} fill="none" />
        {arc}
        <circle cx={cx} cy={cy} r={Math.max(0.8, size / 14)} fill={tone} />
      </svg>
    </span>
  )
}

function getArtifactConfidencePct(
  artifact: SprintEngineArtifact,
  task: SprintEngineTask | undefined,
): number | null {
  const feedback = task?.feedback
  if (!feedback) return null
  if (feedback.agentId !== artifact.createdBy) return null
  const value = feedback.scores?.confidencePct
  return typeof value === 'number' ? value : null
}

export function SprintEngineInboxRow({
  artifact,
  task,
  selected,
  onSelect,
  id,
}: {
  artifact: SprintEngineArtifact
  task: SprintEngineTask | undefined
  selected: boolean
  onSelect: () => void
  id?: string
}) {
  const tone = sprintEngineInboxRowTone(artifact)
  const timestamp = artifact.createdAt ?? artifact.updatedAt
  const relativeTimestamp = timestamp ? formatRelativeTime(timestamp) : '—'
  const title = (
    <>
      <span className="mr-2 font-mono tabular-nums text-[11px] text-[color:var(--text-muted)]">
        {artifact.id}
      </span>
      {artifact.title}
    </>
  )
  return (
    <InboxRow
      id={id}
      tone={tone}
      title={title}
      supporting={sprintEngineInboxRowSupporting(artifact, task)}
      trailing={relativeTimestamp}
      selected={selected}
      onSelect={onSelect}
      ariaLabel={`${artifact.id} ${artifact.title}`}
    />
  )
}

export function SprintEngineBlockedByRow({
  task,
  blockers,
  selected,
  onSelect,
  id,
}: {
  task: SprintEngineTask
  blockers: ReturnType<typeof getSprintEngineArtifactDependencyBlockers>
  selected: boolean
  onSelect: () => void
  id?: string
}) {
  const title = (
    <>
      <span className="mr-2 font-mono tabular-nums text-[11px] text-[color:var(--text-muted)]">
        {task.id}
      </span>
      {task.title}
    </>
  )
  return (
    <InboxRow
      id={id}
      tone="warn"
      title={title}
      supporting={`Waiting on ${formatArtifactBlockerSummary(blockers)}`}
      selected={selected}
      onSelect={onSelect}
      ariaLabel={`${task.id} ${task.title} waiting on ${formatArtifactBlockerSummary(blockers)}`}
    />
  )
}

function SprintEngineArtifactInspector({
  artifact,
  task,
  actionState,
  onClose,
  onOpenArtifact,
  onApproveArtifact,
  onRequestArtifactChanges,
  onSelectTask,
  isExpanded,
  onToggleExpand,
}: {
  artifact: SprintEngineArtifact
  task: SprintEngineTask | undefined
  actionState: ArtifactActionState | undefined
  onClose: () => void
  onOpenArtifact: (artifact: SprintEngineArtifact) => void
  onApproveArtifact: (artifact: SprintEngineArtifact) => void
  onRequestArtifactChanges: (artifact: SprintEngineArtifact) => void
  onSelectTask: (taskId: string) => void
  isExpanded: boolean
  onToggleExpand: () => void
}) {
  const isSourceHandoff = artifact.id === SOURCE_HANDOFF_ARTIFACT_ID
  const tone = sprintEngineInboxRowTone(artifact)
  const statusLabel = isSourceHandoff ? 'Source' : sprintEngineArtifactStatusLabels[artifact.status]
  const timestamp = artifact.createdAt ?? artifact.updatedAt
  const relativeTimestamp = timestamp ? formatRelativeTime(timestamp) : 'No timestamp'
  const absoluteTimestamp = timestamp ? new Date(timestamp).toLocaleString() : undefined
  const confidencePct = getArtifactConfidencePct(artifact, task)
  const mobileDecision = getMobileArtifactDecision(artifact)
  const autoApproval = getSprintEngineArtifactAutoApprovalEligibility(artifact)
  const canOpenArtifact = Boolean(artifact.path.trim())
  const readyForReview = artifact.status === 'ready_for_review'
  const pending = actionState?.status === 'pending'

  const items: DefinitionItem[] = []
  items.push({
    term: 'Status',
    description: (
      <span className="inline-flex items-center gap-2">
        <StatusDot tone={tone} />
        <span>{statusLabel}</span>
      </span>
    ),
  })
  items.push({
    term: 'Updated',
    description: <span title={absoluteTimestamp}>{relativeTimestamp}</span>,
  })
  items.push({
    term: 'Kind',
    description: isSourceHandoff ? 'Handover' : sprintEngineArtifactKindLabels[artifact.kind],
  })
  if (!isSourceHandoff && artifact.taskId) {
    items.push({
      term: 'Task',
      description: (
        <button
          type="button"
          onClick={() => onSelectTask(artifact.taskId)}
          disabled={!task}
          className="interactive font-mono text-[color:var(--text-strong)] transition-colors hover:text-[color:var(--accent-primary)] disabled:text-[color:var(--text-disabled)]"
        >
          {artifact.taskId}
          {task ? <span className="ml-1.5 font-sans text-[color:var(--text-muted)]">{task.title}</span> : null}
        </button>
      ),
    })
  }
  items.push({
    term: 'File',
    description: artifact.path ? (
      <span className="break-all font-mono text-[12px] text-[color:var(--text-strong)]">{artifact.path}</span>
    ) : (
      <span className="text-[color:var(--text-disabled)]">No file path recorded.</span>
    ),
  })
  if (confidencePct !== null) {
    items.push({
      term: 'Confidence',
      description: (
        <span className="inline-flex items-center gap-2">
          <ConfidenceDial value={confidencePct} label="Agent confidence" />
          <span className="tabular-nums">{Math.round(confidencePct)}%</span>
        </span>
      ),
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-[color:var(--border-default)] px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] text-[color:var(--text-subtle)]">
              <StatusDot tone={tone} />
              <span>{statusLabel}</span>
              <span>·</span>
              <span className="font-mono text-[color:var(--text-muted)]">{artifact.id}</span>
            </div>
            <h3 className="mt-2 truncate text-[18px] font-semibold leading-7 text-[color:var(--text-strong)]">
              {artifact.title}
            </h3>
          </div>
          <InspectorChromeActions
            expanded={isExpanded}
            onToggleExpand={onToggleExpand}
            onClose={onClose}
            closeLabel="Close artifact detail"
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {canOpenArtifact ? (
            <GhostButton onClick={() => onOpenArtifact(artifact)} disabled={pending}>
              {pending && actionState?.kind === 'open' ? 'Opening…' : 'Open'}
            </GhostButton>
          ) : null}
          {readyForReview ? (
            <>
              <PrimaryButton onClick={() => onApproveArtifact(artifact)} disabled={pending}>
                {pending && actionState?.kind === 'approve' ? 'Approving…' : 'Approve'}
              </PrimaryButton>
              <GhostButton onClick={() => onRequestArtifactChanges(artifact)} disabled={pending}>
                {pending && actionState?.kind === 'requestChanges' ? 'Requesting changes…' : 'Request changes'}
              </GhostButton>
            </>
          ) : null}
          {!canOpenArtifact && !readyForReview ? (
            <span className="text-[12px] text-[color:var(--text-muted)]">
              No actions available for this artifact yet.
            </span>
          ) : null}
        </div>
      </header>

      <div className="flex-1 space-y-5 overflow-auto px-5 py-4 text-[13px] leading-6 text-[color:var(--text-default)]">
        <DefinitionList items={items} />

        {mobileDecision ? (
          <div>
            <div className="mb-2 text-[10px] font-bold text-[color:var(--text-disabled)]">Mobile decision</div>
            <div className="text-[12px] leading-5 text-[color:var(--text-default)]">
              {formatMobileArtifactDecision(mobileDecision)}
            </div>
          </div>
        ) : null}

        {readyForReview && autoApproval.label ? (
          <div>
            <div className="mb-2 text-[10px] font-bold text-[color:var(--text-disabled)]">Auto-approval</div>
            <div
              className={`text-[12px] leading-5 ${
                autoApproval.eligible
                  ? 'text-[color:var(--accent-primary)]'
                  : 'text-[color:var(--tone-warn)]'
              }`}
            >
              {autoApproval.label}
            </div>
          </div>
        ) : null}

        {actionState && actionState.status !== 'pending' ? (
          <div>
            <div className="mb-2 text-[10px] font-bold text-[color:var(--text-disabled)]">Last action</div>
            <div
              className={`text-[12px] leading-5 ${
                actionState.status === 'error' ? 'text-[color:var(--tone-error)]' : 'text-[color:var(--tone-good)]'
              }`}
            >
              {actionState.message}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function SprintEngineArtifactList({
  artifacts,
  tasksById,
  actions,
  title = 'Review Artifacts',
  emptyLabel,
  hideHeader = false,
  onSelectTask,
  onOpenArtifact,
  onApproveArtifact,
  onRequestArtifactChanges,
}: {
  artifacts: SprintEngineArtifact[]
  tasksById: Record<string, SprintEngineTask | undefined>
  actions: Record<string, ArtifactActionState>
  title?: string
  emptyLabel: string
  hideHeader?: boolean
  onSelectTask: (taskId: string) => void
  onOpenArtifact: (artifact: SprintEngineArtifact) => void
  onApproveArtifact: (artifact: SprintEngineArtifact) => void
  onRequestArtifactChanges: (artifact: SprintEngineArtifact) => void
}) {
  return (
    <div>
      {hideHeader ? null : (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] font-semibold text-[color:var(--text-muted)]">{title}</div>
          {artifacts.length > 0 ? (
            <span className="text-[11px] text-[color:var(--text-disabled)]">
              {formatArtifactSummary(artifacts)}
            </span>
          ) : null}
        </div>
      )}

      {artifacts.length > 0 ? (
        <ol className="divide-y divide-[color:var(--border-default)]">
          {artifacts.map((artifact) => {
            const task = tasksById[artifact.taskId]
            const action = actions[artifact.id]
            const pending = action?.status === 'pending'
            const readyForReview = artifact.status === 'ready_for_review'
            const canOpenArtifact = Boolean(artifact.path.trim())
            const autoApprovalEligibility = getSprintEngineArtifactAutoApprovalEligibility(artifact)
            const mobileDecision = getMobileArtifactDecision(artifact)
            const confidencePct = getArtifactConfidencePct(artifact, task)
            const isSourceHandoff = artifact.id === SOURCE_HANDOFF_ARTIFACT_ID
            const timestamp = artifact.createdAt ?? artifact.updatedAt
            const absoluteTimestamp = timestamp ? new Date(timestamp).toLocaleString() : null
            const relativeTimestamp = timestamp ? formatRelativeTime(timestamp) : 'No timestamp'

            return (
              <li key={artifact.id} className="grid gap-3 px-3 py-2.5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                <div className="min-w-0 space-y-0.5">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="shrink-0 font-mono tabular-nums text-[11px] text-[color:var(--text-muted)]">{artifact.id}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[color:var(--text-strong)]">{artifact.title}</span>
                    {confidencePct !== null ? (
                      <ConfidenceDial value={confidencePct} label="Agent confidence" />
                    ) : null}
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${artifactStatusTone(artifact.status)}`}>
                      {isSourceHandoff ? 'Source' : sprintEngineArtifactStatusLabels[artifact.status]}
                    </span>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[color:var(--text-subtle)]">
                    {isSourceHandoff ? null : (
                      <>
                        <span>{sprintEngineArtifactKindLabels[artifact.kind]}</span>
                        <span>·</span>
                        <button
                          type="button"
                          onClick={() => onSelectTask(artifact.taskId)}
                          disabled={!task}
                          className="interactive font-mono text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--accent-primary)] disabled:text-[color:var(--text-disabled)]"
                        >
                          {artifact.taskId}
                          {task ? <span className="ml-1.5 font-sans">{task.title}</span> : null}
                        </button>
                        <span>·</span>
                      </>
                    )}
                    <span title={absoluteTimestamp ?? undefined}>{relativeTimestamp}</span>
                    {mobileDecision ? (
                      <span className="text-[color:var(--text-muted)]">{formatMobileArtifactDecision(mobileDecision)}</span>
                    ) : null}
                    {readyForReview && autoApprovalEligibility.label ? (
                      <span className={autoApprovalEligibility.eligible ? 'text-[color:var(--accent-primary)]' : 'text-[color:var(--tone-warn)]'}>
                        {autoApprovalEligibility.label}
                      </span>
                    ) : null}
                  </div>
                  {action && action.status !== 'pending' ? (
                    <div className={`text-[11px] ${action.status === 'error' ? 'text-[color:var(--tone-error)]' : 'text-[color:var(--tone-good)]'}`}>
                      {action.message}
                    </div>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-1.5 justify-self-end">
                  {canOpenArtifact ? (
                    <GhostButton onClick={() => onOpenArtifact(artifact)} disabled={pending}>
                      {pending && action?.kind === 'open' ? 'Opening…' : 'Open'}
                    </GhostButton>
                  ) : null}
                  {readyForReview ? (
                    <>
                      <PrimaryButton onClick={() => onApproveArtifact(artifact)} disabled={pending}>
                        {pending && action?.kind === 'approve' ? 'Approving…' : 'Approve'}
                      </PrimaryButton>
                      <GhostButton onClick={() => onRequestArtifactChanges(artifact)} disabled={pending}>
                        {pending && action?.kind === 'requestChanges' ? 'Requesting changes…' : 'Request changes'}
                      </GhostButton>
                    </>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ol>
      ) : (
        <div className="text-[12px] text-[color:var(--text-disabled)]">{emptyLabel}</div>
      )}
    </div>
  )
}

function ArtifactBlockerList({
  blockers,
}: {
  blockers: ReturnType<typeof getSprintEngineArtifactDependencyBlockers>
}) {
  if (blockers.length === 0) return null
  return (
    <div className="border-l border-[color:var(--tone-warn-soft)] pl-3 text-sm text-[color:var(--tone-warn)]">
      <div className="text-[11px] font-semibold text-[color:var(--tone-warn)]">Blocked by review</div>
      <div className="mt-2 space-y-2 text-[12px] leading-5 text-[color:var(--tone-warn)]">
        {blockers.map((blocker) => (
          <div key={blocker.taskId} className="space-y-1">
            <div>
              Waiting on <span className="font-mono">{blocker.taskId}</span>:
            </div>
            <ul className="ml-3 list-disc space-y-0.5">
              {blocker.artifacts.map((artifact) => (
                <li key={artifact.id} className="[overflow-wrap:anywhere]">
                  <span className="font-mono">{artifact.id}</span> · {artifact.title} · {sprintEngineArtifactStatusLabels[artifact.status]}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Task body sub-components — owner, quality gates, scores, findings,
// activity feed, compact details. Each is small, single-purpose, and
// designed for the 320–560 px side-pane the inspector lives in.
// ──────────────────────────────────────────────────────────────────────────

function findGateAgent(
  gate: SprintEngineQualityGate,
  task: SprintEngineTask,
  runtimeAgents: RuntimeAgentView[],
): RuntimeAgentView | null {
  const claimed = gate.attempts
    .map((attempt) => attempt.claimedBy)
    .filter((id): id is string => Boolean(id))
  for (const agentId of [...claimed].reverse()) {
    const agent = runtimeAgents.find((entry) => entry.agentId === agentId)
    if (agent) return agent
  }
  const byRoleOnThisTask = runtimeAgents.find(
    (entry) => entry.role === gate.role && entry.currentTaskId === task.id,
  )
  if (byRoleOnThisTask) return byRoleOnThisTask

  return runtimeAgents.find((entry) => entry.role === gate.role) ?? null
}

function TaskOwnerLine({
  task,
  ownerLabel,
  runtimeAgents,
  isAgentTerminalLive,
  onOpenAgentTerminal,
}: {
  task: SprintEngineTask
  ownerLabel: string
  runtimeAgents: RuntimeAgentView[]
  isAgentTerminalLive: (agentId: string) => boolean
  onOpenAgentTerminal: (agentId: string) => void
}) {
  const ownerAgent = task.ownerAgentId
    ? runtimeAgents.find((entry) => entry.agentId === task.ownerAgentId)
    : null
  const ownerStatus = ownerAgent?.status ?? null
  const ownerAgentId = task.ownerAgentId
  const hasLiveTerminal = ownerAgentId ? isAgentTerminalLive(ownerAgentId) : false
  const canOpenTerminal = Boolean(ownerAgentId)

  const identityCluster = (
    <>
      <RoleAvatar role={task.role} size="sm" ariaLabel="" />
      <span className="text-[color:var(--text-default)]">{ownerLabel}</span>
    </>
  )

  return (
    <div className="flex items-center gap-2 text-[12px] text-[color:var(--text-muted)]">
      {canOpenTerminal && ownerAgentId ? (
        <button
          type="button"
          onClick={() => onOpenAgentTerminal(ownerAgentId)}
          aria-label={`Open ${ownerLabel} terminal`}
          className={
            'interactive -mx-1.5 inline-flex items-center gap-2 rounded px-1.5 py-0.5 ' +
            'transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ' +
            FOCUS_RING_CLASS
          }
        >
          {identityCluster}
        </button>
      ) : (
        <span className="inline-flex items-center gap-2">{identityCluster}</span>
      )}
      {ownerStatus ? (
        <>
          <span className="text-[color:var(--text-disabled)]">·</span>
          <span className="inline-flex items-center gap-1.5">
            <StatusDot tone={runtimeStatusTone(ownerStatus)} />
            <span>{ownerStatus.replace(/_/g, ' ')}</span>
          </span>
        </>
      ) : null}
      {hasLiveTerminal ? (
        <span className="ml-1 text-[10px] text-[color:var(--text-disabled)]">live</span>
      ) : null}
    </div>
  )
}

function TaskCallout({
  tone,
  label,
  children,
}: {
  tone: 'warn' | 'error'
  label: string
  children: React.ReactNode
}) {
  const toneColor = tone === 'error' ? 'var(--tone-error)' : 'var(--tone-warn)'
  return (
    <div
      className="border-l pl-3 text-[12px] leading-5"
      style={{ borderColor: toneColor, color: toneColor }}
    >
      <div className="text-[11px] font-semibold" style={{ color: toneColor }}>
        {label}
      </div>
      <div className="mt-1 text-[color:var(--text-default)]">{children}</div>
    </div>
  )
}

function TaskQualityGates({
  task,
  runtimeAgents,
  isAgentTerminalLive,
  onOpenAgentTerminal,
}: {
  task: SprintEngineTask
  runtimeAgents: RuntimeAgentView[]
  isAgentTerminalLive: (agentId: string) => boolean
  onOpenAgentTerminal: (agentId: string) => void
}) {
  const gates = getSprintEngineTaskQualityGates(task)
  if (gates.length === 0) return null

  const phases: SprintEngineQualityGatePhase[] = ['review', 'testing', 'product']
  const ordered = phases.flatMap((phase) => gates.filter((gate) => gate.phase === phase))

  return (
    <div>
      <div className="mb-2 text-[11px] font-semibold text-[color:var(--text-muted)]">
        Quality gates
      </div>
      <ul className="divide-y divide-[color:var(--border-subtle)] border-y border-[color:var(--border-subtle)]">
        {ordered.map((gate) => {
          const agent = findGateAgent(gate, task, runtimeAgents)
          const agentHasLiveTerminal = agent ? isAgentTerminalLive(agent.agentId) : false
          const gateIdentity = (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <RoleAvatar role={gate.role} size="sm" ariaLabel="" />
              <span className="truncate">{agent?.label ?? sprintEngineRoleLabels[gate.role]}</span>
            </span>
          )
          return (
            <li
              key={`${gate.phase}:${gate.id}`}
              className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 py-2"
            >
              <StatusDot tone={qualityGateStatusTone(gate.status)} />
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  {agent ? (
                    <button
                      type="button"
                      onClick={() => onOpenAgentTerminal(agent.agentId)}
                      aria-label={`Open ${agent.label} terminal`}
                      className={
                        'interactive -mx-1 inline-flex min-w-0 items-center rounded px-1 py-0.5 ' +
                        'text-[12.5px] text-[color:var(--text-strong)] transition-colors ' +
                        'hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ' +
                        FOCUS_RING_CLASS
                      }
                    >
                      {gateIdentity}
                    </button>
                  ) : (
                    <span className="inline-flex min-w-0 items-center text-[12.5px] text-[color:var(--text-strong)]">
                      {gateIdentity}
                    </span>
                  )}
                  <GateAttemptTrail attempts={gate.attempts} />
                  <span className="text-[11px] text-[color:var(--text-muted)]">
                    {sprintEngineQualityGateStatusLabels[gate.status]}
                  </span>
                  {agentHasLiveTerminal ? (
                    <span className="text-[10px] text-[color:var(--text-disabled)]">live</span>
                  ) : null}
                  {!gate.required ? (
                    <span className="text-[11px] text-[color:var(--text-disabled)]">optional</span>
                  ) : null}
                </div>
                {gate.attempts.length === 0 && gate.focus ? (
                  <div className="mt-0.5 truncate text-[11px] text-[color:var(--text-muted)]">
                    {gate.focus}
                  </div>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function TaskScoresLine({ task }: { task: SprintEngineTask }) {
  const feedback = task.feedback
  if (!feedback) return null
  const confidence = feedback.scores.confidencePct
  const hallucination = feedback.scores.hallucinationRiskPct
  if (typeof confidence !== 'number' && typeof hallucination !== 'number') return null

  const captured = feedback.capturedAt ? formatRelativeTime(feedback.capturedAt) : null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-[color:var(--text-muted)]">
      {typeof confidence === 'number' ? (
        <span>
          Confidence{' '}
          <span className="tabular-nums font-mono text-[color:var(--text-strong)]">
            {Math.round(confidence)}%
          </span>
        </span>
      ) : null}
      {typeof hallucination === 'number' ? (
        <span>
          Hallucination{' '}
          <span
            className="tabular-nums font-mono"
            style={{
              color:
                hallucination >= 30
                  ? 'var(--tone-error)'
                  : hallucination >= 10
                    ? 'var(--tone-warn)'
                    : 'var(--text-strong)',
            }}
          >
            {Math.round(hallucination)}%
          </span>
        </span>
      ) : null}
      <span className="text-[color:var(--text-disabled)]">
        from <span className="font-mono">{feedback.agentId}</span>
        {captured ? `, ${captured}` : ''}
      </span>
    </div>
  )
}

function TaskOpenFindings({
  issues,
  findings,
}: {
  issues: SprintEngineTaskFeedbackIssue[]
  findings: SprintEngineTaskFeedbackFinding[]
}) {
  if (issues.length === 0 && findings.length === 0) return null
  const total = issues.length + findings.length

  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-[11px] font-semibold text-[color:var(--tone-warn)]">
          Open findings
        </span>
        <span className="tabular-nums text-[11px] text-[color:var(--text-disabled)]">{total}</span>
      </div>
      <ul className="divide-y divide-[color:var(--border-subtle)] border-y border-[color:var(--border-subtle)]">
        {findings.map((finding) => (
          <li key={finding.id} className="py-2 text-[12px] leading-5 text-[color:var(--text-default)]">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] text-[color:var(--text-muted)]">
              <span className="text-[color:var(--tone-warn)]">
                {feedbackFindingSeverityLabels[finding.severity]}
              </span>
              <span>{feedbackFindingKindLabels[finding.kind]}</span>
              <span>·</span>
              <span>{feedbackFindingAreaLabels[finding.area]}</span>
              {finding.file ? (
                <>
                  <span>·</span>
                  <span className="font-mono text-[10.5px] [overflow-wrap:anywhere]">
                    {finding.file}
                  </span>
                </>
              ) : null}
            </div>
            <div className="mt-1 text-[color:var(--text-strong)]">{finding.title}</div>
            <div className="mt-0.5 text-[color:var(--text-muted)] [overflow-wrap:anywhere]">
              {finding.detail}
            </div>
            {finding.recommendation ? (
              <div className="mt-0.5 text-[color:var(--text-default)]">
                <span className="text-[color:var(--text-muted)]">→ </span>
                {finding.recommendation}
              </div>
            ) : null}
          </li>
        ))}
        {issues.map((issue) => (
          <li key={issue.id} className="py-2 text-[12px] leading-5 text-[color:var(--text-default)]">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] text-[color:var(--text-muted)]">
              <span className="text-[color:var(--tone-warn)]">
                {feedbackIssueSeverityLabels[issue.severity]}
              </span>
              <span>prompt {feedbackIssueCategoryLabels[issue.category].toLowerCase()}</span>
              {issue.target ? (
                <>
                  <span>·</span>
                  <span className="font-mono text-[10.5px]">{issue.target}</span>
                </>
              ) : null}
            </div>
            <div className="mt-1 text-[color:var(--text-strong)]">{issue.title}</div>
            <div className="mt-0.5 text-[color:var(--text-muted)] [overflow-wrap:anywhere]">
              {issue.detail}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

// Activity feed — the spine. Replaces five legacy stacked sections
// (Activity, Implementation Handoff, Open Feedback Comments, ready-action
// messages, Recorded Artifacts) with one filterable chronological list.
// Sub-filter chips reduce the stream by entry type without hiding any data.

type ActivityFilter = 'all' | 'reviews' | 'comments' | 'status' | 'evidence'

const ACTIVITY_FILTERS: Array<{ key: ActivityFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'reviews', label: 'Reviews' },
  { key: 'comments', label: 'Comments' },
  { key: 'status', label: 'Status' },
  { key: 'evidence', label: 'Evidence' },
]

const ACTIVITY_TYPE_TO_FILTER: Record<SprintEngineTaskActivityType, Exclude<ActivityFilter, 'all'>> = {
  comment: 'comments',
  status_change: 'status',
  claim: 'status',
  evidence: 'evidence',
  feedback: 'reviews',
  needs_input: 'comments',
  artifact: 'reviews',
  system: 'status',
}

function activityEntryTone(entry: SprintEngineTaskActivityEntry): Tone {
  if (entry.type === 'needs_input') return 'warn'
  if (entry.type === 'feedback') return 'accent'
  if (entry.type === 'artifact') {
    if (entry.artifactStatus === 'approved') return 'good'
    if (entry.artifactStatus === 'changes_requested') return 'error'
    if (entry.artifactStatus === 'ready_for_review') return 'warn'
    return 'accent'
  }
  if (entry.type === 'status_change') {
    if (entry.status === 'done') return 'good'
    if (entry.status === 'needs_input') return 'warn'
    return 'neutral'
  }
  return 'neutral'
}

// Boilerplate "{actor} did X on {task}" messages duplicate the verb chip and
// add no signal — suppress for these types. Real prose lives on comments,
// needs_input resolutions, artifacts, and system events.
const SUPPRESS_ACTIVITY_MESSAGE_TYPES = new Set<SprintEngineTaskActivityType>([
  'claim',
  'evidence',
  'status_change',
  'feedback',
])

// Coalesce consecutive identical-actor/type events within this window into one
// row with a ×N count. Only applied to types where rapid bursts are noise
// (evidence emissions on `task publish`).
const ACTIVITY_COALESCE_WINDOW_MS = 5 * 60 * 1000
const COALESCIBLE_ACTIVITY_TYPES = new Set<SprintEngineTaskActivityType>(['evidence'])

// Long-prose preview cap; comment / needs-input resolutions / artifact notes
// exceeding this are clipped with a "Show more" toggle.
const LONG_MESSAGE_PREVIEW_LIMIT = 280

type ActivityGroup = {
  key: string
  primary: SprintEngineTaskActivityEntry
  members: SprintEngineTaskActivityEntry[]
}

function groupActivityEntries(entries: SprintEngineTaskActivityEntry[]): ActivityGroup[] {
  const groups: ActivityGroup[] = []
  for (const entry of entries) {
    const last = groups[groups.length - 1]
    const lastMember = last ? last.members[last.members.length - 1] : null
    const coalescible =
      Boolean(last) &&
      Boolean(lastMember) &&
      COALESCIBLE_ACTIVITY_TYPES.has(entry.type) &&
      last!.primary.type === entry.type &&
      last!.primary.actor === entry.actor &&
      Math.abs(
        new Date(lastMember!.timestamp).getTime() - new Date(entry.timestamp).getTime(),
      ) <= ACTIVITY_COALESCE_WINDOW_MS
    if (coalescible) {
      last!.members.push(entry)
    } else {
      groups.push({ key: entry.id, primary: entry, members: [entry] })
    }
  }
  return groups
}

function activityMessageIsVisible(entry: SprintEngineTaskActivityEntry): boolean {
  if (!entry.message) return false
  if (SUPPRESS_ACTIVITY_MESSAGE_TYPES.has(entry.type)) return false
  return true
}

function CollapsibleMessage({
  message,
  expanded,
  onToggle,
  className,
}: {
  message: string
  expanded: boolean
  onToggle: () => void
  className?: string
}) {
  const isLong = message.length > LONG_MESSAGE_PREVIEW_LIMIT
  if (!isLong) {
    return <div className={className}>{message}</div>
  }
  const display = expanded
    ? message
    : `${message.slice(0, LONG_MESSAGE_PREVIEW_LIMIT).trimEnd()}…`
  return (
    <div className={className}>
      <span>{display}</span>{' '}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={
          'interactive text-[11px] text-[color:var(--text-muted)] underline-offset-2 ' +
          'transition-colors hover:text-[color:var(--text-strong)] hover:underline ' +
          FOCUS_RING_CLASS
        }
      >
        {expanded ? 'Show less' : 'Show more'}
      </button>
    </div>
  )
}

function activityVerb(entry: SprintEngineTaskActivityEntry): string {
  switch (entry.type) {
    case 'comment':
      return 'commented'
    case 'status_change':
      switch (entry.status) {
        case 'changes_requested':
          return 'requested changes'
        case 'needs_input':
          return 'asked for input'
        case 'in_progress':
          return 'resumed work'
        case 'review':
          return 'published for review'
        case 'testing':
          return 'moved to testing'
        case 'product':
          return 'moved to product review'
        case 'done':
          return 'completed'
        case 'canceled':
          return 'canceled'
        case 'ready':
          return 'marked ready'
        case 'todo':
          return 'moved to todo'
        default:
          return entry.status ? `moved to ${entry.status.replace(/_/g, ' ')}` : 'changed status'
      }
    case 'claim':
      return 'claimed'
    case 'evidence':
      return 'recorded evidence'
    case 'feedback':
      return 'logged feedback'
    case 'needs_input':
      return 'asked for input'
    case 'artifact':
      if (entry.artifactStatus === 'approved') return 'approved artifact'
      if (entry.artifactStatus === 'changes_requested') return 'requested artifact changes'
      if (entry.artifactStatus === 'ready_for_review') return 'submitted artifact'
      return entry.artifactStatus
        ? `artifact ${entry.artifactStatus.replace(/_/g, ' ')}`
        : 'recorded artifact'
    case 'system':
      return 'system event'
    default:
      return 'updated'
  }
}

function TaskActivityFeed({
  entries,
  emptyLabel,
}: {
  entries: SprintEngineTaskActivityEntry[]
  emptyLabel: string
}) {
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(() => new Set())

  const filteredEntries = useMemo(() => {
    if (filter === 'all') return entries
    return entries.filter((entry) => ACTIVITY_TYPE_TO_FILTER[entry.type] === filter)
  }, [entries, filter])

  const groups = useMemo(() => groupActivityEntries(filteredEntries), [filteredEntries])

  const toggleExpanded = useCallback((id: string) => {
    setExpandedMessages((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-[11px] font-semibold text-[color:var(--text-muted)]">Activity</div>
        <div className="flex gap-0.5" role="group" aria-label="Filter activity">
          {ACTIVITY_FILTERS.map((option) => {
            const active = filter === option.key
            return (
              <button
                key={option.key}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(option.key)}
                className={`interactive rounded px-2 py-1 text-[11px] transition-colors ${
                  active
                    ? 'bg-[color:var(--accent-primary-soft)] text-[color:var(--accent-primary)]'
                    : 'text-[color:var(--text-muted)] hover:text-[color:var(--text-strong)]'
                }`}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="text-[12px] text-[color:var(--text-disabled)]">
          {entries.length === 0 ? emptyLabel : 'No entries match this filter.'}
        </div>
      ) : (
        <ol className="divide-y divide-[color:var(--border-subtle)] border-y border-[color:var(--border-subtle)]">
          {groups.map((group) => {
            const entry = group.primary
            const count = group.members.length
            const tone = activityEntryTone(entry)
            const absolute = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : undefined
            const relative = entry.timestamp ? formatRelativeTime(entry.timestamp) : '—'
            const showMessage = activityMessageIsVisible(entry)
            const expanded = expandedMessages.has(entry.id)
            return (
              <li
                key={group.key}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-2 py-2.5 text-[12px] leading-5 text-[color:var(--text-default)]"
              >
                <span className="mt-[0.35rem]">
                  <StatusDot tone={tone} />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] text-[color:var(--text-muted)]">
                    <span className="font-mono text-[11px] text-[color:var(--text-default)]">
                      {entry.actor}
                    </span>
                    <span>{activityVerb(entry)}</span>
                    {count > 1 ? (
                      <span className="tabular-nums text-[color:var(--text-disabled)]">
                        ×{count}
                      </span>
                    ) : null}
                  </div>
                  {showMessage ? (
                    <CollapsibleMessage
                      message={entry.message}
                      expanded={expanded}
                      onToggle={() => toggleExpanded(entry.id)}
                      className="mt-0.5 text-[color:var(--text-default)] [overflow-wrap:anywhere]"
                    />
                  ) : null}
                </div>
                <span
                  title={absolute}
                  className="tabular-nums font-mono text-[10.5px] text-[color:var(--text-disabled)]"
                >
                  {relative}
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

function TaskOpenFeedbackComments({ comments }: { comments: SprintEngineTaskComment[] }) {
  if (comments.length === 0) return null
  return (
    <div>
      <div className="mb-2 text-[11px] font-semibold text-[color:var(--tone-warn)]">
        Open feedback ({comments.length})
      </div>
      <div className="space-y-3">
        {comments.map((comment) => (
          <TaskCommentRow key={comment.id} comment={comment} />
        ))}
      </div>
    </div>
  )
}

const taskDiffStatusLabels: Record<SprintEngineTaskDiff['status'], string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  type_changed: 'Type changed',
  unmerged: 'Unmerged',
  unknown: 'Unknown',
}

// Diff capture runs on `task publish` and `task status --status done`, so the
// section is only meaningful once a task has reached a post-publish state.
const diffCaptureStatuses: ReadonlyArray<SprintEngineTask['status']> = [
  'review',
  'testing',
  'product',
  'done',
  'changes_requested',
]

function diffLineToneClass(line: SprintEngineTaskDiffLine): string {
  if (line.type === 'added') return 'bg-[color:var(--tone-good-soft)] text-[color:var(--diff-added)]'
  if (line.type === 'removed') return 'bg-[color:var(--tone-error-soft)] text-[color:var(--diff-removed)]'
  return 'text-[color:var(--diff-context)]'
}

function diffLinePrefix(line: SprintEngineTaskDiffLine): string {
  if (line.type === 'added') return '+'
  if (line.type === 'removed') return '-'
  return ' '
}

function formatDiffMeta(diff: SprintEngineTaskDiff): string {
  const parts: string[] = [taskDiffStatusLabels[diff.status]]
  if (diff.oldPath) parts.push(`from ${diff.oldPath}`)
  if (diff.skippedReason) {
    parts.push(`skipped (${diff.skippedReason.replace(/_/g, ' ')})`)
  } else if (diff.binary) {
    parts.push('binary')
  }
  if (diff.truncated) parts.push('truncated')
  return parts.join(' · ')
}

function DiffLineRow({ line }: { line: SprintEngineTaskDiffLine }) {
  return (
    <div className={`grid min-w-max grid-cols-[3.25rem_3.25rem_1.5rem_minmax(24rem,1fr)] gap-2 px-3 py-0.5 font-mono text-[11px] leading-5 tabular-nums ${diffLineToneClass(line)}`}>
      <span className="select-none text-right text-[color:var(--text-disabled)]">{line.oldLine ?? ''}</span>
      <span className="select-none text-right text-[color:var(--text-disabled)]">{line.newLine ?? ''}</span>
      <span className="select-none text-center">{diffLinePrefix(line)}</span>
      <span className="whitespace-pre">{line.content || ' '}</span>
    </div>
  )
}

function ChangedFileDiff({ diff }: { diff: SprintEngineTaskDiff }) {
  if (diff.hunks.length === 0) {
    return (
      <div className="border-t border-[color:var(--border-subtle)] px-3 py-2 text-[12px] text-[color:var(--text-disabled)]">
        No hunks captured for this file.
      </div>
    )
  }

  return (
    <div className="max-h-[28rem] overflow-auto border-t border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)]">
      {diff.hunks.map((hunk, index) => (
        <div key={`${diff.path}:${index}`} className="border-b border-[color:var(--border-subtle)] last:border-b-0">
          <div className="min-w-max px-3 py-1.5 font-mono text-[11px] text-[color:var(--text-muted)]">
            @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
            {hunk.section ? <span className="ml-2">{hunk.section}</span> : null}
          </div>
          {hunk.lines.map((line, lineIndex) => (
            <DiffLineRow key={`${line.oldLine ?? 'x'}:${line.newLine ?? 'x'}:${lineIndex}`} line={line} />
          ))}
        </div>
      ))}
    </div>
  )
}

function ChangedFilesSection({ task }: { task: SprintEngineTask }) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set())
  const diffs = task.evidence.diffs ?? []
  const captureExpected = diffCaptureStatuses.includes(task.status)

  if (!captureExpected && diffs.length === 0) return null

  if (diffs.length === 0) {
    return (
      <div className="text-[12px] text-[color:var(--text-disabled)]">
        Diff capture unavailable. Republish the task or check the worker log.
      </div>
    )
  }

  const toggle = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <div className="divide-y divide-[color:var(--border-subtle)] border-t border-[color:var(--border-subtle)]">
      {diffs.map((diff, index) => {
          const expandable = diff.hunks.length > 0 && !diff.skippedReason
          const expanded = expandable && expandedPaths.has(diff.path)
          const panelId = `task-diff-${index}-${diff.path.replace(/[^A-Za-z0-9_-]+/g, '-')}`
          const rowContent = (
            <>
              <span className="min-w-0">
                <span className="block font-mono text-[12px] text-[color:var(--text-strong)] [overflow-wrap:anywhere]">
                  {diff.path}
                </span>
                <span className="mt-0.5 block text-[11px] text-[color:var(--text-muted)] [overflow-wrap:anywhere]">
                  {formatDiffMeta(diff)}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-3 font-mono text-[11px] tabular-nums">
                <span className="text-[color:var(--diff-added)]">+{diff.additions}</span>
                <span className="text-[color:var(--diff-removed)]">-{diff.deletions}</span>
                <span
                  aria-hidden="true"
                  className={`inline-block w-[1ch] text-[color:var(--text-disabled)] transition-transform ${
                    expandable ? '' : 'invisible'
                  } ${expanded ? 'rotate-90' : ''}`}
                >
                  ›
                </span>
              </span>
            </>
          )
          const rowLayout = 'grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-2 text-left'

          return (
            <div key={`${diff.path}:${diff.oldPath ?? ''}:${index}`}>
              {expandable ? (
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={panelId}
                  onClick={() => toggle(diff.path)}
                  className={`${rowLayout} interactive transition-colors hover:bg-[color:var(--bg-hover)] focus:outline-none focus:ring-1 focus:ring-[color:var(--border-strong)]`}
                >
                  {rowContent}
                </button>
              ) : (
                <div className={rowLayout}>{rowContent}</div>
              )}
            {expanded ? (
              <div id={panelId}>
                <ChangedFileDiff diff={diff} />
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Inspector panel — task / artifact / agent / preview branches.
// ──────────────────────────────────────────────────────────────────────────

// Arrows-out (expand) and arrows-in (collapse) corner glyphs. Borderless icon
// next to CloseIconButton in every closable inspector header. The pattern
// matches Notion's side-peek and Figma's panel expand.
function InspectorChromeActions({
  expanded,
  onToggleExpand,
  onClose,
  closeLabel,
}: {
  expanded: boolean
  onToggleExpand: () => void
  onClose: () => void
  closeLabel: string
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <IconButton
        onClick={onToggleExpand}
        aria-label={expanded ? 'Collapse inspector' : 'Expand inspector'}
      >
        <svg className="icon-sm" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          {expanded ? (
            <>
              <path d="M11.5 5.5L8.5 5.5L8.5 2.5M8.5 5.5L12.5 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2.5 8.5L5.5 8.5L5.5 11.5M5.5 8.5L1.5 12.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </>
          ) : (
            <>
              <path d="M9.5 1.5L12.5 1.5L12.5 4.5M12.5 1.5L8.5 5.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M4.5 12.5L1.5 12.5L1.5 9.5M1.5 12.5L5.5 8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </>
          )}
        </svg>
      </IconButton>
      <CloseIconButton onClick={onClose} aria-label={closeLabel} />
    </div>
  )
}

export function SprintEngineInspectorPanel({
  selection,
  sprintEngineState,
  runtimeAgents,
  tasksById,
  selectedTaskBoardColumn,
  selectedTaskStatusLabel,
  selectedTaskOwnerLabel,
  selectedTaskNeedsInputNote,
  selectedTaskArtifacts,
  selectedTaskArtifactBlockers,
  artifactActions,
  onClose,
  onSelectTask,
  onOpenArtifact,
  onApproveArtifact,
  onRequestArtifactChanges,
  onBackFromArtifact,
  onPopOutArtifact,
  onSpawnAgent,
  onOpenAgentTerminal,
  isAgentTerminalLive,
  isExpanded,
  onToggleExpand,
}: {
  selection: SprintEngineInspectorSelection
  sprintEngineState: import('../../types/workspace').SprintEngineState
  runtimeAgents: RuntimeAgentView[]
  tasksById: Record<string, SprintEngineTask>
  selectedTaskBoardColumn: SprintEngineTaskBoardColumn | null
  selectedTaskStatusLabel: string
  selectedTaskOwnerLabel: string
  selectedTaskNeedsInputNote: string | null
  selectedTaskArtifacts: SprintEngineArtifact[]
  selectedTaskArtifactBlockers: ReturnType<typeof getSprintEngineArtifactDependencyBlockers>
  artifactActions: Record<string, ArtifactActionState>
  onClose: () => void
  onSelectTask: (taskId: string) => void
  onOpenArtifact: (artifact: SprintEngineArtifact) => void | Promise<void>
  onApproveArtifact: (artifact: SprintEngineArtifact) => void | Promise<void>
  onRequestArtifactChanges: (artifact: SprintEngineArtifact) => void
  onBackFromArtifact: () => void
  onPopOutArtifact: () => void
  onSpawnAgent: (agentId: string) => void
  onOpenAgentTerminal: (agentId: string) => void
  isAgentTerminalLive: (agentId: string) => boolean
  isExpanded: boolean
  onToggleExpand: () => void
}) {
  if (selection.kind === 'artifact-preview') {
    return (
      <FilePreviewPane
        title={
          <span className="text-[13px] font-semibold text-[color:var(--text-strong)]">
            {selection.artifact.name}
          </span>
        }
        path={selection.artifact.path}
        content={selection.artifact.content}
        onBack={onBackFromArtifact}
        onPopOut={onPopOutArtifact}
      />
    )
  }

  if (selection.kind === 'artifact') {
    const artifact = selection.artifact
    return (
      <SprintEngineArtifactInspector
        artifact={artifact}
        task={tasksById[artifact.taskId]}
        actionState={artifactActions[artifact.id]}
        onClose={onClose}
        onOpenArtifact={onOpenArtifact}
        onApproveArtifact={onApproveArtifact}
        onRequestArtifactChanges={onRequestArtifactChanges}
        onSelectTask={onSelectTask}
        isExpanded={isExpanded}
        onToggleExpand={onToggleExpand}
      />
    )
  }

  if (selection.kind === 'agent') {
    const agent = selection.agent
    const runtime = runtimeAgents.find((entry) => entry.agentId === agent.id) ?? null
    const hasLiveTerminal = isAgentTerminalLive(agent.id)
    const currentTask = runtime?.currentTaskId
      ? sprintEngineState.tasks.find((task) => task.id === runtime.currentTaskId) ?? null
      : null
    const tasksOwnedByAgent = sprintEngineState.tasks.filter((task) => task.ownerAgentId === agent.id)
    return (
      <div className="flex h-full min-h-0 flex-col">
        <header className="border-b border-[color:var(--border-default)] px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[11px] text-[color:var(--text-subtle)]">
                <RoleAvatar role={agent.role} size="sm" ariaLabel="" />
                <span>{sprintEngineRoleLabels[agent.role]}</span>
                <span>·</span>
                <span className="flex items-center gap-1.5">
                  <StatusDot tone={runtimeStatusTone(runtime?.status ?? (hasLiveTerminal ? 'running' : 'idle'))} />
                  {runtime?.status ?? (hasLiveTerminal ? 'running' : 'idle')}
                </span>
              </div>
              <h3 className="mt-2 truncate text-[18px] font-semibold leading-7 text-[color:var(--text-strong)]">
                {agent.label}
              </h3>
              <div className="mt-1 font-mono text-[11px] text-[color:var(--text-disabled)]">{agent.id}</div>
            </div>
            <InspectorChromeActions
              expanded={isExpanded}
              onToggleExpand={onToggleExpand}
              onClose={onClose}
              closeLabel="Close agent detail"
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {hasLiveTerminal ? (
              <button
                type="button"
                onClick={() => onOpenAgentTerminal(agent.id)}
                className="h-7 rounded border border-[color:var(--border-strong)] px-2.5 text-[11px] font-medium text-[color:var(--text-default)] interactive transition-colors hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-strong)]"
              >
                Open Terminal
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onSpawnAgent(agent.id)}
                className="h-7 rounded border border-[color:var(--accent-primary)] bg-[color:var(--accent-primary-soft)] px-2.5 text-[11px] font-semibold text-[color:var(--accent-primary)] interactive transition-colors hover:bg-[color:var(--accent-primary-soft-strong)]"
              >
                Spawn {sprintEngineRoleLabels[agent.role]}
              </button>
            )}
          </div>
        </header>

        <div className="flex-1 space-y-5 overflow-auto px-5 py-4 text-[13px] leading-6 text-[color:var(--text-default)]">
          <div>
            <div className="mb-2 text-[10px] font-bold text-[color:var(--text-disabled)]">Currently Working On</div>
            {currentTask ? (
              <button
                type="button"
                onClick={() => onSelectTask(currentTask.id)}
                className="block w-full rounded-md border border-[color:var(--border-default)] px-3 py-2 text-left interactive transition-colors hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-surface-raised)]"
              >
                <div className="font-mono text-[11px] text-[color:var(--tone-warn)]">{currentTask.id}</div>
                <div className="mt-1 truncate text-sm font-semibold text-[color:var(--text-strong)]">{currentTask.title}</div>
              </button>
            ) : (
              <div className="text-[color:var(--text-subtle)]">No active task assignment.</div>
            )}
          </div>

          <div>
            <div className="mb-2 text-[10px] font-bold text-[color:var(--text-disabled)]">
              Assigned Tasks ({tasksOwnedByAgent.length})
            </div>
            {tasksOwnedByAgent.length === 0 ? (
              <div className="text-[color:var(--text-subtle)]">No tasks assigned.</div>
            ) : (
              <ul className="divide-y divide-[color:var(--border-default)] border-y border-[color:var(--border-default)]">
                {tasksOwnedByAgent.map((task) => (
                  <li key={task.id}>
                    <button
                      type="button"
                      onClick={() => onSelectTask(task.id)}
                      className="block w-full px-1 py-2.5 text-left interactive transition-colors hover:bg-[color:var(--bg-surface-raised)]"
                    >
                      <div className="flex items-center gap-2 text-[11px]">
                        <span className="font-mono text-[color:var(--tone-warn)]">{task.id}</span>
                        <span className="text-[color:var(--text-subtle)]">{task.status}</span>
                      </div>
                      <div className="mt-0.5 truncate text-sm text-[color:var(--text-strong)]">{task.title}</div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    )
  }

  // Task mode (default branch).
  const selectedTask = selection.task
  const tone = boardColumnTone(selectedTaskBoardColumn)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-[color:var(--border-default)] px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] text-[color:var(--text-subtle)]">
              <StatusDot tone={tone} />
              <span>{selectedTaskStatusLabel}</span>
              <span>·</span>
              <span className="font-mono tabular-nums text-[color:var(--text-muted)]">
                {selectedTask.id}
              </span>
            </div>
            <h3 className="mt-2 text-[18px] font-semibold leading-7 text-[color:var(--text-strong)]">
              {selectedTask.title}
            </h3>
          </div>
          <InspectorChromeActions
            expanded={isExpanded}
            onToggleExpand={onToggleExpand}
            onClose={onClose}
            closeLabel="Close task detail"
          />
        </div>
      </header>

      <SprintEngineTaskBody
        key={selectedTask.id}
        selectedTask={selectedTask}
        selectedTaskOwnerLabel={selectedTaskOwnerLabel}
        selectedTaskNeedsInputNote={selectedTaskNeedsInputNote}
        selectedTaskArtifacts={selectedTaskArtifacts}
        selectedTaskArtifactBlockers={selectedTaskArtifactBlockers}
        artifactActions={artifactActions}
        tasksById={tasksById}
        runtimeAgents={runtimeAgents}
        onSelectTask={onSelectTask}
        onOpenArtifact={onOpenArtifact}
        onApproveArtifact={onApproveArtifact}
        onRequestArtifactChanges={onRequestArtifactChanges}
        onOpenAgentTerminal={onOpenAgentTerminal}
        isAgentTerminalLive={isAgentTerminalLive}
      />
    </div>
  )
}

function SprintEngineTaskBody({
  selectedTask,
  selectedTaskOwnerLabel,
  selectedTaskNeedsInputNote,
  selectedTaskArtifacts,
  selectedTaskArtifactBlockers,
  artifactActions,
  tasksById,
  runtimeAgents,
  onSelectTask,
  onOpenArtifact,
  onApproveArtifact,
  onRequestArtifactChanges,
  onOpenAgentTerminal,
  isAgentTerminalLive,
}: {
  selectedTask: SprintEngineTask
  selectedTaskOwnerLabel: string
  selectedTaskNeedsInputNote: string | null
  selectedTaskArtifacts: SprintEngineArtifact[]
  selectedTaskArtifactBlockers: ReturnType<typeof getSprintEngineArtifactDependencyBlockers>
  artifactActions: Record<string, ArtifactActionState>
  tasksById: Record<string, SprintEngineTask>
  runtimeAgents: RuntimeAgentView[]
  onSelectTask: (taskId: string) => void
  onOpenArtifact: (artifact: SprintEngineArtifact) => void | Promise<void>
  onApproveArtifact: (artifact: SprintEngineArtifact) => void | Promise<void>
  onRequestArtifactChanges: (artifact: SprintEngineArtifact) => void
  onOpenAgentTerminal: (agentId: string) => void
  isAgentTerminalLive: (agentId: string) => boolean
}) {
  const openIssues = getOpenSprintEngineFeedbackIssues(selectedTask.feedback)
  const openFindings = getOpenSprintEngineFeedbackFindings(selectedTask.feedback)
  const activityEntries = getSprintEngineTaskActivityDescending(selectedTask)
  const openFeedbackComments = getOpenSprintEngineFeedbackComments(selectedTask)
  const [view, setView] = useState<'activity' | 'diff'>('activity')
  const tabIdPrefix = useId()
  const diffCount = selectedTask.evidence.diffs?.length ?? 0
  const captureExpected = diffCaptureStatuses.includes(selectedTask.status)
  const showDiffTab = captureExpected || diffCount > 0
  const tabItems: TabItem<'activity' | 'diff'>[] = [
    { id: 'activity', label: 'Activity' },
    { id: 'diff', label: 'Diff', ...(diffCount > 0 ? { count: diffCount } : {}) },
  ]
  const effectiveView = showDiffTab ? view : 'activity'

  const activityStream = (
    <>
      <TaskActivityFeed entries={activityEntries} emptyLabel="No activity recorded yet." />
      <TaskOpenFeedbackComments comments={openFeedbackComments} />
    </>
  )

  return (
    <div className="flex-1 space-y-5 overflow-auto px-5 py-4 text-[13px] leading-6 text-[color:var(--text-default)]">
      <TaskOwnerLine
        task={selectedTask}
        ownerLabel={selectedTaskOwnerLabel}
        runtimeAgents={runtimeAgents}
        isAgentTerminalLive={isAgentTerminalLive}
        onOpenAgentTerminal={onOpenAgentTerminal}
      />

      {selectedTaskNeedsInputNote ? (
        <TaskCallout tone="warn" label="Needs input">
          <div>{selectedTaskNeedsInputNote}</div>
          <div className="mt-1 text-[11px] text-[color:var(--text-muted)]">
            Respond in the worker CLI to unblock this task.
          </div>
        </TaskCallout>
      ) : null}

      {selectedTaskArtifactBlockers.length > 0 ? (
        <ArtifactBlockerList blockers={selectedTaskArtifactBlockers} />
      ) : null}

      <TaskOpenFindings issues={openIssues} findings={openFindings} />

      {/* Description — top of the body, untitled; typography carries
          the hierarchy. */}
      <div className="text-[13px] leading-6 text-[color:var(--text-default)]">
        {selectedTask.description || (
          <span className="text-[color:var(--text-disabled)]">No description recorded.</span>
        )}
      </div>

      {selectedTask.acceptanceCriteria.length > 0 ? (
        <ul className="space-y-1.5 text-[12.5px] text-[color:var(--text-default)]">
          {selectedTask.acceptanceCriteria.map((criterion) => (
            <li
              key={criterion}
              className="grid grid-cols-[14px_minmax(0,1fr)] items-baseline gap-2"
            >
              <AcceptanceCheckbox checked={selectedTask.status === 'done'} />
              <span className="[overflow-wrap:anywhere]">{criterion}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <TaskQualityGates
        task={selectedTask}
        runtimeAgents={runtimeAgents}
        isAgentTerminalLive={isAgentTerminalLive}
        onOpenAgentTerminal={onOpenAgentTerminal}
      />

      <TaskScoresLine task={selectedTask} />

      {showDiffTab ? (
        <div>
          <Tabs<'activity' | 'diff'>
            ariaLabel="Task detail views"
            idPrefix={tabIdPrefix}
            items={tabItems}
            value={effectiveView}
            onChange={setView}
          />
          <TabPanel
            idPrefix={tabIdPrefix}
            tabId="activity"
            active={effectiveView === 'activity'}
            className="mt-4 space-y-5"
          >
            {activityStream}
          </TabPanel>
          <TabPanel
            idPrefix={tabIdPrefix}
            tabId="diff"
            active={effectiveView === 'diff'}
            className="mt-4"
          >
            <ChangedFilesSection task={selectedTask} />
          </TabPanel>
        </div>
      ) : (
        <div className="space-y-5">{activityStream}</div>
      )}

      {/* Compact details — secondary metadata. Hairline-divided, untitled
          section headings reserved for hierarchy that earns them. */}
      <div className="border-t border-[color:var(--border-subtle)] pt-4">
        <DefinitionList
          layout="compact-grid"
          items={[
            { term: 'Source', description: formatTaskSourceLabel(selectedTask) },
            { term: 'Owner', description: selectedTaskOwnerLabel },
            {
              term: 'Depends on',
              description: selectedTask.dependsOn.length > 0 ? selectedTask.dependsOn.join(', ') : 'None',
            },
            {
              term: selectedTask.completedAt ? 'Completed' : 'Started',
              description: formatTimestamp(selectedTask.completedAt ?? selectedTask.startedAt),
            },
          ]}
        />

        {selectedTask.source?.type === 'github' ? (
          <div className="mt-3 text-[12px] leading-5 text-[color:var(--text-default)]">
            <span className="text-[color:var(--text-muted)]">GitHub issue · </span>
            <span>
              {selectedTask.source.repo ? `${selectedTask.source.repo} ` : ''}
              {selectedTask.source.externalId ? `#${selectedTask.source.externalId}` : ''}
            </span>
            {formatTaskSyncStatusLabel(selectedTask) ? (
              <div className="mt-1 text-[11px] text-[color:var(--tone-warn)]">
                {formatTaskSyncStatusDescription(selectedTask)}
              </div>
            ) : null}
            {selectedTask.source.externalUrl ? (
              <button
                type="button"
                onClick={() => {
                  window.open(selectedTask.source?.externalUrl, '_blank', 'noopener,noreferrer')
                }}
                className="mt-1 text-[11px] text-[color:var(--accent-primary)] interactive transition-colors hover:text-[color:var(--accent-primary-hover)]"
              >
                Open issue →
              </button>
            ) : null}
          </div>
        ) : null}

        {selectedTask.triage ? (
          <div className="mt-3 border-l border-[color:var(--tone-warn-soft)] pl-3 text-[12px] leading-5 text-[color:var(--text-default)]">
            <div className="text-[11px] font-semibold text-[color:var(--tone-warn)]">
              Architect triage
            </div>
            <div className="mt-1">{selectedTask.triage.summary}</div>
          </div>
        ) : null}

        {/* Additional reference sections collapsed to keep the surface
            quiet. Open on demand. */}
        <details className="group mt-4">
          <summary className="cursor-pointer list-none text-[11px] font-semibold text-[color:var(--text-muted)] hover:text-[color:var(--text-default)]">
            <span className="mr-1 inline-block transition-transform group-open:rotate-90" aria-hidden="true">›</span>
            More
          </summary>
          <div className="mt-3 space-y-4">
            <SectionList title="Owned paths" items={selectedTask.ownedPaths} emptyLabel="No owned paths recorded." />
            <SectionList
              title="Implementation notes"
              items={selectedTask.implementationNotes}
              emptyLabel="No implementation notes recorded."
            />
            <SectionList title="Notes" items={selectedTask.notes} emptyLabel="No notes recorded." />

            <SprintEngineArtifactList
              artifacts={selectedTaskArtifacts}
              tasksById={tasksById}
              actions={artifactActions}
              emptyLabel="No review artifacts are attached to this task."
              onSelectTask={onSelectTask}
              onOpenArtifact={(artifact) => void onOpenArtifact(artifact)}
              onApproveArtifact={(artifact) => void onApproveArtifact(artifact)}
              onRequestArtifactChanges={onRequestArtifactChanges}
            />

            <div>
              <div className="mb-2 text-[11px] font-semibold text-[color:var(--text-muted)]">
                Evidence summary
              </div>
              <div>{selectedTask.evidence.summary || 'No completion summary recorded yet.'}</div>
            </div>

            <SectionList
              title="Commands run"
              items={selectedTask.evidence.commandsRan}
              emptyLabel="No commands recorded."
            />
            <SectionList
              title="Results"
              items={selectedTask.evidence.results}
              emptyLabel="No test or validation results recorded."
            />
            {selectedTask.evidence.diffs && selectedTask.evidence.diffs.length > 0 ? null : (
              <SectionList
                title="Touched files"
                items={selectedTask.evidence.touchedFiles}
                emptyLabel="No touched files recorded."
              />
            )}
          </div>
        </details>
      </div>
    </div>
  )
}
