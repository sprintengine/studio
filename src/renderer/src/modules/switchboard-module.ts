import React from 'react'

import type { RendererHost, RendererModule } from './renderer-host'
import { registerSwitchboardWorkspaceTypes } from './switchboard-workspace-types'
import { dispatchPanelCommandEvent } from '../utils/panelCommands'

// Lazy so the Switchboard/Watchtower panel bundles only load when rendered —
// never, when the module is disabled.
const SwitchboardWorkspacePanel = React.lazy(
  () => import('../components/panels/SwitchboardWorkspacePanel')
)
const WatchtowerPanel = React.lazy(() => import('../components/panels/WatchtowerPanel'))
const SwitchboardBoardPanel = React.lazy(() => import('../components/panels/SwitchboardBoardPanel'))

// Switchboard + Watchtower palette commands, registered through the module
// path (MC-1533's in-tree proof). Switchboard command ids stay
// `switchboard.<id>`; Watchtower's are a surface of this module, so their
// registered ids are namespaced under it (`switchboard.watchtower.*`) while
// the panel bus events keep their original ids — the panels' listeners are
// unchanged (LEGACY_COMMAND_ID_ALIASES keeps persisted keybinding deltas
// working). The Switchboard pair proves the availability-predicate path:
// identical semantics to the old `switchboardWorkspace` enum precondition,
// expressed against the published context view instead of a shell enum entry.
function registerSwitchboardCommands(host: RendererHost): void {
  const dispatchPanelCommand = (id: string) => () => dispatchPanelCommandEvent(id)
  const switchboardActive = (context: { activeWorkspaceMode: string | null }): boolean =>
    context.activeWorkspaceMode === 'switchboard'
  host.registerCommand({
    id: 'refresh.board',
    title: 'Refresh board',
    category: 'Switchboard',
    scopes: ['panel:switchboard'],
    availability: switchboardActive,
    run: dispatchPanelCommand('switchboard.refresh.board'),
  })
  host.registerCommand({
    id: 'open.runner',
    title: 'Open runner',
    category: 'Switchboard',
    scopes: ['panel:switchboard'],
    availability: switchboardActive,
    run: dispatchPanelCommand('switchboard.open.runner'),
  })
  const watchtowerCommands: ReadonlyArray<{ id: string; title: string; eventId: string }> = [
    { id: 'watchtower.run.review', title: 'Run review', eventId: 'watchtower.run.review' },
    { id: 'watchtower.triage.inbox', title: 'Triage inbox', eventId: 'watchtower.triage.inbox' },
    { id: 'watchtower.open.active-review', title: 'Active review', eventId: 'watchtower.open.active-review' },
    { id: 'watchtower.import.github', title: 'Import from GitHub', eventId: 'watchtower.import.github' },
    { id: 'watchtower.import.jira', title: 'Import from Jira', eventId: 'watchtower.import.jira' },
    { id: 'watchtower.refresh.board', title: 'Refresh', eventId: 'watchtower.refresh.board' },
  ]
  for (const definition of watchtowerCommands) {
    host.registerCommand({
      id: definition.id,
      title: definition.title,
      category: 'Watchtower',
      scopes: ['panel:watchtower'],
      run: dispatchPanelCommand(definition.eventId),
    })
  }
}

// Matches the main-side switchboard module's id, so the single enablement
// override gates both processes consistently.
export const switchboardRendererModule: RendererModule = {
  manifest: {
    id: 'switchboard',
    displayName: 'Switchboard & Watchtower',
    version: 1,
    publisher: 'multicode',
    category: 'orchestration',
    summary: 'Durable task board (Switchboard) and triage/review inbox (Watchtower).',
    defaultEnabled: true,
    dependsOn: ['agent-runtime'],
  },
  registerRenderer(host) {
    host.registerPanel('switchboard-workspace', SwitchboardWorkspacePanel)
    host.registerPanel('watchtower-panel', WatchtowerPanel)
    host.registerPanel('switchboard-board', SwitchboardBoardPanel)
    registerSwitchboardWorkspaceTypes(host)
    registerSwitchboardCommands(host)
  },
}
