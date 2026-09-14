import { basename, dirname, isAbsolute, resolve } from 'path'
import { MobileSprintEngineCommandError } from './command-error'
import { SIDECAR_DIR_NAME, isSidecarDirName } from '../../../shared/workspace-sidecar'

export type ValidSprintEngineStatePath = {
  statePath: string
  teamDirectory: string
  workspaceRoot: string
}

export function validateSprintEngineStatePath(input: string): ValidSprintEngineStatePath {
  if (typeof input !== 'string' || !input.trim()) {
    throw new MobileSprintEngineCommandError('path_not_allowed', 'A sprint run path is required.', false)
  }

  const rawStatePath = input.trim()
  if (!isAbsolute(rawStatePath)) {
    throw new MobileSprintEngineCommandError('path_not_allowed', 'Sprint run path must be absolute.', false)
  }

  const statePath = resolve(rawStatePath)
  const teamDirectory = dirname(statePath)
  const sprintEngineDirectory = dirname(teamDirectory)
  const sidecarDirectory = dirname(sprintEngineDirectory)
  const workspaceRoot = dirname(sidecarDirectory)

  if (
    basename(statePath) !== 'run.yaml'
    || basename(sprintEngineDirectory) !== 'sprintengine'
    || !isSidecarDirName(basename(sidecarDirectory))
    || workspaceRoot === sidecarDirectory
  ) {
    throw new MobileSprintEngineCommandError('path_not_allowed', `Sprint run path must point to ${SIDECAR_DIR_NAME}/sprintengine/<team>/run.yaml.`, false)
  }

  return { statePath, teamDirectory, workspaceRoot }
}
