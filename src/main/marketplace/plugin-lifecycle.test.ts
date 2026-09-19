import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { IpcMain } from 'electron'

import type { McpSettings } from '../../shared/electron-api'
import type { MarketplacePluginEntry, MarketplacePluginManifest } from '../../shared/marketplace'
import { canonicalManifestPayload, validateMarketplacePluginManifest } from '../../shared/marketplace'
import {
  canonicalManifestPayload as canonicalModulePayload,
  validateThirdPartyModuleManifest,
} from '../../shared/modules/third-party-manifest'
import type { PluginManifest, PluginMcpConfigFormat } from '../../shared/plugin-manifest'
import { createDefinitionWriteCore } from '../automations/definition-write'
import { allowAutomationProvider, createBuiltInAutomationProviderRegistry } from '../automations/provider-registry'
import { AutomationsStore } from '../automations/store'
import { createMcpConfigService, type PluginLookup } from '../mcp-config-service'
import type { MarketplaceAutomationInstaller } from '../modules/plugin-bundle-installer'
import { loadMainModules } from '../module-host/load-modules'
import { classifyModuleTrust, verifyModuleSignature, type ModuleTrustContext } from '../modules/module-signature'
import { planThirdPartyMainModules } from '../modules/third-party-main-loader'
import { readTrustedModulesSync, setModuleTrust } from '../modules/trust-store'
import { discoverUserModules } from '../modules/user-module-registry'
import type { InstallPluginResult } from '../plugin-install'
import {
  createMarketplacePluginLifecycleService,
  readMarketplacePluginInstallReceipts,
  type MarketplacePluginLifecycleServices,
} from './plugin-lifecycle'
import { MarketplaceRegistryClient, configuredMarketplaceRegistryUrl } from './registry-client'
import { skillContentDigest } from './skill-content'
import { readMarketplaceUpdateStates } from './update-detection'
import type { MarketplacePluginDownloadFetch } from './plugin-download'
import { test } from 'vitest'

