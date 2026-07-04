// Sprint Engine inspector data helpers — pure formatters, tone resolvers,
// and inbox-ordering logic. Split out of SprintEngineBoardPanel.tsx so the
// orchestrator stays focused on state coordination and the inspector
// rendering carries its own data shaping in a separately testable module.
//
// What lives here:
//   - SOURCE_HANDOFF_ARTIFACT_ID — sentinel ID for the architect handover
//     artifact that always sorts to the top of the inbox.
//   - MobileArtifactDecision type + accessors (resolve approve / request-
//     changes signals from mobile actors).
//   - Artifact summary / timestamp / tone / status-label helpers.
//   - Sprint Engine inbox row tone + supporting-line resolvers.
//   - Inspector-shared types: selection, runtime-agent view, artifact &
//     task-ready action states (consumed by both orchestrator and inspector).
//   - Runtime-status and task-source/sync label formatters.

import type {
  SprintEngineArtifact,
  SprintEngineQualityGateAttempt,
  SprintEngineRoleId,
  SprintEngineTask,
} from '../../types/workspace'
import {
  getSprintEngineArtifactDependencyBlockers,
  sprintEngineArtifactKindLabel,
  type SprintEngineAgentRosterItem,
} from '../../utils/sprintengine'
import { formatTimestamp } from '../../utils/time'
import type { LifecycleState, Tone } from '../ui'

export { formatTimestamp }

export type RuntimeAgentView = {
  agentId: string
  label: string
  role: SprintEngineRoleId
  status: string
  currentTaskId: string | null
}

export type SprintEngineInspectorSelection =
  | { kind: 'task'; task: SprintEngineTask }
  | { kind: 'agent'; agent: SprintEngineAgentRosterItem }
  | { kind: 'artifact'; artifact: SprintEngineArtifact }
  | {
      kind: 'artifact-preview'
      artifact: { id: string; path: string; name: string; content: string }
    }

export type SprintEngineGateAttemptVisualState =
  | 'approved'
  | 'changes_requested'
  | 'failed'
  | 'blocked'
  | 'released'
  | 'superseded'
  | 'in_flight'
  | 'unknown'

export function sprintEngineGateAttemptVisualState(
  attempt: SprintEngineQualityGateAttempt,
): SprintEngineGateAttemptVisualState {
  const status = attempt.verdict ?? attempt.status
  if (status === 'approved') return 'approved'
  if (status === 'changes_requested') return 'changes_requested'
  if (status === 'failed') return 'failed'
  if (status === 'blocked') return 'blocked'
  if (status === 'released') return 'released'
  if (status === 'superseded') return 'superseded'
  if (Boolean(attempt.startedAt) && !attempt.completedAt) return 'in_flight'
  return 'unknown'
}

export type ArtifactActionKind = 'open' | 'approve' | 'requestChanges'

export type ArtifactActionState = {
  kind: ArtifactActionKind
  status: 'pending' | 'success' | 'error'
  message: string
}

// Per-task transient state for resolving a `needs_input` blocker from the
// inspector composer (send-and-resume / resolve-and-complete). Keyed by taskId,
// it mirrors the artifact action-state machine but carries no `kind` because a
// task input has a single resolution path.
export type TaskInputActionState = {
  status: 'pending' | 'success' | 'error'
  message: string
}

// Per-task transient state for the inspector comment composer (add a comment,
// or comment + send back for rework). Keyed by taskId; same shape as the
// needs-input action state.
export type TaskCommentActionState = {
  status: 'pending' | 'success' | 'error'
  message: string
}

export function runtimeStatusTone(status: string): Tone {
  switch (status) {
    case 'running':
    case 'needs_input':
      return 'warn'
    case 'complete':
    case 'done':
      return 'good'
    case 'error':
      return 'error'
    // `retired` (parked, revived when work returns) and a departed agent (now
    // plain `idle` — liveness is derived, not stored) keep a muted neutral tone.
    case 'planning':
    case 'exited':
    case 'retired':
    default:
      return 'neutral'
  }
}

