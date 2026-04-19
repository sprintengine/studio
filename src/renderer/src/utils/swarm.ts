import type {
  AgentId,
  SwarmMockConfig,
  SwarmRole,
  SwarmRoleCounts,
  SwarmRuntimeAgent,
  SwarmTaskBoardColumn,
  SwarmTaskEvidence,
  SwarmPromptMap,
  SwarmSkillMap,
  SwarmState,
  SwarmTask,
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

export const swarmTeamPresets: Array<{
  id: 'small' | 'medium' | 'large'
  name: string
  description: string
  roleCounts: SwarmRoleCounts
}> = [
  {
    id: 'small',
    name: 'Small Team',
    description: 'Architect, product strategist, frontend designer, and developer.',
    roleCounts: { architect: 1, product: 1, developer: 1, frontend: 1, tester: 0, security: 0 },
  },
  {
    id: 'medium',
    name: 'Medium Team',
    description: 'Product guidance, frontend work, two developers, and testing.',
    roleCounts: { architect: 1, product: 1, developer: 2, frontend: 1, tester: 1, security: 0 },
  },
  {
    id: 'large',
    name: 'Large Team',
    description: 'Full product, build, validation, and security coverage.',
    roleCounts: { architect: 1, product: 1, developer: 4, frontend: 1, tester: 1, security: 1 },
  },
]

const now = () => Date.now()

function emptyEvidence(summary = ''): SwarmTaskEvidence {
  return {
    summary,
    touchedFiles: [],
    commandsRan: [],
    results: [],
  }
}

function roleFromOwner(owner: string | undefined): SwarmRole {
  if (owner === 'architect') return 'architect'
  if (owner === 'product') return 'product'
  if (owner === 'frontend') return 'frontend'
  if (owner === 'tester') return 'tester'
  if (owner === 'security') return 'security'
  return 'developer'
}

function normalizeLegacyStatus(status: string | undefined): SwarmTask['status'] {
  switch (status) {
    case 'done':
      return 'done'
    case 'in_progress':
    case 'review':
    case 'testing':
      return 'in_progress'
    case 'needs_input':
      return 'needs_input'
    default:
      return 'todo'
  }
}

function createTask(task: Partial<SwarmTask> & Pick<SwarmTask, 'id' | 'title' | 'description' | 'role'>): SwarmTask {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    role: task.role,
    status: task.status ?? 'todo',
    ownerAgentId: task.ownerAgentId ?? null,
    dependsOn: task.dependsOn ?? [],
    ownedPaths: task.ownedPaths ?? [],
    acceptanceCriteria: task.acceptanceCriteria ?? [],
    implementationNotes: task.implementationNotes ?? [],
    evidence: task.evidence ?? emptyEvidence(),
    questionsForUser: task.questionsForUser ?? [],
    notes: task.notes ?? [],
    artifacts: task.artifacts ?? [],
    startedAt: task.startedAt ?? null,
    completedAt: task.completedAt ?? null,
  }
}

