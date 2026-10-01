// Where a hosted card's `open.surface` lands.
//
// `home` is the card feed's own page and `plugins`/`skills` are views of the
// Extensions door, which is the split `CardSurfaceView` states. `agent-clis`
// named a third view until the owner moved agent CLIs to Settings ▸ Agents
// (2026-09-25). The feed's view names are a permanent contract and published
// cards still name it, so it lands where that view's list went: Settings ▸
// Agents, on this machine — install is this machine's, and so is the list the
// view showed.

import type { CardSurfaceView } from '../../../../../shared/hosted-card-feed'
import { EXTENSIONS_DRAWER_VIEWS, type ExtensionsDrawerView } from '../globalSurface/extensions/extensionsSurfaceTarget'

export type CardSurfaceRoute =
  { kind: 'extensions-home' } | { kind: 'settings-agents' } | { kind: 'extensions'; view: ExtensionsDrawerView }

export function cardSurfaceRoute(view: CardSurfaceView): CardSurfaceRoute {
  switch (view) {
    case 'home':
      return { kind: 'extensions-home' }
    case 'agent-clis':
      return { kind: 'settings-agents' }
    case 'plugins':
      return { kind: 'extensions', view: EXTENSIONS_DRAWER_VIEWS.plugins }
    case 'skills':
      return { kind: 'extensions', view: EXTENSIONS_DRAWER_VIEWS.skills }
  }
}