export function runtimeStatusLabel(status: string): string {
  switch (status) {
    case 'needs_input':
      return 'Needs Input'
    case 'running':
      return 'Running'
    case 'planning':
      return 'Planning'
    case 'complete':
      return 'Complete'
    case 'done':
      return 'Done'
    case 'exited':
      return 'Exited'
    case 'error':
      return 'Error'
    // `retired` means the terminal is parked — "not running now, revived when
    // work returns" — so it reads as the honest "Paused" rather than "Idle"
    // (ready and waiting). A departed agent is now plain `idle` (liveness is
    // derived, not stored) and renders through the default Idle presentation.
    case 'retired':
      return 'Paused'
    default:
      return 'Idle'
  }
}

export function formatTaskSourceLabel(task: SprintEngineTask): string {
  if (!task.source) return 'Local'
  if (task.source.type === 'github') {
    return task.source.externalId ? `GitHub #${task.source.externalId}` : 'GitHub'
  }
  return task.source.type.charAt(0).toUpperCase() + task.source.type.slice(1)
}

export function formatTaskSyncStatusLabel(task: SprintEngineTask): string | null {
  switch (task.source?.syncStatus) {
    case 'local_changed':
      return 'Local edits'
    case 'remote_changed':
      return 'Remote changed'
    case 'conflict':
      return 'Sync conflict'
    default:
      return null
  }
}

export function formatTaskSyncStatusDescription(task: SprintEngineTask): string {
  switch (task.source?.syncStatus) {
    case 'local_changed':
      return 'Local execution details differ from the last synced GitHub issue.'
    case 'remote_changed':
      return 'GitHub changed since the previous sync; this task was refreshed because local details were unchanged.'
    case 'conflict':
      return 'GitHub and local execution details both changed. Review the issue before starting work.'
    default:
      return ''
  }
}

export function formatArtifactSummary(artifacts: SprintEngineArtifact[]): string {
  const pendingCount = artifacts.filter((artifact) =>
    artifact.status !== 'approved' && artifact.status !== 'superseded'
  ).length
  const approvedCount = artifacts.filter((artifact) => artifact.status === 'approved').length

  if (pendingCount > 0 && approvedCount > 0) {
    return `${pendingCount} pending, ${approvedCount} approved`
  }
  if (pendingCount > 0) {
    return `${pendingCount} pending ${pendingCount === 1 ? 'artifact' : 'artifacts'}`
  }
  return `${approvedCount} approved ${approvedCount === 1 ? 'artifact' : 'artifacts'}`
}

export function artifactTimestampMs(artifact: SprintEngineArtifact): number {
  const timestamp = artifact.updatedAt ?? artifact.createdAt
  if (!timestamp) return 0
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : 0
}

export const SOURCE_HANDOFF_ARTIFACT_ID = 'source-handoff'

export function getSprintEngineInboxArtifacts(artifacts: SprintEngineArtifact[]): SprintEngineArtifact[] {
  return [...artifacts].sort((a, b) => {
    const aIsHandoff = a.id === SOURCE_HANDOFF_ARTIFACT_ID
    const bIsHandoff = b.id === SOURCE_HANDOFF_ARTIFACT_ID
    if (aIsHandoff !== bIsHandoff) return aIsHandoff ? -1 : 1
    const timestampDelta = artifactTimestampMs(b) - artifactTimestampMs(a)
    if (timestampDelta !== 0) return timestampDelta
    return a.title.localeCompare(b.title)
  })
}

export type MobileArtifactDecision = {
  action: string
  actor: string
  timestamp: string | null
  note?: string
}

export function getMobileArtifactDecision(artifact: SprintEngineArtifact): MobileArtifactDecision | null {
  const mobileHistory = [...artifact.reviewHistory]
    .reverse()
    .find((entry) => isMobileActor(entry.actor))

  if (mobileHistory) {
    return {
      action: mobileHistory.action,
      actor: mobileHistory.actor,
      timestamp: mobileHistory.timestamp,
      note: mobileHistory.note,
    }
  }

  if (artifact.approvedBy && isMobileActor(artifact.approvedBy)) {
    return {
      action: 'approved',
      actor: artifact.approvedBy,
      timestamp: artifact.approvedAt ?? null,
    }
  }

  if (artifact.changesRequestedBy && isMobileActor(artifact.changesRequestedBy)) {
    return {
      action: 'changes_requested',
      actor: artifact.changesRequestedBy,
      timestamp: artifact.changesRequestedAt ?? null,
    }
  }

  return null
}

