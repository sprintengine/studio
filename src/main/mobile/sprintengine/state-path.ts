import { basename, dirname, isAbsolute, resolve } from 'path'
import { MobileSprintEngineCommandError } from './command-error'

export type ValidSprintEngineStatePath = {
  statePath: string
  teamDirectory: string
  workspaceRoot: string
}

export function validateSprintEngineStatePath(input: string): ValidSprintEngineStatePath {
  if (typeof input !== 'string' || !input.trim()) {
    throw new MobileSprintEngineCommandError('path_not_allowed', 'A Sprint Engine run path is required.', false)
  }

  const rawStatePath = input.trim()
  if (!isAbsolute(rawStatePath)) {
    throw new MobileSprintEngineCommandError('path_not_allowed', 'Sprint Engine run path must be absolute.', false)
  }

  const statePath = resolve(rawStatePath)
  const teamDirectory = dirname(statePath)
  const sprintEngineDirectory = dirname(teamDirectory)
  const multiCodeDirectory = dirname(sprintEngineDirectory)
  const workspaceRoot = dirname(multiCodeDirectory)

  if (
    basename(statePath) !== 'run.yaml'
    || basename(sprintEngineDirectory) !== 'sprintengine'
    || basename(multiCodeDirectory) !== '.multi-code'
    || workspaceRoot === multiCodeDirectory
  ) {
    throw new MobileSprintEngineCommandError('path_not_allowed', 'Sprint Engine run path must point to .multi-code/sprintengine/<team>/run.yaml.', false)
  }

  return { statePath, teamDirectory, workspaceRoot }
}
