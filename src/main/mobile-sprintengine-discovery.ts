import { readdir } from 'fs/promises'
import { join } from 'path'
import { pathExists } from './filesystem-workspace'

export async function discoverMobileSprintEngineStatePaths(workspaceRoots: string[]): Promise<string[]> {
  const roots = workspaceRoots.length > 0 ? workspaceRoots : [process.cwd()]
  const statePathGroups = await Promise.all(roots.map((root) => discoverSprintEngineStatePaths(root)))
  return [...new Set(statePathGroups.flat())]
}

async function discoverSprintEngineStatePaths(workspaceRoot: string): Promise<string[]> {
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
        const statePath = join(sprintEngineRoot, entry.name, 'state.yaml')
        return (await pathExists(statePath)) ? statePath : null
      })
  )
  return statePaths.filter((statePath): statePath is string => Boolean(statePath))
}
