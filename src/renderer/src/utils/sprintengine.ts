import type {
  AgentId,
  SprintEngineArtifact,
  SprintEngineArtifactKind,
  SprintEngineArtifactReviewHistoryEntry,
  SprintEngineArtifactStatus,
  SprintEngineMockConfig,
  SprintEngineProjectionLockReport,
  SprintEngineProjectionLockWarning,
  SprintEngineProjectionLocks,
  SprintEngineProjectionCreation,
  SprintEngineProjectionSource,
  SprintEngineQualityGate,
  SprintEngineQualityGateAttempt,
  SprintEngineQualityGatePhase,
  SprintEngineQualityGateStatus,
  SprintEngineQualityGateSummary,
  SprintEngineQualityPolicy,
  SprintEngineQualityPolicyGate,
  SprintEngineRecordedArtifact,
  SprintEngineRole,
  SprintEngineRoleCounts,
  SprintEngineRunnerPolicy,
  SprintEngineRuntimeAgent,
  SprintEngineSkillMap,
  SprintEngineTaskActivityEntry,
  SprintEngineTaskActivityType,
  SprintEngineTaskCommentType,
  SprintEngineTaskDispatch,
  SprintEngineTaskDispatchMode,
  SprintEngineTaskDispatchStatus,
  SprintEngineTaskDispatchTriagedBy,
  SprintEngineTaskBoardColumn,
  SprintEngineTaskEvidence,
  SprintEngineTaskFeedback,
  SprintEngineTaskFeedbackFinding,
  SprintEngineTaskFeedbackFindingArea,
  SprintEngineTaskFeedbackFindingKind,
  SprintEngineTaskFeedbackFindingSeverity,
  SprintEngineTaskFeedbackFindingStatus,
  SprintEngineTaskFeedbackIssue,
  SprintEngineTaskFeedbackIssueCategory,
  SprintEngineTaskFeedbackIssueSeverity,
  SprintEngineTaskFeedbackIssueStatus,
  SprintEngineTaskSource,
  SprintEngineTaskSourceSyncStatus,
  SprintEngineTaskSourceType,
  SprintEngineTaskTriage,
  SprintEngineTaskComment,
  SprintEngineTaskNeedsInput,
  SprintEngineState,
  SprintEngineTask,
  SprintEngineTaskStatus,
  SprintEngineNeedsInputKind,
  SprintEngineNeedsInputReason,
} from '../types/workspace'

export type SprintEngineAgentRosterItem = {
  id: AgentId
  label: string
  role: SprintEngineRole
}

export const sprintEngineTaskStateLabel: Record<SprintEngineTaskStatus, string> = {
  todo: 'Todo',
  changes_requested: 'Changes Requested',
  in_progress: 'In Progress',
  review: 'Review',
  testing: 'Testing',
  product: 'Product',
  needs_input: 'Needs Input',
  done: 'Done',
}

export const sprintEngineQualityGatePhaseLabels: Record<SprintEngineQualityGatePhase, string> = {
  review: 'Review',
  testing: 'Testing',
  product: 'Product',
}

export const sprintEngineQualityGateStatusLabels: Record<SprintEngineQualityGateStatus, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  approved: 'Approved',
  changes_requested: 'Changes Requested',
  blocked: 'Blocked',
  skipped: 'Skipped',
}

export const sprintEngineTaskCommentTypeLabels: Record<SprintEngineTaskCommentType, string> = {
  implementation_summary: 'Implementation Summary',
  implementation_response: 'Implementation Response',
  review_feedback: 'Review Feedback',
  test_feedback: 'Test Feedback',
  product_feedback: 'Product Feedback',
  architect_feedback: 'Architect Feedback',
  needs_input: 'Needs Input',
  user_note: 'User Note',
  system_note: 'System Note',
}

export const sprintEngineRoleLabels: Record<SprintEngineRole, string> = {
  architect: 'Architect',
  product: 'Product Strategist',
  developer: 'Developer',
  frontend: 'Frontend Engineer',
  tester: 'Tester',
  security: 'Security Specialist',
  code_reviewer: 'Code Reviewer',
  spec_reviewer: 'Spec Reviewer',
  performance: 'Performance Engineer',
}

/**
 * Kanban column ordering and labels. Shared between the kanban view (orchestrator)
 * and the inspector's task-status icon so both surfaces use the same vocabulary.
 */
export const sprintEngineTaskBoardColumns: { key: SprintEngineTaskBoardColumn; label: string }[] = [
  { key: 'todo', label: 'Todo' },
  { key: 'ready', label: 'Ready' },
  { key: 'changes_requested', label: 'Changes Requested' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'review', label: 'Review' },
  { key: 'testing', label: 'Testing' },
  { key: 'product', label: 'Product' },
  { key: 'needs_input', label: 'Needs Input' },
  { key: 'done', label: 'Done' },
]

const sprintEngineLifecyclePhaseColumns: SprintEngineQualityGatePhase[] = ['review', 'testing', 'product']

type SprintEngineLifecyclePhaseState = Pick<SprintEngineState, 'tasks' | 'qualityPolicy'> & Partial<Pick<
  SprintEngineState,
  'rosterConfigured' | 'sprintEngineAgents'
>>

function isSprintEngineQualityGatePhase(value: unknown): value is SprintEngineQualityGatePhase {
  return value === 'review' || value === 'testing' || value === 'product'
}

function isSprintEngineQualityGateStatus(value: unknown): value is SprintEngineQualityGateStatus {
  return (
    value === 'pending'
    || value === 'in_progress'
    || value === 'approved'
    || value === 'changes_requested'
    || value === 'blocked'
    || value === 'skipped'
  )
}

function isSprintEngineTaskCommentType(value: unknown): value is SprintEngineTaskCommentType {
  return (
    value === 'implementation_summary'
    || value === 'implementation_response'
    || value === 'review_feedback'
    || value === 'test_feedback'
    || value === 'product_feedback'
    || value === 'architect_feedback'
    || value === 'needs_input'
    || value === 'user_note'
    || value === 'system_note'
  )
}

export const sprintEngineRoleAccent: Record<SprintEngineRole, string> = {
  architect: '#d4a757',
  product: '#e879a7',
  developer: '#c7ccd4',
  frontend: '#39d7ff',
  tester: '#3dff8f',
  security: '#ff6b6b',
  code_reviewer: '#f59e0b',
  spec_reviewer: '#22c55e',
  performance: '#a78bfa',
}

// Maps a SpecialistAction.soulRole string to the canonical SprintEngineRole
// so Watchtower (and any other panel showing specialists) can render the same
// icon disc + role accent + role label that Sprint Engine uses. Returns null
// for specialists with no Sprint Engine equivalent (devops, blog_writer);
// callers should fall back to the specialist's own icon and short label.
const SOUL_ROLE_TO_SPRINT_ENGINE_ROLE: Record<string, SprintEngineRole> = {
  architect: 'architect',
  product: 'product',
  developer: 'developer',
  frontend: 'frontend',
  tester: 'tester',
  security: 'security',
  code_reviewer: 'code_reviewer',
  spec_reviewer: 'spec_reviewer',
  performance: 'performance',
}

export function soulRoleToSprintEngineRole(soulRole: string): SprintEngineRole | null {
  return SOUL_ROLE_TO_SPRINT_ENGINE_ROLE[soulRole] ?? null
}

export const sprintEngineArtifactKindLabels: Record<SprintEngineArtifactKind, string> = {
  architect_plan: 'Architect Plan',
  product_strategy: 'Product Strategy',
  requirements: 'Requirements',
  html_mockup: 'HTML Mockup',
  design_notes: 'Design Notes',
  branding: 'Branding',
  security_review: 'Security Review',
  code_review: 'Code Review',
  spec_review: 'Spec Review',
  performance_review: 'Performance Review',
  validation_report: 'Validation Report',
}

export const sprintEngineArtifactStatusLabels: Record<SprintEngineArtifactStatus, string> = {
  draft: 'Draft',
  ready_for_review: 'Ready For Review',
  approved: 'Approved',
  changes_requested: 'Changes Requested',
  superseded: 'Superseded',
}

export const sprintEngineRoleOrder: SprintEngineRole[] = [
  'architect',
  'product',
  'frontend',
  'developer',
  'code_reviewer',
  'spec_reviewer',
  'performance',
  'tester',
  'security',
]

const sprintEngineArtifactKinds: readonly SprintEngineArtifactKind[] = [
  'architect_plan',
  'product_strategy',
  'requirements',
  'html_mockup',
  'design_notes',
  'branding',
  'security_review',
  'code_review',
  'spec_review',
  'performance_review',
  'validation_report',
]

const sprintEngineArtifactStatuses: readonly SprintEngineArtifactStatus[] = [
  'draft',
  'ready_for_review',
  'approved',
  'changes_requested',
  'superseded',
]

const feedbackIssueCategories: readonly SprintEngineTaskFeedbackIssueCategory[] = [
  'system_prompt',
  'role_prompt',
  'task_card',
  'acceptance_criteria',
  'context',
  'tooling',
  'coordination',
  'validation',
  'permissions',
  'ui',
  'other',
]

