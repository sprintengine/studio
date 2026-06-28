import { isAbsolute, relative, resolve, sep } from 'path'

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

function isPathInsideOrEqual(parentPath: string, targetPath: string): boolean {
  const relativePath = relative(resolve(parentPath), resolve(targetPath))
  return (
    relativePath === ''
    || (!relativePath.startsWith('..') && !isAbsolute(relativePath) && !relativePath.split(sep).includes('..'))
  )
}
