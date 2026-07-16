import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { IpcMain } from 'electron'

import type {
  McpSettings,
  SkillPackEntry,
} from '../../shared/electron-api'
import type { MarketplacePluginEntry, MarketplacePluginManifest } from '../../shared/marketplace'
import { canonicalManifestPayload, validateMarketplacePluginManifest } from '../../shared/marketplace'
import { canonicalManifestPayload as canonicalModulePayload, validateThirdPartyModuleManifest } from '../../shared/modules/third-party-manifest'
import type { PluginManifest, PluginMcpConfigFormat } from '../../shared/plugin-manifest'
import { createMcpConfigService, type PluginLookup } from '../mcp-config-service'
import { loadMainModules } from '../module-host/load-modules'
import { classifyModuleTrust, verifyModuleSignature, type ModuleTrustContext } from '../modules/module-signature'
import { planThirdPartyMainModules } from '../modules/third-party-main-loader'
import { discoverUserModules } from '../modules/user-module-registry'
import type { InstallPluginResult } from '../plugin-install'
import type { SkillPackService } from '../skill-pack-service'
import { createMarketplacePluginLifecycleService, type MarketplacePluginLifecycleServices } from './plugin-lifecycle'
import { skillContentDigest } from './skill-content'
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

function createFakeIpcMain(): { ipcMain: IpcMain; handled: string[] } {
  const handled: string[] = []
  const ipcMain = {
    handle(channel: string, _handler: unknown): void {
      handled.push(channel)
    },
  } as unknown as IpcMain
  return { ipcMain, handled }
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

function sha256Hex(source: string): string {
  return createHash('sha256').update(Buffer.from(source, 'utf8')).digest('hex')
}

function componentsWithDigests(
  components: BundleComponents,
  files: Map<string, string>
): MarketplacePluginManifest['components'] {
  return Object.fromEntries(
    Object.entries(components).map(([kind, component]) => {
      const componentFiles = Array.from(files.entries())
        .filter(([path]) => path === component.path || path.startsWith(`${component.path}/`))
        .map(([path, source]) => ({ path, sha256: sha256Hex(source) }))
        .sort((a, b) => a.path.localeCompare(b.path))
      return [kind, { path: component.path, files: componentFiles }]
    })
  ) as MarketplacePluginManifest['components']
}

function signedPluginManifest(
  components: BundleComponents,
  files: Map<string, string>,
  signer: Signer,
  version: number,
  overrides: Record<string, unknown> = {}
): MarketplacePluginManifest {
  const unsigned = {
    id: 'registry-plugin',
    displayName: 'Registry Plugin',
    version,
    permissions: ['network'],
    components: componentsWithDigests(components, files),
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

function signedModuleManifest(id: string, signer: Signer, version = 1): Record<string, unknown> {
  const unsigned = {
    id,
    displayName: `${id} Module`,
    version,
    defaultEnabled: true,
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

async function writeBundle(
  root: string,
  folder: string,
  components: BundleComponents,
  signer: Signer,
  version: number,
  options: { unsigned?: boolean } = {}
): Promise<{
  files: Map<string, string>
  entry: MarketplacePluginEntry
  fingerprint: string
}> {
  const bundleRoot = join(root, folder)
  const files = new Map<string, string>()
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
    files.set(`${components.skills.path}/SKILL.md`, `---\nname: ${components.skills.name}\ndescription: ${components.skills.name} v${version}.\n---\n`)
  }
  if (components.module) {
    files.set(`${components.module.path}/manifest.json`, `${JSON.stringify(signedModuleManifest(components.module.id, signer, version), null, 2)}\n`)
    files.set(`${components.module.path}/main.cjs`, 'exports.registerMain = () => {}\n')
  }
  if (components.cli) {
    files.set(`${components.cli.path}/plugin.json`, `${JSON.stringify({
      id: components.cli.id,
      displayName: components.cli.id,
      version,
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

  const signed = signedPluginManifest(components, files, signer, version)
  // An unsigned bundle is the same authoring manifest with the signature
  // stripped; the download/installer decide trust from signature presence.
  const { signature, ...unsignedManifest } = signed
  const manifest = options.unsigned ? unsignedManifest : signed
  const fingerprint = options.unsigned ? '' : verifyModuleSignature(signed).fingerprint!
  files.set('plugin.json', `${JSON.stringify(manifest, null, 2)}\n`)

  for (const [path, source] of files) {
    const destination = join(bundleRoot, path)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, source, 'utf8')
  }

  return {
    files,
    fingerprint,
    entry: {
      id: signed.id,
      name: signed.displayName,
      publisher: { name: 'Multicode Labs', verified: !options.unsigned },
      summary: 'Registry plugin.',
      category: 'dev-tools',
      icon: 'icons/registry.svg',
      latest: signed.version,
      source: `https://github.com/multicode-labs/marketplace/tree/main/plugins/${folder}`,
      provides: Object.keys(components) as MarketplacePluginEntry['provides'],
      ...(options.unsigned ? {} : { signature }),
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
        download_url: `https://raw.githubusercontent.com/multicode-labs/marketplace/main/${folder}/${path}`,
      }))))
    }
    const raw = url.match(/^https:\/\/raw\.githubusercontent\.com\/multicode-labs\/marketplace\/main\/([^/]+)\/(.+)$/)
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
    const planned = planThirdPartyMainModules(modules)
    const { ipcMain } = createFakeIpcMain()
    const loaded = loadMainModules({
      ipcMain,
      modules: planned.modules,
      ineligible: planned.ineligible,
      launchErrors: planned.launchErrors,
    })
    assert.deepEqual(loaded.report.loaded, ['registry-module-v1'])
    assert.deepEqual(loaded.report.errors, [])

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

async function testUnsignedMcpSkillsBundleRoutesThroughTrust(): Promise<void> {
  await withTempDir(async (temp) => {
    const signer = generateKeyPairSync('ed25519')
    const components: BundleComponents = {
      mcp: { path: 'mcp/server.json', id: 'unsigned-mcp' },
      skills: { path: 'skills/unsigned-skill', name: 'unsigned-skill' },
    }
    const bundle = await writeBundle(temp, 'unsigned-plugin', components, signer, 1, { unsigned: true })
    const folders = new Map([[ 'unsigned-plugin', bundle.files ]])
    const { services, workspaceRoot, receiptStorePath } = await createServices(
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
      skillHarnesses: ['agents'],
    })
    assert.equal(blocked.ok, false)
    if (blocked.ok) return
    assert.equal(blocked.classification, 'unsigned')
    assert.match(blocked.message, /Unsigned marketplace plugin requires trust approval/)
    assert.equal(existsSync(join(workspaceRoot, '.codex', 'config.toml')), false)
    assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'unsigned-skill')), false)
    assert.equal(existsSync(receiptStorePath), false)

    const granted = await lifecycle.installFromRegistry({
      entry: bundle.entry,
      workspaceRoot,
      mcpSettings: { syncEnabled: false, servers: {} },
      mcpClients: ['codex'],
      skillHarnesses: ['agents'],
      trustGranted: true,
    })
    assert.equal(granted.ok, true, JSON.stringify(granted))
    if (!granted.ok) return
    assert.equal(granted.classification, 'unsigned')
    assert.equal(granted.trust, 'unsigned')
    assert.equal(granted.loadEligible, false)
    assert.match(await readFile(join(workspaceRoot, '.codex', 'config.toml'), 'utf8'), /unsigned-mcp/)
    assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'unsigned-skill', 'SKILL.md')), true)
    const receipts = JSON.parse(await readFile(receiptStorePath, 'utf8')) as {
      plugins: Record<string, { classification?: unknown }>
    }
    assert.equal(receipts.plugins['registry-plugin']?.classification, 'unsigned')
  })
}

