import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildSync } from 'esbuild'

import { parseThirdPartyModuleManifest } from '../../shared/modules/third-party-manifest'
import type { MarketplaceComponentKind, MarketplacePluginEntry } from '../../shared/marketplace'
import { classifySignedManifestTrust, verifyModuleSignature } from '../modules/module-signature'
import {
  generateModuleSigningKeyPair,
  publicKeyFingerprint,
  signManifest,
} from '../../../packages/module-sdk/src/signing'
import {
  downloadMarketplacePluginBundle,
  type MarketplacePluginDownloadFetch,
} from './plugin-download'

const SOURCE_URL = 'https://github.com/multicode-labs/marketplace/tree/main/plugins/downloaded-plugin'
const API_ROOT = 'https://api.github.com/repos/multicode-labs/marketplace/contents/plugins/downloaded-plugin?ref=main'
const API_MCP = 'https://api.github.com/repos/multicode-labs/marketplace/contents/plugins/downloaded-plugin/mcp?ref=main'
const RAW_PLUGIN = 'https://raw.githubusercontent.com/multicode-labs/marketplace/main/plugins/downloaded-plugin/plugin.json'
const RAW_MCP = 'https://raw.githubusercontent.com/multicode-labs/marketplace/main/plugins/downloaded-plugin/mcp/server.json'

type BundleFixture = {
  entry: MarketplacePluginEntry
  manifest: Record<string, unknown>
  fingerprint: string
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'mc-marketplace-download-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(`${JSON.stringify(value)}\n`, {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  })
}

function textResponse(value: string, init: ResponseInit = {}): Response {
  return new Response(value, { status: 200, ...init })
}

function bytesResponse(value: Uint8Array, init: ResponseInit = {}): Response {
  const body = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
  return new Response(body, { status: 200, ...init })
}

function mcpComponentSource(): string {
  return `${JSON.stringify({
    servers: [
      {
        id: 'downloaded-mcp',
        name: 'Downloaded MCP',
        transport: 'stdio',
        command: 'node',
        args: ['-e', 'console.log("downloaded mcp")'],
        clients: ['codex'],
        scope: 'workspace',
        source: 'bundled',
        riskLevel: 'local-command',
      },
    ],
  }, null, 2)}\n`
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value)).digest('hex')
}

function createFixture(overrides: Record<string, unknown> = {}, mcpJson: string | Uint8Array = mcpComponentSource()): BundleFixture {
  const keyPair = generateModuleSigningKeyPair()
  const unsigned = {
    id: 'downloaded-plugin',
    displayName: 'Downloaded Plugin',
    version: 1,
    publisher: 'Multicode Labs',
    category: 'Testing',
    summary: 'Downloaded marketplace plugin.',
    defaultEnabled: false,
    source: 'third-party',
    permissions: ['network'],
    components: {
      mcp: { path: 'mcp/server.json', files: [{ path: 'mcp/server.json', sha256: sha256Hex(mcpJson) }] },
    },
    ...overrides,
  }
  const signature = signManifest(unsigned, keyPair.privateKeyPem)
  const manifest = { ...unsigned, signature }
  return {
    manifest,
    fingerprint: publicKeyFingerprint(signature.publicKey) ?? '',
    entry: {
      id: 'downloaded-plugin',
      name: 'Downloaded Plugin',
      publisher: { name: 'Multicode Labs', verified: true },
      summary: 'Downloaded marketplace plugin.',
      category: 'Testing',
      icon: 'icons/downloaded.svg',
      latest: 1,
      source: SOURCE_URL,
      provides: ['mcp'],
      signature,
    },
  }
}

