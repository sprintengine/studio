import assert from 'node:assert/strict'

import type { MarketplaceRegistryReadResult } from '../../../../shared/electron-api'
import type { MarketplaceIndex, MarketplacePluginEntry } from '../../../../shared/marketplace/manifest'
import {
  componentKindLabels,
  deriveBrowseView,
  externalSourceHref,
  filterPlugins,
  groupPluginsByCategory,
  type BrowseLoad,
} from './storefrontView'

// The storefront must render real registry data and never a silent empty grid:
// every non-ok registry state (offline / fetch-error / invalid-schema / thrown /
// unsupported) maps to an explicit view, and "empty" means the registry truly
// lists nothing — distinct from a search that matched nothing.

function plugin(overrides: Partial<MarketplacePluginEntry> = {}): MarketplacePluginEntry {
  return {
    id: 'browser-automation-mcp',
    name: 'Browser Automation MCP',
    publisher: { name: 'Multicode Labs', verified: true },
    summary: 'Playwright MCP server for browser inspection and UI automation.',
    category: 'Testing',
    icon: 'icons/browser-automation.svg',
    latest: 1,
    source: 'https://github.com/hotstacklabs/sprintengine-marketplace/tree/main/plugins/browser-automation-mcp',
    provides: ['mcp'],
    signature: { algorithm: 'ed25519', publicKey: 'k', signature: 's' },
    ...overrides,
  }
}

function index(plugins: MarketplacePluginEntry[]): MarketplaceIndex {
  return { schemaVersion: 1, plugins }
}

function okResult(plugins: MarketplacePluginEntry[]): MarketplaceRegistryReadResult {
  return {
    ok: true,
    state: plugins.length === 0 ? 'empty' : 'ok',
    registryUrl: 'https://example.com/marketplace.json',
    source: 'network',
    stale: false,
    fetchedAt: '2026-06-16T00:00:00Z',
    marketplace: index(plugins),
  }
}

function offlineResult(plugins: MarketplacePluginEntry[]): MarketplaceRegistryReadResult {
  return {
    ok: true,
    state: 'offline',
    registryUrl: 'https://example.com/marketplace.json',
    source: 'cache',
    stale: true,
    fetchedAt: '2026-06-15T00:00:00Z',
    marketplace: index(plugins),
    message: 'Offline — showing the last fetched catalog.',
  }
}

// The default hosted registry URL 404s in shipped builds, so the main process
// falls back to the packaged seed: ok + state 'offline' but source 'seed' and
// stale:false. The view-model must still render the cards (so the default
// Browse → card → Install path reaches an install affordance) while disclosing
// that the data is the bundled fallback, not the live registry.
function seedResult(plugins: MarketplacePluginEntry[]): MarketplaceRegistryReadResult {
  return {
    ok: true,
    state: 'offline',
    registryUrl: 'https://example.com/marketplace.json',
    source: 'seed',
    stale: false,
    fetchedAt: '2026-06-16T00:00:00Z',
    marketplace: index(plugins),
    message: 'Marketplace registry fetch failed with HTTP 404. Showing packaged marketplace registry seed.',
  }
}

function failResult(
  state: 'fetch-error' | 'invalid-schema' | 'offline',
  message: string,
): MarketplaceRegistryReadResult {
  return { ok: false, state, registryUrl: 'https://example.com/marketplace.json', stale: false, message }
}

// The trailing semicolon is load-bearing: an arrow with a parenthesized-object
// body (`=> ({...})`) and no semicolon, followed by the bare `{ ... }` test
// block below, makes `tsc` parse the object as arrow params (TS1003 cascade).
// esbuild tolerates it; `tsc -b` (typecheck:tests) does not.
const result = (r: MarketplaceRegistryReadResult): BrowseLoad => ({ status: 'result', result: r });

// --- filter + group --------------------------------------------------------

{
  const plugins = [
    plugin({ id: 'a', name: 'Browser Automation', category: 'Testing', summary: 'playwright' }),
    plugin({ id: 'b', name: 'Repo Workflows', category: 'Code Hosting', summary: 'github', publisher: { name: 'Acme', verified: false } }),
  ]
  assert.deepEqual(filterPlugins(plugins, '').map((p) => p.id), ['a', 'b'])
  assert.deepEqual(filterPlugins(plugins, 'browser').map((p) => p.id), ['a'])
  assert.deepEqual(filterPlugins(plugins, 'code hosting').map((p) => p.id), ['b'], 'matches category')
  assert.deepEqual(filterPlugins(plugins, 'github').map((p) => p.id), ['b'], 'matches summary')
  assert.deepEqual(filterPlugins(plugins, 'ACME').map((p) => p.id), ['b'], 'matches publisher, case-insensitive')
  assert.deepEqual(filterPlugins(plugins, 'zzz'), [])

  const groups = groupPluginsByCategory(plugins)
  assert.deepEqual(groups.map((g) => g.category), ['Code Hosting', 'Testing'], 'sorted by category')
}