async function testUnsignedModuleBearingBundleHardBlocksEvenWithTrust(): Promise<void> {
  await withTempDir(async (temp) => {
    const signer = generateKeyPairSync('ed25519')
    const components: BundleComponents = {
      mcp: { path: 'mcp/server.json', id: 'unsigned-mcp' },
      module: { path: 'module', id: 'unsigned-module' },
    }
    const bundle = await writeBundle(temp, 'unsigned-module-plugin', components, signer, 1, { unsigned: true })
    const folders = new Map([[ 'unsigned-module-plugin', bundle.files ]])
    const { services, workspaceRoot, moduleRoot, receiptStorePath } = await createServices(
      temp,
      createGithubFetcher(folders),
      { trustedModules: new Map() }
    )
    const lifecycle = createMarketplacePluginLifecycleService(services)

    const result = await lifecycle.installFromRegistry({
      entry: bundle.entry,
      workspaceRoot,
      mcpSettings: { syncEnabled: false, servers: {} },
      mcpClients: ['codex'],
      trustGranted: true,
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.classification, 'unsigned')
    assert.match(result.message, /unsigned/i)
    assert.doesNotMatch(result.message, /requires trust approval/)
    assert.equal(existsSync(join(workspaceRoot, '.codex', 'config.toml')), false)
    assert.equal(existsSync(join(moduleRoot, 'unsigned-module')), false)
    assert.equal(existsSync(receiptStorePath), false)
  })
}

async function testUnsignedSkillsOnlyBundleRoutesThroughTrust(): Promise<void> {
  await withTempDir(async (temp) => {
    const signer = generateKeyPairSync('ed25519')
    // A skills-ONLY unsigned bundle (no mcp alongside): declarative, so it earns
    // the same trust-grant path as unsigned-mcp — blocked until trustGranted, then
    // staged load-ineligible. Guards the skills half of the mcp/skills split in
    // isolation (the combined case cannot prove skills alone routes correctly).
    const components: BundleComponents = {
      skills: { path: 'skills/unsigned-skill', name: 'unsigned-skill' },
    }
    const bundle = await writeBundle(temp, 'unsigned-skills-plugin', components, signer, 1, { unsigned: true })
    const folders = new Map([[ 'unsigned-skills-plugin', bundle.files ]])
    const { services, workspaceRoot, receiptStorePath } = await createServices(
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
      skillHarnesses: ['agents'],
    })
    assert.equal(blocked.ok, false)
    if (blocked.ok) return
    assert.equal(blocked.classification, 'unsigned')
    assert.match(blocked.message, /Unsigned marketplace plugin requires trust approval/)
    assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'unsigned-skill')), false)
    assert.equal(existsSync(receiptStorePath), false)

    const granted = await lifecycle.installFromRegistry({
      entry: bundle.entry,
      workspaceRoot,
      mcpSettings: { syncEnabled: false, servers: {} },
      mcpClients: ['codex'],
      skillHarnesses: ['agents'],
      trustGranted: true,
    })
    assert.equal(granted.ok, true, JSON.stringify(granted))
    if (!granted.ok) return
    assert.equal(granted.classification, 'unsigned')
    assert.equal(granted.trust, 'unsigned')
    assert.equal(granted.loadEligible, false)
    assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'unsigned-skill', 'SKILL.md')), true)
    const receipts = JSON.parse(await readFile(receiptStorePath, 'utf8')) as {
      plugins: Record<string, { classification?: unknown }>
    }
    assert.equal(receipts.plugins['registry-plugin']?.classification, 'unsigned')
  })
}

