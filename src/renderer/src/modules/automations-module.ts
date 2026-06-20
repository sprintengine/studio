import React from 'react'

import type { RendererModule } from './renderer-host'
import { createAutomationsTemplate, registerAutomationsWorkspaceTypes } from './automations-workspace-types'
import { dispatchRevealTarget } from '../utils/revealTarget'
import { decodeRunRef, resolveAutomationsWorkspaceId } from '../components/automations/runTarget'

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
    // Deep-link from an automations run notification to the run it is about,
    // shared by manual Run-now (T6) and background scheduled runs (T13). The run
    // target carries the run's folderPath, so Open lands in that project's
    // control center even when nothing for it is open: resolve an existing
    // automations workspace for the folder first (dedupe), create one only if
    // none exists, then reveal THAT workspace and dispatch the run target to it
    // (not the notification's project workspace). With no run target it returns
    // nothing and the shell's workspace-reveal fallback still gives an Open.
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
            // Dynamic store import (not a top-level one) keeps the eager module
            // registry — and the bundled-ids drift test — free of the workspace
            // store / FlexLayout graph, matching the sprint-engine-module pattern.
            run: () => {
              void import('../store/workspaceStore').then(({ useWorkspaceStore }) => {
                const store = useWorkspaceStore.getState()
                const targetWorkspaceId = resolveAutomationsWorkspaceId({
                  folderPath: decodeRunRef(target.ref)?.folderPath ?? null,
                  fallbackWorkspaceId: workspaceId,
                  workspaces: store.workspaces,
                  createAutomationsWorkspace: (folderPath) =>
                    store.addWorkspace(createAutomationsTemplate(), { name: 'Automations', folderPath, mode: 'automations' }),
                })
                revealWorkspace(targetWorkspaceId)
                dispatchRevealTarget({ workspaceId: targetWorkspaceId, target })
              })
            },
          },
        ]
      },
    })
  },
}
