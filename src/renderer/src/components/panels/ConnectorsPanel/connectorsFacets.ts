// connectorsFacets — pure, DOM-free derivation for the Connectors surface. The
// React panel (`ConnectorsPanel.tsx`) owns the two catalog IPC reads and the
// rendering; the source-merge, facet bucketing, search, and state machine live
// here so every state (loading / partial-source-failure / error / empty /
// no-match / ready) gets node-level coverage, mirroring `storefrontView.ts`.
//
// Two real sources feed one grid:
//   1. MCP catalog (`window.api.mcpListCatalog`) — the launchable connectors. A
//      catalog entry is launchable when it carries a `skill` link (Railway's
//      driving-skill model) OR is installed in the workspace's MCP settings —
//      an installed server launches as a plain connector chat (isolated MCP,
//      no seeded skill), matching launchConnectorChat.
//   2. Marketplace registry (`window.api.readMarketplaceRegistry`) — installable
//      plugins that `provides` mcp/skills. Browsable/installable here; launching
//      still requires a catalog or installed-settings entry.

import type { McpCatalogServer, McpServerConfig } from '../../../../../shared/electron-api'
import type { AgentComposerConnector } from '../../workspace/agentComposer/AgentComposer'
import type {
  MarketplaceComponentKind,
  MarketplacePluginEntry,
} from '../../../../../shared/marketplace/manifest'
import { componentKindLabels } from '../../settings/storefrontView'
import { connectorCanLaunch } from '../../../../../shared/connector-launch'

export type ConnectorSource = 'catalog' | 'registry'

// The category an entry lands in, which is the heading it renders under.
//
// These were the facet TABS of the browse grid until the source-tabs ruling
// (2026-09-05): the tab row belongs to the sources now, so a category is a
// group inside a source rather than a filter across all of them. `Featured`
// went with the tabs — it ranked the catalogue by "can this launch on this
// machine right now", which is a fact about the machine, and it hid everything
// else behind a tab nobody chose. `Other` is a real bucket rather than a
// dropped one: an unmapped category still renders, under "More".
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
  // A launchable connector: a catalog entry with a driving skill, or one the
  // user has installed (enabled in MCP settings). Only these get New chat and
  // only these populate the Featured rail.
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
// Payments), the HotStack controlled vocabulary the generated catalogue
// carries (code, communication, data, design, development, productivity,
// sales-marketing), plus common marketplace category words so registry plugins
// bucket sensibly too. Payments is tested first so a "payments data" style
// label reads as Payments rather than Data.
const FACET_RULES: ReadonlyArray<{ facet: NamedFacet; test: RegExp }> = [
  { facet: 'Payments', test: /pay|billing|invoic|commerce|checkout|stripe/i },
  {
    facet: 'Infrastructure',
    test: /deploy|infra|host|server|cloud|devops|ci\/?cd|container|docker|kubernet|observab|monitor|logging|testing|develop|\bcode\b|security/i,
  },
  { facet: 'Data', test: /data|\bdb\b|sql|warehouse|analytic|search|vector|storage|\bmaps?\b|geospatial|\bai\b|\bmodels?\b/i },
  {
    facet: 'Productivity',
    test: /plan|project|issue|task|ticket|knowledge|doc|design|calendar|email|chat|note|productiv|crm|communicat|market/i,
  },
]

// THE launchable-connector rule, in one place: a connector launches when the
// catalog pairs a driving skill with it (Railway's model — launchable even
// before install, the launch synthesizes its config from the catalog), or when
// the user has it installed and enabled in MCP settings (plain connector chat:
// isolated MCP, no seeded skill). Every surface that offers or performs a
// launch — canLaunch below, the Ready-to-launch rail, the automation connector
// picker, and resolveConnectorLaunch — expresses it through this predicate so
// they cannot drift. It lives in `src/shared/connector-launch.ts` since MC-2159,
// because main resolves connectors for headless launches through the same rule.
export { connectorCanLaunch }

// Present an installed (settings) MCP server as a catalog-shaped entry so the
// Ready-to-launch rail renders one shape for both populations — catalog entries
// and installed custom servers that have no catalog row at all. The settings
// config is a superset of the catalog shape; only its settings-owned fields
// (enabled/scope/source) are dropped.
export function installedServerAsCatalogEntry(server: McpServerConfig): McpCatalogServer {
  const { enabled: _enabled, scope: _scope, source: _source, ...catalogShaped } = server
  return catalogShaped
}