const feedbackIssueSeverities: readonly SprintEngineTaskFeedbackIssueSeverity[] = ['low', 'medium', 'high']
const feedbackIssueStatuses: readonly SprintEngineTaskFeedbackIssueStatus[] = ['new', 'reviewed', 'applied', 'rejected', 'deferred']
const feedbackFindingKinds: readonly SprintEngineTaskFeedbackFindingKind[] = [
  'code_bug',
  'security_issue',
  'product_requirement_violation',
  'test_gap',
  'accessibility_issue',
  'performance_issue',
  'reliability_issue',
  'documentation_gap',
  'other',
]
const feedbackFindingSeverities: readonly SprintEngineTaskFeedbackFindingSeverity[] = ['critical', 'high', 'medium', 'low']
const feedbackFindingAreas: readonly SprintEngineTaskFeedbackFindingArea[] = [
  'frontend',
  'backend',
  'database',
  'networking',
  'auth',
  'security',
  'filesystem',
  'cli',
  'ipc',
  'mobile',
  'testing',
  'performance',
  'docs',
  'product',
  'other',
]
const feedbackFindingStatuses: readonly SprintEngineTaskFeedbackFindingStatus[] = ['open', 'accepted', 'fixed', 'rejected', 'deferred']
const sprintEngineTaskSourceTypes: readonly SprintEngineTaskSourceType[] = ['local', 'github', 'jira', 'linear']
const sprintEngineTaskSourceSyncStatuses: readonly SprintEngineTaskSourceSyncStatus[] = ['clean', 'local_changed', 'remote_changed', 'conflict']
const sprintEngineTaskDispatchModes: readonly SprintEngineTaskDispatchMode[] = ['dependency', 'manual']
const sprintEngineTaskDispatchStatuses: readonly SprintEngineTaskDispatchStatus[] = ['todo', 'ready']
const sprintEngineTaskDispatchTriagedByValues: readonly SprintEngineTaskDispatchTriagedBy[] = ['none', 'user', 'architect']
const sprintEngineNeedsInputKinds: readonly SprintEngineNeedsInputKind[] = ['architect', 'user', 'owner']
const sprintEngineNeedsInputReasons: readonly SprintEngineNeedsInputReason[] = ['task_scope', 'artifact_review', 'tooling', 'verification', 'product_decision', 'blocked_other']

const sprintEngineTaskActivityTypes: readonly SprintEngineTaskActivityType[] = [
  'comment',
  'status_change',
  'claim',
  'evidence',
  'feedback',
  'needs_input',
  'artifact',
  'system',
]

const sprintEngineTaskBoardColumnSet: readonly SprintEngineTaskBoardColumn[] = [
  'todo',
  'ready',
  'changes_requested',
  'in_progress',
  'review',
  'testing',
  'product',
  'needs_input',
  'done',
]

export const sprintEngineTaskActivityLabels: Record<SprintEngineTaskActivityType, string> = {
  comment: 'Comment',
  status_change: 'Status',
  claim: 'Claim',
  evidence: 'Evidence',
  feedback: 'Feedback',
  needs_input: 'Needs Input',
  artifact: 'Artifact',
  system: 'System',
}

function isSprintEngineTaskActivityType(value: unknown): value is SprintEngineTaskActivityType {
  return sprintEngineTaskActivityTypes.includes(value as SprintEngineTaskActivityType)
}

function isSprintEngineTaskBoardColumn(value: unknown): value is SprintEngineTaskBoardColumn {
  return sprintEngineTaskBoardColumnSet.includes(value as SprintEngineTaskBoardColumn)
}

export function isSprintEngineTaskClaimableColumn(column: SprintEngineTaskBoardColumn | null | undefined): boolean {
  return column === 'ready' || column === 'changes_requested'
}

export function isSprintEngineTaskLaunchable(task: SprintEngineTask, sprintEngineState: SprintEngineState): boolean {
  return !task.ownerAgentId && isSprintEngineTaskClaimableColumn(getSprintEngineTaskBoardColumn(task, sprintEngineState.tasks))
}

const reviewGateArtifactKinds = new Set<SprintEngineArtifactKind>([
  'architect_plan',
  'product_strategy',
  'requirements',
  'html_mockup',
  'design_notes',
  'branding',
  'security_review',
  'code_review',
  'spec_review',
  'performance_review',
  'validation_report',
])

export type SprintEngineArtifactDependencyBlocker = {
  taskId: string
  title: string
  artifacts: SprintEngineArtifact[]
}

export type SprintEngineArtifactAutoApprovalEligibility = {
  eligible: boolean
  label: string
  reason: string | null
}

function emptyEvidence(summary = ''): SprintEngineTaskEvidence {
  return { summary, touchedFiles: [], commandsRan: [], results: [] }
}

function isSprintEngineRole(value: unknown): value is SprintEngineRole {
  return (
    value === 'architect'
    || value === 'product'
    || value === 'developer'
    || value === 'frontend'
    || value === 'tester'
    || value === 'security'
    || value === 'code_reviewer'
    || value === 'spec_reviewer'
    || value === 'performance'
  )
}

function isSprintEngineArtifactKind(value: unknown): value is SprintEngineArtifactKind {
  return sprintEngineArtifactKinds.includes(value as SprintEngineArtifactKind)
}

function isSprintEngineArtifactStatus(value: unknown): value is SprintEngineArtifactStatus {
  return sprintEngineArtifactStatuses.includes(value as SprintEngineArtifactStatus)
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function percentOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100
    ? value
    : undefined
}

function normalizeSprintEngineTaskActivity(input: unknown): SprintEngineTaskActivityEntry[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((entry, index): SprintEngineTaskActivityEntry[] => {
    if (!entry || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    const type = record.type
    const timestamp = stringOrNull(record.timestamp)?.trim()
    if (!isSprintEngineTaskActivityType(type) || !timestamp) return []
    const message = typeof record.message === 'string' ? record.message : ''
    const id = stringOrNull(record.id)?.trim() || `activity-${index + 1}`
    const actor = stringOrNull(record.actor)?.trim() || 'unknown'
    const status = optionalTrimmedString(record.status)
    const artifactId = optionalTrimmedString(record.artifactId)
    const artifactStatus = optionalTrimmedString(record.artifactStatus)
    return [{
      id,
      timestamp,
      type,
      actor,
      message,
      ...(status ? { status } : {}),
      ...(artifactId ? { artifactId } : {}),
      ...(artifactStatus ? { artifactStatus } : {}),
    }]
  })
}

function normalizeSprintEngineTaskComments(input: unknown): SprintEngineTaskComment[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((comment, index): SprintEngineTaskComment[] => {
    if (!comment || typeof comment !== 'object') return []
    const record = comment as Record<string, unknown>
    const body = stringOrNull(record.body)?.trim()
    if (!body) return []
    const source = record.source === 'agent' || record.source === 'system' ? record.source : 'user'
    const type = isSprintEngineTaskCommentType(record.type) ? record.type : undefined
    const authorAgentId = optionalTrimmedString(record.authorAgentId)
    const authorRole = isSprintEngineRole(record.authorRole) ? record.authorRole : undefined
    const paths = stringArray(record.paths)
    const data = record.data && typeof record.data === 'object'
      ? (record.data as Record<string, unknown>)
      : undefined
    return [{
      id: stringOrNull(record.id) ?? `comment-${index + 1}`,
      actor: stringOrNull(record.actor) ?? 'user',
      source,
      body,
      createdAt: stringOrNull(record.createdAt) ?? '',
      ...(type ? { type } : {}),
      ...(authorAgentId ? { authorAgentId } : {}),
      ...(authorRole ? { authorRole } : {}),
      ...(paths.length > 0 ? { paths } : {}),
      ...(data ? { data } : {}),
    }]
  })
}

function normalizeSprintEngineQualityGateAttempts(input: unknown): SprintEngineQualityGateAttempt[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((attempt, index): SprintEngineQualityGateAttempt[] => {
    if (!attempt || typeof attempt !== 'object') return []
    const record = attempt as Record<string, unknown>
    const id = optionalTrimmedString(record.id) ?? `attempt-${index + 1}`
    const status = isSprintEngineQualityGateStatus(record.status) ? record.status : undefined
    const actor = optionalTrimmedString(record.actor)
    const startedAt = optionalTrimmedString(record.startedAt)
    const completedAt = optionalTrimmedString(record.completedAt)
    const verdict = optionalTrimmedString(record.verdict)
    const note = optionalTrimmedString(record.note)
    return [{
      id,
      ...(status ? { status } : {}),
      ...(actor ? { actor } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(completedAt ? { completedAt } : {}),
      ...(verdict ? { verdict } : {}),
      ...(note ? { note } : {}),
    }]
  })
}

function normalizeSprintEngineQualityGates(input: unknown): SprintEngineQualityGate[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((gate, index): SprintEngineQualityGate[] => {
    if (!gate || typeof gate !== 'object') return []
    const record = gate as Record<string, unknown>
    const id = optionalTrimmedString(record.id) ?? `gate-${index + 1}`
    const phase = isSprintEngineQualityGatePhase(record.phase) ? record.phase : null
    const role = isSprintEngineRole(record.role) ? record.role : null
    if (!phase || !role) return []
    const status = isSprintEngineQualityGateStatus(record.status) ? record.status : 'pending'
    const required = record.required !== false
    const allowSelfReview = record.allowSelfReview === true
    const focus = optionalTrimmedString(record.focus)
    return [{
      id,
      phase,
      role,
      status,
      required,
      allowSelfReview,
      ...(focus ? { focus } : {}),
      attempts: normalizeSprintEngineQualityGateAttempts(record.attempts),
    }]
  })
}

function normalizeSprintEngineQualityGateSummary(input: unknown): SprintEngineQualityGateSummary | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  const numberOrZero = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0
  const stringNumberRecord = (value: unknown): Record<string, number> => {
    if (!value || typeof value !== 'object') return {}
    const entries = Object.entries(value as Record<string, unknown>).flatMap(([key, raw]) =>
      typeof raw === 'number' && Number.isFinite(raw) ? [[key, raw] as const] : []
    )
    return Object.fromEntries(entries)
  }
  return {
    total: numberOrZero(record.total),
    required: numberOrZero(record.required),
    openRequired: numberOrZero(record.openRequired),
    byPhase: stringNumberRecord(record.byPhase),
    byStatus: stringNumberRecord(record.byStatus),
  }
}

function normalizeSprintEngineRecordedArtifacts(input: unknown): SprintEngineRecordedArtifact[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((artifact, index): SprintEngineRecordedArtifact[] => {
    if (!artifact || typeof artifact !== 'object') return []
    const record = artifact as Record<string, unknown>
    const id = optionalTrimmedString(record.id) ?? `recorded-${index + 1}`
    return [{
      id,
      ...(optionalTrimmedString(record.kind) ? { kind: optionalTrimmedString(record.kind)! } : {}),
      ...(optionalTrimmedString(record.title) ? { title: optionalTrimmedString(record.title)! } : {}),
      ...(optionalTrimmedString(record.path) ? { path: optionalTrimmedString(record.path)! } : {}),
      ...(optionalTrimmedString(record.gateId) ? { gateId: optionalTrimmedString(record.gateId)! } : {}),
      ...(optionalTrimmedString(record.createdBy) ? { createdBy: optionalTrimmedString(record.createdBy)! } : {}),
      ...(optionalTrimmedString(record.createdAt) ? { createdAt: optionalTrimmedString(record.createdAt)! } : {}),
    }]
  })
}

function normalizeSprintEngineQualityPolicy(input: unknown): SprintEngineQualityPolicy | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  const lifecyclePhases = Array.isArray(record.lifecyclePhases)
    ? record.lifecyclePhases.filter(isSprintEngineQualityGatePhase)
    : []
  const gatesRecord = record.gates && typeof record.gates === 'object'
    ? record.gates as Record<string, unknown>
    : {}
  const gates: Record<string, SprintEngineQualityPolicyGate> = {}
  for (const [gateId, raw] of Object.entries(gatesRecord)) {
    if (!raw || typeof raw !== 'object') continue
    const rawGate = raw as Record<string, unknown>
    if (!isSprintEngineQualityGatePhase(rawGate.phase) || !isSprintEngineRole(rawGate.role)) continue
    const focus = optionalTrimmedString(rawGate.focus)
    gates[gateId] = {
      phase: rawGate.phase,
      role: rawGate.role,
      required: rawGate.required !== false,
      ...(focus ? { focus } : {}),
    }
  }
  return {
    enabled: record.enabled !== false,
    rosterDriven: record.rosterDriven !== false,
    lifecyclePhases,
    gates,
  }
}

function positiveNumberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : fallback
}

function normalizeSprintEngineRunnerPolicy(input: unknown): SprintEngineRunnerPolicy | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  const mode = record.mode === 'auto' || record.mode === 'off'
    ? record.mode
    : 'off'
  return {
    mode,
    pollIntervalSeconds: positiveNumberOrDefault(record.pollIntervalSeconds, 10),
    idleBackoffSeconds: positiveNumberOrDefault(record.idleBackoffSeconds, 30),
    maxBackoffSeconds: positiveNumberOrDefault(record.maxBackoffSeconds, 120),
    stopWhenComplete: record.stopWhenComplete !== false,
  }
}

function isFeedbackIssueCategory(value: unknown): value is SprintEngineTaskFeedbackIssueCategory {
  return feedbackIssueCategories.includes(value as SprintEngineTaskFeedbackIssueCategory)
}

function isFeedbackIssueSeverity(value: unknown): value is SprintEngineTaskFeedbackIssueSeverity {
  return feedbackIssueSeverities.includes(value as SprintEngineTaskFeedbackIssueSeverity)
}

function isFeedbackIssueStatus(value: unknown): value is SprintEngineTaskFeedbackIssueStatus {
  return feedbackIssueStatuses.includes(value as SprintEngineTaskFeedbackIssueStatus)
}

function isFeedbackFindingKind(value: unknown): value is SprintEngineTaskFeedbackFindingKind {
  return feedbackFindingKinds.includes(value as SprintEngineTaskFeedbackFindingKind)
}

function isFeedbackFindingSeverity(value: unknown): value is SprintEngineTaskFeedbackFindingSeverity {
  return feedbackFindingSeverities.includes(value as SprintEngineTaskFeedbackFindingSeverity)
}

function isFeedbackFindingArea(value: unknown): value is SprintEngineTaskFeedbackFindingArea {
  return feedbackFindingAreas.includes(value as SprintEngineTaskFeedbackFindingArea)
}

function isFeedbackFindingStatus(value: unknown): value is SprintEngineTaskFeedbackFindingStatus {
  return feedbackFindingStatuses.includes(value as SprintEngineTaskFeedbackFindingStatus)
}

function isSprintEngineTaskSourceType(value: unknown): value is SprintEngineTaskSourceType {
  return sprintEngineTaskSourceTypes.includes(value as SprintEngineTaskSourceType)
}

function isSprintEngineTaskSourceSyncStatus(value: unknown): value is SprintEngineTaskSourceSyncStatus {
  return sprintEngineTaskSourceSyncStatuses.includes(value as SprintEngineTaskSourceSyncStatus)
}

function isSprintEngineTaskDispatchMode(value: unknown): value is SprintEngineTaskDispatchMode {
  return sprintEngineTaskDispatchModes.includes(value as SprintEngineTaskDispatchMode)
}

function isSprintEngineTaskDispatchStatus(value: unknown): value is SprintEngineTaskDispatchStatus {
  return sprintEngineTaskDispatchStatuses.includes(value as SprintEngineTaskDispatchStatus)
}

function isSprintEngineTaskDispatchTriagedBy(value: unknown): value is SprintEngineTaskDispatchTriagedBy {
  return sprintEngineTaskDispatchTriagedByValues.includes(value as SprintEngineTaskDispatchTriagedBy)
}

function isSprintEngineNeedsInputKind(value: unknown): value is SprintEngineNeedsInputKind {
  return sprintEngineNeedsInputKinds.includes(value as SprintEngineNeedsInputKind)
}

