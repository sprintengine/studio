export type ProjectKnowledgeConfig = {
  projectRoot: string
  relativeRoot: string
  inherited: boolean
}

export function normalizeProjectRootKey(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/u, '')
  return normalized || null
}

function pathKey(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

function isPathInsideOrEqual(parentPath: string, childPath: string): boolean {
  const parent = pathKey(parentPath)
  const child = pathKey(childPath)
  return child === parent || child.startsWith(`${parent}/`)
}

export function resolveProjectKnowledgeConfig(
  workspaceRoot: string | null | undefined,
  projectKnowledgeRoots: Record<string, string | null> | null | undefined,
  workspaceRelativeRoot?: string | null
): ProjectKnowledgeConfig | null {
  const workspaceKey = normalizeProjectRootKey(workspaceRoot)
  if (!workspaceKey) return null

  let best: ProjectKnowledgeConfig | null = null
  for (const [projectRoot, relativeRoot] of Object.entries(projectKnowledgeRoots ?? {})) {
    const normalizedProjectRoot = normalizeProjectRootKey(projectRoot)
    if (!normalizedProjectRoot || !relativeRoot || !isPathInsideOrEqual(normalizedProjectRoot, workspaceKey)) continue
    if (!best || normalizedProjectRoot.length > best.projectRoot.length) {
      best = {
        projectRoot: normalizedProjectRoot,
        relativeRoot,
        inherited: pathKey(normalizedProjectRoot) !== pathKey(workspaceKey),
      }
    }
  }

  if (best) return best
  if (!workspaceRelativeRoot) return null

  return {
    projectRoot: workspaceKey,
    relativeRoot: workspaceRelativeRoot,
    inherited: false,
  }
}
