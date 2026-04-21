import type {
  AgentId,
  SwarmMockConfig,
  SwarmRole,
  SwarmRoleCounts,
  SwarmRuntimeAgent,
  SwarmSkillMap,
  SwarmTaskBoardColumn,
  SwarmTaskEvidence,
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
  frontend: 'Frontend Designer',
  tester: 'Tester',
  security: 'Security Specialist',
}

export const swarmRoleAccent: Record<SwarmRole, string> = {
  architect: '#d4a757',
  product: '#e879a7',
  developer: '#c7ccd4',
  frontend: '#39d7ff',
  tester: '#3dff8f',
  security: '#ff6b6b',
}

export const swarmRoleOrder: SwarmRole[] = [
  'architect',
  'product',
  'frontend',
  'developer',
  'tester',
  'security',
]

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
  )
}

export function createDefaultSwarmRoleCounts(): SwarmRoleCounts {
  return { architect: 1, product: 0, developer: 1, frontend: 0, tester: 0, security: 0 }
}

export function createDefaultSwarmSkills(): SwarmSkillMap {
  return {
    architect: ['Deep repo analysis', 'Planning', 'Task decomposition', 'Dependency mapping'],
    product: ['Market research', 'Competitor analysis', 'Audience fit', 'Product positioning'],
    developer: ['Implementation', 'Refactoring', 'Integration work', 'Testing'],
    frontend: ['Interface design', 'Interaction design', 'Responsive layouts', 'UI implementation'],
    tester: ['Regression checks', 'Acceptance review', 'Validation'],
    security: ['Threat modeling', 'Security review', 'Hardening', 'Abuse-case analysis'],
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
    product: Math.max(0, roleCounts?.product ?? 0),
    developer: Math.max(0, roleCounts?.developer ?? 1),
    frontend: Math.max(0, roleCounts?.frontend ?? 0),
    tester: Math.max(0, roleCounts?.tester ?? 0),
    security: Math.max(0, roleCounts?.security ?? 0),
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
  const roleTotals: Record<SwarmRole, number> = { architect: 0, product: 0, developer: 0, frontend: 0, tester: 0, security: 0 }
  for (const agent of Object.values(swarmAgents)) {
    if (isSwarmRole(agent?.role)) roleTotals[agent.role] += 1
  }

  const seenByRole: Record<SwarmRole, number> = { architect: 0, product: 0, developer: 0, frontend: 0, tester: 0, security: 0 }

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
    planApproved: false,
    planReady: false,
    planReadyAt: null,
    planReadyBy: null,
    taskGraphReplacedAt: null,
    taskValidation: null,
    events: [],
    tasks: [],
  }
}

export function getSwarmTaskBoardColumn(
  task: SwarmTask,
  tasks: SwarmTask[],
  planApproved: boolean
): SwarmTaskBoardColumn {
  if (task.status === 'in_progress' || task.status === 'needs_input' || task.status === 'done') {
    return task.status
  }
  if (!planApproved) return 'todo'
  const dependenciesDone = task.dependsOn.every((depId) =>
    tasks.some((t) => t.id === depId && t.status === 'done')
  )
  return dependenciesDone ? 'ready' : 'todo'
}

export function normalizeSwarmState(input: SwarmState | null | undefined): SwarmState | null {
  if (!input) return null

  const tasks = (Array.isArray(input.tasks) ? input.tasks : []).map((task, index) => ({
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
    notes: Array.isArray(task.notes) ? task.notes : [],
    startedAt: task.startedAt ?? null,
    completedAt: task.completedAt ?? null,
  }))

  const roleCounts = normalizeSwarmRoleCounts(input.roleCounts)

  return {
    name: input.name?.trim() || 'Swarm Team',
    goal: input.goal ?? '',
    roleCounts,
    swarmAgents: input.swarmAgents && Object.keys(input.swarmAgents).length > 0
      ? input.swarmAgents
      : Object.fromEntries(buildSwarmAgentRoster(roleCounts).map((a) => [a.id, { role: a.role, status: 'idle' as const, currentTaskId: null }])),
    planApproved: input.planApproved ?? false,
    planReady: input.planReady ?? false,
    planReadyAt: input.planReadyAt ?? null,
    planReadyBy: input.planReadyBy ?? null,
    taskGraphReplacedAt: input.taskGraphReplacedAt ?? null,
    taskValidation: input.taskValidation ?? null,
    events: input.events ?? [],
    tasks,
  }
}