function isSprintEngineNeedsInputReason(value: unknown): value is SprintEngineNeedsInputReason {
  return sprintEngineNeedsInputReasons.includes(value as SprintEngineNeedsInputReason)
}

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeSprintEngineTaskSource(value: unknown): SprintEngineTaskSource | undefined {
  if (!value || typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>
  if (!isSprintEngineTaskSourceType(record.type)) return undefined

  const externalId = optionalTrimmedString(record.externalId)
  const externalUrl = optionalTrimmedString(record.externalUrl)
  const repo = optionalTrimmedString(record.repo)
  const title = optionalTrimmedString(record.title)
  const body = typeof record.body === 'string' ? record.body : undefined
  const externalUpdatedAt = optionalTrimmedString(record.externalUpdatedAt)
  const syncedAt = optionalTrimmedString(record.syncedAt)
  const syncStatus = isSprintEngineTaskSourceSyncStatus(record.syncStatus) ? record.syncStatus : undefined

  return {
    type: record.type,
    ...(externalId ? { externalId } : {}),
    ...(externalUrl ? { externalUrl } : {}),
    ...(repo ? { repo } : {}),
    ...(title ? { title } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(externalUpdatedAt ? { externalUpdatedAt } : {}),
    ...(syncedAt ? { syncedAt } : {}),
    ...(syncStatus ? { syncStatus } : {}),
  }
}

function normalizeSprintEngineTaskDispatch(value: unknown): SprintEngineTaskDispatch | undefined {
  if (!value || typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>
  if (!isSprintEngineTaskDispatchMode(record.mode)) return undefined

  const status = isSprintEngineTaskDispatchStatus(record.status) ? record.status : undefined
  const triagedBy = isSprintEngineTaskDispatchTriagedBy(record.triagedBy) ? record.triagedBy : undefined
  const readyAt = optionalTrimmedString(record.readyAt)

  return {
    mode: record.mode,
    ...(status ? { status } : {}),
    ...(triagedBy ? { triagedBy } : {}),
    ...(readyAt ? { readyAt } : {}),
  }
}

function normalizeSprintEngineTaskNeedsInput(value: unknown): SprintEngineTaskNeedsInput | undefined {
  if (!value || typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>
  if (!isSprintEngineNeedsInputKind(record.kind)) return undefined
  const defaultReasonByKind: Record<SprintEngineNeedsInputKind, SprintEngineNeedsInputReason> = {
    architect: 'task_scope',
    user: 'product_decision',
    owner: 'blocked_other',
  }
  const reason = isSprintEngineNeedsInputReason(record.reason)
    ? record.reason
    : defaultReasonByKind[record.kind]
  const artifactId = optionalTrimmedString(record.artifactId)
  const suggestedResolution = optionalTrimmedString(record.suggestedResolution)
  const reportedBy = optionalTrimmedString(record.reportedBy)
  const reportedAt = optionalTrimmedString(record.reportedAt)
  const resolvedBy = optionalTrimmedString(record.resolvedBy)
  const resolvedAt = optionalTrimmedString(record.resolvedAt)
  const resolution = optionalTrimmedString(record.resolution)
  const resumeRequestedAt = optionalTrimmedString(record.resumeRequestedAt)

  return {
    kind: record.kind,
    reason,
    question: typeof record.question === 'string' ? record.question : '',
    ...(artifactId ? { artifactId } : {}),
    ...(suggestedResolution ? { suggestedResolution } : {}),
    ...(reportedBy ? { reportedBy } : {}),
    ...(reportedAt ? { reportedAt } : {}),
    ...(resolvedBy ? { resolvedBy } : {}),
    ...(resolvedAt ? { resolvedAt } : {}),
    ...(resolution ? { resolution } : {}),
    ...(resumeRequestedAt ? { resumeRequestedAt } : {}),
  }
}

function normalizeSprintEngineTaskFeedbackIssues(value: unknown): SprintEngineTaskFeedbackIssue[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((issue, index): SprintEngineTaskFeedbackIssue[] => {
    if (!issue || typeof issue !== 'object') return []
    const record = issue as Record<string, unknown>
    const category = record.category
    const severity = record.severity
    const title = optionalTrimmedString(record.title)
    const detail = optionalTrimmedString(record.detail)

    if (!isFeedbackIssueCategory(category) || !isFeedbackIssueSeverity(severity) || !title || !detail) {
      return []
    }

    const id = optionalTrimmedString(record.id) ?? `feedback-issue-${index + 1}`
    const status = isFeedbackIssueStatus(record.status) ? record.status : undefined
    const target = optionalTrimmedString(record.target)
    const evidence = optionalTrimmedString(record.evidence)
    const suggestedPromptChange = optionalTrimmedString(record.suggestedPromptChange)
    const suggestedProcessChange = optionalTrimmedString(record.suggestedProcessChange)

    return [{
      id,
      category,
      severity,
      title,
      detail,
      ...(status ? { status } : {}),
      ...(target ? { target } : {}),
      ...(evidence ? { evidence } : {}),
      ...(suggestedPromptChange ? { suggestedPromptChange } : {}),
      ...(suggestedProcessChange ? { suggestedProcessChange } : {}),
    }]
  })
}

function normalizeSprintEngineTaskFeedbackFindings(value: unknown): SprintEngineTaskFeedbackFinding[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((finding, index): SprintEngineTaskFeedbackFinding[] => {
    if (!finding || typeof finding !== 'object') return []
    const record = finding as Record<string, unknown>
    const kind = record.kind
    const severity = record.severity
    const area = record.area
    const title = optionalTrimmedString(record.title)
    const detail = optionalTrimmedString(record.detail)

    if (
      !isFeedbackFindingKind(kind)
      || !isFeedbackFindingSeverity(severity)
      || !isFeedbackFindingArea(area)
      || !title
      || !detail
    ) {
      return []
    }

    const id = optionalTrimmedString(record.id) ?? `feedback-finding-${index + 1}`
    const status = isFeedbackFindingStatus(record.status) ? record.status : undefined
    const recommendation = optionalTrimmedString(record.recommendation)
    const requirementId = optionalTrimmedString(record.requirementId)
    const file = optionalTrimmedString(record.file)

    return [{
      id,
      kind,
      severity,
      area,
      title,
      detail,
      ...(status ? { status } : {}),
      ...(recommendation ? { recommendation } : {}),
      ...(requirementId ? { requirementId } : {}),
      ...(file ? { file } : {}),
    }]
  })
}

function normalizeSprintEngineTaskFeedback(value: unknown): SprintEngineTaskFeedback | undefined {
  if (!value || typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>
  const scoresRecord = record.scores && typeof record.scores === 'object'
    ? record.scores as Record<string, unknown>
    : {}
  const scores = {
    directiveClarityPct: percentOrUndefined(scoresRecord.directiveClarityPct),
    taskClarityPct: percentOrUndefined(scoresRecord.taskClarityPct),
    acceptanceCriteriaClarityPct: percentOrUndefined(scoresRecord.acceptanceCriteriaClarityPct),
    sprintEngineToolEffectivenessPct: percentOrUndefined(scoresRecord.sprintEngineToolEffectivenessPct),
    promptOptimizationPct: percentOrUndefined(scoresRecord.promptOptimizationPct),
    contextFitPct: percentOrUndefined(scoresRecord.contextFitPct),
    hallucinationRiskPct: percentOrUndefined(scoresRecord.hallucinationRiskPct),
    roleFitPct: percentOrUndefined(scoresRecord.roleFitPct),
    autonomyPct: percentOrUndefined(scoresRecord.autonomyPct),
    confidencePct: percentOrUndefined(scoresRecord.confidencePct),
  }
  const hasScore = Object.values(scores).some((score) => score !== undefined)
  const topFriction = typeof record.topFriction === 'string' && record.topFriction.trim()
    ? record.topFriction
    : undefined
  const suggestedImprovement = typeof record.suggestedImprovement === 'string' && record.suggestedImprovement.trim()
    ? record.suggestedImprovement
    : undefined
  const issues = normalizeSprintEngineTaskFeedbackIssues(record.issues)
  const findings = normalizeSprintEngineTaskFeedbackFindings(record.findings)

  if (
    typeof record.schemaVersion !== 'number'
    || typeof record.capturedAt !== 'string'
    || typeof record.source !== 'string'
    || typeof record.agentId !== 'string'
    || !isSprintEngineRole(record.role)
    || (!hasScore && !topFriction && !suggestedImprovement && issues.length === 0 && findings.length === 0)
  ) {
    return undefined
  }

  return {
    schemaVersion: record.schemaVersion,
    capturedAt: record.capturedAt,
    source: record.source,
    agentId: record.agentId,
    role: record.role,
    scores,
    ...(topFriction ? { topFriction } : {}),
    ...(suggestedImprovement ? { suggestedImprovement } : {}),
    ...(issues.length > 0 ? { issues } : {}),
    ...(findings.length > 0 ? { findings } : {}),
  }
}

function normalizeSprintEngineTaskTriage(value: unknown): SprintEngineTaskTriage | undefined {
  if (!value || typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>
  const summary = optionalTrimmedString(record.summary)
  const riskRating = record.riskRating
  if (
    !summary
    || (riskRating !== 'low' && riskRating !== 'medium' && riskRating !== 'high')
    || typeof record.readyRecommendation !== 'boolean'
    || record.triagedBy !== 'architect'
    || typeof record.triagedAt !== 'string'
  ) {
    return undefined
  }

  const suggestedRole = isSprintEngineRole(record.suggestedRole) ? record.suggestedRole : undefined
  return {
    summary,
    ...(suggestedRole ? { suggestedRole } : {}),
    acceptanceCriteria: stringArray(record.acceptanceCriteria),
    likelyAffectedAreas: stringArray(record.likelyAffectedAreas),
    missingInformation: stringArray(record.missingInformation),
    riskRating,
    readyRecommendation: record.readyRecommendation,
    triagedBy: 'architect',
    triagedAt: record.triagedAt,
  }
}

function normalizeSprintEngineArtifactReviewHistory(value: unknown): SprintEngineArtifactReviewHistoryEntry[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    if (
      typeof record.action !== 'string'
      || typeof record.actor !== 'string'
      || typeof record.timestamp !== 'string'
    ) {
      return []
    }

    return [{
      action: record.action,
      actor: record.actor,
      timestamp: record.timestamp,
      ...(typeof record.note === 'string' ? { note: record.note } : {}),
    }]
  })
}

function normalizeSprintEngineArtifacts(value: unknown): SprintEngineArtifact[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((artifact, index) => {
    if (!artifact || typeof artifact !== 'object') return []
    const record = artifact as Record<string, unknown>
    if (
      typeof record.id !== 'string'
      || !isSprintEngineArtifactKind(record.kind)
      || !isSprintEngineArtifactStatus(record.status)
    ) {
      return []
    }

    const fallbackTitle = typeof record.path === 'string' && record.path.trim()
      ? record.path
      : `Artifact ${index + 1}`

    return [{
      id: record.id,
      kind: record.kind,
      title: typeof record.title === 'string' && record.title.trim() ? record.title : fallbackTitle,
      path: typeof record.path === 'string' ? record.path : '',
      status: record.status,
      createdBy: typeof record.createdBy === 'string' ? record.createdBy : '',
      taskId: typeof record.taskId === 'string' ? record.taskId : '',
      fingerprint: stringOrNull(record.fingerprint),
      reviewHistory: normalizeSprintEngineArtifactReviewHistory(record.reviewHistory),
      recommendedTasks: stringArray(record.recommendedTasks),
      createdAt: stringOrNull(record.createdAt),
      updatedAt: stringOrNull(record.updatedAt),
      ...(record.approvedBy === undefined ? {} : { approvedBy: stringOrNull(record.approvedBy) }),
      ...(record.approvedAt === undefined ? {} : { approvedAt: stringOrNull(record.approvedAt) }),
      ...(record.changesRequestedBy === undefined ? {} : { changesRequestedBy: stringOrNull(record.changesRequestedBy) }),
      ...(record.changesRequestedAt === undefined ? {} : { changesRequestedAt: stringOrNull(record.changesRequestedAt) }),
    }]
  })
}

export function createDefaultSprintEngineRoleCounts(): SprintEngineRoleCounts {
  return { architect: 1, product: 1, developer: 1, frontend: 0, tester: 0, security: 0, code_reviewer: 0, spec_reviewer: 0, performance: 0 }
}

export function createDefaultSprintEngineSkills(): SprintEngineSkillMap {
  return {
    architect: ['Deep repo analysis', 'Planning', 'Task decomposition', 'Dependency mapping'],
    product: ['Market research', 'Competitor analysis', 'Audience fit', 'Product positioning'],
    developer: ['Implementation', 'Refactoring', 'Integration work', 'Testing'],
    frontend: ['Interface design', 'Interaction design', 'Responsive layouts', 'UI implementation'],
    tester: ['Regression checks', 'Acceptance review', 'Validation'],
    security: ['Threat modeling', 'Security review', 'Hardening', 'Abuse-case analysis'],
    code_reviewer: ['Code review', 'Regression risk', 'Maintainability', 'Evidence quality'],
    spec_reviewer: ['Spec conformance', 'Acceptance coverage', 'Behavioral gaps', 'Test evidence'],
    performance: ['Latency review', 'Memory and CPU analysis', 'Bundle/runtime cost', 'Measurement quality'],
  }
}

export function countSprintEngineAgents(roleCounts: SprintEngineRoleCounts): number {
  return Object.values(roleCounts).reduce((total, count) => total + Math.max(0, count), 0)
}

export function normalizeSprintEngineRoleCounts(
  roleCounts?: Partial<SprintEngineRoleCounts> | null
): SprintEngineRoleCounts {
  return {
    architect: Math.max(0, roleCounts?.architect ?? 1),
    product: Math.max(0, roleCounts?.product ?? 1),
    developer: Math.max(0, roleCounts?.developer ?? 1),
    frontend: Math.max(0, roleCounts?.frontend ?? 0),
    tester: Math.max(0, roleCounts?.tester ?? 0),
    security: Math.max(0, roleCounts?.security ?? 0),
    code_reviewer: Math.max(0, roleCounts?.code_reviewer ?? 0),
    spec_reviewer: Math.max(0, roleCounts?.spec_reviewer ?? 0),
    performance: Math.max(0, roleCounts?.performance ?? 0),
  }
}

function roleAgentIndex(agentId: string, role: SprintEngineRole): number {
  const base = role
  if (agentId === base) return 1
  const match = agentId.match(new RegExp(`^${base}-(\\d+)$`))
  if (!match) return Number.MAX_SAFE_INTEGER
  return Number(match[1])
}

export function getNextSprintEngineAgentId(
  role: SprintEngineRole,
  sprintEngineAgents: Record<AgentId, SprintEngineRuntimeAgent>
): AgentId {
  const usedIds = new Set(Object.keys(sprintEngineAgents))
  if (!usedIds.has(role) && role !== 'developer') return role

  let nextIndex = 1
  for (const [agentId, agent] of Object.entries(sprintEngineAgents)) {
    if (agent.role !== role) continue
    const index = roleAgentIndex(agentId, role)
    if (Number.isFinite(index)) nextIndex = Math.max(nextIndex, index + 1)
  }

  let candidate = `${role}-${nextIndex}`
  while (usedIds.has(candidate)) {
    nextIndex += 1
    candidate = `${role}-${nextIndex}`
  }
  return candidate
}

export function buildSprintEngineAgentRoster(roleCounts: SprintEngineRoleCounts): SprintEngineAgentRosterItem[] {
  const roster: SprintEngineAgentRosterItem[] = []

  for (const role of sprintEngineRoleOrder) {
    const count = Math.max(role === 'architect' ? 1 : 0, roleCounts[role])
    for (let i = 0; i < count; i++) {
      const id = count > 1 || role === 'developer' ? `${role}-${i + 1}` : role
      const suffix = count > 1 ? ` ${i + 1}` : ''
      roster.push({ id, label: `${sprintEngineRoleLabels[role]}${suffix}`, role })
    }
  }

  return roster
}

export function buildSprintEngineAgentRosterFromRuntimeAgents(
  sprintEngineAgents: Record<AgentId, SprintEngineRuntimeAgent>
): SprintEngineAgentRosterItem[] {
  const roleTotals: Record<SprintEngineRole, number> = { architect: 0, product: 0, developer: 0, frontend: 0, tester: 0, security: 0, code_reviewer: 0, spec_reviewer: 0, performance: 0 }
  for (const agent of Object.values(sprintEngineAgents)) {
    if (isSprintEngineRole(agent?.role)) roleTotals[agent.role] += 1
  }

  const seenByRole: Record<SprintEngineRole, number> = { architect: 0, product: 0, developer: 0, frontend: 0, tester: 0, security: 0, code_reviewer: 0, spec_reviewer: 0, performance: 0 }

  return Object.entries(sprintEngineAgents)
    .filter((entry): entry is [AgentId, SprintEngineRuntimeAgent] => isSprintEngineRole(entry[1]?.role))
    .sort(([aId, a], [bId, b]) => {
      const roleDelta = sprintEngineRoleOrder.indexOf(a.role) - sprintEngineRoleOrder.indexOf(b.role)
      return roleDelta !== 0 ? roleDelta : roleAgentIndex(aId, a.role) - roleAgentIndex(bId, b.role)
    })
    .map(([id, agent]) => {
      seenByRole[agent.role] += 1
      const suffix = roleTotals[agent.role] > 1 ? ` ${seenByRole[agent.role]}` : ''
      return { id, label: `${sprintEngineRoleLabels[agent.role]}${suffix}`, role: agent.role }
    })
}

export function buildSprintEngineAgentRosterForState(
  sprintEngineState: Pick<SprintEngineState, 'roleCounts' | 'sprintEngineAgents'> | null | undefined
): SprintEngineAgentRosterItem[] {
  if (sprintEngineState?.sprintEngineAgents && Object.keys(sprintEngineState.sprintEngineAgents).length > 0) {
    return buildSprintEngineAgentRosterFromRuntimeAgents(sprintEngineState.sprintEngineAgents)
  }
  return buildSprintEngineAgentRoster(sprintEngineState?.roleCounts ?? createDefaultSprintEngineRoleCounts())
}

// Worker roles that surface their own role-task launch button on the Sprint
// Engine panel. When one of these has an active or ready task, the role-task
// launch supersedes a generic focus-agent action for the same role.
const SPRINT_ENGINE_FOCUS_WORKER_ROLES: SprintEngineRole[] = [
  'developer',
  'frontend',
  'product',
  'code_reviewer',
  'spec_reviewer',
  'performance',
  'tester',
  'security',
]

export type SprintEngineRuntimeAgentEffectiveStatus =
  | SprintEngineRuntimeAgent['status']
  | 'idle'
  | 'exited'

export type SprintEngineFocusAgent = {
  agentId: AgentId
  role: SprintEngineRole
  status: SprintEngineRuntimeAgentEffectiveStatus
  currentTaskId: string | null
}

export type SprintEngineFocusAgentAvailability = {
  /** The first needs_input or running agent after the local-exit override. */
  focusAgent: SprintEngineFocusAgent | null
  /** True only when the panel would surface the generic focus-agent action.
   *  Mirrors SprintEngineBoardPanel: hidden when the focus agent's role has a
   *  dedicated role-task launch (which supersedes the generic action). */
  showFocusAgentAction: boolean
}

/** Subset of the renderer's AgentState used to compute the localExited override
 *  without coupling this utility to the full AgentState type. */
export type SprintEngineLocalAgentLike = {
  kind?: string
  cliLastExitedAt?: number | null
  cliStartRequested?: boolean
  cliHasLaunched?: boolean
}

/**
 * Compute the effective focus-agent availability used by both the Sprint
 * Engine panel and the command palette. Applies the same three filters the
 * panel applies:
 *   1. Roster-derived runtime agents only (orphan sprintEngineAgents entries
 *      that are not on the roster are ignored).
 *   2. localExited override: if the renderer agent state shows the CLI has
 *      exited and no fresh start has been requested, treat the agent as
 *      exited regardless of the projected run-store agent state.
 *   3. showFocusAgentAction: hidden when the focus agent's role already has a
 *      dedicated role-task launch surfaced by the panel.
 */
export function computeSprintEngineFocusAgentAvailability(
  sprintEngineState: SprintEngineState | null | undefined,
  agents: Record<string, SprintEngineLocalAgentLike | undefined>
): SprintEngineFocusAgentAvailability {
  if (!sprintEngineState) return { focusAgent: null, showFocusAgentAction: false }

  const roster = buildSprintEngineAgentRosterForState(sprintEngineState)
  const rosterById = new Map(roster.map((agent) => [agent.id, agent]))

  const runtimeAgents: SprintEngineFocusAgent[] = roster.map((agent) => {
    const runtime = sprintEngineState.sprintEngineAgents[agent.id]
    const local = agents[agent.id]
    const localExited = Boolean(
      local?.kind === 'sprintengine'
      && local.cliLastExitedAt
      && !local.cliStartRequested
      && !local.cliHasLaunched
    )
    const status: SprintEngineRuntimeAgentEffectiveStatus = localExited
      ? 'exited'
      : (runtime?.status ?? 'idle')
    return {
      agentId: agent.id,
      role: runtime?.role ?? agent.role,
      status,
      currentTaskId: runtime?.currentTaskId ?? null,
    }
  })

  const needsInput = runtimeAgents.find((agent) => agent.status === 'needs_input')
  const running = runtimeAgents.find((agent) => agent.status === 'running')
  const focusAgent = needsInput ?? running ?? null

  if (!focusAgent) return { focusAgent: null, showFocusAgentAction: false }

  const readyTasks = sprintEngineState.tasks.filter((task) =>
    isSprintEngineTaskLaunchable(task, sprintEngineState)
  )
  const roleTaskLaunchSet = new Set<SprintEngineRole>()
  for (const role of SPRINT_ENGINE_FOCUS_WORKER_ROLES) {
    const activeTask = sprintEngineState.tasks.find(
      (task) =>
        task.role === role
        && (task.status === 'in_progress' || task.status === 'needs_input')
    )
    const readyTask = readyTasks.find((task) => task.role === role && !task.ownerAgentId)
    if (activeTask ?? readyTask) roleTaskLaunchSet.add(role)
  }

  const focusAgentRosterRole = rosterById.get(focusAgent.agentId)?.role
  const focusAgentRole = focusAgentRosterRole ?? focusAgent.role
  const showFocusAgentAction =
    !focusAgentRole
    || focusAgentRole === 'architect'
    || !roleTaskLaunchSet.has(focusAgentRole)

  return { focusAgent, showFocusAgentAction }
}

export function buildSprintEngineRosterCommandArgs(
  sprintEngineState: Pick<SprintEngineState, 'roleCounts' | 'sprintEngineAgents' | 'rosterConfigured'> | SprintEngineRoleCounts | null | undefined
): string[] {
  if (sprintEngineState && 'roleCounts' in sprintEngineState && !sprintEngineState.rosterConfigured) return []
  const roster = sprintEngineState && 'roleCounts' in sprintEngineState
    ? buildSprintEngineAgentRosterForState(sprintEngineState)
    : buildSprintEngineAgentRoster(normalizeSprintEngineRoleCounts(sprintEngineState as Partial<SprintEngineRoleCounts> | null | undefined))
  return roster.map((agent) => `${agent.role}:${agent.id}`)
}

export function createInitialSprintEngineState(config: SprintEngineMockConfig): SprintEngineState {
  const roleCounts = normalizeSprintEngineRoleCounts(config.roleCounts)
  const roster = buildSprintEngineAgentRoster(roleCounts)
  return {
    name: config.name?.trim() || 'Sprint Engine Team',
    goal: config.goal,
    rosterConfigured: true,
    roleCounts,
    sprintEngineAgents: Object.fromEntries(
      roster.map((agent) => [
        agent.id,
        { role: agent.role, status: 'idle' as const, currentTaskId: null },
      ])
    ),
    events: [],
    tasks: [],
    artifacts: [],
  }
}

export function getSprintEngineTaskBoardColumn(
  task: SprintEngineTask,
  tasks: SprintEngineTask[]
): SprintEngineTaskBoardColumn {
  // Folder-store projection: when the task carries an authoritative board column
  // (or it lives in an in_progress/needs_input/done folder), trust that value.
  if (task.boardColumn && isSprintEngineTaskBoardColumn(task.boardColumn)) {
    return task.boardColumn
  }
  if (
    task.status === 'changes_requested'
    || task.status === 'in_progress'
    || task.status === 'review'
    || task.status === 'testing'
    || task.status === 'product'
    || task.status === 'needs_input'
    || task.status === 'done'
  ) {
    return task.status
  }
  const dependenciesDone = task.dependsOn.every((depId) =>
    tasks.some((t) => t.id === depId && t.status === 'done')
  )
  if (!dependenciesDone) return 'todo'
  if (task.dispatch?.mode === 'manual' && task.dispatch.status !== 'ready') return 'todo'
  return 'ready'
}

export function getSprintEngineTaskSourceType(task: Pick<SprintEngineTask, 'source'>): SprintEngineTaskSourceType {
  return task.source?.type ?? 'local'
}

export function getReviewableSprintEngineArtifacts(artifacts: SprintEngineArtifact[]): SprintEngineArtifact[] {
  return artifacts.filter((artifact) =>
    reviewGateArtifactKinds.has(artifact.kind) && artifact.status !== 'superseded'
  )
}

export function isSprintEngineArtifactAutoApprovableKind(kind: SprintEngineArtifactKind): boolean {
  return reviewGateArtifactKinds.has(kind)
}

export function getSprintEngineArtifactAutoApprovalEligibility(
  artifact: SprintEngineArtifact
): SprintEngineArtifactAutoApprovalEligibility {
  if (artifact.status !== 'ready_for_review') {
    return {
      eligible: false,
      label: '',
      reason: 'Only artifacts ready for review can be auto-approved.',
    }
  }

  if (!artifact.path.trim()) {
    return {
      eligible: false,
      label: 'Cannot auto-approve: file unavailable',
      reason: 'Artifact file path is missing.',
    }
  }

  if (isSprintEngineArtifactAutoApprovableKind(artifact.kind)) {
    return {
      eligible: true,
      label: 'Auto-approval ready',
      reason: null,
    }
  }

  return {
    eligible: false,
    label: '',
    reason: 'Unknown artifact type.',
  }
}

export function getAutoApprovableReadySprintEngineArtifacts(
  sprintEngineState: Pick<SprintEngineState, 'tasks' | 'artifacts'>
): SprintEngineArtifact[] {
  const reviewArtifacts = getReviewableSprintEngineArtifacts(sprintEngineState.artifacts)
  const reviewArtifactsByTaskId = getSprintEngineArtifactsByTaskId(reviewArtifacts)
  const tasksById = new Map(sprintEngineState.tasks.map((task) => [task.id, task]))

  return reviewArtifacts.filter((artifact) => {
    if (!getSprintEngineArtifactAutoApprovalEligibility(artifact).eligible) return false

    const task = tasksById.get(artifact.taskId)
    if (!task || task.status !== 'needs_input') return false

    const blockingArtifacts = (reviewArtifactsByTaskId[task.id] ?? []).filter((candidate) =>
      candidate.status !== 'approved' && candidate.status !== 'superseded'
    )
    if (blockingArtifacts.length === 0) return false

    return blockingArtifacts.every((candidate) =>
      getSprintEngineArtifactAutoApprovalEligibility(candidate).eligible
    )
  })
}

export function getSprintEngineArtifactsByTaskId(
  artifacts: SprintEngineArtifact[]
): Record<string, SprintEngineArtifact[]> {
  return artifacts.reduce<Record<string, SprintEngineArtifact[]>>((byTaskId, artifact) => {
    if (!artifact.taskId) return byTaskId
    byTaskId[artifact.taskId] = [...(byTaskId[artifact.taskId] ?? []), artifact]
    return byTaskId
  }, {})
}

export function getSprintEngineArtifactDependencyBlockers(
  task: SprintEngineTask,
  tasks: SprintEngineTask[],
  artifacts: SprintEngineArtifact[]
): SprintEngineArtifactDependencyBlocker[] {
  const artifactsByTaskId = getSprintEngineArtifactsByTaskId(getReviewableSprintEngineArtifacts(artifacts))
  const tasksById = new Map(tasks.map((candidate) => [candidate.id, candidate]))

  return task.dependsOn.flatMap((dependencyId) => {
    const dependency = tasksById.get(dependencyId)
    if (!dependency || dependency.status === 'done') return []

    const waitingArtifacts = (artifactsByTaskId[dependencyId] ?? []).filter((artifact) =>
      artifact.status !== 'approved'
    )
    if (waitingArtifacts.length === 0) return []

    return [{
      taskId: dependency.id,
      title: dependency.title,
      artifacts: waitingArtifacts,
    }]
  })
}

export function normalizeSprintEngineState(input: SprintEngineState | null | undefined): SprintEngineState | null {
  if (!input) return null

  const tasks = (Array.isArray(input.tasks) ? input.tasks : []).map((task, index) => {
    const feedback = normalizeSprintEngineTaskFeedback(task.feedback)
    const triage = normalizeSprintEngineTaskTriage(task.triage)
    const source = normalizeSprintEngineTaskSource(task.source)
    const dispatch = normalizeSprintEngineTaskDispatch(task.dispatch)
    const needsInput = normalizeSprintEngineTaskNeedsInput(task.needsInput)
    const activity = normalizeSprintEngineTaskActivity(task.activity)
    const taskStatusValues = ['todo', 'changes_requested', 'in_progress', 'review', 'testing', 'product', 'needs_input', 'done'] as const
    const semanticStatus = taskStatusValues.includes(task.stateStatus as SprintEngineTaskStatus)
      ? task.stateStatus as SprintEngineTaskStatus
      : null
    const status: SprintEngineTaskStatus = semanticStatus
      ?? (taskStatusValues.includes(task.status as SprintEngineTaskStatus)
        ? task.status as SprintEngineTaskStatus
        : 'todo' as const)
    const boardColumn = isSprintEngineTaskBoardColumn(task.boardColumn) ? task.boardColumn : undefined
    const folderStatus = optionalTrimmedString(task.folderStatus)
    const taskRecord = task as unknown as Record<string, unknown>
    const qualityGates = normalizeSprintEngineQualityGates(taskRecord.qualityGates)
    const qualityGateSummary = normalizeSprintEngineQualityGateSummary(taskRecord.qualityGateSummary)
    const latestComments = normalizeSprintEngineTaskComments(taskRecord.latestComments)
    const latestOpenFeedback = normalizeSprintEngineTaskComments(taskRecord.latestOpenFeedback)
    const recordedArtifacts = normalizeSprintEngineRecordedArtifacts(taskRecord.recordedArtifacts)
    return {
      id: task.id ?? `task-${index + 1}`,
      title: task.title ?? `Task ${index + 1}`,
      description: task.description ?? '',
      role: isSprintEngineRole(task.role) ? task.role : 'developer' as SprintEngineRole,
      status,
      ...(semanticStatus ? { stateStatus: semanticStatus } : {}),
      ...(boardColumn ? { boardColumn } : {}),
      ...(folderStatus ? { folderStatus } : {}),
      ...(source ? { source } : {}),
      ...(dispatch ? { dispatch } : {}),
      ownerAgentId: task.ownerAgentId ?? null,
      dependsOn: task.dependsOn ?? [],
      ownedPaths: task.ownedPaths ?? [],
      acceptanceCriteria: task.acceptanceCriteria ?? [],
      implementationNotes: task.implementationNotes ?? [],
      evidence: task.evidence ?? emptyEvidence(),
      ...(feedback ? { feedback } : {}),
      ...(triage ? { triage } : {}),
      ...(needsInput ? { needsInput } : {}),
      notes: Array.isArray(task.notes) ? task.notes : [],
      comments: normalizeSprintEngineTaskComments(task.comments),
      startedAt: task.startedAt ?? null,
      completedAt: task.completedAt ?? null,
      ...(activity.length > 0 ? { activity } : {}),
      ...(qualityGates.length > 0 ? { qualityGates } : {}),
      ...(qualityGateSummary ? { qualityGateSummary } : {}),
      ...(latestComments.length > 0 ? { latestComments } : {}),
      ...(latestOpenFeedback.length > 0 ? { latestOpenFeedback } : {}),
      ...(recordedArtifacts.length > 0 ? { recordedArtifacts } : {}),
    }
  })

  const roleCounts = normalizeSprintEngineRoleCounts(input.roleCounts)

  return {
    name: input.name?.trim() || 'Sprint Engine Team',
    goal: input.goal ?? '',
    rosterConfigured: Boolean(input.rosterConfigured),
    ...(input.source ? { source: input.source } : {}),
    ...(input.sourceBundle ? { sourceBundle: input.sourceBundle } : {}),
    updatedAt: input.updatedAt ?? null,
    roleCounts,
    sprintEngineAgents: input.sprintEngineAgents && Object.keys(input.sprintEngineAgents).length > 0
      ? input.sprintEngineAgents
      : Object.fromEntries(buildSprintEngineAgentRoster(roleCounts).map((a) => [a.id, { role: a.role, status: 'idle' as const, currentTaskId: null }])),
    events: input.events ?? [],
    tasks,
    artifacts: normalizeSprintEngineArtifacts(input.artifacts),
    ...(input.projection ? { projection: input.projection } : {}),
    ...(input.locks ? { locks: input.locks } : {}),
    ...(input.creation ? { creation: input.creation } : {}),
    ...(input.qualityPolicy ? { qualityPolicy: input.qualityPolicy } : {}),
    ...(input.runner ? { runner: input.runner } : {}),
  }
}

function normalizeProjectionLockReports(value: unknown): SprintEngineProjectionLockReport[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): SprintEngineProjectionLockReport[] => {
    if (!entry || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    const name = optionalTrimmedString(record.name)
    if (!name) return []
    const age = typeof record.ageSeconds === 'number' ? record.ageSeconds : null
    const ownerRecord = record.owner && typeof record.owner === 'object' ? record.owner as Record<string, unknown> : null
    const owner = ownerRecord
      ? {
          ...(typeof ownerRecord.pid === 'number' ? { pid: ownerRecord.pid } : {}),
          ...(typeof ownerRecord.createdAt === 'string' ? { createdAt: ownerRecord.createdAt } : {}),
        }
      : null
    return [{
      name,
      exists: Boolean(record.exists),
      stale: Boolean(record.stale),
      ageSeconds: age,
      owner,
    }]
  })
}

function normalizeProjectionLockWarnings(value: unknown): SprintEngineProjectionLockWarning[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): SprintEngineProjectionLockWarning[] => {
    if (!entry || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    const name = optionalTrimmedString(record.name)
    const message = optionalTrimmedString(record.message)
    if (!name || !message) return []
    const age = typeof record.ageSeconds === 'number' ? record.ageSeconds : null
    return [{ name, message, ageSeconds: age }]
  })
}

function normalizeProjectionLocks(value: unknown): SprintEngineProjectionLocks | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const locks = normalizeProjectionLockReports(record.locks)
  const warnings = normalizeProjectionLockWarnings(record.warnings)
  if (locks.length === 0 && warnings.length === 0) return undefined
  return { locks, warnings }
}

function normalizeProjectionCreation(value: unknown): SprintEngineProjectionCreation | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const source = optionalTrimmedString(record.source)
  const createdAt = optionalTrimmedString(record.createdAt)
  const updatedAt = optionalTrimmedString(record.updatedAt)
  if (!source && !createdAt && !updatedAt) return undefined
  return {
    ...(source ? { source } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  }
}

function projectionSourceValue(value: unknown): SprintEngineProjectionSource {
  return value === 'folder_store' || value === 'unavailable'
    ? value
    : 'folder_store'
}

function normalizeProjectionRoster(value: unknown): Record<string, SprintEngineRuntimeAgent> {
  if (!value || typeof value !== 'object') return {}
  const result: Record<string, SprintEngineRuntimeAgent> = {}
  for (const [agentId, agent] of Object.entries(value as Record<string, unknown>)) {
    if (!agent || typeof agent !== 'object') continue
    const record = agent as Record<string, unknown>
    if (!isSprintEngineRole(record.role)) continue
    const status = record.status === 'running' || record.status === 'needs_input' || record.status === 'done'
      ? record.status
      : 'idle' as const
    result[agentId] = {
      role: record.role,
      status,
      currentTaskId: typeof record.currentTaskId === 'string' ? record.currentTaskId : null,
    }
  }
  return result
}

/**
 * Convert a folder-store `projection.json` payload into the SprintEngineState
 * shape the renderer panels consume. The projection is the single source of
 * truth for board columns, activity, lock warnings, and run metadata.
 */
export function normalizeSprintEngineProjection(
  input: unknown,
  fallbackName?: string,
): SprintEngineState | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const runRecord = record.run && typeof record.run === 'object' ? record.run as Record<string, unknown> : {}

  const roster = normalizeProjectionRoster(record.roster)
  const rawTasks = Array.isArray(record.tasks) ? record.tasks : []
  const rawArtifacts = Array.isArray(record.artifacts) ? record.artifacts : []
  const rawActivity = Array.isArray(record.activity) ? record.activity : []

  const events = rawActivity.flatMap((event): SprintEngineState['events'] => {
    if (!event || typeof event !== 'object') return []
    const e = event as Record<string, unknown>
    if (typeof e.id !== 'string' || typeof e.timestamp !== 'string' || typeof e.type !== 'string' || typeof e.actor !== 'string') {
      return []
    }
    return [{
      id: e.id,
      timestamp: e.timestamp,
      type: e.type,
      actor: e.actor,
      message: typeof e.message === 'string' ? e.message : '',
      ...(typeof e.targetAgentId === 'string' ? { targetAgentId: e.targetAgentId } : {}),
      ...(typeof e.taskId === 'string' ? { taskId: e.taskId } : {}),
      ...(typeof e.artifactId === 'string' ? { artifactId: e.artifactId } : {}),
      ...(typeof e.notificationKind === 'string' ? { notificationKind: e.notificationKind } : {}),
    }]
  })

  const fallbackRoleCounts = createDefaultSprintEngineRoleCounts()
  for (const role of Object.keys(fallbackRoleCounts) as SprintEngineRole[]) fallbackRoleCounts[role] = 0
  for (const agent of Object.values(roster)) {
    if (isSprintEngineRole(agent.role)) fallbackRoleCounts[agent.role] += 1
  }
  const hasRosterCounts = Object.values(fallbackRoleCounts).some((count) => count > 0)
  const roleCounts = hasRosterCounts ? fallbackRoleCounts : createDefaultSprintEngineRoleCounts()

  const candidate: SprintEngineState = {
    name: optionalTrimmedString(runRecord.name) ?? fallbackName ?? 'Sprint Engine Team',
    goal: typeof runRecord.goal === 'string' ? runRecord.goal : '',
    rosterConfigured: Boolean(runRecord.rosterConfigured),
    updatedAt: optionalTrimmedString(runRecord.updatedAt) ?? optionalTrimmedString(record.updatedAt) ?? null,
    roleCounts,
    sprintEngineAgents: Object.keys(roster).length > 0
      ? roster
      : Object.fromEntries(buildSprintEngineAgentRoster(roleCounts).map((a) => [a.id, { role: a.role, status: 'idle' as const, currentTaskId: null }])),
    events,
    tasks: rawTasks as SprintEngineState['tasks'],
    artifacts: rawArtifacts as SprintEngineState['artifacts'],
    projection: {
      source: projectionSourceValue(record.source),
      updatedAt: optionalTrimmedString(record.updatedAt) ?? null,
      generatedAt: optionalTrimmedString(record.generatedAt) ?? null,
    },
    ...(normalizeProjectionLocks(record.locks) ? { locks: normalizeProjectionLocks(record.locks) } : {}),
    ...(normalizeProjectionCreation(runRecord.creation) ? { creation: normalizeProjectionCreation(runRecord.creation) } : {}),
    ...(normalizeSprintEngineQualityPolicy(runRecord.qualityPolicy)
      ? { qualityPolicy: normalizeSprintEngineQualityPolicy(runRecord.qualityPolicy) }
      : {}),
    ...(normalizeSprintEngineRunnerPolicy(runRecord.runner)
      ? { runner: normalizeSprintEngineRunnerPolicy(runRecord.runner) }
      : {}),
  }

  return normalizeSprintEngineState(candidate)
}