async function testUnsignedCliBearingBundleHardBlocksEvenWithTrust(): Promise<void> {
  await withTempDir(async (temp) => {
    const signer = generateKeyPairSync('ed25519')
    // CLI is the other code-bearing kind (alongside module): an unsigned bundle
    // carrying one is never trust-grantable, mirroring the unsigned-module block.
    const components: BundleComponents = {
      cli: { path: 'cli', id: 'unsigned-cli' },
    }
    const bundle = await writeBundle(temp, 'unsigned-cli-plugin', components, signer, 1, { unsigned: true })
    const folders = new Map([[ 'unsigned-cli-plugin', bundle.files ]])
    const { services, workspaceRoot, pluginRoot, receiptStorePath } = await createServices(
      temp,
      createGithubFetcher(folders),
      { trustedModules: new Map() }
    )
    const lifecycle = createMarketplacePluginLifecycleService(services)

    const result = await lifecycle.installFromRegistry({
      entry: bundle.entry,
      workspaceRoot,
      mcpSettings: { syncEnabled: false, servers: {} },
      mcpClients: ['codex'],
      trustGranted: true,
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.classification, 'unsigned')
    assert.match(result.message, /unsigned/i)
    assert.doesNotMatch(result.message, /requires trust approval/)
    assert.equal(existsSync(join(pluginRoot, 'unsigned-cli')), false)
    assert.equal(existsSync(receiptStorePath), false)
  })
}

async function testInlineMcpEntryRoutesThroughTrustAndSyncs(): Promise<void> {
  await withTempDir(async (temp) => {
    const { services, workspaceRoot, receiptStorePath } = await createServices(
      temp,
      createGithubFetcher(new Map()),
      { trustedModules: new Map() }
    )
    const lifecycle = createMarketplacePluginLifecycleService(services)
    const entry: MarketplacePluginEntry = {
      id: 'inline-mcp-plugin',
      name: 'Inline MCP Plugin',
      publisher: { name: 'Community Author', verified: false },
      summary: 'Inline MCP server config.',
      category: 'dev-tools',
      icon: 'icons/inline.svg',
      latest: 1,
      provides: ['mcp'],
      mcp: {
        servers: [
          {
            id: 'inline-mcp',
            name: 'inline-mcp',
            transport: 'stdio',
            command: 'node',
            args: ['-e', 'console.log("inline")'],
            clients: ['codex'],
            scope: 'workspace',
            source: 'custom',
            enabled: true,
            riskLevel: 'local-command',
          },
        ],
      },
    }

    const blocked = await lifecycle.installFromRegistry({
      entry,
      workspaceRoot,
      mcpSettings: { syncEnabled: false, servers: {} },
      mcpClients: ['codex'],
    })
    assert.equal(blocked.ok, false)
    if (blocked.ok) return
    assert.equal(blocked.classification, 'unsigned')
    assert.match(blocked.message, /Inline MCP marketplace entry requires trust approval/)
    assert.equal(existsSync(join(workspaceRoot, '.codex', 'config.toml')), false)
    assert.equal(existsSync(receiptStorePath), false)

    const granted = await lifecycle.installFromRegistry({
      entry,
      workspaceRoot,
      mcpSettings: { syncEnabled: false, servers: {} },
      mcpClients: ['codex'],
      trustGranted: true,
    })
    assert.equal(granted.ok, true, JSON.stringify(granted))
    if (!granted.ok) return
    assert.equal(granted.classification, 'unsigned')
    assert.equal(granted.trust, 'unsigned')
    assert.equal(granted.loadEligible, false)
    assert.equal(granted.updated, false)
    assert.match(await readFile(join(workspaceRoot, '.codex', 'config.toml'), 'utf8'), /inline-mcp/)
    const receipts = JSON.parse(await readFile(receiptStorePath, 'utf8')) as {
      plugins: Record<string, { classification?: unknown; components?: Array<{ kind?: unknown }> }>
    }
    assert.equal(receipts.plugins['inline-mcp-plugin']?.classification, 'unsigned')
    assert.equal(receipts.plugins['inline-mcp-plugin']?.components?.[0]?.kind, 'mcp')
  })
}

async function testDigestMismatchedRegistryInstallDoesNotFanOut(): Promise<void> {
  await withTempDir(async (temp) => {
    const signer = generateKeyPairSync('ed25519')
    const components: BundleComponents = { mcp: { path: 'mcp/server.json', id: 'tampered-mcp' } }
    const bundle = await writeBundle(temp, 'tampered-plugin', components, signer, 1)
    bundle.files.set(components.mcp!.path, `${JSON.stringify({ servers: [] }, null, 2)}\n`)
    const folders = new Map([[ 'tampered-plugin', bundle.files ]])
    const { services, workspaceRoot, receiptStorePath } = await createServices(
      temp,
      createGithubFetcher(folders),
      { trustedModules: new Map(), trustedKeyFingerprints: new Set([bundle.fingerprint]) }
    )
    const lifecycle = createMarketplacePluginLifecycleService(services)

    const result = await lifecycle.installFromRegistry({
      entry: bundle.entry,
      workspaceRoot,
      mcpSettings: { syncEnabled: false, servers: {} },
      mcpClients: ['codex'],
    })

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.classification, 'invalid')
    assert.match(result.message, /component digests/i)
    assert.equal(existsSync(join(workspaceRoot, '.codex', 'config.toml')), false)
    assert.equal(existsSync(receiptStorePath), false)
  })
}

