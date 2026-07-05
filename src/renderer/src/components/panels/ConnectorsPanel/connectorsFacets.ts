// connectorsFacets — pure, DOM-free derivation for the Connectors surface. The
// React panel (`ConnectorsPanel.tsx`) owns the two catalog IPC reads and the
// rendering; the source-merge, facet bucketing, search, and state machine live
// here so every state (loading / partial-source-failure / error / empty /
// no-match / ready) gets node-level coverage, mirroring `storefrontView.ts`.
//
// Two real sources feed one grid:
//   1. MCP catalog (`window.api.mcpListCatalog`) — the launchable connectors. A
//      connector is a catalog entry carrying a `skill` link (matches T1's
//      launchConnectorChat rule); today only Railway qualifies.
//   2. Marketplace registry (`window.api.readMarketplaceRegistry`) — installable
//      plugins that `provides` mcp/skills. Browsable/installable here; launching
//      still requires the catalog+skill entry.

import type { McpCatalogServer } from '../../../../../shared/electron-api'
import type {
  MarketplaceComponentKind,
  MarketplacePluginEntry,
} from '../../../../../shared/marketplace/manifest'
import { componentKindLabels } from '../../settings/storefrontView'

export type ConnectorSource = 'catalog' | 'registry'

// The six facet tabs from the surface mockup. `Featured` and `All` are computed
// rails, not category buckets; the four middle tabs bucket by category.
export type ConnectorFacet = 'Featured' | 'Infrastructure' | 'Payments' | 'Productivity' | 'Data' | 'All'

export const CONNECTOR_FACETS: readonly ConnectorFacet[] = [
  'Featured',
  'Infrastructure',
  'Payments',
  'Productivity',
  'Data',
  'All',
]

// The category bucket an entry lands in. `Other` never matches a named tab; those
// entries surface only under `All`, so an unmapped category is never silently
// dropped from the surface.
export type NamedFacet = 'Infrastructure' | 'Payments' | 'Productivity' | 'Data' | 'Other'

// One row/tile in the surface, normalized across both sources so the grid,
// search, and facet logic never branch on source.
export type ConnectorEntry = {
  // `${source}:${id}` — a catalog and a registry entry can share an id, so the
  // source-qualified key is what keeps React keys and selection unambiguous.
  key: string
  id: string
  source: ConnectorSource
  name: string
  category: string
  summary?: string
  tags: string[]
  // Sentence-case component labels ("MCP server", "Skill pack") for the subtitle,
  // via storefrontView's shared COMPONENT_KIND_LABEL map.
  componentLabels: string[]
  facet: NamedFacet
  // A launchable connector (catalog entry with a skill). Only these get New chat
  // and only these populate the Featured rail.
  canLaunch: boolean
  // Catalog entry present in the active workspace's MCP settings. Registry
  // install-state detection is out of this task's scope, so registry entries
  // report `false` and route through the storefront install flow instead.
  installed: boolean
  // Raw source refs so the panel can hand the existing tiles/detail their native
  // shapes without re-deriving them.
  catalogServer?: McpCatalogServer
  plugin?: MarketplacePluginEntry
}

// Ordered category → facet rules; first match wins. Keyed to the real
// `resources/mcps/catalog.json` categories (Deployments, Code Hosting, Testing,
// Observability, Database, Search, Documentation, Knowledge, Planning, Design,
// Payments) plus common marketplace category words so registry plugins bucket
// sensibly too. Payments is tested first so a "payments data" style label reads
// as Payments rather than Data.
const FACET_RULES: ReadonlyArray<{ facet: NamedFacet; test: RegExp }> = [
  { facet: 'Payments', test: /pay|billing|invoic|commerce|checkout|stripe/i },
  {
    facet: 'Infrastructure',
    test: /deploy|infra|host|server|cloud|devops|ci\/?cd|container|docker|kubernet|observab|monitor|logging|testing/i,
  },
  { facet: 'Data', test: /data|\bdb\b|sql|warehouse|analytic|search|vector|storage/i },
  { facet: 'Productivity', test: /plan|project|issue|task|ticket|knowledge|doc|design|calendar|email|chat|note|productiv|crm/i },
]

export function connectorFacet(category: string): NamedFacet {
  const value = category.trim()
  if (!value) return 'Other'
  for (const rule of FACET_RULES) if (rule.test.test(value)) return rule.facet
  return 'Other'
}

// Catalog entries always carry an MCP server; a skill link adds a skill-pack
// component. This mirrors the registry `provides` vocabulary so both sources feed
// the same COMPONENT_KIND_LABEL map.
function catalogProvides(server: McpCatalogServer): MarketplaceComponentKind[] {
  return server.skill ? ['mcp', 'skills'] : ['mcp']
}

