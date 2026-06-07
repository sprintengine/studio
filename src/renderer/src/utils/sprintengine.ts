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
  SprintEngineRoleId,
  SprintEngineRoleRegistry,
  SprintEngineRoleRegistryMetadata,
  SprintEngineRoleRegistrySourceLayer,
  SprintEngineRoleRegistryWarning,
  SprintEngineRoleSettings,
  SprintEngineRunnerPolicy,
  SprintEngineRuntimeAgent,
  SprintEngineSkillMap,
  SprintEngineTaskActivityEntry,
  SprintEngineTaskActivityType,
  SprintEngineTaskCommentType,
  SprintEngineTaskDiff,
  SprintEngineTaskDiffLine,
  SprintEngineTaskDiffSource,
  SprintEngineTaskDiffStatus,
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
  role: SprintEngineRoleId
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

// Bundled-role label table. Renderer surfaces must NEVER index this with a
// raw `SprintEngineRoleId` from projection or registry data — use
// `getSprintEngineRoleLabel(roleId, metadata?)` so custom and unknown
// configured roles fall back to a registry label or a safe humanized id.
export const sprintEngineRoleLabels: Record<SprintEngineRole, string> = {
  architect: 'Architect',
  product: 'Product Strategist',
  developer: 'Developer',
  frontend: 'Frontend Engineer',
  ui_ux_reviewer: 'UI/UX Reviewer',
  tester: 'Tester',
  security: 'Security Specialist',
  code_reviewer: 'Code Reviewer',
  nuclear_reviewer: 'Nuclear Reviewer',
  spec_reviewer: 'Spec Reviewer',
  performance: 'Performance Engineer',
  cross_platform: 'Cross-platform Specialist',
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

// Bundled-role accent table. Renderer surfaces must NEVER index this with a
// raw `SprintEngineRoleId` — use `getSprintEngineRoleAccent` so custom roles
// fall back to a neutral chrome tone.
export const sprintEngineRoleAccent: Record<SprintEngineRole, string> = {
  architect: '#d4a757',
  product: '#e879a7',
  developer: '#c7ccd4',
  frontend: '#39d7ff',
  ui_ux_reviewer: '#8bdbca',
  tester: '#3dff8f',
  security: '#ff6b6b',
  code_reviewer: '#f59e0b',
  nuclear_reviewer: '#fb7185',
  spec_reviewer: '#22c55e',
  performance: '#a78bfa',
  cross_platform: '#14b8a6',
}

// Neutral accent used when an extensible role has no registry icon/colour
// metadata. Pulled into a constant so safe accessors and primitives share
// the same fallback tone instead of inventing one per call site.
export const sprintEngineNeutralRoleAccent = '#7a8190'

// Maps a SpecialistAction.soulRole string to the canonical bundled
// SprintEngineRole so Watchtower (and any other panel showing specialists)
// can render the same icon disc + role accent + role label that Sprint
// Engine uses. This mapping is intentionally scoped to non-registry
// specialist compatibility: it converts a fixed-set Watchtower specialist
// identifier into a bundled Sprint Engine role for icon/accent reuse and
// must not be used to coerce registry-discovered role ids. Returns null
// for specialists with no bundled Sprint Engine equivalent (devops,
// blog_writer); callers should fall back to the specialist's own icon and
// short label.
const SOUL_ROLE_TO_SPRINT_ENGINE_ROLE: Record<string, SprintEngineRole> = {
  architect: 'architect',
  product: 'product',
  developer: 'developer',
  frontend: 'frontend',
  ui_ux_reviewer: 'ui_ux_reviewer',
  tester: 'tester',
  security: 'security',
  code_reviewer: 'code_reviewer',
  nuclear_reviewer: 'nuclear_reviewer',
  spec_reviewer: 'spec_reviewer',
  performance: 'performance',
  cross_platform: 'cross_platform',
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
  cross_platform_review: 'Cross-platform Review',
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
  'ui_ux_reviewer',
  'developer',
  'code_reviewer',
  'nuclear_reviewer',
  'spec_reviewer',
  'performance',
  'cross_platform',
  'tester',
  'security',
]

// Architect is the minimum role Sprint Engine planning depends on. Treat it
// as an always-enabled member of any roster so a stale or hostile user
// setting cannot strand a new workspace without a planner.
export const protectedSprintEngineRoleId: SprintEngineRoleId = 'architect'

// Settings.role enablement is a future-roster filter, never a runtime
// dispatch policy. Returns the role ids the user has explicitly turned off,
// excluding `architect` which cannot be disabled.
export function getUserDisabledSprintEngineRoleIds(
  settings: SprintEngineRoleSettings | null | undefined,
): ReadonlySet<SprintEngineRoleId> {
  const disabled = new Set<SprintEngineRoleId>()
  const entries = settings?.enabled
  if (!entries || typeof entries !== 'object') return disabled
  for (const [roleId, enabled] of Object.entries(entries)) {
    if (enabled !== false) continue
    if (roleId === protectedSprintEngineRoleId) continue
    if (!normalizeSprintEngineRoleId(roleId)) continue
    disabled.add(roleId)
  }
  return disabled
}

// Build the ordered, selectable Sprint Engine role list shared by the new
// workspace roster table and the guided-brief handoff roster. Bundled roles
// come first (in their canonical order), custom registry roles follow
// alphabetically. Manifest-disabled registry roles and user-disabled roles
// are filtered out; `architect` always remains.
export function orderSprintEngineRosterRoles(
  registry?: SprintEngineRoleRegistry | null,
  disabledRoleIds?: ReadonlySet<SprintEngineRoleId> | null,
): SprintEngineRoleId[] {
  const disabled = disabledRoleIds ?? new Set<SprintEngineRoleId>()
  const ids = new Set<SprintEngineRoleId>()
  for (const role of sprintEngineRoleOrder) {
    if (role !== protectedSprintEngineRoleId && disabled.has(role)) continue
    ids.add(role)
  }
  for (const role of Object.values(registry?.roles ?? {}) as SprintEngineRoleRegistryMetadata[]) {
    if (role.enabled === false) continue
    if (role.id !== protectedSprintEngineRoleId && disabled.has(role.id)) continue
    ids.add(role.id)
  }
  return [...ids].sort((a, b) => {
    const aBundled = sprintEngineRoleOrder.indexOf(a as SprintEngineRole)
    const bBundled = sprintEngineRoleOrder.indexOf(b as SprintEngineRole)
    const aRank = aBundled >= 0 ? aBundled : sprintEngineRoleOrder.length
    const bRank = bBundled >= 0 ? bBundled : sprintEngineRoleOrder.length
    if (aRank !== bRank) return aRank - bRank
    return getSprintEngineRoleLabel(a, registry).localeCompare(getSprintEngineRoleLabel(b, registry))
  })
}

// Zero out counts for user-disabled roles before workspace creation so a
// stale local count from a prior selection cannot leak a disabled role into
// the new roster. Architect is preserved.
export function applyUserDisabledSprintEngineRoleCounts(
  roleCounts: SprintEngineRoleCounts,
  disabledRoleIds: ReadonlySet<SprintEngineRoleId>,
): SprintEngineRoleCounts {
  if (!disabledRoleIds.size) return roleCounts
  let mutated = false
  let next: SprintEngineRoleCounts | null = null
  for (const roleId of disabledRoleIds) {
    if ((roleCounts[roleId] ?? 0) <= 0) continue
    if (!next) next = { ...roleCounts }
    next[roleId] = 0
    mutated = true
  }
  return mutated && next ? next : roleCounts
}

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
  'cross_platform_review',
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
const sprintEngineNeedsInputKinds: readonly SprintEngineNeedsInputKind[] = ['architect', 'user', 'owner', 'external_validation']

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
  'cross_platform_review',
  'validation_report',
])