async function testSkillPostInstallListingFailureRollsBackResidue(): Promise<void> {
  await withTempDir(async (temp) => {
    const signer = generateKeyPairSync('ed25519')
    const components: BundleComponents = {
      skills: { path: 'skills/registry-skill', name: 'registry-skill' },
    }
    const bundle = await writeBundle(temp, 'skill-plugin', components, signer, 1)
    const folders = new Map([[ 'skill-plugin', bundle.files ]])
    const { services, workspaceRoot, receiptStorePath } = await createServices(
      temp,
      createGithubFetcher(folders),
      { trustedModules: new Map(), trustedKeyFingerprints: new Set([bundle.fingerprint]) }
    )
    services.skillPackService = {
      ...services.skillPackService,
      listInstalled: async () => ({ ok: true, installed: [] }),
    }
    const lifecycle = createMarketplacePluginLifecycleService(services)

    const result = await lifecycle.installFromRegistry({
      entry: bundle.entry,
      workspaceRoot,
      mcpSettings: { syncEnabled: false, servers: {} },
      skillHarnesses: ['agents'],
    })

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.component, 'skills')
    assert.match(result.message, /was not found after install/)
    assert.deepEqual(result.installed?.map((component) => component.kind), ['skills'])
    assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'registry-skill')), false)
    assert.equal(existsSync(receiptStorePath), false)
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

