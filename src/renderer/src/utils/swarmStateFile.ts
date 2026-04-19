import type {
  AgentState,
  SwarmArtifact,
  SwarmEvent,
  SwarmRole,
  SwarmRoleCounts,
  SwarmRuntimeAgent,
  SwarmRuntimeAgentStatus,
  SwarmState,
  SwarmTask,
  SwarmTaskEvidence,
  SwarmTaskValidation,
} from '../types/workspace'
import {
  buildInitialSwarmAgents,
  buildSwarmAgentRoster,
  createDefaultSwarmSkills,
  normalizeSwarmState,
} from './swarm'

type SwarmFileTaskEvidence = {
  summary: string
  touchedFiles: string[]
  commandsRan: string[]
  results: string[]
}

type SwarmFileTask = Omit<SwarmTask, 'startedAt' | 'completedAt' | 'evidence'> & {
  startedAt: string | null
  completedAt: string | null
  evidence: SwarmFileTaskEvidence
}

type SwarmFileState = {
  version: number
  swarm: {
    id: string
    name: string
    goal: string
    status: SwarmState['phase']
    planApproved: boolean
    planReady?: boolean
    planReadyAt?: string | null
    planReadyBy?: string | null
    taskGraphReplacedAt?: string | null
    taskValidation?: SwarmFileTaskValidation | null
    workspacePath?: string
    checkoutMode: 'shared'
    updatedAt: string
  }
  roles: Record<
    SwarmRole,
    {
      label: string
      skills: string[]
    }
  >
  agents: Record<
    string,
    {
      role: SwarmRole
      status: SwarmRuntimeAgentStatus
      currentTaskId: string | null
    }
  >
  tasks: SwarmFileTask[]
  events: Array<Omit<SwarmEvent, 'timestamp'> & { timestamp: string }>
  artifacts: SwarmArtifact[]
}

