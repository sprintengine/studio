import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeMcpServerConfig } from '../../src/main/mcp-config-service'
import { classifyModuleTrust, verifyModuleSignature } from '../../src/main/modules/module-signature'
import {
  parseMarketplaceIndex,
  parseMarketplacePluginManifest,
  type MarketplaceComponentKind,
} from '../../src/shared/marketplace'

type TrustedPublishers = {
  schemaVersion: 1
  publishers: Array<{
    name: string
    verified: boolean
    publicKey: string
    fingerprint: string
  }>
}

type McpCatalog = {
  servers: Array<{
    id: string
    transport: string
    command?: string
    args?: string[]
    url?: string
    riskLevel?: string
  }>
}

const marketplaceRoot = join(process.cwd(), 'resources', 'marketplace')
const marketplacePath = join(marketplaceRoot, 'marketplace.json')
const trustedPublishersPath = join(marketplaceRoot, 'trusted-publishers.json')
const catalogPath = join(process.cwd(), 'resources', 'mcps', 'catalog.json')

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function componentKinds(components: Record<string, unknown>): MarketplaceComponentKind[] {
  return Object.keys(components).sort() as MarketplaceComponentKind[]
}

function assertNoKeyMaterial(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) {
      assertNoKeyMaterial(child)
      continue
    }
    assert.equal(entry.name.endsWith('.key') || entry.name.endsWith('.pem'), false, `${child} must not store private key material`)
  }
}

const trustedPublishers = readJson<TrustedPublishers>(trustedPublishersPath)
assert.equal(trustedPublishers.schemaVersion, 1)
const trustedFingerprints = new Set(trustedPublishers.publishers.map((publisher) => publisher.fingerprint))
assert.ok(trustedFingerprints.size > 0, 'at least one trusted publisher fingerprint is required')

const catalog = readJson<McpCatalog>(catalogPath)
const catalogById = new Map(catalog.servers.map((server) => [server.id, server]))

const marketplaceResult = parseMarketplaceIndex(readFileSync(marketplacePath, 'utf8'))
assert.equal(marketplaceResult.ok, true)
if (!marketplaceResult.ok) throw new Error('marketplace.json did not validate')

const { marketplace } = marketplaceResult
assert.equal(marketplace.schemaVersion, 1)
assert.ok(marketplace.plugins.length >= 3 && marketplace.plugins.length <= 4, 'marketplace must contain 3-4 seed plugins')
assert.equal(new Set(marketplace.plugins.map((plugin) => plugin.id)).size, marketplace.plugins.length, 'plugin ids must be unique')

for (const entry of marketplace.plugins) {
  assert.equal(entry.publisher.name, 'Multicode Labs', `${entry.id} publisher name`)
  assert.equal(entry.publisher.verified, true, `${entry.id} must be first-party verified`)
  assert.equal(entry.latest, 1, `${entry.id} seed version`)
  assert.deepEqual(entry.provides, ['mcp'], `${entry.id} should only advertise its MCP component`)
  assert.match(entry.source, /^https:\/\/github\.com\/multicode-labs\/marketplace\/tree\/main\/plugins\//)
  assert.equal(existsSync(join(marketplaceRoot, entry.icon)), true, `${entry.id} icon must exist`)

  const pluginRoot = join(marketplaceRoot, 'plugins', entry.id)
  const pluginManifestPath = join(pluginRoot, 'plugin.json')
  const manifestResult = parseMarketplacePluginManifest(readFileSync(pluginManifestPath, 'utf8'))
  assert.equal(manifestResult.ok, true, `${entry.id} plugin.json must validate`)
  if (!manifestResult.ok) throw new Error(`${entry.id} plugin.json did not validate`)

  const { manifest } = manifestResult
  assert.equal(manifest.id, entry.id)
  assert.equal(manifest.displayName, entry.name)
  assert.equal(manifest.version, entry.latest)
  assert.deepEqual(entry.signature, manifest.signature, `${entry.id} index signature must match plugin signature`)
  assert.deepEqual(componentKinds(manifest.components), entry.provides)

  const signature = verifyModuleSignature(manifest)
  assert.equal(signature.valid, true, `${entry.id} signature must verify`)
  assert.ok(signature.fingerprint, `${entry.id} signature fingerprint is required`)
  assert.equal(trustedFingerprints.has(signature.fingerprint), true, `${entry.id} signer must be a trusted first-party publisher`)
  assert.equal(
    classifyModuleTrust(manifest, {
      trustedModules: new Map(),
      trustedKeyFingerprints: trustedFingerprints,
    }).status,
    'trusted',
    `${entry.id} should classify as trusted when first-party publisher keys are accepted`
  )

  const componentPath = manifest.components.mcp?.path
  assert.ok(componentPath, `${entry.id} must carry an MCP component`)
  const mcpComponent = readJson<{ servers: unknown[] }>(join(pluginRoot, componentPath))
  assert.ok(Array.isArray(mcpComponent.servers), `${entry.id} MCP component must declare servers[]`)
  assert.equal(mcpComponent.servers.length, 1, `${entry.id} should wrap one bundled MCP server`)
  const server = normalizeMcpServerConfig(mcpComponent.servers[0], {
    enabled: true,
    clients: ['codex', 'claude-code'],
    scope: 'workspace',
    source: 'bundled',
  })
  assert.ok(server, `${entry.id} MCP server must normalize through the app MCP parser`)
  const catalogServer = catalogById.get(server.id)
  assert.ok(catalogServer, `${entry.id} wraps bundled MCP server ${server.id}`)
  assert.equal(server.transport, catalogServer.transport)
  assert.deepEqual(server.args, catalogServer.args ?? [])
  assert.equal(server.command, catalogServer.command)
  assert.equal(server.url, catalogServer.url)
  assert.equal(server.riskLevel, catalogServer.riskLevel)
}

assertNoKeyMaterial(marketplaceRoot)

console.log(`marketplace seed registry verified (${marketplace.plugins.length} plugins)`)