const sprintEngineTaskDiffStatuses = new Set<SprintEngineTaskDiffStatus>([
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'type_changed',
  'unmerged',
  'unknown',
])

const sprintEngineTaskDiffSources = new Set<SprintEngineTaskDiffSource>([
  'working_tree',
  'staged',
  'commit',
  'checkpoint',
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

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => typeof item === 'string' && item.trim() ? [item.trim()] : [])
    : []
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function nullableLineNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null
}

function normalizeSprintEngineTaskDiffLines(value: unknown): SprintEngineTaskDiffLine[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 2500).flatMap((line): SprintEngineTaskDiffLine[] => {
    if (!line || typeof line !== 'object') return []
    const record = line as Record<string, unknown>
    const type = record.type === 'added' || record.type === 'removed' || record.type === 'context'
      ? record.type
      : null
    if (!type || typeof record.content !== 'string') return []
    return [{
      type,
      oldLine: nullableLineNumber(record.oldLine),
      newLine: nullableLineNumber(record.newLine),
      content: record.content,
    }]
  })
}

function normalizeSprintEngineTaskDiffHunks(value: unknown): SprintEngineTaskDiff['hunks'] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 100).flatMap((hunk): SprintEngineTaskDiff['hunks'] => {
    if (!hunk || typeof hunk !== 'object') return []
    const record = hunk as Record<string, unknown>
    return [{
      oldStart: nonNegativeInteger(record.oldStart),
      oldLines: nonNegativeInteger(record.oldLines),
      newStart: nonNegativeInteger(record.newStart),
      newLines: nonNegativeInteger(record.newLines),
      ...(optionalTrimmedString(record.section) ? { section: optionalTrimmedString(record.section)! } : {}),
      lines: normalizeSprintEngineTaskDiffLines(record.lines),
    }]
  })
}

function normalizeSprintEngineTaskDiffs(value: unknown): SprintEngineTaskDiff[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 50).flatMap((diff): SprintEngineTaskDiff[] => {
    if (!diff || typeof diff !== 'object') return []
    const record = diff as Record<string, unknown>
    const path = optionalTrimmedString(record.path)
    if (!path) return []
    const status = sprintEngineTaskDiffStatuses.has(record.status as SprintEngineTaskDiffStatus)
      ? record.status as SprintEngineTaskDiffStatus
      : 'unknown'
    const source = sprintEngineTaskDiffSources.has(record.source as SprintEngineTaskDiffSource)
      ? record.source as SprintEngineTaskDiffSource
      : 'working_tree'
    return [{
      path,
      ...(optionalTrimmedString(record.oldPath) ? { oldPath: optionalTrimmedString(record.oldPath)! } : {}),
      status,
      additions: nonNegativeInteger(record.additions),
      deletions: nonNegativeInteger(record.deletions),
      capturedAt: optionalTrimmedString(record.capturedAt) ?? '',
      capturedBy: optionalTrimmedString(record.capturedBy) ?? '',
      source,
      binary: record.binary === true,
      truncated: record.truncated === true,
      ...(optionalTrimmedString(record.skippedReason) ? { skippedReason: optionalTrimmedString(record.skippedReason)! } : {}),
      hunks: normalizeSprintEngineTaskDiffHunks(record.hunks),
    }]
  })
}

function normalizeSprintEngineTaskEvidence(value: unknown): SprintEngineTaskEvidence {
  if (!value || typeof value !== 'object') return emptyEvidence()
  const record = value as Record<string, unknown>
  const diffs = normalizeSprintEngineTaskDiffs(record.diffs)
  return {
    summary: typeof record.summary === 'string' ? record.summary : '',
    touchedFiles: normalizeStringList(record.touchedFiles),
    commandsRan: normalizeStringList(record.commandsRan),
    results: normalizeStringList(record.results),
    ...(diffs.length > 0 ? { diffs } : {}),
  }
}

function isSprintEngineRole(value: unknown): value is SprintEngineRole {
  return (
    value === 'architect'
    || value === 'product'
    || value === 'developer'
    || value === 'frontend'
    || value === 'ui_ux_reviewer'
    || value === 'tester'
    || value === 'security'
    || value === 'code_reviewer'
    || value === 'nuclear_reviewer'
    || value === 'spec_reviewer'
    || value === 'performance'
    || value === 'cross_platform'
  )
}

