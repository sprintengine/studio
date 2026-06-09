import type { BacklogItem, BacklogItemLink, BacklogResolvedLink } from './backlog'
import { normalizeSprintEngineProjection } from './sprintengine'
import type { BacklogLinkProviderInput } from '../modules/renderer-host'
import type { Workspace } from '../types/workspace'

export const SPRINT_ENGINE_MODULE_ID = 'sprint-engine'
export const SPRINT_ENGINE_RUN_TARGET_KIND = 'sprintengine.run'

export type SprintEngineProjectionRead = {
  ok: boolean
  data?: unknown
  message?: string
}

export type SprintEngineBacklogLinkOpenPorts = {
  workspaces: ReadonlyArray<Workspace>
  setActiveWorkspace(workspaceId: string): void
  openRunSummaryOverlay(workspaceId: string): void
  publishDiagnostic?(input: {
    level: 'info' | 'warning' | 'error'
    source: string
    title: string
    message: string
    details?: string
    workspaceId?: string
    workspaceName?: string
  }): Promise<unknown> | unknown
}

function pathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

function safeProjectRelativeRunPath(path: string): string | null {
  const normalized = path.trim().replace(/\\/g, '/').replace(/^\/+/u, '')
  if (
    !normalized
    || path.startsWith('/')
    || path.startsWith('\\\\')
    || /^[A-Za-z]:[\\/]/u.test(path)
    || normalized.split('/').includes('..')
  ) {
    return null
  }
  return /^\.multi-code\/sprintengine\/[^/]+\/run\.yaml$/u.test(normalized) ? normalized : null
}

function joinProjectPath(workspaceRoot: string, relativePath: string): string {
  const separator = workspaceRoot.includes('\\') && !workspaceRoot.includes('/') ? '\\' : '/'
  return `${workspaceRoot.replace(/[\\/]+$/u, '')}${separator}${relativePath.replace(/^[\\/]+/u, '')}`
}

export function sprintEngineRunLinkForItem(item: Pick<BacklogItem, 'links'>): BacklogItemLink | null {
  return item.links.find((link) =>
    link.moduleId === SPRINT_ENGINE_MODULE_ID
    && link.type === 'execution'
    && link.target.kind === SPRINT_ENGINE_RUN_TARGET_KIND
  ) ?? null
}

export function hasSprintEngineRunLink(item: Pick<BacklogItem, 'links'>): boolean {
  return Boolean(sprintEngineRunLinkForItem(item))
}

export function sprintEngineStatePathForBacklogLink(
  workspaceRoot: string,
  link: BacklogItemLink,
): string | null {
  const targetPath = link.target.path?.trim()
  if (link.target.kind !== SPRINT_ENGINE_RUN_TARGET_KIND || !targetPath) return null
  const safeTargetPath = safeProjectRelativeRunPath(targetPath)
  if (!safeTargetPath) return null
  return joinProjectPath(workspaceRoot, safeTargetPath)
}

function unavailableLink(link: BacklogItemLink, reason: string): BacklogResolvedLink {
  return {
    ...link,
    status: 'unknown',
    unavailableReason: reason,
    canOpen: false,
  }
}

function teamSlugFromStatePath(statePath: string): string | undefined {
  const normalized = statePath.replace(/\\/g, '/')
  const match = normalized.match(/(?:^|\/)\.multi-code\/sprintengine\/([^/]+)\/run\.yaml$/u)
  return match?.[1]
}

export async function resolveSprintEngineBacklogLink(
  input: BacklogLinkProviderInput & {
    readSprintEngineProjection(statePath: string): Promise<SprintEngineProjectionRead>
  },
): Promise<BacklogResolvedLink> {
  const statePath = sprintEngineStatePathForBacklogLink(input.workspaceRoot, input.link)
  if (!statePath) {
    return unavailableLink(input.link, 'Sprint Engine run link is missing a project-relative run.yaml target.')
  }

  let projection: SprintEngineProjectionRead
  try {
    projection = await input.readSprintEngineProjection(statePath)
  } catch (error) {
    return unavailableLink(input.link, error instanceof Error ? error.message : String(error))
  }

  if (!projection.ok) {
    return unavailableLink(input.link, projection.message || 'Sprint Engine projection is unavailable.')
  }

  const state = normalizeSprintEngineProjection(projection.data, teamSlugFromStatePath(statePath))
  if (!state) {
    return unavailableLink(input.link, 'Sprint Engine projection is malformed.')
  }

  const status = state.tasks.length > 0 && state.tasks.every((task) => task.status === 'done')
    ? 'completed'
    : 'active'
  return {
    ...input.link,
    status,
    canOpen: true,
  }
}

export async function openSprintEngineBacklogLink(
  input: BacklogLinkProviderInput & { ports: SprintEngineBacklogLinkOpenPorts },
): Promise<boolean> {
  const statePath = sprintEngineStatePathForBacklogLink(input.workspaceRoot, input.link)
  if (!statePath) {
    await input.ports.publishDiagnostic?.({
      level: 'warning',
      source: 'sprintengine',
      title: 'Sprint Engine run unavailable',
      message: 'This Backlog link does not include a project-relative Sprint Engine run target.',
      workspaceId: input.workspaceId,
    })
    return false
  }

  const targetKey = pathKey(statePath)
  const workspace = input.ports.workspaces.find((candidate) =>
    candidate.sprintEngineContext?.statePath
    && pathKey(candidate.sprintEngineContext.statePath) === targetKey
  )

  if (!workspace) {
    await input.ports.publishDiagnostic?.({
      level: 'warning',
      source: 'sprintengine',
      title: 'Sprint Engine run unavailable',
      message: 'No open workspace is mounted for this Sprint Engine run.',
      details: statePath,
      workspaceId: input.workspaceId,
    })
    return false
  }

  input.ports.setActiveWorkspace(workspace.id)
  input.ports.openRunSummaryOverlay(workspace.id)
  return true
}
