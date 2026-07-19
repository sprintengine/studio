import React from 'react'

import type { RendererModule } from './renderer-host'
import { decodeAutomationTargetRef } from '../components/automations/runTarget'
import { dispatchAutomationSurfaceTarget } from '../components/workspace/globalSurface/automations/automationSurfaceTarget'
import { registerAutomationsWorkspaceTypes } from './automations-workspace-types'

// Lazy so the control-center bundle (and the store/FlexLayout graph it pulls in)
// loads only when an Automations host workspace renders the panel — never while
// the module is disabled, and never into the eager module-registry graph.
const AutomationsControlCenterPanel = React.lazy(
  () => import('../components/panels/AutomationsPanel')
)

// The Automations door + its full-page surface. Lazy — and deliberately NOT
// top-level imports — because both reach the workspace store (and, through it,
// the FlexLayout graph); keeping them behind dynamic imports leaves the eager
// module-registry graph store-free, the discipline the other doors follow.
const AutomationsNavEntry = React.lazy(() =>
  import('../components/workspace/globalSurface/automations/AutomationsNavEntry').then((module) => ({
    default: module.AutomationsNavEntry,
  }))
)
const AutomationsGlobalSurface = React.lazy(
  () => import('../components/workspace/globalSurface/automations/AutomationsGlobalSurface')
)

// Automations renderer module. Matches the main-side `automations` module id so
// the single enablement override gates both processes: disabling the module
// removes the Automations entry points and stops the engine sidecar on the main
// side.
//
// Automations stop being sidebar Projects-list citizens (global-surfaces epic
// 1704 / item 1707): the door opens a full-page surface listing every automation
// across every project. The `automations-host` workspace TYPE stays registered
// (hidden from the creation picker) because the executor still creates hidden
// host workspaces at runtime to host live run terminals — the surface relocates
// the control center without changing run execution. The always-on background
// run observer (AutomationsRunSupervisor) is still mounted directly by the shell
// (WorkspaceManager), gated on this module's enablement, so scheduled runs notify
// even when the door is closed.
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
    // The Automations top-nav door (order 10, where the hardcoded built-in used
    // to sit) + the full-page surface it opens.
    host.registerSidebarNavEntry({ id: 'automations', order: 10, Component: AutomationsNavEntry })
    host.registerGlobalSurface({ id: 'automations', Component: AutomationsGlobalSurface })

    // Deep-link from an automations run notification to the run it is about,
    // shared by manual Run-now and background scheduled runs. Automations are no
    // longer workspaces, so Open opens the full-page door and selects the run's
    // automation (via the surface's deep-link latch) instead of revealing the
    // now-retired host workspace. A provider action REPLACES the shell's generic
    // workspace-reveal fallback, so this resolves its own destination.
    host.registerNotificationActionProvider({
      source: 'automations',
      resolveActions: ({ notification }) => {
        const target = notification.navigationTarget
        if (!target) return []
        // Accept both the forward door kind and the legacy `run` kind (both carry
        // the same automationId/runId/folderPath ref) so notifications persisted
        // before this change still route to the door.
        const decoded = decodeAutomationTargetRef(target)
        if (!decoded) return []
        return [
          {
            id: 'automations.open-run',
            label: 'Open',
            run: () => {
              // Latch the automation to select first (the surface drains it on
              // mount), then open the door. Dynamic store import keeps the eager
              // module registry — and the bundled-ids drift test — free of the
              // workspace store / FlexLayout graph, matching the roadmap and
              // sprint-engine module pattern.
              dispatchAutomationSurfaceTarget(target)
              void import('../store/workspaceStore').then(({ useWorkspaceStore }) => {
                useWorkspaceStore.getState().openGlobalSurface('automations')
              })
            },
          },
        ]
      },
    })
  },
}
