import React from 'react'

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
  },
}