async function testFailedUpdateRollsBackReplacementAndKeepsReceipt(): Promise<void> {
  await withTempDir(async (temp) => {
    const signer = generateKeyPairSync('ed25519')
    const v1 = await writeBundle(temp, 'plugin-v1', {
      mcp: { path: 'mcp/server.json', id: 'registry-mcp' },
      skills: { path: 'skills/registry-skill', name: 'registry-skill' },
      module: { path: 'module', id: 'registry-module' },
      cli: { path: 'cli', id: 'registry-cli' },
    }, signer, 1)
    const v2 = await writeBundle(temp, 'plugin-v2', {
      mcp: { path: 'mcp/server.json', id: 'registry-mcp' },
      skills: { path: 'skills/registry-skill', name: 'registry-skill' },
      module: { path: 'module', id: 'registry-module' },
      cli: { path: 'cli', id: 'registry-cli' },
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

    services.installPluginFolder = async (): Promise<InstallPluginResult> => ({
      ok: false,
      message: 'cli install exploded',
      issues: [{ path: '', message: 'cli install exploded' }],
    })

    const updated = await lifecycle.updateFromRegistry({
      entry: v2.entry,
      workspaceRoot,
      mcpSettings: installed.mcpSettings,
      mcpClients: ['codex'],
      skillHarnesses: ['agents'],
    })
    assert.equal(updated.ok, false)
    if (updated.ok) return
    assert.equal(updated.updated, true)
    assert.match(updated.message, /cli install exploded/)

    const codexConfig = await readFile(join(workspaceRoot, '.codex', 'config.toml'), 'utf8')
    assert.match(codexConfig, /registry-mcp/)
    assert.match(await readFile(join(workspaceRoot, '.agents', 'skills', 'registry-skill', 'SKILL.md'), 'utf8'), /registry-skill v1/)
    const moduleManifest = JSON.parse(await readFile(join(moduleRoot, 'registry-module', 'manifest.json'), 'utf8')) as { version?: unknown }
    assert.equal(moduleManifest.version, 1)
    const cliManifest = JSON.parse(await readFile(join(pluginRoot, 'registry-cli', 'plugin.json'), 'utf8')) as { version?: unknown }
    assert.equal(cliManifest.version, 1)

    const receipts = JSON.parse(await readFile(receiptStorePath, 'utf8')) as {
      plugins: Record<string, { version?: unknown }>
    }
    assert.equal(receipts.plugins['registry-plugin']?.version, 1)
  })
}

async function testReceiptStoreValidationRejectsMalformedAndUnsafeState(): Promise<void> {
  await withTempDir(async (temp) => {
    const { services, workspaceRoot, receiptStorePath, moduleRoot } = await createServices(
      temp,
      createGithubFetcher(new Map()),
      { trustedModules: new Map() }
    )
    const lifecycle = createMarketplacePluginLifecycleService(services)

    await mkdir(dirname(receiptStorePath), { recursive: true })
    await writeFile(receiptStorePath, '{ not json', 'utf8')
    const malformed = await lifecycle.uninstall({
      pluginId: 'registry-plugin',
      workspaceRoot,
      mcpSettings: { syncEnabled: false, servers: {} },
    })
    assert.equal(malformed.ok, false)
    assert.match(malformed.message, /receipt store is invalid/)

    const outsidePath = join(moduleRoot, '..', 'outside')
    await mkdir(outsidePath, { recursive: true })
    await writeFile(receiptStorePath, `${JSON.stringify({
      schemaVersion: 1,
      plugins: {
        'registry-plugin': {
          id: 'registry-plugin',
          displayName: 'Registry Plugin',
          version: 1,
          sourceUrl: 'https://example.test/registry-plugin',
          classification: 'verified',
          installedAt: new Date().toISOString(),
          components: [{ kind: 'module', id: '../outside' }],
        },
      },
    }, null, 2)}\n`, 'utf8')
    const unsafe = await lifecycle.uninstall({
      pluginId: 'registry-plugin',
      workspaceRoot,
      mcpSettings: { syncEnabled: false, servers: {} },
    })
    assert.equal(unsafe.ok, false)
    assert.match(unsafe.message, /components\[0\]\.id/)
    assert.equal(existsSync(outsidePath), true)
  })
}


// --- Claude Code plugin installs (bundled snapshot content) -----------------

const CLAUDE_SKILL_BODIES: Record<string, string> = {
  alpha: '---\nname: alpha\ndescription: First.\n---\n',
  beta: '---\nname: beta\ndescription: Second.\n---\n',
}

function claudeSkillDigest(body: string): { path: string; sha256: string; size: number } {
  return {
    path: 'SKILL.md',
    sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
    size: Buffer.byteLength(body, 'utf8'),
  }
}

const CLAUDE_LIFECYCLE_ENTRY: MarketplacePluginEntry = {
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
  skills: Object.entries(CLAUDE_SKILL_BODIES).map(([folder, body]) => {
    const files = [claudeSkillDigest(body)]
    return {
      name: folder,
      description: `The ${folder} skill.`,
      path: `skills/${folder}`,
      files,
      contentDigest: skillContentDigest(files),
    }
  }),
}

// Claude-plugin installs never touch the network — the whole flow reads the
// bundled catalogue payload. A fetch is a regression, so it throws.
function createClaudeLifecycleFetcher(): MarketplacePluginDownloadFetch {
  return (url) => Promise.reject(new Error(`unexpected network request during bundled install: ${url}`))
}

// Writes the packaged payload dir the catalogue generator would emit and
// returns the resolver the download resolves it through.
async function installClaudePayload(temp: string): Promise<(relativePath: string) => string | null> {
  const resourceDir = join(temp, 'packaged', 'skills', 'acme-skills')
  for (const [folder, body] of Object.entries(CLAUDE_SKILL_BODIES)) {
    await mkdir(join(resourceDir, folder), { recursive: true })
    await writeFile(join(resourceDir, folder, 'SKILL.md'), body, 'utf8')
  }
  return (relativePath) => (relativePath === 'skills/acme-skills' ? resourceDir : null)
}

async function testClaudePluginRequiresTrustGrant(): Promise<void> {
  await withTempDir(async (temp) => {
    const { services, workspaceRoot } = await createServices(temp, createClaudeLifecycleFetcher(), { trustedModules: new Map() })
    services.packagedResourceResolver = await installClaudePayload(temp)
    const lifecycle = createMarketplacePluginLifecycleService(services)
    const result = await lifecycle.installFromRegistry({ entry: CLAUDE_LIFECYCLE_ENTRY, workspaceRoot })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.classification, 'unsigned')
      assert.match(result.message, /trust approval/)
    }
    assert.equal(existsSync(join(workspaceRoot, '.claude', 'skills', 'alpha')), false)
  })
}