type SwarmFileTaskValidation = Omit<SwarmTaskValidation, 'checkedAt'> & {
  checkedAt: string | null
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/

function toIso(value: number | null): string | null {
  return value ? new Date(value).toISOString() : null
}

function fromIso(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

function normalizeEvidence(input: Partial<SwarmTaskEvidence> | undefined): SwarmTaskEvidence {
  return {
    summary: input?.summary ?? '',
    touchedFiles: Array.isArray(input?.touchedFiles) ? input.touchedFiles : [],
    commandsRan: Array.isArray(input?.commandsRan) ? input.commandsRan : [],
    results: Array.isArray(input?.results) ? input.results : [],
  }
}

function countRolesFromAgents(agents: SwarmFileState['agents'] | undefined): SwarmRoleCounts | null {
  if (!agents) return null

  const counts: SwarmRoleCounts = {
    architect: 0,
    product: 0,
    developer: 0,
    frontend: 0,
    tester: 0,
    security: 0,
  }

  for (const agent of Object.values(agents)) {
    if (!agent?.role || !(agent.role in counts)) continue
    counts[agent.role] += 1
  }

  return Object.values(counts).some((count) => count > 0) ? counts : null
}

function inferAgentStatus(agent: AgentState | undefined, currentTask: SwarmTask | undefined): string {
  if (currentTask?.status === 'needs_input') return 'needs_input'
  if (currentTask?.status === 'in_progress') return 'running'
  if (agent?.status === 'streaming' || agent?.status === 'running') return agent.status
  return agent?.status ?? 'idle'
}

function normalizeRuntimeAgents(
  input: Record<string, SwarmRuntimeAgent> | undefined,
  roleCounts: SwarmRoleCounts
): Record<string, SwarmRuntimeAgent> {
  if (input && Object.keys(input).length > 0) {
    return input
  }
  return buildInitialSwarmAgents(roleCounts)
}

function joinPath(basePath: string, child: string): string {
  const separator = basePath.includes('\\') && !basePath.includes('/') ? '\\' : '/'
  const trimmedBase = basePath.replace(/[\\/]+$/, '')
  return `${trimmedBase}${separator}${child}`
}

export function slugifySwarmName(name: string | null | undefined): string {
  const slug = (name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return slug || 'swarm-team'
}

export function getSwarmRootDirectoryPath(folderPath: string): string {
  return joinPath(folderPath, 'swarm')
}

export function getSwarmDirectoryPath(folderPath: string, swarmName?: string): string {
  return joinPath(getSwarmRootDirectoryPath(folderPath), slugifySwarmName(swarmName))
}

export function getSwarmStateFilePath(folderPath: string, swarmName?: string): string {
  return joinPath(getSwarmDirectoryPath(folderPath, swarmName), 'state.yaml')
}

export function getSwarmPlanFilePath(folderPath: string, swarmName?: string): string {
  return joinPath(getSwarmDirectoryPath(folderPath, swarmName), 'plan.md')
}

export function getSwarmTasksTemplateFilePath(folderPath: string, swarmName?: string): string {
  return joinPath(getSwarmDirectoryPath(folderPath, swarmName), 'tasks.template.json')
}

export function getSwarmTasksSchemaFilePath(folderPath: string, swarmName?: string): string {
  return joinPath(getSwarmDirectoryPath(folderPath, swarmName), 'tasks.schema.json')
}

export function serializeSwarmStateFile(args: {
  workspaceId: string
  workspacePath: string
  swarmState: SwarmState
  agents: Record<string, AgentState>
}): string {
  const { workspaceId, workspacePath, swarmState, agents } = args
  const roster = buildSwarmAgentRoster(swarmState.roleCounts)
  const serialized: SwarmFileState = {
    version: 1,
    swarm: {
      id: `swarm-${workspaceId}-${slugifySwarmName(swarmState.name)}`,
      name: swarmState.name,
      goal: swarmState.goal,
      status: swarmState.phase,
      planApproved: swarmState.planApproved,
      planReady: swarmState.planReady,
      planReadyAt: toIso(swarmState.planReadyAt),
      planReadyBy: swarmState.planReadyBy,
      taskGraphReplacedAt: toIso(swarmState.taskGraphReplacedAt),
      taskValidation: swarmState.taskValidation
        ? {
            ...swarmState.taskValidation,
            checkedAt: toIso(swarmState.taskValidation.checkedAt),
          }
        : null,
      workspacePath,
      checkoutMode: 'shared',
      updatedAt: new Date().toISOString(),
    },
    roles: {
      architect: {
        label: 'Architect',
        skills: swarmState.skills.architect,
      },
      product: {
        label: 'Product Strategist',
        skills: swarmState.skills.product,
      },
      developer: {
        label: 'Developer',
        skills: swarmState.skills.developer,
      },
      frontend: {
        label: 'Frontend Designer',
        skills: swarmState.skills.frontend,
      },
      tester: {
        label: 'Tester',
        skills: swarmState.skills.tester,
      },
      security: {
        label: 'Security Specialist',
        skills: swarmState.skills.security,
      },
    },
    agents: Object.fromEntries(
      roster.map((rosterAgent) => {
        const currentTask = swarmState.tasks.find((task) => task.ownerAgentId === rosterAgent.id && task.status !== 'done')
        const runtimeAgent = swarmState.swarmAgents[rosterAgent.id]
        return [
          rosterAgent.id,
          {
            role: rosterAgent.role,
            status: runtimeAgent?.status ?? inferAgentStatus(agents[rosterAgent.id], currentTask),
            currentTaskId: runtimeAgent?.currentTaskId ?? currentTask?.id ?? null,
          },
        ]
      })
    ),
    tasks: swarmState.tasks.map((task) => ({
      ...task,
      evidence: normalizeEvidence(task.evidence),
      startedAt: toIso(task.startedAt),
      completedAt: toIso(task.completedAt),
    })),
    events: swarmState.events.map((event) => ({
      ...event,
      timestamp: new Date(event.timestamp).toISOString(),
    })),
    artifacts: swarmState.artifacts,
  }

  return `${JSON.stringify(serialized, null, 2)}\n`
}

export function parseSwarmStateFile(content: string): SwarmState {
  const parsed = JSON.parse(content) as Partial<SwarmFileState>
  const roleCounts = countRolesFromAgents(parsed.agents) ?? undefined
  const defaultSkills = createDefaultSwarmSkills()

  const candidate: SwarmState = {
    name: parsed.swarm?.name ?? 'Swarm Team',
    goal: parsed.swarm?.goal ?? 'Swarm run',
    agentCount: roleCounts ? Object.values(roleCounts).reduce((sum, count) => sum + count, 0) : 0,
    roleCounts: roleCounts ?? {
      architect: 1,
      product: 1,
      developer: 1,
      frontend: 1,
      tester: 0,
      security: 0,
    },
    skills: {
      architect: parsed.roles?.architect?.skills ?? defaultSkills.architect,
      product: parsed.roles?.product?.skills ?? defaultSkills.product,
      developer: parsed.roles?.developer?.skills ?? defaultSkills.developer,
      frontend: parsed.roles?.frontend?.skills ?? defaultSkills.frontend,
      tester: parsed.roles?.tester?.skills ?? defaultSkills.tester,
      security: parsed.roles?.security?.skills ?? defaultSkills.security,
    },
    swarmAgents: normalizeRuntimeAgents(parsed.agents as Record<string, SwarmRuntimeAgent> | undefined, roleCounts ?? {
      architect: 1,
      product: 1,
      developer: 1,
      frontend: 1,
      tester: 0,
      security: 0,
    }),
    phase: parsed.swarm?.status ?? 'planning',
    planApproved: parsed.swarm?.planApproved ?? false,
    planReady: parsed.swarm?.planReady ?? false,
    planReadyAt: fromIso(parsed.swarm?.planReadyAt),
    planReadyBy: parsed.swarm?.planReadyBy ?? null,
    taskGraphReplacedAt: fromIso(parsed.swarm?.taskGraphReplacedAt),
    taskValidation: parsed.swarm?.taskValidation
      ? {
          ok: Boolean(parsed.swarm.taskValidation.ok),
          checkedAt: fromIso(parsed.swarm.taskValidation.checkedAt),
          errors: Array.isArray(parsed.swarm.taskValidation.errors) ? parsed.swarm.taskValidation.errors : [],
          warnings: Array.isArray(parsed.swarm.taskValidation.warnings) ? parsed.swarm.taskValidation.warnings : [],
        }
      : null,
    artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
    events: Array.isArray(parsed.events)
      ? parsed.events.map((event) => ({
          ...event,
          timestamp: fromIso(event.timestamp) ?? Date.now(),
        }))
      : [],
    tasks: Array.isArray(parsed.tasks)
      ? parsed.tasks.map((task) => ({
          ...task,
          evidence: normalizeEvidence(task.evidence),
          startedAt: fromIso(task.startedAt),
          completedAt: fromIso(task.completedAt),
        }))
      : [],
  }

  return normalizeSwarmState(candidate) ?? candidate
}

export function serializeSwarmPlanMarkdown(swarmState: SwarmState): string {
  const lines = [
    '# Swarm Plan',
    '',
    '> Draft placeholder. The architect owns this file and should replace it after repo discovery, product research, specialist consultation, and user alignment.',
    '',
    '## Goal',
    '',
    swarmState.goal,
    '',
    '## Architect Workflow',
    '',
    '- Study the current repository and relevant implementation details.',
    '- Ask clarifying questions until the user confirms the intended outcome.',
    '- Consult the product strategist when market, competitor, audience, positioning, onboarding, or workflow ambiguity could change the plan.',
    '- Consult other specialists when the plan needs frontend, security, testing, or domain-specific input.',
    '- Replace this placeholder with the final low-level design and execution plan.',
    '- Update task cards through the swarm coordination tool, not by hand-editing state.',
    '',
    '## Low-Level Design',
    '',
    '_Architect to fill in after discovery._',
    '',
    '## Implementation Plan',
    '',
    '_Architect to fill in after user alignment._',
    '',
    '## Acceptance Criteria',
    '',
    '_Architect to fill in._',
    '',
    '## Risks / Open Questions',
    '',
    '_Architect to fill in._',
    '',
    '## Initial Task Placeholders',
    '',
  ]

  for (const task of swarmState.tasks) {
    lines.push(`### ${task.id} - ${task.title}`)
    lines.push('')
    lines.push(`- Role: ${task.role}`)
    lines.push(`- Status: ${task.status}`)
    lines.push(`- Depends on: ${task.dependsOn.length > 0 ? task.dependsOn.join(', ') : 'none'}`)
    if (task.ownedPaths.length > 0) {
      lines.push('- Owned paths:')
      task.ownedPaths.forEach((path) => lines.push(`  - ${path}`))
    }
    if (task.acceptanceCriteria.length > 0) {
      lines.push('- Acceptance criteria:')
      task.acceptanceCriteria.forEach((item) => lines.push(`  - ${item}`))
    }
    if (task.implementationNotes.length > 0) {
      lines.push('- Implementation notes:')
      task.implementationNotes.forEach((item) => lines.push(`  - ${item}`))
    }
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

export function serializeSwarmTasksTemplate(): string {
  return `${JSON.stringify({
    tasks: [
      {
        id: 'T1',
        title: 'Replace with a low-level task title',
        description: 'Explain the exact outcome this specialist should deliver.',
        role: 'developer',
        status: 'todo',
        ownerAgentId: null,
        dependsOn: [],
        ownedPaths: ['src/path-or-directory'],
        acceptanceCriteria: [
          'Specific behavior or outcome that must be true when this task is complete.',
        ],
        implementationNotes: [
          'Important plan details, constraints, or suggested approach from the architect.',
        ],
        evidence: {
          summary: '',
          touchedFiles: [],
          commandsRan: [],
          results: [],
        },
        questionsForUser: [],
        notes: [],
        artifacts: [],
        startedAt: null,
        completedAt: null,
      },
    ],
  }, null, 2)}\n`
}

export function serializeSwarmTasksSchema(): string {
  return `${JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Swarm Kanban Tasks',
    type: 'object',
    required: ['tasks'],
    additionalProperties: false,
    properties: {
      tasks: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: [
            'id',
            'title',
            'description',
            'role',
            'dependsOn',
            'ownedPaths',
            'acceptanceCriteria',
            'implementationNotes',
          ],
          additionalProperties: true,
          properties: {
            id: { type: 'string', minLength: 1 },
            title: { type: 'string', minLength: 1 },
            description: { type: 'string', minLength: 1 },
            role: {
              type: 'string',
              enum: ['architect', 'product', 'developer', 'frontend', 'tester', 'security'],
            },
            status: {
              type: 'string',
              enum: ['todo', 'in_progress', 'needs_input', 'done'],
              default: 'todo',
            },
            ownerAgentId: { type: ['string', 'null'] },
            dependsOn: { type: 'array', items: { type: 'string' } },
            ownedPaths: { type: 'array', items: { type: 'string' } },
            acceptanceCriteria: { type: 'array', items: { type: 'string' } },
            implementationNotes: { type: 'array', items: { type: 'string' } },
            evidence: {
              type: 'object',
              additionalProperties: true,
              properties: {
                summary: { type: 'string' },
                touchedFiles: { type: 'array', items: { type: 'string' } },
                commandsRan: { type: 'array', items: { type: 'string' } },
                results: { type: 'array', items: { type: 'string' } },
              },
            },
            questionsForUser: { type: 'array', items: { type: 'string' } },
            notes: { type: 'array', items: { type: 'string' } },
            artifacts: { type: 'array' },
            startedAt: { type: ['string', 'null'] },
            completedAt: { type: ['string', 'null'] },
          },
        },
      },
    },
  }, null, 2)}\n`
}