test('plugin-lifecycle', async () => {
  type BundleComponents = {
    mcp?: { path: string; id: string }
    skills?: { path: string; name: string }
    module?: { path: string; id: string }
    cli?: { path: string; id: string }
    automation?: { path: string; name: string }
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
    files: Map<string, string>,
  ): MarketplacePluginManifest['components'] {
    return Object.fromEntries(
      Object.entries(components).map(([kind, component]) => {
        const componentFiles = Array.from(files.entries())
          .filter(([path]) => path === component.path || path.startsWith(`${component.path}/`))
          .map(([path, source]) => ({ path, sha256: sha256Hex(source) }))
          .sort((a, b) => a.path.localeCompare(b.path))
        return [kind, { path: component.path, files: componentFiles }]
      }),
    ) as MarketplacePluginManifest['components']
  }

  function signedPluginManifest(
    components: BundleComponents,
    files: Map<string, string>,
    signer: Signer,
    version: number,
    overrides: Record<string, unknown> = {},
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
    options: { unsigned?: boolean } = {},
  ): Promise<{
    files: Map<string, string>
    entry: MarketplacePluginEntry
    fingerprint: string
  }> {
    const bundleRoot = join(root, folder)
    const files = new Map<string, string>()
    if (components.mcp) {
      files.set(
        components.mcp.path,
        `${JSON.stringify(
          {
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
          },
          null,
          2,
        )}\n`,
      )
    }

    if (components.skills) {
      files.set(
        `${components.skills.path}/SKILL.md`,
        `---\nname: ${components.skills.name}\ndescription: ${components.skills.name} v${version}.\n---\n`,
      )
    }
    if (components.module) {
      files.set(
        `${components.module.path}/manifest.json`,
        `${JSON.stringify(signedModuleManifest(components.module.id, signer, version), null, 2)}\n`,
      )
      files.set(`${components.module.path}/main.cjs`, 'exports.registerMain = () => {}\n')
    }
    if (components.cli) {
      files.set(
        `${components.cli.path}/plugin.json`,
        `${JSON.stringify(
          {
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
          },
          null,
          2,
        )}\n`,
      )
    }

    if (components.automation) {
      files.set(
        components.automation.path,
        `${JSON.stringify(
          {
            name: components.automation.name,
            status: 'enabled',
            trigger: {
              kind: 'schedule',
              config: { kind: 'schedule', cadence: { type: 'daily', timeLocal: '03:00' }, timezone: 'UTC' },
            },
            action: { kind: 'spawn-agent', config: { prompt: 'Check for outdated dependencies.' } },
          },
          null,
          2,
        )}\n`,
      )
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
        publisher: { name: 'SprintEngine Labs', verified: !options.unsigned },
        summary: 'Registry plugin.',
        category: 'dev-tools',
        icon: 'icons/registry.svg',
        latest: signed.version,
        source: `https://github.com/sprintengine/studio-releases/tree/main/plugins/${folder}`,
        provides: Object.keys(components) as MarketplacePluginEntry['provides'],
        ...(options.unsigned ? {} : { signature }),
      },
    }
  }

  function createGithubFetcher(folders: Map<string, Map<string, string>>): MarketplacePluginDownloadFetch {
    return async (url) => {
      const github = url.match(
        /^https:\/\/api\.github\.com\/repos\/sprintengine\/studio-releases\/contents\/plugins\/([^?]+)\?ref=main$/,
      )
      if (github) {
        const folder = github[1]!
        const files = folders.get(folder)
        if (!files) return new Response('not found', { status: 404 })
        return new Response(
          JSON.stringify(
            Array.from(files.keys()).map((path) => ({
              type: 'file',
              path: `plugins/${folder}/${path}`,
              download_url: `https://raw.githubusercontent.com/sprintengine/studio-releases/main/${folder}/${path}`,
            })),
          ),
        )
      }
      const raw = url.match(
        /^https:\/\/raw\.githubusercontent\.com\/sprintengine\/studio-releases\/main\/([^/]+)\/(.+)$/,
      )
      if (raw) {
        const files = folders.get(raw[1]!)
        const body = files?.get(raw[2]!)
        if (body === undefined) return new Response('not found', { status: 404 })
        return new Response(body)
      }
      return new Response('not found', { status: 404 })
    }
  }

  async function createServices(
    temp: string,
    fetcher: MarketplacePluginDownloadFetch,
    trustContext: ModuleTrustContext,
  ): Promise<{
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
    const lookupPlugin: PluginLookup = (id) =>
      id === 'codex' ? { manifest: mcpPluginManifest(id, 'codex') } : undefined
    return {
      workspaceRoot,
      moduleRoot,
      pluginRoot,
      receiptStorePath,
      services: {
        mcpConfigService: createMcpConfigService({ lookupPlugin, homeDir: () => join(temp, 'home') }),
        trustContext: () => trustContext,
        moduleRoot: () => moduleRoot,
        pluginRoot: () => pluginRoot,
        reloadPlugins: () => undefined,
        installAutomationDefinition: automationInstaller(),
        receiptStorePath,
        stagingRoot: join(temp, 'staging'),
        fetcher,
      },
    }
  }

  // The real automations write path against a real per-project store, so the
  // receipt and uninstall assertions below are about a definition that exists.
  function automationInstaller(): MarketplaceAutomationInstaller {
    const registry = createBuiltInAutomationProviderRegistry()
    const core = createDefinitionWriteCore({
      createStore: (workspaceRoot) => new AutomationsStore(workspaceRoot),
      getTriggerProviderRegistrations: () => registry.listTriggerProviderRegistrations(),
      getActionProviderRegistrations: () => registry.listActionProviderRegistrations(),
      checkProviderPermission: allowAutomationProvider,
      now: () => Date.parse('2026-07-30T12:00:00.000Z'),
    })
    return async (input) => {
      const result = await core.installFromCatalogue(input.workspaceRoot, {
        payload: input.definition,
        sourceCatalogueId: input.sourceCatalogueId,
        ...(input.sourcePublisher ? { sourcePublisher: input.sourcePublisher } : {}),
      })
      if (!result.ok) return result
      return { ok: true, value: result.value }
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
      const folders = new Map([['verified-plugin', bundle.files]])
      const { services, workspaceRoot, moduleRoot, pluginRoot, receiptStorePath } = await createServices(
        temp,
        createGithubFetcher(folders),
        { trustedModules: new Map(), trustedKeyFingerprints: new Set([bundle.fingerprint]) },
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
      const folders = new Map([['community-plugin', bundle.files]])
      const { services, workspaceRoot } = await createServices(temp, createGithubFetcher(folders), {
        trustedModules: new Map(),
      })
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
      const folders = new Map([['unsigned-plugin', bundle.files]])
      const { services, workspaceRoot, receiptStorePath } = await createServices(temp, createGithubFetcher(folders), {
        trustedModules: new Map(),
      })
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
      const folders = new Map([['unsigned-module-plugin', bundle.files]])
      const { services, workspaceRoot, moduleRoot, receiptStorePath } = await createServices(
        temp,
        createGithubFetcher(folders),
        { trustedModules: new Map() },
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
      const folders = new Map([['unsigned-skills-plugin', bundle.files]])
      const { services, workspaceRoot, receiptStorePath } = await createServices(temp, createGithubFetcher(folders), {
        trustedModules: new Map(),
      })
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
      const folders = new Map([['unsigned-cli-plugin', bundle.files]])
      const { services, workspaceRoot, pluginRoot, receiptStorePath } = await createServices(
        temp,
        createGithubFetcher(folders),
        { trustedModules: new Map() },
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
      const { services, workspaceRoot, receiptStorePath } = await createServices(temp, createGithubFetcher(new Map()), {
        trustedModules: new Map(),
      })
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
      const folders = new Map([['tampered-plugin', bundle.files]])
      const { services, workspaceRoot, receiptStorePath } = await createServices(temp, createGithubFetcher(folders), {
        trustedModules: new Map(),
        trustedKeyFingerprints: new Set([bundle.fingerprint]),
      })
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

  async function testSkillInstallFailureRollsBackResidue(): Promise<void> {
    await withTempDir(async (temp) => {
      const signer = generateKeyPairSync('ed25519')
      const components: BundleComponents = {
        skills: { path: 'skills/registry-skill', name: 'registry-skill' },
      }
      const bundle = await writeBundle(temp, 'skill-plugin', components, signer, 1)
      const folders = new Map([['skill-plugin', bundle.files]])
      const { services, workspaceRoot, receiptStorePath } = await createServices(temp, createGithubFetcher(folders), {
        trustedModules: new Map(),
        trustedKeyFingerprints: new Set([bundle.fingerprint]),
      })
      // A real, deterministic install failure: the harness skill directory is a
      // file, so nothing can be written under it.
      await mkdir(join(workspaceRoot, '.agents'), { recursive: true })
      await writeFile(join(workspaceRoot, '.agents', 'skills'), 'not a directory', 'utf8')
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
      assert.deepEqual(result.installed ?? [], [])
      assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'registry-skill')), false)
      assert.equal(existsSync(receiptStorePath), false)
    })
  }

  async function testUpdateAndUninstallRemoveOldComponents(): Promise<void> {
    await withTempDir(async (temp) => {
      const signer = generateKeyPairSync('ed25519')
      const v1 = await writeBundle(
        temp,
        'plugin-v1',
        {
          mcp: { path: 'mcp/server.json', id: 'registry-mcp-v1' },
          skills: { path: 'skills/registry-skill-v1', name: 'registry-skill-v1' },
          module: { path: 'module', id: 'registry-module-v1' },
          cli: { path: 'cli', id: 'registry-cli-v1' },
        },
        signer,
        1,
      )
      const v2 = await writeBundle(
        temp,
        'plugin-v2',
        {
          mcp: { path: 'mcp/server.json', id: 'registry-mcp-v2' },
          skills: { path: 'skills/registry-skill-v2', name: 'registry-skill-v2' },
          module: { path: 'module', id: 'registry-module-v2' },
          cli: { path: 'cli', id: 'registry-cli-v2' },
        },
        signer,
        2,
      )
      const folders = new Map([
        ['plugin-v1', v1.files],
        ['plugin-v2', v2.files],
      ])
      const { services, workspaceRoot, moduleRoot, pluginRoot, receiptStorePath } = await createServices(
        temp,
        createGithubFetcher(folders),
        { trustedModules: new Map(), trustedKeyFingerprints: new Set([v1.fingerprint, v2.fingerprint]) },
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

  async function testAutomationInstallRecordsReceiptAndSurvivesUninstall(): Promise<void> {
    await withTempDir(async (temp) => {
      const signer = generateKeyPairSync('ed25519')
      const bundle = await writeBundle(
        temp,
        'automation-plugin',
        {
          skills: { path: 'skills/sweep-skill', name: 'sweep-skill' },
          automation: { path: 'automation/automation.json', name: 'Nightly dependency sweep' },
        },
        signer,
        1,
      )
      const folders = new Map([['automation-plugin', bundle.files]])
      const { services, workspaceRoot, receiptStorePath } = await createServices(temp, createGithubFetcher(folders), {
        trustedModules: new Map(),
        trustedKeyFingerprints: new Set([bundle.fingerprint]),
      })
      const lifecycle = createMarketplacePluginLifecycleService(services)

      const installed = await lifecycle.installFromRegistry({
        entry: bundle.entry,
        workspaceRoot,
        mcpSettings: { syncEnabled: false, servers: {} },
        skillHarnesses: ['agents'],
        automationDefaultCli: 'claude-code',
      })

      assert.equal(installed.ok, true, JSON.stringify(installed))
      if (!installed.ok) return
      assert.deepEqual(
        installed.installed.map((component) => component.kind),
        ['skills', 'automation'],
      )

      const definitions = await new AutomationsStore(workspaceRoot).listDefinitions()
      assert.equal(definitions.ok, true)
      if (!definitions.ok) return
      assert.equal(definitions.values.length, 1)
      const automationId = definitions.values[0].id

      const receipts = JSON.parse(await readFile(receiptStorePath, 'utf8')) as {
        plugins: Record<string, { components: Array<{ kind: string; id: string }> }>
      }
      const receiptComponents = receipts.plugins['registry-plugin']?.components ?? []
      const automationReceipt = receiptComponents.find((component) => component.kind === 'automation')
      assert.equal(
        automationReceipt?.id,
        automationId,
        'the receipt carries the automation kind and the store-issued id it created',
      )

      const uninstalled = await lifecycle.uninstall({
        pluginId: 'registry-plugin',
        workspaceRoot,
        skillHarnesses: ['agents'],
      })
      assert.equal(uninstalled.ok, true, JSON.stringify(uninstalled))
      assert.equal(
        existsSync(join(workspaceRoot, '.agents', 'skills', 'sweep-skill')),
        false,
        'the skill copy is removed',
      )

      // Owner ruling: an added automation is the user's. Uninstalling the plugin
      // that shipped its starter must not silently delete a scheduled job that
      // touches their repo.
      const afterUninstall = await new AutomationsStore(workspaceRoot).listDefinitions()
      assert.equal(afterUninstall.ok, true)
      if (!afterUninstall.ok) return
      assert.deepEqual(
        afterUninstall.values.map((definition) => definition.id),
        [automationId],
      )
    })
  }

  async function testFailedUpdateRollsBackReplacementAndKeepsReceipt(): Promise<void> {
    await withTempDir(async (temp) => {
      const signer = generateKeyPairSync('ed25519')
      const v1 = await writeBundle(
        temp,
        'plugin-v1',
        {
          mcp: { path: 'mcp/server.json', id: 'registry-mcp' },
          skills: { path: 'skills/registry-skill', name: 'registry-skill' },
          module: { path: 'module', id: 'registry-module' },
          cli: { path: 'cli', id: 'registry-cli' },
        },
        signer,
        1,
      )
      const v2 = await writeBundle(
        temp,
        'plugin-v2',
        {
          mcp: { path: 'mcp/server.json', id: 'registry-mcp' },
          skills: { path: 'skills/registry-skill', name: 'registry-skill' },
          module: { path: 'module', id: 'registry-module' },
          cli: { path: 'cli', id: 'registry-cli' },
        },
        signer,
        2,
      )
      const folders = new Map([
        ['plugin-v1', v1.files],
        ['plugin-v2', v2.files],
      ])
      const { services, workspaceRoot, moduleRoot, pluginRoot, receiptStorePath } = await createServices(
        temp,
        createGithubFetcher(folders),
        { trustedModules: new Map(), trustedKeyFingerprints: new Set([v1.fingerprint, v2.fingerprint]) },
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
      assert.match(
        await readFile(join(workspaceRoot, '.agents', 'skills', 'registry-skill', 'SKILL.md'), 'utf8'),
        /registry-skill v1/,
      )
      const moduleManifest = JSON.parse(
        await readFile(join(moduleRoot, 'registry-module', 'manifest.json'), 'utf8'),
      ) as {
        version?: unknown
      }
      assert.equal(moduleManifest.version, 1)
      const cliManifest = JSON.parse(await readFile(join(pluginRoot, 'registry-cli', 'plugin.json'), 'utf8')) as {
        version?: unknown
      }
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
        { trustedModules: new Map() },
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
      await writeFile(
        receiptStorePath,
        `${JSON.stringify(
          {
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
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
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
      const { services, workspaceRoot } = await createServices(temp, createClaudeLifecycleFetcher(), {
        trustedModules: new Map(),
      })
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
      const { services, workspaceRoot, receiptStorePath } = await createServices(temp, createClaudeLifecycleFetcher(), {
        trustedModules: new Map(),
      })
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
        '---\nname: alpha\ndescription: First.\n---\n',
      )
      assert.equal(existsSync(join(workspaceRoot, '.claude', 'skills', 'beta', 'SKILL.md')), true)
      assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'alpha')), false)

      const store = JSON.parse(await readFile(receiptStorePath, 'utf8')) as {
        plugins: Record<
          string,
          { components: Array<{ kind: string; installedDirName?: string; harnesses?: string[] }> }
        >
      }
      const receipt = store.plugins['acme-skills']
      assert.ok(receipt, 'receipt written')
      assert.deepEqual(
        receipt.components.map((component) => `${component.kind}:${component.installedDirName}`),
        ['skills:alpha', 'skills:beta'],
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
      const { services, workspaceRoot, receiptStorePath } = await createServices(temp, createClaudeLifecycleFetcher(), {
        trustedModules: new Map(),
      })
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
        assert.equal(existsSync(join(workspaceRoot, dir, 'skills', 'alpha', 'SKILL.md')), true, `alpha lands in ${dir}`)
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
      const { services, workspaceRoot } = await createServices(temp, createClaudeLifecycleFetcher(), {
        trustedModules: new Map(),
      })
      services.packagedResourceResolver = await installClaudePayload(temp)
      // First auto-resolved install lands claude+codex+agents.
      services.resolveSkillHarnesses = () => Promise.resolve(['claude', 'codex', 'agents'])
      const lifecycle = createMarketplacePluginLifecycleService(services)
      const first = await lifecycle.installFromRegistry({
        entry: CLAUDE_LIFECYCLE_ENTRY,
        workspaceRoot,
        trustGranted: true,
      })
      assert.equal(first.ok, true, JSON.stringify(first))
      for (const dir of ['.claude', '.codex', '.agents']) {
        assert.equal(
          existsSync(join(workspaceRoot, dir, 'skills', 'alpha')),
          true,
          `alpha in ${dir} after first install`,
        )
      }

      // Update while the codex probe transiently reports not-installed: the
      // resolved set narrows to claude+agents. Auto-resolution must NOT delete
      // the still-wanted .codex copies — union with the prior receipt keeps them.
      services.resolveSkillHarnesses = () => Promise.resolve(['claude', 'agents'])
      const update = await lifecycle.installFromRegistry({
        entry: CLAUDE_LIFECYCLE_ENTRY,
        workspaceRoot,
        trustGranted: true,
      })
      assert.equal(update.ok, true, JSON.stringify(update))
      for (const dir of ['.claude', '.codex', '.agents']) {
        assert.equal(
          existsSync(join(workspaceRoot, dir, 'skills', 'alpha')),
          true,
          `alpha preserved in ${dir} after probe hiccup`,
        )
      }
    })
  }

  async function testClaudePluginExplicitHarnessNarrowingStillRemoves(): Promise<void> {
    await withTempDir(async (temp) => {
      const { services, workspaceRoot } = await createServices(temp, createClaudeLifecycleFetcher(), {
        trustedModules: new Map(),
      })
      services.packagedResourceResolver = await installClaudePayload(temp)
      const lifecycle = createMarketplacePluginLifecycleService(services)
      const first = await lifecycle.installFromRegistry({
        entry: CLAUDE_LIFECYCLE_ENTRY,
        workspaceRoot,
        trustGranted: true,
        skillHarnesses: ['claude', 'codex', 'agents'],
      })
      assert.equal(first.ok, true, JSON.stringify(first))
      // An EXPLICIT narrowing is a deliberate intent — the .codex copies go.
      const update = await lifecycle.installFromRegistry({
        entry: CLAUDE_LIFECYCLE_ENTRY,
        workspaceRoot,
        trustGranted: true,
        skillHarnesses: ['claude'],
      })
      assert.equal(update.ok, true, JSON.stringify(update))
      assert.equal(existsSync(join(workspaceRoot, '.claude', 'skills', 'alpha')), true)
      assert.equal(existsSync(join(workspaceRoot, '.codex', 'skills', 'alpha')), false)
      assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'alpha')), false)
    })
  }

  async function testClaudePluginResolverFailureFallsBackToClaude(): Promise<void> {
    await withTempDir(async (temp) => {
      const { services, workspaceRoot } = await createServices(temp, createClaudeLifecycleFetcher(), {
        trustedModules: new Map(),
      })
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
      const { services, workspaceRoot } = await createServices(temp, createClaudeLifecycleFetcher(), {
        trustedModules: new Map(),
      })
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
      const { services, workspaceRoot } = await createServices(temp, createClaudeLifecycleFetcher(), {
        trustedModules: new Map(),
      })
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
      const { services, workspaceRoot } = await createServices(temp, createClaudeLifecycleFetcher(), {
        trustedModules: new Map(),
      })
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
      assert.equal(
        await readFile(join(workspaceRoot, '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf8'),
        'mine, not yours',
      )
      assert.equal(existsSync(join(workspaceRoot, '.claude', 'skills', 'beta')), false)
    })
  }

  // With the registry override serving latest=2 over an installed v1,
  // the update state reads update-available, the update runs through
  // updateFromRegistry, and the state settles to current in the same process —
  // no restart.
  async function testUpdateAvailabilitySettlesThroughRegistryUpdate(): Promise<void> {
    await withTempDir(async (temp) => {
      const signer = generateKeyPairSync('ed25519')
      const components: BundleComponents = { module: { path: 'module', id: 'update-module' } }
      const bundleV1 = await writeBundle(temp, 'update-plugin-v1', components, signer, 1)
      const bundleV2 = await writeBundle(temp, 'update-plugin-v2', components, signer, 2)
      const folders = new Map([
        ['update-plugin-v1', bundleV1.files],
        ['update-plugin-v2', bundleV2.files],
      ])
      const { services, workspaceRoot, moduleRoot, receiptStorePath } = await createServices(
        temp,
        createGithubFetcher(folders),
        { trustedModules: new Map(), trustedKeyFingerprints: new Set([bundleV1.fingerprint]) },
      )
      const lifecycle = createMarketplacePluginLifecycleService(services)

      const installed = await lifecycle.installFromRegistry({ entry: bundleV1.entry, workspaceRoot })
      assert.equal(installed.ok, true, JSON.stringify(installed))

      // The registry override env var is the fixture seam: the client reads the
      // configured URL, which serves an index whose latest is 2.
      const registryUrl = configuredMarketplaceRegistryUrl({
        SPRINTENGINE_MARKETPLACE_REGISTRY_URL: 'https://registry.test/marketplace.json',
      } as unknown as NodeJS.ProcessEnv)
      assert.equal(registryUrl, 'https://registry.test/marketplace.json')
      const registryReader = new MarketplaceRegistryClient({
        registryUrl,
        cachePath: join(temp, 'registry-cache.json'),
        usePackagedSeedFallback: false,
        fetcher: async (url) =>
          url === registryUrl
            ? new Response(JSON.stringify({ schemaVersion: 1, plugins: [bundleV2.entry] }))
            : new Response('not found', { status: 404 }),
      })
      const updateStateServices = {
        registryReader,
        receiptStorePath,
        moduleRoot: () => moduleRoot,
        trustContext: services.trustContext,
      }

      const before = await readMarketplaceUpdateStates(updateStateServices)
      assert.equal(before.ok && before.checked, true)
      if (!before.ok || !before.checked) return
      assert.deepEqual(before.entries, [
        {
          id: 'registry-plugin',
          displayName: 'Registry Plugin',
          availability: { state: 'update-available', installedVersion: 1, latestVersion: 2 },
        },
      ])

      const updated = await lifecycle.updateFromRegistry({ entry: bundleV2.entry, workspaceRoot })
      assert.equal(updated.ok, true, JSON.stringify(updated))
      if (!updated.ok) return
      assert.equal(updated.updated, true)

      const after = await readMarketplaceUpdateStates(updateStateServices)
      assert.equal(after.ok && after.checked, true)
      if (!after.ok || !after.checked) return
      assert.deepEqual(after.entries[0]?.availability, { state: 'current', installedVersion: 2, latestVersion: 2 })
    })
  }

  function corruptSignature(signature: { algorithm: 'ed25519'; publicKey: string; signature: string }): {
    algorithm: 'ed25519'
    publicKey: string
    signature: string
  } {
    const flipped = signature.signature.startsWith('A') ? 'B' : 'A'
    return { ...signature, signature: flipped + signature.signature.slice(1) }
  }

  // Update security, part 1: an update whose signature no longer verifies
  // is blocked with the existing invalid-signature treatment, and the previous
  // install stays untouched.
  async function testUpdateWithInvalidSignatureIsBlocked(): Promise<void> {
    await withTempDir(async (temp) => {
      const signer = generateKeyPairSync('ed25519')
      const components: BundleComponents = { module: { path: 'module', id: 'update-module' } }
      const bundleV1 = await writeBundle(temp, 'tamper-plugin-v1', components, signer, 1)
      const bundleV2 = await writeBundle(temp, 'tamper-plugin-v2', components, signer, 2)
      // The served v2 bundle and its registry entry carry a signature that no
      // longer verifies over the manifest payload.
      const manifest = JSON.parse(bundleV2.files.get('plugin.json')!) as {
        signature: Parameters<typeof corruptSignature>[0]
      }
      manifest.signature = corruptSignature(manifest.signature)
      bundleV2.files.set('plugin.json', `${JSON.stringify(manifest, null, 2)}\n`)
      bundleV2.entry.signature = manifest.signature

      const folders = new Map([
        ['tamper-plugin-v1', bundleV1.files],
        ['tamper-plugin-v2', bundleV2.files],
      ])
      const { services, workspaceRoot, moduleRoot, receiptStorePath } = await createServices(
        temp,
        createGithubFetcher(folders),
        { trustedModules: new Map(), trustedKeyFingerprints: new Set([bundleV1.fingerprint]) },
      )
      const lifecycle = createMarketplacePluginLifecycleService(services)

      const installed = await lifecycle.installFromRegistry({ entry: bundleV1.entry, workspaceRoot })
      assert.equal(installed.ok, true, JSON.stringify(installed))

      const blocked = await lifecycle.updateFromRegistry({ entry: bundleV2.entry, workspaceRoot, trustGranted: true })
      assert.equal(blocked.ok, false)
      if (blocked.ok) return
      assert.equal(blocked.classification, 'invalid')
      assert.match(blocked.message, /signature is invalid/)

      // The v1 install survives the blocked update byte-for-byte.
      const receipts = await readMarketplacePluginInstallReceipts(receiptStorePath)
      assert.equal(receipts.ok, true)
      if (!receipts.ok) return
      assert.equal(receipts.receipts[0]?.version, 1)
      const installedManifest = JSON.parse(
        await readFile(join(moduleRoot, 'update-module', 'manifest.json'), 'utf8'),
      ) as { version: number }
      assert.equal(installedManifest.version, 1)
    })
  }

  // Update security, part 2: an update signed by a different publisher is
  // RE-classified — it re-prompts for trust instead of riding the previous
  // grant, and even once installed it is not load-eligible until re-trusted.
  async function testUpdateSignedByDifferentPublisherReprompts(): Promise<void> {
    await withTempDir(async (temp) => {
      const originalSigner = generateKeyPairSync('ed25519')
      const differentSigner = generateKeyPairSync('ed25519')
      const components: BundleComponents = { module: { path: 'module', id: 'update-module' } }
      const bundleV1 = await writeBundle(temp, 'rekey-plugin-v1', components, originalSigner, 1)
      const bundleV2 = await writeBundle(temp, 'rekey-plugin-v2', components, differentSigner, 2)
      const folders = new Map([
        ['rekey-plugin-v1', bundleV1.files],
        ['rekey-plugin-v2', bundleV2.files],
      ])
      // Only the ORIGINAL publisher key is trusted.
      const { services, workspaceRoot, moduleRoot, receiptStorePath } = await createServices(
        temp,
        createGithubFetcher(folders),
        { trustedModules: new Map(), trustedKeyFingerprints: new Set([bundleV1.fingerprint]) },
      )
      const lifecycle = createMarketplacePluginLifecycleService(services)

      const installed = await lifecycle.installFromRegistry({ entry: bundleV1.entry, workspaceRoot })
      assert.equal(installed.ok, true, JSON.stringify(installed))
      if (!installed.ok) return
      assert.equal(installed.classification, 'verified')

      const reprompted = await lifecycle.updateFromRegistry({ entry: bundleV2.entry, workspaceRoot })
      assert.equal(reprompted.ok, false)
      if (reprompted.ok) return
      assert.equal(reprompted.classification, 'community')
      assert.match(reprompted.message, /requires trust approval/)
      const untouched = await readMarketplacePluginInstallReceipts(receiptStorePath)
      assert.equal(untouched.ok && untouched.receipts[0]?.version, 1)

      const granted = await lifecycle.updateFromRegistry({ entry: bundleV2.entry, workspaceRoot, trustGranted: true })
      assert.equal(granted.ok, true, JSON.stringify(granted))
      if (!granted.ok) return
      assert.equal(granted.updated, true)
      assert.equal(granted.classification, 'community')
      // The updated module must not silently load under the old grant.
      assert.equal(granted.loadEligible, false)
      const modules = await discoverUserModules(moduleRoot, services.trustContext())
      assert.equal(modules.modules[0]?.manifest.version, 2)
      assert.equal(classifyModuleTrust(modules.modules[0].manifest, services.trustContext()).status, 'signed')
    })

    // Same walk with the trust store wired: re-approving the re-keyed update at
    // the prompt IS the trust decision for the NEW manifest, so the module ends
    // trusted — bound to the new fingerprint, never inheriting the old grant.
    await withTempDir(async (temp) => {
      const originalSigner = generateKeyPairSync('ed25519')
      const differentSigner = generateKeyPairSync('ed25519')
      const components: BundleComponents = { module: { path: 'module', id: 'update-module' } }
      const bundleV1 = await writeBundle(temp, 'rekey-plugin-v1', components, originalSigner, 1)
      const bundleV2 = await writeBundle(temp, 'rekey-plugin-v2', components, differentSigner, 2)
      const folders = new Map([
        ['rekey-plugin-v1', bundleV1.files],
        ['rekey-plugin-v2', bundleV2.files],
      ])
      const { services, workspaceRoot, moduleRoot } = await createServices(temp, createGithubFetcher(folders), {
        trustedModules: new Map(),
      })
      const userDataDir = join(temp, 'userdata')
      useRealTrustStore(services, userDataDir)
      // Only the original publisher key is trusted, so v1 installs verified.
      services.trustContext = () => ({
        trustedModules: readTrustedModulesSync(userDataDir),
        trustedKeyFingerprints: new Set([bundleV1.fingerprint]),
      })
      const lifecycle = createMarketplacePluginLifecycleService(services)

      const installed = await lifecycle.installFromRegistry({ entry: bundleV1.entry, workspaceRoot })
      assert.equal(installed.ok, true, JSON.stringify(installed))
      // A verified install grants nothing: it is already load-eligible.
      assert.equal(readTrustedModulesSync(userDataDir).has('update-module'), false)

      const granted = await lifecycle.updateFromRegistry({ entry: bundleV2.entry, workspaceRoot, trustGranted: true })
      assert.equal(granted.ok, true, JSON.stringify(granted))
      if (!granted.ok) return
      const component = granted.installed.find((installedComponent) => installedComponent.kind === 'module')
      assert.equal(readTrustedModulesSync(userDataDir).get('update-module'), component?.manifestFp)
      const modules = await discoverUserModules(moduleRoot, services.trustContext())
      assert.equal(modules.modules[0]?.manifest.version, 2)
      assert.equal(classifyModuleTrust(modules.modules[0].manifest, services.trustContext()).status, 'trusted')
    })
  }

  // Wire the REAL trust store (the one the Settings toggle writes) behind the
  // lifecycle's trust seam, and read trust back the way the app does — so these
  // tests prove the grant against the file module loading actually consults.
  function useRealTrustStore(services: MarketplacePluginLifecycleServices, userDataDir: string): void {
    services.trustContext = () => ({ trustedModules: readTrustedModulesSync(userDataDir) })
    services.setModuleTrust = async (id, manifestFp) => {
      const { result, previous } = await setModuleTrust(userDataDir, id, manifestFp)
      return { ...result, previous }
    }
  }

  // The install prompt's trust decision IS the module trust decision: a signed
  // module installed from a community bundle loads without a second, identical
  // toggle in Settings → Modules, and uninstalling takes the grant back with it.
  async function testCommunityModuleInstallGrantsTrustAndUninstallRevokes(): Promise<void> {
    await withTempDir(async (temp) => {
      const signer = generateKeyPairSync('ed25519')
      const components: BundleComponents = { module: { path: 'module', id: 'granted-module' } }
      const bundle = await writeBundle(temp, 'granted-plugin', components, signer, 1)
      bundle.entry.publisher.verified = false
      const folders = new Map([['granted-plugin', bundle.files]])
      const { services, workspaceRoot, moduleRoot } = await createServices(temp, createGithubFetcher(folders), {
        trustedModules: new Map(),
      })
      const userDataDir = join(temp, 'userdata')
      useRealTrustStore(services, userDataDir)
      const lifecycle = createMarketplacePluginLifecycleService(services)

      const result = await lifecycle.installFromRegistry({ entry: bundle.entry, workspaceRoot, trustGranted: true })

      assert.equal(result.ok, true, JSON.stringify(result))
      if (!result.ok) return
      assert.equal(result.classification, 'community')
      const component = result.installed.find((installed) => installed.kind === 'module')
      assert.equal(component?.trustStatus, 'signed')
      assert.match(component?.message ?? '', /Installed and trusted/)
      // Fingerprint-bound: the entry is the installed manifest's identity, not a
      // blanket grant for the id.
      assert.equal(readTrustedModulesSync(userDataDir).get('granted-module'), component?.manifestFp)

      // The real load path, not just the store: discovery classifies the module
      // trusted and the main-process loader takes it.
      const modules = await discoverUserModules(moduleRoot, services.trustContext())
      assert.equal(modules.modules[0]?.manifest.id, 'granted-module')
      assert.equal(classifyModuleTrust(modules.modules[0].manifest, services.trustContext()).status, 'trusted')
      const planned = planThirdPartyMainModules(modules)
      const { ipcMain } = createFakeIpcMain()
      const loaded = loadMainModules({
        ipcMain,
        modules: planned.modules,
        ineligible: planned.ineligible,
        launchErrors: planned.launchErrors,
      })
      assert.deepEqual(loaded.report.loaded, ['granted-module'])

      const uninstalled = await lifecycle.uninstall({ pluginId: bundle.entry.id, workspaceRoot })
      assert.equal(uninstalled.ok, true, JSON.stringify(uninstalled))
      assert.equal(existsSync(join(moduleRoot, 'granted-module')), false)
      // An orphaned grant would silently re-trust the same bytes later.
      assert.equal(readTrustedModulesSync(userDataDir).has('granted-module'), false)
    })
  }

  // G3. Settings → Modules knows a module's id, never the id of the bundle that
  // installed it — those need not match — so an uninstall named by the module id
  // has to reach the receipt that owns it and take the whole bundle out. An id
  // nothing installed is refused by name rather than reported as a success.
  async function testUninstallResolvesAModuleIdToItsOwningReceipt(): Promise<void> {
    await withTempDir(async (temp) => {
      const signer = generateKeyPairSync('ed25519')
      const components: BundleComponents = { module: { path: 'module', id: 'granted-module' } }
      const bundle = await writeBundle(temp, 'granted-plugin', components, signer, 1)
      bundle.entry.publisher.verified = false
      const folders = new Map([['granted-plugin', bundle.files]])
      const { services, workspaceRoot, moduleRoot } = await createServices(temp, createGithubFetcher(folders), {
        trustedModules: new Map(),
      })
      const userDataDir = join(temp, 'userdata')
      useRealTrustStore(services, userDataDir)
      const lifecycle = createMarketplacePluginLifecycleService(services)

      const installed = await lifecycle.installFromRegistry({ entry: bundle.entry, workspaceRoot, trustGranted: true })
      assert.equal(installed.ok, true, JSON.stringify(installed))
      assert.equal(existsSync(join(moduleRoot, 'granted-module')), true)

      // Neither an unrelated id nor a component id that is not a module resolves.
      const unknown = await lifecycle.uninstall({ pluginId: 'not-a-thing', workspaceRoot })
      assert.equal(unknown.ok, false)
      if (!unknown.ok) assert.match(unknown.message, /not-a-thing is not installed/)

      // The module's own id — what the Settings row carries — removes the bundle.
      const removed = await lifecycle.uninstall({ pluginId: 'granted-module', workspaceRoot })
      assert.equal(removed.ok, true, JSON.stringify(removed))
      if (!removed.ok) return
      assert.equal(removed.id, bundle.entry.id, 'the receipt that owns the module is the one that was removed')
      assert.notEqual(bundle.entry.id, 'granted-module', 'the bundle id and its module id really do differ here')
      assert.equal(existsSync(join(moduleRoot, 'granted-module')), false)
      assert.equal(readTrustedModulesSync(userDataDir).has('granted-module'), false)

      // And the receipt is gone with it, so a re-install is an install and not an
      // update of something that is no longer there.
      const receipts = await readMarketplacePluginInstallReceipts(services.receiptStorePath)
      assert.equal(receipts.ok, true)
      if (receipts.ok)
        assert.deepEqual(
          receipts.receipts.map((receipt) => receipt.id),
          [],
        )

      // A second uninstall is refused rather than silently succeeding.
      const again = await lifecycle.uninstall({ pluginId: 'granted-module', workspaceRoot })
      assert.equal(again.ok, false)
    })
  }

  // The grant is transactional with the receipt: if the receipt cannot be
  // written, the files roll back and the trust store ends exactly as it started,
  // including a fingerprint the user had trusted before this install.
  async function testFailedReceiptWriteLeavesTrustStoreUnchanged(): Promise<void> {
    await withTempDir(async (temp) => {
      const signer = generateKeyPairSync('ed25519')
      const components: BundleComponents = { module: { path: 'module', id: 'granted-module' } }
      const bundle = await writeBundle(temp, 'granted-plugin', components, signer, 1)
      bundle.entry.publisher.verified = false
      const folders = new Map([['granted-plugin', bundle.files]])
      const { services, workspaceRoot, moduleRoot } = await createServices(temp, createGithubFetcher(folders), {
        trustedModules: new Map(),
      })
      const userDataDir = join(temp, 'userdata')
      useRealTrustStore(services, userDataDir)
      // A grant this install must not clobber: some other manifest under the
      // same id that the user trusted earlier.
      await setModuleTrust(userDataDir, 'granted-module', 'a'.repeat(64))

      // Make only the receipt write fail: the store file is missing (an empty
      // store, as on a first install) inside a directory nothing may write to.
      const receiptDir = join(temp, 'read-only-receipts')
      await mkdir(receiptDir, { recursive: true })
      services.receiptStorePath = join(receiptDir, 'marketplace-installs.json')
      await chmod(receiptDir, 0o500)
      const lifecycle = createMarketplacePluginLifecycleService(services)

      try {
        const result = await lifecycle.installFromRegistry({ entry: bundle.entry, workspaceRoot, trustGranted: true })

        assert.equal(result.ok, false, JSON.stringify(result))
        if (result.ok) return
        assert.match(result.message, /Could not write marketplace plugin install receipt/)
        assert.equal(existsSync(join(moduleRoot, 'granted-module')), false, 'the rolled-back install left no module')
        assert.equal(readTrustedModulesSync(userDataDir).get('granted-module'), 'a'.repeat(64))
      } finally {
        await chmod(receiptDir, 0o700)
      }
    })
  }

  // Undoing a failed update is not an uninstall: the snapshot puts the trusted
  // module back, so the trust its files still match must survive the rollback.
  async function testFailedUpdateKeepsThePreviousModuleTrust(): Promise<void> {
    await withTempDir(async (temp) => {
      const signer = generateKeyPairSync('ed25519')
      const v1: BundleComponents = { module: { path: 'module', id: 'granted-module' } }
      const bundleV1 = await writeBundle(temp, 'granted-plugin-v1', v1, signer, 1)
      bundleV1.entry.publisher.verified = false
      // v2 adds an automation component, which installs AFTER the module and is
      // refused because automations are switched off — so the update fails with
      // the replacement module already written.
      const v2: BundleComponents = {
        module: { path: 'module', id: 'granted-module' },
        automation: { path: 'automation/automation.json', name: 'Nightly sweep' },
      }
      const bundleV2 = await writeBundle(temp, 'granted-plugin-v2', v2, signer, 2)
      bundleV2.entry.publisher.verified = false
      const folders = new Map([
        ['granted-plugin-v1', bundleV1.files],
        ['granted-plugin-v2', bundleV2.files],
      ])
      const { services, workspaceRoot, moduleRoot } = await createServices(temp, createGithubFetcher(folders), {
        trustedModules: new Map(),
      })
      const userDataDir = join(temp, 'userdata')
      useRealTrustStore(services, userDataDir)
      const lifecycle = createMarketplacePluginLifecycleService(services)

      const first = await lifecycle.installFromRegistry({ entry: bundleV1.entry, workspaceRoot, trustGranted: true })
      assert.equal(first.ok, true, JSON.stringify(first))
      const trustedFingerprint = readTrustedModulesSync(userDataDir).get('granted-module')
      assert.ok(trustedFingerprint, 'the first install granted trust')

      services.installAutomationDefinition = undefined
      const failed = await lifecycle.updateFromRegistry({
        entry: bundleV2.entry,
        workspaceRoot,
        trustGranted: true,
        // Satisfies the automation preflight, so the update gets far enough to
        // install the replacement module and fail on the component AFTER it.
        automationDefaultCli: 'codex',
      })

      assert.equal(failed.ok, false, JSON.stringify(failed))
      if (failed.ok) return
      assert.equal(failed.component, 'automation')
      assert.deepEqual(
        failed.installed?.map((component) => component.kind),
        ['module'],
        'the module was installed, then rolled back',
      )
      const modules = await discoverUserModules(moduleRoot, services.trustContext())
      assert.equal(modules.modules[0]?.manifest.version, 1, 'the previous module was restored')
      assert.equal(readTrustedModulesSync(userDataDir).get('granted-module'), trustedFingerprint)
      assert.equal(classifyModuleTrust(modules.modules[0].manifest, services.trustContext()).status, 'trusted')
    })
  }

  // A trust store that will not write is never reported as a clean trust
  // decision: the install says so on the component, and an uninstall that cannot
  // withdraw the grant fails loudly instead of leaving an entry that would
  // silently re-trust the same bytes later.
  async function testTrustWriteFailuresAreSurfacedNotSwallowed(): Promise<void> {
    await withTempDir(async (temp) => {
      const signer = generateKeyPairSync('ed25519')
      const components: BundleComponents = { module: { path: 'module', id: 'granted-module' } }
      const bundle = await writeBundle(temp, 'granted-plugin', components, signer, 1)
      bundle.entry.publisher.verified = false
      const folders = new Map([['granted-plugin', bundle.files]])
      const { services, workspaceRoot, receiptStorePath } = await createServices(temp, createGithubFetcher(folders), {
        trustedModules: new Map(),
      })
      services.setModuleTrust = async () => ({ ok: false, message: 'disk is full' })
      const lifecycle = createMarketplacePluginLifecycleService(services)

      const result = await lifecycle.installFromRegistry({ entry: bundle.entry, workspaceRoot, trustGranted: true })
      assert.equal(result.ok, true, JSON.stringify(result))
      if (!result.ok) return
      const component = result.installed.find((installed) => installed.kind === 'module')
      assert.match(component?.message ?? '', /recording trust failed \(disk is full\)/)

      const uninstalled = await lifecycle.uninstall({ pluginId: bundle.entry.id, workspaceRoot })
      assert.equal(uninstalled.ok, false)
      if (uninstalled.ok) return
      assert.match(uninstalled.message, /could not withdraw its trust: disk is full/)
      // The receipt survives a failed uninstall, so retrying it is possible.
      const receipts = JSON.parse(await readFile(receiptStorePath, 'utf8')) as { plugins: Record<string, unknown> }
      assert.ok(receipts.plugins['registry-plugin'])
    })
  }

  async function main(): Promise<void> {
    await testVerifiedRegistryInstallFansOutAndRecordsReceipt()
    await testTrustWriteFailuresAreSurfacedNotSwallowed()
    await testCommunityBundleRequiresTrustGrant()
    await testCommunityModuleInstallGrantsTrustAndUninstallRevokes()
    await testUninstallResolvesAModuleIdToItsOwningReceipt()
    await testFailedReceiptWriteLeavesTrustStoreUnchanged()
    await testFailedUpdateKeepsThePreviousModuleTrust()
    await testUnsignedMcpSkillsBundleRoutesThroughTrust()
    await testUnsignedSkillsOnlyBundleRoutesThroughTrust()
    await testUnsignedModuleBearingBundleHardBlocksEvenWithTrust()
    await testUnsignedCliBearingBundleHardBlocksEvenWithTrust()
    await testInlineMcpEntryRoutesThroughTrustAndSyncs()
    await testDigestMismatchedRegistryInstallDoesNotFanOut()
    await testSkillInstallFailureRollsBackResidue()
    await testUpdateAndUninstallRemoveOldComponents()
    await testUpdateAvailabilitySettlesThroughRegistryUpdate()
    await testUpdateWithInvalidSignatureIsBlocked()
    await testUpdateSignedByDifferentPublisherReprompts()
    await testAutomationInstallRecordsReceiptAndSurvivesUninstall()
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

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