function createUnsignedFixture(overrides: {
  provides?: MarketplaceComponentKind[]
  components?: Record<string, unknown>
} = {}): { entry: MarketplacePluginEntry; manifest: Record<string, unknown> } {
  const provides: MarketplaceComponentKind[] = overrides.provides ?? ['mcp']
  const components = overrides.components ?? {
    mcp: { path: 'mcp/server.json', files: [{ path: 'mcp/server.json', sha256: sha256Hex(mcpComponentSource()) }] },
  }
  return {
    manifest: {
      id: 'downloaded-plugin',
      displayName: 'Downloaded Plugin',
      version: 1,
      publisher: 'Multicode Labs',
      category: 'Testing',
      summary: 'Downloaded marketplace plugin.',
      defaultEnabled: false,
      source: 'third-party',
      permissions: ['network'],
      components,
    },
    entry: {
      id: 'downloaded-plugin',
      name: 'Downloaded Plugin',
      publisher: { name: 'Multicode Labs', verified: false },
      summary: 'Downloaded marketplace plugin.',
      category: 'Testing',
      icon: 'icons/downloaded.svg',
      latest: 1,
      source: SOURCE_URL,
      provides,
    },
  }
}

function createGithubFetcher(pluginJson: string, mcpJson: string | Uint8Array = mcpComponentSource()): {
  fetcher: MarketplacePluginDownloadFetch
  requests: string[]
} {
  const requests: string[] = []
  const fetcher: MarketplacePluginDownloadFetch = async (url) => {
    requests.push(url)
    if (url === API_ROOT) {
      return jsonResponse([
        { type: 'file', path: 'plugins/downloaded-plugin/plugin.json', download_url: RAW_PLUGIN },
        { type: 'dir', path: 'plugins/downloaded-plugin/mcp', url: API_MCP },
      ])
    }
    if (url === API_MCP) {
      return jsonResponse([
        { type: 'file', path: 'plugins/downloaded-plugin/mcp/server.json', download_url: RAW_MCP },
      ])
    }
    if (url === RAW_PLUGIN) return textResponse(pluginJson)
    if (url === RAW_MCP) return typeof mcpJson === 'string' ? textResponse(mcpJson) : bytesResponse(mcpJson)
    return new Response('not found', { status: 404 })
  }
  return { fetcher, requests }
}

async function testVerifiedFirstPartyDownloadStagesBundle(): Promise<void> {
  await withTempDir(async (dir) => {
    const fixture = createFixture()
    const { fetcher, requests } = createGithubFetcher(`${JSON.stringify(fixture.manifest, null, 2)}\n`)

    const result = await downloadMarketplacePluginBundle({
      entry: fixture.entry,
      trustContext: {
        trustedModules: new Map(),
        trustedKeyFingerprints: new Set([fixture.fingerprint]),
      },
      stagingRoot: join(dir, 'staging'),
      fetcher,
    })

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.classification, 'verified')
    assert.equal(result.trust.status, 'trusted')
    assert.equal(result.loadEligible, true)
    assert.equal(result.manifest.id, 'downloaded-plugin')
    assert.equal(existsSync(join(result.stagedBundlePath, 'plugin.json')), true)
    assert.equal(existsSync(join(result.stagedBundlePath, 'mcp', 'server.json')), true)
    assert.deepEqual(requests, [API_ROOT, RAW_PLUGIN, API_MCP, RAW_MCP])
  })
}

async function testUnavailableGithubSourceFallsBackToPackagedSeedBundle(): Promise<void> {
  await withTempDir(async (dir) => {
    const fixture = createFixture()
    const packagedBundle = join(dir, 'seed', 'plugins', 'downloaded-plugin')
    mkdirSync(join(packagedBundle, 'mcp'), { recursive: true })
    writeFileSync(join(packagedBundle, 'plugin.json'), `${JSON.stringify(fixture.manifest, null, 2)}\n`, 'utf8')
    writeFileSync(join(packagedBundle, 'mcp', 'server.json'), mcpComponentSource(), 'utf8')

    const requests: string[] = []
    const result = await downloadMarketplacePluginBundle({
      entry: fixture.entry,
      trustContext: {
        trustedModules: new Map(),
        trustedKeyFingerprints: new Set([fixture.fingerprint]),
      },
      stagingRoot: join(dir, 'staging'),
      fetcher: async (url) => {
        requests.push(url)
        return new Response('not found', { status: 404 })
      },
      packagedResourceResolver: (relativePath) =>
        relativePath === 'plugins/downloaded-plugin' ? packagedBundle : null,
    })

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(requests, [API_ROOT])
    assert.equal(result.classification, 'verified')
    assert.equal(result.trust.status, 'trusted')
    assert.equal(result.sourceUrl, SOURCE_URL)
    assert.equal(existsSync(join(result.stagedBundlePath, 'plugin.json')), true)
    assert.equal(existsSync(join(result.stagedBundlePath, 'mcp', 'server.json')), true)
  })
}

