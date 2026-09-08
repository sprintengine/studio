import assert from 'node:assert/strict'

import type { McpCatalogServer } from '../../../../../shared/electron-api'
import type { MarketplacePluginEntry } from '../../../../../shared/marketplace/manifest'
import type { McpServerConfig } from '../../../../../shared/electron-api'
import {
  buildConnectorEntries,
  connectorCanLaunch,
  connectorEntryAsComposerConnector,
  connectorFacet,
  installedServerAsCatalogEntry,
  launchableConnectors,
  registryEntriesForKinds,
  searchConnectors,
  sectionConnectors,
} from './connectorsFacets'

// The Connectors surface must merge two real sources into one faceted grid, mark
// catalog entries launchable when they carry a driving skill OR are installed in
// MCP settings, and never collapse a failed source into a silent empty grid: a
// single-source failure degrades to a notice, a total failure is an explicit
// error, and "empty" means both sources truly list nothing (distinct from a
// search that matched nothing).

function server(overrides: Partial<McpCatalogServer> = {}): McpCatalogServer {
  return {
    id: 'railway',
    name: 'Railway',
    category: 'Deployments',
    description: 'Deploys, services, logs',
    transport: 'http',
    clients: [],
    required: false,
    riskLevel: 'low',
    skill: 'use-railway',
    ...overrides,
  } as McpCatalogServer
}

function plugin(overrides: Partial<MarketplacePluginEntry> = {}): MarketplacePluginEntry {
  return {
    id: 'stripe-mcp',
    name: 'Stripe',
    publisher: { name: 'Stripe', verified: true },
    summary: 'Payments, billing, customers',
    category: 'Payments',
    icon: 'stripe.svg',
    latest: 1,
    provides: ['mcp', 'skills'],
    ...overrides,
  }
}

// --- category → facet bucketing -------------------------------------------

// Every real catalog category buckets into one of the four named facets (no
// catalog entry falls through to Other).
assert.equal(connectorFacet('Deployments'), 'Infrastructure')
assert.equal(connectorFacet('Code Hosting'), 'Infrastructure')
assert.equal(connectorFacet('Testing'), 'Infrastructure')
assert.equal(connectorFacet('Observability'), 'Infrastructure')
assert.equal(connectorFacet('Payments'), 'Payments')
assert.equal(connectorFacet('Database'), 'Data')
assert.equal(connectorFacet('Search'), 'Data')
assert.equal(connectorFacet('Documentation'), 'Productivity')
assert.equal(connectorFacet('Knowledge'), 'Productivity')
assert.equal(connectorFacet('Planning'), 'Productivity')
assert.equal(connectorFacet('Design'), 'Productivity')
// An unknown category is preserved as Other, never guessed into a named facet.
assert.equal(connectorFacet('Weather'), 'Other')
assert.equal(connectorFacet(''), 'Other')

// --- source merge ----------------------------------------------------------

{
  const entries = buildConnectorEntries(
    [server(), server({ id: 'github', name: 'GitHub', category: 'Code Hosting', skill: undefined })],
    [plugin()],
    new Set(['github']),
  )
  assert.equal(entries.length, 3)
  const railway = entries.find((e) => e.id === 'railway')!
  // Skill-linked catalog entries are launchable even when not installed.
  assert.equal(railway.canLaunch, true)
  assert.deepEqual(railway.componentLabels, ['MCP server', 'Skill pack'])
  assert.equal(railway.key, 'catalog:railway')
  const github = entries.find((e) => e.id === 'github')!
  // An installed skill-less entry is launchable too (plain connector chat).
  assert.equal(github.canLaunch, true)
  assert.deepEqual(github.componentLabels, ['MCP server'])
  // Installed reflects the active workspace's MCP settings for catalog entries.
  assert.equal(github.installed, true)
  assert.equal(railway.installed, false)
  const stripe = entries.find((e) => e.source === 'registry')!
  assert.equal(stripe.canLaunch, false)
  assert.equal(stripe.facet, 'Payments')
}

// Neither skill-linked nor installed → not launchable.
{
  const entries = buildConnectorEntries(
    [server({ id: 'vercel', name: 'Vercel', skill: undefined })],
    [],
    new Set(),
  )
  assert.equal(entries[0].canLaunch, false)
}

// Registry plugins that provide neither mcp nor skills are not connectors and are
// dropped from the surface.
{
  const entries = buildConnectorEntries(
    [],
    [plugin({ id: 'theme-pack', provides: ['module'] }), plugin({ id: 'cli-only', provides: ['cli'] })],
    new Set(),
  )
  assert.equal(entries.length, 0)
}

// --- with nothing installed, the skill link is the only launch route --------

