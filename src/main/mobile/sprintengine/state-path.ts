import { basename, dirname, isAbsolute, resolve } from 'path'
import { MobileSprintEngineCommandError } from './command-error'

export type ValidSprintEngineStatePath = {
  statePath: string
  teamDirectory: string
  workspaceRoot: string
}

export function validateSprintEngineStatePath(input: string): ValidSprintEngineStatePath {
  if (typeof input !== 'string' || !input.trim()) {
    throw new MobileSprintEngineCommandError('path_not_allowed', 'A Sprint Engine state path is required.', false)
  }

  const rawStatePath = input.trim()
  if (!isAbsolute(rawStatePath)) {
    throw new MobileSprintEngineCommandError('path_not_allowed', 'Sprint Engine state path must be absolute.', false)
  }

  const statePath = resolve(rawStatePath)
  const teamDirectory = dirname(statePath)
  const sprintEngineDirectory = dirname(teamDirectory)
  const multiCodeDirectory = dirname(sprintEngineDirectory)
  const workspaceRoot = dirname(multiCodeDirectory)

  if (
    basename(statePath) !== 'state.yaml'
    || basename(sprintEngineDirectory) !== 'sprintengine'
    || basename(multiCodeDirectory) !== '.multi-code'
    || workspaceRoot === multiCodeDirectory
  ) {
    throw new MobileSprintEngineCommandError('path_not_allowed', 'Sprint Engine state path must point to .multi-code/sprintengine/<team>/state.yaml.', false)
  }

  return { statePath, teamDirectory, workspaceRoot }
}