export function createEmptySwarmSkills(): SwarmSkillMap {
  return {
    architect: [],
    product: [],
    developer: [],
    frontend: [],
    tester: [],
    security: [],
  }
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

export function createDefaultSwarmRolePrompts(): SwarmPromptMap {
  return {
    architect: [
      'Own discovery, architecture, task decomposition, and final plan readiness.',
      'Consult specialists early when product, interface, security, testing, or implementation judgment could change the plan.',
      'Do not unlock execution until the plan, task graph, dependencies, and acceptance criteria are coherent.',
    ].join('\n'),
    product: [
      'Pressure-test the goal against user intent, competitor expectations, workflow fit, and adoption risk.',
      'Turn ambiguous user language into clear product priorities, tradeoffs, and acceptance criteria.',
      'Keep recommendations practical enough for the architect to convert into concrete tasks.',
    ].join('\n'),
    developer: [
      'Implement production code inside the assigned task scope with minimal unrelated churn.',
      'Respect existing architecture, verify behavior with focused tests or checks, and publish clear evidence.',
      'Raise blockers through the swarm tool instead of guessing across ownership boundaries.',
    ].join('\n'),
    frontend: [
      'Own visual hierarchy, interaction design, responsiveness, accessibility, and UI implementation quality.',
      'Prefer dense, calm interfaces with clear affordances, stable spacing, and consistent type/color systems.',
      'Validate that important controls fit without overlap across practical desktop and mobile widths.',
    ].join('\n'),
    tester: [
      'Probe the plan and implementation for regressions, missing acceptance criteria, and validation gaps.',
      'Run or specify the highest-signal checks available for the changed surface.',
      'Report failures with reproduction steps and enough context for the owner to fix them quickly.',
    ].join('\n'),
    security: [
      'Review data flow, permissions, command execution, secrets handling, and abuse cases.',
      'Call out risky defaults, unsafe trust boundaries, and gaps in validation or user consent.',
      'Recommend focused hardening work that fits the actual threat model.',
    ].join('\n'),
  }
}

export function createDefaultSwarmRoleCounts(): SwarmRoleCounts {
  return { architect: 1, product: 1, developer: 1, frontend: 1, tester: 0, security: 0 }
}

export function buildInitialSwarmAgents(roleCounts: SwarmRoleCounts): Record<AgentId, SwarmRuntimeAgent> {
  return Object.fromEntries(
    buildSwarmAgentRoster(roleCounts).map((agent) => [
      agent.id,
      {
        role: agent.role,
        status: agent.role === 'architect' ? 'planning' : 'idle',
        currentTaskId: null,
      },
    ])
  )
}

export function countSwarmAgents(roleCounts: SwarmRoleCounts): number {
  return Object.values(roleCounts).reduce((total, count) => total + Math.max(0, count), 0)
}

export function normalizeSwarmRoleCounts(
  roleCounts?: Partial<SwarmRoleCounts> | null,
  fallbackAgentCount?: number
): SwarmRoleCounts {
  if (roleCounts) {
    return {
      architect: Math.max(0, roleCounts.architect ?? 0),
      product: Math.max(0, roleCounts.product ?? 0),
      developer: Math.max(0, roleCounts.developer ?? 0),
      frontend: Math.max(0, roleCounts.frontend ?? 0),
      tester: Math.max(0, roleCounts.tester ?? 0),
      security: Math.max(0, roleCounts.security ?? 0),
    }
  }

  const count = Math.max(1, fallbackAgentCount ?? 3)
  return {
    architect: 1,
    product: count >= 4 ? 1 : 0,
    developer: count >= 2 ? Math.max(1, count - (count >= 3 ? 2 : 1) - (count >= 4 ? 2 : 0)) : 0,
    frontend: count >= 3 ? 1 : 0,
    tester: count >= 5 ? 1 : 0,
    security: 0,
  }
}

export function buildSwarmAgentRoster(input: number | SwarmRoleCounts): SwarmAgentRosterItem[] {
  const roleCounts = typeof input === 'number' ? normalizeSwarmRoleCounts(null, input) : input
  const roster: SwarmAgentRosterItem[] = []

  const pushRole = (role: SwarmRole, label: string, count: number) => {
    for (let index = 0; index < count; index += 1) {
      const suffix = count > 1 ? ` ${index + 1}` : ''
      const idBase =
        role === 'architect'
          ? 'architect'
          : role === 'product'
            ? 'product'
          : role === 'frontend'
            ? 'frontend'
          : role === 'tester'
              ? 'tester'
              : role === 'security'
                ? 'security'
                : 'developer'

      roster.push({
        id: count > 1 || role === 'developer' ? `${idBase}-${index + 1}` : idBase,
        label: `${label}${suffix}`,
        role,
      })
    }
  }

  pushRole('architect', 'Architect', Math.max(1, roleCounts.architect))
  pushRole('product', 'Product Strategist', roleCounts.product)
  pushRole('frontend', 'Frontend Designer', roleCounts.frontend)
  pushRole('developer', 'Developer', roleCounts.developer)
  pushRole('tester', 'Tester', roleCounts.tester)
  pushRole('security', 'Security Specialist', roleCounts.security)

  return roster
}

export function buildInitialSwarmTasks(config: SwarmMockConfig): SwarmTask[] {
  void config
  return []
}

export function createInitialSwarmState(config: SwarmMockConfig): SwarmState {
  const roleCounts = normalizeSwarmRoleCounts(config.roleCounts, config.agentCount)
  return {
    name: config.name?.trim() || 'Swarm Team',
    goal: config.goal,
    agentCount: countSwarmAgents(roleCounts),
    roleCounts,
    skills: {
      ...createDefaultSwarmSkills(),
      ...config.skills,
    },
    rolePrompts: {
      ...createDefaultSwarmRolePrompts(),
      ...config.rolePrompts,
    },
    swarmAgents: buildInitialSwarmAgents(roleCounts),
    phase: 'awaiting_approval',
    planApproved: false,
    planReady: false,
    planReadyAt: null,
    planReadyBy: null,
    taskGraphReplacedAt: null,
    taskValidation: null,
    artifacts: [
      {
        id: 'ART-PLAN-001',
        type: 'plan',
        title: 'Initial architect plan',
        path: 'swarm/plan.md',
      },
    ],
    events: [
      {
        id: 'EVT-001',
        timestamp: now(),
        type: 'swarm_created',
        actor: 'architect',
        message: 'Swarm workspace created and awaiting architect planning approval.',
      },
    ],
    tasks: buildInitialSwarmTasks(config),
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

  const dependenciesDone = task.dependsOn.every((dependencyId) =>
    tasks.some((candidate) => candidate.id === dependencyId && candidate.status === 'done')
  )

  return dependenciesDone ? 'ready' : 'todo'
}

export function normalizeSwarmState(input: SwarmState | null | undefined): SwarmState | null {
  if (!input) return null

  const tasks = Array.isArray(input.tasks) ? input.tasks : []
  const normalizedTasks = tasks.map((task, index) => {
    const legacyTask = task as Omit<Partial<SwarmTask>, 'notes'> & {
      owner?: string
      details?: string[]
      files?: string[]
      priority?: number
      notes?: string[] | string
    }
    const status = normalizeLegacyStatus(legacyTask.status)
    const ownerAgentId =
      legacyTask.ownerAgentId ?? (status === 'todo' ? null : legacyTask.owner ?? null)
    const notes = Array.isArray(legacyTask.notes)
      ? legacyTask.notes
      : typeof legacyTask.notes === 'string' && legacyTask.notes.length > 0
        ? [legacyTask.notes]
        : []

    return createTask({
      id: legacyTask.id ?? `task-${index + 1}`,
      title: legacyTask.title ?? `Swarm Task ${index + 1}`,
      description: legacyTask.description ?? '',
      role: legacyTask.role ?? roleFromOwner(legacyTask.ownerAgentId ?? legacyTask.owner),
      status,
      ownerAgentId,
      dependsOn: legacyTask.dependsOn ?? [],
      ownedPaths: legacyTask.ownedPaths ?? legacyTask.files ?? [],
      acceptanceCriteria: legacyTask.acceptanceCriteria ?? legacyTask.details ?? [],
      implementationNotes: legacyTask.implementationNotes ?? [],
      evidence: legacyTask.evidence ?? emptyEvidence(),
      questionsForUser: legacyTask.questionsForUser ?? [],
      notes,
      artifacts: legacyTask.artifacts ?? [],
      startedAt: legacyTask.startedAt ?? null,
      completedAt: legacyTask.completedAt ?? null,
    })
  })

  return {
    name: input.name?.trim() || 'Swarm Team',
    goal: input.goal,
    agentCount: countSwarmAgents(normalizeSwarmRoleCounts(input.roleCounts, input.agentCount)),
    roleCounts: normalizeSwarmRoleCounts(input.roleCounts, input.agentCount),
    skills: {
      ...createDefaultSwarmSkills(),
      architect: input.skills?.architect ?? createDefaultSwarmSkills().architect,
      product: input.skills?.product ?? createDefaultSwarmSkills().product,
      developer: input.skills?.developer ?? createDefaultSwarmSkills().developer,
      frontend: input.skills?.frontend ?? createDefaultSwarmSkills().frontend,
      tester: input.skills?.tester ?? createDefaultSwarmSkills().tester,
      security: input.skills?.security ?? createDefaultSwarmSkills().security,
    },
    rolePrompts: {
      ...createDefaultSwarmRolePrompts(),
      ...input.rolePrompts,
    },
    swarmAgents:
      input.swarmAgents && Object.keys(input.swarmAgents).length > 0
        ? input.swarmAgents
        : buildInitialSwarmAgents(normalizeSwarmRoleCounts(input.roleCounts, input.agentCount)),
    phase: input.phase ?? (input.planApproved ? 'executing' : 'awaiting_approval'),
    planApproved: input.planApproved ?? true,
    planReady: input.planReady ?? Boolean(input.planApproved),
    planReadyAt: input.planReadyAt ?? null,
    planReadyBy: input.planReadyBy ?? null,
    taskGraphReplacedAt: input.taskGraphReplacedAt ?? null,
    taskValidation: input.taskValidation ?? null,
    artifacts: input.artifacts ?? [],
    events: input.events ?? [],
    tasks: Array.isArray(input.tasks) ? normalizedTasks : buildInitialSwarmTasks(input),
  }
}
