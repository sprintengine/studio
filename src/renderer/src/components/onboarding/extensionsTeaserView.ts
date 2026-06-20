// Pure, DOM-free view-model for the first-run extensions teaser. Mirrors the
// other settings/onboarding view-models (storefrontView, agentConfigAdoption):
// the React component owns IPC + rendering, the state machine lives here so every
// teaser state — including the offline cache/seed `staleNotice` fallback — gets
// node-level coverage without bundling the store or component graph.

import type { BrowseView } from '../settings/storefrontView'
import type { MarketplacePluginEntry } from '../../../../shared/marketplace/manifest'

// How many leading registry entries the teaser previews. Small on purpose: a
// taste of what's available, not a catalog.
export const TEASER_LIMIT = 3

// The leading entries to preview, pulled from a `ready` browse view. Featured
// leads when present; otherwise the first categorized entries.
export function selectTeaserPlugins(view: BrowseView, limit = TEASER_LIMIT): MarketplacePluginEntry[] {
  if (view.status !== 'ready') return []
  const lead = [...view.featured, ...view.groups.flatMap((group) => group.plugins)]
  return lead.slice(0, limit)
}

// What the teaser should render. `staleNotice` rides the `list`/`empty` states so
// cached/seed offline data is disclosed as a fallback, never shown as live or as
// a definitive empty registry.
export type TeaserView =
  // Old build with no registry IPC, or a ready view with no lead entries — the
  // section is omitted entirely rather than showing a dead control.
  | { kind: 'hidden' }
  | { kind: 'loading' }
  // Offline with NO cached/seed data to fall back on.
  | { kind: 'offline' }
  | { kind: 'error' }
  | { kind: 'empty'; staleNotice: string | null }
  | { kind: 'list'; plugins: MarketplacePluginEntry[]; staleNotice: string | null }

export function deriveTeaserView(view: BrowseView, limit = TEASER_LIMIT): TeaserView {
  switch (view.status) {
    case 'unsupported':
      return { kind: 'hidden' }
    case 'loading':
      return { kind: 'loading' }
    case 'offline':
      return { kind: 'offline' }
    case 'error':
      return { kind: 'error' }
    // query is always '' in the teaser, so 'no-match' is unreachable; fold it into
    // the empty state defensively rather than leaving a dead branch.
    case 'no-match':
      return { kind: 'empty', staleNotice: view.staleNotice ?? null }
    case 'empty':
      return { kind: 'empty', staleNotice: view.staleNotice ?? null }
    case 'ready': {
      const plugins = selectTeaserPlugins(view, limit)
      if (plugins.length === 0) return { kind: 'hidden' }
      return { kind: 'list', plugins, staleNotice: view.staleNotice ?? null }
    }
  }
}
