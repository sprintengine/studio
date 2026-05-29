import React from 'react'

import type { RendererModule } from './renderer-host'

// Lazy so the editor (Monaco) and content-search bundles only load when their
// panels render — never, when the module is disabled. Monaco is one of the
// heaviest renderer deps, so code-splitting it behind this module is the single
// biggest dev-tools win.
const EditorPanel = React.lazy(() => import('../components/panels/EditorPanel'))
const ContentSearchPanel = React.lazy(() => import('../components/panels/ContentSearchPanel'))

// Dev Tools (file explorer + editor + content search) as a renderer-only
// capability module. Like git and memory-graph, the *backend* is foundational:
// the filesystem IPC stays always-registered in register-core-ipc because
// agents and search depend on it. Only the panels gate.
//
// The canonical `editor` and `content-search` panels are served through the
// host (they fit the generic `{ workspaceId }` contract). The `explorer` and
// per-file `file-editor` panels stay local lazy consts in WorkspaceLayout
// because they take extra props (`onStartFuturePlan`, `filePath`) the host panel
// contract omits — the same split git uses for its conflict resolver. All of
// them gate on this module's enablement.
export const devToolsRendererModule: RendererModule = {
  manifest: {
    id: 'dev-tools',
    displayName: 'Dev Tools',
    version: 1,
    publisher: 'multicode',
    category: 'dev-tools',
    summary:
      'File explorer, code editor, and content search. Disabling hides these panels; the filesystem backend stays available to agents and search.',
    defaultEnabled: true,
  },
  registerRenderer(host) {
    host.registerPanel('editor', EditorPanel)
    host.registerPanel('content-search', ContentSearchPanel)
  },
}
