// storefrontView — pure, DOM-free derivation for the Settings → Extensions
// "Browse" storefront. The React component (`BrowseStorefront.tsx`) owns the
// registry IPC call and rendering; the state machine and filtering live here so
// every state (loading / unsupported / error / offline / empty / no-match /
// ready) gets node-level coverage like the other settings view-models.
//
// Phase-2 read-only scope: this consumes the T2.1 RegistryClient result
// (`window.api.readMarketplaceRegistry`) directly. That result is the registry
// INDEX (marketplace.json) only — it carries each plugin's components-carried
// (`provides`) and version (`latest`), but NOT the per-plugin permission list or
// changelog. Those live in the signed plugin.json that is downloaded and
// verified only at install time (Phase 3), so the detail view discloses them as
// install-time, never fabricated here.

import type { MarketplaceRegistryReadResult } from '../../../../shared/electron-api'
import type {
  MarketplaceComponentKind,
  MarketplacePluginEntry,
} from '../../../../shared/marketplace/manifest'

// Sentence-case labels for the component kinds a plugin bundles. Mirrors the
// installed-inventory kind labels so the same primitive reads the same way on
// both surfaces.
export const COMPONENT_KIND_LABEL: Record<MarketplaceComponentKind, string> = {
  mcp: 'MCP server',
  skills: 'Skill pack',
  module: 'Module',
  cli: 'Agent CLI',
}

export function componentKindLabels(provides: MarketplaceComponentKind[]): string[] {
  return provides.map((kind) => COMPONENT_KIND_LABEL[kind])
}

// Render-boundary guard for the "View source" affordance. A plugin `source` is
// only schema-checked as a non-empty string (manifest.ts), so once a third-party
// or catalogue registry is in play the value is attacker-influenced. The detail
// panel opens it via an external anchor that routes to shell.openExternal, and
// only http(s) is safe to hand there — a `file://`, `smb://`, or OS
// protocol-handler URL is a known Electron abuse vector. Return the value only
// when it parses to an http/https URL; otherwise fail closed to `undefined` so
// the component renders no link. Mirrors the fetch path's scheme distrust but
// intentionally omits the host allowlist: this is a display-only link.
export function externalSourceHref(source: string | undefined): string | undefined {
  if (!source) return undefined
  let url: URL
  try {
    url = new URL(source)
  } catch {
    return undefined
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? source : undefined
}

// How many leading (curated-order) entries lead the Featured rail. The first
// entries of the first-party curated index are the editorial lead (TD1); the
// rail only shows when there are more plugins than it would hold, so it never
// just duplicates a short full list.
const FEATURED_COUNT = 3

// `undefined` distinguishes "the running build predates the registry API" (old
// build) from a reachable-but-failed read.
export type BrowseLoad =
  | { status: 'loading' }
  | { status: 'unsupported' }
  // A thrown IPC exception (the typed result models reachable outcomes only).
  | { status: 'threw'; message: string }
  | { status: 'result'; result: MarketplaceRegistryReadResult }

export type PluginCategoryGroup = { category: string; plugins: MarketplacePluginEntry[] }

export type BrowseView =
  | { status: 'loading' }
  // The build predates the registry IPC — distinct from an empty registry.
  | { status: 'unsupported' }
  // Reached the registry and it failed (fetch-error / invalid-schema / threw).
  // Never a silent empty grid.
  | { status: 'error'; message: string; issues?: string[] }
  // Offline with NO cached index to fall back on — a distinct warn/retry state,
  // never collapsed into the generic error view (offline WITH a stale cache is
  // instead a `ready` view carrying `staleNotice`).
  | { status: 'offline'; message: string }
  // Registry reachable (or served from cache) but it lists no plugins.
  | { status: 'empty'; staleNotice?: string }
  // Plugins exist but the search query matched none.
  | { status: 'no-match'; query: string; staleNotice?: string }
  | {
      status: 'ready'
      featured: MarketplacePluginEntry[]
      groups: PluginCategoryGroup[]
      total: number
      // Present only when the data is served from a stale offline cache.
      staleNotice?: string
    }

export function filterPlugins(plugins: MarketplacePluginEntry[], query: string): MarketplacePluginEntry[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return plugins
  return plugins.filter((plugin) => {
    // Search the primary category plus every widened `categories[]`/`tags[]` facet
    // so a plugin surfaces on any label it carries, not just its display category.
    const fields = [
      plugin.name,
      plugin.category,
      plugin.summary,
      plugin.publisher.name,
      ...(plugin.categories ?? []),
      ...(plugin.tags ?? []),
    ]
    return fields.some((field) => field.toLowerCase().includes(needle))
  })
}

export function groupPluginsByCategory(plugins: MarketplacePluginEntry[]): PluginCategoryGroup[] {
  const groups = new Map<string, MarketplacePluginEntry[]>()
  for (const plugin of plugins) {
    const category = plugin.category.trim() || 'Other'
    groups.set(category, [...(groups.get(category) ?? []), plugin])
  }
  return Array.from(groups.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, entries]) => ({ category, plugins: entries }))
}

export function deriveBrowseView(load: BrowseLoad, query: string): BrowseView {
  if (load.status === 'loading') return { status: 'loading' }
  if (load.status === 'unsupported') return { status: 'unsupported' }
  if (load.status === 'threw') {
    return { status: 'error', message: load.message }
  }

  const result = load.result
  if (!result.ok) {
    // Offline with no cache is its own state (warn + retry), not a hard error.
    if (result.state === 'offline') {
      return { status: 'offline', message: result.message || "Offline — can't reach the extensions registry." }
    }
    const fallback =
      result.state === 'invalid-schema'
        ? "The extensions registry returned data this app can't read."
        : "Couldn't reach the extensions registry."
    return {
      status: 'error',
      message: result.message || fallback,
      issues: result.issues?.map((issue) => issue.message),
    }
  }

  // ok | empty | offline all carry a (possibly cached) marketplace index.
  const staleNotice = result.state === 'offline' ? result.message : undefined
  const plugins = result.marketplace.plugins

  if (plugins.length === 0) {
    return { status: 'empty', staleNotice }
  }

  const filtered = filterPlugins(plugins, query)
  if (filtered.length === 0) {
    return { status: 'no-match', query: query.trim(), staleNotice }
  }

  // Featured leads only the unfiltered, larger-than-the-rail view, so it never
  // just repeats a short full list or competes with an active search.
  const featured = !query.trim() && plugins.length > FEATURED_COUNT ? plugins.slice(0, FEATURED_COUNT) : []
  // Featured plugins are pulled out of the category groups so each plugin
  // renders exactly once (no duplicate cards / DOM ids); `total` still counts
  // every matched plugin.
  const featuredIds = new Set(featured.map((entry) => entry.id))
  const categorized = featured.length > 0 ? filtered.filter((entry) => !featuredIds.has(entry.id)) : filtered

  return {
    status: 'ready',
    featured,
    groups: groupPluginsByCategory(categorized),
    total: filtered.length,
    staleNotice,
  }
}
