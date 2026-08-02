import React from 'react'

import type { RendererModule } from './renderer-host'
import { useWorkspaceStore } from '../store/workspaceStore'
import { collectReviewStateMigrations } from '../store/slices/workspacesSlice'
import { REVIEW_WORKSPACE_MODE } from '../types/workspace'

// The Reviews door (MC-1708 T6). Lazy — and deliberately not a top-level import —
// because the nav entry reaches the workspace store; keeping it behind a dynamic
// import leaves the eager module-registry graph store-free, matching the other
// module doors.
const ReviewsNavEntry = React.lazy(() =>
  import('../review/door/ReviewsNavEntry').then((m) => ({ default: m.ReviewsNavEntry })),
)

// The Reviews full-page surface (global-surfaces epic 1704), mounted by
// WorkspaceManager over the workspace card region when the door opens it. Lazy so
// its bundle (the walkthrough tree — Monaco, guide chat) stays off the wire until
// the door is opened, and never loads while the module is disabled.
const ReviewsGlobalSurface = React.lazy(
  () => import('../review/door/ReviewsGlobalSurface'),
)

// Review renderer module. Matches the main-side `review` module id so the single
// enablement override gates both processes.
//
// Reviews are instance-level objects (MC-1708): the `review` workspace TYPE
// retired, so this module registers no creatable workspace type and no FlexLayout
// panel. It contributes the Reviews sidebar door + full-page surface (which mount
// the walkthrough keyed by review id) and runs the one-time retirement that lifts
// any persisted `Workspace.reviewState` onto disk and drops the dead review rows.
export const reviewRendererModule: RendererModule = {
  manifest: {
    id: 'review',
    displayName: 'Review',
    version: 1,
    publisher: 'multicode',
    category: 'orchestration',
    summary: 'Guided, human-led review of a pull request, branch, or patch.',
    defaultEnabled: true,
    dependsOn: ['agent-runtime'],
  },
  registerRenderer(host) {
    // After Roadmap (order 40) in the top-nav cluster — mockup §4 sidebar order.
    host.registerSidebarNavEntry({ id: 'reviews', order: 50, Component: ReviewsNavEntry })
    host.registerGlobalSurface({ id: 'reviews', Component: ReviewsGlobalSurface })
    armReviewWorkspaceRetirement()
  },
}

let retirementArmed = false
let draining = false

// Drop every persisted review-mode workspace row, but only AFTER its reviewer
// state is safely on disk. The review id is the workspace id, so each row's state
// is lifted into its `<reviewDir>/state.json` (the same per-review-id directory
// its change set and brief already live in) before the row is removed. A row is
// dropped ONLY once its state is safely on disk (a successful lift) or there was
// nothing to preserve (no reviewer state). A row that still carries state we could
// not lift — a transient write error, or a review with no project folder to write
// into — is KEPT and retried on the next drain, so unposted comments are never
// silently lost.
async function drainRetiredReviewWorkspaces(): Promise<void> {
  if (draining) return
  const reviewRows = useWorkspaceStore.getState().workspaces.filter((w) => w.mode === REVIEW_WORKSPACE_MODE)
  if (reviewRows.length === 0) return
  draining = true
  try {
    const lifted = new Set<string>()
    for (const migration of collectReviewStateMigrations(reviewRows)) {
      try {
        const result = await window.api.reviewWriteState(
          { workspaceRoot: migration.workspaceRoot, workspaceId: migration.reviewId },
          migration.state,
        )
        if (result.ok) lifted.add(migration.reviewId)
      } catch {
        // Keep the row; the next drain retries the lift.
      }
    }
    const removeWorkspace = useWorkspaceStore.getState().removeWorkspace
    for (const row of reviewRows) {
      // Safe to drop: nothing to preserve, or its state is now on disk.
      if (!row.reviewState || lifted.has(row.id)) removeWorkspace(row.id)
    }
  } finally {
    draining = false
  }
}

// Arm the retirement once per app session: drain immediately, then keep watching
// the workspace list. Persisted state hydrates asynchronously, and cross-window
// sync or backup recovery can re-introduce a review-mode row after the first
// drain — the same reason dropRetiredRoadmapWorkspaces (MC-1692) runs on every
// list-entry path, adapted here to the lift-before-drop ordering reviews require
// (roadmap rows had nothing to preserve; review rows carry unposted comments).
function armReviewWorkspaceRetirement(): void {
  if (retirementArmed) return
  retirementArmed = true
  void drainRetiredReviewWorkspaces()
  useWorkspaceStore.subscribe((state, prev) => {
    if (state.workspaces === prev.workspaces) return
    if (!state.workspaces.some((w) => w.mode === REVIEW_WORKSPACE_MODE)) return
    void drainRetiredReviewWorkspaces()
  })
}
