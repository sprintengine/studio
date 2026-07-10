// Contract tests for the generated bundled MCP catalog
// (resources/mcps/catalog.json, produced by scripts/generate-connector-catalogue.mjs
// from @hotstack/catalogue-snapshot) and for normalizeCatalogServer, which
// every entry must survive to reach the Connectors surface.
//
// findCatalogPath/listCatalog need electron and stay covered by runtime use;
// this suite pins the data contract those functions serve.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeCatalogServer } from './mcp-config-service'

const catalogPath = join(process.cwd(), 'resources', 'mcps', 'catalog.json')
const overlayPath = join(process.cwd(), 'resources', 'mcps', 'catalog-overlay.json')

// User settings and installedServerIds reference these ids; a regeneration
// that drops or renames one silently detaches existing installs.
const LEGACY_SERVER_IDS = [
  'playwright',
  'github',
  'context7',
  'openai-docs',
  'vercel',
  'railway',
  'supabase',
  'sentry',
  'grafana',
  'linear',
  'atlassian',
  'figma',
  'notion',
  'stripe',
  'brave-search',
]

function main(): void {
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as { servers: Array<Record<string, unknown>> }
  assert.ok(Array.isArray(catalog.servers) && catalog.servers.length >= LEGACY_SERVER_IDS.length)

  testEveryServerNormalizes(catalog.servers)
  testLegacyAliasesStayStable(catalog.servers)
  testRailwayKeepsItsLaunchSkill(catalog.servers)
  testIconsAndSkillsForwardThroughNormalization(catalog.servers)
  testOverlayRecordsAllLand(catalog.servers)

  console.log('mcp catalog contract tests passed')
}

function testEveryServerNormalizes(servers: Array<Record<string, unknown>>): void {
  const ids = new Set<string>()
  for (const raw of servers) {
    const server = normalizeCatalogServer(raw)
    assert.ok(server, `catalog server ${String(raw.id)} must normalize`)
    assert.ok(server.id.length > 0)
    assert.ok(!ids.has(server.id), `duplicate catalog server id ${server.id}`)
    ids.add(server.id)
    assert.ok(server.name.length > 0)
    assert.ok(['stdio', 'http', 'sse'].includes(server.transport))
    if (server.transport === 'stdio') assert.ok(server.command && server.command.length > 0)
    else assert.ok(server.url && server.url.length > 0)
    assert.ok((server.clients ?? []).length > 0)
  }
}

function testLegacyAliasesStayStable(servers: Array<Record<string, unknown>>): void {
  const ids = new Set(servers.map((server) => server.id))
  for (const legacy of LEGACY_SERVER_IDS) {
    assert.ok(ids.has(legacy), `legacy catalog id "${legacy}" missing from generated catalog`)
  }
}

function testRailwayKeepsItsLaunchSkill(servers: Array<Record<string, unknown>>): void {
  const railway = servers.find((server) => server.id === 'railway')
  assert.ok(railway)
  const normalized = normalizeCatalogServer(railway)
  assert.ok(normalized)
  assert.equal(normalized.skill, 'use-railway')
  assert.equal(normalized.transport, 'http')
  assert.equal(normalized.url, 'https://mcp.railway.com')
}

function testIconsAndSkillsForwardThroughNormalization(servers: Array<Record<string, unknown>>): void {
  const withIcon = servers.find((server) => typeof server.icon === 'string')
  assert.ok(withIcon, 'generated catalog must carry data-URI icons')
  const normalized = normalizeCatalogServer(withIcon)
  assert.ok(normalized)
  assert.equal(normalized.icon, withIcon.icon)
  assert.match(String(normalized.icon), /^data:image\/svg\+xml;base64,|^https:\/\//)
  // Catalog entries present as browsable, not pre-enabled installs. The
  // McpCatalogServer type omits enabled/source, but the normalizer stamps
  // them on the runtime value consumed by mcpSync.
  const runtime = normalized as unknown as Record<string, unknown>
  assert.equal(runtime.enabled, false)
  assert.equal(runtime.source, 'bundled')
}

function testOverlayRecordsAllLand(servers: Array<Record<string, unknown>>): void {
  const overlay = JSON.parse(readFileSync(overlayPath, 'utf8')) as {
    schemaVersion: number
    entries: Record<string, { id?: string }>
  }
  assert.equal(overlay.schemaVersion, 1)
  const ids = new Set(servers.map((server) => server.id))
  for (const [hotstackId, record] of Object.entries(overlay.entries)) {
    assert.ok(record.id, `overlay entry ${hotstackId} must pin a legacy id alias`)
    assert.ok(ids.has(record.id), `overlay alias "${record.id}" (${hotstackId}) missing from generated catalog`)
  }
}

main()
