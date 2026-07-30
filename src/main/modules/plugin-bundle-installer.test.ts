import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import Module from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { WebContents } from 'electron'
import type { MarketplacePluginInstallInput, McpClientTarget, McpSettings } from '../../shared/electron-api'
import { canonicalManifestPayload, validateMarketplacePluginManifest } from '../../shared/marketplace'
import type { PluginManifest, PluginMcpConfigFormat } from '../../shared/plugin-manifest'
import { createMcpConfigService, type PluginLookup } from '../mcp-config-service'
import { installMarketplacePlugin } from './plugin-bundle-installer'

type RuntimeModule = typeof import('../terminal-runtime')
type SentEvent = { channel: string; payload: unknown }

type BundleComponents = {
  mcp?: { path: string; clients?: McpClientTarget[] }
  skills?: { path: string }
  module?: { path: string }
  cli?: { path: string }
  automation?: { path: string; source?: string }
}

const AUTOMATION_PAYLOAD = `${JSON.stringify({
  name: 'Nightly dependency sweep',
  status: 'paused',
  trigger: { kind: 'schedule', config: { kind: 'schedule', cadence: { type: 'daily', timeLocal: '03:00' }, timezone: 'UTC' } },
  action: { kind: 'spawn-agent', config: { prompt: 'Check for outdated dependencies.' } },
}, null, 2)}\n`

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

function sha256Hex(source: string): string {
  return createHash('sha256').update(Buffer.from(source, 'utf8')).digest('hex')
}

function componentsWithDigests(components: BundleComponents, files: Map<string, string>): BundleComponents {
  return Object.fromEntries(
    Object.entries(components).map(([kind, component]) => {
      const componentFiles = Array.from(files.entries())
        .filter(([path]) => path === component.path || path.startsWith(`${component.path}/`))
        .map(([path, source]) => ({ path, sha256: sha256Hex(source) }))
        .sort((a, b) => a.path.localeCompare(b.path))
      return [kind, { path: component.path, files: componentFiles }]
    })
  ) as BundleComponents
}

