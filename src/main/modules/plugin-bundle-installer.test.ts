import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import Module from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import type { WebContents } from 'electron'
import type { MarketplacePluginInstallInput, McpSettings, SkillPackEntry } from '../../shared/electron-api'
import { canonicalManifestPayload, validateMarketplacePluginManifest } from '../../shared/marketplace'
import type { PluginManifest, PluginMcpConfigFormat } from '../../shared/plugin-manifest'
import { createMcpConfigService, type PluginLookup } from '../mcp-config-service'
import type { SkillPackService } from '../skill-pack-service'
import { installMarketplacePlugin } from './plugin-bundle-installer'

type RuntimeModule = typeof import('../terminal-runtime')
type SentEvent = { channel: string; payload: unknown }

type BundleComponents = {
  mcp?: { path: string }
  skills?: { path: string }
  module?: { path: string }
  cli?: { path: string }
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'mc-marketplace-install-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function createMockWebContents(): WebContents & { sent: SentEvent[] } {
  const sender = {
    sent: [] as SentEvent[],
    isDestroyed: () => false,
    send(channel: string, payload: unknown): void {
      sender.sent.push({ channel, payload })
    },
  }
  return sender as unknown as WebContents & { sent: SentEvent[] }
}

async function withElectronMock<T>(
  userDataDir: string,
  sender: WebContents,
  fn: () => Promise<T>
): Promise<T> {
  const moduleWithLoad = Module as typeof Module & {
    _load(request: string, parent: NodeModule | null, isMain: boolean): unknown
  }
  const originalLoad = moduleWithLoad._load
  moduleWithLoad._load = function loadWithElectronMock(
    request: string,
    parent: NodeModule | null,
    isMain: boolean
  ): unknown {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => userDataDir,
        },
        BrowserWindow: {
          getAllWindows: () => [{ isDestroyed: () => false, webContents: sender }],
        },
      }
    }
    return originalLoad.call(this, request, parent, isMain)
  }

  try {
    return await fn()
  } finally {
    moduleWithLoad._load = originalLoad
  }
}

async function writeSkill(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await writeFile(
    join(path, 'SKILL.md'),
    '---\nname: local-skill\ndescription: Local test skill.\n---\n# Local Skill\n\nInstall me.\n',
    'utf8'
  )
}

async function writeModule(path: string, id = 'bundle-module'): Promise<void> {
  await writeJson(join(path, 'manifest.json'), {
    id,
    displayName: 'Bundle Module',
    version: 1,
    permissions: ['network'],
  })
}

async function writeCli(path: string, id = 'bundle-cli'): Promise<void> {
  await writeJson(join(path, 'plugin.json'), {
    id,
    displayName: 'Bundle CLI',
    version: 1,
    binary: 'node',
    permissionPresets: {
      default: { label: 'Default', args: [] },
    },
    launch: { argv: ['{{binary}}'] },
    promptInjection: { mode: 'stdin-pipe' },
    completion: { mode: 'process-exit' },
    capabilities: {
      resumeSession: false,
      sessionIdFromCaller: false,
      toolUse: false,
      mcpServers: false,
    },
  })
}

function signedBundleManifest(components: BundleComponents, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const unsigned = {
    id: 'bundle-plugin',
    displayName: 'Bundle Plugin',
    version: 1,
    permissions: ['network'],
    components,
    ...overrides,
  }
  const dummySignature = { algorithm: 'ed25519' as const, publicKey: 'YWJj', signature: 'ZGVm' }
  const validated = validateMarketplacePluginManifest({ ...unsigned, signature: dummySignature })
  assert.equal(validated.ok, true)
  if (!validated.ok) throw new Error('test manifest did not validate')

  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const payload = Buffer.from(canonicalManifestPayload(validated.manifest), 'utf8')
  return {
    ...unsigned,
    signature: {
      algorithm: 'ed25519',
      publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      signature: sign(null, payload, privateKey).toString('base64'),
    },
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
      const harnesses = input.harnesses?.length ? input.harnesses : ['agents']
      for (const harness of harnesses) {
        const harnessDir = harness === 'agents' ? '.agents' : `.${harness}`
        await cp(input.slug, join(input.workspaceRoot, harnessDir, 'skills', installedDirName), {
          recursive: true,
          force: true,
        })
      }
      const installed: SkillPackEntry = {
        id: installedDirName,
        slug: input.slug,
        name: installedDirName,
        installedDirName,
        harnesses,
        source: 'custom',
        installedAt: '2026-06-16T00:00:00.000Z',
      }
      return { ok: true, installed, log: input.slug }
    },
    remove: async () => ({ ok: false, message: 'not used' }),
  }
}

