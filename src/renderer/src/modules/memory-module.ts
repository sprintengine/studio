import React from 'react'

import type { RendererModule } from './renderer-host'

// Lazy so the Memory Graph bundle (and its d3-force dependency) only loads when
// the panel is actually rendered — i.e. never, when the module is disabled.
const MemoryGraphPanel = React.lazy(() => import('../components/panels/MemoryGraphPanel'))

// Renderer-only module: gates the visualization panel (and its d3-force bundle).
// The underlying knowledge-graph backend stays foundational/always-on (agents
// and the Knowledge Graph settings tab depend on it), so there is no matching
// main-process module.
export const memoryRendererModule: RendererModule = {
  manifest: {
    id: 'memory-graph',
    displayName: 'Memory Graph panel',
    version: 1,
    publisher: 'multicode',
    category: 'insight',
    summary: 'Force-directed visualization of the workspace knowledge graph. Disabling hides the panel; the knowledge-graph backend stays available to agents.',
    defaultEnabled: true,
  },
  registerRenderer(host) {
    host.registerPanel('memory-graph', MemoryGraphPanel)
  },
}
