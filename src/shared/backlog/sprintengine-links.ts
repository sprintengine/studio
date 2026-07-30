// The Sprint Engine Backlog link shapes, single-sourced for every writer: the
// renderer's workspace-creation flow and projection refresh, and the mobile
// command path in the main process (a phone-driven run has nobody at the
// desktop, so the renderer's projection tick never runs for it). Pure and
// node-free (tsconfig.web-safe), mirroring src/shared/backlog/agent-links.ts.
//
// The renderer-only halves — resolving a link against mounted workspaces and
// opening one — stay in src/renderer/src/utils/sprintengineBacklogLinks.ts,
// which re-exports everything here so there is exactly one implementation.

// Type-only, so this module stays node-free: the Backlog lifecycle vocabulary a
// child link remembers in `priorStatus`. Imported rather than re-spelled because
// a third copy of the status union would drift from the two that already mirror
// each other.
import type { BacklogItemStatusPayload } from '../electron-api'

export const SPRINT_ENGINE_MODULE_ID = 'sprint-engine'
export const SPRINT_ENGINE_RUN_TARGET_KIND = 'sprintengine.run'
export const SPRINT_ENGINE_PR_TARGET_KIND = 'sprintengine.pullRequest'
// Fixed id so the PR link is idempotent per item: re-running a sprint replaces
// the link rather than accumulating stale ones (mirrors the agent-runtime
// `agent-runtime:working-agent` most-recent-wins convention).
//
// This is the PRIMARY project's id. A run spanning projects opens one pull
// request per project (MC-1612) and the item carries one link per project, so a
// sibling's id is suffixed with its repo id — see `sprintEnginePullRequestLinkId`.
// The primary keeps the bare id it has always had, which is what makes a
// single-repo run's one link identical to the one it wrote before this existed.
export const SPRINT_ENGINE_PR_LINK_ID = 'sprint-engine:pull-request'

// The primary repo's declared id. Mirrors `DEFAULT_SPRINTENGINE_TASK_REPO`
// (src/shared/sprintengine/run-types.ts), re-spelled here to keep this module
// node-free and dependency-free.
const PRIMARY_REPO_ID = 'primary'

// One link id per project. The primary's is the bare, unchanged id (a single-repo
// run must keep writing exactly the link it always wrote); each sibling gets its
// own, so its pull request replaces only itself on a re-run.
export function sprintEnginePullRequestLinkId(repoId?: string): string {
  const id = (repoId ?? '').trim()
  return !id || id === PRIMARY_REPO_ID ? SPRINT_ENGINE_PR_LINK_ID : `${SPRINT_ENGINE_PR_LINK_ID}:${id}`
}

// Structural shapes of the built links; assignable to both the renderer's
// BacklogItemLink and the main-process BacklogItemLinkPayload.
export type SprintEngineRunBacklogLink = {
  id: string
  moduleId: string
  type: 'execution'
  label: string
  target: { kind: string; id: string; path: string; taskId?: string }
  status: 'active' | 'pending'
  priorStatus?: BacklogItemStatusPayload
}

export type SprintEnginePullRequestBacklogLink = {
  id: string
  moduleId: string
  type: 'external'
  label: string
  target: { kind: string; id: string; url: string }
  status: 'active'
  updatedAt: string
}

// Per-run link id: one item can only be executing one run per team slug, and a
// re-run of the same team replaces its link rather than stacking a duplicate.
export function sprintEngineRunLinkId(teamSlug: string): string {
  return `${SPRINT_ENGINE_MODULE_ID}:${teamSlug}`
}

// The execution link recorded on the originating Backlog item when a run starts.
// `target.path` must be the project-relative run.yaml — `addOrUpdateBacklogLink`
// rejects an absolute one, and every reader resolves it back through
// `safeProjectRelativeRunPath`.
//
// An epic launch records the same link on each child item (MC-2017), with three
// differences that make it a CHILD link rather than the launching item's own:
//  - `status: 'pending'` — recorded, not started. Only `active` drives an item to
//    `in_progress`, so a child does not read as working until its own task claims.
//  - `priorStatus` — the status the child held before the sprint, so cancelling
//    puts it back instead of stranding it `in_progress`.
//  - `target.taskId` — bound later, by the projection tick, once the planner has
//    minted the task whose `backlogRef` names this child.
export function buildSprintEngineRunLink(input: {
  teamSlug: string
  runRelativePath: string
  status?: 'active' | 'pending'
  priorStatus?: BacklogItemStatusPayload
  taskId?: string
}): SprintEngineRunBacklogLink {
  return {
    id: sprintEngineRunLinkId(input.teamSlug),
    moduleId: SPRINT_ENGINE_MODULE_ID,
    type: 'execution',
    label: 'Sprint',
    target: {
      kind: SPRINT_ENGINE_RUN_TARGET_KIND,
      id: input.teamSlug,
      path: input.runRelativePath,
      ...(input.taskId ? { taskId: input.taskId } : {}),
    },
    status: input.status ?? 'active',
    ...(input.priorStatus ? { priorStatus: input.priorStatus } : {}),
  }
}

