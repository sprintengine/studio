import React from 'react'

import type { RendererModule } from './renderer-host'
import { useWorkspaceStore } from '../store/workspaceStore'
import { collectReviewStateMigrations } from '../store/slices/workspacesSlice'
import { REVIEW_WORKSPACE_MODE } from '../types/workspace'
import { REVIEW_GUIDE_AGENT_ID_PREFIX } from '../review/door/reviewGuideTerminal'
import { ReviewsGlyph } from '../review/door/ReviewsGlyph'

// The Reviews surface (global-surfaces epic 1704; a modal since 2026-09-05),
// mounted by WorkspaceManager in the shell's modal shell. Lazy so its bundle
// (the walkthrough tree — Monaco, guide chat) stays off the wire until it is
// opened, and never loads while the module is disabled.
const ReviewsGlobalSurface = React.lazy(
  () => import('../review/door/ReviewsGlobalSurface'),
)

// Review renderer module. Matches the main-side `review` module id so the single
// enablement override gates both processes.
//
// Reviews are instance-level objects (MC-1708): the `review` workspace TYPE
// retired, so this module registers no creatable workspace type and no FlexLayout
// panel. It contributes the Reviews modal surface (which mounts the walkthrough
// keyed by review id) and runs the one-time retirement that lifts any persisted
// `Workspace.reviewState` onto disk and drops the dead review rows.
//
// A modal, not a door (owner, 2026-09-05): a review is read beside the chat
// that produced the change, and the workspace pane is where it is reached
// from — the pane's launcher lists Reviews with Browser, Terminal, Files and
// Diff. But a walkthrough is Monaco beside a guide transcript, and the pane
// column is too narrow to read it in, so picking Reviews there floats the
// surface at workbench width over the page instead of opening a pane tab. The
// Extensions section of the sidebar lists it too, as it lists every modal.
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
    // No `order` and no `Icon`: nothing lists modal surfaces or draws a trigger
    // for one since the Extensions drawer ruling (2026-09-05) retired the
    // settings cluster. Reviews is opened from the workspace pane strip, and
    // the `launcher` below IS that row — the one the shell used to hard-code in
    // paneKinds.tsx. R is free: no tab kind starts with it.
    host.registerModalSurface({
      id: 'reviews',
      label: 'Reviews',
      launcher: { label: 'Reviews', letter: 'R', Glyph: ReviewsGlyph },
      Component: ReviewsGlobalSurface,
    })
    // The guide runs as an ordinary agent terminal that main spawned without a
    // window's knowledge, so no workspace row claims it. Claiming the prefix is
    // what lets the shell label those sessions and adopt one when the reviewer
    // opens it (MC-1911), without core knowing the id shape.
    host.registerAgentIdNamespace({ prefix: REVIEW_GUIDE_AGENT_ID_PREFIX, label: 'Reviews' })
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
// drain — the same reason dropRetiredModeWorkspaces (MC-1692) runs on every
// list-entry path, adapted here to the lift-before-drop ordering reviews require
// (a retired-mode row has nothing to preserve; review rows carry unposted comments).
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