async function testPartialGithubDownloadDoesNotFallbackToPackagedSeedBundle(): Promise<void> {
  await withTempDir(async (dir) => {
    const fixture = createFixture()
    const packagedBundle = join(dir, 'seed', 'plugins', 'downloaded-plugin')
    mkdirSync(join(packagedBundle, 'mcp'), { recursive: true })
    writeFileSync(join(packagedBundle, 'plugin.json'), `${JSON.stringify(fixture.manifest, null, 2)}\n`, 'utf8')
    writeFileSync(join(packagedBundle, 'mcp', 'server.json'), mcpComponentSource(), 'utf8')

    const stagingRoot = join(dir, 'staging')
    let resolverCalls = 0
    const result = await downloadMarketplacePluginBundle({
      entry: fixture.entry,
      trustContext: {
        trustedModules: new Map(),
        trustedKeyFingerprints: new Set([fixture.fingerprint]),
      },
      stagingRoot,
      fetcher: async (url) => {
        if (url === API_ROOT) {
          return jsonResponse([
            { type: 'file', path: 'plugins/downloaded-plugin/plugin.json', download_url: RAW_PLUGIN },
            { type: 'dir', path: 'plugins/downloaded-plugin/mcp', url: API_MCP },
          ])
        }
        if (url === RAW_PLUGIN) return textResponse(`${JSON.stringify(fixture.manifest, null, 2)}\n`)
        if (url === API_MCP) return new Response('not found', { status: 404 })
        return new Response('not found', { status: 404 })
      },
      packagedResourceResolver: (relativePath) => {
        resolverCalls += 1
        return relativePath === 'plugins/downloaded-plugin' ? packagedBundle : null
      },
    })

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.statusCode, 404)
    assert.equal(resolverCalls, 0)
    assert.deepEqual(await readdir(stagingRoot), [])
  })
}

async function testGithubPathValidationDoesNotFallbackToPackagedSeedBundle(): Promise<void> {
  await withTempDir(async (dir) => {
    const fixture = createFixture()
    const stagingRoot = join(dir, 'staging')
    let resolverCalls = 0
    const result = await downloadMarketplacePluginBundle({
      entry: fixture.entry,
      trustContext: {
        trustedModules: new Map(),
        trustedKeyFingerprints: new Set([fixture.fingerprint]),
      },
      stagingRoot,
      fetcher: async (url) => {
        if (url === API_ROOT) {
          return jsonResponse([
            { type: 'file', path: 'plugins/other-plugin/plugin.json', download_url: RAW_PLUGIN },
          ])
        }
        if (url === RAW_PLUGIN) return textResponse(`${JSON.stringify(fixture.manifest, null, 2)}\n`)
        return new Response('not found', { status: 404 })
      },
      packagedResourceResolver: () => {
        resolverCalls += 1
        return join(dir, 'seed', 'plugins', 'downloaded-plugin')
      },
    })

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.message, /outside the plugin source path/i)
    assert.equal(resolverCalls, 0)
    assert.deepEqual(await readdir(stagingRoot), [])
  })
}

async function testSignedUntrustedPublisherStagesAsCommunity(): Promise<void> {
  await withTempDir(async (dir) => {
    const fixture = createFixture()
    const { fetcher } = createGithubFetcher(`${JSON.stringify(fixture.manifest, null, 2)}\n`)

    const result = await downloadMarketplacePluginBundle({
      entry: fixture.entry,
      trustContext: { trustedModules: new Map() },
      stagingRoot: join(dir, 'staging'),
      fetcher,
    })

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.classification, 'community')
    assert.equal(result.trust.status, 'signed')
    assert.equal(result.loadEligible, false)
  })
}

