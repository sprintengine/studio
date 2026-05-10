import type {
  SprintEngineRole,
  SprintEngineRoleCounts,
  SprintEngineRuntimeAgent,
  SprintEngineState,
} from '../types/workspace'
import {
  buildSprintEngineAgentRoster,
  createDefaultSprintEngineRoleCounts,
  normalizeSprintEngineState,
} from './sprintengine'

// The shared Sprint Engine state file is agent-managed. The Electron app may locate
// and read `state.yaml`, but it must never write or "sync back" Sprint Engine state.
// All mutations must go through the sprintengine Python tool.

function joinPath(basePath: string, child: string): string {
  const sep = basePath.includes('\\') && !basePath.includes('/') ? '\\' : '/'
  return `${basePath.replace(/[\\/]+$/, '')}${sep}${child}`
}

export function slugifySprintEngineName(name: string | null | undefined): string {
  const slug = (name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'sprintengine-team'
}

export function getSprintEngineRootDirectoryPath(folderPath: string): string {
  return joinPath(joinPath(folderPath, '.multi-code'), 'sprintengine')
}

export function getSprintEngineDirectoryPath(folderPath: string, sprintEngineName?: string): string {
  return joinPath(getSprintEngineRootDirectoryPath(folderPath), slugifySprintEngineName(sprintEngineName))
}

export function getExistingSprintEngineStateFilePath(folderPath: string, sprintEngineDirectoryName: string): string {
  return joinPath(joinPath(getSprintEngineRootDirectoryPath(folderPath), sprintEngineDirectoryName), 'state.yaml')
}

export function getSprintEngineStateFilePath(folderPath: string, sprintEngineName?: string): string {
  return joinPath(getSprintEngineDirectoryPath(folderPath, sprintEngineName), 'state.yaml')
}

export function getSprintEnginePlanFilePath(folderPath: string, sprintEngineName?: string): string {
  return joinPath(getSprintEngineDirectoryPath(folderPath, sprintEngineName), 'plan.md')
}

function isSprintEngineRole(value: unknown): value is SprintEngineRole {
  return ['architect', 'product', 'developer', 'frontend', 'tester', 'security', 'code_reviewer', 'performance'].includes(value as string)
}

function countRolesFromAgents(agents: Record<string, { role: SprintEngineRole }> | undefined): SprintEngineRoleCounts | null {
  if (!agents) return null
  const counts = createDefaultSprintEngineRoleCounts()
  for (const key of Object.keys(counts) as SprintEngineRole[]) counts[key] = 0
  for (const agent of Object.values(agents)) {
    if (isSprintEngineRole(agent?.role)) counts[agent.role] += 1
  }
  return Object.values(counts).some((c) => c > 0) ? counts : null
}

export function parseSprintEngineStateFile(content: string, fallbackName?: string): SprintEngineState {
  const parsed = JSON.parse(content) as Record<string, unknown>
  const sprintengine = (parsed.sprintengine ?? {}) as Record<string, unknown>
  const agents = (parsed.agents ?? {}) as Record<string, SprintEngineRuntimeAgent>
  const roleCounts = countRolesFromAgents(agents) ?? createDefaultSprintEngineRoleCounts()

  const candidate: SprintEngineState = {
    name: (sprintengine.name as string) ?? fallbackName ?? 'Sprint Engine Team',
    goal: (sprintengine.goal as string) ?? '',
    rosterConfigured: Boolean(sprintengine.rosterConfigured),
    source: typeof parsed.source === 'object' && parsed.source !== null
      ? parsed.source as SprintEngineState['source']
      : undefined,
    updatedAt: typeof sprintengine.updatedAt === 'string' ? sprintengine.updatedAt : null,
    roleCounts,
    sprintEngineAgents: Object.keys(agents).length > 0
      ? agents
      : Object.fromEntries(buildSprintEngineAgentRoster(roleCounts).map((a) => [a.id, { role: a.role, status: 'idle' as const, currentTaskId: null }])),
    events: Array.isArray(parsed.events) ? parsed.events as SprintEngineState['events'] : [],
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks as SprintEngineState['tasks'] : [],
    artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts as SprintEngineState['artifacts'] : [],
  }

  return normalizeSprintEngineState(candidate) ?? candidate
}
