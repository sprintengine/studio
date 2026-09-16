import React from 'react'

import { subscribeBacklogScan } from '../hooks/useSharedBacklogScan'
import { createBacklogReader } from './backlog-reader'
import type { RendererModule } from './renderer-host'

const BacklogPanel = React.lazy(() => import('../components/panels/BacklogPanel'))

export const backlogRendererModule: RendererModule = {
  manifest: {
    id: 'backlog',
    displayName: 'Backlog',
    version: 1,
    publisher: 'multicode',
    category: 'orchestration',
    summary:
      'Local work-intake items backed by backlog files and sidecar metadata.',
    defaultEnabled: true,
    dependsOn: ['dev-tools'],
  },
  registerRenderer(host) {
    // The workspace pane's Backlog tab renders this panel; it is the one
    // Backlog surface. The instance-level Backlog door that used to sit beside
    // it (T9, a top-nav row of its own) retired on 2026-09-05: with the
    // Backlog a pane tab beside the chat, a second full-page copy of the same
    // list was a second home for one idea.
    host.registerPanel('backlog', BacklogPanel)
    // Backlog read API for module renderers, riding the panel's shared scan.
    // The workspace store resolves lazily so this module (registered eagerly
    // at boot) never pulls the store into the module-registry import graph.
    host.provideBacklogReader(createBacklogReader({
      resolveFolderPath: async (workspaceId) => {
        const { useWorkspaceStore } = await import('../store/workspaceStore')
        return (
          useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === workspaceId)
            ?.folderPath ?? null
        )
      },
      subscribe: subscribeBacklogScan,
    }))
  },
}
