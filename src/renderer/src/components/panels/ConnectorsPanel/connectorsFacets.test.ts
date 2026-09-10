import assert from 'node:assert/strict'

import type { MarketplacePluginEntry } from '../../../../../shared/marketplace/manifest'
import type { McpServerConfig } from '../../../../../shared/electron-api'
import {
  buildConnectorEntries,
  connectorCanLaunch,
  connectorEntryAsComposerConnector,
  connectorFacet,
  installedServerAsListing,
  launchableConnectors,
  registryEntriesForKinds,
  searchConnectors,
  sectionConnectors,
} from './connectorsFacets'

// The Connectors surface must turn the registry's mcp/skills plugins into one
// faceted grid, list exactly the installed+enabled MCP servers as launchable,
// and never collapse a failed read into a silent empty grid: a failure is an
// explicit error, and "empty" means the registry truly lists nothing (distinct
// from a search that matched nothing).
//
// It merged a second source until the third-party retirement (MC-2519,
// 2026-09-08) — the bundled MCP catalogue, whose rows browsed here and could
// launch before install when they carried a driving skill. Both are gone.

function config(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'my-custom',
    name: 'My custom MCP',
    description: 'A hand-added server',
    category: 'Deployments',
    transport: 'http',
    enabled: true,
    clients: [],
    scope: 'workspace',
    source: 'custom',
    riskLevel: 'network',
    ...overrides,
  } as McpServerConfig
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

// Every category word the surface meets buckets into one of the four named
// facets rather than falling through to Other.
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

// --- the grid's population ------------------------------------------------

{
  const entries = buildConnectorEntries([plugin()])
  assert.equal(entries.length, 1)
  const stripe = entries[0]
  assert.equal(stripe.source, 'registry')
  assert.equal(stripe.key, 'registry:stripe-mcp')
  assert.deepEqual(stripe.componentLabels, ['MCP server', 'Skill pack'])
  assert.equal(stripe.facet, 'Payments')
  // Browsing a registry row never makes it installed, and never launchable:
  // install is the only route to a launch.
  assert.equal(stripe.installed, false)
  assert.equal(stripe.canLaunch, false)
}

// A module entry IS listed in the Plugins catalogue (D10); a cli-only entry has
// its own canvas and is dropped from this one.
{
  const entries = buildConnectorEntries([
    plugin({ id: 'theme-pack', provides: ['module'] }),
    plugin({ id: 'cli-only', provides: ['cli'] }),
  ])
  assert.deepEqual(entries.map((entry) => entry.id), ['theme-pack'])
}

// --- installed settings servers present as listings for the launch rail -----

{
  const entry = installedServerAsListing(config({ transport: 'stdio', command: 'custom-mcp' }))
  assert.equal(entry.id, 'my-custom')
  assert.equal(entry.name, 'My custom MCP')
  assert.equal(entry.transport, 'stdio')
  // Settings-owned fields are dropped from the listing shape.
  assert.ok(!('enabled' in entry))
  assert.ok(!('scope' in entry))
  assert.ok(!('source' in entry))
}

// --- the one launchable rule + the launch population ------------------------

assert.equal(connectorCanLaunch(true), true)
assert.equal(connectorCanLaunch(false), false)

{
  const installed: Record<string, McpServerConfig> = {
    github: config({ id: 'github', name: 'GitHub', category: 'Code Hosting' }),
    linear: config({ id: 'linear', name: 'Linear', enabled: false }),
    'my-custom': config(),
  }
  const ready = launchableConnectors(installed)
  // Every installed, enabled server — and a disabled one never surfaces.
  assert.deepEqual(ready.map((entry) => entry.id), ['github', 'my-custom'])
  assert.equal(ready.find((entry) => entry.id === 'github')!.category, 'Code Hosting')
  assert.equal(ready.find((entry) => entry.id === 'my-custom')!.name, 'My custom MCP')
  // Nothing installed → nothing to launch. There is no catalogue template left
  // to launch a server the person never installed.
  assert.deepEqual(launchableConnectors(undefined), [])
  assert.deepEqual(launchableConnectors({}), [])
}