async function testClaudePluginInstallsSkillsIntoClaudeHarnessAndUninstalls(): Promise<void> {
  await withTempDir(async (temp) => {
    const { services, workspaceRoot, receiptStorePath } = await createServices(
      temp,
      createClaudeLifecycleFetcher(),
      { trustedModules: new Map() }
    )
    services.packagedResourceResolver = await installClaudePayload(temp)
    const lifecycle = createMarketplacePluginLifecycleService(services)
    const result = await lifecycle.installFromRegistry({
      entry: CLAUDE_LIFECYCLE_ENTRY,
      workspaceRoot,
      trustGranted: true,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    assert.equal(result.classification, 'unsigned')
    // With no resolveSkillHarnesses wired (these services), installs fall
    // back to the Claude harness dir only — never a silent no-op.
    assert.equal(
      await readFile(join(workspaceRoot, '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf8'),
      '---\nname: alpha\ndescription: First.\n---\n'
    )
    assert.equal(existsSync(join(workspaceRoot, '.claude', 'skills', 'beta', 'SKILL.md')), true)
    assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'alpha')), false)

    const store = JSON.parse(await readFile(receiptStorePath, 'utf8')) as {
      plugins: Record<string, { components: Array<{ kind: string; installedDirName?: string; harnesses?: string[] }> }>
    }
    const receipt = store.plugins['acme-skills']
    assert.ok(receipt, 'receipt written')
    assert.deepEqual(
      receipt.components.map((component) => `${component.kind}:${component.installedDirName}`),
      ['skills:alpha', 'skills:beta']
    )
    assert.deepEqual(receipt.components[0]!.harnesses, ['claude'])

    const removed = await lifecycle.uninstall({ pluginId: 'acme-skills', workspaceRoot })
    assert.equal(removed.ok, true, JSON.stringify(removed))
    assert.equal(existsSync(join(workspaceRoot, '.claude', 'skills', 'alpha')), false)
    assert.equal(existsSync(join(workspaceRoot, '.claude', 'skills', 'beta')), false)
  })
}


