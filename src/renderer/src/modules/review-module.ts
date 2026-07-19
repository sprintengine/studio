import React from 'react'

import type { RendererModule } from './renderer-host'
import { useWorkspaceStore } from '../store/workspaceStore'
import { collectReviewStateMigrations } from '../store/slices/workspacesSlice'
import { REVIEW_WORKSPACE_MODE } from '../types/workspace'

// Lazy so the review panel bundle loads only when the Reviews surface renders it —
// never into the eager module-registry graph, and never while the module is
// disabled.
const ReviewPanel = React.lazy(() => import('../components/panels/ReviewPanel'))

// Review renderer module. Matches the main-side `review` module id so the single
// enablement override gates both processes.
//
// Reviews are instance-level objects (MC-1708): the `review` workspace TYPE
// retired, so this module no longer registers a creatable workspace type. It
// registers the review panel (mounted full-page by the Reviews surface, MC-1708
// T6, keyed by review id) and runs the one-time retirement that lifts any
// persisted `Workspace.reviewState` onto disk and drops the dead review-mode rows.
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
    host.registerPanel('review', ReviewPanel)
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
