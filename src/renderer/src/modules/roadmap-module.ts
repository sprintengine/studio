import React from 'react'

import type { RendererModule } from './renderer-host'

// The Roadmap top-nav door. Lazy — and deliberately NOT a top-level import —
// because the entry component reaches the workspace store (and, through it, the
// FlexLayout graph); keeping it behind a dynamic import leaves the eager
// module-registry graph store-free, the same discipline the other modules follow.
const RoadmapNavEntry = React.lazy(() =>
  import('../components/workspace/RoadmapNavEntry').then((module) => ({ default: module.RoadmapNavEntry }))
)

// The Roadmap full-page surface (global-surfaces epic 1704), mounted by
// WorkspaceManager over the workspace card region when the door opens it. Lazy —
// it pulls in the roadmap board — so its bundle stays off the wire until opened.
const RoadmapGlobalSurface = React.lazy(() => import('../components/workspace/globalSurface/RoadmapGlobalSurface'))

// Roadmap capability module (MC-1691). Splits Roadmap out of Sprint Engine into a
// module you can switch off in Settings → Modules: one toggle gates the sidebar
// door (the nav contribution below), the global surface (WorkspaceManager mounts
// it only while this module is enabled), and the orchestrator (main gates its
// reconcile tick on this same enablement). `dependsOn` carries BOTH sprint-engine
// (the roadmap orchestrates sprints) and automations (the orchestrator rides the
// automations engine's evaluation tick — without the dependency, disabling
// Automations would silently stop reconciliation).
export const roadmapRendererModule: RendererModule = {
  manifest: {
    id: 'roadmap',
    displayName: 'Roadmap',
    version: 1,
    publisher: 'multicode',
    category: 'orchestration',
    summary:
      'Works an ordered plan of backlog items across your projects, one sprint at a time. Disabling hides the sidebar door and stops Multicode from starting new sprints.',
    defaultEnabled: true,
    dependsOn: ['sprint-engine', 'automations'],
  },
  registerRenderer(host) {
    // After Connectors (order 30) in the top-nav cluster — D4.
    host.registerSidebarNavEntry({ id: 'roadmap', order: 40, Component: RoadmapNavEntry })
    // The door routes to this full-page surface (epic 1704); the id matches the
    // one the nav entry opens via openRoadmapSurface → openGlobalSurface('roadmap').
    // The retired `roadmap` workspace mode (store v65, dropRetiredRoadmapWorkspaces)
    // has no reachable panel mount, so the board lives only on this surface now.
    host.registerGlobalSurface({ id: 'roadmap', Component: RoadmapGlobalSurface })
  },
}