async function createBundle(root: string, components: BundleComponents): Promise<string> {
  const bundle = join(root, 'bundle')
  await mkdir(bundle, { recursive: true })
  if (components.mcp) {
    await writeJson(join(bundle, components.mcp.path), {
      servers: [
        {
          id: 'bundle-mcp',
          name: 'Bundle MCP',
          transport: 'stdio',
          command: 'node',
          args: ['-e', 'console.log("bundle mcp")'],
          clients: ['codex'],
          scope: 'workspace',
          riskLevel: 'local-command',
        },
      ],
    })
  }
  if (components.skills) await writeSkill(join(bundle, components.skills.path))
  if (components.module) await writeModule(join(bundle, components.module.path))
  if (components.cli) await writeCli(join(bundle, components.cli.path))
  await writeJson(join(bundle, 'plugin.json'), signedBundleManifest(components))
  return bundle
}

async function installInput(temp: string, bundle: string): Promise<{
  input: MarketplacePluginInstallInput
  services: Parameters<typeof installMarketplacePlugin>[1]
  workspaceRoot: string
  moduleRoot: string
  pluginRoot: string
}> {
  const workspaceRoot = join(temp, 'workspace')
  const moduleRoot = join(temp, 'modules')
  const pluginRoot = join(temp, 'plugins')
  await mkdir(workspaceRoot, { recursive: true })

  const lookupPlugin: PluginLookup = (id) => {
    if (id === 'codex') return { manifest: mcpPluginManifest(id, 'codex') }
    return undefined
  }
  const mcpConfigService = createMcpConfigService({
    lookupPlugin,
    homeDir: () => join(temp, 'home'),
  })
  const mcpSettings: McpSettings = { syncEnabled: false, servers: {} }
  return {
    input: { localFolder: bundle, workspaceRoot, mcpSettings, mcpClients: ['codex'], skillHarnesses: ['agents'] },
    services: {
      mcpConfigService,
      skillPackService: createLocalSkillService(),
      trustContext: () => ({ trustedModules: new Map() }),
      moduleRoot: () => moduleRoot,
      pluginRoot: () => pluginRoot,
      reloadPlugins: () => undefined,
    },
    workspaceRoot,
    moduleRoot,
    pluginRoot,
  }
}

async function testInstallsEveryComponentThroughRealPaths(): Promise<void> {
  await withTempDir(async (temp) => {
    const components: BundleComponents = {
      mcp: { path: 'mcp.json' },
      skills: { path: 'skills/local-skill' },
      module: { path: 'module' },
      cli: { path: 'cli' },
    }
    const bundle = await createBundle(temp, components)
    const { input, services, workspaceRoot, moduleRoot, pluginRoot } = await installInput(temp, bundle)

    const result = await installMarketplacePlugin(input, services)

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.trust, 'signed')
    assert.equal(result.loadEligible, false, 'signed but untrusted bundle is not auto-trusted')
    assert.deepEqual(result.installed.map((component) => component.kind), ['mcp', 'skills', 'module', 'cli'])
    assert.equal(result.mcpSettings?.servers['bundle-mcp']?.enabled, true)

    const codexConfig = await readFile(join(workspaceRoot, '.codex', 'config.toml'), 'utf8')
    assert.match(codexConfig, /\[mcp_servers\.bundle-mcp\]/)
    assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'local-skill', 'SKILL.md')), true)
    assert.equal(existsSync(join(moduleRoot, 'bundle-module', 'manifest.json')), true)
    assert.equal(existsSync(join(pluginRoot, 'bundle-cli', 'plugin.json')), true)
  })
}

