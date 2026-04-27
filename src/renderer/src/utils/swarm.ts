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
  SwarmTaskBoardColumn,
  SwarmTaskEvidence,
  SwarmTaskFeedback,
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
}

export const swarmRoleAccent: Record<SwarmRole, string> = {
  architect: '#d4a757',
  product: '#e879a7',
  developer: '#c7ccd4',
  frontend: '#39d7ff',
  tester: '#3dff8f',
  security: '#ff6b6b',
  code_reviewer: '#f59e0b',
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
  'validation_report',
]

const swarmArtifactStatuses: readonly SwarmArtifactStatus[] = [
  'draft',
  'ready_for_review',
  'approved',
  'changes_requested',
  'superseded',
]

const reviewGateArtifactKinds = new Set<SwarmArtifactKind>([
  'architect_plan',
  'product_strategy',
  'requirements',
  'html_mockup',
  'design_notes',
  'branding',
  'security_review',
  'code_review',
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

  if (
    typeof record.schemaVersion !== 'number'
    || typeof record.capturedAt !== 'string'
    || typeof record.source !== 'string'
    || typeof record.agentId !== 'string'
    || !isSwarmRole(record.role)
    || (!hasScore && !topFriction && !suggestedImprovement)
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
  return { architect: 1, product: 1, developer: 1, frontend: 0, tester: 0, security: 0, code_reviewer: 0 }
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
  const roleTotals: Record<SwarmRole, number> = { architect: 0, product: 0, developer: 0, frontend: 0, tester: 0, security: 0, code_reviewer: 0 }
  for (const agent of Object.values(swarmAgents)) {
    if (isSwarmRole(agent?.role)) roleTotals[agent.role] += 1
  }

  const seenByRole: Record<SwarmRole, number> = { architect: 0, product: 0, developer: 0, frontend: 0, tester: 0, security: 0, code_reviewer: 0 }

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

export function createInitialSwarmState(config: SwarmMockConfig): SwarmState {
  const roleCounts = normalizeSwarmRoleCounts(config.roleCounts)
  const roster = buildSwarmAgentRoster(roleCounts)
  return {
    name: config.name?.trim() || 'Swarm Team',
    goal: config.goal,
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
  return dependenciesDone ? 'ready' : 'todo'
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
    return {
      id: task.id ?? `task-${index + 1}`,
      title: task.title ?? `Task ${index + 1}`,
      description: task.description ?? '',
      role: isSwarmRole(task.role) ? task.role : 'developer' as SwarmRole,
      status: (['todo', 'in_progress', 'needs_input', 'done'] as const).includes(task.status as SwarmTaskStatus)
        ? task.status as SwarmTaskStatus
        : 'todo' as const,
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
    name: input.name?.trim() || 'Swarm Team',
    goal: input.goal ?? '',
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
