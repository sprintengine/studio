import type { LayoutTemplate, Workspace } from '../../../../types/workspace'
import { REVIEWS_HOST_WORKSPACE_MODE } from '../../../../types/workspace'
import { useWorkspaceStore } from '../../../../store/workspaceStore'

// The Reviews host: where a project's review guide terminals live (MC-1911).
//
// The guide runs with the project as its cwd — it reads the change, the code
// around it, and the knowledge graph — but its terminal is not the reviewer's
// work, and until now it became a tab in whatever standard workspace happened to
// be open on that folder. This is the residency instead: one rail-hidden
// workspace per project root, holding review guides and nothing else, found and
// opened through the Reviews door exactly as a sprint run's agents are found
// through the Sprints door.
//
// It is created on demand — starting a run, or asking the guide a question — and
// never by the user, so it has no entry in the workspace-type registry and no
// creation flow.

// Rail-hidden and never user-created, so this template is only ever the shape of
// an empty workspace: guide tabs are added to it one at a time as reviews run.
const REVIEWS_HOST_TEMPLATE: LayoutTemplate = {
  id: 'reviews-host-mode',
  name: 'Reviews',
  description: 'Hosts the review guide terminals for one project.',
  previewSlots: [],
  layout: {
    global: { tabSetEnableDrop: true, tabEnableClose: true },
    borders: [],
    layout: { type: 'row', children: [] },
  },
}

export function isReviewsHostWorkspace(workspace: { mode: string }): boolean {
  return workspace.mode === REVIEWS_HOST_WORKSPACE_MODE
}

// Names the host after its project, because the session manager groups sessions
// by workspace name: a reviewer with two projects' guides running sees which is
// which without opening either.
export function reviewsHostWorkspaceName(projectRoot: string): string {
  const project = projectRoot.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop()
  return project ? `Reviews — ${project}` : 'Reviews'
}

export function findReviewsHostWorkspace(
  workspaces: readonly Workspace[],
  projectRoot: string,
): Workspace | undefined {
  const root = normalizeRoot(projectRoot)
  return workspaces.find(
    (workspace) => isReviewsHostWorkspace(workspace) && normalizeRoot(workspace.folderPath) === root,
  )
}

// The host workspace id for this project, creating it if this is the project's
// first guide. Returns null only when there is no project root to host — the
// caller then starts without one and the main process falls back to the
// project's own workspace, which is where the guide used to live anyway.
//
// Created in the BACKGROUND: the reviewer is reading the Reviews door when this
// runs, and minting a workspace must not close the surface out from under them.
export function ensureReviewsHostWorkspace(projectRoot: string | null): string | null {
  const root = projectRoot?.trim()
  if (!root) return null
  const store = useWorkspaceStore.getState()
  const existing = findReviewsHostWorkspace(store.workspaces, root)
  if (existing) return existing.id
  return store.addWorkspace(REVIEWS_HOST_TEMPLATE, {
    name: reviewsHostWorkspaceName(root),
    folderPath: root,
    mode: REVIEWS_HOST_WORKSPACE_MODE,
    background: true,
  })
}

// Path comparison for roots that came from two places (a workspace row the user
// picked, a review record written earlier). Only a trailing separator differs in
// practice; case and separator style are left alone so two genuinely different
// folders never collapse into one.
function normalizeRoot(path: string | null | undefined): string {
  if (!path) return ''
  return path.replace(/[\\/]+$/u, '')
}
