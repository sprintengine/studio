import type { BacklogItem, BacklogItemLink, BacklogItemLinkStatus, BacklogResolvedLink } from './backlog'
import {
  deriveSprintEngineRepoMergeRollup,
  isCanceledSprintEngineRun,
  isCompletedSprintEngineRun,
  normalizeSprintEngineProjection,
} from './sprintengine'
import {
  SPRINT_ENGINE_RUN_TARGET_KIND,
  isSprintEngineChildRunLink,
  safeProjectRelativeRunPath,
  sprintEngineRunLinkOf,
  teamSlugFromStatePath,
} from '../../../shared/backlog/sprintengine-links'
import type { BacklogLinkProviderInput } from '../modules/renderer-host'
import type { SprintEngineState, Workspace } from '../types/workspace'

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
  isSprintEngineChildRunLink,
  runRelativePathForStatePath,
  sprintEnginePullRequestLinkId,
  sprintEnginePullRequestLinksOf,
  sprintEngineRepoDisplayName,
  sprintEngineRunLinkId,
} from '../../../shared/backlog/sprintengine-links'

/**
 * Whether a run has LANDED: finished, and every branch it delivered merged.
 *
 * This is the completion a Backlog item is allowed to read — there is no point
 * marking an item completed while its work sits unmerged on a branch (MC-2017).
 * It composes the two canonical predicates rather than re-deriving either: task
 * completeness (`isCompletedSprintEngineRun`) and the cross-repo merge rollup
 * (`deriveSprintEngineRepoMergeRollup().allMerged`, MC-1613), so a run spanning
 * projects only lands when its LAST branch does.
 *
 * A run with no worktree has no branch to merge — its work is already on the
 * checkout branch — so completion is landing. Same rule the run-landed automation
 * trigger applies (src/main/automations/triggers/sprint-engine-run-landed.ts).
 */
export function isLandedSprintEngineRun(state: SprintEngineState): boolean {
  if (isCanceledSprintEngineRun(state) || !isCompletedSprintEngineRun(state)) return false
  if (state.vcs?.mode !== 'run_worktree') return true
  return deriveSprintEngineRepoMergeRollup(state.vcs)?.allMerged === true
}

/**
 * The live status of one epic-child run link, and the task it is bound to.
 *
 * A child link tracks ITS TASK, not the whole run — that is what makes the fan-out
 * task-accurate, so a child whose task has not started is not prematurely moved
 * (MC-2017). The task is bound by `backlogRef`: the planner mints one task per
 * child pointing back at the child's file, and the binding is cached onto
 * `target.taskId` by the first tick that sees it.
 *
 * The `done` case is the point of the whole item: a finished task whose run has
 * not landed keeps its child `active` (reading `in_progress`), because the work is
 * still only on a branch.
 */
export function resolveSprintEngineChildRunLink(input: {
  state: SprintEngineState
  link: Pick<BacklogItemLink, 'target'>
  itemRelativePath: string
}): { status: BacklogItemLinkStatus; taskId?: string } {
  const itemKey = pathKey(input.itemRelativePath)
  const taskId = input.link.target.taskId
    ?? input.state.tasks.find(
      (task) => task.backlogRef && pathKey(task.backlogRef.projectRelativePath) === itemKey,
    )?.id
  // Run-level cancellation is decided for every child at once and outranks
  // whatever their individual tasks say.
  if (isCanceledSprintEngineRun(input.state)) return { status: 'canceled', ...(taskId ? { taskId } : {}) }

  const task = taskId ? input.state.tasks.find((candidate) => candidate.id === taskId) : undefined
  // No task yet: the planner has not minted this child's task, so nothing has
  // claimed it and the link stays recorded-but-not-started.
  if (!task) return { status: 'pending', ...(taskId ? { taskId } : {}) }
  if (task.status === 'canceled') return { status: 'canceled', taskId }
  if (task.status === 'todo') return { status: 'pending', taskId }
  // The engine's `review` phase is an implementation detail of how the sprint
  // runs, not a human review gate, so it reads as ordinary work in progress.
  if (task.status !== 'done') return { status: 'active', taskId }
  return { status: isLandedSprintEngineRun(input.state) ? 'completed' : 'active', taskId }
}

export type SprintEngineProjectionRead = {
  ok: boolean
  data?: unknown
  message?: string
}

export type SprintEngineBacklogLinkOpenPorts = {
  /**
   * Open the Sprints door on this run. Resolves false when the run's store could
   * not be read, so the caller can say so instead of dropping the operator on a
   * door that quietly opened on some other sprint.
   */
  openSprintsDoorOnRun(statePath: string): Promise<boolean> | boolean
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

  // An epic child tracks its own task, not the run: it must not read Active
  // before its task claims, nor Completed while the run sits unmerged. Resolving
  // it here — and not only in the projection tick that writes it — is what stops
  // the Backlog surface's sync pass from overwriting a child's per-task status
  // with the run-level one.
  if (isSprintEngineChildRunLink(input.link)) {
    const child = resolveSprintEngineChildRunLink({
      state,
      link: input.link,
      itemRelativePath: input.item.relativePath,
    })
    return {
      ...input.link,
      ...(child.taskId ? { target: { ...input.link.target, taskId: child.taskId } } : {}),
      status: child.status,
      canOpen: true,
    }
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

// Open a Backlog `sprintengine.run` link: the Sprints door, on that run
// (item 1767).
//
// This used to find-or-mount a workspace for the run and activate it, because a
// run could only be read through a workspace. The door reads runs from disk by
// state path, so there is nothing to mount — and mounting would have created a
// workspace (and its terminals) for someone who only wanted to look. A run whose
// workspace was never opened, or was closed long ago, now opens exactly like a
// live one.
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

  if (await input.ports.openSprintsDoorOnRun(statePath)) return true

  await input.ports.publishDiagnostic?.({
    level: 'warning',
    source: 'sprintengine',
    title: 'Sprint run unavailable',
    message: 'This sprint’s stored run could not be read, so there is nothing to open.',
    details: statePath,
    workspaceId: input.workspaceId,
  })
  return false
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