/**
 * Newest-first activity for inspector display. The projection stores activity
 * oldest-first; the inspector prioritizes the most recent handoff signal.
 */
export function getSprintEngineTaskActivityDescending(
  task: Pick<SprintEngineTask, 'activity'>,
): SprintEngineTaskActivityEntry[] {
  const activity = task.activity ?? []
  return [...activity].sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''))
}

/**
 * Open feedback items the inspector should surface above secondary metadata —
 * issues and findings whose status is still active (not applied/rejected/fixed).
 */
export function getOpenSprintEngineFeedbackIssues(
  feedback: SprintEngineTaskFeedback | undefined,
): SprintEngineTaskFeedbackIssue[] {
  if (!feedback?.issues) return []
  return feedback.issues.filter((issue) => {
    const status = issue.status ?? 'new'
    return status !== 'applied' && status !== 'rejected'
  })
}

export function getOpenSprintEngineFeedbackFindings(
  feedback: SprintEngineTaskFeedback | undefined,
): SprintEngineTaskFeedbackFinding[] {
  if (!feedback?.findings) return []
  return feedback.findings.filter((finding) => {
    const status = finding.status ?? 'open'
    return status !== 'fixed' && status !== 'rejected'
  })
}

export function hasOpenSprintEngineFeedback(
  feedback: SprintEngineTaskFeedback | undefined,
): boolean {
  if (!feedback) return false
  return getOpenSprintEngineFeedbackIssues(feedback).length > 0
    || getOpenSprintEngineFeedbackFindings(feedback).length > 0
}

