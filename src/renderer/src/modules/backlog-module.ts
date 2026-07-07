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
      'Local work-intake items backed by backlog files, sidecar metadata, and module-contributed actions.',
    defaultEnabled: true,
    dependsOn: ['dev-tools'],
  },
  registerRenderer(host) {
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
