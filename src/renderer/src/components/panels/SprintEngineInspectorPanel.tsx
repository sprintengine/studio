// Sprint Engine inspector — the right-hand detail pane for tasks, artifacts,
// agents, and artifact previews. Extracted from SprintEngineBoardPanel.tsx so
// the orchestrator stays focused on state coordination and IPC plumbing while
// the inspector owns its own rendering, sub-components, and detail formatting.
//
// Task-mode layout (item 2029) reads in four groups, in this order:
//   who and what   — status, id, title, and a POINTER at the backlog item
//                    this task delivers (never the item's own words: no
//                    description, no acceptance criteria live here)
//   where it runs  — Repo · Modules · After
//   how it is going— Elapsed (activity sparkline) · Diff (add/delete ratio
//                    bar) · Tokens (a plain number, no bar — token counts have
//                    no natural ceiling, and an unmeasured source reads as
//                    unmeasured, never as zero)
//   what happened  — ONE timeline: comments, status changes, work notes,
//                    review passes and the run's VCS milestones, newest first,
//                    compose at the top, one lifecycle glyph per entry.
//
// Groups are separated by SPACE, not rules: the pane draws no horizontal
// hairline of its own, and a vertical tone bar appears only on an exception
// callout (needs input / blocked), never as structure.
//
// Nothing is removed from the record. Every field the engine writes is still
// written and still reachable — this module decides only what is RENDERED.
//
// Data shaping lives next door in `sprintEngineInspector.ts`; the orchestrator
// passes hydrated derived values via props rather than letting the inspector
// reach back into the store directly.

import React, { useCallback, useId, useMemo, useRef, useState } from 'react'
import type {
  AgentState,
  SprintEngineArtifact,
  SprintEngineEvent,
  SprintEngineTask,
  SprintEngineTaskActivityEntry,
  SprintEngineTaskActivityType,
  SprintEngineTaskBoardColumn,
  SprintEngineTaskDiff,
  SprintEngineTaskDiffLine,
  SprintEngineTaskEvidence,
  SprintEngineTaskFeedback,
  SprintEngineTaskFeedbackFinding,
  SprintEngineTaskFeedbackIssue,
  SprintEngineRoleId,
} from '../../types/workspace'
import {
  feedbackFindingAreaLabels,
  feedbackFindingKindLabels,
  feedbackFindingSeverityLabels,
  feedbackIssueCategoryLabels,
  feedbackIssueSeverityLabels,
} from '../../utils/sprintengineRunSummary'
import {
  getOpenSprintEngineFeedbackFindings,
  getOpenSprintEngineFeedbackIssues,
  getSprintEngineArtifactAutoApprovalEligibility,
  getSprintEngineArtifactDependencyBlockers,
  getSprintEngineAgentActivityDescending,
  getSprintEngineTaskImplementerTimeline,
  getSprintEngineTasksWorkedOnByAgent,
  getSprintEngineRoleLabel,
  sprintEngineArtifactKindLabel,
  sprintEngineArtifactStatusLabels,
  sprintEngineTaskStateLabel,
  taskBoardColumnToLifecycle,
  type SprintEngineAgentActivityEntry,
  type SprintEngineAgentWorkedOnTask,
  type SprintEngineTaskImplementerEntry,
} from '../../utils/sprintengine'
import { formatRelativeTime } from '../../utils/switchboardBoard'
import { formatTokenCount } from '../../utils/sprintengineTokenUsage'
import type { SprintEngineTaskTokenUsage } from '../../../../shared/sprintengine-token-usage'
import {
  CloseIconButton,
  DefinitionList,
  FilePreviewPane,
  FOCUS_RING_CLASS,
  FOCUS_RING_INSET_CLASS,
  GhostButton,
  IconButton,
  InboxRow,
  InlineNotice,
  LIFECYCLE_LABEL,
  LifecycleGlyph,
  PanelHeader,
  PrimaryButton,
  RoleAvatar,
  Spinner,
  Textarea,
  Tooltip,
  TruncatedText,
  type DefinitionItem,
  type LifecycleState,
} from '../ui'
import {
  SOURCE_HANDOFF_ARTIFACT_ID,
  artifactStatusTone,
  buildTaskTimeline,
  formatArtifactBlockerSummary,
  formatArtifactSummary,
  formatElapsed,
  formatMobileArtifactDecision,
  formatTaskSourceLabel,
  formatTimestamp,
  getMobileArtifactDecision,
  sprintEngineInboxRowSupporting,
  sprintEngineInboxRowLifecycle,
  taskActivitySparkline,
  taskDiffTotals,
  taskElapsedMs,
  taskModuleLabels,
  timelineItemLifecycle,
  type ActivitySparkBar,
  type ArtifactActionState,
  type TaskInputActionState,
  type TaskCommentActionState,
  type TaskTimelineItem,
  type RuntimeAgentView,
  type SprintEngineInspectorSelection,
} from './sprintEngineInspector'
import { HtmlArtifactFrame } from '../workspace/guidedBrief/MockupPreviewPane'
import type { MockupAnnotation } from '../workspace/guidedBrief/annotate/types'
import { sprintEngineSeedPreviewKind } from './sprintEngineBoard/sprintEngineStartedFrom'
import { basename, parentPath } from '../../utils/paths'

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
      <div className="mb-2 text-micro font-semibold text-[color:var(--text-muted)]">{title}</div>
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
        <div className="text-meta text-[color:var(--text-disabled)]">{emptyLabel}</div>
      )}
    </div>
  )
}

// Shared check glyph: a completed implementation pass reads as a "done" tick.
// `label` drives the accessible name + tooltip. Omit it (decorative) when an
// adjacent label or trail aria-label already names the glyph, to avoid a
// screen reader announcing the same thing twice.
type GlyphProps = { className?: string; label?: string }

function glyphA11yProps(label: string | undefined) {
  return label
    ? ({ role: 'img', 'aria-label': label } as const)
    : ({ 'aria-hidden': true } as const)
}