// Build the idempotent PR link for one project of a completed sprint. `external`
// is lifecycle-neutral, so attaching it never moves the item's status. The
// per-project id makes re-runs replace each link instead of stacking duplicates.
//
// `repoLabel` names the project in the link the person clicks, and is passed only
// when the run spans more than one: a single-repo run has nothing to disambiguate
// from, and "Pull request (multicode)" next to no other link is just noise.
export function buildSprintEnginePullRequestLink(input: {
  pullRequestUrl: string
  updatedAt: string
  repoId?: string
  repoLabel?: string
}): SprintEnginePullRequestBacklogLink {
  const repoLabel = input.repoLabel?.trim()
  return {
    id: sprintEnginePullRequestLinkId(input.repoId),
    moduleId: SPRINT_ENGINE_MODULE_ID,
    type: 'external',
    label: repoLabel ? `Pull request (${repoLabel})` : 'Pull request',
    target: {
      kind: SPRINT_ENGINE_PR_TARGET_KIND,
      id: input.pullRequestUrl,
      url: input.pullRequestUrl,
    },
    status: 'active',
    updatedAt: input.updatedAt,
  }
}

// The project a repo is named by wherever a person reads it: its directory name,
// never its store id. `root` is workspace-relative (`.` for the primary), so the
// primary is named by the workspace directory itself. Mirrors `_repo_display_name`
// (sprintengine_core/tool/shell.py), which names the same projects in PR bodies.
export function sprintEngineRepoDisplayName(input: { workspaceRoot: string; root?: string | null }): string {
  const root = (input.root ?? '').trim()
  const path = !root || root === '.' ? input.workspaceRoot : root
  return path.replace(/\\/g, '/').replace(/\/+$/u, '').split('/').pop() || 'project'
}

// The canonical run-store layout: `<root>/.multi-code/sprintengine/<team>/run.yaml`.
const RUN_RELATIVE_PATH_PATTERN = /^\.multi-code\/sprintengine\/[^/]+\/run\.yaml$/u
const RUN_STATE_PATH_PATTERN = /(?:^|\/)\.multi-code\/sprintengine\/([^/]+)\/run\.yaml$/u

// Accept only a project-relative run.yaml under the run store. Rejects absolute
// paths, drive letters, UNC prefixes and any `..` segment, so a link read off
// disk can never point a reader outside the workspace.
export function safeProjectRelativeRunPath(path: string): string | null {
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
  return RUN_RELATIVE_PATH_PATTERN.test(normalized) ? normalized : null
}

export function teamSlugFromStatePath(statePath: string): string | undefined {
  return statePath.replace(/\\/g, '/').match(RUN_STATE_PATH_PATTERN)?.[1]
}

// The project-relative run.yaml for a state path that lives under `workspaceRoot`.
// Returns null when the state path is outside the root or is not a run.yaml, so a
// caller can never write an out-of-tree link target.
export function runRelativePathForStatePath(workspaceRoot: string, statePath: string): string | null {
  const rootKey = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/u, '')
  const normalized = statePath.replace(/\\/g, '/')
  if (!normalized.toLowerCase().startsWith(`${rootKey.toLowerCase()}/`)) return null
  return safeProjectRelativeRunPath(normalized.slice(rootKey.length + 1))
}

// Structural minimum of a stored link, so readers here work against both the
// renderer's BacklogItemLink and the main-process BacklogItemLinkPayload.
type StoredLink = {
  id: string
  moduleId: string
  type: string
  target: { kind: string; id: string; path?: string; url?: string; taskId?: string }
  status?: string
}

// Whether this run link is one of the epic-child fan-out links (MC-2017) rather
// than the launching item's own. A child link is born `pending` and gains a
// `target.taskId` when the planner mints its task, so either marker identifies
// one for the rest of its life. The distinction matters because the two are
// driven by different things: a child link tracks ITS TASK, the launching item's
// link tracks the whole run. Nothing promotes a launching item's link into a
// child link, so a single-item launch — whose one task may well carry a
// `backlogRef` back to it — keeps reading as the run-level link it has always
// been.
export function isSprintEngineChildRunLink<Link extends StoredLink>(link: Link): boolean {
  return link.status === 'pending' || typeof link.target.taskId === 'string'
}

// The item's Sprint Engine execution link, if any. This is the only backlog -> run
// correspondence that exists: there is no reverse index, so every "which item
// started this run" query scans items for an execution link resolving to the run.
export function sprintEngineRunLinkOf<Link extends StoredLink>(links: readonly Link[]): Link | null {
  return (
    links.find(
      (link) =>
        link.moduleId === SPRINT_ENGINE_MODULE_ID
        && link.type === 'execution'
        && link.target.kind === SPRINT_ENGINE_RUN_TARGET_KIND,
    ) ?? null
  )
}

// Every pull request on the item, one per project the run delivered (MC-1612).
// Primary first when it is there, because it is the project the run is anchored in.
export function sprintEnginePullRequestLinksOf<Link extends StoredLink>(links: readonly Link[]): Link[] {
  const matched = links.filter(
    (link) => link.id === SPRINT_ENGINE_PR_LINK_ID || link.id.startsWith(`${SPRINT_ENGINE_PR_LINK_ID}:`),
  )
  return [
    ...matched.filter((link) => link.id === SPRINT_ENGINE_PR_LINK_ID),
    ...matched.filter((link) => link.id !== SPRINT_ENGINE_PR_LINK_ID),
  ]
}

// The item's pull request when a caller can only show one — the primary project's,
// falling back to whichever project has one. Callers that can show every project's
// (the Backlog item's own link list) use `sprintEnginePullRequestLinksOf`.
export function sprintEnginePullRequestLinkOf<Link extends StoredLink>(links: readonly Link[]): Link | null {
  return sprintEnginePullRequestLinksOf(links)[0] ?? null
}
