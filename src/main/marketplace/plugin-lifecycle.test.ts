import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import type {
  McpSettings,
  SkillPackEntry,
} from '../../shared/electron-api'
import type { MarketplacePluginEntry, MarketplacePluginManifest } from '../../shared/marketplace'
import { canonicalManifestPayload, validateMarketplacePluginManifest } from '../../shared/marketplace'
import { canonicalManifestPayload as canonicalModulePayload, validateThirdPartyModuleManifest } from '../../shared/modules/third-party-manifest'
import type { PluginManifest, PluginMcpConfigFormat } from '../../shared/plugin-manifest'
import { createMcpConfigService, type PluginLookup } from '../mcp-config-service'
import { classifyModuleTrust, verifyModuleSignature, type ModuleTrustContext } from '../modules/module-signature'
import { discoverUserModules } from '../modules/user-module-registry'
import type { SkillPackService } from '../skill-pack-service'
import { createMarketplacePluginLifecycleService, type MarketplacePluginLifecycleServices } from './plugin-lifecycle'
import type { MarketplacePluginDownloadFetch } from './plugin-download'

type BundleComponents = {
  mcp?: { path: string; id: string }
  skills?: { path: string; name: string }
  module?: { path: string; id: string }
  cli?: { path: string; id: string }
}

type Signer = {
  publicKey: KeyObject
  privateKey: KeyObject
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'mc-marketplace-lifecycle-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function mcpPluginManifest(id: string, format: PluginMcpConfigFormat): PluginManifest {
  return {
    id,
    displayName: id,
    version: 1,
    binary: id,
    permissionPresets: { default: { label: 'Default', args: [] } },
    launch: { argv: ['{{binary}}'] },
    promptInjection: { mode: 'stdin-pipe' },
    completion: { mode: 'process-exit' },
    capabilities: {
      resumeSession: false,
      sessionIdFromCaller: false,
      toolUse: true,
      mcpServers: true,
    },
    mcpConfig: {
      path: `{{workspaceRoot}}/.${id}/config.toml`,
      format,
    },
  }
}

function createLocalSkillService(): SkillPackService {
  return {
    listCatalog: () => ({ ok: true, packs: [] }),
    listInstalled: async (input) => {
      const skillsDir = join(input.workspaceRoot, '.agents', 'skills')
      if (!existsSync(skillsDir)) return { ok: true, installed: [] }
      const entries = await readdir(skillsDir, { withFileTypes: true })
      return {
        ok: true,
        installed: entries
          .filter((entry) => entry.isDirectory())
          .map((entry): SkillPackEntry => ({
            id: entry.name,
            slug: entry.name,
            name: entry.name,
            installedDirName: entry.name,
            harnesses: ['agents'],
            source: 'custom',
          })),
      }
    },
    install: async (input) => {
      const installedDirName = input.installedDirName ?? basename(input.slug)
      for (const harness of input.harnesses?.length ? input.harnesses : ['agents' as const]) {
        const harnessDir = harness === 'agents' ? '.agents' : `.${harness}`
        await cp(input.slug, join(input.workspaceRoot, harnessDir, 'skills', installedDirName), {
          recursive: true,
          force: true,
        })
      }
      return {
        ok: true,
        installed: {
          id: installedDirName,
          slug: input.slug,
          name: installedDirName,
          installedDirName,
          harnesses: input.harnesses?.length ? input.harnesses : ['agents'],
          source: 'custom',
        },
        log: input.slug,
      }
    },
    remove: async (input) => {
      const dirName = input.installedDirName ?? basename(input.slug)
      const removed: string[] = []
      for (const harness of input.harnesses?.length ? input.harnesses : ['agents' as const]) {
        const harnessDir = harness === 'agents' ? '.agents' : `.${harness}`
        const path = join(input.workspaceRoot, harnessDir, 'skills', dirName)
        if (!existsSync(path)) continue
        await rm(path, { recursive: true, force: true })
        removed.push(path)
      }
      if (removed.length === 0) return { ok: false, message: `No installed copies of ${dirName} were found in this workspace.` }
      return { ok: true, slug: input.slug, log: removed.join('\n') }
    },
  }
}

function signPayload(payload: string, signer: Signer): MarketplacePluginManifest['signature'] {
  return {
    algorithm: 'ed25519',
    publicKey: signer.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    signature: sign(null, Buffer.from(payload, 'utf8'), signer.privateKey).toString('base64'),
  }
}

