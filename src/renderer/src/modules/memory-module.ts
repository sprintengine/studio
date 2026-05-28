import React from 'react'

import type { RendererModule } from './renderer-host'

// Lazy so the Memory Graph bundle (and its d3-force dependency) only loads when
// the panel is actually rendered — i.e. never, when the module is disabled.
const MemoryGraphPanel = React.lazy(() => import('../components/panels/MemoryGraphPanel'))

export const memoryRendererModule: RendererModule = {
  manifest: {
    id: 'memory-graph',
    displayName: 'Memory Graph',
    version: 1,
    publisher: 'multicode',
    category: 'insight',
    summary: 'Knowledge-graph view of workspace memory plus live activity synapses.',
    defaultEnabled: true,
  },
  registerRenderer(host) {
    host.registerPanel('memory-graph', MemoryGraphPanel)
  },
}
