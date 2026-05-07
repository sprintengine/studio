import type {
  AgentId,
  SwarmArtifact,
  SwarmArtifactKind,
  SwarmArtifactReviewHistoryEntry,
  SwarmArtifactStatus,
  SwarmMockConfig,
  SwarmRole,
  SwarmRoleCounts,
  SwarmRuntimeAgent,
  SwarmSkillMap,
  SwarmTaskDispatch,
  SwarmTaskDispatchMode,
  SwarmTaskDispatchStatus,
  SwarmTaskDispatchTriagedBy,
  SwarmTaskBoardColumn,
  SwarmTaskEvidence,
  SwarmTaskFeedback,
  SwarmTaskFeedbackFinding,
  SwarmTaskFeedbackFindingArea,
  SwarmTaskFeedbackFindingKind,
  SwarmTaskFeedbackFindingSeverity,
  SwarmTaskFeedbackFindingStatus,
  SwarmTaskFeedbackIssue,
  SwarmTaskFeedbackIssueCategory,
  SwarmTaskFeedbackIssueSeverity,
  SwarmTaskFeedbackIssueStatus,
  SwarmTaskSource,
  SwarmTaskSourceSyncStatus,
  SwarmTaskSourceType,
  SwarmState,
  SwarmTask,
  SwarmTaskStatus,
} from '../types/workspace'

export type SwarmAgentRosterItem = {
  id: AgentId
  label: string
  role: SwarmRole
}

export const swarmRoleLabels: Record<SwarmRole, string> = {
  architect: 'Architect',
  product: 'Product Strategist',
  developer: 'Developer',
  frontend: 'Frontend Engineer',
  tester: 'Tester',
  security: 'Security Specialist',
  code_reviewer: 'Code Reviewer',
  performance: 'Performance Engineer',
}

export const swarmRoleAccent: Record<SwarmRole, string> = {
  architect: '#d4a757',
  product: '#e879a7',
  developer: '#c7ccd4',
  frontend: '#39d7ff',
  tester: '#3dff8f',
  security: '#ff6b6b',
  code_reviewer: '#f59e0b',
  performance: '#a78bfa',
}

