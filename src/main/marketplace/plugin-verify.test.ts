import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { MarketplacePluginEntry, MarketplacePluginManifest } from '../../shared/marketplace'
import { validateMarketplacePluginAuthoringManifest } from '../../shared/marketplace'
import type { CapabilityPermission } from '../../shared/modules/permissions'
import {
  generateModuleSigningKeyPair,
  signManifest,
} from '../../../packages/module-sdk/src/signing'
import { createMarketplacePluginVerifier } from './plugin-verify'
import type { MarketplacePluginDownloadFetch } from './plugin-download'

const SOURCE_URL = 'https://example.test/plugins/preview-plugin/'
const PLUGIN_JSON_URL = 'https://example.test/plugins/preview-plugin/plugin.json'
const MCP_JSON_URL = 'https://example.test/plugins/preview-plugin/mcp/server.json'

type Fixture = {
  entry: MarketplacePluginEntry
  manifest: MarketplacePluginManifest
  fingerprint: string
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'mc-marketplace-verify-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function createFixture(options: {
  permissions?: CapabilityPermission[]
  omitPermissions?: boolean
  publisherVerified?: boolean
} = {}): Fixture {
  const keyPair = generateModuleSigningKeyPair()
  const unsigned = {
    id: 'preview-plugin',
    displayName: 'Preview Plugin',
    version: 1,
    publisher: 'Multicode Labs',
    category: 'Testing',
    summary: 'Preview marketplace plugin.',
    defaultEnabled: false,
    ...(options.omitPermissions ? {} : { permissions: options.permissions ?? ['network'] }),
    components: {
      mcp: { path: 'mcp/server.json' },
    },
  }
  const validated = validateMarketplacePluginAuthoringManifest(unsigned)
  assert.equal(validated.ok, true)
  if (!validated.ok) throw new Error('test plugin manifest did not validate')
  const signature = signManifest(validated.manifest, keyPair.privateKeyPem)
  const manifest: MarketplacePluginManifest = { ...validated.manifest, signature }
  return {
    manifest,
    fingerprint: keyPair.fingerprint,
    entry: {
      id: manifest.id,
      name: manifest.displayName,
      publisher: { name: 'Multicode Labs', verified: options.publisherVerified ?? true },
      summary: manifest.summary ?? '',
      category: manifest.category ?? '',
      icon: 'icons/preview.svg',
      latest: manifest.version,
      source: SOURCE_URL,
      provides: ['mcp'],
      signature,
    },
  }
}

function createFetcher(pluginJson: string): MarketplacePluginDownloadFetch {
  return async (url) => {
    if (url === PLUGIN_JSON_URL) return new Response(pluginJson)
    if (url === MCP_JSON_URL) {
      return new Response(`${JSON.stringify({
        servers: [
          {
            id: 'preview-mcp',
            name: 'Preview MCP',
            transport: 'stdio',
            command: 'node',
            args: ['-e', 'console.log("preview mcp")'],
            clients: ['codex'],
            scope: 'workspace',
            source: 'custom',
            riskLevel: 'local-command',
          },
        ],
      })}\n`)
    }
    return new Response('not found', { status: 404 })
  }
}

async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
}

function assertNoInstallSideEffects(temp: string, stagingRoot: string): void {
  assert.equal(existsSync(join(temp, 'workspace', '.codex', 'config.toml')), false)
  assert.equal(existsSync(join(temp, 'workspace', '.agents', 'skills')), false)
  assert.equal(existsSync(join(temp, 'modules')), false)
  assert.equal(existsSync(join(temp, 'plugins')), false)
  assert.equal(existsSync(stagingRoot), true)
}

async function testVerifiedPreviewSurfacesPermissionsAndRemovesStage(): Promise<void> {
  await withTempDir(async (temp) => {
    const stagingRoot = join(temp, 'staging')
    const fixture = createFixture({ permissions: ['network', 'process:spawn'] })
    const verifier = createMarketplacePluginVerifier({
      trustContext: () => ({
        trustedModules: new Map(),
        trustedKeyFingerprints: new Set([fixture.fingerprint]),
      }),
      stagingRoot,
      fetcher: createFetcher(`${JSON.stringify(fixture.manifest, null, 2)}\n`),
    })

    const result = await verifier.verify(fixture.entry)

    assert.equal(result.classification, 'verified')
    assert.deepEqual(result.permissions, ['network', 'process:spawn'])
    assert.equal(result.sourceUrl, SOURCE_URL)
    assert.equal(result.issues, undefined)
    assert.deepEqual(await listDir(stagingRoot), [])
    assertNoInstallSideEffects(temp, stagingRoot)
  })
}

