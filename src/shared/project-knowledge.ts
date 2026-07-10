/**
 * Project Knowledge root resolution, shared by the renderer and the main
 * process.
 *
 * Relocated verbatim from `src/renderer/src/utils/projectKnowledge.ts`
 * (sprint-runtime-ownership Phase 2: the main process shares the pure Sprint
 * Engine corpus), following the established shim pattern
 * (`sprintengineAutomationLifecycle.ts`). The renderer file remains as a
 * re-export shim, so every existing import site and test keeps working
 * unchanged.
 */
import { basename } from './paths'

export type ProjectKnowledgeConfig = {
  projectRoot: string
  relativeRoot: string
  inherited: boolean
}

/** One open project (deduped across its workspaces) for the Knowledge Graph settings list. */
export type ProjectKnowledgeEntry = {
  /** Lowercased project-root path; stable React key + dedupe key. */
  key: string
  /** Project-root path with original casing, for display. */
  projectRoot: string
  /** Final path segment of `projectRoot` (e.g. `multicode`). */
  name: string
  /** Configured knowledge folder relative to `projectRoot`, or null when unconfigured. */
  relativeRoot: string | null
  /** Number of open workspaces that resolve to this project. */
  workspaceCount: number
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

function normalizePathParts(value: string): { drive: string | null; parts: string[] } {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/u, '')
  const driveMatch = normalized.match(/^([A-Za-z]:)\/(.*)$/)
  if (driveMatch) {
    return {
      drive: driveMatch[1].toLowerCase(),
      parts: driveMatch[2].split('/').filter(Boolean),
    }
  }
  return {
    drive: null,
    parts: normalized.split('/').filter(Boolean),
  }
}

/**
 * Path of `toPath` expressed relative to `fromPath` (POSIX separators).
 * Returns null when the two paths live on different Windows drives (no
 * relative path exists) and `.` when they are the same directory.
 */
export function relativePathBetween(fromPath: string, toPath: string): string | null {
  const from = normalizePathParts(fromPath)
  const to = normalizePathParts(toPath)
  if (from.drive !== to.drive) return null

  let common = 0
  while (
    common < from.parts.length
    && common < to.parts.length
    && from.parts[common].toLowerCase() === to.parts[common].toLowerCase()
  ) {
    common += 1
  }

  return [
    ...from.parts.slice(common).map(() => '..'),
    ...to.parts.slice(common),
  ].join('/') || '.'
}

/**
 * Distinct projects across the given open workspaces, deduped by resolved
 * project root. Sprint Engine / Multiloop workspaces that inherit a configured
 * ancestor collapse onto that ancestor; unconfigured workspaces stand as their
 * own project. Sorted by display name.
 */
export function listOpenProjectKnowledge(
  workspaces: ReadonlyArray<{
    folderPath: string | null
    memory?: { relativeRoot: string | null } | null
  }>,
  projectKnowledgeRoots: Record<string, string | null> | null | undefined
): ProjectKnowledgeEntry[] {
  const byKey = new Map<string, ProjectKnowledgeEntry>()

  for (const workspace of workspaces) {
    const config = resolveProjectKnowledgeConfig(
      workspace.folderPath,
      projectKnowledgeRoots,
      workspace.memory?.relativeRoot
    )
    const projectRoot = config?.projectRoot ?? normalizeProjectRootKey(workspace.folderPath)
    if (!projectRoot) continue

    const key = projectRoot.toLowerCase()
    const existing = byKey.get(key)
    if (existing) {
      existing.workspaceCount += 1
      if (!existing.relativeRoot && config?.relativeRoot) existing.relativeRoot = config.relativeRoot
      continue
    }

    byKey.set(key, {
      key,
      projectRoot,
      name: basename(projectRoot),
      relativeRoot: config?.relativeRoot ?? null,
      workspaceCount: 1,
    })
  }

  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name))
}
