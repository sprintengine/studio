// connectorsFacets — pure, DOM-free derivation for the Connectors surface. The
// React panel owns the registry IPC read and the rendering; the facet
// bucketing, search, and state machine live here so every state (loading /
// error / empty / no-match / ready) gets node-level coverage, mirroring
// `storefrontView.ts`.
//
// One source feeds the grid: the marketplace registry
// (`window.api.readMarketplaceRegistry`) — installable plugins that `provides`
// mcp/skills. A second source fed it until the third-party retirement
// (MC-2519, 2026-09-08): the bundled MCP catalogue, sixteen servers nobody here
// wrote, whose rows browsed beside the plugins and could launch before install
// when the row paired a driving skill. It is gone, and with it the whole
// `'catalog'` entry source; launching now requires a server the person
// installed, which is what `launchableConnectors` below lists.

import type { McpServerConfig, McpServerListing } from '../../../../../shared/electron-api'
import type { AgentComposerConnector } from '../../workspace/agentComposer/useAgentComposer'
import type { MarketplaceComponentKind, MarketplacePluginEntry } from '../../../../../shared/marketplace/manifest'
import { componentKindLabels } from '../../settings/storefrontView'
import { connectorCanLaunch } from '../../../../../shared/connector-launch'

type ConnectorSource = 'registry'

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
  // `${source}:${id}` — source-qualified since the grid had two populations,
  // and kept so a key never collides if it has two again.
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
  // A launchable connector: one the user has installed (enabled in MCP
  // settings). Registry rows are not installed by browsing them, so they report
  // `false` here and route through the storefront install flow instead.
  canLaunch: boolean
  installed: boolean
  // The raw plugin so the panel can hand the existing tiles/detail their native
  // shape without re-deriving it.
  plugin?: MarketplacePluginEntry
}

// Ordered category → facet rules; first match wins. Keyed to the category words
// a marketplace plugin actually carries, plus the vocabulary the retired
// connector catalogue used (Deployments, Code Hosting, Testing, Observability,
// Database, Search, Documentation, Knowledge, Planning, Design, Payments), kept
// because those words are common to any plugin directory rather than special to
// that file. Payments is tested first so a "payments data" style label reads as
// Payments rather than Data.
const FACET_RULES: ReadonlyArray<{ facet: NamedFacet; test: RegExp }> = [
  { facet: 'Payments', test: /pay|billing|invoic|commerce|checkout|stripe/i },
  {
    facet: 'Infrastructure',
    test: /deploy|infra|host|server|cloud|devops|ci\/?cd|container|docker|kubernet|observab|monitor|logging|testing|develop|\bcode\b|security/i,
  },
  {
    facet: 'Data',
    test: /data|\bdb\b|sql|warehouse|analytic|search|vector|storage|\bmaps?\b|geospatial|\bai\b|\bmodels?\b/i,
  },
  {
    facet: 'Productivity',
    test: /plan|project|issue|task|ticket|knowledge|doc|design|calendar|email|chat|note|productiv|crm|communicat|market/i,
  },
]

// THE launchable-connector rule, in one place: a connector launches when the
// user has it installed and enabled in MCP settings (a plain connector chat:
// isolated MCP, no seeded skill). Every surface that offers or performs a
// launch — canLaunch below, the Ready-to-launch rail, the automation connector
// picker, and resolveConnectorLaunch — expresses it through this predicate so
// they cannot drift. It lives in `src/shared/connector-launch.ts` since MC-2159,
// because main resolves connectors for headless launches through the same rule.
export { connectorCanLaunch }

// Present an installed (settings) MCP server as a display listing, so a surface
// draws one shape whether the row came from settings or from anywhere else. The
// settings config is a superset of the listing shape; only its settings-owned
// fields (enabled/scope/source) are dropped.
export function installedServerAsListing(server: McpServerConfig): McpServerListing {
  const { enabled: _enabled, scope: _scope, source: _source, ...listing } = server
  return listing
}

// The launchable population behind the Ready-to-launch rail and the automation
// connector picker: every installed, enabled MCP server, presented as a
// listing. Until the third-party retirement (MC-2519, 2026-09-08) the bundled
// catalogue's skill-paired rows came first and could launch before install;
// there is no such row any more, so this is exactly what the person installed.
export function launchableConnectors(
  installedServers: Record<string, McpServerConfig> | undefined,
): McpServerListing[] {
  return Object.values(installedServers ?? {})
    .filter((config) => config.enabled)
    .map(installedServerAsListing)
}

// The connector "New chat" payload. Identity plus the display bits the
// composer's attachment chip shows — the spawn still resolves the server itself
// from the id. No `icon`: the chip falls back to the brand icon keyed off the
// id, so an entry with no artwork of its own still renders.
export function connectorEntryAsComposerConnector(entry: ConnectorEntry): AgentComposerConnector {
  return { id: entry.id, name: entry.name }
}

export function connectorFacet(category: string): NamedFacet {
  const value = category.trim()
  if (!value) return 'Other'
  for (const rule of FACET_RULES) if (rule.test.test(value)) return rule.facet
  return 'Other'
}

/**
 * The Plugins catalogue's entries: the registry's mcp, skills and module
 * plugins.
 *
 * This took a second `catalog` population until the third-party retirement
 * (MC-2519, 2026-09-08) and is kept as its own function rather than collapsed
 * into `registryEntriesForKinds`, because it names the catalogue's rule where
 * the door's other canvases name theirs.
 *
 * `module` joined the list on 2026-09-10 (D10). Until then a module-only entry
 * was in the registry, had a detail panel, had an install flow — and appeared
 * on no canvas a person could reach, because the Modules canvas the original
 * split assumed never shipped. So the one extension kind that adds a whole door
 * to the app was the one kind nobody could install from the Extensions door.
 * The install path is unchanged and needs no workspace for a module-only bundle
 * (`needsWorkspace`, BrowseStorefront.tsx): only mcp and skills components
 * write into a project.
 *
 * `cli` stays out: agent CLIs have their own canvas (`AgentClisCatalogue`) with
 * its own install/launch affordances, and listing them twice would be one thing
 * counted twice on two tabs.
 */
export function buildConnectorEntries(plugins: MarketplacePluginEntry[]): ConnectorEntry[] {
  return registryEntriesForKinds(plugins, ['mcp', 'skills', 'module'])
}

// Registry plugins presented as normalized entries for a set of component
// kinds. The Plugins catalogue uses mcp/skills/module; the door's Agent CLIs
// canvas uses cli — same row shape, same detail/install flow, no parallel
// presentation model.
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
export type SourceLoad<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: T }