function signedPluginManifest(
  components: BundleComponents,
  signer: Signer,
  version: number,
  overrides: Record<string, unknown> = {}
): MarketplacePluginManifest {
  const unsigned = {
    id: 'registry-plugin',
    displayName: 'Registry Plugin',
    version,
    permissions: ['network'],
    components: Object.fromEntries(
      Object.entries(components).map(([kind, component]) => [kind, { path: component.path }])
    ),
    ...overrides,
  }
  const dummySignature = signPayload('{}', signer)
  const validated = validateMarketplacePluginManifest({ ...unsigned, signature: dummySignature })
  assert.equal(validated.ok, true)
  if (!validated.ok) throw new Error('test plugin manifest did not validate')
  return {
    ...validated.manifest,
    signature: signPayload(canonicalManifestPayload(validated.manifest), signer),
  }
}

function signedModuleManifest(id: string, signer: Signer): Record<string, unknown> {
  const unsigned = {
    id,
    displayName: `${id} Module`,
    version: 1,
    permissions: ['network'],
    entry: { main: 'main.cjs' },
  }
  const validated = validateThirdPartyModuleManifest(unsigned)
  assert.equal(validated.ok, true)
  if (!validated.ok) throw new Error('test module manifest did not validate')
  return {
    ...validated.manifest,
    signature: signPayload(canonicalModulePayload(validated.manifest), signer),
  }
}

async function writeBundle(root: string, folder: string, components: BundleComponents, signer: Signer, version: number): Promise<{
  files: Map<string, string>
  entry: MarketplacePluginEntry
  fingerprint: string
}> {
  const bundleRoot = join(root, folder)
  const files = new Map<string, string>()
  const manifest = signedPluginManifest(components, signer, version)
  const fingerprint = verifyModuleSignature(manifest).fingerprint!

  files.set('plugin.json', `${JSON.stringify(manifest, null, 2)}\n`)
  if (components.mcp) {
    files.set(components.mcp.path, `${JSON.stringify({
      servers: [
        {
          id: components.mcp.id,
          name: components.mcp.id,
          transport: 'stdio',
          command: 'node',
          args: ['-e', `console.log("${components.mcp.id}")`],
          clients: ['codex'],
          scope: 'workspace',
          source: 'custom',
          riskLevel: 'local-command',
        },
      ],
    }, null, 2)}\n`)
  }
  if (components.skills) {
    files.set(`${components.skills.path}/SKILL.md`, `---\nname: ${components.skills.name}\ndescription: ${components.skills.name}.\n---\n`)
  }
  if (components.module) {
    files.set(`${components.module.path}/manifest.json`, `${JSON.stringify(signedModuleManifest(components.module.id, signer), null, 2)}\n`)
    files.set(`${components.module.path}/main.cjs`, 'exports.registerMain = () => {}\n')
  }
  if (components.cli) {
    files.set(`${components.cli.path}/plugin.json`, `${JSON.stringify({
      id: components.cli.id,
      displayName: components.cli.id,
      version: 1,
      binary: 'node',
      permissionPresets: { default: { label: 'Default', args: [] } },
      launch: { argv: ['{{binary}}'] },
      promptInjection: { mode: 'stdin-pipe' },
      completion: { mode: 'process-exit' },
      capabilities: {
        resumeSession: false,
        sessionIdFromCaller: false,
        toolUse: false,
        mcpServers: false,
      },
    }, null, 2)}\n`)
  }

  for (const [path, source] of files) {
    const destination = join(bundleRoot, path)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, source, 'utf8')
  }

  return {
    files,
    fingerprint,
    entry: {
      id: manifest.id,
      name: manifest.displayName,
      publisher: { name: 'Multicode Labs', verified: true },
      summary: 'Registry plugin.',
      category: 'dev-tools',
      icon: 'icons/registry.svg',
      latest: manifest.version,
      source: `https://github.com/multicode-labs/marketplace/tree/main/plugins/${folder}`,
      provides: Object.keys(components) as MarketplacePluginEntry['provides'],
      signature: manifest.signature,
    },
  }
}

function createGithubFetcher(folders: Map<string, Map<string, string>>): MarketplacePluginDownloadFetch {
  return async (url) => {
    const github = url.match(/^https:\/\/api\.github\.com\/repos\/multicode-labs\/marketplace\/contents\/plugins\/([^?]+)\?ref=main$/)
    if (github) {
      const folder = github[1]!
      const files = folders.get(folder)
      if (!files) return new Response('not found', { status: 404 })
      return new Response(JSON.stringify(Array.from(files.keys()).map((path) => ({
        type: 'file',
        path: `plugins/${folder}/${path}`,
        download_url: `https://raw.example.test/${folder}/${path}`,
      }))))
    }
    const raw = url.match(/^https:\/\/raw\.example\.test\/([^/]+)\/(.+)$/)
    if (raw) {
      const files = folders.get(raw[1]!)
      const body = files?.get(raw[2]!)
      if (body === undefined) return new Response('not found', { status: 404 })
      return new Response(body)
    }
    return new Response('not found', { status: 404 })
  }
}