function signedBundleManifest(
  components: BundleComponents,
  files: Map<string, string>,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const unsigned = {
    id: 'bundle-plugin',
    displayName: 'Bundle Plugin',
    version: 1,
    permissions: ['network'],
    components: componentsWithDigests(components, files),
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

function unsignedBundleManifest(
  components: BundleComponents,
  files: Map<string, string>,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'bundle-plugin',
    displayName: 'Bundle Plugin',
    version: 1,
    permissions: ['network'],
    components: componentsWithDigests(components, files),
    ...overrides,
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

async function createBundle(
  root: string,
  components: BundleComponents,
  options: { signed?: boolean } = {}
): Promise<string> {
  const bundle = join(root, 'bundle')
  await mkdir(bundle, { recursive: true })
  const files = new Map<string, string>()
  if (components.mcp) {
    files.set(components.mcp.path, `${JSON.stringify({
      servers: [
        {
          id: 'bundle-mcp',
          name: 'Bundle MCP',
          transport: 'stdio',
          command: 'node',
          args: ['-e', 'console.log("bundle mcp")'],
          clients: components.mcp.clients ?? ['codex'],
          scope: 'workspace',
          riskLevel: 'local-command',
        },
      ],
    }, null, 2)}\n`)
  }
  if (components.skills) {
    files.set(
      `${components.skills.path}/SKILL.md`,
      '---\nname: local-skill\ndescription: Local test skill.\n---\n# Local Skill\n\nInstall me.\n'
    )
  }
  if (components.module) {
    files.set(`${components.module.path}/manifest.json`, `${JSON.stringify({
      id: 'bundle-module',
      displayName: 'Bundle Module',
      version: 1,
      permissions: ['network'],
    }, null, 2)}\n`)
  }
  if (components.cli) {
    files.set(`${components.cli.path}/plugin.json`, `${JSON.stringify({
      id: 'bundle-cli',
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
    }, null, 2)}\n`)
  }
  if (components.automation) {
    files.set(components.automation.path, components.automation.source ?? AUTOMATION_PAYLOAD)
  }
  const manifest = options.signed === false
    ? unsignedBundleManifest(components, files)
    : signedBundleManifest(components, files)
  files.set('plugin.json', `${JSON.stringify(manifest, null, 2)}\n`)
  for (const [path, source] of files) {
    const destination = join(bundle, path)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, source, 'utf8')
  }
  return bundle
}

async function installInput(temp: string, bundle: string, options: {
  lookupPlugin?: PluginLookup
  mcpClients?: McpClientTarget[]
} = {}): Promise<{
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

  const lookupPlugin: PluginLookup = options.lookupPlugin ?? ((id) => {
    if (id === 'codex') return { manifest: mcpPluginManifest(id, 'codex') }
    return undefined
  })
  const mcpConfigService = createMcpConfigService({
    lookupPlugin,
    homeDir: () => join(temp, 'home'),
  })
  const mcpSettings: McpSettings = { syncEnabled: false, servers: {} }
  return {
    input: { localFolder: bundle, workspaceRoot, mcpSettings, mcpClients: options.mcpClients ?? ['codex'], skillHarnesses: ['agents'] },
    services: {
      mcpConfigService,
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

async function testMcpFanOutWarningDoesNotReportCleanSuccess(): Promise<void> {
  await withTempDir(async (temp) => {
    const components: BundleComponents = { mcp: { path: 'mcp.json', clients: ['codex', 'opencode'] } }
    const bundle = await createBundle(temp, components)
    const lookupPlugin: PluginLookup = (id) => {
      if (id === 'codex') return { manifest: mcpPluginManifest(id, 'codex') }
      // The second fan-out client declares an unimplemented config-writer format
      // ('generic') so sync emits a warning and writes no target for it. Exercises
      // the installer's contract that a fan-out warning is not masked as clean
      // success, independent of which per-format writers happen to be implemented.
      if (id === 'opencode') return { manifest: mcpPluginManifest(id, 'generic') }
      return undefined
    }
    const { input, services, workspaceRoot } = await installInput(temp, bundle, {
      lookupPlugin,
      mcpClients: ['codex', 'opencode'],
    })

    const result = await installMarketplacePlugin(input, services)

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.component, 'mcp')
    assert.match(result.message, /opencode \(bundle-mcp\)/)
    assert.deepEqual(result.installed?.map((component) => component.kind), ['mcp'])
    assert.ok(
      result.issues?.some((issue) =>
        issue.path === 'clients.opencode' && /writer for format "generic" is not implemented/.test(issue.message)
      ),
      `expected opencode warning in install issues, got ${JSON.stringify(result.issues)}`
    )

    const codexConfig = await readFile(join(workspaceRoot, '.codex', 'config.toml'), 'utf8')
    assert.match(codexConfig, /\[mcp_servers\.bundle-mcp\]/)
  })
}

async function testLocalInstallRejectsSignedComponentDigestMismatchBeforeWrites(): Promise<void> {
  await withTempDir(async (temp) => {
    const components: BundleComponents = { mcp: { path: 'mcp.json' }, module: { path: 'module' } }
    const bundle = await createBundle(temp, components)
    await writeJson(join(bundle, 'mcp.json'), {
      servers: [
        {
          id: 'bundle-mcp',
          name: 'Tampered MCP',
          transport: 'stdio',
          command: 'node',
          args: ['-e', 'console.log("tampered")'],
          clients: ['codex'],
          scope: 'workspace',
          riskLevel: 'local-command',
        },
      ],
    })
    const { input, services, workspaceRoot, moduleRoot } = await installInput(temp, bundle)

    const result = await installMarketplacePlugin(input, services)

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.message, /component digests/i)
    assert.equal(result.installed, undefined)
    assert.ok(result.issues?.some((issue) => /digest does not match/.test(issue.message)))
    assert.equal(existsSync(join(workspaceRoot, '.codex', 'config.toml')), false)
    assert.equal(existsSync(moduleRoot), false)
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
        assert.equal((await runtime.ipcHandlers.getTerminalStatus('bundle-mcp-launch')).processAlive, true)
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
    // A real, deterministic install failure: the harness skill directory is a
    // file, so the skill copy cannot create anything under it. The MCP
    // component installed first, and the result must still say so.
    await mkdir(join(input.workspaceRoot!, '.agents'), { recursive: true })
    await writeFile(join(input.workspaceRoot!, '.agents', 'skills'), 'not a directory', 'utf8')

    const result = await installMarketplacePlugin(input, services)

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.component, 'skills')
    assert.deepEqual(result.installed?.map((component) => component.kind), ['mcp'])
  })
}

async function testInstallsUnsignedMcpSkillsBundle(): Promise<void> {
  await withTempDir(async (temp) => {
    const components: BundleComponents = { mcp: { path: 'mcp.json' }, skills: { path: 'skills/local-skill' } }
    const bundle = await createBundle(temp, components, { signed: false })
    const { input, services, workspaceRoot } = await installInput(temp, bundle)

    const result = await installMarketplacePlugin(input, services)

    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    assert.equal(result.trust, 'unsigned')
    assert.equal(result.loadEligible, false, 'unsigned bundle is never load-eligible')
    assert.deepEqual(result.installed.map((component) => component.kind), ['mcp', 'skills'])

    const codexConfig = await readFile(join(workspaceRoot, '.codex', 'config.toml'), 'utf8')
    assert.match(codexConfig, /\[mcp_servers\.bundle-mcp\]/)
    assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'local-skill', 'SKILL.md')), true)
  })
}

