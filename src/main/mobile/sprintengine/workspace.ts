import { constants } from 'fs'
import { access, stat } from 'fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { readSwarmSnapshot } from './snapshot'
import { MobileSwarmCommandError } from './command-error'
import { isPathInsideOrEqual, isSafePathSegment } from './path-utils'
import {
  validateSwarmStatePath,
  type ValidSwarmStatePath,
} from './state-path'

export async function resolveStateForSwarm(input: {
  swarmId: string
  statePaths: string[]
  workspaceRoot: string
  allowedWorkspaceRoots: string[]
}): Promise<ValidSwarmStatePath> {
  const { swarmId, statePaths, workspaceRoot, allowedWorkspaceRoots } = input
  if (!isSafePathSegment(swarmId)) {
    throw new MobileSwarmCommandError('path_not_allowed', 'SprintEngine id must be a single safe path segment.', false)
  }

  const statePath = statePaths.length > 0
    ? statePaths.find((candidate) => basename(dirname(candidate)) === swarmId)
    : join(workspaceRoot, '.multi-code', 'sprintengine', swarmId, 'state.yaml')

  if (!statePath) {
    throw new MobileSwarmCommandError('swarm_not_found', 'Requested sprintengine is not available to mobile control.', false)
  }

  const state = validateSwarmStatePath(statePath)
  if (!isAllowedWorkspace(allowedWorkspaceRoots, state.workspaceRoot)) {
    throw new MobileSwarmCommandError('path_not_allowed', 'Sprint Engine state path is outside the allowed workspace roots.', false)
  }

  try {
    const stateStats = await stat(state.statePath)
    if (!stateStats.isFile()) {
      throw new MobileSwarmCommandError('swarm_not_found', 'Sprint Engine state path is not a file.', false)
    }
  } catch (error) {
    if (error instanceof MobileSwarmCommandError) throw error
    throw new MobileSwarmCommandError('swarm_not_found', 'Requested Sprint Engine state was not found.', false)
  }

  return state
}

export async function assertExpectedSnapshotVersion(input: {
  expectedSnapshotVersion?: string
  statePath: string
}): Promise<void> {
  const { expectedSnapshotVersion, statePath } = input
  if (!expectedSnapshotVersion) return
  const snapshot = await readSwarmSnapshot(statePath)
  if (snapshot.snapshotVersion !== expectedSnapshotVersion) {
    throw new MobileSwarmCommandError('stale_snapshot', 'Command was based on a stale sprintengine snapshot.', false)
  }
}

export async function validateMobileWorkspacePath(input: {
  workspacePath: string
  allowedWorkspaceRoots: string[]
}): Promise<string> {
  if (!isAbsolute(input.workspacePath)) {
    throw new MobileSwarmCommandError('path_not_allowed', 'Workspace path must be absolute.', false)
  }

  const workspacePath = resolve(input.workspacePath)
  if (!isAllowedWorkspace(input.allowedWorkspaceRoots, workspacePath)) {
    throw new MobileSwarmCommandError('path_not_allowed', 'Workspace path is outside the allowed workspace roots.', false)
  }

  try {
    await access(workspacePath, constants.R_OK | constants.W_OK)
    const workspaceStats = await stat(workspacePath)
    if (!workspaceStats.isDirectory()) {
      throw new MobileSwarmCommandError('path_not_allowed', 'Workspace path must be a directory.', false)
    }
  } catch (error) {
    if (error instanceof MobileSwarmCommandError) throw error
    throw new MobileSwarmCommandError('path_not_allowed', 'Workspace path is not accessible.', false)
  }

  return workspacePath
}

function isAllowedWorkspace(allowedWorkspaceRoots: string[], targetPath: string): boolean {
  return allowedWorkspaceRoots.some((workspaceRoot) => isPathInsideOrEqual(workspaceRoot, targetPath))
}
