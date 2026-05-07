import { basename, dirname, isAbsolute, resolve } from 'path'
import { MobileSwarmCommandError } from './command-error'

export type ValidSwarmStatePath = {
  statePath: string
  teamDirectory: string
  workspaceRoot: string
}

export function validateSwarmStatePath(input: string): ValidSwarmStatePath {
  if (typeof input !== 'string' || !input.trim()) {
    throw new MobileSwarmCommandError('path_not_allowed', 'A Sprint Engine state path is required.', false)
  }

  const rawStatePath = input.trim()
  if (!isAbsolute(rawStatePath)) {
    throw new MobileSwarmCommandError('path_not_allowed', 'Sprint Engine state path must be absolute.', false)
  }

  const statePath = resolve(rawStatePath)
  const teamDirectory = dirname(statePath)
  const swarmDirectory = dirname(teamDirectory)
  const multiCodeDirectory = dirname(swarmDirectory)
  const workspaceRoot = dirname(multiCodeDirectory)

  if (
    basename(statePath) !== 'state.yaml'
    || basename(swarmDirectory) !== 'sprintengine'
    || basename(multiCodeDirectory) !== '.multi-code'
    || workspaceRoot === multiCodeDirectory
  ) {
    throw new MobileSwarmCommandError('path_not_allowed', 'Sprint Engine state path must point to .multi-code/sprintengine/<team>/state.yaml.', false)
  }

  return { statePath, teamDirectory, workspaceRoot }
}
