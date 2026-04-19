import type {
  AgentId,
  SwarmMockConfig,
  SwarmRole,
  SwarmRoleCounts,
  SwarmTaskBoardColumn,
  SwarmTaskEvidence,
  SwarmSkillMap,
  SwarmState,
  SwarmTask,
} from '../types/workspace'

export type SwarmAgentRosterItem = {
  id: AgentId
  label: string
  role: SwarmRole | 'developer'
}

export const swarmRoleLabels: Record<SwarmRole, string> = {
  architect: 'Architect',
  developer: 'Developer',
  frontend: 'Frontend Designer',
  tester: 'Tester',
  security: 'Security Specialist',
}

export const swarmRoleAccent: Record<SwarmRole, string> = {
  architect: '#d4a757',
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
    description: 'One architect, one frontend designer, one developer.',
    roleCounts: { architect: 1, developer: 1, frontend: 1, tester: 0, security: 0 },
  },
  {
    id: 'medium',
    name: 'Medium Team',
    description: 'One architect, one frontend designer, two developers.',
    roleCounts: { architect: 1, developer: 2, frontend: 1, tester: 0, security: 0 },
  },
  {
    id: 'large',
    name: 'Large Team',
    description: 'One architect, one frontend designer, four developers.',
    roleCounts: { architect: 1, developer: 4, frontend: 1, tester: 0, security: 0 },
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
    developer: [],
    frontend: [],
    tester: [],
    security: [],
  }
}

export function createDefaultSwarmSkills(): SwarmSkillMap {
  return {
    architect: ['Deep repo analysis', 'Planning', 'Task decomposition', 'Dependency mapping'],
    developer: ['Implementation', 'Refactoring', 'Integration work', 'Testing'],
    frontend: ['Interface design', 'Interaction design', 'Responsive layouts', 'UI implementation'],
    tester: ['Regression checks', 'Acceptance review', 'Validation'],
    security: ['Threat modeling', 'Security review', 'Hardening', 'Abuse-case analysis'],
  }
}

export function createDefaultSwarmRoleCounts(): SwarmRoleCounts {
  return { architect: 1, developer: 1, frontend: 1, tester: 0, security: 0 }
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
      developer: Math.max(0, roleCounts.developer ?? 0),
      frontend: Math.max(0, roleCounts.frontend ?? 0),
      tester: Math.max(0, roleCounts.tester ?? 0),
      security: Math.max(0, roleCounts.security ?? 0),
    }
  }

  const count = Math.max(1, fallbackAgentCount ?? 3)
  return {
    architect: 1,
    developer: count >= 2 ? Math.max(1, count - (count >= 3 ? 2 : 1) - (count >= 4 ? 1 : 0)) : 0,
    frontend: count >= 3 ? 1 : 0,
    tester: count >= 4 ? 1 : 0,
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
  pushRole('frontend', 'Frontend Designer', roleCounts.frontend)
  pushRole('developer', 'Developer', roleCounts.developer)
  pushRole('tester', 'Tester', roleCounts.tester)
  pushRole('security', 'Security Specialist', roleCounts.security)

  return roster
}