// Predicate for any registry-keyed role id. Preserves custom configured
// roles through projection normalization; bundled roles are still accepted.
export function isSprintEngineRoleId(value: unknown): value is SprintEngineRoleId {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeSprintEngineRoleId(value: unknown): SprintEngineRoleId | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function isBundledSprintEngineRole(value: SprintEngineRoleId | null | undefined): value is SprintEngineRole {
  return isSprintEngineRole(value)
}

// Convert a registry role id like `marketer` or `growth_engineer` to a safe
// display label when no registry metadata is available. Underscores and
// hyphens become spaces; segments are title-cased. Bundled roles always
// resolve via `sprintEngineRoleLabels`, so this only ever runs for unknown
// configured ids.
export function humanizeSprintEngineRoleId(roleId: SprintEngineRoleId): string {
  const cleaned = roleId.trim().replace(/[_-]+/g, ' ').trim()
  if (!cleaned) return roleId
  return cleaned
    .split(/\s+/)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

export function getSprintEngineRoleLabel(
  roleId: SprintEngineRoleId | null | undefined,
  metadata?: SprintEngineRoleRegistryMetadata | SprintEngineRoleRegistry | null,
): string {
  const normalized = normalizeSprintEngineRoleId(roleId)
  if (!normalized) return 'Unknown role'
  const fromRegistry = resolveRoleRegistryMetadata(normalized, metadata)
  if (fromRegistry?.label && fromRegistry.label.trim()) return fromRegistry.label.trim()
  if (isSprintEngineRole(normalized)) return sprintEngineRoleLabels[normalized]
  // Alias lookup: when the registry directory was passed and contains an
  // alias that resolves the id, prefer that label.
  return humanizeSprintEngineRoleId(normalized)
}

export function getSprintEngineRoleAccent(
  roleId: SprintEngineRoleId | null | undefined,
  metadata?: SprintEngineRoleRegistryMetadata | SprintEngineRoleRegistry | null,
): string {
  const normalized = normalizeSprintEngineRoleId(roleId)
  if (!normalized) return sprintEngineNeutralRoleAccent
  if (isSprintEngineRole(normalized)) return sprintEngineRoleAccent[normalized]
  // Registry metadata does not currently emit an accent colour; we keep the
  // neutral fallback until the registry contract grows that field rather
  // than fabricating tones per id.
  resolveRoleRegistryMetadata(normalized, metadata)
  return sprintEngineNeutralRoleAccent
}

// Bundled glyph kinds the renderer ships SVGs for. Extensible roles fall
// back to the neutral glyph below; registry metadata may eventually carry
// its own icon kind, but the renderer only ships a fixed sprite sheet today.
export type SprintEngineRoleGlyphKind =
  | 'architect'
  | 'product'
  | 'developer'
  | 'frontend'
  | 'ui_ux_reviewer'
  | 'tester'
  | 'security'
  | 'code_reviewer'
  | 'nuclear_reviewer'
  | 'spec_reviewer'
  | 'performance'
  | 'cross_platform'
  | 'unknown'

export function getSprintEngineRoleGlyphKind(
  roleId: SprintEngineRoleId | null | undefined,
  metadata?: SprintEngineRoleRegistryMetadata | SprintEngineRoleRegistry | null,
): SprintEngineRoleGlyphKind {
  const normalized = normalizeSprintEngineRoleId(roleId)
  if (!normalized) return 'unknown'
  if (isSprintEngineRole(normalized)) return normalized
  const fromRegistry = resolveRoleRegistryMetadata(normalized, metadata)
  const icon = fromRegistry?.icon?.trim()
  if (icon && isSprintEngineRole(icon)) return icon
  return 'unknown'
}

function resolveRoleRegistryMetadata(
  roleId: SprintEngineRoleId,
  source: SprintEngineRoleRegistryMetadata | SprintEngineRoleRegistry | null | undefined,
): SprintEngineRoleRegistryMetadata | undefined {
  if (!source) return undefined
  if (isSprintEngineRoleRegistry(source)) {
    const direct = source.roles[roleId]
    if (direct) return direct
    const aliasTarget = source.aliases?.[roleId]
    if (aliasTarget) return source.roles[aliasTarget]
    return undefined
  }
  if (source.id === roleId) return source
  return undefined
}

function isSprintEngineRoleRegistry(
  value: SprintEngineRoleRegistryMetadata | SprintEngineRoleRegistry,
): value is SprintEngineRoleRegistry {
  return Object.prototype.hasOwnProperty.call(value, 'roles')
}

function isSprintEngineRoleRegistrySourceLayer(value: unknown): value is SprintEngineRoleRegistrySourceLayer {
  return typeof value === 'string' && value.length > 0
}

function normalizeSprintEngineRoleRegistryWarning(raw: unknown): SprintEngineRoleRegistryWarning | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const code = optionalTrimmedString(record.code)
  const message = optionalTrimmedString(record.message)
  if (!code || !message) return undefined
  const roleId = optionalTrimmedString(record.roleId)
  const sourceLayer = optionalTrimmedString(record.sourceLayer)
  return {
    code,
    message,
    ...(roleId ? { roleId } : {}),
    ...(sourceLayer ? { sourceLayer } : {}),
  }
}

function normalizeSprintEngineRoleRegistryMetadata(raw: unknown): SprintEngineRoleRegistryMetadata | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const id = normalizeSprintEngineRoleId(record.id)
  if (!id) return undefined
  const label = optionalTrimmedString(record.label) ?? humanizeSprintEngineRoleId(id)
  const aliases = Array.isArray(record.aliases)
    ? record.aliases.flatMap((alias) => {
        const normalized = normalizeSprintEngineRoleId(alias)
        return normalized ? [normalized] : []
      })
    : []
  const summary = typeof record.summary === 'string' && record.summary.trim()
    ? record.summary.trim()
    : record.summary === null
      ? null
      : undefined
  const icon = typeof record.icon === 'string' && record.icon.trim()
    ? record.icon.trim()
    : record.icon === null
      ? null
      : undefined
  const sourceRecord = record.source && typeof record.source === 'object'
    ? record.source as Record<string, unknown>
    : null
  const layer = isSprintEngineRoleRegistrySourceLayer(sourceRecord?.layer)
    ? sourceRecord!.layer
    : 'bundled'
  const shadowedSources = Array.isArray(record.shadowedSources)
    ? record.shadowedSources.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return []
        const entryRecord = entry as Record<string, unknown>
        return isSprintEngineRoleRegistrySourceLayer(entryRecord.layer)
          ? [{ layer: entryRecord.layer }]
          : []
      })
    : []
  const warnings = Array.isArray(record.warnings)
    ? record.warnings.flatMap((entry) => {
        const normalized = normalizeSprintEngineRoleRegistryWarning(entry)
        return normalized ? [normalized] : []
      })
    : []
  const enabled = typeof record.enabled === 'boolean' ? record.enabled : undefined
  return {
    id,
    label,
    aliases,
    ...(summary !== undefined ? { summary } : {}),
    ...(icon !== undefined ? { icon } : {}),
    source: { layer },
    ...(shadowedSources.length > 0 ? { shadowedSources } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
  }
}

