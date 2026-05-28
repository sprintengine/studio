import React from 'react'

import type { RendererModule } from './renderer-host'

const MultiloopBoardPanel = React.lazy(() => import('../components/panels/MultiloopBoardPanel'))

// Matches the main-side multiloop module's id so the single enablement override
// gates both processes.
export const multiloopRendererModule: RendererModule = {
  manifest: {
    id: 'multiloop',
    displayName: 'Multiloop',
    version: 1,
    publisher: 'multicode',
    category: 'orchestration',
    summary: 'Milestone-driven loop: roadmap, active work, blockers, and evidence.',
    defaultEnabled: true,
  },
  registerRenderer(host) {
    host.registerPanel('multiloop-board', MultiloopBoardPanel)
  },
}