async function testMcpSkillBundleIsVisibleAndLaunchesTerminalWithInstalledMcp(): Promise<void> {
  await withTempDir(async (temp) => {
    const components: BundleComponents = {
      mcp: { path: 'mcp.json' },
      skills: { path: 'skills/local-skill' },
    }
    const bundle = await createBundle(temp, components)
    const { input, services, workspaceRoot } = await installInput(temp, bundle)

    const result = await installMarketplacePlugin(input, services)

    assert.equal(result.ok, true)
    if (!result.ok) return

    const activeServers = Object.values(result.mcpSettings?.servers ?? {}).filter((server) => server.enabled)
    assert.deepEqual(activeServers.map((server) => server.id), ['bundle-mcp'])
    assert.equal(activeServers[0]?.clients.includes('codex'), true)

    const codexConfig = await readFile(join(workspaceRoot, '.codex', 'config.toml'), 'utf8')
    assert.match(codexConfig, /\[mcp_servers\.bundle-mcp\]/)
    assert.match(codexConfig, /command = "node"/)
    assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'local-skill', 'SKILL.md')), true)

    const sender = createMockWebContents()
    await withElectronMock(join(temp, 'electron-user-data'), sender, async () => {
      const catalog = services.mcpConfigService.listCatalog()
      assert.equal(catalog.ok, true, catalog.ok ? undefined : catalog.message)
      if (catalog.ok) {
        assert.ok(catalog.servers.length > 0, 'MCP catalog should be readable for Settings visibility')
      }

      const runtimeModule = require('../terminal-runtime') as RuntimeModule
      const syncInputs: Array<{ settings: McpSettings; clients: string[] }> = []
      const runtime = runtimeModule.createTerminalRuntime({
        diagnosticsEnabled: false,
        requireAuthenticatedUser: () => undefined,
        logMainPerfEvent: () => undefined,
        syncMcpConfig: async (syncInput) => {
          syncInputs.push({ settings: syncInput.settings, clients: syncInput.clients })
          const syncResult = services.mcpConfigService.sync(syncInput)
          if (!syncResult.ok) return { ok: false, message: syncResult.message }
          return { ok: true }
        },
      })

      try {
        const launch = await runtime.ipcHandlers.spawnTerminal(sender, {
          sessionId: 'bundle-mcp-launch',
          cols: 100,
          rows: 24,
          cwd: workspaceRoot,
          cli: 'codex',
          cliRuntimes: { codex: { command: process.execPath } },
          kind: 'agent',
          shellOnly: false,
          visible: false,
          mcpSettings: result.mcpSettings,
        })

        assert.equal(launch.ok, true, JSON.stringify(launch))
        assert.equal(runtime.ipcHandlers.getTerminalStatus('bundle-mcp-launch').processAlive, true)
        assert.equal(syncInputs.length, 1)
        assert.equal(syncInputs[0].clients.includes('codex'), true)
        assert.equal(syncInputs[0].settings.servers['bundle-mcp']?.enabled, true)
      } finally {
        runtime.ipcHandlers.killTerminal('bundle-mcp-launch')
        await runtime.shutdown()
      }
    })
  })
}

async function testInvalidBundleSignatureRejectsBeforeWrites(): Promise<void> {
  await withTempDir(async (temp) => {
    const components: BundleComponents = { mcp: { path: 'mcp.json' }, module: { path: 'module' } }
    const bundle = await createBundle(temp, components)
    const raw = JSON.parse(await readFile(join(bundle, 'plugin.json'), 'utf8')) as Record<string, unknown>
    await writeJson(join(bundle, 'plugin.json'), { ...raw, displayName: 'Tampered Bundle' })

    const { input, services, workspaceRoot, moduleRoot } = await installInput(temp, bundle)
    const result = await installMarketplacePlugin(input, services)

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.message, 'Plugin bundle signature is invalid.')
    assert.equal(existsSync(join(workspaceRoot, '.codex', 'config.toml')), false)
    assert.equal(existsSync(moduleRoot), false)
  })
}

async function testPartialFailureReportsInstalledComponents(): Promise<void> {
  await withTempDir(async (temp) => {
    const components: BundleComponents = { mcp: { path: 'mcp.json' }, skills: { path: 'skills/local-skill' } }
    const bundle = await createBundle(temp, components)
    const { input, services } = await installInput(temp, bundle)
    services.skillPackService = {
      ...services.skillPackService,
      install: async () => ({ ok: false, message: 'skills CLI failed' }),
    }

    const result = await installMarketplacePlugin(input, services)

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.component, 'skills')
    assert.equal(result.message, 'skills CLI failed')
    assert.deepEqual(result.installed?.map((component) => component.kind), ['mcp'])
  })
}

async function main(): Promise<void> {
  await testInstallsEveryComponentThroughRealPaths()
  await testMcpSkillBundleIsVisibleAndLaunchesTerminalWithInstalledMcp()
  await testInvalidBundleSignatureRejectsBeforeWrites()
  await testPartialFailureReportsInstalledComponents()
  console.log('plugin-bundle-installer tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