async function testCommunityPreviewSurfacesPermissionsForTrustPrompt(): Promise<void> {
  await withTempDir(async (temp) => {
    const stagingRoot = join(temp, 'staging')
    const fixture = createFixture({ permissions: ['filesystem:read-workspace'], publisherVerified: false })
    const verifier = createMarketplacePluginVerifier({
      trustContext: () => ({ trustedModules: new Map() }),
      stagingRoot,
      fetcher: createFetcher(`${JSON.stringify(fixture.manifest, null, 2)}\n`),
    })

    const result = await verifier.verify(fixture.entry)

    assert.equal(result.classification, 'community')
    assert.deepEqual(result.permissions, ['filesystem:read-workspace'])
    assert.equal(result.sourceUrl, SOURCE_URL)
    assert.deepEqual(await listDir(stagingRoot), [])
    assertNoInstallSideEffects(temp, stagingRoot)
  })
}

async function testVerifiedPreviewDoesNotFabricateMissingPermissions(): Promise<void> {
  await withTempDir(async (temp) => {
    const stagingRoot = join(temp, 'staging')
    const fixture = createFixture({ omitPermissions: true })
    const verifier = createMarketplacePluginVerifier({
      trustContext: () => ({
        trustedModules: new Map(),
        trustedKeyFingerprints: new Set([fixture.fingerprint]),
      }),
      stagingRoot,
      fetcher: createFetcher(`${JSON.stringify(fixture.manifest, null, 2)}\n`),
    })

    const result = await verifier.verify(fixture.entry)

    assert.equal(result.classification, 'verified')
    assert.deepEqual(result.permissions, [])
    assert.deepEqual(await listDir(stagingRoot), [])
    assertNoInstallSideEffects(temp, stagingRoot)
  })
}

async function testUnsignedPreviewBlocksWithoutPermissions(): Promise<void> {
  await withTempDir(async (temp) => {
    const stagingRoot = join(temp, 'staging')
    const fixture = createFixture({ permissions: ['ipc:settings'] })
    const { signature: _signature, ...unsigned } = fixture.manifest
    const verifier = createMarketplacePluginVerifier({
      trustContext: () => ({ trustedModules: new Map() }),
      stagingRoot,
      fetcher: createFetcher(`${JSON.stringify(unsigned, null, 2)}\n`),
    })

    const result = await verifier.verify(fixture.entry)

    assert.equal(result.classification, 'unsigned')
    assert.deepEqual(result.permissions, [])
    assert.match(result.message ?? '', /unsigned/i)
    assert.ok(result.issues?.some((issue) => /signature/i.test(issue.path) || /signature/i.test(issue.message)))
    assert.deepEqual(await listDir(stagingRoot), [])
    assertNoInstallSideEffects(temp, stagingRoot)
  })
}

async function testInvalidPreviewBlocksWithoutPermissions(): Promise<void> {
  await withTempDir(async (temp) => {
    const stagingRoot = join(temp, 'staging')
    const fixture = createFixture({ permissions: ['filesystem:write-workspace'] })
    const tampered = { ...fixture.manifest, displayName: 'Tampered Plugin' }
    const verifier = createMarketplacePluginVerifier({
      trustContext: () => ({ trustedModules: new Map() }),
      stagingRoot,
      fetcher: createFetcher(`${JSON.stringify(tampered, null, 2)}\n`),
    })

    const result = await verifier.verify(fixture.entry)

    assert.equal(result.classification, 'invalid')
    assert.deepEqual(result.permissions, [])
    assert.match(result.message ?? '', /signature is invalid/i)
    assert.ok(result.issues?.some((issue) => /signature/i.test(issue.path) || /signature/i.test(issue.message)))
    assert.deepEqual(await listDir(stagingRoot), [])
    assertNoInstallSideEffects(temp, stagingRoot)
  })
}

async function main(): Promise<void> {
  await testVerifiedPreviewSurfacesPermissionsAndRemovesStage()
  await testCommunityPreviewSurfacesPermissionsForTrustPrompt()
  await testVerifiedPreviewDoesNotFabricateMissingPermissions()
  await testUnsignedPreviewBlocksWithoutPermissions()
  await testInvalidPreviewBlocksWithoutPermissions()
  console.log('marketplace plugin verify tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