// Build a renderer-side role registry directory from the
// `sprintengine.roles.list` MCP response. Unknown or malformed entries are
// dropped; warnings the registry surfaced are preserved so the Settings
// Roles tab and inspector can show source-layer / shadowing diagnostics.
export function buildSprintEngineRoleRegistry(payload: unknown): SprintEngineRoleRegistry {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const rolesRaw = Array.isArray(record.roles) ? record.roles : []
  const roles: Record<SprintEngineRoleId, SprintEngineRoleRegistryMetadata> = {}
  for (const entry of rolesRaw) {
    const normalized = normalizeSprintEngineRoleRegistryMetadata(entry)
    if (!normalized) continue
    roles[normalized.id] = normalized
  }
  const aliasesRaw = record.aliases && typeof record.aliases === 'object'
    ? record.aliases as Record<string, unknown>
    : {}
  const aliases: Record<string, SprintEngineRoleId> = {}
  for (const [aliasKey, target] of Object.entries(aliasesRaw)) {
    const aliasId = normalizeSprintEngineRoleId(aliasKey)
    const targetId = normalizeSprintEngineRoleId(target)
    if (!aliasId || !targetId || !roles[targetId]) continue
    aliases[aliasId] = targetId
  }
  const warningsRaw = Array.isArray(record.warnings) ? record.warnings : []
  const warnings: SprintEngineRoleRegistryWarning[] = []
  for (const entry of warningsRaw) {
    const normalized = normalizeSprintEngineRoleRegistryWarning(entry)
    if (normalized) warnings.push(normalized)
  }
  return { roles, aliases, warnings }
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
    // Preserve any registry-keyed role id (bundled or custom) so comments
    // authored by a custom-role agent like `marketer` keep their attribution
    // through projection normalization. Empty strings are still dropped.
    const authorRole = normalizeSprintEngineRoleId(record.authorRole)
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
    const role = normalizeSprintEngineRoleId(record.role)
    const claimedBy = optionalTrimmedString(record.claimedBy)
    const startedAt = optionalTrimmedString(record.startedAt)
    const completedAt = optionalTrimmedString(record.completedAt)
    const verdict = optionalTrimmedString(record.verdict)
    const note = optionalTrimmedString(record.note)
    const summary = optionalTrimmedString(record.summary)
    return [{
      id,
      ...(status ? { status } : {}),
      ...(actor ? { actor } : {}),
      ...(role ? { role } : {}),
      ...(claimedBy ? { claimedBy } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(completedAt ? { completedAt } : {}),
      ...(verdict ? { verdict } : {}),
      ...(note ? { note } : {}),
      ...(summary ? { summary } : {}),
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
    const role = normalizeSprintEngineRoleId(record.role)
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
    const roleId = normalizeSprintEngineRoleId(rawGate.role)
    if (!isSprintEngineQualityGatePhase(rawGate.phase) || !roleId) continue
    const focus = optionalTrimmedString(rawGate.focus)
    gates[gateId] = {
      phase: rawGate.phase,
      role: roleId,
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
  // Field rename: legacy `runner.mode` (`auto|off`) → `runner.cliWatchPolling`
  // (`enabled|disabled`). Read both for backward compatibility; the Python
  // normalizer also accepts both shapes so projections from older state files
  // still resolve correctly.
  const explicit = record.cliWatchPolling
  const cliWatchPolling = explicit === 'enabled' || explicit === 'disabled'
    ? explicit
    : record.mode === 'auto'
      ? 'enabled'
      : 'disabled'
  return {
    cliWatchPolling,
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
    external_validation: 'verification',
  }
  const reason = optionalTrimmedString(record.reason)
    ? optionalTrimmedString(record.reason)!
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

  const feedbackRole = normalizeSprintEngineRoleId(record.role)
  if (
    typeof record.schemaVersion !== 'number'
    || typeof record.capturedAt !== 'string'
    || typeof record.source !== 'string'
    || typeof record.agentId !== 'string'
    || !feedbackRole
    || (!hasScore && !topFriction && !suggestedImprovement && issues.length === 0 && findings.length === 0)
  ) {
    return undefined
  }

  return {
    schemaVersion: record.schemaVersion,
    capturedAt: record.capturedAt,
    source: record.source,
    agentId: record.agentId,
    role: feedbackRole,
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

  const suggestedRole = normalizeSprintEngineRoleId(record.suggestedRole)
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
  return {
    architect: 1,
    product: 1,
    developer: 1,
    frontend: 0,
    ui_ux_reviewer: 0,
    tester: 0,
    security: 0,
    code_reviewer: 0,
    nuclear_reviewer: 0,
    spec_reviewer: 0,
    performance: 0,
    cross_platform: 0,
  }
}

export function createDefaultSprintEngineSkills(): SprintEngineSkillMap {
  return {
    architect: ['Deep repo analysis', 'Planning', 'Task decomposition', 'Dependency mapping'],
    product: ['Market research', 'Competitor analysis', 'Audience fit', 'Product positioning'],
    developer: ['Implementation', 'Refactoring', 'Integration work', 'Testing'],
    frontend: ['Interface design', 'Interaction design', 'Responsive layouts', 'UI implementation'],
    ui_ux_reviewer: ['UI/UX review', 'Brand alignment', 'Responsive QA', 'Visual artifact checks'],
    tester: ['Regression checks', 'Acceptance review', 'Validation'],
    security: ['Threat modeling', 'Security review', 'Hardening', 'Abuse-case analysis'],
    code_reviewer: ['Code review', 'Regression risk', 'Maintainability', 'Evidence quality'],
    nuclear_reviewer: ['Structural review', 'Large-file risk', 'Abstraction quality', 'Spaghetti-growth checks'],
    spec_reviewer: ['Spec conformance', 'Acceptance coverage', 'Behavioral gaps', 'Test evidence'],
    performance: ['Latency review', 'Memory and CPU analysis', 'Bundle/runtime cost', 'Measurement quality'],
    cross_platform: ['OS compatibility', 'Browser/device coverage', 'Path and shell portability', 'Packaging checks'],
  }
}

export function countSprintEngineAgents(roleCounts: SprintEngineRoleCounts): number {
  return Object.values(roleCounts).reduce((total, count) => total + Math.max(0, count), 0)
}

export function normalizeSprintEngineRoleCounts(
  roleCounts?: Partial<SprintEngineRoleCounts> | null
): SprintEngineRoleCounts {
  const defaults = createDefaultSprintEngineRoleCounts()
  const result: SprintEngineRoleCounts = { ...defaults }
  if (!roleCounts || typeof roleCounts !== 'object') return result
  for (const [role, rawCount] of Object.entries(roleCounts)) {
    if (!normalizeSprintEngineRoleId(role)) continue
    const fallback = defaults[role] ?? (role === 'architect' ? 1 : 0)
    result[role] = Math.max(role === 'architect' ? 1 : 0, Math.floor(Number(rawCount ?? fallback) || 0))
  }
  return result
}

function roleAgentIndex(agentId: string, role: SprintEngineRoleId): number {
  const base = role
  if (agentId === base) return 1
  // Escape the role id for use in a RegExp — custom registry ids may
  // contain characters the regex syntax would otherwise interpret.
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = agentId.match(new RegExp(`^${escaped}-(\\d+)$`))
  if (!match) return Number.MAX_SAFE_INTEGER
  return Number(match[1])
}

export function getNextSprintEngineAgentId(
  role: SprintEngineRoleId,
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

export function buildSprintEngineAgentRoster(
  roleCounts: SprintEngineRoleCounts,
  registry?: SprintEngineRoleRegistry | null,
): SprintEngineAgentRosterItem[] {
  const roster: SprintEngineAgentRosterItem[] = []
  const configuredRoles = new Set<SprintEngineRoleId>([
    ...sprintEngineRoleOrder,
    ...Object.keys(roleCounts).filter((role) => Boolean(normalizeSprintEngineRoleId(role))),
  ])
  const orderedRoles = [...configuredRoles].sort((a, b) => {
    const aBundled = sprintEngineRoleOrder.indexOf(a as SprintEngineRole)
    const bBundled = sprintEngineRoleOrder.indexOf(b as SprintEngineRole)
    const aRank = aBundled >= 0 ? aBundled : sprintEngineRoleOrder.length
    const bRank = bBundled >= 0 ? bBundled : sprintEngineRoleOrder.length
    if (aRank !== bRank) return aRank - bRank
    return getSprintEngineRoleLabel(a, registry).localeCompare(getSprintEngineRoleLabel(b, registry))
  })

  for (const role of orderedRoles) {
    const count = Math.max(role === 'architect' ? 1 : 0, roleCounts[role] ?? 0)
    for (let i = 0; i < count; i++) {
      const id = count > 1 || role === 'developer' ? `${role}-${i + 1}` : role
      const suffix = count > 1 ? ` ${i + 1}` : ''
      roster.push({ id, label: `${getSprintEngineRoleLabel(role, registry)}${suffix}`, role })
    }
  }

  return roster
}

export function buildSprintEngineAgentRosterFromRuntimeAgents(
  sprintEngineAgents: Record<AgentId, SprintEngineRuntimeAgent>,
  registry?: SprintEngineRoleRegistry | null,
): SprintEngineAgentRosterItem[] {
  // Tally how many agents each registry-keyed role has so we can decide
  // whether to append a positional suffix to labels. Bundled and custom
  // roles share the same Map; unknown ids do not silently collapse into a
  // bundled bucket.
  const roleTotals = new Map<SprintEngineRoleId, number>()
  for (const agent of Object.values(sprintEngineAgents)) {
    const role = agent?.role
    if (!role) continue
    roleTotals.set(role, (roleTotals.get(role) ?? 0) + 1)
  }

  const seenByRole = new Map<SprintEngineRoleId, number>()
  const rolePriority = (role: SprintEngineRoleId): number => {
    const bundled = sprintEngineRoleOrder.indexOf(role as SprintEngineRole)
    // Bundled order first, then unknown/custom roles sorted alphabetically
    // after the bundled block so the roster has a stable layout regardless
    // of registry source layer.
    return bundled >= 0 ? bundled : sprintEngineRoleOrder.length
  }

  return Object.entries(sprintEngineAgents)
    .filter((entry): entry is [AgentId, SprintEngineRuntimeAgent] => Boolean(entry[1]?.role))
    .sort(([aId, a], [bId, b]) => {
      const roleDelta = rolePriority(a.role) - rolePriority(b.role)
      if (roleDelta !== 0) return roleDelta
      const roleNameDelta = a.role.localeCompare(b.role)
      if (roleNameDelta !== 0) return roleNameDelta
      return roleAgentIndex(aId, a.role) - roleAgentIndex(bId, b.role)
    })
    .map(([id, agent]) => {
      const seen = (seenByRole.get(agent.role) ?? 0) + 1
      seenByRole.set(agent.role, seen)
      const total = roleTotals.get(agent.role) ?? 1
      const suffix = total > 1 ? ` ${seen}` : ''
      const baseLabel = getSprintEngineRoleLabel(agent.role, registry)
      return { id, label: `${baseLabel}${suffix}`, role: agent.role }
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

// Bundled worker roles that surface their own role-task launch button on
// the Sprint Engine panel. When one of these has an active or ready task,
// the role-task launch supersedes a generic focus-agent action for the same
// role. Extensible/custom roles do not yet ship dedicated role-task launch
// buttons; they always defer to the generic focus-agent action.
const SPRINT_ENGINE_FOCUS_WORKER_ROLES: SprintEngineRole[] = [
  'developer',
  'frontend',
  'ui_ux_reviewer',
  'product',
  'code_reviewer',
  'nuclear_reviewer',
  'spec_reviewer',
  'performance',
  'cross_platform',
  'tester',
  'security',
]

export type SprintEngineRuntimeAgentEffectiveStatus =
  | SprintEngineRuntimeAgent['status']
  | 'idle'
  | 'exited'

export type SprintEngineFocusAgent = {
  agentId: AgentId
  role: SprintEngineRoleId
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
  const roleTaskLaunchSet = new Set<SprintEngineRoleId>()
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
  const focusAgentRole: SprintEngineRoleId | undefined = focusAgentRosterRole ?? focusAgent.role
  const showFocusAgentAction =
    !focusAgentRole
    || focusAgentRole === 'architect'
    || !roleTaskLaunchSet.has(focusAgentRole)

  return { focusAgent, showFocusAgentAction }
}

function isSprintEngineStateRosterInput(
  input: Pick<SprintEngineState, 'roleCounts' | 'sprintEngineAgents' | 'rosterConfigured'> | SprintEngineRoleCounts | null | undefined
): input is Pick<SprintEngineState, 'roleCounts' | 'sprintEngineAgents' | 'rosterConfigured'> {
  return Boolean(input && typeof input === 'object' && 'sprintEngineAgents' in input)
}

export function buildSprintEngineRosterCommandArgs(
  sprintEngineState: Pick<SprintEngineState, 'roleCounts' | 'sprintEngineAgents' | 'rosterConfigured'> | SprintEngineRoleCounts | null | undefined
): string[] {
  const stateInput = isSprintEngineStateRosterInput(sprintEngineState) ? sprintEngineState : null
  if (stateInput && !stateInput.rosterConfigured) return []
  const roster = stateInput
    ? buildSprintEngineAgentRosterForState(stateInput)
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
    const feedbackAssessments = Array.isArray((task as { feedbackAssessments?: unknown }).feedbackAssessments)
      ? ((task as { feedbackAssessments?: unknown[] }).feedbackAssessments ?? [])
        .map((entry) => normalizeSprintEngineTaskFeedback(entry))
        .filter((entry): entry is SprintEngineTaskFeedback => Boolean(entry))
      : []
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
    // Preserve any registry-keyed role id (bundled or custom) so projection
    // normalization never drops a custom-role task into `developer`.
    const taskRole = normalizeSprintEngineRoleId(task.role) ?? 'developer'
    return {
      id: task.id ?? `task-${index + 1}`,
      title: task.title ?? `Task ${index + 1}`,
      description: task.description ?? '',
      role: taskRole,
      status,
      ...(semanticStatus ? { stateStatus: semanticStatus } : {}),
      ...(boardColumn ? { boardColumn } : {}),
      ...(folderStatus ? { folderStatus } : {}),
      ...(source ? { source } : {}),
      ...(dispatch ? { dispatch } : {}),
      ownerAgentId: task.ownerAgentId ?? null,
      ...(task.lastImplementedByAgentId ? { lastImplementedByAgentId: task.lastImplementedByAgentId } : {}),
      dependsOn: stringArray(task.dependsOn),
      ownedPaths: stringArray(task.ownedPaths),
      acceptanceCriteria: stringArray(task.acceptanceCriteria),
      implementationNotes: stringArray(task.implementationNotes),
      evidence: normalizeSprintEngineTaskEvidence(task.evidence),
      ...(feedback ? { feedback } : {}),
      ...(feedbackAssessments.length > 0 ? { feedbackAssessments } : {}),
      ...(triage ? { triage } : {}),
      ...(needsInput ? { needsInput } : {}),
      notes: stringArray(task.notes),
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

function normalizeCurrentDispatch(value: unknown): SprintEngineRuntimeAgent['currentDispatch'] {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const dispatchId = optionalTrimmedString(record.dispatchId) ?? optionalTrimmedString(record.id) ?? null
  const targetKind = optionalTrimmedString(record.targetKind) ?? null
  const role = normalizeSprintEngineRoleId(record.role)
  return {
    dispatchId,
    targetKind,
    ...(role ? { role } : {}),
    ...(optionalTrimmedString(record.reason) ? { reason: optionalTrimmedString(record.reason) } : {}),
    ...(optionalTrimmedString(record.taskId) ? { taskId: optionalTrimmedString(record.taskId) } : {}),
    ...(optionalTrimmedString(record.gateId) ? { gateId: optionalTrimmedString(record.gateId) } : {}),
    ...(optionalTrimmedString(record.artifactId) ? { artifactId: optionalTrimmedString(record.artifactId) } : {}),
    ...(optionalTrimmedString(record.attemptId) ? { attemptId: optionalTrimmedString(record.attemptId) } : {}),
    ...(optionalTrimmedString(record.assignedAt) ? { assignedAt: optionalTrimmedString(record.assignedAt) } : {}),
  }
}

function normalizeCurrentGate(value: unknown): SprintEngineRuntimeAgent['currentGate'] {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const taskId = optionalTrimmedString(record.taskId)
  const gateId = optionalTrimmedString(record.gateId)
  const attemptId = optionalTrimmedString(record.attemptId)
  if (!taskId && !gateId && !attemptId) return null
  return {
    ...(taskId ? { taskId } : {}),
    ...(gateId ? { gateId } : {}),
    ...(attemptId ? { attemptId } : {}),
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
    // Accept any registry-keyed role id (bundled or custom). Roster entries
    // are required to carry a role; only fully missing/empty roles are
    // dropped.
    const roleId = normalizeSprintEngineRoleId(record.role)
    if (!roleId) continue
    const status = record.status === 'running' || record.status === 'needs_input' || record.status === 'done' || record.status === 'retired'
      ? record.status
      : 'idle' as const
    const currentGateId = optionalTrimmedString(record.currentGateId)
    const currentGate = normalizeCurrentGate(record.currentGate)
    result[agentId] = {
      role: roleId,
      status,
      currentTaskId: typeof record.currentTaskId === 'string' ? record.currentTaskId : null,
      ...(currentGateId ? { currentGateId } : {}),
      ...(currentGate ? { currentGate } : {}),
      currentDispatch: normalizeCurrentDispatch(record.currentDispatch),
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
    const role = normalizeSprintEngineRoleId(agent.role)
    if (role) fallbackRoleCounts[role] = (fallbackRoleCounts[role] ?? 0) + 1
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

export type SprintEngineAgentReviewedTask = {
  task: SprintEngineTask
  attempts: Array<{
    gateId: string
    phase: SprintEngineQualityGatePhase
    gateStatus: SprintEngineQualityGate['status']
    role: SprintEngineRoleId
    attemptStatus?: string
    verdict?: string
    summary?: string
    completedAt?: string
    startedAt?: string
  }>
  latestAttemptAt: string | null
}

/**
 * Tasks that the given agent has a quality-gate attempt on, with attempt
 * summaries. Sorted by most recent attempt first.
 */
export function getSprintEngineTasksReviewedByAgent(
  agentId: string,
  tasks: ReadonlyArray<SprintEngineTask>,
): SprintEngineAgentReviewedTask[] {
  const out: SprintEngineAgentReviewedTask[] = []
  for (const task of tasks) {
    const gates = task.qualityGates ?? []
    if (gates.length === 0) continue
    const matchingAttempts: SprintEngineAgentReviewedTask['attempts'] = []
    let latest: string | null = null
    for (const gate of gates) {
      for (const attempt of gate.attempts) {
        if (attempt.actor !== agentId && attempt.claimedBy !== agentId) continue
        const completed = attempt.completedAt ?? null
        const started = attempt.startedAt ?? null
        const stamp = completed ?? started
        if (stamp && (!latest || stamp > latest)) latest = stamp
        matchingAttempts.push({
          gateId: gate.id,
          phase: gate.phase,
          gateStatus: gate.status,
          role: gate.role,
          ...(attempt.status ? { attemptStatus: attempt.status } : {}),
          ...(attempt.verdict ? { verdict: attempt.verdict } : {}),
          ...(attempt.summary ? { summary: attempt.summary } : {}),
          ...(completed ? { completedAt: completed } : {}),
          ...(started ? { startedAt: started } : {}),
        })
      }
    }
    if (matchingAttempts.length === 0) continue
    out.push({ task, attempts: matchingAttempts, latestAttemptAt: latest })
  }
  out.sort((a, b) => (b.latestAttemptAt ?? '').localeCompare(a.latestAttemptAt ?? ''))
  return out
}

export type SprintEngineAgentWorkedOnTask = {
  task: SprintEngineTask
  latestActivityAt: string | null
}

/**
 * Tasks the agent has any recorded activity on. Most useful as the "did /
 * completed / in-flight" view in the agent inspector, since ownerAgentId is
 * cleared the moment a task moves out of in_progress so it can't survive as
 * a historical record.
 *
 * Returned newest-first by the agent's latest activity timestamp.
 */
export function getSprintEngineTasksWorkedOnByAgent(
  agentId: string,
  tasks: ReadonlyArray<SprintEngineTask>,
): SprintEngineAgentWorkedOnTask[] {
  const out: SprintEngineAgentWorkedOnTask[] = []
  for (const task of tasks) {
    let latest: string | null = null
    let matched = false
    for (const entry of task.activity ?? []) {
      if (entry.actor !== agentId) continue
      matched = true
      const stamp = entry.timestamp || null
      if (stamp && (!latest || stamp > latest)) latest = stamp
    }
    if (!matched) continue
    out.push({ task, latestActivityAt: latest })
  }
  out.sort((a, b) => (b.latestActivityAt ?? '').localeCompare(a.latestActivityAt ?? ''))
  return out
}

export type SprintEngineAgentActivityEntry = {
  entry: SprintEngineTaskActivityEntry
  taskId: string
  taskTitle: string
  taskStatus: SprintEngineTask['status']
}

/**
 * Newest-first activity entries authored by `agentId` across every task,
 * decorated with the task context the agent view needs to render them.
 */
export function getSprintEngineAgentActivityDescending(
  agentId: string,
  tasks: ReadonlyArray<SprintEngineTask>,
): SprintEngineAgentActivityEntry[] {
  const out: SprintEngineAgentActivityEntry[] = []
  for (const task of tasks) {
    for (const entry of task.activity ?? []) {
      if (entry.actor !== agentId) continue
      out.push({ entry, taskId: task.id, taskTitle: task.title, taskStatus: task.status })
    }
  }
  out.sort((a, b) => (b.entry.timestamp ?? '').localeCompare(a.entry.timestamp ?? ''))
  return out
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
    const rosterRoles = new Set<SprintEngineRoleId>(
      Object.values(sprintEngineState.sprintEngineAgents ?? {}).map((agent) => agent.role)
    )
    const canFilterByRoster = Boolean(policy.rosterDriven && sprintEngineState.rosterConfigured && rosterRoles.size > 0)
    const gateRoleIsRelevant = (role: SprintEngineRoleId): boolean => !canFilterByRoster || rosterRoles.has(role)
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

// Sprint Engine board view-model helpers — pure derivations consumed by the
// board shell, model hook, and sub-views. Kept testable so the board panel can
// stay a thin composition over them.

export type SprintEngineBoardRuntimeAgentView = {
  agentId: string
  role: SprintEngineRoleId
  status: string
}

export type SprintEngineBoardRunPhase = 'Planning' | 'Tasked' | 'Running' | 'Complete'

/**
 * Resolve the high-level run-phase label rendered in the board hero. Driven by
 * task completion + active runtime agent states, not by surface chrome.
 */
export function getSprintEngineBoardRunPhase(
  sprintEngineState: Pick<SprintEngineState, 'tasks'>,
  runtimeAgents: SprintEngineBoardRuntimeAgentView[],
): SprintEngineBoardRunPhase {
  if (sprintEngineState.tasks.length > 0 && sprintEngineState.tasks.every((task) => task.status === 'done')) {
    return 'Complete'
  }
  if (runtimeAgents.some((agent) => agent.status === 'running' || agent.status === 'needs_input')) {
    return 'Running'
  }
  if (sprintEngineState.tasks.length > 0) {
    return 'Tasked'
  }
  return 'Planning'
}

/**
 * Resolve the per-task owner label shown in the inspector and kanban detail.
 * Resolution order: the active owner, then the worker who last published an
 * implementation pass (the task carries this through review/testing/product),
 * then the role label for `done` tasks, and finally the explicit
 * "No active worker" copy for tasks that were never implemented.
 */
export function getSprintEngineTaskOwnerLabel(
  task: Pick<SprintEngineTask, 'ownerAgentId' | 'lastImplementedByAgentId' | 'role' | 'status'>,
  rosterById: Record<string, { label: string } | undefined>,
): string {
  const ownerId = task.ownerAgentId ?? task.lastImplementedByAgentId ?? null
  if (ownerId) {
    return rosterById[ownerId]?.label ?? ownerId
  }
  return task.status === 'done' ? getSprintEngineRoleLabel(task.role) : 'No active worker'
}

/** One row in the task inspector's implementer timeline. */
export type SprintEngineTaskImplementerEntry = {
  agentId: string
  label: string
  role: SprintEngineRoleId | null
  /** This worker's own completed rounds (their implementation comments). */
  passCount: number
  /** ISO timestamp of this worker's latest implementation pass, if any. */
  lastActivityAt: string | null
  /** True when this worker currently holds the active claim (`ownerAgentId`). */
  isActive: boolean
  /** Runtime status (running/needs_input/error/exited/…) — only resolved for
   *  the active worker; null for historical rows. */
  runtimeStatus: string | null
}

/** Minimal runtime-agent shape the timeline needs to resolve labels/roles. */
export type SprintEngineImplementerRuntimeAgent = {
  agentId: string
  label: string
  role: SprintEngineRoleId
  status: string
}

/**
 * Build the per-worker implementer timeline for a task. Each hand-off to review
 * records an `implementation_summary` (first pass) or `implementation_response`
 * (rework pass) comment, so passes group by author into one row per worker.
 * The active claim (`ownerAgentId`) sorts first; remaining workers follow by
 * most-recent activity. Reassignment therefore surfaces the new owner on top
 * while each worker keeps their own tick count.
 */
export function getSprintEngineTaskImplementerTimeline(
  task: Pick<SprintEngineTask, 'comments' | 'ownerAgentId' | 'lastImplementedByAgentId' | 'role'>,
  runtimeAgents: readonly SprintEngineImplementerRuntimeAgent[],
): SprintEngineTaskImplementerEntry[] {
  const runtimeById = new Map(runtimeAgents.map((agent) => [agent.agentId, agent]))
  const ownerId = task.ownerAgentId ?? null

  type Accumulator = {
    agentId: string
    passCount: number
    lastActivityAt: string | null
    role: SprintEngineRoleId | null
  }
  const byAgent = new Map<string, Accumulator>()

  const comments = Array.isArray(task.comments) ? task.comments : []
  for (const comment of comments) {
    if (comment.type !== 'implementation_summary' && comment.type !== 'implementation_response') {
      continue
    }
    const agentId = (comment.authorAgentId ?? comment.actor ?? '').trim()
    if (!agentId) continue
    const entry = byAgent.get(agentId) ?? {
      agentId,
      passCount: 0,
      lastActivityAt: null,
      role: normalizeSprintEngineRoleId(comment.authorRole) ?? null,
    }
    entry.passCount += 1
    const createdAt = (comment.createdAt ?? '').trim()
    if (createdAt && (!entry.lastActivityAt || createdAt > entry.lastActivityAt)) {
      entry.lastActivityAt = createdAt
    }
    if (!entry.role) entry.role = normalizeSprintEngineRoleId(comment.authorRole) ?? null
    byAgent.set(agentId, entry)
  }

  // Ensure the active owner appears even before they publish their first pass,
  // and guard against trimmed comments by seeding the recorded last implementer.
  for (const seedId of [ownerId, task.lastImplementedByAgentId ?? null]) {
    if (seedId && !byAgent.has(seedId)) {
      byAgent.set(seedId, { agentId: seedId, passCount: 0, lastActivityAt: null, role: null })
    }
  }

  const entries: SprintEngineTaskImplementerEntry[] = Array.from(byAgent.values()).map((acc) => {
    const runtime = runtimeById.get(acc.agentId)
    const isActive = acc.agentId === ownerId
    return {
      agentId: acc.agentId,
      label: runtime?.label ?? acc.agentId,
      role: acc.role ?? runtime?.role ?? task.role ?? null,
      passCount: acc.passCount,
      lastActivityAt: acc.lastActivityAt,
      isActive,
      runtimeStatus: isActive ? runtime?.status ?? null : null,
    }
  })

  entries.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1
    const aTime = a.lastActivityAt ?? ''
    const bTime = b.lastActivityAt ?? ''
    if (aTime !== bTime) return aTime > bTime ? -1 : 1
    return a.label.localeCompare(b.label)
  })

  return entries
}

/**
 * Per-column empty-state copy for the kanban layout. Each column maps to a
 * single sentence; the board panel renders the result as the column's empty
 * placeholder line.
 */
export function getSprintEngineKanbanEmptyMessage(column: SprintEngineTaskBoardColumn): string {
  switch (column) {
    case 'ready':
      return 'No ready work. Waiting on dependencies or active workers.'
    case 'changes_requested':
      return 'No rework queued from reviewers or testers.'
    case 'in_progress':
      return 'No workers are actively claiming tasks.'
    case 'review':
      return 'No tasks awaiting review gates.'
    case 'testing':
      return 'No tasks awaiting test verification.'
    case 'product':
      return 'No tasks awaiting product acceptance.'
    case 'needs_input':
      return 'No blocked tasks or worker questions.'
    case 'done':
      return 'Completed work will collect here.'
    default:
      return 'Planned tasks that are waiting on dependencies appear here.'
  }
}

/**
 * Wrap text in xterm bracketed-paste markers so multi-line agent prompts are
 * pasted as a single block when written to a live terminal session.
 */
export function bracketedTerminalPaste(text: string): string {
  return `\x1b[200~${text.replace(/\r?\n/g, '\n')}\x1b[201~\r`
}

function normalizeComparableArtifactPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized
}

/**
 * True when `targetPath` equals `parentDir` or is nested under it, after
 * normalizing slashes and Windows drive-letter casing. Path containment check
 * used by the artifact path resolver.
 */
export function isPathInsideOrEqual(parentDir: string, targetPath: string): boolean {
  const parent = normalizeComparableArtifactPath(parentDir)
  const target = normalizeComparableArtifactPath(targetPath)
  return target === parent || target.startsWith(`${parent}/`)
}

/**
 * Resolve a Sprint Engine artifact path (as written into the projection) to an
 * absolute file path safe to open in the editor. Rejects remote URLs,
 * parent-relative traversal, and paths that resolve outside the Sprint Engine
 * team directory. The {@link parentPath} and {@link joinFilePath} helpers are
 * passed in so this util stays decoupled from any specific filesystem adapter.
 */
export function resolveSprintEngineArtifactEditorPath(
  statePath: string,
  artifactPathInput: string,
  helpers: {
    parentPath: (path: string) => string
    joinFilePath: (a: string, b: string) => string
    isAbsoluteFilePath: (path: string) => boolean
  },
): string {
  const { parentPath, joinFilePath, isAbsoluteFilePath } = helpers
  const artifactPath = artifactPathInput.trim()
  if (!artifactPath) throw new Error('Artifact path is required.')
  if (/^https?:\/\//i.test(artifactPath)) {
    throw new Error('Remote artifact links cannot be opened in the editor.')
  }
  if (artifactPath.split(/[\\/]+/).includes('..')) {
    throw new Error('Artifact path must stay inside the Sprint Engine team directory.')
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/i.test(artifactPath) && !isAbsoluteFilePath(artifactPath)) {
    throw new Error('Only workspace artifact file paths can be opened.')
  }

  const teamDirectory = parentPath(statePath)
  const workspaceRoot = parentPath(parentPath(parentPath(teamDirectory)))
  const targetPath = isAbsoluteFilePath(artifactPath)
    ? artifactPath
    : [
        joinFilePath(workspaceRoot, artifactPath),
        joinFilePath(teamDirectory, artifactPath),
      ].find((candidate) => isPathInsideOrEqual(teamDirectory, candidate))
      ?? joinFilePath(workspaceRoot, artifactPath)

  if (!isPathInsideOrEqual(teamDirectory, targetPath)) {
    throw new Error('Artifact path must stay inside the Sprint Engine team directory.')
  }

  return targetPath
}
