import React from 'react'

import { subscribeBacklogScan } from '../hooks/useSharedBacklogScan'
import { createBacklogReader } from './backlog-reader'
import { createTrackerIssueLinkProviders } from './trackerBacklogLinks'
import type { RendererModule } from './renderer-host'

const BacklogPanel = React.lazy(() => import('../components/panels/BacklogPanel'))

// The Backlog door (T9). Lazy — and deliberately not a top-level import —
// because both reach the workspace store; keeping them behind a dynamic import
// leaves the eager module-registry graph store-free, matching the other module
// doors (Reviews, Roadmap).
const BacklogNavEntry = React.lazy(() =>
  import('../components/workspace/globalSurface/backlog/BacklogNavEntry').then((m) => ({
    default: m.BacklogNavEntry,
  })),
)

const BacklogGlobalSurface = React.lazy(
  () => import('../components/workspace/globalSurface/backlog/BacklogGlobalSurface'),
)

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
    // The instance-level Backlog door: one page listing every open project's
    // backlog, with a project filter (T9, mockup §4). Order 25 puts it directly
    // after Sprints (20) and before Roadmap (40), matching the mockup's sidebar
    // order. The per-project panel above is unchanged — the door is the
    // instance-level view, not a replacement.
    host.registerSidebarNavEntry({ id: 'backlog', order: 25, Component: BacklogNavEntry })
    host.registerGlobalSurface({ id: 'backlog', Component: BacklogGlobalSurface })
    // Live tracker-issue status on proxy Backlog items (MC-1638). One provider
    // per tracker for the `<provider>.issue` sidecar link the materializer writes;
    // all status resolution and opening route through the tracker IPC surface, so
    // the renderer never talks to a tracker directly. window.api is read inside
    // the port closures (call time), keeping registration windowless-safe.
    for (const provider of createTrackerIssueLinkProviders({
      fetchIssue: (input) => window.api.trackerFetchIssue(input),
      openExternal: (url) => window.api.openExternal(url),
    })) {
      host.registerBacklogLinkProvider(provider)
    }
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