{
  const railwaySkilled = server({ skill: 'use-railway' })
  const others = [
    server({ id: 'vercel', name: 'Vercel', category: 'Deployments', skill: undefined }),
    server({ id: 'stripe', name: 'Stripe', category: 'Payments', skill: undefined }),
  ]
  const entries = buildConnectorEntries([railwaySkilled, ...others], [], new Set())
  const launchable = entries.filter((e) => e.canLaunch)
  assert.deepEqual(launchable.map((e) => e.id), ['railway'])
  // Installing one of the skill-less entries promotes it.
  const withInstall = buildConnectorEntries([railwaySkilled, ...others], [], new Set(['vercel']))
  assert.deepEqual(
    withInstall.filter((e) => e.canLaunch).map((e) => e.id),
    ['railway', 'vercel'],
  )
}

// --- installed settings servers present catalog-shaped for the launch rail --

{
  const installed: McpServerConfig = {
    id: 'my-custom',
    name: 'My custom MCP',
    description: 'A hand-added server',
    transport: 'stdio',
    command: 'custom-mcp',
    enabled: true,
    clients: [],
    scope: 'workspace',
    source: 'custom',
    riskLevel: 'network',
  } as McpServerConfig
  const entry = installedServerAsCatalogEntry(installed)
  assert.equal(entry.id, 'my-custom')
  assert.equal(entry.name, 'My custom MCP')
  assert.equal(entry.transport, 'stdio')
  // Settings-owned fields are dropped from the catalog shape.
  assert.ok(!('enabled' in entry))
  assert.ok(!('scope' in entry))
  assert.ok(!('source' in entry))
}

// --- the one launchable rule + the merged launch population -----------------

assert.equal(connectorCanLaunch('use-railway', false), true)
assert.equal(connectorCanLaunch(undefined, true), true)
assert.equal(connectorCanLaunch(undefined, false), false)

{
  const config = (overrides: Partial<McpServerConfig>): McpServerConfig =>
    ({
      id: 'x',
      name: 'X',
      transport: 'http',
      enabled: true,
      clients: [],
      scope: 'workspace',
      source: 'custom',
      riskLevel: 'network',
      ...overrides,
    }) as McpServerConfig
  const catalog = [
    server({ skill: 'use-railway' }),
    server({ id: 'github', name: 'GitHub', category: 'Code Hosting', skill: undefined }),
  ]
  const installed: Record<string, McpServerConfig> = {
    github: config({ id: 'github', name: 'GitHub' }),
    linear: config({ id: 'linear', name: 'Linear', enabled: false }),
    'my-custom': config({ id: 'my-custom', name: 'My custom MCP' }),
  }
  const ready = launchableConnectors(catalog, installed)
  // Skill-paired catalog entries lead; installed entries follow deduped by id;
  // a disabled installed server never surfaces.
  assert.deepEqual(ready.map((entry) => entry.id), ['railway', 'github', 'my-custom'])
  // The catalog row (icon/summary/category) is preferred for installed ids the
  // catalog knows; custom servers are presented catalog-shaped.
  assert.equal(ready.find((entry) => entry.id === 'github')!.category, 'Code Hosting')
  assert.equal(ready.find((entry) => entry.id === 'my-custom')!.name, 'My custom MCP')
  // A failed catalog load (empty catalog) still surfaces the installed servers.
  assert.deepEqual(launchableConnectors([], installed).map((entry) => entry.id), ['github', 'my-custom'])
  // No installed servers → just the skill-paired catalog entries.
  assert.deepEqual(launchableConnectors(catalog, undefined).map((entry) => entry.id), ['railway'])
}

// --- search across both sources -------------------------------------------

{
  const entries = buildConnectorEntries([server()], [plugin()], new Set())
  // Name match.
  assert.deepEqual(searchConnectors(entries, 'railway').map((e) => e.id), ['railway'])
  // Summary match on the registry source.
  assert.deepEqual(searchConnectors(entries, 'billing').map((e) => e.id), ['stripe-mcp'])
  // Category match.
  assert.deepEqual(searchConnectors(entries, 'payments').map((e) => e.id), ['stripe-mcp'])
  // Empty query returns everything.
  assert.equal(searchConnectors(entries, '   ').length, 2)
  // No match.
  assert.equal(searchConnectors(entries, 'zzz').length, 0)
}

// Registry tag/categories facets are searchable too.
{
  const entries = buildConnectorEntries([], [plugin({ tags: ['webhooks'], categories: ['Finance'] })], new Set())
  assert.equal(searchConnectors(entries, 'webhooks').length, 1)
  assert.equal(searchConnectors(entries, 'finance').length, 1)
}

// --- the category bucket a row renders under -------------------------------
// The facet TABS that filtered across every source went with the browse grid
// (source-tabs ruling, 2026-09-05): a category is a group inside a source's own
// tab now, so what an entry carries is the bucket, not a filter.
{
  const entries = buildConnectorEntries(
    [
      server({ skill: 'use-railway' }),
      server({ id: 'supabase', name: 'Supabase', category: 'Database', skill: undefined }),
    ],
    [plugin()],
    new Set(),
  )
  assert.deepEqual(
    entries.map((entry) => [entry.id, entry.facet]),
    [
      ['railway', 'Infrastructure'],
      ['supabase', 'Data'],
      ['stripe-mcp', 'Payments'],
    ],
  )
}


