import assert from 'node:assert/strict'

import type { McpCatalogServer } from '../../../../../shared/electron-api'
import type { MarketplacePluginEntry } from '../../../../../shared/marketplace/manifest'
import type { McpServerConfig } from '../../../../../shared/electron-api'
import {
  buildConnectorEntries,
  connectorCanLaunch,
  connectorFacet,
  deriveConnectorsView,
  facetCounts,
  filterByFacet,
  installedServerAsCatalogEntry,
  launchableConnectors,
  searchConnectors,
  sectionConnectors,
  type SourceLoad,
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

const ready = <T,>(data: T): SourceLoad<T> => ({ status: 'ready', data })

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
  // Installing one of the skill-less entries promotes it (and Featured follows).
  const withInstall = buildConnectorEntries([railwaySkilled, ...others], [], new Set(['vercel']))
  assert.deepEqual(
    filterByFacet(withInstall, 'Featured').map((e) => e.id),
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

// --- facet filtering + counts ---------------------------------------------

{
  const entries = buildConnectorEntries(
    [
      server({ skill: 'use-railway' }),
      server({ id: 'supabase', name: 'Supabase', category: 'Database', skill: undefined }),
    ],
    [plugin()],
    new Set(),
  )
  // Featured is the launchable rail.
  assert.deepEqual(filterByFacet(entries, 'Featured').map((e) => e.id), ['railway'])
  // Named facet buckets by category.
  assert.deepEqual(filterByFacet(entries, 'Data').map((e) => e.id), ['supabase'])
  assert.deepEqual(filterByFacet(entries, 'Payments').map((e) => e.id), ['stripe-mcp'])
  // All returns the full set.
  assert.equal(filterByFacet(entries, 'All').length, 3)

  const counts = facetCounts(entries)
  assert.equal(counts.All, 3)
  assert.equal(counts.Featured, 1)
  assert.equal(counts.Infrastructure, 1) // railway/Deployments
  assert.equal(counts.Data, 1)
  assert.equal(counts.Payments, 1)
  assert.equal(counts.Productivity, 0)
}

// --- view state machine ----------------------------------------------------

// Both loading → loading.
assert.equal(
  deriveConnectorsView({ status: 'loading' }, { status: 'loading' }, new Set(), '', 'All').status,
  'loading',
)

// One source still loading (the other ready) → still loading, no partial grid.
assert.equal(
  deriveConnectorsView(ready([server()]), { status: 'loading' }, new Set(), '', 'All').status,
  'loading',
)

// Both failed → hard error carrying both messages.
{
  const view = deriveConnectorsView(
    { status: 'error', message: 'catalog down.' },
    { status: 'error', message: 'registry down.' },
    new Set(),
    '',
    'All',
  )
  assert.equal(view.status, 'error')
  assert.match(view.status === 'error' ? view.message : '', /catalog down\. registry down\./)
}

// One source down, the other ready → ready with a degradation notice, not empty.
{
  const view = deriveConnectorsView(
    ready([server()]),
    { status: 'error', message: 'offline.' },
    new Set(),
    '',
    'All',
  )
  assert.equal(view.status, 'ready')
  assert.equal(view.status === 'ready' ? view.total : -1, 1)
  assert.match(view.status === 'ready' ? view.notice ?? '' : '', /Marketplace connectors are unavailable/)
}

// Both ready but empty → empty.
assert.equal(deriveConnectorsView(ready([]), ready([]), new Set(), '', 'All').status, 'empty')

// Search matches nothing → no-match (distinct from empty).
{
  const view = deriveConnectorsView(ready([server()]), ready([plugin()]), new Set(), 'zzz', 'All')
  assert.equal(view.status, 'no-match')
  assert.equal(view.status === 'no-match' ? view.query : '', 'zzz')
}

// A facet with no members → no-match for that facet even with no query.
{
  const view = deriveConnectorsView(ready([server()]), ready([]), new Set(), '', 'Payments')
  assert.equal(view.status, 'no-match')
}

// --- category sections ------------------------------------------------------

// All tab: one collapsed section per non-empty facet bucket, tab-strip order,
// unmapped bucket last under a plain "More" heading. Empty buckets are dropped.
{
  const entries = buildConnectorEntries(
    [server(), server({ id: 'weather', name: 'Weather', category: 'Weather' })],
    [plugin()],
    new Set(),
  )
  const sections = sectionConnectors(entries, 'All')
  assert.deepEqual(
    sections.map((section) => section.title),
    ['Infrastructure', 'Payments', 'More'],
  )
  assert.ok(sections.every((section) => !section.expanded))
  assert.deepEqual(sections[0].entries.map((entry) => entry.id), ['railway'])
  assert.deepEqual(sections[2].entries.map((entry) => entry.id), ['weather'])
}

// A specific facet tab renders as a single expanded section (no show-more cutoff).
{
  const entries = filterByFacet(buildConnectorEntries([server()], [plugin()], new Set()), 'Payments')
  const sections = sectionConnectors(entries, 'Payments')
  assert.equal(sections.length, 1)
  assert.equal(sections[0].title, 'Payments')
  assert.equal(sections[0].expanded, true)
}

// No entries → no sections (the panel's empty/no-match states own that copy).
assert.deepEqual(sectionConnectors([], 'All'), [])

console.log('connectors-facets guard passed')