/**
 * Convert a folder-store lock age (seconds) into a compact human label, e.g.
 * `12s`, `4m`, `2h`. Used by the lock warning surface to communicate how long
 * the stale lock has been held without leaking absolute timestamps.
 */
export function formatSprintEngineLockAge(ageSeconds: number | null | undefined): string {
  if (typeof ageSeconds !== 'number' || !Number.isFinite(ageSeconds) || ageSeconds < 0) return 'unknown age'
  if (ageSeconds < 60) return `${Math.round(ageSeconds)}s`
  const minutes = ageSeconds / 60
  if (minutes < 60) return `${Math.round(minutes)}m`
  const hours = minutes / 60
  if (hours < 24) return `${Math.round(hours * 10) / 10}h`
  const days = hours / 24
  return `${Math.round(days * 10) / 10}d`
}

/**
 * Lifecycle phases the board should currently surface as columns. A phase
 * appears when the active `qualityPolicy.lifecyclePhases` includes it OR any
 * task is currently materialized in that phase folder. Empty result means the
 * board hides review/testing/product columns entirely (pre-gated runs and
 * mock states keep their compact layout).
 */
export function getActiveSprintEngineLifecyclePhases(
  sprintEngineState: SprintEngineLifecyclePhaseState | null | undefined
): SprintEngineQualityGatePhase[] {
  if (!sprintEngineState) return []
  const phasesFromPolicy = new Set<SprintEngineQualityGatePhase>()
  const policy = sprintEngineState.qualityPolicy
  if (policy?.enabled) {
    const configuredLifecyclePhases = new Set(policy.lifecyclePhases)
    const rosterRoles = new Set(
      Object.values(sprintEngineState.sprintEngineAgents ?? {}).map((agent) => agent.role)
    )
    const canFilterByRoster = Boolean(policy.rosterDriven && sprintEngineState.rosterConfigured && rosterRoles.size > 0)
    const gateRoleIsRelevant = (role: SprintEngineRole): boolean => !canFilterByRoster || rosterRoles.has(role)
    if (canFilterByRoster) {
      for (const gate of Object.values(policy.gates)) {
        if (configuredLifecyclePhases.has(gate.phase) && gateRoleIsRelevant(gate.role)) {
          phasesFromPolicy.add(gate.phase)
        }
      }
    } else {
      for (const phase of policy.lifecyclePhases) phasesFromPolicy.add(phase)
    }
    for (const task of sprintEngineState.tasks) {
      for (const gate of task.qualityGates ?? []) {
        if (configuredLifecyclePhases.has(gate.phase) && gateRoleIsRelevant(gate.role)) {
          phasesFromPolicy.add(gate.phase)
        }
      }
    }
  }
  const phasesFromTasks = new Set<SprintEngineQualityGatePhase>()
  for (const task of sprintEngineState.tasks) {
    const column = task.boardColumn ?? task.status
    if (column && isSprintEngineQualityGatePhase(column)) phasesFromTasks.add(column)
  }
  return sprintEngineLifecyclePhaseColumns.filter(
    (phase) => phasesFromPolicy.has(phase) || phasesFromTasks.has(phase)
  )
}