async function testRejectsUnsignedModuleBundleBeforeWrites(): Promise<void> {
  await withTempDir(async (temp) => {
    const components: BundleComponents = { mcp: { path: 'mcp.json' }, module: { path: 'module' } }
    const bundle = await createBundle(temp, components, { signed: false })
    const { input, services, workspaceRoot, moduleRoot } = await installInput(temp, bundle)

    const result = await installMarketplacePlugin(input, services)

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.message, 'Plugin bundle is unsigned and cannot be installed.')
    assert.equal(result.trust, 'unsigned')
    assert.equal(result.loadEligible, false)
    assert.equal(existsSync(join(workspaceRoot, '.codex', 'config.toml')), false)
    assert.equal(existsSync(moduleRoot), false)
  })
}

async function testRejectsUnsignedCliBundleBeforeWrites(): Promise<void> {
  await withTempDir(async (temp) => {
    const components: BundleComponents = { cli: { path: 'cli' } }
    const bundle = await createBundle(temp, components, { signed: false })
    const { input, services, pluginRoot } = await installInput(temp, bundle)

    const result = await installMarketplacePlugin(input, services)

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.message, 'Plugin bundle is unsigned and cannot be installed.')
    assert.equal(existsSync(pluginRoot), false)
  })
}

async function testRejectsAutomationPayloadThatIsNotADefinition(): Promise<void> {
  await withTempDir(async (temp) => {
    const components: BundleComponents = {
      mcp: { path: 'mcp.json' },
      automation: { path: 'automation/automation.json', source: `${JSON.stringify({ name: 'No trigger' })}\n` },
    }
    const bundle = await createBundle(temp, components, { signed: false })
    const { input, services, workspaceRoot } = await installInput(temp, bundle)

    const result = await installMarketplacePlugin(input, services)

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.component, 'automation')
    assert.deepEqual(
      result.issues?.map((issue) => issue.path),
      ['components.automation.trigger', 'components.automation.action']
    )
    assert.equal(existsSync(join(workspaceRoot, '.codex', 'config.toml')), false, 'preflight refuses before any component is written')
  })
}

async function testAutomationComponentRefusedRatherThanSilentlyDropped(): Promise<void> {
  await withTempDir(async (temp) => {
    // The kind stages and validates, but nothing installs an automation
    // definition yet; the bundle must fail rather than install its other
    // components and quietly drop the automation it declared.
    const components: BundleComponents = { mcp: { path: 'mcp.json' }, automation: { path: 'automation/automation.json' } }
    const bundle = await createBundle(temp, components, { signed: false })
    const { input, services, workspaceRoot } = await installInput(temp, bundle)

    const result = await installMarketplacePlugin(input, services)

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.component, 'automation')
    assert.match(result.message, /cannot be installed from a plugin bundle yet/)
    assert.equal(existsSync(join(workspaceRoot, '.codex', 'config.toml')), false)
  })
}

async function main(): Promise<void> {
  await testInstallsEveryComponentThroughRealPaths()
  await testInstallsUnsignedMcpSkillsBundle()
  await testRejectsUnsignedModuleBundleBeforeWrites()
  await testRejectsUnsignedCliBundleBeforeWrites()
  await testRejectsAutomationPayloadThatIsNotADefinition()
  await testAutomationComponentRefusedRatherThanSilentlyDropped()
  await testMcpFanOutWarningDoesNotReportCleanSuccess()
  await testLocalInstallRejectsSignedComponentDigestMismatchBeforeWrites()
  await testMcpSkillBundleIsVisibleAndLaunchesTerminalWithInstalledMcp()
  await testInvalidBundleSignatureRejectsBeforeWrites()
  await testPartialFailureReportsInstalledComponents()
  console.log('plugin-bundle-installer tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
