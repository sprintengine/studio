import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { pathExists } from './filesystem-workspace'

export async function discoverMobileSprintEngineStatePaths(workspaceRoots: string[]): Promise<string[]> {
  const roots = workspaceRoots.length > 0 ? workspaceRoots : [process.cwd()]
  const statePathGroups = await Promise.all(roots.map((root) => discoverSprintEngineStatePaths(root)))
  const discovered = new Map<string, DiscoveredSprintEngineStatePath>()
  for (const item of statePathGroups.flat()) {
    const existing = discovered.get(item.statePath)
    if (!existing || item.updatedAtMs > existing.updatedAtMs) {
      discovered.set(item.statePath, item)
    }
  }
  return [...discovered.values()]
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs || left.statePath.localeCompare(right.statePath))
    .map((item) => item.statePath)
}

type DiscoveredSprintEngineStatePath = {
  statePath: string
  updatedAtMs: number
}

async function discoverSprintEngineStatePaths(workspaceRoot: string): Promise<DiscoveredSprintEngineStatePath[]> {
  const sprintEngineRoot = join(workspaceRoot, '.multi-code', 'sprintengine')
  let entries
  try {
    entries = await readdir(sprintEngineRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const statePaths = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const statePath = join(sprintEngineRoot, entry.name, 'run.yaml')
        if (!(await pathExists(statePath))) {
          return null
        }
        return {
          statePath,
          updatedAtMs: await readSprintEngineUpdatedAtMs(statePath, join(sprintEngineRoot, entry.name, 'projection.json')),
        }
      })
  )
  return statePaths.filter((statePath): statePath is DiscoveredSprintEngineStatePath => Boolean(statePath))
}

async function readSprintEngineUpdatedAtMs(statePath: string, projectionPath: string): Promise<number> {
  const [projectionStats, stateStats] = await Promise.all([
    stat(projectionPath).catch(() => null),
    stat(statePath).catch(() => null),
  ])
  return projectionStats?.mtimeMs ?? stateStats?.mtimeMs ?? 0
}