{
  // Widened schema: search also matches any `categories[]` facet beyond the primary
  // display category, and any `tags[]` label — case-insensitively.
  const plugins = [
    plugin({ id: 'a', name: 'Test Runner', category: 'Testing', categories: ['Testing', 'Automation'], tags: ['playwright', 'e2e'], summary: 'browser testing helper' }),
    plugin({ id: 'b', name: 'Repo Workflows', category: 'Code Hosting', tags: ['git'], summary: 'repository workflows' }),
  ]
  assert.deepEqual(filterPlugins(plugins, 'automation').map((p) => p.id), ['a'], 'matches a secondary category')
  assert.deepEqual(filterPlugins(plugins, 'E2E').map((p) => p.id), ['a'], 'matches a tag, case-insensitive')
  assert.deepEqual(filterPlugins(plugins, 'git').map((p) => p.id), ['b'], 'matches a tag')
}

{
  // Inline-MCP entries (no bundle source, provides ['mcp']) are ordinary registry
  // entries: they filter, group, and render like any other card.
  const inline = plugin({
    id: 'inline-weather',
    name: 'Weather MCP',
    category: 'Data',
    provides: ['mcp'],
    source: undefined,
    signature: undefined,
    mcp: { servers: [{ id: 'weather', name: 'Weather', transport: 'stdio', command: 'npx', args: ['weather-mcp'], enabled: true, clients: ['claude-code'], scope: 'workspace', source: 'custom', riskLevel: 'low' }] },
  })
  const view = deriveBrowseView(result(okResult([inline])), '')
  assert.equal(view.status, 'ready')
  if (view.status !== 'ready') throw new Error('unreachable')
  assert.equal(view.total, 1)
  assert.deepEqual(view.groups.flatMap((g) => g.plugins.map((p) => p.id)), ['inline-weather'])
  assert.deepEqual(filterPlugins([inline], 'weather').map((p) => p.id), ['inline-weather'])
}

// --- lifecycle states ------------------------------------------------------

assert.equal(deriveBrowseView({ status: 'loading' }, '').status, 'loading')
assert.equal(deriveBrowseView({ status: 'unsupported' }, '').status, 'unsupported')

{
  const view = deriveBrowseView({ status: 'threw', message: 'boom' }, '')
  assert.equal(view.status, 'error')
  if (view.status !== 'error') throw new Error('unreachable')
  assert.equal(view.message, 'boom')
}

{
  const view = deriveBrowseView(result(failResult('fetch-error', 'network down')), '')
  assert.equal(view.status, 'error')
}

{
  const view = deriveBrowseView(result(failResult('invalid-schema', 'bad schema')), '')
  assert.equal(view.status, 'error')
}

{
  // Offline with NO cache (ok:false, state:'offline') is a DISTINCT offline
  // state — not collapsed into the generic error view.
  const view = deriveBrowseView(result(failResult('offline', 'Offline — no cached catalog.')), '')
  assert.equal(view.status, 'offline')
  if (view.status !== 'offline') throw new Error('unreachable')
  assert.equal(view.message, 'Offline — no cached catalog.')
}

{
  // Empty registry (loaded ok, zero plugins) — explicit empty, not error.
  const view = deriveBrowseView(result(okResult([])), '')
  assert.equal(view.status, 'empty')
}

{
  // Plugins exist but the query matched none → no-match, not empty.
  const view = deriveBrowseView(result(okResult([plugin()])), 'nonexistent')
  assert.equal(view.status, 'no-match')
  if (view.status !== 'no-match') throw new Error('unreachable')
  assert.equal(view.query, 'nonexistent')
}

{
  // Offline serves the cached index AND surfaces the stale notice.
  const view = deriveBrowseView(result(offlineResult([plugin()])), '')
  assert.equal(view.status, 'ready')
  if (view.status !== 'ready') throw new Error('unreachable')
  assert.ok(view.staleNotice && /Offline/.test(view.staleNotice))
  assert.equal(view.total, 1)
}

