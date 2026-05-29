import React from 'react'

import type { RendererModule } from './renderer-host'

// Lazy so the Sprint Engine board bundle only loads when the panel is actually
// rendered — never, when the module is disabled.
const SprintEngineBoardPanel = React.lazy(
  () => import('../components/panels/SprintEngineBoardPanel')
)

// Sprint Engine renderer module. Matches the main-side `sprint-engine` module id
// so the single enablement override gates both processes consistently.
//
// Scope: this gates the user-facing Sprint Engine surfaces — the board panel,
// the `sprintengine` workspace mode (and the dependent `guided-brief` mode), and
// the always-mounted auto-run supervisor + state synchronizer. The Sprint Engine
// MCP hub stays foundational on the main side (lazily started only on a managed
// run), and the `roles` settings tab stays available like the knowledge-graph
// tab does for the memory-graph module.
//
// Only the canonical `sprintengine` board is routed through the host. The
// fixed-view fallbacks, run summary, and plan reader stay local lazy consts in
// WorkspaceLayout because they take props the generic host panel contract
// (`{ workspaceId }`) doesn't carry — the same split git uses for its conflict
// resolver.
export const sprintEngineRendererModule: RendererModule = {
  manifest: {
    id: 'sprint-engine',
    displayName: 'Sprint Engine',
    version: 1,
    publisher: 'multicode',
    category: 'orchestration',
    summary:
      'Autonomous multi-agent sprint board with quality gates. Disabling hides the board, the Sprint Engine and Guided Brief workspace modes, and stops the auto-run supervisor.',
    defaultEnabled: true,
    dependsOn: ['agent-runtime'],
  },
  registerRenderer(host) {
    host.registerPanel('sprintengine', SprintEngineBoardPanel)
  },
}
