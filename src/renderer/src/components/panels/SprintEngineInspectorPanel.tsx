// Sprint Engine inspector — the right-hand detail pane for tasks, artifacts,
// agents, and artifact previews. Extracted from SprintEngineBoardPanel.tsx so
// the orchestrator stays focused on state coordination and IPC plumbing while
// the inspector owns its own rendering, sub-components, and detail formatting.
//
// Data shaping lives next door in `sprintEngineInspector.ts`; the orchestrator
// passes hydrated derived values via props rather than letting the inspector
// reach back into the store directly.

import React from 'react'
import {
  feedbackFindingAreaLabels,
  feedbackFindingKindLabels,
  feedbackFindingSeverityLabels,
  feedbackFindingStatusLabels,
  feedbackIssueCategoryLabels,
  feedbackIssueSeverityLabels,
  feedbackIssueStatusLabels,
  feedbackScoreLabels,
} from '../../utils/sprintengineRunSummary'
import type {
  SprintEngineArtifact,
  SprintEngineTask,
  SprintEngineTaskActivityEntry,
  SprintEngineTaskBoardColumn,
  SprintEngineTaskFeedback,
  SprintEngineTaskFeedbackFinding,
  SprintEngineTaskFeedbackIssue,
} from '../../types/workspace'
import {
  getOpenSprintEngineFeedbackFindings,
  getOpenSprintEngineFeedbackIssues,
  getSprintEngineArtifactAutoApprovalEligibility,
  getSprintEngineArtifactDependencyBlockers,
  getSprintEngineTaskActivityDescending,
  sprintEngineArtifactKindLabels,
  sprintEngineArtifactStatusLabels,
  sprintEngineRoleLabels,
  sprintEngineTaskActivityLabels,
  sprintEngineTaskBoardColumns,
} from '../../utils/sprintengine'
import { formatRelativeTime } from '../../utils/switchboardBoard'
import {
  CloseIconButton,
  DefinitionList,
  FilePreviewPane,
  GhostButton,
  InboxRow,
  PrimaryButton,
  RoleAvatar,
  StatusDot,
  type DefinitionItem,
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
  type TaskReadyActionState,
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
      <div className="mb-2 text-[10px] font-bold text-[color:var(--text-disabled)]">{title}</div>
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

function AgentFeedback({ feedback }: { feedback: SprintEngineTaskFeedback }) {
  const scores = feedbackScoreLabels.flatMap((metric) => {
    const value = feedback.scores[metric.key]
    return typeof value === 'number' ? [{ ...metric, value }] : []
  })

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="text-[10px] font-bold text-[color:var(--text-disabled)]">Agent Feedback</div>
        <div className="text-[11px] text-[color:var(--text-disabled)]">
          {feedback.agentId} - {formatTimestamp(feedback.capturedAt)}
        </div>
      </div>
      {scores.length > 0 ? (
        <div className="grid gap-x-4 gap-y-2 md:grid-cols-2">
          {scores.map((metric) => (
            <div key={metric.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-[12px]">
              <span className="text-[color:var(--text-muted)]">{metric.label}</span>
              <span className="font-mono text-[color:var(--text-strong)]">{metric.value}%</span>
            </div>
          ))}
        </div>
      ) : null}
      {feedback.topFriction ? (
        <div className="mt-3 text-[12px] text-[color:var(--text-default)]">
          <span className="text-[color:var(--text-muted)]">Top friction: </span>
          {feedback.topFriction}
        </div>
      ) : null}
      {feedback.suggestedImprovement ? (
        <div className="mt-1 text-[12px] text-[color:var(--text-default)]">
          <span className="text-[color:var(--text-muted)]">Suggested improvement: </span>
          {feedback.suggestedImprovement}
        </div>
      ) : null}
      {feedback.issues && feedback.issues.length > 0 ? (
        <PromptImprovementIssues issues={feedback.issues} className="mt-4" />
      ) : null}
      {feedback.findings && feedback.findings.length > 0 ? (
        <RoleFindings findings={feedback.findings} className="mt-4" />
      ) : null}
    </div>
  )
}

function PromptImprovementIssues({
  issues,
  className = '',
}: {
  issues: SprintEngineTaskFeedbackIssue[]
  className?: string
}) {
  if (issues.length === 0) return null

  return (
    <div className={className}>
      <div className="mb-2 text-[10px] font-bold text-[color:var(--text-disabled)]">
        Prompt Improvement Signals
      </div>
      <div className="space-y-3">
        {issues.map((issue) => (
          <div key={issue.id} className="rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] p-3">
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="font-semibold text-[color:var(--text-strong)]">{issue.title}</span>
              <span className="text-[color:var(--text-disabled)]">{feedbackIssueCategoryLabels[issue.category]}</span>
              <span className="text-[color:var(--text-disabled)]">{feedbackIssueSeverityLabels[issue.severity]}</span>
              <span className="text-[color:var(--text-disabled)]">{feedbackIssueStatusLabels[issue.status ?? 'new']}</span>
              {issue.target ? <span className="font-mono text-[color:var(--text-muted)]">{issue.target}</span> : null}
            </div>
            <div className="mt-2 text-[12px] leading-5 text-[color:var(--text-default)]">{issue.detail}</div>
            {issue.evidence ? (
              <div className="mt-2 text-[12px] leading-5 text-[color:var(--text-muted)]">Evidence: {issue.evidence}</div>
            ) : null}
            {issue.suggestedPromptChange ? (
              <div className="mt-2 text-[12px] leading-5 text-[color:var(--text-default)]">
                <span className="text-[color:var(--text-muted)]">Prompt change: </span>
                {issue.suggestedPromptChange}
              </div>
            ) : null}
            {issue.suggestedProcessChange ? (
              <div className="mt-1 text-[12px] leading-5 text-[color:var(--text-default)]">
                <span className="text-[color:var(--text-muted)]">Process change: </span>
                {issue.suggestedProcessChange}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}

function RoleFindings({
  findings,
  className = '',
}: {
  findings: SprintEngineTaskFeedbackFinding[]
  className?: string
}) {
  if (findings.length === 0) return null

  return (
    <div className={className}>
      <div className="mb-2 text-[10px] font-bold text-[color:var(--text-disabled)]">Role Findings</div>
      <div className="space-y-3">
        {findings.map((finding) => (
          <div key={finding.id} className="rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] p-3">
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="font-semibold text-[color:var(--text-strong)]">{finding.title}</span>
              <span className="text-[color:var(--text-disabled)]">{feedbackFindingKindLabels[finding.kind]}</span>
              <span className="text-[color:var(--text-disabled)]">{feedbackFindingSeverityLabels[finding.severity]}</span>
              <span className="text-[color:var(--text-disabled)]">{feedbackFindingAreaLabels[finding.area]}</span>
              <span className="text-[color:var(--text-disabled)]">{feedbackFindingStatusLabels[finding.status ?? 'open']}</span>
              {finding.requirementId ? <span className="font-mono text-[color:var(--text-muted)]">{finding.requirementId}</span> : null}
              {finding.file ? <span className="font-mono text-[color:var(--text-muted)] [overflow-wrap:anywhere]">{finding.file}</span> : null}
            </div>
            <div className="mt-2 text-[12px] leading-5 text-[color:var(--text-default)]">{finding.detail}</div>
            {finding.recommendation ? (
              <div className="mt-2 text-[12px] leading-5 text-[color:var(--text-default)]">
                <span className="text-[color:var(--text-muted)]">Recommendation: </span>
                {finding.recommendation}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}

function ActivityTimeline({
  entries,
  emptyLabel,
}: {
  entries: SprintEngineTaskActivityEntry[]
  emptyLabel: string
}) {
  if (entries.length === 0) {
    return (
      <div>
        <div className="mb-2 text-[10px] font-bold text-[color:var(--text-disabled)]">Activity</div>
        <div className="text-[12px] text-[color:var(--text-disabled)]">{emptyLabel}</div>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-2 text-[10px] font-bold text-[color:var(--text-disabled)]">Activity</div>
      <ol className="space-y-1.5 text-[12px] leading-5 text-[color:var(--text-default)]">
        {entries.map((entry) => {
          const timestamp = entry.timestamp
          const absolute = timestamp ? new Date(timestamp).toLocaleString() : undefined
          const relative = timestamp ? formatRelativeTime(timestamp) : '—'
          const detail = entry.type === 'status_change' && entry.status
            ? `${entry.message} (→ ${entry.status})`
            : entry.message
          return (
            <li
              key={entry.id}
              className="grid grid-cols-[6.5rem_auto_minmax(0,1fr)_auto] items-baseline gap-2"
            >
              <span className="font-mono text-[10px] text-[color:var(--text-muted)]">
                {sprintEngineTaskActivityLabels[entry.type]}
              </span>
              <span className="font-mono text-[11px] text-[color:var(--text-muted)]">{entry.actor}</span>
              <span className="[overflow-wrap:anywhere]">{detail}</span>
              <span
                title={absolute}
                className="tabular-nums font-mono text-[11px] text-[color:var(--text-disabled)]"
              >
                {relative}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function OpenFeedbackSummary({
  issues,
  findings,
}: {
  issues: SprintEngineTaskFeedbackIssue[]
  findings: SprintEngineTaskFeedbackFinding[]
}) {
  if (issues.length === 0 && findings.length === 0) return null
  return (
    <div className="border-l border-[color:var(--tone-warn-soft)] pl-3">
      <div className="mb-2 text-[10px] font-bold text-[color:var(--tone-warn)]">
        Open Feedback ({issues.length + findings.length})
      </div>
      <ul className="space-y-1.5 text-[12px] leading-5 text-[color:var(--text-default)]">
        {issues.map((issue) => (
          <li key={issue.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-2">
            <span className="font-mono text-[10px] text-[color:var(--tone-warn)]">Issue</span>
            <span className="[overflow-wrap:anywhere]">
              <span className="font-semibold text-[color:var(--text-strong)]">{issue.title}</span>
              {issue.detail ? <span className="ml-2 text-[color:var(--text-muted)]">{issue.detail}</span> : null}
            </span>
            <span className="font-mono text-[10px] uppercase text-[color:var(--text-disabled)]">
              {feedbackIssueSeverityLabels[issue.severity]}
            </span>
          </li>
        ))}
        {findings.map((finding) => (
          <li key={finding.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-2">
            <span className="font-mono text-[10px] text-[color:var(--tone-warn)]">Finding</span>
            <span className="[overflow-wrap:anywhere]">
              <span className="font-semibold text-[color:var(--text-strong)]">{finding.title}</span>
              {finding.detail ? <span className="ml-2 text-[color:var(--text-muted)]">{finding.detail}</span> : null}
            </span>
            <span className="font-mono text-[10px] uppercase text-[color:var(--text-disabled)]">
              {feedbackFindingSeverityLabels[finding.severity]}
            </span>
          </li>
        ))}
      </ul>
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
}: {
  artifact: SprintEngineArtifact
  task: SprintEngineTask | undefined
  actionState: ArtifactActionState | undefined
  onClose: () => void
  onOpenArtifact: (artifact: SprintEngineArtifact) => void
  onApproveArtifact: (artifact: SprintEngineArtifact) => void
  onRequestArtifactChanges: (artifact: SprintEngineArtifact) => void
  onSelectTask: (taskId: string) => void
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
          <CloseIconButton onClick={onClose} aria-label="Close artifact detail" />
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
          <div className="text-[10px] font-bold text-[color:var(--text-disabled)]">{title}</div>
          {artifacts.length > 0 ? (
            <span className="text-[11px] font-semibold text-[color:var(--text-disabled)]">
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
      <div className="text-[10px] font-bold text-[color:var(--tone-warn)]">Blocked by review</div>
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

export function SprintEngineInspectorPanel({
  selection,
  sprintEngineState,
  runtimeAgents,
  tasksById,
  selectedTaskBoardColumn,
  selectedTaskStatusLabel,
  selectedTaskOwnerLabel,
  selectedTaskNeedsInputNote,
  selectedTaskCanMarkReady,
  selectedTaskCanSpawnWorker,
  selectedTaskCanManageWorker,
  selectedTaskOwnerCliRunning,
  selectedTaskArtifacts,
  selectedTaskArtifactBlockers,
  taskReadyActions,
  artifactActions,
  onClose,
  onSelectTask,
  onMarkTaskReady,
  onOpenReadyTaskWorker,
  onOpenArtifact,
  onApproveArtifact,
  onRequestArtifactChanges,
  onBackFromArtifact,
  onPopOutArtifact,
  onSpawnAgent,
  onOpenAgentTerminal,
  isAgentTerminalLive,
}: {
  selection: SprintEngineInspectorSelection
  sprintEngineState: import('../../types/workspace').SprintEngineState
  runtimeAgents: RuntimeAgentView[]
  tasksById: Record<string, SprintEngineTask>
  selectedTaskBoardColumn: SprintEngineTaskBoardColumn | null
  selectedTaskStatusLabel: string
  selectedTaskOwnerLabel: string
  selectedTaskNeedsInputNote: string | null
  selectedTaskCanMarkReady: boolean
  selectedTaskCanSpawnWorker: boolean
  selectedTaskCanManageWorker: boolean
  selectedTaskOwnerCliRunning: boolean
  selectedTaskArtifacts: SprintEngineArtifact[]
  selectedTaskArtifactBlockers: ReturnType<typeof getSprintEngineArtifactDependencyBlockers>
  taskReadyActions: Record<string, TaskReadyActionState>
  artifactActions: Record<string, ArtifactActionState>
  onClose: () => void
  onSelectTask: (taskId: string) => void
  onMarkTaskReady: (task: SprintEngineTask) => void | Promise<void>
  onOpenReadyTaskWorker: (task: SprintEngineTask) => void
  onOpenArtifact: (artifact: SprintEngineArtifact) => void | Promise<void>
  onApproveArtifact: (artifact: SprintEngineArtifact) => void | Promise<void>
  onRequestArtifactChanges: (artifact: SprintEngineArtifact) => void
  onBackFromArtifact: () => void
  onPopOutArtifact: () => void
  onSpawnAgent: (agentId: string) => void
  onOpenAgentTerminal: (agentId: string) => void
  isAgentTerminalLive: (agentId: string) => boolean
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
            <CloseIconButton onClick={onClose} aria-label="Close agent detail" />
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
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-[color:var(--border-default)] px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] text-[color:var(--text-subtle)]">
              <span className="font-mono tabular-nums text-[12px] text-[color:var(--text-muted)]">{selectedTask.id}</span>
              <span>·</span>
              <span className="flex items-center gap-1.5">
                <SprintEngineTaskStatusIcon
                  column={selectedTaskBoardColumn ?? 'todo'}
                  className="h-3 w-3 text-[color:var(--text-muted)]"
                />
                {selectedTaskStatusLabel}
              </span>
              <span>·</span>
              <span>{sprintEngineRoleLabels[selectedTask.role]}</span>
            </div>
            <h3 className="mt-2 text-[18px] font-semibold leading-7 text-[color:var(--text-strong)]">
              {selectedTask.title}
            </h3>
          </div>
          <CloseIconButton onClick={onClose} aria-label="Close task detail" />
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {selectedTaskCanMarkReady ? (
            <button
              type="button"
              disabled={taskReadyActions[selectedTask.id]?.status === 'pending'}
              onClick={() => void onMarkTaskReady(selectedTask)}
              className="h-7 rounded border border-[color:var(--tone-warn-soft)] bg-[color:var(--tone-warn-soft)] px-2.5 text-[11px] font-semibold text-[color:var(--tone-warn)] interactive transition-colors hover:bg-[color:var(--tone-warn-soft)] disabled:cursor-wait disabled:opacity-60"
            >
              Move To Ready
            </button>
          ) : null}
          {selectedTaskCanSpawnWorker || (selectedTask.ownerAgentId && selectedTaskCanManageWorker) ? (
            <button
              type="button"
              onClick={() => onOpenReadyTaskWorker(selectedTask)}
              className="h-7 rounded border border-[color:var(--border-strong)] px-2.5 text-[11px] font-medium text-[color:var(--text-default)] interactive transition-colors hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-strong)]"
            >
              {selectedTask.ownerAgentId
                ? selectedTaskOwnerCliRunning ? 'Open Terminal' : 'Respawn'
                : `Spawn ${sprintEngineRoleLabels[selectedTask.role]}`}
            </button>
          ) : null}
        </div>
      </header>

      <SprintEngineTaskBody
        selectedTask={selectedTask}
        selectedTaskOwnerLabel={selectedTaskOwnerLabel}
        selectedTaskNeedsInputNote={selectedTaskNeedsInputNote}
        selectedTaskArtifacts={selectedTaskArtifacts}
        selectedTaskArtifactBlockers={selectedTaskArtifactBlockers}
        taskReadyActions={taskReadyActions}
        artifactActions={artifactActions}
        tasksById={tasksById}
        onSelectTask={onSelectTask}
        onOpenArtifact={onOpenArtifact}
        onApproveArtifact={onApproveArtifact}
        onRequestArtifactChanges={onRequestArtifactChanges}
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
  taskReadyActions,
  artifactActions,
  tasksById,
  onSelectTask,
  onOpenArtifact,
  onApproveArtifact,
  onRequestArtifactChanges,
}: {
  selectedTask: SprintEngineTask
  selectedTaskOwnerLabel: string
  selectedTaskNeedsInputNote: string | null
  selectedTaskArtifacts: SprintEngineArtifact[]
  selectedTaskArtifactBlockers: ReturnType<typeof getSprintEngineArtifactDependencyBlockers>
  taskReadyActions: Record<string, TaskReadyActionState>
  artifactActions: Record<string, ArtifactActionState>
  tasksById: Record<string, SprintEngineTask>
  onSelectTask: (taskId: string) => void
  onOpenArtifact: (artifact: SprintEngineArtifact) => void | Promise<void>
  onApproveArtifact: (artifact: SprintEngineArtifact) => void | Promise<void>
  onRequestArtifactChanges: (artifact: SprintEngineArtifact) => void
}) {
  const openIssues = getOpenSprintEngineFeedbackIssues(selectedTask.feedback)
  const openFindings = getOpenSprintEngineFeedbackFindings(selectedTask.feedback)
  const activityEntries = getSprintEngineTaskActivityDescending(selectedTask)

  const readyActionMessage = taskReadyActions[selectedTask.id]?.message ?? null
  const readyActionError = taskReadyActions[selectedTask.id]?.status === 'error'

  return (
    <div className="flex-1 space-y-5 overflow-auto px-5 py-4 text-[13px] leading-6 text-[color:var(--text-default)]">
      {selectedTaskNeedsInputNote ? (
        <div className="border-l border-[color:var(--tone-warn-soft)] pl-3 text-sm text-[color:var(--tone-warn)]">
          <div className="text-[10px] font-bold text-[color:var(--tone-warn)]">Needs Input</div>
          <div className="mt-2 leading-6">{selectedTaskNeedsInputNote}</div>
          <div className="mt-2 text-[12px] text-[color:var(--tone-warn)]">
            Respond in the worker CLI to unblock this task.
          </div>
        </div>
      ) : null}

      {selectedTaskArtifactBlockers.length > 0 ? (
        <ArtifactBlockerList blockers={selectedTaskArtifactBlockers} />
      ) : null}

      <OpenFeedbackSummary issues={openIssues} findings={openFindings} />

      {readyActionMessage ? (
        <div
          className={`border-l pl-3 text-[12px] leading-5 ${
            readyActionError
              ? 'border-[color:var(--tone-error-soft)] text-[color:var(--tone-error)]'
              : 'border-[color:var(--border-strong)] text-[color:var(--text-muted)]'
          }`}
        >
          {readyActionMessage}
        </div>
      ) : null}

      <ActivityTimeline
        entries={activityEntries}
        emptyLabel="No activity recorded yet."
      />

      <details className="group" open>
        <summary className="cursor-pointer list-none text-[10px] font-bold text-[color:var(--text-disabled)] hover:text-[color:var(--text-muted)]">
          <span className="mr-1 inline-block transition-transform group-open:rotate-90" aria-hidden="true">›</span>
          Details
        </summary>
        <div className="mt-4 space-y-5">
          <DefinitionList
            layout="compact-grid"
            items={[
              { term: 'Source', description: formatTaskSourceLabel(selectedTask) },
              { term: 'Owner', description: selectedTaskOwnerLabel },
              { term: 'Dependencies', description: selectedTask.dependsOn.join(', ') || 'None' },
              {
                term: selectedTask.completedAt ? 'Completed' : 'Started',
                description: formatTimestamp(selectedTask.completedAt ?? selectedTask.startedAt),
              },
            ]}
          />

          {selectedTask.source?.type === 'github' ? (
            <div className="border-l border-[color:var(--border-strong)] pl-3">
              <div className="text-[10px] font-bold text-[color:var(--text-disabled)]">GitHub Issue</div>
              <div className="mt-1 truncate text-sm text-[color:var(--text-default)]">
                {selectedTask.source.repo ? `${selectedTask.source.repo} ` : ''}
                {selectedTask.source.externalId ? `#${selectedTask.source.externalId}` : ''}
              </div>
              {formatTaskSyncStatusLabel(selectedTask) ? (
                <div className="mt-2 text-[12px] leading-5 text-[color:var(--tone-warn)]">
                  {formatTaskSyncStatusDescription(selectedTask)}
                </div>
              ) : null}
              {selectedTask.source.externalUrl ? (
                <button
                  type="button"
                  onClick={() => {
                    window.open(selectedTask.source?.externalUrl, '_blank', 'noopener,noreferrer')
                  }}
                  className="mt-2 rounded px-2 py-1 text-[11px] font-semibold text-[color:var(--tone-warn)] interactive transition-colors hover:bg-[color:var(--tone-warn-soft)]"
                >
                  Open Issue
                </button>
              ) : null}
            </div>
          ) : null}

          {selectedTask.triage ? (
            <div className="border-l border-[color:var(--tone-warn)] pl-3 text-sm text-[color:var(--tone-warn)]">
              <div className="text-[10px] font-bold text-[color:var(--tone-warn)]">Architect Triage</div>
              <div className="mt-2 leading-6">{selectedTask.triage.summary}</div>
            </div>
          ) : null}

          <div>
            <div className="mb-2 text-[10px] font-bold text-[color:var(--text-disabled)]">Description</div>
            <div>{selectedTask.description || 'No description recorded.'}</div>
          </div>

          <SectionList
            title="Acceptance Criteria"
            items={selectedTask.acceptanceCriteria}
            emptyLabel="No acceptance criteria recorded."
          />
          <SectionList title="Owned Paths" items={selectedTask.ownedPaths} emptyLabel="No owned paths recorded." />
          <SectionList
            title="Implementation Notes"
            items={selectedTask.implementationNotes}
            emptyLabel="No implementation notes recorded."
          />
          <SectionList title="Notes" items={selectedTask.notes} emptyLabel="No notes recorded." />
          <SectionList
            title="Comments"
            items={selectedTask.comments.map((comment) => `${comment.actor}: ${comment.body}`)}
            emptyLabel="No comments recorded."
          />

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
            <div className="mb-2 text-[10px] font-bold text-[color:var(--text-disabled)]">Evidence Summary</div>
            <div>{selectedTask.evidence.summary || 'No completion summary recorded yet.'}</div>
          </div>

          {selectedTask.feedback ? <AgentFeedback feedback={selectedTask.feedback} /> : null}

          <SectionList
            title="Commands Run"
            items={selectedTask.evidence.commandsRan}
            emptyLabel="No commands recorded."
          />
          <SectionList
            title="Results"
            items={selectedTask.evidence.results}
            emptyLabel="No test or validation results recorded."
          />
          <SectionList
            title="Touched Files"
            items={selectedTask.evidence.touchedFiles}
            emptyLabel="No touched files recorded."
          />
        </div>
      </details>
    </div>
  )
}