async function createServices(temp: string, fetcher: MarketplacePluginDownloadFetch, trustContext: ModuleTrustContext): Promise<{
  services: MarketplacePluginLifecycleServices
  workspaceRoot: string
  moduleRoot: string
  pluginRoot: string
  receiptStorePath: string
}> {
  const workspaceRoot = join(temp, 'workspace')
  const moduleRoot = join(temp, 'modules')
  const pluginRoot = join(temp, 'plugins')
  const receiptStorePath = join(temp, 'marketplace-installs.json')
  await mkdir(workspaceRoot, { recursive: true })
  const lookupPlugin: PluginLookup = (id) => id === 'codex' ? { manifest: mcpPluginManifest(id, 'codex') } : undefined
  return {
    workspaceRoot,
    moduleRoot,
    pluginRoot,
    receiptStorePath,
    services: {
      mcpConfigService: createMcpConfigService({ lookupPlugin, homeDir: () => join(temp, 'home') }),
      skillPackService: createLocalSkillService(),
      trustContext: () => trustContext,
      moduleRoot: () => moduleRoot,
      pluginRoot: () => pluginRoot,
      reloadPlugins: () => undefined,
      receiptStorePath,
      stagingRoot: join(temp, 'staging'),
      fetcher,
    },
  }
}

async function testVerifiedRegistryInstallFansOutAndRecordsReceipt(): Promise<void> {
  await withTempDir(async (temp) => {
    const signer = generateKeyPairSync('ed25519')
    const components: BundleComponents = {
      mcp: { path: 'mcp/server.json', id: 'registry-mcp-v1' },
      skills: { path: 'skills/registry-skill-v1', name: 'registry-skill-v1' },
      module: { path: 'module', id: 'registry-module-v1' },
      cli: { path: 'cli', id: 'registry-cli-v1' },
    }
    const bundle = await writeBundle(temp, 'verified-plugin', components, signer, 1)
    const folders = new Map([[ 'verified-plugin', bundle.files ]])
    const { services, workspaceRoot, moduleRoot, pluginRoot, receiptStorePath } = await createServices(
      temp,
      createGithubFetcher(folders),
      { trustedModules: new Map(), trustedKeyFingerprints: new Set([bundle.fingerprint]) }
    )
    const lifecycle = createMarketplacePluginLifecycleService(services)
    const mcpSettings: McpSettings = { syncEnabled: false, servers: {} }

    const result = await lifecycle.installFromRegistry({
      entry: bundle.entry,
      workspaceRoot,
      mcpSettings,
      mcpClients: ['codex'],
      skillHarnesses: ['agents'],
    })

    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    assert.equal(result.classification, 'verified')
    assert.equal(result.trust, 'trusted')
    assert.equal(result.loadEligible, true)
    assert.equal(result.updated, false)
    assert.match(await readFile(join(workspaceRoot, '.codex', 'config.toml'), 'utf8'), /registry-mcp-v1/)
    assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'registry-skill-v1', 'SKILL.md')), true)
    assert.equal(existsSync(join(moduleRoot, 'registry-module-v1', 'manifest.json')), true)
    assert.equal(existsSync(join(pluginRoot, 'registry-cli-v1', 'plugin.json')), true)

    const modules = await discoverUserModules(moduleRoot, services.trustContext())
    assert.equal(modules.modules[0]?.manifest.id, 'registry-module-v1')
    assert.equal(classifyModuleTrust(modules.modules[0].manifest, services.trustContext()).status, 'trusted')
    const receipts = JSON.parse(await readFile(receiptStorePath, 'utf8')) as { plugins: Record<string, unknown> }
    assert.ok(receipts.plugins['registry-plugin'])
  })
}

async function testCommunityBundleRequiresTrustGrant(): Promise<void> {
  await withTempDir(async (temp) => {
    const signer = generateKeyPairSync('ed25519')
    const components: BundleComponents = { mcp: { path: 'mcp/server.json', id: 'community-mcp' } }
    const bundle = await writeBundle(temp, 'community-plugin', components, signer, 1)
    bundle.entry.publisher.verified = false
    const folders = new Map([[ 'community-plugin', bundle.files ]])
    const { services, workspaceRoot } = await createServices(
      temp,
      createGithubFetcher(folders),
      { trustedModules: new Map() }
    )
    const lifecycle = createMarketplacePluginLifecycleService(services)

    const blocked = await lifecycle.installFromRegistry({
      entry: bundle.entry,
      workspaceRoot,
      mcpSettings: { syncEnabled: false, servers: {} },
      mcpClients: ['codex'],
    })

    assert.equal(blocked.ok, false)
    if (blocked.ok) return
    assert.equal(blocked.classification, 'community')
    assert.match(blocked.message, /requires trust approval/)
    assert.equal(existsSync(join(workspaceRoot, '.codex', 'config.toml')), false)

    const granted = await lifecycle.installFromRegistry({
      entry: bundle.entry,
      workspaceRoot,
      mcpSettings: { syncEnabled: false, servers: {} },
      mcpClients: ['codex'],
      trustGranted: true,
    })
    assert.equal(granted.ok, true, JSON.stringify(granted))
    if (!granted.ok) return
    assert.equal(granted.classification, 'community')
    assert.match(await readFile(join(workspaceRoot, '.codex', 'config.toml'), 'utf8'), /community-mcp/)
  })
}