async function testClaudePluginDefaultFanOutUsesResolvedHarnesses(): Promise<void> {
  await withTempDir(async (temp) => {
    const { services, workspaceRoot, receiptStorePath } = await createServices(
      temp,
      createClaudeLifecycleFetcher(),
      { trustedModules: new Map() }
    )
    services.packagedResourceResolver = await installClaudePayload(temp)
    // The wired resolver (installed CLIs with native skill support + agents)
    // drives the default target set; the caller passes no skillHarnesses.
    services.resolveSkillHarnesses = () => Promise.resolve(['claude', 'codex', 'agents'])
    const lifecycle = createMarketplacePluginLifecycleService(services)
    const result = await lifecycle.installFromRegistry({
      entry: CLAUDE_LIFECYCLE_ENTRY,
      workspaceRoot,
      trustGranted: true,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    for (const dir of ['.claude', '.codex', '.agents']) {
      assert.equal(
        existsSync(join(workspaceRoot, dir, 'skills', 'alpha', 'SKILL.md')),
        true,
        `alpha lands in ${dir}`
      )
    }
    // No writes outside the resolved set.
    assert.equal(existsSync(join(workspaceRoot, '.cursor', 'skills', 'alpha')), false)

    const store = JSON.parse(await readFile(receiptStorePath, 'utf8')) as {
      plugins: Record<string, { components: Array<{ harnesses?: string[] }> }>
    }
    assert.deepEqual(store.plugins['acme-skills']!.components[0]!.harnesses, ['claude', 'codex', 'agents'])

    // Uninstall removes every harness copy the receipt recorded.
    const removed = await lifecycle.uninstall({ pluginId: 'acme-skills', workspaceRoot })
    assert.equal(removed.ok, true, JSON.stringify(removed))
    for (const dir of ['.claude', '.codex', '.agents']) {
      assert.equal(existsSync(join(workspaceRoot, dir, 'skills', 'alpha')), false, `alpha removed from ${dir}`)
    }
  })
}

async function testClaudePluginAutoResolveUpdateNeverDeletesOnProbeHiccup(): Promise<void> {
  await withTempDir(async (temp) => {
    const { services, workspaceRoot } = await createServices(temp, createClaudeLifecycleFetcher(), { trustedModules: new Map() })
    services.packagedResourceResolver = await installClaudePayload(temp)
    // First auto-resolved install lands claude+codex+agents.
    services.resolveSkillHarnesses = () => Promise.resolve(['claude', 'codex', 'agents'])
    const lifecycle = createMarketplacePluginLifecycleService(services)
    const first = await lifecycle.installFromRegistry({ entry: CLAUDE_LIFECYCLE_ENTRY, workspaceRoot, trustGranted: true })
    assert.equal(first.ok, true, JSON.stringify(first))
    for (const dir of ['.claude', '.codex', '.agents']) {
      assert.equal(existsSync(join(workspaceRoot, dir, 'skills', 'alpha')), true, `alpha in ${dir} after first install`)
    }

    // Update while the codex probe transiently reports not-installed: the
    // resolved set narrows to claude+agents. Auto-resolution must NOT delete
    // the still-wanted .codex copies — union with the prior receipt keeps them.
    services.resolveSkillHarnesses = () => Promise.resolve(['claude', 'agents'])
    const update = await lifecycle.installFromRegistry({ entry: CLAUDE_LIFECYCLE_ENTRY, workspaceRoot, trustGranted: true })
    assert.equal(update.ok, true, JSON.stringify(update))
    for (const dir of ['.claude', '.codex', '.agents']) {
      assert.equal(existsSync(join(workspaceRoot, dir, 'skills', 'alpha')), true, `alpha preserved in ${dir} after probe hiccup`)
    }
  })
}

async function testClaudePluginExplicitHarnessNarrowingStillRemoves(): Promise<void> {
  await withTempDir(async (temp) => {
    const { services, workspaceRoot } = await createServices(temp, createClaudeLifecycleFetcher(), { trustedModules: new Map() })
    services.packagedResourceResolver = await installClaudePayload(temp)
    const lifecycle = createMarketplacePluginLifecycleService(services)
    const first = await lifecycle.installFromRegistry({
      entry: CLAUDE_LIFECYCLE_ENTRY, workspaceRoot, trustGranted: true, skillHarnesses: ['claude', 'codex', 'agents'],
    })
    assert.equal(first.ok, true, JSON.stringify(first))
    // An EXPLICIT narrowing is a deliberate intent — the .codex copies go.
    const update = await lifecycle.installFromRegistry({
      entry: CLAUDE_LIFECYCLE_ENTRY, workspaceRoot, trustGranted: true, skillHarnesses: ['claude'],
    })
    assert.equal(update.ok, true, JSON.stringify(update))
    assert.equal(existsSync(join(workspaceRoot, '.claude', 'skills', 'alpha')), true)
    assert.equal(existsSync(join(workspaceRoot, '.codex', 'skills', 'alpha')), false)
    assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'alpha')), false)
  })
}

