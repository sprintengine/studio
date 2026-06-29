import React from 'react'

import type { RendererModule } from './renderer-host'
import { decodeRunRef } from '../components/automations/runTarget'
import { registerAutomationsWorkspaceTypes } from './automations-workspace-types'

// Lazy so the control-center bundle (and the store/FlexLayout graph it pulls in)
// loads only when an Automations workspace renders the panel — never while the
// module is disabled, and never into the eager module-registry graph.
const AutomationsControlCenterPanel = React.lazy(
  () => import('../components/panels/AutomationsPanel')
)

// Automations renderer module. Matches the main-side `automations` module id so
// the single enablement override gates both processes: disabling the module
// removes the Automations entry points and stops the engine sidecar on the main
// side.
//
// Automations is a visible workspace TYPE (mode 'automations-host'): the user
// creates one per project, and it hosts both the control-center panel and the
// live run terminals. The always-on background run observer
// (AutomationsRunSupervisor) is mounted directly by the shell (WorkspaceManager),
// gated on this module's enablement, so scheduled runs notify even when no
// automations workspace is open.
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
    host.registerPanel('automations-control-center', AutomationsControlCenterPanel)
    registerAutomationsWorkspaceTypes(host)

    // Deep-link from an automations run notification to the run it is about,
    // shared by manual Run-now and background scheduled runs (the run target
    // carries the run's folderPath). Open lands in the global Automations screen
    // scoped to that project, then the screen selects the automation and focuses
    // the run. With no run target it returns nothing and the shell's generic
    // workspace-reveal fallback still offers an Open.
    host.registerNotificationActionProvider({
      source: 'automations',
      resolveActions: ({ notification }) => {
        const target = notification.navigationTarget
        if (target?.kind !== 'run' || !target.ref) return []
        return [
          {
            id: 'automations.open-run',
            label: 'Open',
            // Dynamic store import (not a top-level one) keeps the eager module
            // registry — and the bundled-ids drift test — free of the workspace
            // store / FlexLayout graph, matching the sprint-engine-module pattern.
            run: () => {
              void import('../store/workspaceStore').then(({ useWorkspaceStore }) => {
                const decoded = decodeRunRef(target.ref)
                useWorkspaceStore.getState().openAutomationsOverlay({
                  projectPath: decoded?.folderPath ?? null,
                  runTarget: decoded
                    ? { automationId: decoded.automationId, runId: decoded.runId }
                    : null,
                })
              })
            },
          },
        ]
      },
    })
  },
}