async function testUpdateAndUninstallRemoveOldComponents(): Promise<void> {
  await withTempDir(async (temp) => {
    const signer = generateKeyPairSync('ed25519')
    const v1 = await writeBundle(temp, 'plugin-v1', {
      mcp: { path: 'mcp/server.json', id: 'registry-mcp-v1' },
      skills: { path: 'skills/registry-skill-v1', name: 'registry-skill-v1' },
      module: { path: 'module', id: 'registry-module-v1' },
      cli: { path: 'cli', id: 'registry-cli-v1' },
    }, signer, 1)
    const v2 = await writeBundle(temp, 'plugin-v2', {
      mcp: { path: 'mcp/server.json', id: 'registry-mcp-v2' },
      skills: { path: 'skills/registry-skill-v2', name: 'registry-skill-v2' },
      module: { path: 'module', id: 'registry-module-v2' },
      cli: { path: 'cli', id: 'registry-cli-v2' },
    }, signer, 2)
    const folders = new Map([
      ['plugin-v1', v1.files],
      ['plugin-v2', v2.files],
    ])
    const { services, workspaceRoot, moduleRoot, pluginRoot, receiptStorePath } = await createServices(
      temp,
      createGithubFetcher(folders),
      { trustedModules: new Map(), trustedKeyFingerprints: new Set([v1.fingerprint, v2.fingerprint]) }
    )
    const lifecycle = createMarketplacePluginLifecycleService(services)
    const installed = await lifecycle.installFromRegistry({
      entry: v1.entry,
      workspaceRoot,
      mcpSettings: { syncEnabled: false, servers: {} },
      mcpClients: ['codex'],
      skillHarnesses: ['agents'],
    })
    assert.equal(installed.ok, true, JSON.stringify(installed))
    if (!installed.ok) return

    const updated = await lifecycle.updateFromRegistry({
      entry: v2.entry,
      workspaceRoot,
      mcpSettings: installed.mcpSettings,
      mcpClients: ['codex'],
      skillHarnesses: ['agents'],
    })
    assert.equal(updated.ok, true, JSON.stringify(updated))
    if (!updated.ok) return
    assert.equal(updated.updated, true)

    const codexConfig = await readFile(join(workspaceRoot, '.codex', 'config.toml'), 'utf8')
    assert.doesNotMatch(codexConfig, /registry-mcp-v1/)
    assert.match(codexConfig, /registry-mcp-v2/)
    assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'registry-skill-v1')), false)
    assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'registry-skill-v2', 'SKILL.md')), true)
    assert.equal(existsSync(join(moduleRoot, 'registry-module-v1')), false)
    assert.equal(existsSync(join(moduleRoot, 'registry-module-v2', 'manifest.json')), true)
    assert.equal(existsSync(join(pluginRoot, 'registry-cli-v1')), false)
    assert.equal(existsSync(join(pluginRoot, 'registry-cli-v2', 'plugin.json')), true)

    const uninstalled = await lifecycle.uninstall({
      pluginId: 'registry-plugin',
      workspaceRoot,
      mcpSettings: updated.mcpSettings,
      mcpClients: ['codex'],
      skillHarnesses: ['agents'],
    })
    assert.equal(uninstalled.ok, true)
    if (!uninstalled.ok) return
    const afterUninstallConfig = await readFile(join(workspaceRoot, '.codex', 'config.toml'), 'utf8')
    assert.doesNotMatch(afterUninstallConfig, /registry-mcp-v2/)
    assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'registry-skill-v2')), false)
    assert.equal(existsSync(join(moduleRoot, 'registry-module-v2')), false)
    assert.equal(existsSync(join(pluginRoot, 'registry-cli-v2')), false)
    const receipts = JSON.parse(await readFile(receiptStorePath, 'utf8')) as { plugins: Record<string, unknown> }
    assert.equal(receipts.plugins['registry-plugin'], undefined)
  })
}

async function main(): Promise<void> {
  await testVerifiedRegistryInstallFansOutAndRecordsReceipt()
  await testCommunityBundleRequiresTrustGrant()
  await testUpdateAndUninstallRemoveOldComponents()
  console.log('marketplace plugin lifecycle tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