// The merged launchable population behind the Ready-to-launch rail and the
// automation connector picker: skill-paired catalog entries first, then every
// installed+enabled server — the matching catalog entry when one exists
// (icon/summary), else the installed config presented catalog-shaped. Takes the
// catalog as a plain array so a failed catalog load (pass []) still surfaces
// the installed servers, which launch without the catalog.
export function launchableConnectors(
  catalog: McpCatalogServer[],
  installedServers: Record<string, McpServerConfig> | undefined,
): McpCatalogServer[] {
  const result = catalog.filter((server) => connectorCanLaunch(server.skill, false))
  const seen = new Set(result.map((server) => server.id))
  const catalogById = new Map(catalog.map((server) => [server.id, server]))
  for (const config of Object.values(installedServers ?? {})) {
    if (!config.enabled || seen.has(config.id)) continue
    seen.add(config.id)
    result.push(catalogById.get(config.id) ?? installedServerAsCatalogEntry(config))
  }
  return result
}

// The connector "New chat" payload. Identity plus the display bits the
// composer's attachment chip shows — the spawn still resolves the server itself
// from the id. `icon` is optional: the chip falls back to the brand icon keyed
// off the id, so an entry without a catalog record still renders.
export function connectorEntryAsComposerConnector(entry: ConnectorEntry): AgentComposerConnector {
  return { id: entry.id, name: entry.name, icon: entry.catalogServer?.icon }
}

export function connectorFacet(category: string): NamedFacet {
  const value = category.trim()
  if (!value) return 'Other'
  for (const rule of FACET_RULES) if (rule.test.test(value)) return rule.facet
  return 'Other'
}

// Catalog entries always carry an MCP server; a skill link adds a skills
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
    const installed = installedServerIds.has(server.id)
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
      canLaunch: connectorCanLaunch(server.skill, installed),
      installed,
      catalogServer: server,
    }
  })

  // Only mcp/skills plugins are connectors; module- and cli-only plugins are
  // different extension kinds — they browse on the door's own kind canvases
  // (MC-1847 C2, registryEntriesForKinds) rather than in the connector grid.
  const registryEntries: ConnectorEntry[] = registryEntriesForKinds(plugins, ['mcp', 'skills'])

  return [...catalogEntries, ...registryEntries]
}

// Registry plugins presented as normalized entries for a set of component
// kinds. The connector grid uses mcp/skills; the door's Modules and Agent CLIs
// canvases use module/cli — same row shape, same detail/install flow, no
// parallel presentation model.
export function registryEntriesForKinds(
  plugins: MarketplacePluginEntry[],
  kinds: readonly MarketplaceComponentKind[],
): ConnectorEntry[] {
  return plugins
    .filter((plugin) => plugin.provides.some((kind) => kinds.includes(kind)))
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
}

export function searchConnectors(entries: ConnectorEntry[], query: string): ConnectorEntry[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return entries
  return entries.filter((entry) => {
    const fields = [entry.name, entry.category, entry.summary ?? '', ...entry.tags]
    return fields.some((field) => field.toLowerCase().includes(needle))
  })
}

// One category section: a heading and the rows under it. It carries no
// collapsed state any more — the "Show N more" toggle it used to hide rows
// behind is the pager's job (source-tabs ruling, 2026-09-05), and a section
// that hid half of itself could not be walked by one.
export type ConnectorSection = {
  title: string
  entries: ConnectorEntry[]
}

const SECTION_ORDER: readonly NamedFacet[] = ['Infrastructure', 'Payments', 'Productivity', 'Data', 'Other']

// Group the (already searched) entries into category sections, in the declared
// order, with the unmapped bucket last under "More" — so a category the rules
// do not name is never silently dropped from the surface.
export function sectionConnectors(entries: ConnectorEntry[]): ConnectorSection[] {
  if (entries.length === 0) return []
  return SECTION_ORDER.map((bucket) => ({
    title: bucket === 'Other' ? 'More' : bucket,
    entries: entries.filter((entry) => entry.facet === bucket),
  })).filter((section) => section.entries.length > 0)
}

// Per-source async load. `undefined`-free: each source resolves to loading, a
// reachable failure, or ready data, so a partial failure (one source down) is a
// first-class state rather than a silent empty grid.
export type SourceLoad<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: T }
