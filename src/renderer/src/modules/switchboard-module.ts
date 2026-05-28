import React from 'react'

import type { RendererModule } from './renderer-host'

// Lazy so the Switchboard/Watchtower panel bundles only load when rendered —
// never, when the module is disabled.
const SwitchboardWorkspacePanel = React.lazy(
  () => import('../components/panels/SwitchboardWorkspacePanel')
)
const WatchtowerPanel = React.lazy(() => import('../components/panels/WatchtowerPanel'))
const SwitchboardBoardPanel = React.lazy(() => import('../components/panels/SwitchboardBoardPanel'))

// Matches the main-side switchboard module's id, so the single enablement
// override gates both processes consistently.
export const switchboardRendererModule: RendererModule = {
  manifest: {
    id: 'switchboard',
    displayName: 'Switchboard & Watchtower',
    version: 1,
    publisher: 'multicode',
    category: 'orchestration',
    summary: 'Durable task board (Switchboard) and triage/review inbox (Watchtower).',
    defaultEnabled: true,
  },
  registerRenderer(host) {
    host.registerPanel('switchboard-workspace', SwitchboardWorkspacePanel)
    host.registerPanel('watchtower-panel', WatchtowerPanel)
    host.registerPanel('switchboard-board', SwitchboardBoardPanel)
  },
}