/**
 * Board columns the renderer should display for the current state. Lifecycle
 * phase columns (review/testing/product) appear only when policy or active
 * tasks demand them; the rest of the column vocabulary is fixed.
 */
export function getSprintEngineVisibleBoardColumns(
  sprintEngineState: SprintEngineLifecyclePhaseState | null | undefined
): { key: SprintEngineTaskBoardColumn; label: string }[] {
  const activePhases = new Set<SprintEngineQualityGatePhase>(
    getActiveSprintEngineLifecyclePhases(sprintEngineState)
  )
  return sprintEngineTaskBoardColumns.filter((column) =>
    !isSprintEngineQualityGatePhase(column.key) || activePhases.has(column.key)
  )
}

export function getLatestSprintEngineTaskComment(
  task: Pick<SprintEngineTask, 'comments' | 'latestComments'>,
  type: SprintEngineTaskCommentType
): SprintEngineTaskComment | undefined {
  const pool: SprintEngineTaskComment[] = [
    ...(task.latestComments ?? []),
    ...(task.comments ?? []),
  ]
  let latest: SprintEngineTaskComment | undefined
  for (const comment of pool) {
    if (comment.type !== type) continue
    if (!latest || (comment.createdAt ?? '').localeCompare(latest.createdAt ?? '') > 0) {
      latest = comment
    }
  }
  return latest
}

