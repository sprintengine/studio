import assert from 'node:assert/strict'

import type { McpCatalogServer } from '../../types/workspace'
import { filterMcpCatalog } from './mcpCatalogFilter'

// The catalog search must match what a user scans for (name / category /
// description), case-insensitively, and must never hide servers until the user
// actually types — an empty query is the full list, not an empty grid.

function server(overrides: Partial<McpCatalogServer> = {}): McpCatalogServer {
  return {
    id: 'context7',
    name: 'Context7',
    category: 'Docs',
    description: 'Up-to-date library documentation',
    transport: 'stdio',
    clients: ['claude-code'],
    riskLevel: 'low',
    ...overrides,
  } as McpCatalogServer
}

const catalog = [
  server({ id: 'context7', name: 'Context7', category: 'Docs', description: 'Up-to-date library documentation' }),
  server({ id: 'brave', name: 'Brave Search', category: 'Search', description: 'Web search via Brave' }),
  server({ id: 'gh', name: 'GitHub', category: 'Dev tools', description: 'Repos, issues, and pull requests' }),
]

// Empty / whitespace query returns the full list unchanged (same reference order).
assert.deepEqual(filterMcpCatalog(catalog, '').map((s) => s.id), ['context7', 'brave', 'gh'])
assert.deepEqual(filterMcpCatalog(catalog, '   ').map((s) => s.id), ['context7', 'brave', 'gh'])

// Name match, case-insensitive.
assert.deepEqual(filterMcpCatalog(catalog, 'brave').map((s) => s.id), ['brave'])
assert.deepEqual(filterMcpCatalog(catalog, 'GITHUB').map((s) => s.id), ['gh'])

// Category match.
assert.deepEqual(filterMcpCatalog(catalog, 'search').map((s) => s.id), ['brave'])
assert.deepEqual(filterMcpCatalog(catalog, 'docs').map((s) => s.id), ['context7'])

// Description match (and a term that spans multiple descriptions).
assert.deepEqual(filterMcpCatalog(catalog, 'pull requests').map((s) => s.id), ['gh'])
assert.deepEqual(filterMcpCatalog(catalog, 'search').length, 1)

// No match → empty array (caller renders the "no matches" message).
assert.deepEqual(filterMcpCatalog(catalog, 'nonexistent-zzz'), [])

// Missing optional fields must not throw.
const sparse = [server({ id: 'bare', name: 'Bare', category: undefined, description: undefined })]
assert.deepEqual(filterMcpCatalog(sparse, 'bare').map((s) => s.id), ['bare'])
assert.deepEqual(filterMcpCatalog(sparse, 'docs'), [])

// Leading/trailing whitespace in the query is trimmed before matching.
assert.deepEqual(filterMcpCatalog(catalog, '  brave  ').map((s) => s.id), ['brave'])

console.log('mcpCatalogFilter.test.ts passed')