// --- search ----------------------------------------------------------------

{
  const entries = buildConnectorEntries([plugin(), plugin({ id: 'railway-mcp', name: 'Railway', category: 'Deployments', summary: 'Deploys, services, logs' })])
  // Name match.
  assert.deepEqual(searchConnectors(entries, 'railway').map((e) => e.id), ['railway-mcp'])
  // Summary match.
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
  const entries = buildConnectorEntries([plugin({ tags: ['webhooks'], categories: ['Finance'] })])
  assert.equal(searchConnectors(entries, 'webhooks').length, 1)
  assert.equal(searchConnectors(entries, 'finance').length, 1)
}

// --- the category bucket a row renders under -------------------------------
// The facet TABS that filtered across every source went with the browse grid
// (source-tabs ruling, 2026-09-05): a category is a group inside a source's own
// tab now, so what an entry carries is the bucket, not a filter.
{
  const entries = buildConnectorEntries([
    plugin({ id: 'railway-mcp', name: 'Railway', category: 'Deployments' }),
    plugin({ id: 'supabase-mcp', name: 'Supabase', category: 'Database' }),
    plugin(),
  ])
  assert.deepEqual(
    entries.map((entry) => [entry.id, entry.facet]),
    [
      ['railway-mcp', 'Infrastructure'],
      ['supabase-mcp', 'Data'],
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
  const entries = buildConnectorEntries([
    plugin({ id: 'railway-mcp', name: 'Railway', category: 'Deployments' }),
    plugin({ id: 'weather-mcp', name: 'Weather', category: 'Weather' }),
    plugin(),
  ])
  const sections = sectionConnectors(entries)
  assert.deepEqual(
    sections.map((section) => section.title),
    ['Infrastructure', 'Payments', 'More'],
  )
  assert.deepEqual(sections[0].entries.map((entry) => entry.id), ['railway-mcp'])
  assert.deepEqual(sections[2].entries.map((entry) => entry.id), ['weather-mcp'])
}

// No entries → no sections (the tab's empty/no-match sentence owns that copy).
assert.deepEqual(sectionConnectors([]), [])

// "New chat" hands the host the connector itself, not a bare id: the composer's
// attachment chip needs the display name at open, with no second read. It
// carries no icon — the chip falls back to the brand mark keyed off the id.
{
  const [entry] = buildConnectorEntries([plugin({ id: 'railway-mcp', name: 'Railway' })])
  assert.deepEqual(connectorEntryAsComposerConnector(entry), { id: 'railway-mcp', name: 'Railway' })
}


// --- registry entries by kind (MC-1847 C2) ---------------------------------
// The Plugins catalogue lists mcp, skills and module entries (D10); cli entries
// keep their own canvas. Same normalized row shape from one builder.
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
  // The catalogue path is the same builder with mcp/skills/module: a
  // module-only plugin is listed, a cli-only one is not.
  assert.deepEqual(
    buildConnectorEntries(all).map((entry) => entry.id),
    ['stripe-mcp', 'roadmap-module', 'full-stack'],
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
  // Listed, never launchable: install still gates launch.
  const calendarRows = buildConnectorEntries([calendar])
  assert.deepEqual(calendarRows.map((row) => row.id), ['multicode-calendar'])
  assert.equal(calendarRows[0].canLaunch, false)
  assert.deepEqual(calendarRows[0].componentLabels, ['Module'])
  // A cli-only plugin still keeps to its own canvas.
  assert.deepEqual(buildConnectorEntries([plugin({ id: 'cursor-only', name: 'Cursor', provides: ['cli'] })]), [])
  // A mixed bundle (mcp + module) is listed once, and its row
  // never launches from the registry side — install still gates launch.
  const mixed = plugin({ id: 'suite', name: 'Suite', provides: ['mcp', 'module'] })
  const gridRows = buildConnectorEntries([mixed])
  assert.deepEqual(gridRows.map((row) => row.id), ['suite'])
  assert.equal(gridRows[0].canLaunch, false)
}

console.log('connectors-facets guard passed')
