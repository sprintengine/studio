/**
 * Project Knowledge root resolution, shared by the renderer and the main
 * process.
 *
 * Relocated verbatim from `src/renderer/src/utils/projectKnowledge.ts` when the
 * main process began composing launches of its own. The renderer file remains
 * as a re-export shim, so every existing import site and test keeps working
 * unchanged.
 */
import type { MemoryRootStatus } from './electron-api'
import { basename } from './paths'

/**
 * What a launch needs from the resolved Knowledge Graph root: the env vars that
 * tell the agent's tooling where the graph is, and the sentence that tells the
 * AGENT it exists.
 *
 * That sentence is no longer appended to the user's prompt. It is the knowledge
 * section of the host-context document (`src/shared/host-context/document.ts`),
 * which main builds once per launch and the CLI manifest delivers out of band —
 * the wording here is still the single source of it.
 */
export type KnowledgeLaunchContext = {
  rootPath?: string
  relativeRoot?: string
  promptSuffix: string | null
}

/**
 * Turn a resolved root into launch inputs. Shared because both launch paths
 * compose it: `TerminalView` for an interactively-spawned agent, and the
 * main-process AgentLaunchService for one launched with no window —
 * which must not silently drop the graph just because nobody is watching.
 *
 * An UNRESOLVABLE configured root still yields a line. Saying nothing would
 * leave the agent to guess another knowledge folder, which is exactly the
 * invention the line forbids.
 */
export function knowledgeLaunchContext(status: MemoryRootStatus): KnowledgeLaunchContext {
  if (status.ok) {
    return {
      rootPath: status.rootPath,
      relativeRoot: status.relativeRoot,
      promptSuffix: [
        `Knowledge Graph is configured at ${status.relativeRoot}.`,
        'This is a repo-local Markdown knowledge graph for product, architecture, brand, and ecosystem context.',
        'Inspect it when relevant instead of assuming project context.',
        'Use the workspace-knowledge skill if it is installed in .agents/skills.',
      ].join(' '),
    }
  }
  return {
    rootPath: undefined,
    ...(status.relativeRoot ? { relativeRoot: status.relativeRoot } : {}),
    promptSuffix: status.relativeRoot
      ? `Knowledge Graph is configured at ${status.relativeRoot}, but the folder is currently missing or inaccessible. Do not guess another knowledge folder.`
      : null,
  }
}

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
  workspaceRelativeRoot?: string | null,
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
    common < from.parts.length &&
    common < to.parts.length &&
    from.parts[common].toLowerCase() === to.parts[common].toLowerCase()
  ) {
    common += 1
  }

  return [...from.parts.slice(common).map(() => '..'), ...to.parts.slice(common)].join('/') || '.'
}

/**
 * Distinct projects across the given open workspaces, deduped by resolved
 * project root. A workspace that inherits a configured ancestor collapses onto
 * that ancestor; an unconfigured workspace stands as its own project. Sorted by
 * display name.
 */
export function listOpenProjectKnowledge(
  workspaces: ReadonlyArray<{
    folderPath: string | null
    memory?: { relativeRoot: string | null } | null
  }>,
  projectKnowledgeRoots: Record<string, string | null> | null | undefined,
): ProjectKnowledgeEntry[] {
  const byKey = new Map<string, ProjectKnowledgeEntry>()

  for (const workspace of workspaces) {
    const config = resolveProjectKnowledgeConfig(
      workspace.folderPath,
      projectKnowledgeRoots,
      workspace.memory?.relativeRoot,
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