export const swarmArtifactKindLabels: Record<SwarmArtifactKind, string> = {
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

export const swarmArtifactStatusLabels: Record<SwarmArtifactStatus, string> = {
  draft: 'Draft',
  ready_for_review: 'Ready For Review',
  approved: 'Approved',
  changes_requested: 'Changes Requested',
  superseded: 'Superseded',
}

export const swarmRoleOrder: SwarmRole[] = [
  'architect',
  'product',
  'frontend',
  'developer',
  'code_reviewer',
  'performance',
  'tester',
  'security',
]

const swarmArtifactKinds: readonly SwarmArtifactKind[] = [
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

const swarmArtifactStatuses: readonly SwarmArtifactStatus[] = [
  'draft',
  'ready_for_review',
  'approved',
  'changes_requested',
  'superseded',
]

const feedbackIssueCategories: readonly SwarmTaskFeedbackIssueCategory[] = [
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

const feedbackIssueSeverities: readonly SwarmTaskFeedbackIssueSeverity[] = ['low', 'medium', 'high']
const feedbackIssueStatuses: readonly SwarmTaskFeedbackIssueStatus[] = ['new', 'reviewed', 'applied', 'rejected', 'deferred']
const feedbackFindingKinds: readonly SwarmTaskFeedbackFindingKind[] = [
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
const feedbackFindingSeverities: readonly SwarmTaskFeedbackFindingSeverity[] = ['critical', 'high', 'medium', 'low']
const feedbackFindingAreas: readonly SwarmTaskFeedbackFindingArea[] = [
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
const feedbackFindingStatuses: readonly SwarmTaskFeedbackFindingStatus[] = ['open', 'accepted', 'fixed', 'rejected', 'deferred']
const swarmTaskSourceTypes: readonly SwarmTaskSourceType[] = ['local', 'github', 'jira', 'linear']
const swarmTaskSourceSyncStatuses: readonly SwarmTaskSourceSyncStatus[] = ['clean', 'local_changed', 'remote_changed', 'conflict']
const swarmTaskDispatchModes: readonly SwarmTaskDispatchMode[] = ['dependency', 'manual']
const swarmTaskDispatchStatuses: readonly SwarmTaskDispatchStatus[] = ['todo', 'ready']
const swarmTaskDispatchTriagedByValues: readonly SwarmTaskDispatchTriagedBy[] = ['none', 'user', 'architect']

const reviewGateArtifactKinds = new Set<SwarmArtifactKind>([
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

export type SwarmArtifactDependencyBlocker = {
  taskId: string
  title: string
  artifacts: SwarmArtifact[]
}

export type SwarmArtifactAutoApprovalEligibility = {
  eligible: boolean
  label: string
  reason: string | null
}

function emptyEvidence(summary = ''): SwarmTaskEvidence {
  return { summary, touchedFiles: [], commandsRan: [], results: [] }
}

function isSwarmRole(value: unknown): value is SwarmRole {
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

function isSwarmArtifactKind(value: unknown): value is SwarmArtifactKind {
  return swarmArtifactKinds.includes(value as SwarmArtifactKind)
}

function isSwarmArtifactStatus(value: unknown): value is SwarmArtifactStatus {
  return swarmArtifactStatuses.includes(value as SwarmArtifactStatus)
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

function isFeedbackIssueCategory(value: unknown): value is SwarmTaskFeedbackIssueCategory {
  return feedbackIssueCategories.includes(value as SwarmTaskFeedbackIssueCategory)
}

function isFeedbackIssueSeverity(value: unknown): value is SwarmTaskFeedbackIssueSeverity {
  return feedbackIssueSeverities.includes(value as SwarmTaskFeedbackIssueSeverity)
}

function isFeedbackIssueStatus(value: unknown): value is SwarmTaskFeedbackIssueStatus {
  return feedbackIssueStatuses.includes(value as SwarmTaskFeedbackIssueStatus)
}

function isFeedbackFindingKind(value: unknown): value is SwarmTaskFeedbackFindingKind {
  return feedbackFindingKinds.includes(value as SwarmTaskFeedbackFindingKind)
}

function isFeedbackFindingSeverity(value: unknown): value is SwarmTaskFeedbackFindingSeverity {
  return feedbackFindingSeverities.includes(value as SwarmTaskFeedbackFindingSeverity)
}

function isFeedbackFindingArea(value: unknown): value is SwarmTaskFeedbackFindingArea {
  return feedbackFindingAreas.includes(value as SwarmTaskFeedbackFindingArea)
}

function isFeedbackFindingStatus(value: unknown): value is SwarmTaskFeedbackFindingStatus {
  return feedbackFindingStatuses.includes(value as SwarmTaskFeedbackFindingStatus)
}

function isSwarmTaskSourceType(value: unknown): value is SwarmTaskSourceType {
  return swarmTaskSourceTypes.includes(value as SwarmTaskSourceType)
}

function isSwarmTaskSourceSyncStatus(value: unknown): value is SwarmTaskSourceSyncStatus {
  return swarmTaskSourceSyncStatuses.includes(value as SwarmTaskSourceSyncStatus)
}

function isSwarmTaskDispatchMode(value: unknown): value is SwarmTaskDispatchMode {
  return swarmTaskDispatchModes.includes(value as SwarmTaskDispatchMode)
}

function isSwarmTaskDispatchStatus(value: unknown): value is SwarmTaskDispatchStatus {
  return swarmTaskDispatchStatuses.includes(value as SwarmTaskDispatchStatus)
}

function isSwarmTaskDispatchTriagedBy(value: unknown): value is SwarmTaskDispatchTriagedBy {
  return swarmTaskDispatchTriagedByValues.includes(value as SwarmTaskDispatchTriagedBy)
}

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeSwarmTaskSource(value: unknown): SwarmTaskSource | undefined {
  if (!value || typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>
  if (!isSwarmTaskSourceType(record.type)) return undefined

  const externalId = optionalTrimmedString(record.externalId)
  const externalUrl = optionalTrimmedString(record.externalUrl)
  const repo = optionalTrimmedString(record.repo)
  const title = optionalTrimmedString(record.title)
  const externalUpdatedAt = optionalTrimmedString(record.externalUpdatedAt)
  const syncedAt = optionalTrimmedString(record.syncedAt)
  const syncStatus = isSwarmTaskSourceSyncStatus(record.syncStatus) ? record.syncStatus : undefined

  return {
    type: record.type,
    ...(externalId ? { externalId } : {}),
    ...(externalUrl ? { externalUrl } : {}),
    ...(repo ? { repo } : {}),
    ...(title ? { title } : {}),
    ...(externalUpdatedAt ? { externalUpdatedAt } : {}),
    ...(syncedAt ? { syncedAt } : {}),
    ...(syncStatus ? { syncStatus } : {}),
  }
}

function normalizeSwarmTaskDispatch(value: unknown): SwarmTaskDispatch | undefined {
  if (!value || typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>
  if (!isSwarmTaskDispatchMode(record.mode)) return undefined

  const status = isSwarmTaskDispatchStatus(record.status) ? record.status : undefined
  const triagedBy = isSwarmTaskDispatchTriagedBy(record.triagedBy) ? record.triagedBy : undefined
  const readyAt = optionalTrimmedString(record.readyAt)

  return {
    mode: record.mode,
    ...(status ? { status } : {}),
    ...(triagedBy ? { triagedBy } : {}),
    ...(readyAt ? { readyAt } : {}),
  }
}

function normalizeSwarmTaskFeedbackIssues(value: unknown): SwarmTaskFeedbackIssue[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((issue, index): SwarmTaskFeedbackIssue[] => {
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

function normalizeSwarmTaskFeedbackFindings(value: unknown): SwarmTaskFeedbackFinding[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((finding, index): SwarmTaskFeedbackFinding[] => {
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

function normalizeSwarmTaskFeedback(value: unknown): SwarmTaskFeedback | undefined {
  if (!value || typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>
  const scoresRecord = record.scores && typeof record.scores === 'object'
    ? record.scores as Record<string, unknown>
    : {}
  const scores = {
    directiveClarityPct: percentOrUndefined(scoresRecord.directiveClarityPct),
    taskClarityPct: percentOrUndefined(scoresRecord.taskClarityPct),
    acceptanceCriteriaClarityPct: percentOrUndefined(scoresRecord.acceptanceCriteriaClarityPct),
    swarmToolEffectivenessPct: percentOrUndefined(scoresRecord.swarmToolEffectivenessPct),
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
  const issues = normalizeSwarmTaskFeedbackIssues(record.issues)
  const findings = normalizeSwarmTaskFeedbackFindings(record.findings)

  if (
    typeof record.schemaVersion !== 'number'
    || typeof record.capturedAt !== 'string'
    || typeof record.source !== 'string'
    || typeof record.agentId !== 'string'
    || !isSwarmRole(record.role)
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

function normalizeSwarmArtifactReviewHistory(value: unknown): SwarmArtifactReviewHistoryEntry[] {
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

function normalizeSwarmArtifacts(value: unknown): SwarmArtifact[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((artifact, index) => {
    if (!artifact || typeof artifact !== 'object') return []
    const record = artifact as Record<string, unknown>
    if (
      typeof record.id !== 'string'
      || !isSwarmArtifactKind(record.kind)
      || !isSwarmArtifactStatus(record.status)
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
      reviewHistory: normalizeSwarmArtifactReviewHistory(record.reviewHistory),
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

export function createDefaultSwarmRoleCounts(): SwarmRoleCounts {
  return { architect: 1, product: 1, developer: 1, frontend: 0, tester: 0, security: 0, code_reviewer: 0, performance: 0 }
}

export function createDefaultSwarmSkills(): SwarmSkillMap {
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

export function countSwarmAgents(roleCounts: SwarmRoleCounts): number {
  return Object.values(roleCounts).reduce((total, count) => total + Math.max(0, count), 0)
}

export function normalizeSwarmRoleCounts(
  roleCounts?: Partial<SwarmRoleCounts> | null
): SwarmRoleCounts {
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

function roleAgentIndex(agentId: string, role: SwarmRole): number {
  const base = role
  if (agentId === base) return 1
  const match = agentId.match(new RegExp(`^${base}-(\\d+)$`))
  if (!match) return Number.MAX_SAFE_INTEGER
  return Number(match[1])
}

export function getNextSwarmAgentId(
  role: SwarmRole,
  swarmAgents: Record<AgentId, SwarmRuntimeAgent>
): AgentId {
  const usedIds = new Set(Object.keys(swarmAgents))
  if (!usedIds.has(role) && role !== 'developer') return role

  let nextIndex = 1
  for (const [agentId, agent] of Object.entries(swarmAgents)) {
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

export function buildSwarmAgentRoster(roleCounts: SwarmRoleCounts): SwarmAgentRosterItem[] {
  const roster: SwarmAgentRosterItem[] = []

  for (const role of swarmRoleOrder) {
    const count = Math.max(role === 'architect' ? 1 : 0, roleCounts[role])
    for (let i = 0; i < count; i++) {
      const id = count > 1 || role === 'developer' ? `${role}-${i + 1}` : role
      const suffix = count > 1 ? ` ${i + 1}` : ''
      roster.push({ id, label: `${swarmRoleLabels[role]}${suffix}`, role })
    }
  }

  return roster
}

export function buildSwarmAgentRosterFromRuntimeAgents(
  swarmAgents: Record<AgentId, SwarmRuntimeAgent>
): SwarmAgentRosterItem[] {
  const roleTotals: Record<SwarmRole, number> = { architect: 0, product: 0, developer: 0, frontend: 0, tester: 0, security: 0, code_reviewer: 0, performance: 0 }
  for (const agent of Object.values(swarmAgents)) {
    if (isSwarmRole(agent?.role)) roleTotals[agent.role] += 1
  }

  const seenByRole: Record<SwarmRole, number> = { architect: 0, product: 0, developer: 0, frontend: 0, tester: 0, security: 0, code_reviewer: 0, performance: 0 }

  return Object.entries(swarmAgents)
    .filter((entry): entry is [AgentId, SwarmRuntimeAgent] => isSwarmRole(entry[1]?.role))
    .sort(([aId, a], [bId, b]) => {
      const roleDelta = swarmRoleOrder.indexOf(a.role) - swarmRoleOrder.indexOf(b.role)
      return roleDelta !== 0 ? roleDelta : roleAgentIndex(aId, a.role) - roleAgentIndex(bId, b.role)
    })
    .map(([id, agent]) => {
      seenByRole[agent.role] += 1
      const suffix = roleTotals[agent.role] > 1 ? ` ${seenByRole[agent.role]}` : ''
      return { id, label: `${swarmRoleLabels[agent.role]}${suffix}`, role: agent.role }
    })
}

export function buildSwarmAgentRosterForState(
  swarmState: Pick<SwarmState, 'roleCounts' | 'swarmAgents'> | null | undefined
): SwarmAgentRosterItem[] {
  if (swarmState?.swarmAgents && Object.keys(swarmState.swarmAgents).length > 0) {
    return buildSwarmAgentRosterFromRuntimeAgents(swarmState.swarmAgents)
  }
  return buildSwarmAgentRoster(swarmState?.roleCounts ?? createDefaultSwarmRoleCounts())
}

export function buildSwarmRosterCommandArgs(
  swarmState: Pick<SwarmState, 'roleCounts' | 'swarmAgents' | 'rosterConfigured'> | SwarmRoleCounts | null | undefined
): string[] {
  if (swarmState && 'roleCounts' in swarmState && !swarmState.rosterConfigured) return []
  const roster = swarmState && 'roleCounts' in swarmState
    ? buildSwarmAgentRosterForState(swarmState)
    : buildSwarmAgentRoster(normalizeSwarmRoleCounts(swarmState as Partial<SwarmRoleCounts> | null | undefined))
  return roster.map((agent) => `${agent.role}:${agent.id}`)
}

export function createInitialSwarmState(config: SwarmMockConfig): SwarmState {
  const roleCounts = normalizeSwarmRoleCounts(config.roleCounts)
  const roster = buildSwarmAgentRoster(roleCounts)
  return {
    name: config.name?.trim() || 'Sprint Engine Team',
    goal: config.goal,
    rosterConfigured: true,
    roleCounts,
    swarmAgents: Object.fromEntries(
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

export function getSwarmTaskBoardColumn(
  task: SwarmTask,
  tasks: SwarmTask[]
): SwarmTaskBoardColumn {
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

export function getSwarmTaskSourceType(task: Pick<SwarmTask, 'source'>): SwarmTaskSourceType {
  return task.source?.type ?? 'local'
}

export function getReviewableSwarmArtifacts(artifacts: SwarmArtifact[]): SwarmArtifact[] {
  return artifacts.filter((artifact) =>
    reviewGateArtifactKinds.has(artifact.kind) && artifact.status !== 'superseded'
  )
}

export function isSwarmArtifactAutoApprovableKind(kind: SwarmArtifactKind): boolean {
  return reviewGateArtifactKinds.has(kind)
}

export function getSwarmArtifactAutoApprovalEligibility(
  artifact: SwarmArtifact
): SwarmArtifactAutoApprovalEligibility {
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

  if (isSwarmArtifactAutoApprovableKind(artifact.kind)) {
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

export function getAutoApprovableReadySwarmArtifacts(
  swarmState: Pick<SwarmState, 'tasks' | 'artifacts'>
): SwarmArtifact[] {
  const reviewArtifacts = getReviewableSwarmArtifacts(swarmState.artifacts)
  const reviewArtifactsByTaskId = getSwarmArtifactsByTaskId(reviewArtifacts)
  const tasksById = new Map(swarmState.tasks.map((task) => [task.id, task]))

  return reviewArtifacts.filter((artifact) => {
    if (!getSwarmArtifactAutoApprovalEligibility(artifact).eligible) return false

    const task = tasksById.get(artifact.taskId)
    if (!task || task.status !== 'needs_input') return false

    const blockingArtifacts = (reviewArtifactsByTaskId[task.id] ?? []).filter((candidate) =>
      candidate.status !== 'approved' && candidate.status !== 'superseded'
    )
    if (blockingArtifacts.length === 0) return false

    return blockingArtifacts.every((candidate) =>
      getSwarmArtifactAutoApprovalEligibility(candidate).eligible
    )
  })
}

export function getSwarmArtifactsByTaskId(
  artifacts: SwarmArtifact[]
): Record<string, SwarmArtifact[]> {
  return artifacts.reduce<Record<string, SwarmArtifact[]>>((byTaskId, artifact) => {
    if (!artifact.taskId) return byTaskId
    byTaskId[artifact.taskId] = [...(byTaskId[artifact.taskId] ?? []), artifact]
    return byTaskId
  }, {})
}

export function getSwarmArtifactDependencyBlockers(
  task: SwarmTask,
  tasks: SwarmTask[],
  artifacts: SwarmArtifact[]
): SwarmArtifactDependencyBlocker[] {
  const artifactsByTaskId = getSwarmArtifactsByTaskId(getReviewableSwarmArtifacts(artifacts))
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

export function normalizeSwarmState(input: SwarmState | null | undefined): SwarmState | null {
  if (!input) return null

  const tasks = (Array.isArray(input.tasks) ? input.tasks : []).map((task, index) => {
    const feedback = normalizeSwarmTaskFeedback(task.feedback)
    const source = normalizeSwarmTaskSource(task.source)
    const dispatch = normalizeSwarmTaskDispatch(task.dispatch)
    return {
      id: task.id ?? `task-${index + 1}`,
      title: task.title ?? `Task ${index + 1}`,
      description: task.description ?? '',
      role: isSwarmRole(task.role) ? task.role : 'developer' as SwarmRole,
      status: (['todo', 'in_progress', 'needs_input', 'done'] as const).includes(task.status as SwarmTaskStatus)
        ? task.status as SwarmTaskStatus
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
      notes: Array.isArray(task.notes) ? task.notes : [],
      startedAt: task.startedAt ?? null,
      completedAt: task.completedAt ?? null,
    }
  })

  const roleCounts = normalizeSwarmRoleCounts(input.roleCounts)

  return {
    name: input.name?.trim() || 'Sprint Engine Team',
    goal: input.goal ?? '',
    rosterConfigured: Boolean(input.rosterConfigured),
    ...(input.source ? { source: input.source } : {}),
    updatedAt: input.updatedAt ?? null,
    roleCounts,
    swarmAgents: input.swarmAgents && Object.keys(input.swarmAgents).length > 0
      ? input.swarmAgents
      : Object.fromEntries(buildSwarmAgentRoster(roleCounts).map((a) => [a.id, { role: a.role, status: 'idle' as const, currentTaskId: null }])),
    events: input.events ?? [],
    tasks,
    artifacts: normalizeSwarmArtifacts(input.artifacts),
  }
}
