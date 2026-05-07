import { isAbsolute, resolve } from 'path'
import { MobileSwarmCommandError } from './command-error'
import { isPathInsideOrEqual } from './path-utils'
import type { ValidSwarmStatePath } from './state-path'

export function resolveSprintEngineArtifactFilePath(
  state: ValidSwarmStatePath,
  artifactPathInput: string
): string {
  const artifactPath = artifactPathInput.trim()
  if (!artifactPath) {
    throw new MobileSwarmCommandError('path_not_allowed', 'Artifact path is required.', false)
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(artifactPath)) {
    throw new MobileSwarmCommandError('path_not_allowed', 'Artifact path must be a workspace file path.', false)
  }

  const fullPath = isAbsolute(artifactPath)
    ? resolve(artifactPath)
    : [
        resolve(state.workspaceRoot, artifactPath),
        resolve(state.teamDirectory, artifactPath),
      ].find((candidate) => isPathInsideOrEqual(state.teamDirectory, candidate))
        ?? resolve(state.workspaceRoot, artifactPath)

  if (!isPathInsideOrEqual(state.teamDirectory, fullPath)) {
    throw new MobileSwarmCommandError('path_not_allowed', 'Artifact path must stay inside the Sprint Engine team directory.', false)
  }

  return fullPath
}