// --- category sections ------------------------------------------------------

// One section per non-empty bucket, in the declared order, with the unmapped
// bucket last under a plain "More" heading. Empty buckets are dropped, and no
// section hides half of itself: the pager walks the whole tab (source-tabs
// ruling, 2026-09-05), which a section with its own cutoff could not be part of.
{
  const entries = buildConnectorEntries(
    [server(), server({ id: 'weather', name: 'Weather', category: 'Weather' })],
    [plugin()],
    new Set(),
  )
  const sections = sectionConnectors(entries)
  assert.deepEqual(
    sections.map((section) => section.title),
    ['Infrastructure', 'Payments', 'More'],
  )
  assert.deepEqual(sections[0].entries.map((entry) => entry.id), ['railway'])
  assert.deepEqual(sections[2].entries.map((entry) => entry.id), ['weather'])
}

// No entries → no sections (the tab's empty/no-match sentence owns that copy).
assert.deepEqual(sectionConnectors([]), [])

// "New chat" hands the host the connector itself, not a bare id: the composer's
// attachment chip needs the display name at open, with no second catalog read.
{
  const [entry] = buildConnectorEntries([server({ icon: 'railway.svg' })], [], new Set())
  assert.deepEqual(connectorEntryAsComposerConnector(entry), {
    id: 'railway',
    name: 'Railway',
    icon: 'railway.svg',
  })
}


// --- registry entries by kind (MC-1847 C2) ---------------------------------
// Module/cli plugins browse on the door's own kind canvases; the connector grid
// keeps its mcp/skills subset. Same normalized row shape from one builder.
{
  const roadmapModule = plugin({ id: 'roadmap-module', name: 'Roadmap', provides: ['module'] })
  const cursorCli = plugin({ id: 'cursor-cli', name: 'Cursor', provides: ['cli'] })
  const stack = plugin({ id: 'full-stack', name: 'Full stack', provides: ['mcp', 'skills', 'module', 'cli'] })
  const all = [plugin(), roadmapModule, cursorCli, stack]

  assert.deepEqual(
    registryEntriesForKinds(all, ['module']).map((entry) => entry.id),
    ['roadmap-module', 'full-stack'],
  )
  assert.deepEqual(
    registryEntriesForKinds(all, ['cli']).map((entry) => entry.id),
    ['cursor-cli', 'full-stack'],
  )
  // The connector grid path is the same builder with mcp/skills — module- and
  // cli-only plugins stay out of it.
  assert.deepEqual(
    buildConnectorEntries([], all, new Set()).map((entry) => entry.id),
    ['stripe-mcp', 'full-stack'],
  )
  // Kind entries are never launchable and keep the registry install route.
  const [moduleEntry] = registryEntriesForKinds(all, ['module'])
  assert.equal(moduleEntry.canLaunch, false)
  assert.equal(moduleEntry.source, 'registry')
  assert.ok(moduleEntry.plugin)
}

// --- module-first card copy + launch exclusion (MC-1531) --------------------
// A module entry's row fields come straight from the index entry, whose
// name/summary ARE the module manifest's displayName + summary (the shared
// authoring projection derives them) — the card leads with what the module
// adds, never bundle mechanics. Module-only plugins never reach the Featured
// (launchable) rail, never count toward it, and never enter the connector grid.
{
  const calendar = plugin({
    id: 'multicode-calendar',
    name: 'Calendar',
    summary: 'Adds a calendar workspace type: time-block notes and schedule Backlog items.',
    category: 'Productivity',
    provides: ['module'],
  })
  const [entry] = registryEntriesForKinds([calendar], ['module'])
  assert.equal(entry.name, 'Calendar')
  assert.equal(entry.summary, 'Adds a calendar workspace type: time-block notes and schedule Backlog items.')
  assert.deepEqual(entry.componentLabels, ['Module'])
  assert.equal(entry.canLaunch, false)
  assert.equal(entry.canLaunch, false, 'a module-only plugin is never launchable')
  assert.deepEqual(buildConnectorEntries([], [calendar], new Set()), [])
  // A mixed bundle (mcp + module) is a connector too, but its connector row
  // never launches from the registry side — install still gates launch.
  const mixed = plugin({ id: 'suite', name: 'Suite', provides: ['mcp', 'module'] })
  const gridRows = buildConnectorEntries([], [mixed], new Set())
  assert.deepEqual(gridRows.map((row) => row.id), ['suite'])
  assert.equal(gridRows[0].canLaunch, false)
}

console.log('connectors-facets guard passed')