function CompletedCheckGlyph({ className, label }: GlyphProps) {
  return (
    <svg className={className} viewBox="0 0 12 12" fill="none" {...glyphA11yProps(label)}>
      {label ? <title>{label}</title> : null}
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
  const lifecycle = sprintEngineInboxRowLifecycle(artifact)
  // Screen readers only get the word (the row glyph is aria-hidden), so speak
  // the artifact status vocabulary — "Approved" / "Approved automatically" —
  // rather than the generic lifecycle "Done", keeping the row aligned with the
  // detail Status word. Scoped to approved; every other status keeps its
  // lifecycle label.
  const spokenStatus =
    artifact.status === 'approved'
      ? lifecycle === 'approved_auto'
        ? LIFECYCLE_LABEL.approved_auto
        : sprintEngineArtifactStatusLabels.approved
      : LIFECYCLE_LABEL[lifecycle]
  const timestamp = artifact.createdAt ?? artifact.updatedAt
  const relativeTimestamp = timestamp ? formatRelativeTime(timestamp) : '—'
  const title = (
    <>
      <span className="mr-2 font-mono tabular-nums text-micro text-[color:var(--text-muted)]">
        {artifact.id}
      </span>
      {artifact.title}
    </>
  )
  return (
    <InboxRow
      id={id}
      leading={<LifecycleGlyph state={lifecycle} live={false} />}
      title={title}
      supporting={sprintEngineInboxRowSupporting(artifact, task)}
      trailing={relativeTimestamp}
      selected={selected}
      onSelect={onSelect}
      ariaLabel={`${artifact.id} ${artifact.title}, ${spokenStatus}`}
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
      <span className="mr-2 font-mono tabular-nums text-micro text-[color:var(--text-muted)]">
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
  const lifecycle = sprintEngineInboxRowLifecycle(artifact)
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
        <LifecycleGlyph state={lifecycle} live={false} />
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
    description: isSourceHandoff ? 'Handover' : sprintEngineArtifactKindLabel(artifact.kind),
  })
  if (!isSourceHandoff && artifact.taskId) {
    items.push({
      term: 'Task',
      description: (
        <button
          type="button"
          onClick={() => onSelectTask(artifact.taskId)}
          disabled={!task}
          className={`interactive font-mono text-[color:var(--text-strong)] hover:text-[color:var(--accent-primary)] disabled:text-[color:var(--text-disabled)] ${FOCUS_RING_CLASS}`}
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
      <span className="break-all font-mono text-meta text-[color:var(--text-strong)]">{artifact.path}</span>
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
      {/* The three inspector panes all led with the same hand-rolled band —
          `px-5 py-4`, a status line stacked over a `text-title` heading — so a
          detail pane opened a type step and 8px taller than the list it opened
          from (2112). One row now: the status line is the title's `scope`, the
          actions keep the band below. */}
      <PanelHeader
        title={artifact.title}
        scope={<InspectorStatusScope lifecycle={lifecycle} live={false} label={statusLabel} id={artifact.id} />}
        primaryAction={
          <InspectorChromeActions
            expanded={isExpanded}
            onToggleExpand={onToggleExpand}
            onClose={onClose}
            closeLabel="Close artifact detail"
          />
        }
        divider={false}
      />
      <div className="border-b border-[color:var(--border-default)] px-3 pb-2">
        <div className="flex flex-wrap gap-1.5">
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
            <span className="text-meta text-[color:var(--text-muted)]">
              No actions available for this artifact yet.
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex-1 space-y-5 overflow-auto px-5 py-4 text-body leading-6 text-[color:var(--text-default)]">
        <DefinitionList items={items} />

        {mobileDecision ? (
          <div>
            <div className="mb-2 text-micro font-bold text-[color:var(--text-disabled)]">Mobile decision</div>
            <div className="text-meta leading-5 text-[color:var(--text-default)]">
              {formatMobileArtifactDecision(mobileDecision)}
            </div>
          </div>
        ) : null}

        {artifact.status === 'approved' && artifact.approvalMode === 'policy' ? (
          <div>
            <div className="mb-2 text-micro font-bold text-[color:var(--text-disabled)]">Approval</div>
            <div className="text-meta leading-5 text-[color:var(--text-default)]">
              Approved automatically by run policy · on your behalf
              {artifact.approvedAt ? ` · ${formatRelativeTime(artifact.approvedAt)}` : ''}
            </div>
          </div>
        ) : null}

        {readyForReview && autoApproval.label ? (
          <div>
            <div className="mb-2 text-micro font-bold text-[color:var(--text-disabled)]">Auto-approval</div>
            <div
              className={`text-meta leading-5 ${
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
            <div className="mb-2 text-micro font-bold text-[color:var(--text-disabled)]">Last action</div>
            <div
              className={`text-meta leading-5 ${
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
  dividers = true,
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
  /** Hairline between rows. Off on the task detail pane, whose anatomy carries
   *  every group boundary with space instead of a rule (item 2029). */
  dividers?: boolean
  onSelectTask: (taskId: string) => void
  onOpenArtifact: (artifact: SprintEngineArtifact) => void
  onApproveArtifact: (artifact: SprintEngineArtifact) => void
  onRequestArtifactChanges: (artifact: SprintEngineArtifact) => void
}) {
  return (
    <div>
      {hideHeader ? null : (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-micro font-semibold text-[color:var(--text-muted)]">{title}</div>
          {artifacts.length > 0 ? (
            <span className="text-micro text-[color:var(--text-disabled)]">
              {formatArtifactSummary(artifacts)}
            </span>
          ) : null}
        </div>
      )}

      {artifacts.length > 0 ? (
        <ol
          className={`@container ${
            dividers ? 'divide-y divide-[color:var(--border-default)]' : 'space-y-1'
          }`}
        >
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
              <li key={artifact.id} className="grid gap-3 px-3 py-2.5 @[520px]:grid-cols-[minmax(0,1fr)_auto] @[520px]:items-center">
                <div className="min-w-0 space-y-0.5">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="shrink-0 font-mono tabular-nums text-micro text-[color:var(--text-muted)]">{artifact.id}</span>
                    <TruncatedText as="span" text={artifact.title} className="min-w-0 flex-1 text-body font-medium text-[color:var(--text-strong)]" />
                    {confidencePct !== null ? (
                      <ConfidenceDial value={confidencePct} label="Agent confidence" />
                    ) : null}
                    <span className={`shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-micro font-bold ${artifactStatusTone(artifact.status)}`}>
                      {isSourceHandoff ? 'Source' : sprintEngineArtifactStatusLabels[artifact.status]}
                    </span>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-micro text-[color:var(--text-subtle)]">
                    {isSourceHandoff ? null : (
                      <>
                        <span>{sprintEngineArtifactKindLabel(artifact.kind)}</span>
                        <span>·</span>
                        <button
                          type="button"
                          onClick={() => onSelectTask(artifact.taskId)}
                          disabled={!task}
                          className={`interactive font-mono text-[color:var(--text-muted)] hover:text-[color:var(--accent-primary)] disabled:text-[color:var(--text-disabled)] ${FOCUS_RING_CLASS}`}
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
                    <div className={`text-micro ${action.status === 'error' ? 'text-[color:var(--tone-error)]' : 'text-[color:var(--tone-good)]'}`}>
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
        <div className="text-meta text-[color:var(--text-disabled)]">{emptyLabel}</div>
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
    <InlineNotice tone="warn" title="Blocked by review">
      <div className="space-y-2 text-meta leading-5">
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
    </InlineNotice>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Task body sub-components — owner, scores, findings, artifacts,
// activity feed, compact details. Each is small, single-purpose, and
// designed for the 320–560 px side-pane the inspector lives in.
// ──────────────────────────────────────────────────────────────────────────

// Cap on visible pass ticks per worker so a heavily-reworked task never breaks
// a row; overflow collapses to a `+N` counter.
const MAX_VISIBLE_OWNER_PASSES = 6

// One tick per implementation pass a worker has published on a task.
function ImplementerTicks({ passCount }: { passCount: number }) {
  if (passCount <= 0) return null
  const visiblePasses = Math.min(passCount, MAX_VISIBLE_OWNER_PASSES)
  const overflow = passCount - visiblePasses
  const ariaLabel = passCount === 1 ? '1 completed pass' : `${passCount} completed passes`
  return (
    <span className="inline-flex items-center gap-1" aria-label={ariaLabel}>
      {Array.from({ length: visiblePasses }, (_, index) => (
        <CompletedCheckGlyph key={`pass-${index}`} className="icon-xs text-[color:var(--tone-good)]" />
      ))}
      {overflow > 0 ? (
        <span className="tabular-nums font-mono text-micro text-[color:var(--text-disabled)]">
          +{overflow}
        </span>
      ) : null}
    </span>
  )
}

// Trailing state for the active worker's row. Running reads as "in progress";
// the act-on states (needs input, crashed/exited) read as a warn-toned word so
// they stay visible on the task without a separate status idiom. The full
// needs-input detail still lives in TaskNeedsInputCallout below.
function ActiveImplementerStatus({ runtimeStatus }: { runtimeStatus: string | null }) {
  if (runtimeStatus === 'needs_input') {
    return <span className="text-[color:var(--tone-warn)]">needs input</span>
  }
  if (runtimeStatus === 'error' || runtimeStatus === 'exited') {
    return <span className="text-[color:var(--tone-warn)]">stopped</span>
  }
  return (
    <span className="inline-flex items-center gap-1 text-[color:var(--text-muted)]">
      <Spinner size={12} />
      <span>in progress</span>
    </span>
  )
}

function TaskImplementerRow({
  entry,
  fallbackRole,
  onOpenAgentTerminal,
  terminalActionsUnavailable,
}: {
  entry: SprintEngineTaskImplementerEntry
  /** The task's own role, used when a comment recorded none. Absent on a roleless run. */
  fallbackRole?: SprintEngineRoleId
  onOpenAgentTerminal: (agentId: string) => void
  terminalActionsUnavailable?: string
}) {
  const role = entry.role ?? fallbackRole
  const relativeTime = entry.isActive ? null : formatRelativeTime(entry.lastActivityAt)
  const identityCluster = (
    <>
      {/* No role, no disc: the avatar's neutral fallback exists for a role that
          cannot be resolved, and must not stand in for one that is absent. */}
      {role ? <RoleAvatar role={role} size="sm" ariaLabel="" /> : null}
      <span className={entry.isActive ? 'text-[color:var(--text-default)]' : 'text-[color:var(--text-muted)]'}>
        {entry.label}
      </span>
    </>
  )
  return (
    <li className="flex items-center gap-2 text-meta text-[color:var(--text-muted)]">
      <button
        type="button"
        onClick={() => onOpenAgentTerminal(entry.agentId)}
        disabled={Boolean(terminalActionsUnavailable)}
        aria-label={
          terminalActionsUnavailable
            ? `Open ${entry.label} terminal — unavailable: ${terminalActionsUnavailable}`
            : `Open ${entry.label} terminal`
        }
        className={
          'interactive -mx-1.5 inline-flex items-center gap-2 rounded px-1.5 py-0.5 ' +
          'hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ' +
          'disabled:cursor-not-allowed disabled:hover:bg-transparent ' +
          FOCUS_RING_CLASS
        }
      >
        {identityCluster}
      </button>
      <ImplementerTicks passCount={entry.passCount} />
      {entry.isActive ? (
        <ActiveImplementerStatus runtimeStatus={entry.runtimeStatus} />
      ) : relativeTime ? (
        <span className="tabular-nums text-[color:var(--text-disabled)]">{relativeTime}</span>
      ) : null}
    </li>
  )
}

// Per-worker implementer timeline: one row per worker who has held the task,
// active claim first, then by most-recent pass. Reassignment surfaces the new
// owner on top while each worker keeps their own tick count.
function TaskImplementerTimeline({
  task,
  runtimeAgents,
  onOpenAgentTerminal,
  terminalActionsUnavailable,
}: {
  task: SprintEngineTask
  runtimeAgents: RuntimeAgentView[]
  onOpenAgentTerminal: (agentId: string) => void
  terminalActionsUnavailable?: string
}) {
  const entries = getSprintEngineTaskImplementerTimeline(task, runtimeAgents)
  if (entries.length === 0) {
    const label = task.status === 'done' && task.role ? getSprintEngineRoleLabel(task.role) : 'No active worker'
    return (
      <div className="flex items-center gap-2 text-meta text-[color:var(--text-muted)]">
        {task.role ? <RoleAvatar role={task.role} size="sm" ariaLabel="" /> : null}
        <span>{label}</span>
      </div>
    )
  }
  return (
    <ul className="space-y-1.5">
      {entries.map((entry) => (
        <TaskImplementerRow
          key={entry.agentId}
          entry={entry}
          fallbackRole={task.role}
          onOpenAgentTerminal={onOpenAgentTerminal}
          terminalActionsUnavailable={terminalActionsUnavailable}
        />
      ))}
    </ul>
  )
}

const needsInputKindLabels: Record<string, string> = {
  architect: 'Architect',
  user: 'User',
}

const needsInputReasonLabels: Record<string, string> = {
  task_scope: 'Task scope',
  artifact_review: 'Artifact review',
  tooling: 'Tooling',
  verification: 'Verification',
  product_decision: 'Product decision',
  blocked_other: 'Blocked',
}

function formatNeedsInputValue(value: string | undefined): string | null {
  if (!value?.trim()) return null
  const trimmed = value.trim()
  return needsInputReasonLabels[trimmed]
    ?? needsInputKindLabels[trimmed]
    ?? trimmed.replace(/_/g, ' ')
}

function resolveNeedsInputReporterRole(
  reporter: string,
  runtimeAgents: RuntimeAgentView[],
) {
  // The reporter is the task's own owner (MC-1542 single-owner tasks), so its
  // live roster entry is the only source of the role the work is blocked behind.
  const runtime = runtimeAgents.find((entry) => entry.agentId === reporter)
  return runtime?.role ?? null
}

// A needs_input task whose whole job is "review artifact X" gets the review
// promoted to the top with the real actions inline — not a Question/Issue/
// Suggested-resolution restatement of "this is a review". The Open/Approve/
// Request-changes controls reuse the same handlers as the artifact list (which
// is otherwise buried under the body's "More" disclosure). Any other ask keeps
// its question — that's real signal — minus the boilerplate scaffolding.
function TaskReviewPrompt({
  artifact,
  action,
  reportedBy,
  reportedAt,
  onOpenArtifact,
  onApproveArtifact,
  onRequestArtifactChanges,
}: {
  artifact: SprintEngineArtifact
  action: ArtifactActionState | undefined
  reportedBy: string | null
  reportedAt: string | null
  onOpenArtifact: (artifact: SprintEngineArtifact) => void
  onApproveArtifact: (artifact: SprintEngineArtifact) => void
  onRequestArtifactChanges: (artifact: SprintEngineArtifact) => void
}) {
  const pending = action?.status === 'pending'
  const readyForReview = artifact.status === 'ready_for_review'
  const canOpenArtifact = Boolean(artifact.path.trim())
  const kindLabel = sprintEngineArtifactKindLabel(artifact.kind)
  const reviewer = reportedBy ?? artifact.createdBy
  const relative = reportedAt
    ? formatRelativeTime(reportedAt)
    : artifact.createdAt
      ? formatRelativeTime(artifact.createdAt)
      : null

  // The kit's notice, not a warn left-bar (MC-2115): the `needs_input` glyph it
  // used to draw itself is the one InlineNotice draws for the warn tone, so the
  // card keeps its shape and loses the stripe.
  return (
    <InlineNotice
      tone="warn"
      title={readyForReview ? 'Ready for your review' : 'Awaiting review'}
      action={
        <>
          {readyForReview ? (
            <PrimaryButton onClick={() => onApproveArtifact(artifact)} disabled={pending}>
              {pending && action?.kind === 'approve' ? 'Approving…' : 'Approve'}
            </PrimaryButton>
          ) : null}
          {canOpenArtifact ? (
            <GhostButton onClick={() => onOpenArtifact(artifact)} disabled={pending}>
              {pending && action?.kind === 'open' ? 'Opening…' : 'Open plan'}
            </GhostButton>
          ) : null}
          {readyForReview ? (
            <GhostButton onClick={() => onRequestArtifactChanges(artifact)} disabled={pending}>
              {pending && action?.kind === 'requestChanges' ? 'Requesting changes…' : 'Request changes'}
            </GhostButton>
          ) : null}
        </>
      }
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-body text-[color:var(--text-strong)]">
        <span className="font-mono tabular-nums text-micro text-[color:var(--text-muted)]">{artifact.id}</span>
        <span>{kindLabel}</span>
        {canOpenArtifact ? (
          <span className="font-mono text-micro text-[color:var(--text-subtle)] [overflow-wrap:anywhere]">
            {artifact.path}
          </span>
        ) : null}
      </div>
      {reviewer ? (
        <div className="mt-1 text-meta text-[color:var(--text-muted)]">
          <span className="font-mono">{reviewer}</span>
          {relative ? <span> · {relative}</span> : null}
        </div>
      ) : null}
      {action && action.status !== 'pending' ? (
        <div
          className={`mt-2 text-meta leading-5 ${
            action.status === 'error' ? 'text-[color:var(--tone-error)]' : 'text-[color:var(--tone-good)]'
          }`}
        >
          {action.message}
        </div>
      ) : null}
    </InlineNotice>
  )
}

// The resolve surface for a free-text needs_input ask. It is the sibling of
// TaskReviewPrompt — same warn hairline + needs_input glyph header so both
// needs_input variants read as one family — but where the review prompt
// resolves via Approve/Request-changes, this one hosts a composer that drives
// the `sprintengine.task.resolve_input` mutation. "Send & resume" returns the
// worker to the task; "Resolve & complete" answers and closes it. The human
// supervisor's identity is attached in main, so the renderer only supplies the
// reply text and the complete flag.
function TaskInputResponsePrompt({
  taskId,
  headline,
  reasonLabel,
  question,
  fallback,
  reportedBy,
  reporterRole,
  reportedAtLabel,
  action,
  onResolveTaskInput,
}: {
  taskId: string
  headline: string
  reasonLabel: string | null
  question: string | null
  fallback: string
  reportedBy: string | null
  reporterRole: SprintEngineRoleId | null
  reportedAtLabel: string | null
  action: TaskInputActionState | undefined
  onResolveTaskInput: (taskId: string, resolution: string, complete: boolean) => Promise<boolean>
}) {
  const [reply, setReply] = useState('')
  const replyFieldId = useId()
  const pending = action?.status === 'pending'
  const canSend = reply.trim().length > 0 && !pending

  const send = async (complete: boolean) => {
    if (reply.trim().length === 0 || pending) return
    const ok = await onResolveTaskInput(taskId, reply, complete)
    if (ok) setReply('')
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send(false)
    }
  }

  const messageToneClass =
    action?.status === 'error'
      ? 'text-[color:var(--tone-error)]'
      : action?.status === 'success'
        ? 'text-[color:var(--tone-good)]'
        : 'text-[color:var(--text-muted)]'

  return (
    <InlineNotice
      tone="warn"
      title={
        <>
          {headline}
          {reasonLabel ? (
            <span className="font-normal text-[color:var(--text-muted)]"> · {reasonLabel}</span>
          ) : null}
        </>
      }
    >
      <div className="whitespace-pre-line text-body leading-6 text-[color:var(--text-default)] [overflow-wrap:anywhere]">
        {question || fallback}
      </div>
      {reportedBy ? (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-[color:var(--text-muted)]">
          {reporterRole ? <RoleAvatar role={reporterRole} size="sm" ariaLabel="" /> : null}
          <span className="font-mono text-[color:var(--text-default)]">{reportedBy}</span>
          {reportedAtLabel ? <span>· {reportedAtLabel}</span> : null}
        </div>
      ) : null}
      <div className="mt-3">
        <label htmlFor={replyFieldId} className="sr-only">
          Reply to the agent
        </label>
        <Textarea
          id={replyFieldId}
          value={reply}
          onChange={(event) => setReply(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={pending}
          rows={3}
          placeholder="Reply to the agent… (Enter to send, Shift+Enter for a new line)"
          size="md"
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <PrimaryButton onClick={() => void send(false)} disabled={!canSend}>
          Send &amp; resume
        </PrimaryButton>
        <GhostButton onClick={() => void send(true)} disabled={!canSend}>
          Resolve &amp; complete
        </GhostButton>
      </div>
      {action ? (
        <div className={`mt-2 text-meta leading-5 ${messageToneClass}`}>{action.message}</div>
      ) : null}
    </InlineNotice>
  )
}

function TaskNeedsInputCallout({
  task,
  fallbackNote,
  runtimeAgents,
  artifacts,
  artifactActions,
  taskInputAction,
  onOpenArtifact,
  onApproveArtifact,
  onRequestArtifactChanges,
  onResolveTaskInput,
}: {
  task: SprintEngineTask
  fallbackNote: string | null
  runtimeAgents: RuntimeAgentView[]
  artifacts: SprintEngineArtifact[]
  artifactActions: Record<string, ArtifactActionState>
  taskInputAction: TaskInputActionState | undefined
  onOpenArtifact: (artifact: SprintEngineArtifact) => void
  onApproveArtifact: (artifact: SprintEngineArtifact) => void
  onRequestArtifactChanges: (artifact: SprintEngineArtifact) => void
  onResolveTaskInput: (taskId: string, resolution: string, complete: boolean) => Promise<boolean>
}) {
  if (task.status !== 'needs_input') return null

  const needsInput = task.needsInput
  const reportedBy = needsInput?.reportedBy?.trim() || null
  const reportedAt = needsInput?.reportedAt?.trim() || null
  const isArtifactReview = needsInput?.reason === 'artifact_review'

  // Review-gated ask with a resolvable artifact → promote the review itself.
  const reviewArtifact =
    isArtifactReview && needsInput?.artifactId
      ? artifacts.find((entry) => entry.id === needsInput.artifactId) ?? null
      : null

  if (reviewArtifact) {
    return (
      <TaskReviewPrompt
        artifact={reviewArtifact}
        action={artifactActions[reviewArtifact.id]}
        reportedBy={reportedBy}
        reportedAt={reportedAt}
        onOpenArtifact={onOpenArtifact}
        onApproveArtifact={onApproveArtifact}
        onRequestArtifactChanges={onRequestArtifactChanges}
      />
    )
  }

  // Review flagged but the artifact isn't attached yet — say so explicitly
  // rather than render dead buttons or pretend it's a free-text question.
  if (isArtifactReview) {
    return (
      <InlineNotice
        tone="warn"
        title="Needs input — Artifact review"
        hint="An artifact is awaiting review but isn’t attached to this task yet. Check the activity feed below for the latest submission."
      />
    )
  }

  // Every other ask: the question is the signal, and the human can resolve it
  // inline. Lead with who is being waited on (the actor route), keep the
  // question, drop the redundant Issue + Suggested-resolution restatement that
  // machine-generated needs_input entries carry, and host the resolve composer.
  const kindRaw = needsInput?.kind?.trim()
  const headline = kindRaw === 'user'
    ? 'Needs your input'
    : kindRaw === 'architect'
      ? 'Needs architect input'
      : 'Needs input'
  const reasonLabel = formatNeedsInputValue(needsInput?.reason)
  const question = needsInput?.question?.trim() || null
  const fallback = fallbackNote?.trim() || 'Worker is waiting for input.'
  const reporterRole = reportedBy ? resolveNeedsInputReporterRole(reportedBy, runtimeAgents) : null
  const reportedAtLabel = reportedAt ? formatTimestamp(reportedAt) : null

  return (
    <TaskInputResponsePrompt
      taskId={task.id}
      headline={headline}
      reasonLabel={reasonLabel}
      question={question}
      fallback={fallback}
      reportedBy={reportedBy}
      reporterRole={reporterRole}
      reportedAtLabel={reportedAtLabel}
      action={taskInputAction}
      onResolveTaskInput={onResolveTaskInput}
    />
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
        <span className="text-micro font-semibold text-[color:var(--tone-warn)]">
          Open findings
        </span>
        <span className="tabular-nums text-micro text-[color:var(--text-disabled)]">{total}</span>
      </div>
      <ul className="space-y-2">
        {findings.map((finding) => (
          <li key={finding.id} className="py-2 text-meta leading-5 text-[color:var(--text-default)]">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-micro text-[color:var(--text-muted)]">
              <span className="text-[color:var(--tone-warn)]">
                {feedbackFindingSeverityLabels[finding.severity]}
              </span>
              <span>{feedbackFindingKindLabels[finding.kind]}</span>
              <span>·</span>
              <span>{feedbackFindingAreaLabels[finding.area]}</span>
              {finding.file ? (
                <>
                  <span>·</span>
                  <span className="font-mono text-micro [overflow-wrap:anywhere]">
                    {finding.file}
                  </span>
                </>
              ) : null}
            </div>
            <div className="mt-1 text-[color:var(--text-strong)]">
              {finding.title ?? feedbackFindingKindLabels[finding.kind]}
            </div>
            {finding.detail ? (
              <div className="mt-0.5 text-[color:var(--text-muted)] [overflow-wrap:anywhere]">
                {finding.detail}
              </div>
            ) : null}
            {finding.recommendation ? (
              <div className="mt-0.5 text-[color:var(--text-default)]">
                <span className="text-[color:var(--text-muted)]">→ </span>
                {finding.recommendation}
              </div>
            ) : null}
          </li>
        ))}
        {issues.map((issue) => (
          <li key={issue.id} className="py-2 text-meta leading-5 text-[color:var(--text-default)]">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-micro text-[color:var(--text-muted)]">
              <span className="text-[color:var(--tone-warn)]">
                {feedbackIssueSeverityLabels[issue.severity]}
              </span>
              <span>prompt {feedbackIssueCategoryLabels[issue.category].toLowerCase()}</span>
              {issue.target ? (
                <>
                  <span>·</span>
                  <span className="font-mono text-micro">{issue.target}</span>
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

// The timeline — the pane's one stream. It replaced five legacy stacked
// sections with a single chronological list; item 2029 then removed its filter
// chips from BOTH consumers (this task pane and the agent pane below).
//
// The chips were a per-viewer subset of one short list, and they cost more than
// they saved: a filtered stream hides the entry that explains the one you are
// reading, and "which chip am I on" is state the reader has to carry. One
// unfiltered stream, newest first, with a lifecycle glyph per entry is faster
// to scan and cannot lie about what happened.

// Boilerplate "{actor} did X on {task}" messages duplicate the verb chip and
// add no signal — suppress for these types. Real prose lives on comments,
// needs_input resolutions, artifacts, and system events.
const SUPPRESS_ACTIVITY_MESSAGE_TYPES = new Set<SprintEngineTaskActivityType>([
  'claim',
  'evidence',
  'status_change',
  'feedback',
  // Artifact entries pair with a comment carrying the prose; the verb chip
  // ("requested artifact changes", "approved artifact") is the signal here.
  'artifact',
])

// Coalesce consecutive identical-actor/type events within this window into one
// row with a ×N count. Only applied to types where rapid bursts are noise
// (evidence emissions on `task publish`).
const ACTIVITY_COALESCE_WINDOW_MS = 5 * 60 * 1000
const COALESCIBLE_ACTIVITY_TYPES = new Set<SprintEngineTaskActivityType>(['evidence'])

// Long-prose preview cap; comment / needs-input resolutions / artifact notes
// exceeding this are clipped with a "Show more" toggle.
const LONG_MESSAGE_PREVIEW_LIMIT = 280

type TimelineGroup = {
  key: string
  primary: TaskTimelineItem
  /** How many consecutive identical-actor entries this row stands for. */
  count: number
  /** Oldest member's timestamp, so the next candidate is measured against the
   *  end of the burst rather than its head. */
  lastTimestamp: string
}

function groupTimelineItems(items: ReadonlyArray<TaskTimelineItem>): TimelineGroup[] {
  const groups: TimelineGroup[] = []
  for (const item of items) {
    const last = groups[groups.length - 1]
    const coalescible =
      Boolean(last)
      && item.kind === 'activity'
      && last!.primary.kind === 'activity'
      && COALESCIBLE_ACTIVITY_TYPES.has(item.entry.type)
      && last!.primary.entry.type === item.entry.type
      && last!.primary.entry.actor === item.entry.actor
      && Math.abs(
        new Date(last!.lastTimestamp).getTime() - new Date(item.timestamp).getTime(),
      ) <= ACTIVITY_COALESCE_WINDOW_MS
    if (coalescible) {
      last!.count += 1
      last!.lastTimestamp = item.timestamp
    } else {
      groups.push({ key: item.key, primary: item, count: 1, lastTimestamp: item.timestamp })
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
          'interactive text-micro text-[color:var(--text-muted)] underline-offset-2 ' +
          'hover:text-[color:var(--text-strong)] hover:underline ' +
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

function evidenceHasContent(evidence: SprintEngineTaskEvidence): boolean {
  return Boolean(
    evidence.summary?.trim()
      || evidence.touchedFiles.length > 0
      || evidence.commandsRan.length > 0
      || evidence.results.length > 0
      || (evidence.diffs?.length ?? 0) > 0,
  )
}

function findFeedbackForEntry(
  entry: SprintEngineTaskActivityEntry,
  task: SprintEngineTask,
): SprintEngineTaskFeedback | null {
  const assessments = task.feedbackAssessments ?? []
  // Match on actor + timestamp proximity (within 5 minutes); reviewers can
  // capture multiple assessments in a row, so the closest one wins.
  const entryTime = entry.timestamp ? new Date(entry.timestamp).getTime() : null
  const matchByActor = assessments.filter((a) => a.agentId === entry.actor)
  if (matchByActor.length > 0 && entryTime !== null) {
    let best: SprintEngineTaskFeedback | null = null
    let bestDelta = Infinity
    for (const a of matchByActor) {
      const t = new Date(a.capturedAt).getTime()
      if (!Number.isFinite(t)) continue
      const delta = Math.abs(t - entryTime)
      if (delta < bestDelta) {
        bestDelta = delta
        best = a
      }
    }
    if (best) return best
  }
  if (matchByActor[0]) return matchByActor[0]
  if (task.feedback && task.feedback.agentId === entry.actor) return task.feedback
  return null
}

function findArtifactForEntry(
  entry: SprintEngineTaskActivityEntry,
  artifacts: SprintEngineArtifact[],
): SprintEngineArtifact | null {
  if (!entry.artifactId) return null
  return artifacts.find((a) => a.id === entry.artifactId) ?? null
}

function activityEntryHasDetail(
  entry: SprintEngineTaskActivityEntry,
  task: SprintEngineTask,
  artifacts: SprintEngineArtifact[],
): boolean {
  if (entry.type === 'evidence') return evidenceHasContent(task.evidence)
  if (entry.type === 'feedback') return Boolean(findFeedbackForEntry(entry, task))
  if (entry.type === 'artifact') return Boolean(findArtifactForEntry(entry, artifacts))
  return false
}

function FeedbackDetail({
  feedback,
  task,
  onJumpToFindings,
}: {
  feedback: SprintEngineTaskFeedback
  task: SprintEngineTask
  onJumpToFindings: (() => void) | null
}) {
  const issuesCount = feedback.issues?.length ?? 0
  const findingsCount = feedback.findings?.length ?? 0
  const openFindings = (feedback.findings ?? []).filter(
    (f) => !f.status || f.status === 'open' || f.status === 'accepted',
  ).length + (feedback.issues ?? []).filter(
    (i) => !i.status || i.status === 'new' || i.status === 'reviewed',
  ).length
  const isSelf = task.feedback === feedback
  const sourceLabel = isSelf ? 'Self report' : 'Reviewer assessment'
  const confidence = feedback.scores.confidencePct
  const hallucination = feedback.scores.hallucinationRiskPct
  const roleFit = feedback.scores.roleFitPct
  const reporterRoleId = feedback.role?.trim()
  const reporterLabel = reporterRoleId
    ? getSprintEngineRoleLabel(reporterRoleId)
    : feedback.agentId?.trim() || ''
  return (
    <div className="mt-2 space-y-2 pl-3 text-meta leading-5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-micro text-[color:var(--text-disabled)]">
        <span>{sourceLabel}</span>
        {/* Who reported it: the role when the reporter had one, else the agent
            id it recorded under — never "Unknown role" for an agent that
            legitimately has none (MC-2055). The engine writes an empty role for
            a roleless worker, so an empty string is absence, not a bad id. */}
        {reporterLabel ? (
          <>
            <span>·</span>
            <span className="font-mono text-[color:var(--text-muted)]">{reporterLabel}</span>
          </>
        ) : null}
      </div>
      {(typeof confidence === 'number'
        || typeof hallucination === 'number'
        || typeof roleFit === 'number') ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-[color:var(--text-muted)]">
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
                  color: hallucination >= 30
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
          {typeof roleFit === 'number' ? (
            <span>
              Role fit{' '}
              <span className="tabular-nums font-mono text-[color:var(--text-strong)]">
                {Math.round(roleFit)}%
              </span>
            </span>
          ) : null}
        </div>
      ) : null}
      {feedback.topFriction ? (
        <div>
          <div className="text-micro font-semibold text-[color:var(--text-muted)]">Top friction</div>
          <div className="text-[color:var(--text-default)] [overflow-wrap:anywhere]">{feedback.topFriction}</div>
        </div>
      ) : null}
      {feedback.suggestedImprovement ? (
        <div>
          <div className="text-micro font-semibold text-[color:var(--text-muted)]">Suggested improvement</div>
          <div className="text-[color:var(--text-default)] [overflow-wrap:anywhere]">{feedback.suggestedImprovement}</div>
        </div>
      ) : null}
      {(issuesCount + findingsCount) > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-micro text-[color:var(--text-muted)]">
          <span>
            <span className="tabular-nums font-mono text-[color:var(--text-default)]">{findingsCount}</span> findings
            {issuesCount > 0 ? (
              <>
                {' · '}
                <span className="tabular-nums font-mono text-[color:var(--text-default)]">{issuesCount}</span> issues
              </>
            ) : null}
          </span>
          {openFindings > 0 && onJumpToFindings ? (
            <button
              type="button"
              onClick={onJumpToFindings}
              className={
                'interactive -mx-1 inline-flex items-center rounded px-1 py-0.5 text-micro '
                + 'text-[color:var(--accent-primary)] underline-offset-2 '
                + 'hover:text-[color:var(--accent-primary-hover)] hover:underline '
                + FOCUS_RING_CLASS
              }
            >
              Open findings →
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function ArtifactDetail({
  artifact,
  onOpen,
}: {
  artifact: SprintEngineArtifact
  onOpen: (() => void) | null
}) {
  const kindLabel = sprintEngineArtifactKindLabel(artifact.kind)
  const statusLabel = sprintEngineArtifactStatusLabels[artifact.status] ?? artifact.status
  return (
    <div className="mt-2 space-y-1.5 pl-3 text-meta leading-5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-micro text-[color:var(--text-disabled)]">
        <span>{kindLabel}</span>
        <span>·</span>
        <span>{statusLabel}</span>
      </div>
      <div className="text-[color:var(--text-strong)] [overflow-wrap:anywhere]">{artifact.title}</div>
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className={
            'interactive -mx-1 inline-flex items-center rounded px-1 py-0.5 text-micro '
            + 'text-[color:var(--accent-primary)] underline-offset-2 '
            + 'hover:text-[color:var(--accent-primary-hover)] hover:underline '
            + FOCUS_RING_CLASS
          }
        >
          Open artifact →
        </button>
      ) : null}
    </div>
  )
}

function EvidenceDetail({
  evidence,
  onViewDiff,
}: {
  evidence: SprintEngineTaskEvidence
  onViewDiff: (() => void) | null
}) {
  const summary = evidence.summary?.trim()
  const fileCount = evidence.touchedFiles.length
  const commandCount = evidence.commandsRan.length
  const resultCount = evidence.results.length
  const diffCount = evidence.diffs?.length ?? 0

  return (
    <div className="mt-2 space-y-2 pl-3 text-meta leading-5">
      <div className="text-micro text-[color:var(--text-disabled)]">Recorded evidence (latest snapshot)</div>
      {summary ? (
        <div className="text-[color:var(--text-default)] [overflow-wrap:anywhere]">{summary}</div>
      ) : (
        <div className="text-[color:var(--text-disabled)]">No summary recorded.</div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-[color:var(--text-muted)]">
        <span>
          <span className="tabular-nums font-mono text-[color:var(--text-default)]">{fileCount}</span> files
        </span>
        <span>
          <span className="tabular-nums font-mono text-[color:var(--text-default)]">{commandCount}</span> commands
        </span>
        <span>
          <span className="tabular-nums font-mono text-[color:var(--text-default)]">{resultCount}</span> results
        </span>
        {diffCount > 0 ? (
          <span>
            <span className="tabular-nums font-mono text-[color:var(--text-default)]">{diffCount}</span> diffs
          </span>
        ) : null}
      </div>
      {diffCount > 0 && onViewDiff ? (
        <button
          type="button"
          onClick={onViewDiff}
          className={
            'interactive -mx-1 inline-flex items-center rounded px-1 py-0.5 text-micro '
            + 'text-[color:var(--accent-primary)] underline-offset-2 '
            + 'hover:text-[color:var(--accent-primary-hover)] hover:underline '
            + FOCUS_RING_CLASS
          }
        >
          View diff →
        </button>
      ) : null}
    </div>
  )
}

// What a VCS milestone reads as on the task's own timeline. The engine records
// these once for the RUN; `buildTaskTimeline` attributes them to the tasks whose
// work they actually carry, so the wording here names the milestone, not the run.
function vcsTimelineVerb(item: Extract<TaskTimelineItem, { kind: 'vcs' }>): string {
  if (item.vcs === 'pr_opened') return 'opened the pull request'
  if (item.vcs === 'pr_merged') return 'merged the pull request'
  return 'committed'
}

function TaskTimeline({
  items,
  emptyLabel,
  task,
  artifacts,
  onViewDiff,
  onOpenArtifact,
  onJumpToFindings,
}: {
  items: TaskTimelineItem[]
  emptyLabel: string
  task: SprintEngineTask
  artifacts: SprintEngineArtifact[]
  onViewDiff: (() => void) | null
  onOpenArtifact: ((artifact: SprintEngineArtifact) => void) | null
  onJumpToFindings: (() => void) | null
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  const groups = useMemo(() => groupTimelineItems(items), [items])

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  if (groups.length === 0) {
    return <div className="text-meta text-[color:var(--text-disabled)]">{emptyLabel}</div>
  }

  return (
    <ol className="space-y-2.5">
      {groups.map((group) => {
        const item = group.primary
        const entry = item.kind === 'activity' ? item.entry : null
        const count = group.count
        const absolute = item.timestamp ? new Date(item.timestamp).toLocaleString() : undefined
        const relative = item.timestamp ? formatRelativeTime(item.timestamp) : '—'
        const lifecycle = timelineItemLifecycle(item)
        const showMessage =
          item.kind === 'activity' ? activityMessageIsVisible(item.entry) : Boolean(item.event.message)
        const message = item.kind === 'activity' ? item.entry.message : item.event.message
        const actor = item.kind === 'activity' ? item.entry.actor : item.event.actor
        const verb = item.kind === 'activity' ? activityVerb(item.entry) : vcsTimelineVerb(item)
        const hasDetail = entry ? activityEntryHasDetail(entry, task, artifacts) : false
        const isExpanded = expanded.has(group.key)
        const matchedFeedback = entry?.type === 'feedback' ? findFeedbackForEntry(entry, task) : null
        const matchedArtifact = entry?.type === 'artifact' ? findArtifactForEntry(entry, artifacts) : null
        const verbContent = (
          <>
            <span className="font-mono text-micro text-[color:var(--text-default)]">{actor}</span>
            <span>{verb}</span>
            {count > 1 ? (
              <span className="tabular-nums text-[color:var(--text-disabled)]">×{count}</span>
            ) : null}
            {hasDetail ? (
              <span
                aria-hidden="true"
                className={
                  'ml-0.5 inline-block text-[color:var(--text-disabled)] transition-transform '
                  + (isExpanded ? 'rotate-90' : '')
                }
              >
                ›
              </span>
            ) : null}
          </>
        )
        return (
          <li
            key={group.key}
            className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-baseline gap-x-2 text-meta leading-5 text-[color:var(--text-default)]"
          >
            {/* Lifecycle glyph, never a tone dot: the entry kind reads by shape
                (knowledge/brand/glyph-system.md), colour only reinforcing it.
                Decorative — the actor and verb beside it already name the entry,
                and speaking the lifecycle word here would announce a comment as
                "Idea". */}
            <LifecycleGlyph state={lifecycle} live={false} className="translate-y-[3px]" />
            <div className="min-w-0">
              {hasDetail ? (
                <button
                  type="button"
                  onClick={() => toggleExpanded(group.key)}
                  aria-expanded={isExpanded}
                  className={
                    'interactive -mx-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded px-1 py-0.5 '
                    + 'text-left text-micro text-[color:var(--text-muted)] '
                    + 'hover:text-[color:var(--text-strong)] '
                    + FOCUS_RING_CLASS
                  }
                >
                  {verbContent}
                </button>
              ) : (
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-micro text-[color:var(--text-muted)]">
                  {verbContent}
                </div>
              )}
              {showMessage ? (
                <CollapsibleMessage
                  message={message}
                  expanded={isExpanded}
                  onToggle={() => toggleExpanded(group.key)}
                  className="mt-0.5 text-[color:var(--text-default)] [overflow-wrap:anywhere]"
                />
              ) : null}
              {hasDetail && isExpanded && entry?.type === 'evidence' ? (
                <EvidenceDetail evidence={task.evidence} onViewDiff={onViewDiff} />
              ) : null}
              {hasDetail && isExpanded && entry?.type === 'feedback' && matchedFeedback ? (
                <FeedbackDetail
                  feedback={matchedFeedback}
                  task={task}
                  onJumpToFindings={onJumpToFindings}
                />
              ) : null}
              {hasDetail && isExpanded && entry?.type === 'artifact' && matchedArtifact ? (
                <ArtifactDetail
                  artifact={matchedArtifact}
                  onOpen={onOpenArtifact ? () => onOpenArtifact(matchedArtifact) : null}
                />
              ) : null}
            </div>
            <span
              title={absolute}
              className="tabular-nums font-mono text-micro text-[color:var(--text-disabled)]"
            >
              {relative}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

// "Send back for rework" only makes sense once a task has moved past active
// implementation — when its owner is reviewing it, or it is already done. For
// todo / ready / in_progress it's either not started or already being worked; for
// needs_input the resolve composer owns the resume path. Sending back returns the
// task to `in_progress` under its original owner (the human Inbox loop).
function taskCanBeSentBackForRework(status: SprintEngineTask['status']): boolean {
  return status === 'review' || status === 'done'
}

// Add-a-comment surface for the task inspector. A plain composer (not a warn
// callout — it carries no attention state), available on every task. The
// comment is recorded on the task for the working agent to read. When the task
// has moved past active implementation (`canSendBack`), a secondary action posts
// the comment and sends the task back for rework — set to `in_progress` under its
// original owner, whom the supervisor re-engages. "Resume"-style re-routing for a
// *blocked* task lives in TaskInputResponsePrompt instead; this surface is everyday
// annotation.
//
// It sits directly under the Timeline heading, ABOVE the newest entry (item
// 2029): the newest entry is the one you are replying to, so the reply field
// belongs beside it rather than past the whole history. Its own heading is
// gone with it — the field says what it is, and the Send control only appears
// once there is something to send.
function TaskCommentComposer({
  taskId,
  canSendBack,
  action,
  onPostTaskComment,
}: {
  taskId: string
  canSendBack: boolean
  action: TaskCommentActionState | undefined
  onPostTaskComment: (taskId: string, body: string, options: { reopenForRework: boolean }) => Promise<boolean>
}) {
  const [body, setBody] = useState('')
  const fieldId = useId()
  const pending = action?.status === 'pending'
  const canSubmit = body.trim().length > 0 && !pending

  const submit = async (reopenForRework: boolean) => {
    if (body.trim().length === 0 || pending) return
    const ok = await onPostTaskComment(taskId, body, { reopenForRework })
    if (ok) setBody('')
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void submit(false)
    }
  }

  const messageToneClass =
    action?.status === 'error'
      ? 'text-[color:var(--tone-error)]'
      : action?.status === 'success'
        ? 'text-[color:var(--tone-good)]'
        : 'text-[color:var(--text-muted)]'

  const dirty = body.trim().length > 0

  return (
    <div>
      <label htmlFor={fieldId} className="sr-only">
        Add a comment for the agent
      </label>
      <div className="flex items-start gap-2">
        <Textarea
          id={fieldId}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={pending}
          rows={dirty ? 3 : 1}
          placeholder="Add a comment"
          fullWidth={false}
          className="min-w-0 flex-1"
        />
        <span
          aria-hidden="true"
          className="shrink-0 pt-1.5 font-mono text-micro text-[color:var(--text-disabled)]"
        >
          ⌘↵
        </span>
      </div>
      {dirty ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <PrimaryButton onClick={() => void submit(false)} disabled={!canSubmit}>
            Comment
          </PrimaryButton>
          {canSendBack ? (
            <GhostButton onClick={() => void submit(true)} disabled={!canSubmit}>
              Comment &amp; send back for rework
            </GhostButton>
          ) : null}
        </div>
      ) : null}
      {action ? (
        <div className={`mt-2 text-meta leading-5 ${messageToneClass}`}>{action.message}</div>
      ) : null}
    </div>
  )
}

function AgentWorkedOnTasksList({
  worked,
  onSelectTask,
}: {
  worked: SprintEngineAgentWorkedOnTask[]
  onSelectTask: (taskId: string) => void
}) {
  if (worked.length === 0) {
    return <div className="text-[color:var(--text-subtle)]">No tasks worked on.</div>
  }
  return (
    <ul className="divide-y divide-[color:var(--border-default)] border-y border-[color:var(--border-default)]">
      {worked.map(({ task, latestActivityAt }) => {
        const statusLabel = sprintEngineTaskStateLabel[task.status] ?? task.status
        const relative = latestActivityAt ? formatRelativeTime(latestActivityAt) : null
        return (
          <li key={task.id}>
            <button
              type="button"
              onClick={() => onSelectTask(task.id)}
              className={`block w-full px-1 py-2.5 text-left interactive hover:bg-[color:var(--bg-surface-raised)] ${FOCUS_RING_INSET_CLASS}`}
            >
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-micro text-[color:var(--text-muted)]">
                <span className="font-mono text-[color:var(--tone-warn)]">{task.id}</span>
                <span>{statusLabel}</span>
                {relative ? (
                  <span className="ml-auto tabular-nums font-mono text-micro text-[color:var(--text-disabled)]">
                    {relative}
                  </span>
                ) : null}
              </div>
              <TruncatedText as="div" text={task.title} className="mt-0.5 text-sm text-[color:var(--text-strong)]" />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function AgentActivityFeed({
  entries,
  emptyLabel,
  onSelectTask,
}: {
  entries: SprintEngineAgentActivityEntry[]
  emptyLabel: string
  onSelectTask: (taskId: string) => void
}) {
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(() => new Set())

  const toggleMessage = useCallback((key: string) => {
    setExpandedMessages((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <div className="text-micro font-semibold text-[color:var(--text-muted)]">Timeline</div>
        <span className="tabular-nums font-mono text-micro text-[color:var(--text-disabled)]">
          {entries.length}
        </span>
      </div>

      {entries.length === 0 ? (
        <div className="text-meta text-[color:var(--text-disabled)]">{emptyLabel}</div>
      ) : (
        <ol className="space-y-2.5">
          {entries.map(({ entry, taskId, taskTitle }) => {
            const key = `${taskId}:${entry.id}`
            const absolute = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : undefined
            const relative = entry.timestamp ? formatRelativeTime(entry.timestamp) : '—'
            const showMessage = activityMessageIsVisible(entry)
            const isExpanded = expandedMessages.has(key)
            const lifecycle = timelineItemLifecycle({
              key,
              timestamp: entry.timestamp,
              kind: 'activity',
              entry,
            })
            return (
              <li
                key={key}
                className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-baseline gap-x-2 text-meta leading-5 text-[color:var(--text-default)]"
              >
                <LifecycleGlyph state={lifecycle} live={false} className="translate-y-[3px]" />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-micro text-[color:var(--text-muted)]">
                    <button
                      type="button"
                      onClick={() => onSelectTask(taskId)}
                      aria-label={`Open ${taskId}`}
                      className={
                        'interactive -mx-1 inline-flex items-baseline rounded px-1 py-0.5 '
                        + 'font-mono text-[color:var(--tone-warn)] '
                        + 'hover:text-[color:var(--text-strong)] '
                        + FOCUS_RING_CLASS
                      }
                    >
                      {taskId}
                    </button>
                    <TruncatedText
                      as="span"
                      text={taskTitle}
                      className="text-[color:var(--text-disabled)]"
                    />
                    <span>{activityVerb(entry)}</span>
                  </div>
                  {showMessage ? (
                    <CollapsibleMessage
                      message={entry.message}
                      expanded={isExpanded}
                      onToggle={() => toggleMessage(key)}
                      className="mt-0.5 text-[color:var(--text-default)] [overflow-wrap:anywhere]"
                    />
                  ) : null}
                </div>
                <span
                  title={absolute}
                  className="tabular-nums font-mono text-micro text-[color:var(--text-disabled)]"
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
const diffCaptureStatuses: ReadonlyArray<SprintEngineTask['status']> = ['review', 'done']

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
    <div className={`grid min-w-max grid-cols-[3.25rem_3.25rem_1.5rem_minmax(24rem,1fr)] gap-2 px-3 py-0.5 font-mono text-micro leading-5 tabular-nums ${diffLineToneClass(line)}`}>
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
      <div className="border-t border-[color:var(--border-subtle)] px-3 py-2 text-meta text-[color:var(--text-disabled)]">
        No hunks captured for this file.
      </div>
    )
  }

  return (
    <div className="max-h-[28rem] overflow-auto border-t border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)]">
      {diff.hunks.map((hunk, index) => (
        <div key={`${diff.path}:${index}`} className="border-b border-[color:var(--border-subtle)] last:border-b-0">
          <div className="min-w-max px-3 py-1.5 font-mono text-micro text-[color:var(--text-muted)]">
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
      <div className="text-meta text-[color:var(--text-disabled)]">
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
    <div>
      {diffs.map((diff, index) => {
          const expandable = diff.hunks.length > 0 && !diff.skippedReason
          const expanded = expandable && expandedPaths.has(diff.path)
          const panelId = `task-diff-${index}-${diff.path.replace(/[^A-Za-z0-9_-]+/g, '-')}`
          const rowContent = (
            <>
              <span className="min-w-0">
                <span className="block font-mono text-meta text-[color:var(--text-strong)] [overflow-wrap:anywhere]">
                  {diff.path}
                </span>
                <span className="mt-0.5 block text-micro text-[color:var(--text-muted)] [overflow-wrap:anywhere]">
                  {formatDiffMeta(diff)}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-3 font-mono text-micro tabular-nums">
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
          const rowLayout = 'grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 rounded px-2 py-1.5 text-left'

          return (
            <div key={`${diff.path}:${diff.oldPath ?? ''}:${index}`}>
              {expandable ? (
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={panelId}
                  onClick={() => toggle(diff.path)}
                  className={`${rowLayout} interactive hover:bg-[color:var(--bg-hover)] ${FOCUS_RING_INSET_CLASS}`}
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
// Task detail groups — pointer, execution facts, readouts (item 2029)
// ──────────────────────────────────────────────────────────────────────────

/**
 * The header's link row: the item this task delivers, and the way to open it.
 *
 * A POINTER, never a restatement. The item carries the intent and the
 * acceptance criteria; this card carries the execution record. When the run was
 * seeded from an epic the row says so, because that is where the item is read
 * inside the sprint (the Epic tab). With nothing to open, the row still names
 * the item — a label is honest, a dead button is not.
 */
function TaskItemPointer({
  task,
  inEpic,
  onOpenBacklogItem,
}: {
  task: SprintEngineTask
  inEpic: boolean
  onOpenBacklogItem: ((relativePath: string) => void) | null
}) {
  const backlogRef = task.backlogRef
  const githubUrl = task.source?.type === 'github' ? task.source.externalUrl?.trim() : ''

  const pointer = backlogRef
    ? {
        label: backlogRef.displayKey?.trim() || basename(backlogRef.projectRelativePath),
        title: backlogRef.projectRelativePath,
        context: inEpic ? 'in this epic' : null,
        onOpen: onOpenBacklogItem
          ? () => onOpenBacklogItem(backlogRef.projectRelativePath)
          : null,
      }
    : githubUrl
      ? {
          label: task.source?.externalId
            ? `${task.source.repo ? `${task.source.repo} ` : ''}#${task.source.externalId}`
            : formatTaskSourceLabel(task),
          title: githubUrl,
          context: 'GitHub issue',
          onOpen: () => window.open(githubUrl, '_blank', 'noopener,noreferrer'),
        }
      : null

  if (!pointer) return null

  const body = (
    <>
      <span className="min-w-0 flex-1 truncate text-meta text-[color:var(--text-default)]">
        <span className="font-mono">{pointer.label}</span>
        {pointer.context ? (
          <span className="text-[color:var(--text-muted)]"> · {pointer.context}</span>
        ) : null}
      </span>
      {pointer.onOpen ? (
        <span className="shrink-0 font-mono text-micro text-[color:var(--accent-primary)]">open →</span>
      ) : null}
    </>
  )

  const layout =
    'mt-3 flex w-full items-center gap-2 rounded-[5px] border border-[color:var(--border-default)] '
    + 'bg-[color:var(--bg-surface-raised)] px-2.5 py-1.5 text-left'

  if (!pointer.onOpen) {
    return (
      <div className={layout} title={pointer.title}>
        {body}
      </div>
    )
  }
  return (
    // The item's own path is the tooltip: the row shows its key, and the key
    // alone does not say which file it is on a multi-repo run.
    <Tooltip content={pointer.title} placement="top" wrapperClassName="block">
      <button
        type="button"
        onClick={pointer.onOpen}
        aria-label={`Open ${pointer.label}`}
        className={`${layout} interactive hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] ${FOCUS_RING_CLASS}`}
      >
        {body}
      </button>
    </Tooltip>
  )
}

/**
 * Where the task runs: the three facts the backlog item genuinely does not
 * have. Modules are the task's `ownedPaths` — directories since item 2019 —
 * named the way a person refers to them rather than shown as a file whitelist.
 */
function TaskExecutionFacts({ task }: { task: SprintEngineTask }) {
  const modules = useMemo(() => taskModuleLabels(task.ownedPaths), [task.ownedPaths])
  const after = task.dependsOn.length > 0 ? task.dependsOn.join(' · ') : '—'
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-3">
      <TaskFact term="Repo" value={task.repo || '—'} />
      <TaskFact
        term="Modules"
        value={modules.length > 0 ? modules.map((module) => module.name).join(' · ') : '—'}
        title={modules.map((module) => module.path).join('\n')}
      />
      <TaskFact term="After" value={after} />
    </dl>
  )
}

function TaskFact({ term, value, title }: { term: string; value: string; title?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-micro text-[color:var(--text-subtle)]">{term}</dt>
      <dd
        className="mt-0.5 font-mono text-micro text-[color:var(--text-default)] [overflow-wrap:anywhere]"
        title={title || undefined}
      >
        {value}
      </dd>
    </div>
  )
}

// Activity over the elapsed window. Self-scaling — the tallest bar is the
// busiest bucket — so it needs no axis and cannot be read against an invented
// maximum. The bucket holding the most recent entry carries full accent.
function ActivitySparkline({ bars, label }: { bars: ActivitySparkBar[]; label: string }) {
  return (
    <div className="mt-1 flex h-[18px] items-end gap-[2px]" role="img" aria-label={label}>
      {bars.map((bar, index) => (
        // One ink at two strengths, not two colours: the accent held back to a
        // quarter for history and full for the newest bucket. The soft accent
        // token resolves near-grey on a light surface, which reads as a stray
        // rectangle rather than a chart.
        <span
          key={index}
          className={`flex-1 rounded-[1px] bg-[color:var(--accent-primary)] ${
            bar.recent ? '' : 'opacity-25'
          }`}
          // A quiet bucket still paints its baseline. A bucket of literally no
          // height leaves a gap, and a task whose activity clustered early in a
          // long window is mostly gaps — which renders as two stray rectangles
          // rather than as a chart. 1px is the axis, and stays unmistakably
          // under the 0.18 floor any bucket with activity carries.
          style={bar.height > 0 ? { height: `${Math.round(bar.height * 100)}%` } : { height: '1px' }}
        />
      ))}
    </div>
  )
}

// Added vs deleted as a RATIO — the one bar on this pane, and honest because a
// ratio scales itself. A bar for tokens or for a raw line count would have to
// be drawn against a maximum nobody set.
function DiffRatioBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions
  if (total <= 0) return null
  const addPct = (additions / total) * 100
  return (
    <div
      className="mt-1 flex h-[5px] overflow-hidden rounded-[3px] bg-[color:var(--bg-hover)]"
      role="img"
      aria-label={`${additions} added, ${deletions} deleted`}
    >
      <span className="block h-full bg-[color:var(--diff-added)]" style={{ width: `${addPct}%` }} />
      <span className="block h-full bg-[color:var(--diff-removed)]" style={{ width: `${100 - addPct}%` }} />
    </div>
  )
}

function TaskReadout({
  label,
  value,
  muted,
  children,
}: {
  label: string
  value: string
  muted?: boolean
  children?: React.ReactNode
}) {
  return (
    <div className="min-w-0 flex-1">
      <div className="text-micro text-[color:var(--text-subtle)]">{label}</div>
      <div
        className={`mt-0.5 truncate font-mono text-meta ${
          muted ? 'text-[color:var(--text-disabled)]' : 'text-[color:var(--text-strong)]'
        }`}
      >
        {value}
      </div>
      {children}
    </div>
  )
}

/**
 * How it is going: three readouts true of every task whatever it does, which is
 * what makes them chartable at all.
 *
 * Elapsed carries a sparkline and Diff carries an add/delete ratio bar because
 * both scale themselves. Tokens carries NO bar: token counts have no natural
 * ceiling, so any bar would be drawn against an invented maximum. An agent
 * whose CLI exposes no readable token source reads as unmeasured — never as a
 * zero, which would claim a measurement nobody made.
 */
function TaskReadouts({
  task,
  tokenUsage,
  timeline,
  diffOpen,
  captureExpected,
  onToggleDiff,
}: {
  task: SprintEngineTask
  tokenUsage: SprintEngineTaskTokenUsage | null | undefined
  timeline: TaskTimelineItem[]
  diffOpen: boolean
  /** The task has reached a state where the engine captures a diff. With no
   *  diffs recorded anyway the capture FAILED, and must not read as "no
   *  changes" — a task that has not published yet simply has nothing to show. */
  captureExpected: boolean
  onToggleDiff: (() => void) | null
}) {
  // One clock read per render pass; the pane re-renders on every projection
  // tick, so a live task's elapsed figure stays current without a timer.
  const nowMs = Date.now()
  const elapsedMs = taskElapsedMs(task, nowMs)
  const startedMs = task.startedAt ? Date.parse(task.startedAt) : NaN
  const bars = useMemo(() => {
    if (elapsedMs === null || !Number.isFinite(startedMs)) return []
    return taskActivitySparkline(
      timeline.map((item) => item.timestamp),
      { startMs: startedMs, endMs: startedMs + elapsedMs },
    )
  }, [timeline, startedMs, elapsedMs])

  const diff = taskDiffTotals(task)
  const tokens = tokenUsage?.measured
    ? formatTokenCount(tokenUsage.total.total)
    : tokenUsage?.ownerOwnsMultipleTasks
      ? 'not attributable'
      : 'unmeasured'

  return (
    <div className="flex gap-4">
      <TaskReadout
        label="Elapsed"
        value={elapsedMs === null ? 'not started' : formatElapsed(elapsedMs)}
        muted={elapsedMs === null}
      >
        {bars.length > 0 ? <ActivitySparkline bars={bars} label="Activity over time" /> : null}
      </TaskReadout>

      <div className="min-w-0 flex-1">
        {diff && onToggleDiff ? (
          <button
            type="button"
            onClick={onToggleDiff}
            aria-expanded={diffOpen}
            className={`interactive -mx-1 block w-full rounded px-1 text-left ${FOCUS_RING_CLASS}`}
          >
            <div className="text-micro text-[color:var(--text-subtle)]">
              Diff
              <span
                aria-hidden="true"
                className={`ml-1 inline-block text-[color:var(--text-disabled)] transition-transform ${
                  diffOpen ? 'rotate-90' : ''
                }`}
              >
                ›
              </span>
            </div>
            <div className="mt-0.5 truncate font-mono text-meta text-[color:var(--text-strong)]">
              +{diff.additions} −{diff.deletions}
            </div>
            <DiffRatioBar additions={diff.additions} deletions={diff.deletions} />
          </button>
        ) : (
          <TaskReadout
            label="Diff"
            value={
              diff
                ? `+${diff.additions} −${diff.deletions}`
                : captureExpected
                  ? 'unavailable'
                  : '—'
            }
            muted={!diff}
          >
            {diff ? <DiffRatioBar additions={diff.additions} deletions={diff.deletions} /> : null}
          </TaskReadout>
        )}
      </div>

      <TaskReadout label="Tokens" value={tokens} muted={!tokenUsage?.measured} />
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Inspector panel — task / artifact / agent / preview branches.
// ──────────────────────────────────────────────────────────────────────────

// The lifecycle line an inspector pane wears beside its title, as one node so
// the artifact, agent and task panes state it identically. It rides
// `PanelHeader`'s `scope` slot — the interactive-or-stateful counterpart to a
// plain `subtitle` — which is what let all three panes drop their hand-rolled
// two-line bands (2112).
function InspectorStatusScope({
  lifecycle,
  live,
  label,
  id,
  glyph,
  busy = false,
}: {
  lifecycle?: LifecycleState
  live?: boolean
  label: string
  id?: string
  /** Replaces the lifecycle glyph — the agent pane leads with a role avatar. */
  glyph?: React.ReactNode
  /** Work in flight right now. Draws the spinner the agent pane's status line
   *  carried, which a status WORD alone ("running") does not convey as live. */
  busy?: boolean
}): JSX.Element {
  return (
    // `overflow-hidden` is load-bearing, not cosmetic. `min-w-0` lets this box
    // shrink past its own content — which is what makes the title truncate last
    // — but `·` and the id are `shrink-0`, so without a clip they keep full
    // width and spill out of the box onto PanelHeader's action cluster, drawing
    // the id underneath the expand glyph. Clipping keeps the overflow inside the
    // scope's own bounds. Safe here because this scope is text and glyphs only;
    // it must not migrate up into PanelHeader's shared slot, which also hosts
    // interactive pickers whose focus ring a clip would cut.
    <span className="flex min-w-0 items-center gap-1.5 overflow-hidden text-meta text-[color:var(--text-muted)]">
      {glyph ?? (lifecycle ? <LifecycleGlyph state={lifecycle} live={Boolean(live)} /> : null)}
      {busy ? <Spinner size={12} /> : null}
      <span className="truncate">{label}</span>
      {id ? (
        <>
          <span aria-hidden="true" className="shrink-0 text-[color:var(--text-disabled)]">
            ·
          </span>
          <span className="shrink-0 font-mono tabular-nums">{id}</span>
        </>
      ) : null}
    </span>
  )
}

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
  agents,
  tasksById,
  selectedTaskBoardColumn,
  selectedTaskNeedsInputNote,
  selectedTaskTokenUsage,
  selectedTaskArtifacts,
  selectedTaskArtifactBlockers,
  artifactActions,
  taskInputActions,
  taskCommentActions,
  onClose,
  onSelectTask,
  onOpenArtifact,
  onApproveArtifact,
  onRequestArtifactChanges,
  onSubmitPreviewAnnotations,
  onResolveTaskInput,
  onPostTaskComment,
  onOpenBacklogItem,
  taskItemInEpic = false,
  onBackFromArtifact,
  onPopOutArtifact,
  onSpawnAgent,
  onOpenAgentTerminal,
  terminalActionsUnavailable,
  isAgentTerminalLive,
  isExpanded,
  onToggleExpand,
}: {
  selection: SprintEngineInspectorSelection
  sprintEngineState: import('../../types/workspace').SprintEngineState
  runtimeAgents: RuntimeAgentView[]
  agents: Record<string, AgentState>
  tasksById: Record<string, SprintEngineTask>
  selectedTaskBoardColumn: SprintEngineTaskBoardColumn | null
  selectedTaskNeedsInputNote: string | null
  /** Owner-session token usage for the selected task (single-owner engine),
   * from the run's token ledger. Absent/unmeasured renders no figure. */
  selectedTaskTokenUsage?: SprintEngineTaskTokenUsage | null
  selectedTaskArtifacts: SprintEngineArtifact[]
  selectedTaskArtifactBlockers: ReturnType<typeof getSprintEngineArtifactDependencyBlockers>
  artifactActions: Record<string, ArtifactActionState>
  taskInputActions: Record<string, TaskInputActionState>
  taskCommentActions: Record<string, TaskCommentActionState>
  onClose: () => void
  onSelectTask: (taskId: string) => void
  onOpenArtifact: (artifact: SprintEngineArtifact) => void | Promise<void>
  onApproveArtifact: (artifact: SprintEngineArtifact) => void | Promise<void>
  onRequestArtifactChanges: (artifact: SprintEngineArtifact) => void
  /**
   * Annotate sink for the artifact preview (MC-1468): the board passes this
   * only while the previewed artifact is an HTML mockup that can still receive
   * a change request; the callback pre-fills the request-changes dialog with
   * the serialized pin batch. Absent = the frame's Comment mode stays off.
   */
  onSubmitPreviewAnnotations?: (annotations: MockupAnnotation[]) => Promise<void>
  onResolveTaskInput: (taskId: string, resolution: string, complete: boolean) => Promise<boolean>
  onPostTaskComment: (taskId: string, body: string, options: { reopenForRework: boolean }) => Promise<boolean>
  /**
   * Open the backlog item a task points at (item 2029's header pointer). Null
   * when this mount has nowhere to open it — no resident workspace to reveal it
   * in and no Epic tab to switch to — and the pointer then renders as a plain
   * label rather than a button that does nothing.
   */
  onOpenBacklogItem?: ((relativePath: string) => void) | null
  /** The run was seeded from the epic this task's item belongs to, so the
   *  pointer can say where the item is read inside the sprint. */
  taskItemInEpic?: boolean
  onBackFromArtifact: () => void
  onPopOutArtifact: () => void
  onSpawnAgent: (agentId: string) => void
  onOpenAgentTerminal: (agentId: string) => void
  /** Set when the run has no resident workspace (the Sprints door, MC-1800):
   *  its terminals live in that workspace, so opening and spawning are disabled
   *  and say this reason rather than doing nothing. */
  terminalActionsUnavailable?: string
  isAgentTerminalLive: (agentId: string) => boolean
  isExpanded: boolean
  onToggleExpand: () => void
}) {
  if (selection.kind === 'artifact-preview') {
    // HTML artifacts (mockups) render in the sandboxed frame the Inbox seed
    // preview already uses — same preview-kind helper, so the two surfaces
    // route identically by construction. Everything else keeps the
    // extension-based markdown/plain-text body.
    const isHtmlArtifact =
      sprintEngineSeedPreviewKind(selection.artifact.relativePath) === 'html'
    return (
      <FilePreviewPane
        title={selection.artifact.name}
        path={selection.artifact.path}
        content={selection.artifact.content}
        onBack={onBackFromArtifact}
        onPopOut={onPopOutArtifact}
        onClose={onClose}
        body={
          isHtmlArtifact ? (
            <HtmlArtifactFrame
              absolutePath={selection.artifact.path}
              relativePath={selection.artifact.relativePath}
              watchDirectoryPath={parentPath(selection.artifact.path)}
              enableSourceView
              onSubmitAnnotations={onSubmitPreviewAnnotations}
            />
          ) : undefined
        }
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
    const localAgent = agents[agent.id]
    const displayName = localAgent?.name?.trim() || agent.label
    const runtime = runtimeAgents.find((entry) => entry.agentId === agent.id) ?? null
    const hasLiveTerminal = isAgentTerminalLive(agent.id)
    const runtimeStatus = runtime?.status ?? (hasLiveTerminal ? 'running' : 'idle')
    const currentTask = runtime?.currentTaskId
      ? sprintEngineState.tasks.find((task) => task.id === runtime.currentTaskId) ?? null
      : null
    const workedOnTasks = getSprintEngineTasksWorkedOnByAgent(agent.id, sprintEngineState.tasks)
    const agentActivity = getSprintEngineAgentActivityDescending(agent.id, sprintEngineState.tasks)
    return (
      <div className="flex h-full min-h-0 flex-col">
        {/* An agent with no role is its id and its status. Nothing stands in
            for the role, and no separator is left where one would have gone
            (MC-2055) — so the scope opens on the avatar only when there is a
            role to name, and the id trails the status either way. */}
        <PanelHeader
          title={displayName}
          scope={
            <InspectorStatusScope
              glyph={agent.role ? <RoleAvatar role={agent.role} size="sm" ariaLabel="" /> : undefined}
              label={
                agent.role
                  ? `${getSprintEngineRoleLabel(agent.role)} · ${runtimeStatus}`
                  : runtimeStatus
              }
              id={agent.id}
              busy={runtimeStatus === 'running'}
            />
          }
          primaryAction={
            <InspectorChromeActions
              expanded={isExpanded}
              onToggleExpand={onToggleExpand}
              onClose={onClose}
              closeLabel="Close agent detail"
            />
          }
          divider={false}
        />
        <div className="border-b border-[color:var(--border-default)] px-3 pb-2">
          <div className="flex flex-wrap gap-1.5">
            {hasLiveTerminal ? (
              <button
                type="button"
                onClick={() => onOpenAgentTerminal(agent.id)}
                disabled={Boolean(terminalActionsUnavailable)}
                aria-label={
                  terminalActionsUnavailable
                    ? `Open Terminal — unavailable: ${terminalActionsUnavailable}`
                    : undefined
                }
                className={`h-7 rounded border border-[color:var(--border-strong)] px-2.5 text-micro font-medium text-[color:var(--text-default)] interactive hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-strong)] disabled:cursor-not-allowed disabled:opacity-45 ${FOCUS_RING_CLASS}`}
              >
                Open Terminal
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onSpawnAgent(agent.id)}
                disabled={Boolean(terminalActionsUnavailable)}
                aria-label={
                  terminalActionsUnavailable
                    ? `Spawn — unavailable: ${terminalActionsUnavailable}`
                    : undefined
                }
                className={`h-7 rounded border border-[color:var(--accent-primary)] bg-[color:var(--accent-primary-soft)] px-2.5 text-micro font-semibold text-[color:var(--accent-primary)] interactive hover:bg-[color:var(--accent-primary-soft-strong)] disabled:cursor-not-allowed disabled:opacity-45 ${FOCUS_RING_CLASS}`}
              >
                Spawn
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 space-y-5 overflow-auto px-5 py-4 text-body leading-6 text-[color:var(--text-default)]">
          <div>
            <div className="mb-2 text-micro font-bold text-[color:var(--text-disabled)]">Currently Working On</div>
            {currentTask ? (
              <button
                type="button"
                onClick={() => onSelectTask(currentTask.id)}
                className={`block w-full rounded-md border border-[color:var(--border-default)] px-3 py-2 text-left interactive hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-surface-raised)] ${FOCUS_RING_CLASS}`}
              >
                <div className="font-mono text-micro text-[color:var(--tone-warn)]">{currentTask.id}</div>
                <TruncatedText as="div" text={currentTask.title} className="mt-1 text-sm font-semibold text-[color:var(--text-strong)]" />
              </button>
            ) : (
              <div className="text-[color:var(--text-subtle)]">No active task assignment.</div>
            )}
          </div>

          <div>
            <div className="mb-2 text-micro font-bold text-[color:var(--text-disabled)]">
              Tasks worked on ({workedOnTasks.length})
            </div>
            <AgentWorkedOnTasksList worked={workedOnTasks} onSelectTask={onSelectTask} />
          </div>

          <AgentActivityFeed
            entries={agentActivity}
            emptyLabel="No activity recorded yet."
            onSelectTask={onSelectTask}
          />
        </div>
      </div>
    )
  }

  // Task mode (default branch).
  const selectedTask = selection.task
  // One status vocabulary across the app: the shape-coded LifecycleGlyph (also
  // on Kanban cards and Backlog), not the 6px StatusDot. `live` is reserved for
  // states that are genuinely moving — a running worker or an unanswered ask.
  // `canceled` is a task status with no board column, so it falls back to `todo`
  // rather than widening the column vocabulary for a state the board never shows.
  const lifecycle = taskBoardColumnToLifecycle(
    selectedTaskBoardColumn ?? (selectedTask.status === 'canceled' ? 'todo' : selectedTask.status)
  )
  const lifecycleLive = lifecycle === 'in_progress' || lifecycle === 'needs_input'

  return (
    // The anatomy rules for this pane (zero internal horizontal rules, one
    // stream, compose above the newest entry) are asserted on the RENDERED
    // surface by scripts/testing/sprintengine-task-detail-pass.mjs, which finds
    // the pane by this attribute.
    <div data-sprintengine-task-detail className="flex h-full min-h-0 flex-col">
      {/* Who and what. No rule under it: the space between this group and the
          next is what separates them (item 2029 anatomy). */}
      <PanelHeader
        title={selectedTask.title}
        scope={
          <InspectorStatusScope
            lifecycle={lifecycle}
            live={lifecycleLive}
            label={LIFECYCLE_LABEL[lifecycle]}
            id={selectedTask.id}
          />
        }
        primaryAction={
          <InspectorChromeActions
            expanded={isExpanded}
            onToggleExpand={onToggleExpand}
            onClose={onClose}
            closeLabel="Close task detail"
          />
        }
        divider={false}
      />
      <div className="px-3 pb-2">
        <TaskItemPointer
          task={selectedTask}
          inEpic={taskItemInEpic}
          onOpenBacklogItem={onOpenBacklogItem ?? null}
        />
      </div>

      <SprintEngineTaskBody
        key={selectedTask.id}
        selectedTask={selectedTask}
        selectedTaskNeedsInputNote={selectedTaskNeedsInputNote}
        selectedTaskTokenUsage={selectedTaskTokenUsage}
        selectedTaskArtifacts={selectedTaskArtifacts}
        selectedTaskArtifactBlockers={selectedTaskArtifactBlockers}
        runEvents={sprintEngineState.events}
        artifactActions={artifactActions}
        taskInputAction={taskInputActions[selectedTask.id]}
        taskCommentAction={taskCommentActions[selectedTask.id]}
        tasksById={tasksById}
        runtimeAgents={runtimeAgents}
        onSelectTask={onSelectTask}
        onOpenArtifact={onOpenArtifact}
        onApproveArtifact={onApproveArtifact}
        onRequestArtifactChanges={onRequestArtifactChanges}
        onResolveTaskInput={onResolveTaskInput}
        onPostTaskComment={onPostTaskComment}
        onOpenAgentTerminal={onOpenAgentTerminal}
        terminalActionsUnavailable={terminalActionsUnavailable}
      />
    </div>
  )
}

function SprintEngineTaskBody({
  selectedTask,
  selectedTaskNeedsInputNote,
  selectedTaskTokenUsage,
  selectedTaskArtifacts,
  selectedTaskArtifactBlockers,
  runEvents,
  artifactActions,
  taskInputAction,
  taskCommentAction,
  tasksById,
  runtimeAgents,
  onSelectTask,
  onOpenArtifact,
  onApproveArtifact,
  onRequestArtifactChanges,
  onResolveTaskInput,
  onPostTaskComment,
  onOpenAgentTerminal,
  terminalActionsUnavailable,
}: {
  selectedTask: SprintEngineTask
  selectedTaskNeedsInputNote: string | null
  selectedTaskTokenUsage?: SprintEngineTaskTokenUsage | null
  selectedTaskArtifacts: SprintEngineArtifact[]
  selectedTaskArtifactBlockers: ReturnType<typeof getSprintEngineArtifactDependencyBlockers>
  /** The run's event log. The timeline merges the VCS milestones this task's
   *  own work reached out of it; nothing else is read from it here. */
  runEvents: SprintEngineEvent[]
  artifactActions: Record<string, ArtifactActionState>
  taskInputAction: TaskInputActionState | undefined
  taskCommentAction: TaskCommentActionState | undefined
  tasksById: Record<string, SprintEngineTask>
  runtimeAgents: RuntimeAgentView[]
  onSelectTask: (taskId: string) => void
  onOpenArtifact: (artifact: SprintEngineArtifact) => void | Promise<void>
  onApproveArtifact: (artifact: SprintEngineArtifact) => void | Promise<void>
  onRequestArtifactChanges: (artifact: SprintEngineArtifact) => void
  onResolveTaskInput: (taskId: string, resolution: string, complete: boolean) => Promise<boolean>
  onPostTaskComment: (taskId: string, body: string, options: { reopenForRework: boolean }) => Promise<boolean>
  onOpenAgentTerminal: (agentId: string) => void
  terminalActionsUnavailable?: string
}) {
  const openIssues = getOpenSprintEngineFeedbackIssues(selectedTask.feedback)
  const openFindings = getOpenSprintEngineFeedbackFindings(selectedTask.feedback)
  const timeline = useMemo(
    () => buildTaskTimeline(selectedTask, runEvents),
    [selectedTask, runEvents],
  )
  const findingsAnchorRef = useRef<HTMLDivElement | null>(null)
  const changedFilesRef = useRef<HTMLDivElement | null>(null)
  const diffCount = selectedTask.evidence.diffs?.length ?? 0
  const captureExpected = diffCaptureStatuses.includes(selectedTask.status)
  const hasChangedFiles = captureExpected || diffCount > 0
  const [diffOpen, setDiffOpen] = useState(false)
  const hasOpenFindings = openIssues.length + openFindings.length > 0
  const onJumpToFindings = hasOpenFindings
    ? () => findingsAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    : null
  // The Diff readout IS the way into the changed files — the tab beside the
  // stream is gone (item 2029), so the number you read and the files behind it
  // are one control. The timeline's evidence entry opens the same section.
  const openChangedFiles = hasChangedFiles
    ? () => {
        setDiffOpen(true)
        window.requestAnimationFrame(() =>
          changedFilesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        )
      }
    : null

  return (
    <div className="flex-1 space-y-5 overflow-auto px-5 pb-4 pt-2 text-body leading-6 text-[color:var(--text-default)]">
      {/* Who is on it — the header names the task, this names the workers and
          opens their terminals. */}
      <TaskImplementerTimeline
        task={selectedTask}
        runtimeAgents={runtimeAgents}
        onOpenAgentTerminal={onOpenAgentTerminal}
        terminalActionsUnavailable={terminalActionsUnavailable}
      />

      {/* An exception state preempts the reading order: a task waiting on a
          person is the only thing worth reading first. */}
      <TaskNeedsInputCallout
        task={selectedTask}
        fallbackNote={selectedTaskNeedsInputNote}
        runtimeAgents={runtimeAgents}
        artifacts={selectedTaskArtifacts}
        artifactActions={artifactActions}
        taskInputAction={taskInputAction}
        onOpenArtifact={(artifact) => void onOpenArtifact(artifact)}
        onApproveArtifact={(artifact) => void onApproveArtifact(artifact)}
        onRequestArtifactChanges={onRequestArtifactChanges}
        onResolveTaskInput={onResolveTaskInput}
      />

      {selectedTaskArtifactBlockers.length > 0 ? (
        <ArtifactBlockerList blockers={selectedTaskArtifactBlockers} />
      ) : null}

      {/* Where it runs. */}
      <TaskExecutionFacts task={selectedTask} />

      {/* How it is going. */}
      <div>
        <TaskReadouts
          task={selectedTask}
          tokenUsage={selectedTaskTokenUsage}
          timeline={timeline}
          diffOpen={diffOpen}
          captureExpected={captureExpected}
          // Only offered when there is something behind it: a task whose
          // capture failed says so in the readout instead of opening on the
          // failure message.
          onToggleDiff={diffCount > 0 ? () => setDiffOpen((open) => !open) : null}
        />
        {hasChangedFiles && diffOpen ? (
          <div ref={changedFilesRef} className="mt-2">
            <ChangedFilesSection task={selectedTask} />
          </div>
        ) : null}
      </div>

      {/* MC-1469: artifacts are the task's outputs, not reference metadata —
          they render first-class rather than inside the collapsed More section.
          Hidden entirely when a task has none so artifact-less tasks stay quiet. */}
      {selectedTaskArtifacts.length > 0 ? (
        <SprintEngineArtifactList
          artifacts={selectedTaskArtifacts}
          tasksById={tasksById}
          actions={artifactActions}
          title="Artifacts"
          emptyLabel=""
          dividers={false}
          onSelectTask={onSelectTask}
          onOpenArtifact={(artifact) => void onOpenArtifact(artifact)}
          onApproveArtifact={(artifact) => void onApproveArtifact(artifact)}
          onRequestArtifactChanges={onRequestArtifactChanges}
        />
      ) : null}

      <div ref={findingsAnchorRef}>
        <TaskOpenFindings issues={openIssues} findings={openFindings} />
      </div>

      {/* What happened — one stream, compose above the newest entry. There is
          no description and no acceptance criteria on this pane: those are the
          backlog item's words, and the header points at it. */}
      <div>
        <div className="mb-2 flex flex-wrap items-baseline gap-2">
          <div className="text-micro font-semibold text-[color:var(--text-muted)]">Timeline</div>
          <span className="tabular-nums font-mono text-micro text-[color:var(--text-disabled)]">
            {timeline.length}
          </span>
        </div>
        <div className="mb-3">
          <TaskCommentComposer
            taskId={selectedTask.id}
            canSendBack={taskCanBeSentBackForRework(selectedTask.status)}
            action={taskCommentAction}
            onPostTaskComment={onPostTaskComment}
          />
        </div>
        <TaskTimeline
          items={timeline}
          emptyLabel="Nothing has happened on this task yet."
          task={selectedTask}
          artifacts={selectedTaskArtifacts}
          onViewDiff={openChangedFiles}
          onOpenArtifact={(artifact) => void onOpenArtifact(artifact)}
          onJumpToFindings={onJumpToFindings}
        />
      </div>

      {/* Everything the engine records that this pane does not headline. Kept
          reachable, never deleted — agents read the full metadata and the run
          statistics are built from it. */}
      <details className="group">
        <summary className="cursor-pointer list-none text-micro font-semibold text-[color:var(--text-muted)] hover:text-[color:var(--text-default)]">
          <span className="mr-1 inline-block transition-transform group-open:rotate-90" aria-hidden="true">›</span>
          More
        </summary>
        <div className="mt-3 space-y-4">
          <DefinitionList
            layout="compact-grid"
            items={[
              { term: 'Source', description: formatTaskSourceLabel(selectedTask) },
              {
                term: selectedTask.completedAt ? 'Completed' : 'Started',
                description: formatTimestamp(selectedTask.completedAt ?? selectedTask.startedAt),
              },
              ...(selectedTask.model
                ? [{ term: 'Model', description: selectedTask.model }]
                : []),
            ]}
          />

          {selectedTask.triage ? (
            <InlineNotice tone="warn" title="Architect triage" hint={selectedTask.triage.summary} />
          ) : null}

          <SectionList
            title="Owned modules"
            items={selectedTask.ownedPaths}
            emptyLabel="No owned modules recorded."
          />
          <SectionList
            title="Implementation notes"
            items={selectedTask.implementationNotes}
            emptyLabel="No implementation notes recorded."
          />
          {selectedTask.notes.length > 0 ? (
            <SectionList title="Planning notes" items={selectedTask.notes} emptyLabel="" />
          ) : null}

          <div>
            <div className="mb-2 text-micro font-semibold text-[color:var(--text-muted)]">
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
  )
}
