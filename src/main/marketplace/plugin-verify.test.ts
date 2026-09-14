import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
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
import { skillContentDigest } from './skill-content'
import type { MarketplacePluginDownloadFetch } from './plugin-download'

const SOURCE_URL = 'https://raw.githubusercontent.com/preview/preview-plugin/main/'
const PLUGIN_JSON_URL = 'https://raw.githubusercontent.com/preview/preview-plugin/main/plugin.json'
const MCP_JSON_URL = 'https://raw.githubusercontent.com/preview/preview-plugin/main/mcp/server.json'

type Fixture = {
  entry: MarketplacePluginEntry
  manifest: MarketplacePluginManifest
  fingerprint: string
}

function mcpComponentSource(): string {
  return `${JSON.stringify({
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
  })}\n`
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')
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
  const mcpSource = mcpComponentSource()
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
      mcp: { path: 'mcp/server.json', files: [{ path: 'mcp/server.json', sha256: sha256Hex(mcpSource) }] },
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
    if (url === MCP_JSON_URL) return new Response(mcpComponentSource())
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

async function testUnsignedBundleUnderSignedEntryBlocksAsMismatch(): Promise<void> {
  await withTempDir(async (temp) => {
    const stagingRoot = join(temp, 'staging')
    const fixture = createFixture({ permissions: ['ipc:settings'] })
    const { signature: _signature, ...unsigned } = fixture.manifest
    const verifier = createMarketplacePluginVerifier({
      trustContext: () => ({ trustedModules: new Map() }),
      stagingRoot,
      // The registry entry is signed but the downloaded bundle is unsigned: a
      // signature was stripped. This is a registry mismatch (tamper), blocked as
      // invalid with no permissions surfaced — not a permitted unsigned preview.
      fetcher: createFetcher(`${JSON.stringify(unsigned, null, 2)}\n`),
    })

    const result = await verifier.verify(fixture.entry)

    assert.equal(result.classification, 'invalid')
    assert.deepEqual(result.permissions, [])
    assert.match(result.message ?? '', /registry entry/i)
    assert.ok(result.issues?.some((issue) => /signature/i.test(issue.path) || /signature/i.test(issue.message)))
    assert.deepEqual(await listDir(stagingRoot), [])
    assertNoInstallSideEffects(temp, stagingRoot)
  })
}

async function testUnsignedMcpPreviewSurfacesPermissionsAndRemovesStage(): Promise<void> {
  await withTempDir(async (temp) => {
    const stagingRoot = join(temp, 'staging')
    // A genuinely unsigned mcp-only entry+bundle (matching, no signature either
    // side) is now a permitted preview: classification 'unsigned', permissions
    // surfaced for the trust prompt, and the stage is cleaned after preview.
    const fixture = createFixture({ permissions: ['network'] })
    const { signature: _manifestSignature, ...unsignedManifest } = fixture.manifest
    const { signature: _entrySignature, ...unsignedEntry } = fixture.entry
    const verifier = createMarketplacePluginVerifier({
      trustContext: () => ({ trustedModules: new Map() }),
      stagingRoot,
      fetcher: createFetcher(`${JSON.stringify(unsignedManifest, null, 2)}\n`),
    })

    const result = await verifier.verify(unsignedEntry as MarketplacePluginEntry)

    assert.equal(result.classification, 'unsigned')
    assert.deepEqual(result.permissions, ['network'])
    assert.equal(result.message, undefined)
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


async function testClaudePluginPreviewDisclosesSkillListing(): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'mc-verify-claude-'))
  try {
    const stagingRoot = join(temp, 'staging')
    // Bundled payload on disk + matching digests on the entry — verify reads
    // local bytes only (no fetcher is even wired).
    const doc = '---\nname: hf-cli\n---\n'
    const resourceDir = join(temp, 'packaged', 'skills', 'acme-skills')
    mkdirSync(join(resourceDir, 'hf-cli'), { recursive: true })
    writeFileSync(join(resourceDir, 'hf-cli', 'SKILL.md'), doc, 'utf8')
    const files = [
      {
        path: 'SKILL.md',
        sha256: createHash('sha256').update(doc, 'utf8').digest('hex'),
        size: Buffer.byteLength(doc, 'utf8'),
      },
    ]
    const verifier = createMarketplacePluginVerifier({
      trustContext: () => ({ trustedModules: new Map() }),
      stagingRoot,
      packagedResourceResolver: (relativePath) => (relativePath === 'skills/acme-skills' ? resourceDir : null),
    })
    const result = await verifier.verify({
      id: 'acme-skills',
      name: 'skills',
      publisher: { name: 'Acme', verified: false },
      summary: 'Acme skills plugin.',
      category: 'Development',
      icon: 'data:image/svg+xml;base64,PHN2Zy8+',
      latest: 1,
      provides: ['skills'],
      tags: ['claude-plugin'],
      source: 'https://github.com/acme/skills',
      skills: [
        {
          name: 'hf-cli',
          description: 'Hub CLI.',
          path: 'skills/hf-cli',
          files,
          contentDigest: skillContentDigest(files),
        },
      ],
    })
    // Claude plugins verify as unsigned (they carry no studio manifest) and
    // disclose the REAL skill listing the trust grant would install.
    assert.equal(result.classification, 'unsigned')
    assert.deepEqual(result.permissions, [])
    assert.deepEqual(result.files, ['skills/hf-cli'])
    // The bundled-content identity rides the result so the install re-checks
    // exactly what this listing disclosed.
    assert.match(result.pinnedRef ?? '', /^bundled:[a-f0-9]{16}$/)
    // The pre-trust preview leaves no staged bytes behind.
    assert.deepEqual(await readdir(stagingRoot), [])
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  await testVerifiedPreviewSurfacesPermissionsAndRemovesStage()
  await testCommunityPreviewSurfacesPermissionsForTrustPrompt()
  await testVerifiedPreviewDoesNotFabricateMissingPermissions()
  await testUnsignedBundleUnderSignedEntryBlocksAsMismatch()
  await testUnsignedMcpPreviewSurfacesPermissionsAndRemovesStage()
  await testInvalidPreviewBlocksWithoutPermissions()
  await testClaudePluginPreviewDisclosesSkillListing()
  console.log('marketplace plugin verify tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
