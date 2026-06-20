import React from 'react'

import type { RendererModule } from './renderer-host'

// Lazy so the GitPanel bundle only loads when rendered — never, when disabled.
const GitPanel = React.lazy(() => import('../components/panels/GitPanel'))

// Renderer-only module: gates the Git commit/diff/branch panel (and rail
// button). The git backend (status/diff IPC) stays foundational — always
// registered in register-core-ipc — because editor/explorer git decorations and
// the panel-rail change badge call it unconditionally.
export const gitRendererModule: RendererModule = {
  manifest: {
    id: 'git',
    displayName: 'Git panel',
    version: 1,
    publisher: 'multicode',
    category: 'vcs',
    summary: 'Commit, stage, branch, and view diffs. Disabling hides the panel; git status indicators in the editor and explorer stay.',
    defaultEnabled: true,
  },
  registerRenderer(host) {
    host.registerPanel('git', GitPanel)
  },
}
