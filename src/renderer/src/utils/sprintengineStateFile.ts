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
} from './sprintengine'

// The shared Sprint Engine state file is agent-managed. The Electron app may locate
// and read `state.yaml`, but it must never write or "sync back" Sprint Engine state.
// All mutations must go through the sprintengine Python tool.

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
  return slug || 'sprintengine-team'
}

export function getSwarmRootDirectoryPath(folderPath: string): string {
  return joinPath(joinPath(folderPath, '.multi-code'), 'sprintengine')
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
  return ['architect', 'product', 'developer', 'frontend', 'tester', 'security', 'code_reviewer', 'performance'].includes(value as string)
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
  const sprintengine = (parsed.sprintengine ?? {}) as Record<string, unknown>
  const agents = (parsed.agents ?? {}) as Record<string, SwarmRuntimeAgent>
  const roleCounts = countRolesFromAgents(agents) ?? createDefaultSwarmRoleCounts()

  const candidate: SwarmState = {
    name: (sprintengine.name as string) ?? fallbackName ?? 'Sprint Engine Team',
    goal: (sprintengine.goal as string) ?? '',
    rosterConfigured: Boolean(sprintengine.rosterConfigured),
    source: typeof parsed.source === 'object' && parsed.source !== null
      ? parsed.source as SwarmState['source']
      : undefined,
    updatedAt: typeof sprintengine.updatedAt === 'string' ? sprintengine.updatedAt : null,
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
