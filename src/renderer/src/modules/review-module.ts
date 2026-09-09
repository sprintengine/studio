import React from 'react'

import type { RendererModule } from './renderer-host'
import { REVIEW_GUIDE_AGENT_ID_PREFIX } from '../review/door/reviewGuideTerminal'

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
// panel. It contributes the Reviews modal surface, which mounts the walkthrough
// keyed by review id.
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
    // Order 25: after Sprints (20) and before Design (30) in the Extensions
    // list, which interleaves doors and modals by this one number.
    // No `order` and no `Icon`: nothing lists modal surfaces or draws a trigger
    // for one since the Extensions drawer ruling (2026-09-05) retired the
    // settings cluster. Reviews is opened from the workspace pane strip, whose
    // launcher carries the glyph itself (paneKinds.tsx), so declaring a second
    // copy here would be a field nothing reads pretending to be the source.
    host.registerModalSurface({
      id: 'reviews',
      label: 'Reviews',
      Component: ReviewsGlobalSurface,
    })
    // The guide runs as an ordinary agent terminal that main spawned without a
    // window's knowledge, so no workspace row claims it. Claiming the prefix is
    // what lets the shell label those sessions and adopt one when the reviewer
    // opens it (MC-1911), without core knowing the id shape.
    host.registerAgentIdNamespace({ prefix: REVIEW_GUIDE_AGENT_ID_PREFIX, label: 'Reviews' })
  },
}