async function testDownloadedComponentBytesArePreserved(): Promise<void> {
  await withTempDir(async (dir) => {
    const binaryComponent = new Uint8Array([0x00, 0xff, 0xfe, 0x41, 0xc3, 0x28, 0x7f])
    const fixture = createFixture({}, binaryComponent)
    const { fetcher } = createGithubFetcher(`${JSON.stringify(fixture.manifest, null, 2)}\n`, binaryComponent)

    const result = await downloadMarketplacePluginBundle({
      entry: fixture.entry,
      trustContext: { trustedModules: new Map() },
      stagingRoot: join(dir, 'staging'),
      fetcher,
    })

    assert.equal(result.ok, true)
    if (!result.ok) return
    const staged = await readFile(join(result.stagedBundlePath, 'mcp', 'server.json'))
    assert.deepEqual(staged, Buffer.from(binaryComponent))
  })
}

async function testDownloadedComponentDigestMismatchBlocksAndRemovesStage(): Promise<void> {
  await withTempDir(async (dir) => {
    const fixture = createFixture()
    const { fetcher } = createGithubFetcher(
      `${JSON.stringify(fixture.manifest, null, 2)}\n`,
      `${JSON.stringify({ servers: [] })}\n`
    )
    const stagingRoot = join(dir, 'staging')

    const result = await downloadMarketplacePluginBundle({
      entry: fixture.entry,
      trustContext: {
        trustedModules: new Map(),
        trustedKeyFingerprints: new Set([fixture.fingerprint]),
      },
      stagingRoot,
      fetcher,
    })

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.classification, 'invalid')
    assert.match(result.message, /component digests/i)
    assert.ok(result.issues?.some((issue) => /digest/i.test(issue.message)))
    assert.deepEqual(await readdir(stagingRoot), [])
  })
}

async function testTamperedPluginSignatureBlocksAndRemovesStage(): Promise<void> {
  await withTempDir(async (dir) => {
    const fixture = createFixture()
    const tampered = { ...fixture.manifest, displayName: 'Tampered Plugin' }
    const { fetcher } = createGithubFetcher(`${JSON.stringify(tampered, null, 2)}\n`)
    const stagingRoot = join(dir, 'staging')

    const result = await downloadMarketplacePluginBundle({
      entry: fixture.entry,
      trustContext: { trustedModules: new Map() },
      stagingRoot,
      fetcher,
    })

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.classification, 'invalid')
    assert.equal(result.trust?.status, 'invalid')
    assert.match(result.message, /signature is invalid/i)
    assert.deepEqual(await readdir(stagingRoot), [])
  })
}

async function testUnsignedMcpOnlyBundleStagesAsUnsigned(): Promise<void> {
  await withTempDir(async (dir) => {
    const fixture = createUnsignedFixture()
    const { fetcher } = createGithubFetcher(`${JSON.stringify(fixture.manifest, null, 2)}\n`)
    const stagingRoot = join(dir, 'staging')

    const result = await downloadMarketplacePluginBundle({
      entry: fixture.entry,
      trustContext: { trustedModules: new Map() },
      stagingRoot,
      fetcher,
    })

    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    assert.equal(result.classification, 'unsigned')
    assert.equal(result.trust.status, 'unsigned')
    assert.equal(result.loadEligible, false)
    assert.equal(existsSync(join(result.stagedBundlePath, 'plugin.json')), true)
    assert.equal(existsSync(join(result.stagedBundlePath, 'mcp', 'server.json')), true)
  })
}

async function testUnsignedCodeBearingBundleRejectedAndRemovesStage(): Promise<void> {
  await withTempDir(async (dir) => {
    // Declare a module (code-bearing) component alongside mcp; the unsigned gate
    // must block before staging is exposed. The module dir is not listed by the
    // fetcher because the kind gate rejects before component resolution.
    const fixture = createUnsignedFixture({
      provides: ['mcp', 'module'],
      components: {
        mcp: { path: 'mcp/server.json', files: [{ path: 'mcp/server.json', sha256: sha256Hex(mcpComponentSource()) }] },
        module: { path: 'module' },
      },
    })
    const { fetcher } = createGithubFetcher(`${JSON.stringify(fixture.manifest, null, 2)}\n`)
    const stagingRoot = join(dir, 'staging')

    const result = await downloadMarketplacePluginBundle({
      entry: fixture.entry,
      trustContext: { trustedModules: new Map() },
      stagingRoot,
      fetcher,
    })

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.classification, 'unsigned')
    assert.match(result.message, /unsigned/i)
    assert.deepEqual(await readdir(stagingRoot), [])
  })
}

