// The Sprint Engine Backlog link shapes, single-sourced for every writer: the
// renderer's workspace-creation flow and projection refresh, and the mobile
// command path in the main process (a phone-driven run has nobody at the
// desktop, so the renderer's projection tick never runs for it). Pure and
// node-free (tsconfig.web-safe), mirroring src/shared/backlog/agent-links.ts.
//
// The renderer-only halves — resolving a link against mounted workspaces and
// opening one — stay in src/renderer/src/utils/sprintengineBacklogLinks.ts,
// which re-exports everything here so there is exactly one implementation.

export const SPRINT_ENGINE_MODULE_ID = 'sprint-engine'
export const SPRINT_ENGINE_RUN_TARGET_KIND = 'sprintengine.run'
export const SPRINT_ENGINE_PR_TARGET_KIND = 'sprintengine.pullRequest'
// Fixed id so the PR link is idempotent per item: re-running a sprint replaces
// the link rather than accumulating stale ones (mirrors the agent-runtime
// `agent-runtime:working-agent` most-recent-wins convention).
export const SPRINT_ENGINE_PR_LINK_ID = 'sprint-engine:pull-request'

// Structural shapes of the built links; assignable to both the renderer's
// BacklogItemLink and the main-process BacklogItemLinkPayload.
export type SprintEngineRunBacklogLink = {
  id: string
  moduleId: string
  type: 'execution'
  label: string
  target: { kind: string; id: string; path: string }
  status: 'active'
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
export function buildSprintEngineRunLink(input: {
  teamSlug: string
  runRelativePath: string
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
    },
    status: 'active',
  }
}

// Build the idempotent PR link for a completed sprint. `external` is
// lifecycle-neutral, so attaching it never moves the item's status. The fixed
// id makes re-runs replace the link instead of stacking duplicates.
export function buildSprintEnginePullRequestLink(input: {
  pullRequestUrl: string
  updatedAt: string
}): SprintEnginePullRequestBacklogLink {
  return {
    id: SPRINT_ENGINE_PR_LINK_ID,
    moduleId: SPRINT_ENGINE_MODULE_ID,
    type: 'external',
    label: 'Pull request',
    target: {
      kind: SPRINT_ENGINE_PR_TARGET_KIND,
      id: input.pullRequestUrl,
      url: input.pullRequestUrl,
    },
    status: 'active',
    updatedAt: input.updatedAt,
  }
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
  target: { kind: string; id: string; path?: string; url?: string }
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

export function sprintEnginePullRequestLinkOf<Link extends StoredLink>(links: readonly Link[]): Link | null {
  return links.find((link) => link.id === SPRINT_ENGINE_PR_LINK_ID) ?? null
}