export function buildConnectorEntries(
  catalog: McpCatalogServer[],
  plugins: MarketplacePluginEntry[],
  installedServerIds: ReadonlySet<string>,
): ConnectorEntry[] {
  const catalogEntries: ConnectorEntry[] = catalog.map((server) => {
    const category = server.category?.trim() || 'Other'
    return {
      key: `catalog:${server.id}`,
      id: server.id,
      source: 'catalog',
      name: server.name,
      category,
      summary: server.description,
      tags: server.capabilities ?? [],
      componentLabels: componentKindLabels(catalogProvides(server)),
      facet: connectorFacet(category),
      canLaunch: Boolean(server.skill),
      installed: installedServerIds.has(server.id),
      catalogServer: server,
    }
  })

  // Only mcp/skills plugins are connectors; a module- or cli-only plugin is a
  // different kind of extension and does not belong on this surface.
  const registryEntries: ConnectorEntry[] = plugins
    .filter((plugin) => plugin.provides.some((kind) => kind === 'mcp' || kind === 'skills'))
    .map((plugin) => {
      const category = plugin.category.trim() || 'Other'
      return {
        key: `registry:${plugin.id}`,
        id: plugin.id,
        source: 'registry',
        name: plugin.name,
        category,
        summary: plugin.summary,
        tags: [...(plugin.categories ?? []), ...(plugin.tags ?? [])],
        componentLabels: componentKindLabels(plugin.provides),
        facet: connectorFacet(category),
        canLaunch: false,
        installed: false,
        plugin,
      }
    })

  return [...catalogEntries, ...registryEntries]
}

export function searchConnectors(entries: ConnectorEntry[], query: string): ConnectorEntry[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return entries
  return entries.filter((entry) => {
    const fields = [entry.name, entry.category, entry.summary ?? '', ...entry.tags]
    return fields.some((field) => field.toLowerCase().includes(needle))
  })
}

export function filterByFacet(entries: ConnectorEntry[], facet: ConnectorFacet): ConnectorEntry[] {
  if (facet === 'All') return entries
  if (facet === 'Featured') return entries.filter((entry) => entry.canLaunch)
  return entries.filter((entry) => entry.facet === facet)
}

// Per-tab counts over the search-filtered set, so the badges track the active
// query. Every facet is present in the record (0 when empty) so the tab strip
// renders a stable set.
export function facetCounts(entries: ConnectorEntry[]): Record<ConnectorFacet, number> {
  const counts: Record<ConnectorFacet, number> = {
    Featured: 0,
    Infrastructure: 0,
    Payments: 0,
    Productivity: 0,
    Data: 0,
    All: entries.length,
  }
  for (const entry of entries) {
    if (entry.canLaunch) counts.Featured += 1
    if (entry.facet !== 'Other') counts[entry.facet] += 1
  }
  return counts
}

// Per-source async load. `undefined`-free: each source resolves to loading, a
// reachable failure, or ready data, so a partial failure (one source down) is a
// first-class state rather than a silent empty grid.
export type SourceLoad<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: T }

export type ConnectorsView =
  | { status: 'loading' }
  // Both sources failed — an explicit error, never an empty grid.
  | { status: 'error'; message: string }
  // Both sources resolved and neither lists any connector.
  | { status: 'empty'; notice?: string }
  // Connectors exist but none match the active search + facet.
  | { status: 'no-match'; query: string; facet: ConnectorFacet; notice?: string }
  | {
      status: 'ready'
      entries: ConnectorEntry[]
      counts: Record<ConnectorFacet, number>
      total: number
      // Present when exactly one source failed: the grid still renders the
      // healthy source and discloses the degraded one.
      notice?: string
    }

// Combine the two source loads with the active query + facet into one view. A
// single failed source degrades to a `notice`, never to an error; only a total
// failure (or a total failure while nothing else is still loading) is an error.
export function deriveConnectorsView(
  catalogLoad: SourceLoad<McpCatalogServer[]>,
  registryLoad: SourceLoad<MarketplacePluginEntry[]>,
  installedServerIds: ReadonlySet<string>,
  query: string,
  facet: ConnectorFacet,
): ConnectorsView {
  const catalogReady = catalogLoad.status === 'ready'
  const registryReady = registryLoad.status === 'ready'
  const catalogFailed = catalogLoad.status === 'error'
  const registryFailed = registryLoad.status === 'error'

  // Both down → hard error surfacing both causes.
  if (catalogFailed && registryFailed) {
    return { status: 'error', message: `${catalogLoad.message} ${registryLoad.message}`.trim() }
  }
  // Still waiting on a source that has not failed → keep loading rather than
  // flashing a partial grid.
  if ((catalogLoad.status === 'loading' && !registryFailed) || (registryLoad.status === 'loading' && !catalogFailed)) {
    return { status: 'loading' }
  }

  const notice = catalogFailed
    ? `Some connectors are unavailable: ${catalogLoad.message}`
    : registryFailed
      ? `Marketplace connectors are unavailable: ${registryLoad.message}`
      : undefined

  const entries = buildConnectorEntries(
    catalogReady ? catalogLoad.data : [],
    registryReady ? registryLoad.data : [],
    installedServerIds,
  )

  if (entries.length === 0) {
    return { status: 'empty', notice }
  }

  const searched = searchConnectors(entries, query)
  const counts = facetCounts(searched)
  const faceted = filterByFacet(searched, facet)

  if (faceted.length === 0) {
    return { status: 'no-match', query: query.trim(), facet, notice }
  }

  return { status: 'ready', entries: faceted, counts, total: faceted.length, notice }
}