async function testUnsignedBundleUnderSignedRegistryEntryRejected(): Promise<void> {
  await withTempDir(async (dir) => {
    // A signed registry entry paired with an unsigned downloaded bundle is a
    // registry mismatch (possible tamper) and must not stage, even mcp-only.
    const signed = createFixture()
    const { signature: _signature, ...unsigned } = signed.manifest
    const { fetcher } = createGithubFetcher(`${JSON.stringify(unsigned, null, 2)}\n`)
    const stagingRoot = join(dir, 'staging')

    const result = await downloadMarketplacePluginBundle({
      entry: signed.entry,
      trustContext: { trustedModules: new Map() },
      stagingRoot,
      fetcher,
    })

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.classification, 'invalid')
    assert.deepEqual(await readdir(stagingRoot), [])
  })
}

async function testRejectsNonHttpsSourceBeforeFetch(): Promise<void> {
  const fixture = createFixture()
  let fetched = false
  const result = await downloadMarketplacePluginBundle({
    entry: { ...fixture.entry, source: 'http://example.com/plugins/downloaded-plugin' },
    trustContext: { trustedModules: new Map() },
    fetcher: async () => {
      fetched = true
      return textResponse('unexpected')
    },
  })

  assert.equal(result.ok, false)
  assert.match(result.message, /HTTPS/)
  assert.equal(fetched, false)
}

async function testRejectsNonAllowlistedSourceHostBeforeFetch(): Promise<void> {
  const fixture = createFixture()
  let fetched = false
  const result = await downloadMarketplacePluginBundle({
    entry: { ...fixture.entry, source: 'https://evil.example.com/plugins/downloaded-plugin' },
    trustContext: { trustedModules: new Map() },
    fetcher: async () => {
      fetched = true
      return textResponse('unexpected')
    },
  })

  assert.equal(result.ok, false)
  assert.match(result.message, /allowlist/i)
  assert.equal(fetched, false)
}

async function testForeignPerFileDownloadUrlRejectedMidDownload(): Promise<void> {
  await withTempDir(async (dir) => {
    const fixture = createFixture()
    const foreignDownloadUrl = 'https://evil.example.com/downloaded-plugin/plugin.json'
    const requests: string[] = []
    const stagingRoot = join(dir, 'staging')
    const result = await downloadMarketplacePluginBundle({
      entry: fixture.entry,
      trustContext: {
        trustedModules: new Map(),
        trustedKeyFingerprints: new Set([fixture.fingerprint]),
      },
      stagingRoot,
      fetcher: async (url) => {
        requests.push(url)
        if (url === API_ROOT) {
          return jsonResponse([
            { type: 'file', path: 'plugins/downloaded-plugin/plugin.json', download_url: foreignDownloadUrl },
          ])
        }
        return textResponse('unexpected')
      },
    })

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.message, /allowlist/i)
    // The Contents API host is allowlisted and fetched, but the followed
    // per-file download_url on a foreign host is rejected before any request.
    assert.deepEqual(requests, [API_ROOT])
    assert.deepEqual(await readdir(stagingRoot), [])
  })
}