{
  // Default-path C6 scenario: hosted registry 404s, main process serves the
  // packaged seed. Cards still render (Browse → card → Install reachable) and
  // the seed-source notice is surfaced so the fallback is never silent.
  const view = deriveBrowseView(result(seedResult([plugin()])), '')
  assert.equal(view.status, 'ready')
  if (view.status !== 'ready') throw new Error('unreachable')
  assert.ok(view.staleNotice && /packaged marketplace registry seed/.test(view.staleNotice))
  assert.equal(view.total, 1)
}

// --- ready + featured ------------------------------------------------------

{
  // ≤ FEATURED_COUNT (3) plugins: no Featured rail (it would just repeat the list).
  const small = [plugin({ id: 'a' }), plugin({ id: 'b' }), plugin({ id: 'c' })]
  const view = deriveBrowseView(result(okResult(small)), '')
  assert.equal(view.status, 'ready')
  if (view.status !== 'ready') throw new Error('unreachable')
  assert.equal(view.featured.length, 0)
  assert.equal(view.total, 3)
}

{
  // > 3 plugins, no query → first 3 (curated order) lead the Featured rail.
  const many = ['a', 'b', 'c', 'd', 'e'].map((id) => plugin({ id, category: id === 'a' ? 'Testing' : 'Other' }))
  const view = deriveBrowseView(result(okResult(many)), '')
  assert.equal(view.status, 'ready')
  if (view.status !== 'ready') throw new Error('unreachable')
  assert.deepEqual(view.featured.map((p) => p.id), ['a', 'b', 'c'])
  assert.equal(view.total, 5)
}

{
  // Featured is suppressed while searching (no competing rail).
  const many = ['a', 'b', 'c', 'd'].map((id) => plugin({ id, name: `Plugin ${id}`, summary: 'shared-term' }))
  const view = deriveBrowseView(result(okResult(many)), 'shared-term')
  assert.equal(view.status, 'ready')
  if (view.status !== 'ready') throw new Error('unreachable')
  assert.equal(view.featured.length, 0)
  assert.equal(view.total, 4)
}

{
  // "View source" href guard: http(s) sources pass through unchanged so the
  // link still renders and opens.
  assert.equal(
    externalSourceHref('https://github.com/hotstacklabs/sprintengine-marketplace/tree/main/plugins/x'),
    'https://github.com/hotstacklabs/sprintengine-marketplace/tree/main/plugins/x',
  )
  assert.equal(externalSourceHref('http://example.com/x'), 'http://example.com/x')
}

{
  // Fail closed: non-http(s) schemes that would reach shell.openExternal render
  // no link. Covers file:// / smb:// / an OS protocol-handler scheme.
  assert.equal(externalSourceHref('file:///etc/passwd'), undefined)
  assert.equal(externalSourceHref('smb://host/share'), undefined)
  assert.equal(externalSourceHref('ms-msdt:/id'), undefined)
  // Missing/absent and unparseable sources also fail closed (inline-MCP entries
  // carry no source and must show no link).
  assert.equal(externalSourceHref(undefined), undefined)
  assert.equal(externalSourceHref('not a url'), undefined)
}

{
  // MC-1531: a module-carrying entry flows through Browse like any other
  // plugin. Its index name/summary ARE the module manifest's displayName +
  // summary (the shared authoring projection derives them), so the card leads
  // with what the module adds — never bundle mechanics — its kind label reads
  // "Module", and it groups under its own category.
  const calendar = plugin({
    id: 'multicode-calendar',
    name: 'Calendar',
    summary: 'Adds a calendar workspace type: time-block notes and schedule Backlog items.',
    category: 'Orchestration',
    provides: ['module'],
  })
  assert.deepEqual(componentKindLabels(calendar.provides), ['Module'])
  const view = deriveBrowseView(result(okResult([plugin(), calendar])), '')
  assert.equal(view.status, 'ready')
  if (view.status !== 'ready') throw new Error('unreachable')
  const group = view.groups.find((entry) => entry.category === 'Orchestration')
  assert.ok(group)
  assert.deepEqual(group!.plugins.map((entry) => entry.name), ['Calendar'])
  assert.equal(group!.plugins[0].summary, 'Adds a calendar workspace type: time-block notes and schedule Backlog items.')
}

console.log('storefrontView.test.ts passed')
