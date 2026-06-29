import React from 'react'

import type { RendererModule } from './renderer-host'
import { decodeRunRef } from '../components/automations/runTarget'
import { registerAutomationsWorkspaceTypes } from './automations-workspace-types'
import { isAutomationsHostWorkspace } from '../utils/workspaceVisibility'
import { dispatchRevealTarget } from '../utils/revealTarget'

// Match a run's folderPath to an open Automations host workspace. Pure + tiny
// (no store import) so it stays out of the eager module-registry graph: trim and
// drop a single trailing slash, matching how folders compare elsewhere.
function normalizeFolderKey(folderPath: string | null | undefined): string {
  return (folderPath ?? '').trim().replace(/[/\\]+$/, '')
}

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
    // carries the run's folderPath). Open reveals the run's Automations workspace
    // and dispatches the run target into it; the control-center panel there drains
    // it on reveal and scroll/focuses the run. A provider action REPLACES the
    // shell's generic workspace-reveal fallback (see resolveNotificationActions),
    // so this action must resolve a target itself: prefer the per-project
    // `automations-host` workspace matched by folder, then fall back to the
    // notification's own `workspaceId` (the workspace the run executed in — a
    // legacy explicit-workspaceId run, or the host before it was reordered/closed
    // and reopened). Only when neither resolves is there genuinely nowhere to go.
    host.registerNotificationActionProvider({
      source: 'automations',
      resolveActions: ({ notification }) => {
        const target = notification.navigationTarget
        if (target?.kind !== 'run' || !target.ref) return []
        const decoded = decodeRunRef(target.ref)
        if (!decoded?.folderPath) return []
        const folderKey = normalizeFolderKey(decoded.folderPath)
        const fallbackWorkspaceId = notification.workspaceId
        return [
          {
            id: 'automations.open-run',
            label: 'Open',
            run: (ctx) => {
              // Dynamic store import (not a top-level one) keeps the eager module
              // registry — and the bundled-ids drift test — free of the workspace
              // store / FlexLayout graph, matching the sprint-engine-module pattern.
              void import('../store/workspaceStore').then(({ useWorkspaceStore }) => {
                const host = useWorkspaceStore
                  .getState()
                  .workspaces.find(
                    (workspace) =>
                      isAutomationsHostWorkspace(workspace) &&
                      normalizeFolderKey(workspace.folderPath) === folderKey
                  )
                const targetWorkspaceId = host?.id ?? fallbackWorkspaceId
                if (!targetWorkspaceId) return
                ctx.revealWorkspace(targetWorkspaceId)
                dispatchRevealTarget({ workspaceId: targetWorkspaceId, target })
              })
            },
          },
        ]
      },
    })
  },
}