export function getOpenSprintEngineFeedbackComments(
  task: Pick<SprintEngineTask, 'latestOpenFeedback'>
): SprintEngineTaskComment[] {
  return [...(task.latestOpenFeedback ?? [])].sort((a, b) =>
    (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
  )
}

export function getSprintEngineTaskQualityGates(
  task: Pick<SprintEngineTask, 'qualityGates'>
): SprintEngineQualityGate[] {
  return task.qualityGates ?? []
}

export function getSprintEngineQualityGatesByPhase(
  task: Pick<SprintEngineTask, 'qualityGates'>,
  phase: SprintEngineQualityGatePhase
): SprintEngineQualityGate[] {
  return getSprintEngineTaskQualityGates(task).filter((gate) => gate.phase === phase)
}

export function getOpenSprintEngineQualityGates(
  task: Pick<SprintEngineTask, 'qualityGates'>
): SprintEngineQualityGate[] {
  return getSprintEngineTaskQualityGates(task).filter(
    (gate) => gate.required && gate.status !== 'approved' && gate.status !== 'skipped'
  )
}

/**
 * Convert a `#rrggbb` hex string to an `rgba(...)` string with the given alpha.
 * Colocated here because every caller pairs it with `sprintEngineRoleAccent`
 * to render the role-tinted avatar / backplate documented in
 * knowledge/brand/panel-design-system.md.
 */
export function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  const red = parseInt(value.slice(0, 2), 16)
  const green = parseInt(value.slice(2, 4), 16)
  const blue = parseInt(value.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}
