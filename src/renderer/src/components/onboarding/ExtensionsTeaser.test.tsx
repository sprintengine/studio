import assert from 'node:assert/strict'

import type { MarketplaceRegistryReadResult } from '../../../../shared/electron-api'
import type { MarketplaceIndex, MarketplacePluginEntry } from '../../../../shared/marketplace/manifest'
import { deriveBrowseView, type BrowseView } from '../settings/storefrontView'
import { selectTeaserPlugins } from './ExtensionsTeaser'

// The teaser must preview REAL registry entries only (never sample/placeholder),
// take just the leading few, and show nothing whenever the registry is not in a
// ready state (loading / offline / error / empty).

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

function readyView(plugins: MarketplacePluginEntry[]): BrowseView {
  return deriveBrowseView({ status: 'result', result: okResult(plugins) }, '')
}

const five = ['a', 'b', 'c', 'd', 'e'].map((id) => plugin({ id, name: `Plugin ${id}` }))

run('previews only the leading entries (default 3) from a large registry', () => {
  const picked = selectTeaserPlugins(readyView(five))
  assert.equal(picked.length, 3)
  assert.deepEqual(picked.map((p) => p.id), ['a', 'b', 'c'])
})

run('every previewed entry is a real registry entry (no fabrication)', () => {
  const registryIds = new Set(five.map((p) => p.id))
  for (const picked of selectTeaserPlugins(readyView(five))) {
    assert.ok(registryIds.has(picked.id), `unexpected entry ${picked.id}`)
  }
})

run('returns all real entries when the registry has fewer than the limit', () => {
  const two = ['x', 'y'].map((id) => plugin({ id, name: `Plugin ${id}` }))
  const picked = selectTeaserPlugins(readyView(two))
  assert.deepEqual(picked.map((p) => p.id), ['x', 'y'])
})

run('honors a custom limit', () => {
  assert.equal(selectTeaserPlugins(readyView(five), 2).length, 2)
})

run('previews nothing while loading / offline / error / empty — never sample data', () => {
  assert.deepEqual(selectTeaserPlugins({ status: 'loading' }), [])
  assert.deepEqual(selectTeaserPlugins({ status: 'offline', message: 'x' }), [])
  assert.deepEqual(selectTeaserPlugins({ status: 'error', message: 'x' }), [])
  assert.deepEqual(selectTeaserPlugins({ status: 'empty' }), [])
  assert.deepEqual(selectTeaserPlugins(readyView([])), [])
})

if (failures > 0) {
  console.error(`ExtensionsTeaser.test.tsx: ${failures} failing`)
  process.exit(1)
}
console.log('ExtensionsTeaser.test.tsx: ok')
