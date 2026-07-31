// Backlog <-> Sprint Engine run <-> pull request linking, written from the main
// process (MC-1493 id 34).
//
// The renderer has always written these links — the workspace-creation flow
// records the execution link, and the projection tick attaches the PR link. Both
// only run with a desktop window mounted on the workspace. A phone-started run
// has nobody at the desktop, so for it neither link was ever written: the item
// never learned which run was working it, and the PR never reached the item.
//
// These writers close that hole. They are the same link shapes the renderer
// builds (src/shared/backlog/sprintengine-links.ts is the single source), so a
// link written here is indistinguishable from one the desktop wrote.

import { realpath } from 'fs/promises'

import { addOrUpdateBacklogLink, isBacklogEpicRelativePath, readBacklogObjectStore } from './backlog-service'
import {
  buildSprintEnginePullRequestLink,
  buildSprintEngineRunLink,
  isSprintEngineChildRunLink,
  runRelativePathForStatePath,
  safeProjectRelativeRunPath,
  sprintEnginePullRequestLinksOf,
  teamSlugFromStatePath,
} from '../shared/backlog/sprintengine-links'
import type { BacklogItemStatusPayload } from '../shared/electron-api'

export type SprintEngineLinkWriteResult = { ok: true } | { ok: false; message: string }

function pathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

// Resolve symlinks, falling back to the input when the path does not exist.
async function realPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

/**
 * The workspace root and the run's state path reach us by different routes, and
 * they do not have to agree about symlinks. The engine fully resolves the state
 * path on its way out (`state_path.resolve()` in Python); the workspace root
 * arrives from the command payload merely normalized. On macOS that alone is
 * enough to split them — `/var` is a symlink to `/private/var`.
 *
 * A failed containment test is not a cosmetic problem: it means no execution
 * link, and the execution link is the only backlog->run correspondence there is.
 * The item would silently lose its status, its run reference, and later its pull
 * request — the whole point of the feature.
 *
 * So try the root as given, then try it resolved. Deliberately does NOT resolve
 * the state path itself: run.yaml may not be on disk (a caller may be linking a
 * run it has only just been told about), and a missing file must not be mistaken
 * for a path outside the workspace.
 */
async function resolveRunRelativePath(workspaceRoot: string, statePath: string): Promise<string | null> {
  const direct = runRelativePathForStatePath(workspaceRoot, statePath)
  if (direct) return direct
  const resolved = await realPath(workspaceRoot)
  return resolved === workspaceRoot ? null : runRelativePathForStatePath(resolved, statePath)
}

/**
 * Record the run -> item execution link on the originating Backlog item and move
 * it to `in_progress`, mirroring the desktop creation flow.
 *
 * This link is load-bearing, not bookkeeping: it is the ONLY backlog->run
 * correspondence that exists, and `attachSprintEnginePullRequestLink` finds the
 * originating item by scanning for it. No execution link, no PR link, ever.
 *
 * `childRelativePaths` are the launched epic's children. They get the same run
 * link, recorded `pending` and remembering the status they held (MC-2017): a
 * child moves to `in_progress` when its own task claims, lands only when the
 * sprint does, and goes back to `priorStatus` if the sprint is abandoned. This
 * writer must stay identical to the desktop one — a phone-started epic and a
 * desktop-started one are the same run, and the projection tick that drives these
 * links cannot tell (or care) which wrote them.
 */
export async function recordSprintEngineExecutionLink(input: {
  workspaceRoot: string
  relativePath: string
  statePath: string
  childRelativePaths?: readonly { relativePath: string; status: BacklogItemStatusPayload }[]
}): Promise<SprintEngineLinkWriteResult> {
  const runRelativePath = await resolveRunRelativePath(input.workspaceRoot, input.statePath)
  const teamSlug = teamSlugFromStatePath(input.statePath)
  if (!runRelativePath || !teamSlug) {
    return {
      ok: false,
      message: `Sprint Engine run path ${input.statePath} is not a run.yaml inside the workspace; no execution link written.`,
    }
  }

  // An epic derives its status from its children and is never written one. A
  // launch that fans out to children IS an epic launch, whatever the file is
  // called — the caller only resolves children for an epic — so that, not the
  // `backlog/epics/` path alone, is what decides.
  const isEpicSource =
    (input.childRelativePaths?.length ?? 0) > 0 || isBacklogEpicRelativePath(input.relativePath)
  const linked = await addOrUpdateBacklogLink({
    workspaceRoot: input.workspaceRoot,
    relativePath: input.relativePath,
    link: buildSprintEngineRunLink({ teamSlug, runRelativePath }),
    ...(isEpicSource ? {} : { status: 'in_progress' as const }),
  })
  if (!linked.ok) return linked

  for (const child of input.childRelativePaths ?? []) {
    const childResult = await addOrUpdateBacklogLink({
      workspaceRoot: input.workspaceRoot,
      relativePath: child.relativePath,
      link: buildSprintEngineRunLink({
        teamSlug,
        runRelativePath,
        status: 'pending',
        priorStatus: child.status,
      }),
    })
    if (!childResult.ok) return childResult
  }

  return { ok: true }
}

