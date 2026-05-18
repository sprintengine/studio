import { constants } from 'fs'
import { access, stat } from 'fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { readSprintEngineSnapshot } from './snapshot'
import { MobileSprintEngineCommandError } from './command-error'
import { isPathInsideOrEqual, isSafePathSegment } from './path-utils'
import {
  validateSprintEngineStatePath,
  type ValidSprintEngineStatePath,
} from './state-path'

export async function resolveStateForSprintEngine(input: {
  sprintEngineId: string
  statePaths: string[]
  workspaceRoot: string
  allowedWorkspaceRoots: string[]
}): Promise<ValidSprintEngineStatePath> {
  const { sprintEngineId, statePaths, workspaceRoot, allowedWorkspaceRoots } = input
  if (!isSafePathSegment(sprintEngineId)) {
    throw new MobileSprintEngineCommandError('path_not_allowed', 'Sprint Engine id must be a single safe path segment.', false)
  }

  const statePath = statePaths.length > 0
    ? statePaths.find((candidate) => basename(dirname(candidate)) === sprintEngineId)
    : join(workspaceRoot, '.multi-code', 'sprintengine', sprintEngineId, 'run.yaml')

  if (!statePath) {
    throw new MobileSprintEngineCommandError('sprintengine_not_found', 'Requested sprintengine is not available to mobile control.', false)
  }

  const state = validateSprintEngineStatePath(statePath)
  if (!isAllowedWorkspace(allowedWorkspaceRoots, state.workspaceRoot)) {
    throw new MobileSprintEngineCommandError('path_not_allowed', 'Sprint Engine run path is outside the allowed workspace roots.', false)
  }

  try {
    const stateStats = await stat(state.statePath)
    if (!stateStats.isFile()) {
      throw new MobileSprintEngineCommandError('sprintengine_not_found', 'Sprint Engine run path is not a file.', false)
    }
  } catch (error) {
    if (error instanceof MobileSprintEngineCommandError) throw error
    throw new MobileSprintEngineCommandError('sprintengine_not_found', 'Requested Sprint Engine run was not found.', false)
  }

  return state
}

export async function assertExpectedSnapshotVersion(input: {
  expectedSnapshotVersion?: string
  statePath: string
}): Promise<void> {
  const { expectedSnapshotVersion, statePath } = input
  if (!expectedSnapshotVersion) return
  const snapshot = await readSprintEngineSnapshot(statePath)
  if (snapshot.snapshotVersion !== expectedSnapshotVersion) {
    throw new MobileSprintEngineCommandError('stale_snapshot', 'Command was based on a stale Sprint Engine snapshot.', false)
  }
}

export async function validateMobileWorkspacePath(input: {
  workspacePath: string
  allowedWorkspaceRoots: string[]
}): Promise<string> {
  if (!isAbsolute(input.workspacePath)) {
    throw new MobileSprintEngineCommandError('path_not_allowed', 'Workspace path must be absolute.', false)
  }

  const workspacePath = resolve(input.workspacePath)
  if (!isAllowedWorkspace(input.allowedWorkspaceRoots, workspacePath)) {
    throw new MobileSprintEngineCommandError('path_not_allowed', 'Workspace path is outside the allowed workspace roots.', false)
  }

  try {
    await access(workspacePath, constants.R_OK | constants.W_OK)
    const workspaceStats = await stat(workspacePath)
    if (!workspaceStats.isDirectory()) {
      throw new MobileSprintEngineCommandError('path_not_allowed', 'Workspace path must be a directory.', false)
    }
  } catch (error) {
    if (error instanceof MobileSprintEngineCommandError) throw error
    throw new MobileSprintEngineCommandError('path_not_allowed', 'Workspace path is not accessible.', false)
  }

  return workspacePath
}

function isAllowedWorkspace(allowedWorkspaceRoots: string[], targetPath: string): boolean {
  return allowedWorkspaceRoots.some((workspaceRoot) => isPathInsideOrEqual(workspaceRoot, targetPath))
}
