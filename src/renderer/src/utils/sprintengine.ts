import type {
  AgentId,
  SprintEngineArtifact,
  SprintEngineArtifactKind,
  SprintEngineArtifactReviewHistoryEntry,
  SprintEngineArtifactStatus,
  SprintEngineMockConfig,
  SprintEngineRole,
  SprintEngineRoleCounts,
  SprintEngineRuntimeAgent,
  SprintEngineSkillMap,
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
  SprintEngineState,
  SprintEngineTask,
  SprintEngineTaskStatus,
} from '../types/workspace'

export type SprintEngineAgentRosterItem = {
  id: AgentId
  label: string
  role: SprintEngineRole
}

export const sprintEngineRoleLabels: Record<SprintEngineRole, string> = {
  architect: 'Architect',
  product: 'Product Strategist',
  developer: 'Developer',
  frontend: 'Frontend Engineer',
  tester: 'Tester',
  security: 'Security Specialist',
  code_reviewer: 'Code Reviewer',
  performance: 'Performance Engineer',
}

export const sprintEngineRoleAccent: Record<SprintEngineRole, string> = {
  architect: '#d4a757',
  product: '#e879a7',
  developer: '#c7ccd4',
  frontend: '#39d7ff',
  tester: '#3dff8f',
  security: '#ff6b6b',
  code_reviewer: '#f59e0b',
  performance: '#a78bfa',
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

const reviewGateArtifactKinds = new Set<SprintEngineArtifactKind>([
  'architect_plan',
  'product_strategy',
  'requirements',
  'html_mockup',
  'design_notes',
  'branding',
  'security_review',
  'code_review',
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
  return { architect: 1, product: 1, developer: 1, frontend: 0, tester: 0, security: 0, code_reviewer: 0, performance: 0 }
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
  const roleTotals: Record<SprintEngineRole, number> = { architect: 0, product: 0, developer: 0, frontend: 0, tester: 0, security: 0, code_reviewer: 0, performance: 0 }
  for (const agent of Object.values(sprintEngineAgents)) {
    if (isSprintEngineRole(agent?.role)) roleTotals[agent.role] += 1
  }

  const seenByRole: Record<SprintEngineRole, number> = { architect: 0, product: 0, developer: 0, frontend: 0, tester: 0, security: 0, code_reviewer: 0, performance: 0 }

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
  if (task.status === 'in_progress' || task.status === 'needs_input' || task.status === 'done') {
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
    return {
      id: task.id ?? `task-${index + 1}`,
      title: task.title ?? `Task ${index + 1}`,
      description: task.description ?? '',
      role: isSprintEngineRole(task.role) ? task.role : 'developer' as SprintEngineRole,
      status: (['todo', 'in_progress', 'needs_input', 'done'] as const).includes(task.status as SprintEngineTaskStatus)
        ? task.status as SprintEngineTaskStatus
        : 'todo' as const,
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
      notes: Array.isArray(task.notes) ? task.notes : [],
      startedAt: task.startedAt ?? null,
      completedAt: task.completedAt ?? null,
    }
  })

  const roleCounts = normalizeSprintEngineRoleCounts(input.roleCounts)

  return {
    name: input.name?.trim() || 'Sprint Engine Team',
    goal: input.goal ?? '',
    rosterConfigured: Boolean(input.rosterConfigured),
    ...(input.source ? { source: input.source } : {}),
    updatedAt: input.updatedAt ?? null,
    roleCounts,
    sprintEngineAgents: input.sprintEngineAgents && Object.keys(input.sprintEngineAgents).length > 0
      ? input.sprintEngineAgents
      : Object.fromEntries(buildSprintEngineAgentRoster(roleCounts).map((a) => [a.id, { role: a.role, status: 'idle' as const, currentTaskId: null }])),
    events: input.events ?? [],
    tasks,
    artifacts: normalizeSprintEngineArtifacts(input.artifacts),
  }
}
