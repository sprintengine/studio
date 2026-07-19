import React from 'react'

import type { RendererModule } from './renderer-host'
import { registerReviewWorkspaceType } from './review-workspace-types'

// Lazy so the review panel bundle loads only when a review workspace renders it —
// never while the module is disabled, and never into the eager module-registry
// graph.
const ReviewPanel = React.lazy(() => import('../components/panels/ReviewPanel'))

// Review renderer module. Matches the main-side `review` module id so the single
// enablement override gates both processes: disabling the module removes the
// Review workspace type from the creation hub and renders the shared unavailable
// surface in any open review tab, while the main side stops registering the
// review ingestion IPC.
//
// Review is a visible workspace TYPE (mode 'review'): the user creates one per
// change set from the creation hub, landing on the single-surface review panel.
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
    registerReviewWorkspaceType(host)
  },
}