async function testClaudePluginResolverFailureFallsBackToClaude(): Promise<void> {
  await withTempDir(async (temp) => {
    const { services, workspaceRoot } = await createServices(temp, createClaudeLifecycleFetcher(), { trustedModules: new Map() })
    services.packagedResourceResolver = await installClaudePayload(temp)
    services.resolveSkillHarnesses = () => Promise.reject(new Error('probe blew up'))
    const lifecycle = createMarketplacePluginLifecycleService(services)
    const result = await lifecycle.installFromRegistry({
      entry: CLAUDE_LIFECYCLE_ENTRY,
      workspaceRoot,
      trustGranted: true,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(existsSync(join(workspaceRoot, '.claude', 'skills', 'alpha')), true)
    assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'alpha')), false)
  })

  await withTempDir(async (temp) => {
    const { services, workspaceRoot } = await createServices(temp, createClaudeLifecycleFetcher(), { trustedModules: new Map() })
    services.packagedResourceResolver = await installClaudePayload(temp)
    // An empty resolved set must not install nowhere while claiming success.
    services.resolveSkillHarnesses = () => Promise.resolve([])
    const lifecycle = createMarketplacePluginLifecycleService(services)
    const result = await lifecycle.installFromRegistry({
      entry: CLAUDE_LIFECYCLE_ENTRY,
      workspaceRoot,
      trustGranted: true,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(existsSync(join(workspaceRoot, '.claude', 'skills', 'alpha')), true)
  })
}

async function testClaudePluginHarnessChangeRemovesOrphanedCopies(): Promise<void> {
  await withTempDir(async (temp) => {
    const { services, workspaceRoot } = await createServices(temp, createClaudeLifecycleFetcher(), { trustedModules: new Map() })
    services.packagedResourceResolver = await installClaudePayload(temp)
    const lifecycle = createMarketplacePluginLifecycleService(services)
    // First install targets claude + agents.
    const first = await lifecycle.installFromRegistry({
      entry: CLAUDE_LIFECYCLE_ENTRY,
      workspaceRoot,
      trustGranted: true,
      skillHarnesses: ['claude', 'agents'],
    })
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'alpha')), true)
    // Update narrows to claude only: the .agents copies must be removed, not
    // stranded untracked (componentsOverlap keys skills on dir name alone).
    const second = await lifecycle.installFromRegistry({
      entry: CLAUDE_LIFECYCLE_ENTRY,
      workspaceRoot,
      trustGranted: true,
      skillHarnesses: ['claude'],
    })
    assert.equal(second.ok, true, JSON.stringify(second))
    assert.equal(existsSync(join(workspaceRoot, '.claude', 'skills', 'alpha')), true)
    assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'alpha')), false)
    assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'beta')), false)
  })
}

async function testClaudePluginRefusesForeignSkillDirCollision(): Promise<void> {
  await withTempDir(async (temp) => {
    const { services, workspaceRoot } = await createServices(temp, createClaudeLifecycleFetcher(), { trustedModules: new Map() })
    services.packagedResourceResolver = await installClaudePayload(temp)
    // A hand-dropped skill dir this plugin does not own.
    await mkdir(join(workspaceRoot, '.claude', 'skills', 'alpha'), { recursive: true })
    await writeFile(join(workspaceRoot, '.claude', 'skills', 'alpha', 'SKILL.md'), 'mine, not yours', 'utf8')
    const lifecycle = createMarketplacePluginLifecycleService(services)
    const result = await lifecycle.installFromRegistry({
      entry: CLAUDE_LIFECYCLE_ENTRY,
      workspaceRoot,
      trustGranted: true,
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.message, /already exists/)
    // The pre-flight refusal copies nothing and never clobbers the existing dir.
    assert.equal(await readFile(join(workspaceRoot, '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf8'), 'mine, not yours')
    assert.equal(existsSync(join(workspaceRoot, '.claude', 'skills', 'beta')), false)
  })
}

async function main(): Promise<void> {
  await testVerifiedRegistryInstallFansOutAndRecordsReceipt()
  await testCommunityBundleRequiresTrustGrant()
  await testUnsignedMcpSkillsBundleRoutesThroughTrust()
  await testUnsignedSkillsOnlyBundleRoutesThroughTrust()
  await testUnsignedModuleBearingBundleHardBlocksEvenWithTrust()
  await testUnsignedCliBearingBundleHardBlocksEvenWithTrust()
  await testInlineMcpEntryRoutesThroughTrustAndSyncs()
  await testDigestMismatchedRegistryInstallDoesNotFanOut()
  await testSkillPostInstallListingFailureRollsBackResidue()
  await testUpdateAndUninstallRemoveOldComponents()
  await testFailedUpdateRollsBackReplacementAndKeepsReceipt()
  await testReceiptStoreValidationRejectsMalformedAndUnsafeState()
  await testClaudePluginRequiresTrustGrant()
  await testClaudePluginInstallsSkillsIntoClaudeHarnessAndUninstalls()
  await testClaudePluginDefaultFanOutUsesResolvedHarnesses()
  await testClaudePluginAutoResolveUpdateNeverDeletesOnProbeHiccup()
  await testClaudePluginExplicitHarnessNarrowingStillRemoves()
  await testClaudePluginResolverFailureFallsBackToClaude()
  await testClaudePluginRefusesForeignSkillDirCollision()
  await testClaudePluginHarnessChangeRemovesOrphanedCopies()
  console.log('marketplace plugin lifecycle tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
