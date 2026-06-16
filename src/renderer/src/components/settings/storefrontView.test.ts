import assert from 'node:assert/strict'

import type { MarketplaceRegistryReadResult } from '../../../../shared/electron-api'
import type { MarketplaceIndex, MarketplacePluginEntry } from '../../../../shared/marketplace/manifest'
import {
  deriveBrowseView,
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
    source: 'https://github.com/multicode-labs/marketplace/tree/main/plugins/browser-automation-mcp',
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

function failResult(state: 'fetch-error' | 'invalid-schema', message: string): MarketplaceRegistryReadResult {
  return { ok: false, state, registryUrl: 'https://example.com/marketplace.json', stale: false, message }
}

const result = (r: MarketplaceRegistryReadResult): BrowseLoad => ({ status: 'result', result: r })

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

console.log('storefrontView.test.ts passed')
