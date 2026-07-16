import type { BacklogItem, BacklogItemLink, BacklogResolvedLink } from './backlog'
import { isCanceledSprintEngineRun, isCompletedSprintEngineRun, normalizeSprintEngineProjection } from './sprintengine'
import {
  SPRINT_ENGINE_RUN_TARGET_KIND,
  safeProjectRelativeRunPath,
  sprintEngineRunLinkOf,
  teamSlugFromStatePath,
} from '../../../shared/backlog/sprintengine-links'
import type { BacklogLinkProviderInput } from '../modules/renderer-host'
import type { Workspace } from '../types/workspace'

// The link shapes, ids and builders live in src/shared/backlog/sprintengine-links.ts
// so the main process can write the same links for a phone-driven run, where no
// renderer is mounted to run the projection tick. Re-exported here because every
// existing renderer caller imports them from this module.
export {
  SPRINT_ENGINE_MODULE_ID,
  SPRINT_ENGINE_PR_LINK_ID,
  SPRINT_ENGINE_PR_TARGET_KIND,
  SPRINT_ENGINE_RUN_TARGET_KIND,
  buildSprintEnginePullRequestLink,
  buildSprintEngineRunLink,
  sprintEngineRunLinkId,
} from '../../../shared/backlog/sprintengine-links'

export type SprintEngineProjectionRead = {
  ok: boolean
  data?: unknown
  message?: string
}

export type SprintEngineBacklogLinkOpenPorts = {
  workspaces: ReadonlyArray<Workspace>
  setActiveWorkspace(workspaceId: string): void
  openRunSummaryOverlay(workspaceId: string): void
  mountWorkspaceForRun?(input: {
    workspaceRoot: string
    statePath: string
    teamSlug: string
    link: BacklogItemLink
  }): Promise<Workspace | null> | Workspace | null
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

function joinProjectPath(workspaceRoot: string, relativePath: string): string {
  const separator = workspaceRoot.includes('\\') && !workspaceRoot.includes('/') ? '\\' : '/'
  return `${workspaceRoot.replace(/[\\/]+$/u, '')}${separator}${relativePath.replace(/^[\\/]+/u, '')}`
}

export function sprintEngineRunLinkForItem(item: Pick<BacklogItem, 'links'>): BacklogItemLink | null {
  return sprintEngineRunLinkOf(item.links)
}

export function hasSprintEngineRunLink(item: Pick<BacklogItem, 'links'>): boolean {
  return Boolean(sprintEngineRunLinkForItem(item))
}

// The open workspace whose live Sprint Engine run backs this Backlog run link,
// matched by run.yaml state path (same correspondence `openSprintEngineBacklogLink`
// uses). Returns null when no open workspace is mounted on that run — in which
// case the run's live running/paused state simply is not observable here.
export function matchWorkspaceForBacklogRunLink(
  workspaces: ReadonlyArray<Workspace>,
  workspaceRoot: string,
  link: BacklogItemLink,
): Workspace | null {
  const statePath = sprintEngineStatePathForBacklogLink(workspaceRoot, link)
  if (!statePath) return null
  const targetKey = pathKey(statePath)
  return (
    workspaces.find(
      (workspace) =>
        workspace.sprintEngineContext?.statePath
        && pathKey(workspace.sprintEngineContext.statePath) === targetKey,
    ) ?? null
  )
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

export async function resolveSprintEngineBacklogLink(
  input: BacklogLinkProviderInput & {
    readSprintEngineProjection(statePath: string): Promise<SprintEngineProjectionRead>
  },
): Promise<BacklogResolvedLink> {
  const statePath = sprintEngineStatePathForBacklogLink(input.workspaceRoot, input.link)
  if (!statePath) {
    return unavailableLink(input.link, 'Sprint run link is missing a project-relative run.yaml target.')
  }

  let projection: SprintEngineProjectionRead
  try {
    projection = await input.readSprintEngineProjection(statePath)
  } catch (error) {
    return unavailableLink(input.link, error instanceof Error ? error.message : String(error))
  }

  if (!projection.ok) {
    return unavailableLink(input.link, projection.message || 'Sprint projection is unavailable.')
  }

  const state = normalizeSprintEngineProjection(projection.data, teamSlugFromStatePath(statePath))
  if (!state) {
    return unavailableLink(input.link, 'Sprint projection is malformed.')
  }

  // Cancellation is a decided terminal that outranks completeness: a canceled
  // run's non-done tasks are all `canceled`, never `done`, so it is not
  // `completed` — but it must read as Canceled, not fall back to Active.
  const status = isCanceledSprintEngineRun(state)
    ? 'canceled'
    : isCompletedSprintEngineRun(state)
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
      title: 'Sprint run unavailable',
      message: 'This Backlog link does not include a project-relative sprint run target.',
      workspaceId: input.workspaceId,
    })
    return false
  }

  const targetKey = pathKey(statePath)
  let workspace = input.ports.workspaces.find((candidate) =>
    candidate.sprintEngineContext?.statePath
    && pathKey(candidate.sprintEngineContext.statePath) === targetKey
  )

  if (!workspace && input.ports.mountWorkspaceForRun) {
    try {
      workspace = await input.ports.mountWorkspaceForRun({
        workspaceRoot: input.workspaceRoot,
        statePath,
        teamSlug: teamSlugFromStatePath(statePath) ?? input.link.target.id,
        link: input.link,
      }) ?? undefined
    } catch (error) {
      await input.ports.publishDiagnostic?.({
        level: 'warning',
        source: 'sprintengine',
        title: 'Sprint run unavailable',
        message: 'Could not mount this sprint run as a workspace.',
        details: [
          statePath,
          error instanceof Error ? error.message : String(error),
        ].filter(Boolean).join('\n'),
        workspaceId: input.workspaceId,
      })
      return false
    }
  }

  if (!workspace) {
    await input.ports.publishDiagnostic?.({
      level: 'warning',
      source: 'sprintengine',
      title: 'Sprint run unavailable',
      message: 'No open workspace is mounted for this sprint run.',
      details: statePath,
      workspaceId: input.workspaceId,
    })
    return false
  }

  input.ports.setActiveWorkspace(workspace.id)
  input.ports.openRunSummaryOverlay(workspace.id)
  return true
}

// Resolve the PR link: openable whenever it carries a URL. The PR is an opened
// GitHub artifact, not a local run store, so there is nothing to mount — the
// link just points at the URL.
export function resolveSprintEnginePullRequestLink(
  input: BacklogLinkProviderInput,
): BacklogResolvedLink {
  const url = input.link.target.url?.trim()
  if (!url) {
    return {
      ...input.link,
      status: 'unknown',
      canOpen: false,
      unavailableReason: 'This pull request link has no URL.',
    }
  }
  return { ...input.link, status: 'active', canOpen: true }
}
