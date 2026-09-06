// Contract tests for the bundled MCP catalogue (resources/mcps/catalog.json)
// and for normalizeCatalogServer, which every entry must survive to reach the
// Connectors surface.
//
// What this file pins changed with the frozen-snapshots retirement
// (2026-09-06). The catalogue used to be generated from
// @hotstack/catalogue-snapshot and held 58 servers, and the tests here guarded
// the generator's output: legacy id aliases, the overlay that supplied our own
// launch metadata, Railway's driving skill. Generator, snapshot dependency and
// overlay are all gone, and so is every catalogue row for a server a person can
// reach as a plugin. What is left to guard is the rule that replaced them:
//
//   the catalogue holds a server ONLY while no plugin carries it,
//
// because the epic's whole point is that nobody is offered two routes to the
// same server. The 39 rows `anthropics/claude-plugins-official` already carries
// and the 3 that became our own plugins are named below, so reinstating one is
// a test failure rather than a quiet duplicate row.
//
// findCatalogPath/listCatalog need electron and stay covered by runtime use;
// this suite pins the data contract those functions serve.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeCatalogServer } from './mcp-config-service'

const catalogPath = join(process.cwd(), 'resources', 'mcps', 'catalog.json')

/**
 * The 16 servers with no plugin anywhere, which is the whole of the catalogue.
 * Each one waits on a driving skill written to the rules in
 * backlog/2026-09-06-shipped-mcp-servers-are-plugins.md; as each is written the
 * server becomes a plugin and its row leaves this list, not the other way
 * about.
 */
const CATALOG_IDS = [
  'ai-perplexity-mcp-server',
  'com-apify-apify-mcp-server',
  'com-googleapis-run-mcp',
  'com-microsoft-powerbi-modeling-mcp',
  'io-github-cyanheads-obsidian-mcp-server',
  'io-github-delorenj-mcp-server-trello',
  'io-github-domdomegg-gmail-mcp',
  'io-github-domdomegg-google-cal-mcp',
  'io-github-domdomegg-google-drive-mcp',
  'io-github-domdomegg-google-sheets-mcp',
  'io-github-googlecloudplatform-gemini-cloud-assist-mcp',
  'io-github-neo4j-contrib-mcp-neo4j-aura-manager',
  'io-github-taazkareem-clickup',
  'io-github-vercel-next-devtools-mcp',
  'net-todoist-mcp',
  'openai-docs',
]

/**
 * Servers a person can install as a plugin instead, and therefore must not find
 * here as well: the 39 measured against the official marketplace's manifest at
 * its head on 2026-09-06, and the 3 we published as plugins ourselves.
 */
const CARRIED_BY_A_PLUGIN = [
  'ai-exa-exa',
  'atlassian',
  'brave-search',
  'chrome-devtools',
  'co-huggingface-hf-mcp-server',
  'com-airtable-mcp',
  'com-auth0-mcp',
  'com-cloudflare-mcp-mcp',
  'com-gitlab-mcp',
  'com-microsoft-azure',
  'com-monday-monday-com',
  'com-newrelic-mcp-server',
  'com-paypal-mcp-mcp',
  'context7',
  'figma',
  'github',
  'grafana',
  'io-github-aws-aws-mcp',
  'io-github-containers-kubernetes-mcp-server',
  'io-github-firebase-firebase-mcp',
  'io-github-firecrawl-firecrawl-mcp-server',
  'io-github-hashicorp-terraform-mcp-server',
  'io-github-jfrog-jfrog-mcp-server',
  'io-github-mapbox-mcp-server',
  'io-github-mongodb-js-mongodb-mcp-server',
  'io-github-pagerduty-pagerduty-mcp',
  'io-github-planetscale-mcp-server',
  'io-github-posthog-mcp',
  'io-github-redis-mcp-redis',
  'io-github-snowflake-labs-mcp',
  'io-github-sonarsource-sonarqube-mcp-server',
  'io-github-tavily-ai-tavily-mcp',
  'io-github-zoom-zoom-docs',
  'io-snyk-mcp',
  'linear',
  'notion',
  'playwright',
  'railway',
  'sentry',
  'stripe',
  'supabase',
  'vercel',
]

function main(): void {
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as { servers: Array<Record<string, unknown>> }
  assert.ok(Array.isArray(catalog.servers))

  testEveryServerNormalizes(catalog.servers)
  testCatalogueIsExactlyTheServersWithNoPlugin(catalog.servers)
  testIconsAndSkillsForwardThroughNormalization(catalog.servers)

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

function testCatalogueIsExactlyTheServersWithNoPlugin(servers: Array<Record<string, unknown>>): void {
  const ids = new Set(servers.map((server) => String(server.id)))
  assert.deepEqual(
    [...ids].sort(),
    [...CATALOG_IDS].sort(),
    'the catalogue is exactly the servers no plugin carries; a row added here needs a plugin instead',
  )
  for (const carried of CARRIED_BY_A_PLUGIN) {
    assert.equal(
      ids.has(carried),
      false,
      `"${carried}" is installable as a plugin, so a catalogue row for it would be a second route to the same server`,
    )
  }
}

function testIconsAndSkillsForwardThroughNormalization(servers: Array<Record<string, unknown>>): void {
  const withIcon = servers.find((server) => typeof server.icon === 'string')
  assert.ok(withIcon, 'the catalogue must carry data-URI icons')
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

main()
