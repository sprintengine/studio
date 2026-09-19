import { constants } from 'fs'
import { access, stat } from 'fs/promises'
import { isAbsolute, resolve } from 'path'
import { MobileControlCommandError } from './command-error'
import { isPathInsideOrEqual } from './path-utils'
import { isWorkspaceIdToken, resolveWorkspaceIdToRoot } from './workspace-id'

export async function validateMobileWorkspacePath(input: {
  workspacePath: string
  allowedWorkspaceRoots: string[]
  // Candidate roots a workspace token may resolve to. Defaults to the allowed
  // roots; a caller may widen it so workspaces nested under a configured parent
  // root still resolve.
  workspaceRootCandidates?: string[]
}): Promise<string> {
  // The phone receives a relay-safe workspace token in place of the absolute root
  // (the relay forbids local paths in snapshots), so reverse it before
  // validating. A real absolute path is still accepted for backward compatibility.
  let requestedPath = input.workspacePath
  if (isWorkspaceIdToken(requestedPath)) {
    const resolvedRoot = resolveWorkspaceIdToRoot(
      requestedPath,
      input.workspaceRootCandidates ?? input.allowedWorkspaceRoots,
    )
    if (!resolvedRoot) {
      throw new MobileControlCommandError('path_not_allowed', 'Workspace is not available on this desktop.', false)
    }
    requestedPath = resolvedRoot
  }

  if (!isAbsolute(requestedPath)) {
    throw new MobileControlCommandError('path_not_allowed', 'Workspace path must be absolute.', false)
  }

  const workspacePath = resolve(requestedPath)
  if (!isAllowedWorkspace(input.allowedWorkspaceRoots, workspacePath)) {
    throw new MobileControlCommandError(
      'path_not_allowed',
      'Workspace path is outside the allowed workspace roots.',
      false,
    )
  }

  try {
    await access(workspacePath, constants.R_OK | constants.W_OK)
    const workspaceStats = await stat(workspacePath)
    if (!workspaceStats.isDirectory()) {
      throw new MobileControlCommandError('path_not_allowed', 'Workspace path must be a directory.', false)
    }
  } catch (error) {
    if (error instanceof MobileControlCommandError) throw error
    throw new MobileControlCommandError('path_not_allowed', 'Workspace path is not accessible.', false)
  }

  return workspacePath
}

function isAllowedWorkspace(allowedWorkspaceRoots: string[], targetPath: string): boolean {
  return allowedWorkspaceRoots.some((workspaceRoot) => isPathInsideOrEqual(workspaceRoot, targetPath))
}