async function testNonCanonicalOwnerGithubSourceDownloads(): Promise<void> {
  await withTempDir(async (dir) => {
    const fixture = createFixture()
    const source = 'https://github.com/community-org/registry/tree/main/plugins/downloaded-plugin'
    const apiRoot = 'https://api.github.com/repos/community-org/registry/contents/plugins/downloaded-plugin?ref=main'
    const apiMcp = 'https://api.github.com/repos/community-org/registry/contents/plugins/downloaded-plugin/mcp?ref=main'
    const fetcher: MarketplacePluginDownloadFetch = async (url) => {
      if (url === apiRoot) {
        return jsonResponse([
          { type: 'file', path: 'plugins/downloaded-plugin/plugin.json', download_url: RAW_PLUGIN },
          { type: 'dir', path: 'plugins/downloaded-plugin/mcp', url: apiMcp },
        ])
      }
      if (url === apiMcp) {
        return jsonResponse([
          { type: 'file', path: 'plugins/downloaded-plugin/mcp/server.json', download_url: RAW_MCP },
        ])
      }
      if (url === RAW_PLUGIN) return textResponse(`${JSON.stringify(fixture.manifest, null, 2)}\n`)
      if (url === RAW_MCP) return textResponse(mcpComponentSource())
      return new Response('not found', { status: 404 })
    }

    const result = await downloadMarketplacePluginBundle({
      entry: { ...fixture.entry, source },
      trustContext: {
        trustedModules: new Map(),
        trustedKeyFingerprints: new Set([fixture.fingerprint]),
      },
      stagingRoot: join(dir, 'staging'),
      fetcher,
    })

    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    assert.equal(result.classification, 'verified')
    assert.equal(result.sourceUrl, source)
  })
}

function testCliAndAppRejectSameTamperedModuleBytes(): void {
  const workDir = mkdtempSync(join(tmpdir(), 'mc-marketplace-cli-verify-'))
  try {
    const cliBundle = join(workDir, 'multicode-module.cjs')
    buildSync({
      entryPoints: [join(process.cwd(), 'packages/module-sdk/src/cli.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: cliBundle,
    })

    const moduleDir = join(workDir, 'module')
    mkdirSync(moduleDir)
    writeFileSync(
      join(moduleDir, 'manifest.json'),
      JSON.stringify({
        id: 'marketplace-download-fixture',
        displayName: 'Marketplace Download Fixture',
        version: 1,
        permissions: ['network'],
      }, null, 2)
    )
    const keyPath = join(workDir, 'signing.key')
    assert.equal(spawnSync(process.execPath, [cliBundle, 'keygen', '--out', keyPath], { encoding: 'utf8' }).status, 0)
    assert.equal(spawnSync(process.execPath, [cliBundle, 'sign', moduleDir, '--key', keyPath], { encoding: 'utf8' }).status, 0)

    const manifestPath = join(moduleDir, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.displayName = 'Tampered Download Fixture'
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

    const cliVerify = spawnSync(process.execPath, [cliBundle, 'verify', moduleDir], { encoding: 'utf8' })
    assert.equal(cliVerify.status, 1)
    assert.match(cliVerify.stderr, /INVALID signature/)

    const parsed = parseThirdPartyModuleManifest(readFileSync(manifestPath, 'utf8'))
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.equal(verifyModuleSignature(parsed.manifest).valid, false)
    assert.equal(classifySignedManifestTrust(parsed.manifest, { trustedModules: new Map() }).status, 'invalid')
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  await testVerifiedFirstPartyDownloadStagesBundle()
  await testUnavailableGithubSourceFallsBackToPackagedSeedBundle()
  await testPartialGithubDownloadDoesNotFallbackToPackagedSeedBundle()
  await testGithubPathValidationDoesNotFallbackToPackagedSeedBundle()
  await testSignedUntrustedPublisherStagesAsCommunity()
  await testDownloadedComponentBytesArePreserved()
  await testDownloadedComponentDigestMismatchBlocksAndRemovesStage()
  await testTamperedPluginSignatureBlocksAndRemovesStage()
  await testUnsignedMcpOnlyBundleStagesAsUnsigned()
  await testUnsignedCodeBearingBundleRejectedAndRemovesStage()
  await testUnsignedBundleUnderSignedRegistryEntryRejected()
  await testRejectsNonHttpsSourceBeforeFetch()
  await testRejectsNonAllowlistedSourceHostBeforeFetch()
  await testForeignPerFileDownloadUrlRejectedMidDownload()
  await testNonCanonicalOwnerGithubSourceDownloads()
  testCliAndAppRejectSameTamperedModuleBytes()
  console.log('marketplace plugin download tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
