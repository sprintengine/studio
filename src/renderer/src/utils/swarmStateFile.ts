import type {
  SwarmRole,
  SwarmRoleCounts,
  SwarmRuntimeAgent,
  SwarmState,
} from '../types/workspace'
import {
  buildSwarmAgentRoster,
  createDefaultSwarmRoleCounts,
  normalizeSwarmState,
} from './swarm'

// The shared swarm state file is agent-managed. The Electron app may locate
// and read `state.yaml`, but it must never write or "sync back" swarm state.
// All mutations must go through the swarm Python tool.

function joinPath(basePath: string, child: string): string {
  const sep = basePath.includes('\\') && !basePath.includes('/') ? '\\' : '/'
  return `${basePath.replace(/[\\/]+$/, '')}${sep}${child}`
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

export function getExistingSwarmStateFilePath(folderPath: string, swarmDirectoryName: string): string {
  return joinPath(joinPath(getSwarmRootDirectoryPath(folderPath), swarmDirectoryName), 'state.yaml')
}

export function getSwarmStateFilePath(folderPath: string, swarmName?: string): string {
  return joinPath(getSwarmDirectoryPath(folderPath, swarmName), 'state.yaml')
}

export function getSwarmPlanFilePath(folderPath: string, swarmName?: string): string {
  return joinPath(getSwarmDirectoryPath(folderPath, swarmName), 'plan.md')
}

function isSwarmRole(value: unknown): value is SwarmRole {
  return ['architect', 'product', 'developer', 'frontend', 'tester', 'security', 'code_reviewer'].includes(value as string)
}

function countRolesFromAgents(agents: Record<string, { role: SwarmRole }> | undefined): SwarmRoleCounts | null {
  if (!agents) return null
  const counts = createDefaultSwarmRoleCounts()
  for (const key of Object.keys(counts) as SwarmRole[]) counts[key] = 0
  for (const agent of Object.values(agents)) {
    if (isSwarmRole(agent?.role)) counts[agent.role] += 1
  }
  return Object.values(counts).some((c) => c > 0) ? counts : null
}

export function parseSwarmStateFile(content: string, fallbackName?: string): SwarmState {
  const parsed = JSON.parse(content) as Record<string, unknown>
  const swarm = (parsed.swarm ?? {}) as Record<string, unknown>
  const agents = (parsed.agents ?? {}) as Record<string, SwarmRuntimeAgent>
  const roleCounts = countRolesFromAgents(agents) ?? createDefaultSwarmRoleCounts()

  const candidate: SwarmState = {
    name: (swarm.name as string) ?? fallbackName ?? 'Swarm Team',
    goal: (swarm.goal as string) ?? '',
    updatedAt: typeof swarm.updatedAt === 'string' ? swarm.updatedAt : null,
    roleCounts,
    swarmAgents: Object.keys(agents).length > 0
      ? agents
      : Object.fromEntries(buildSwarmAgentRoster(roleCounts).map((a) => [a.id, { role: a.role, status: 'idle' as const, currentTaskId: null }])),
    events: Array.isArray(parsed.events) ? parsed.events as SwarmState['events'] : [],
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks as SwarmState['tasks'] : [],
    artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts as SwarmState['artifacts'] : [],
  }

  return normalizeSwarmState(candidate) ?? candidate
}
