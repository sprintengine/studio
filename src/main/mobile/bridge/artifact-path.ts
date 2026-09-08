import { isAbsolute, resolve } from 'path'
import { isPathInsideOrEqual } from '../../path-containment'

export function resolveArtifactPathForRead(teamDirectory: string, workspacePath: string, artifactPathInput: string): string {
  const artifactPath = artifactPathInput.trim()
  if (!artifactPath || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(artifactPath)) {
    throw new Error('Artifact path must be a workspace file path.')
  }

  const fullPath = isAbsolute(artifactPath)
    ? resolve(artifactPath)
    : [
        resolve(workspacePath, artifactPath),
        resolve(teamDirectory, artifactPath),
      ].find((candidate) => isPathInsideOrEqual(teamDirectory, candidate))
        ?? resolve(workspacePath, artifactPath)

  if (!isPathInsideOrEqual(teamDirectory, fullPath)) {
    throw new Error('Artifact path must stay inside the sprint team directory.')
  }

  return fullPath
}