export function buildInitialSwarmTasks(config: SwarmMockConfig): SwarmTask[] {
  const goal = config.goal.trim() || 'Deliver the swarm workspace experience'
  const startedAt = now() - 1000 * 60 * 22
  const completedAt = now() - 1000 * 60 * 8

  return [
    createTask({
      id: 'T1',
      title: 'Persist real swarm orchestration state',
      description: `Model the canonical swarm state needed to turn "${goal}" into an actual orchestrated run.`,
      role: 'developer',
      status: 'done',
      ownerAgentId: 'developer-1',
      dependsOn: [],
      ownedPaths: ['src/renderer/src/types', 'src/renderer/src/store', 'src/renderer/src/utils'],
      acceptanceCriteria: [
        'Swarm state supports ownership, evidence, artifacts, events, and plan approval.',
        'Persisted workspaces restore the same swarm run state.',
        'The state model no longer relies on seed mock tasks.',
      ],
      implementationNotes: [
        'Keep the app store canonical.',
        'Model only what the board and workers actually need.',
      ],
      evidence: {
        summary: 'Extended the in-memory swarm model with richer task metadata and orchestration state.',
        touchedFiles: [
          'src/renderer/src/types/workspace.ts',
          'src/renderer/src/store/workspaceStore.ts',
        ],
        commandsRan: ['npm run typecheck'],
        results: ['Type model compiles and persists cleanly.'],
      },
      notes: ['Existing saved workspaces need migration from the older task shape.'],
      startedAt,
      completedAt,
    }),
    createTask({
      id: 'T2',
      title: 'Define swarm disk contract',
      description: 'Project canonical swarm state into agent-readable files for plan context and shared runtime state.',
      role: 'developer',
      status: 'done',
      ownerAgentId: 'developer-1',
      dependsOn: ['T1'],
      ownedPaths: ['swarm', 'src/main', 'src/preload', 'src/renderer/src/services'],
      acceptanceCriteria: [
        'The app can mirror canonical state into swarm/state.yaml.',
        'The architect can publish a durable low-level design into swarm/plan.md.',
        'The sync boundary between UI state and disk artifacts is explicit.',
      ],
      implementationNotes: [
        'Keep the format easy to inspect in a CLI.',
        'Design for future agent write-back without making the file the canonical source of truth.',
      ],
      evidence: {
        summary: 'Prototyped plan and state artifacts under the new swarm folder contract.',
        touchedFiles: ['swarm/README.md', 'swarm/plan.md', 'swarm/state.yaml'],
        commandsRan: [],
        results: ['Prototype artifacts now mirror the architecture discussion.'],
      },
      startedAt: startedAt + 1000 * 60 * 3,
      completedAt: completedAt + 1000 * 60 * 1,
    }),
    createTask({
      id: 'T3',
      title: 'Upgrade swarm board into an operational dashboard',
      description: 'Rework the board to show derived ready work, ownership, owned paths, and worker evidence.',
      role: 'frontend',
      status: 'in_progress',
      ownerAgentId: 'frontend',
      dependsOn: ['T1'],
      ownedPaths: ['src/renderer/src/components/panels', 'src/renderer/src/components/workspace'],
      acceptanceCriteria: [
        'The board renders from rich swarm run data.',
        'Task detail shows owned paths, acceptance criteria, notes, and evidence.',
        'The UI distinguishes Todo, Ready, In Progress, Needs Input, and Done.',
      ],
      implementationNotes: [
        'Optimize for information density and operational clarity.',
        'Make active ownership and dependency state obvious at a glance.',
      ],
      evidence: emptyEvidence('Board refactor is underway.'),
      notes: ['Consider surfacing plan approval and run phase above the kanban lanes.'],
      startedAt: now() - 1000 * 60 * 9,
    }),
    createTask({
      id: 'T4',
      title: 'Build architect planning flow and approval gate',
      description: 'Create the architect-to-user planning loop and prevent workers from starting before the plan is approved.',
      role: 'developer',
      status: 'needs_input',
      ownerAgentId: 'developer-2',
      dependsOn: ['T1', 'T2'],
      ownedPaths: ['src/renderer/src/components/workspace', 'src/renderer/src/services', 'src/renderer/src/store'],
      acceptanceCriteria: [
        'The architect creates plan artifacts before workers start.',
        'The user can review and approve the plan.',
        'Workers do not begin execution before approval.',
      ],
      implementationNotes: [
        'The architect should ask multiple questions until it is aligned with the user.',
        'The architect stops once the plan is approved and seeded.',
      ],
      evidence: emptyEvidence('Waiting on a final decision about where plan approval should live in the UI.'),
      questionsForUser: [
        'Should plan approval be a top-level swarm banner action or part of the task detail workflow?',
      ],
      notes: ['This task is paused pending UX direction.'],
      startedAt: now() - 1000 * 60 * 5,
    }),
    createTask({
      id: 'T5',
      title: 'Enable role-based worker claiming',
      description: 'Allow workers to claim one eligible task whose role matches their specialty.',
      role: 'developer',
      status: 'todo',
      ownerAgentId: null,
      dependsOn: ['T2'],
      ownedPaths: ['src/renderer/src/services', 'src/renderer/src/store'],
      acceptanceCriteria: [
        'A worker can claim one eligible task matching its role.',
        'Claimed tasks record owner agent id and start time.',
        'Workers can update only their own task card.',
      ],
      implementationNotes: [
        'Do not allow duplicate claiming.',
        'Correctness matters more than maximizing parallelism.',
      ],
      notes: ['This task should become Ready because its dependency is already done.'],
    }),
    createTask({
      id: 'T6',
      title: 'Capture worker evidence and completion output',
      description: 'Persist what each specialist changed so the user can validate the final feature quickly.',
      role: 'developer',
      status: 'todo',
      ownerAgentId: null,
      dependsOn: ['T3', 'T5'],
      ownedPaths: ['src/renderer/src/store', 'src/renderer/src/components/panels', 'src/renderer/src/services'],
      acceptanceCriteria: [
        'Each completed task includes summary, touched files, commands run, and results.',
        'Workers can mark a task needs_input.',
        'Done tasks leave a clear audit trail for the user.',
      ],
      implementationNotes: [
        'Completion output should help the user manually validate the feature.',
      ],
      notes: ['This remains blocked until the board UI and claiming flow are further along.'],
    }),
  ]
}

export function createInitialSwarmState(config: SwarmMockConfig): SwarmState {
  const roleCounts = normalizeSwarmRoleCounts(config.roleCounts, config.agentCount)
  return {
    goal: config.goal,
    agentCount: countSwarmAgents(roleCounts),
    roleCounts,
    skills: {
      ...createDefaultSwarmSkills(),
      ...config.skills,
    },
    phase: 'executing',
    planApproved: true,
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
        timestamp: now() - 1000 * 60 * 25,
        type: 'plan_approved',
        actor: 'architect',
        message: 'Architect plan approved. Worker execution is now active.',
      },
      {
        id: 'EVT-002',
        timestamp: now() - 1000 * 60 * 9,
        type: 'task_claimed',
        actor: 'frontend',
        message: 'Frontend specialist claimed T3.',
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
    goal: input.goal,
    agentCount: countSwarmAgents(normalizeSwarmRoleCounts(input.roleCounts, input.agentCount)),
    roleCounts: normalizeSwarmRoleCounts(input.roleCounts, input.agentCount),
    skills: {
      ...createDefaultSwarmSkills(),
      architect: input.skills?.architect ?? createDefaultSwarmSkills().architect,
      developer: input.skills?.developer ?? createDefaultSwarmSkills().developer,
      frontend: input.skills?.frontend ?? createDefaultSwarmSkills().frontend,
      tester: input.skills?.tester ?? createDefaultSwarmSkills().tester,
      security: input.skills?.security ?? createDefaultSwarmSkills().security,
    },
    phase: input.phase ?? (input.planApproved ? 'executing' : 'awaiting_approval'),
    planApproved: input.planApproved ?? true,
    artifacts: input.artifacts ?? [],
    events: input.events ?? [],
    tasks: normalizedTasks.length > 0 ? normalizedTasks : buildInitialSwarmTasks(input),
  }
}
