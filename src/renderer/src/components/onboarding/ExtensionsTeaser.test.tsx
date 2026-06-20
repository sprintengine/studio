import assert from 'node:assert/strict'

import type { MarketplaceRegistryReadResult } from '../../../../shared/electron-api'
import type { MarketplaceIndex, MarketplacePluginEntry } from '../../../../shared/marketplace/manifest'
import { deriveBrowseView, type BrowseView } from '../settings/storefrontView'
import { deriveTeaserView, selectTeaserPlugins } from './extensionsTeaserView'

// The teaser must preview REAL registry entries only (never sample/placeholder),
// take just the leading few, hide while not ready, and — critically — surface the
// offline cache/seed `staleNotice` so a fallback list is never shown as live or
// as a definitive empty registry. This exercises the pure view-model directly, so
// the test never bundles the store or the Settings/Browse component graph.

let failures = 0
function run(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

function plugin(overrides: Partial<MarketplacePluginEntry> = {}): MarketplacePluginEntry {
  return {
    id: 'browser-automation-mcp',
    name: 'Browser Automation MCP',
    publisher: { name: 'Multicode Labs', verified: true },
    summary: 'Playwright MCP server for browser inspection and UI automation.',
    category: 'Testing',
    icon: 'icons/browser-automation.svg',
    latest: 1,
    source: 'https://example.com/plugins/browser-automation-mcp',
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

// ok + state 'offline' (served from the last fetched cache) — carries staleNotice.
function offlineCacheResult(plugins: MarketplacePluginEntry[]): MarketplaceRegistryReadResult {
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

// ok + state 'offline' + source 'seed' — the packaged fallback shipped builds use
// when the hosted registry 404s. Also carries staleNotice.
function seedResult(plugins: MarketplacePluginEntry[]): MarketplaceRegistryReadResult {
  return {
    ok: true,
    state: 'offline',
    registryUrl: 'https://example.com/marketplace.json',
    source: 'seed',
    stale: false,
    fetchedAt: '2026-06-16T00:00:00Z',
    marketplace: index(plugins),
    message: 'Showing packaged marketplace registry seed.',
  }
}

function viewOf(result: MarketplaceRegistryReadResult): BrowseView {
  return deriveBrowseView({ status: 'result', result }, '')
}

const five = ['a', 'b', 'c', 'd', 'e'].map((id) => plugin({ id, name: `Plugin ${id}` }))

// --- selectTeaserPlugins: real-entries-only, leading N ---

run('previews only the leading entries (default 3) from a large registry', () => {
  const picked = selectTeaserPlugins(viewOf(okResult(five)))
  assert.deepEqual(picked.map((p) => p.id), ['a', 'b', 'c'])
})

run('every previewed entry is a real registry entry (no fabrication)', () => {
  const registryIds = new Set(five.map((p) => p.id))
  for (const picked of selectTeaserPlugins(viewOf(okResult(five)))) {
    assert.ok(registryIds.has(picked.id), `unexpected entry ${picked.id}`)
  }
})

run('returns all real entries when the registry has fewer than the limit', () => {
  const two = ['x', 'y'].map((id) => plugin({ id, name: `Plugin ${id}` }))
  assert.deepEqual(selectTeaserPlugins(viewOf(okResult(two))).map((p) => p.id), ['x', 'y'])
})

run('honors a custom limit', () => {
  assert.equal(selectTeaserPlugins(viewOf(okResult(five)), 2).length, 2)
})

// --- deriveTeaserView: state mapping + honest stale/fallback disclosure ---

run('maps not-ready browse states to no-preview teaser states', () => {
  assert.deepEqual(deriveTeaserView({ status: 'loading' }), { kind: 'loading' })
  assert.deepEqual(deriveTeaserView({ status: 'unsupported' }), { kind: 'hidden' })
  assert.deepEqual(deriveTeaserView({ status: 'offline', message: 'x' }), { kind: 'offline' })
  assert.deepEqual(deriveTeaserView({ status: 'error', message: 'x' }), { kind: 'error' })
})

run('live registry list carries no stale notice', () => {
  const view = deriveTeaserView(viewOf(okResult(five)))
  assert.equal(view.kind, 'list')
  assert.equal(view.kind === 'list' && view.staleNotice, null)
})

run('offline CACHE list surfaces the stale notice (never shown as live)', () => {
  const view = deriveTeaserView(viewOf(offlineCacheResult(five)))
  assert.equal(view.kind, 'list')
  assert.ok(view.kind === 'list' && view.staleNotice && /Offline/.test(view.staleNotice))
})

run('offline SEED list surfaces the fallback notice (shipped-build 404 path)', () => {
  const view = deriveTeaserView(viewOf(seedResult(five)))
  assert.equal(view.kind, 'list')
  assert.ok(view.kind === 'list' && view.staleNotice && /seed/.test(view.staleNotice))
})

run('offline-with-empty-cache empty state surfaces the stale notice, not "definitively empty"', () => {
  const view = deriveTeaserView(viewOf(offlineCacheResult([])))
  assert.equal(view.kind, 'empty')
  assert.ok(view.kind === 'empty' && view.staleNotice && /Offline/.test(view.staleNotice))
})

run('a truly empty live registry has no stale notice', () => {
  const view = deriveTeaserView(viewOf(okResult([])))
  assert.deepEqual(view, { kind: 'empty', staleNotice: null })
})

if (failures > 0) {
  console.error(`ExtensionsTeaser.test.tsx: ${failures} failing`)
  process.exit(1)
}
console.log('ExtensionsTeaser.test.tsx: ok')
