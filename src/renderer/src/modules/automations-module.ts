import React from 'react'

import type { RendererModule } from './renderer-host'
import { registerAutomationsWorkspaceTypes } from './automations-workspace-types'
import { dispatchRevealTarget } from '../utils/revealTarget'

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
    // Deep-link from an automations run notification to the run it is about. The
    // shell reveals the workspace; this provider adds the control-center run
    // focus on top when the notification carries a `{ kind: 'run' }` target.
    // With no run target it returns nothing and the shell's workspace-reveal
    // fallback still gives the user an Open. Shared infra: the T13 background-run
    // observer reuses this provider rather than registering a second one.
    host.registerNotificationActionProvider({
      source: 'automations',
      resolveActions: ({ notification, revealWorkspace }) => {
        const workspaceId = notification.workspaceId
        const target = notification.navigationTarget
        if (!workspaceId || target?.kind !== 'run' || !target.ref) return []
        return [
          {
            id: 'automations.open-run',
            label: 'Open',
            run: () => {
              revealWorkspace(workspaceId)
              dispatchRevealTarget({ workspaceId, target })
            },
          },
        ]
      },
    })
  },
}
