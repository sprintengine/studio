import {
  getRunDirectoryPath,
  getRunStateFilePath,
  slugifyRunName,
  type RunKind,
} from './run-state-file'

export type RunWorkspaceContext = {
  name: string
  slug: string
  directoryPath: string
  statePath: string
}

/**
 * Derive the workspace-creation context Sprint Engine uses:
 * slug + directory + state-file path under the run's project-relative root.
 * Domain-specific creation flows wrap this and attach their own state shape,
 * prompt builders, and registration logic.
 */
export function buildRunWorkspaceContext(input: {
  kind: RunKind
  rootPath: string
  name: string
}): RunWorkspaceContext {
  const trimmedRoot = input.rootPath.trim()
  const trimmedName = input.name.trim()
  const slug = slugifyRunName(input.kind, trimmedName)
  return {
    name: trimmedName,
    slug,
    directoryPath: getRunDirectoryPath(trimmedRoot, input.kind, slug),
    statePath: getRunStateFilePath(trimmedRoot, input.kind, slug),
  }
}