export function formatMobileArtifactDecision(decision: MobileArtifactDecision): string {
  const parts = [
    `Mobile ${mobileActionLabel(decision.action)} by ${formatMobileActor(decision.actor)}`,
    decision.timestamp ? formatTimestamp(decision.timestamp) : null,
    decision.note,
  ].filter(Boolean)

  return parts.join(' - ')
}

export function isMobileActor(actor: string): boolean {
  return actor.trim().toLowerCase().startsWith('mobile:')
}

export function formatMobileActor(actor: string): string {
  return actor.replace(/^mobile:/i, '').replace(/[_-]+/g, ' ') || 'mobile device'
}

export function mobileActionLabel(action: string): string {
  switch (action) {
    case 'approve':
    case 'approved':
      return 'approved'
    case 'request_changes':
    case 'requestChanges':
    case 'changes_requested':
      return 'requested changes'
    default:
      return action.replace(/[_-]+/g, ' ')
  }
}

export function formatArtifactBlockerSummary(
  blockers: ReturnType<typeof getSprintEngineArtifactDependencyBlockers>,
): string {
  const artifactCount = blockers.reduce((total, blocker) => total + blocker.artifacts.length, 0)
  const taskIds = blockers.map((blocker) => blocker.taskId).join(', ')
  return `${artifactCount} ${artifactCount === 1 ? 'artifact' : 'artifacts'} from ${taskIds}`
}

export function artifactStatusTone(status: SprintEngineArtifact['status']): string {
  switch (status) {
    case 'approved':
      return 'bg-[color:var(--tone-good-soft)] text-[color:var(--tone-good)]'
    case 'ready_for_review':
      return 'bg-[color:var(--accent-primary-soft)] text-[color:var(--accent-primary)]'
    case 'changes_requested':
      return 'bg-[color:var(--tone-warn-soft)] text-[color:var(--tone-warn)]'
    case 'superseded':
      return 'bg-[color:var(--bg-hover)] text-[color:var(--text-disabled)]'
    default:
      return 'bg-[color:var(--bg-hover)] text-[color:var(--text-muted)]'
  }
}

// Inbox status idiom: the shared shape-coded LifecycleGlyph (see
// knowledge/brand/glyph-system.md), so artifact review stage reads by shape and
// matches the board columns — not a colour-only dot. The tinted pill
// (artifactStatusTone above) is kept for other surfaces; the inbox row + detail
// resolve status to a LifecycleState here.
export function sprintEngineInboxRowLifecycle(artifact: SprintEngineArtifact): LifecycleState {
  if (artifact.id === SOURCE_HANDOFF_ARTIFACT_ID) return 'ready'
  switch (artifact.status) {
    case 'approved':
      return 'done'
    case 'ready_for_review':
      return 'review'
    case 'changes_requested':
      return 'changes_requested'
    case 'superseded':
      return 'archived'
    case 'draft':
      return 'in_progress'
  }
}

export function sprintEngineInboxRowSupporting(
  artifact: SprintEngineArtifact,
  task: SprintEngineTask | undefined,
): string {
  if (artifact.id === SOURCE_HANDOFF_ARTIFACT_ID) return 'Architect handover'
  const kind = sprintEngineArtifactKindLabel(artifact.kind)
  const parts = [kind]
  if (artifact.taskId) parts.push(artifact.taskId)
  if (task?.title) parts.push(task.title)
  return parts.join(' · ')
}

export function sprintEngineInboxEmptyMessage(runPhase: string): string {
  if (runPhase === 'Running') {
    return 'Run in flight. Artifacts will land here as workers finish tasks.'
  }
  if (runPhase === 'Complete') {
    return 'Run complete. No artifacts were produced.'
  }
  if (runPhase === 'Tasked') {
    return 'Tasks queued. Handover and artifacts will appear once workers start.'
  }
  return 'Inbox empty. The handover and any artifacts workers produce will appear here.'
}