/** One project's pull request, as the item should link it. */
export type SprintEnginePullRequestLinkInput = {
  /** Declared repo id; `primary` (or omitted) keeps the original bare link id. */
  repoId?: string
  url: string
  /** Project name shown in the link label; omitted for a single-project run. */
  repoLabel?: string
}

/**
 * Attach a run's pull requests to the Backlog item that started it — one link per
 * project the run delivered (MC-1612).
 *
 * There is no reverse index from a run to its item, so the item is found the way
 * the renderer's projection tick finds it: scan the object store for a record
 * whose execution link resolves to this run's run.yaml. A no-op when nothing
 * links to the run (a run started outside the Backlog has no item to carry a PR)
 * and when the same URL is already attached for that project, so repeat calls do
 * not churn the store.
 *
 * The PR links are `external` and therefore lifecycle-neutral: attaching them
 * never moves the item's status. Completion is the run's business, not the PR's.
 *
 * Every item linking this run gets them, not just the first. Normally that is
 * exactly one item, but if two genuinely share a run they should both show its
 * pull requests — silently stopping at the first would be the surprising choice.
 */
export async function attachSprintEnginePullRequestLink(input: {
  workspaceRoot: string
  statePath: string
  pullRequests: readonly SprintEnginePullRequestLinkInput[]
  now?: () => Date
}): Promise<SprintEngineLinkWriteResult> {
  const pullRequests = input.pullRequests
    .map((pullRequest) => ({ ...pullRequest, url: pullRequest.url.trim() }))
    .filter((pullRequest) => pullRequest.url)
  if (!pullRequests.length) return { ok: false, message: 'A pull request link needs a URL.' }

  const store = await readBacklogObjectStore(input.workspaceRoot)
  if (!store.ok) return store

  // Same symlink hazard as the execution write (see resolveRunRelativePath): the
  // stored link is relative to the workspace root, but the run's state path may be
  // fully resolved. Accept a match against the root either as given or resolved.
  const roots = new Set([pathKey(input.workspaceRoot), pathKey(await realPath(input.workspaceRoot))])
  const targetKey = pathKey(input.statePath)
  const updatedAt = (input.now?.() ?? new Date()).toISOString()

  for (const record of store.store.items) {
    const matched = (record.links ?? []).some((link) => {
      // An epic child links the same run, but the pull request belongs to the
      // sprint and one copy on the launched epic is where a person looks for it —
      // the renderer's projection tick draws the same line (MC-2017).
      if (link.type !== 'execution' || isSprintEngineChildRunLink(link)) return false
      const linkPath = link.target.path ? safeProjectRelativeRunPath(link.target.path) : null
      if (!linkPath) return false
      return [...roots].some((root) => `${root}/${pathKey(linkPath)}` === targetKey)
    })
    if (!matched) continue

    const existing = new Map(
      sprintEnginePullRequestLinksOf(record.links ?? []).map((link) => [link.id, link.target.url]),
    )
    for (const pullRequest of pullRequests) {
      const link = buildSprintEnginePullRequestLink({
        pullRequestUrl: pullRequest.url,
        updatedAt,
        repoId: pullRequest.repoId,
        repoLabel: pullRequest.repoLabel,
      })
      // Same URL already attached for this project: nothing to write.
      if (existing.get(link.id) === pullRequest.url) continue
      const result = await addOrUpdateBacklogLink({
        workspaceRoot: input.workspaceRoot,
        relativePath: record.source.relativePath,
        link,
      })
      if (!result.ok) return result
    }
  }

  return { ok: true }
}
