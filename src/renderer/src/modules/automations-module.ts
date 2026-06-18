import React from 'react'

import type { RendererModule } from './renderer-host'
import { registerAutomationsWorkspaceTypes } from './automations-workspace-types'

// Lazy so the control-center bundle only loads when an automations workspace is
// actually rendered — never when the module is disabled.
const AutomationsPanel = React.lazy(() => import('../components/panels/AutomationsPanel'))

// Automations renderer module. Matches the main-side `automations` module id so
// the single enablement override gates both processes: disabling the module
// hides the `automations` workspace mode (drift-guarded by
// bundled-workspace-types.test.ts) and stops the engine sidecar on the main side.
export const automationsRendererModule: RendererModule = {
  manifest: {
    id: 'automations',
    displayName: 'Automations',
    version: 1,
    publisher: 'multicode',
    category: 'orchestration',
    summary: 'Local-first scheduled agent automations with run history and module-gated execution.',
    defaultEnabled: true,
    dependsOn: ['agent-runtime'],
  },
  registerRenderer(host) {
    host.registerPanel('automations-control-center', AutomationsPanel)
    registerAutomationsWorkspaceTypes(host)
  },
}
