import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { standIn } from '../../../tests/stand-in'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { WebContents } from 'electron'
import type { AutomationDefinition } from '../../shared/automations/contracts'
import type { MarketplacePluginInstallInput, McpClientTarget, McpSettings } from '../../shared/electron-api'
import { canonicalManifestPayload, validateMarketplacePluginManifest } from '../../shared/marketplace'
import type { PluginManifest, PluginMcpConfigFormat } from '../../shared/plugin-manifest'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import { createBuiltInAutomationProviderRegistry } from '../automations/provider-registry'
import { AutomationsStore } from '../automations/store'
import { registerAutomationsIpc } from '../ipc/automations-ipc'
import { createMcpConfigService, type PluginLookup } from '../mcp-config-service'
import {
  canonicalManifestPayload as moduleCanonicalPayload,
  validateThirdPartyModuleManifest,
} from '../../shared/modules/third-party-manifest'
import { installMarketplacePlugin, type MarketplaceAutomationInstaller } from './plugin-bundle-installer'
import { test } from 'vitest'

test('plugin-bundle-installer', async () => {
  type RuntimeModule = typeof import('../terminal-runtime')
  type SentEvent = { channel: string; payload: unknown }

  type BundleComponents = {
    mcp?: { path: string; clients?: McpClientTarget[] }
    skills?: { path: string }
    // `permissions` is the MODULE manifest's own declaration; the bundle
    // plugin.json always discloses ['network'], so overriding this is how the
    // bundle/module permission cross-check gets exercised.
    // `signer` signs the MODULE manifest itself (the identity `classifyModuleTrust`
    // reads), which is a different signature from the bundle's — G1 is about the
    // inner one.
    module?: { path: string; permissions?: string[]; signer?: ModuleSigner }
    cli?: { path: string }
    automation?: { path: string; source?: string }
  }

  const AUTOMATION_PAYLOAD = `${JSON.stringify(
    {
      name: 'Nightly dependency sweep',
      status: 'paused',
      trigger: {
        kind: 'schedule',
        config: { kind: 'schedule', cadence: { type: 'daily', timeLocal: '03:00' }, timezone: 'UTC' },
      },
      action: { kind: 'spawn-agent', config: { prompt: 'Check for outdated dependencies.' } },
    },
    null,
    2,
  )}\n`

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

  async function withElectronMock<T>(userDataDir: string, sender: WebContents, fn: () => Promise<T>): Promise<T> {
    const restoreModules = standIn({
      electron: {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => userDataDir,
        },
        BrowserWindow: {
          getAllWindows: () => [{ isDestroyed: () => false, webContents: sender }],
        },
      },
    })

    try {
      return await fn()
    } finally {
      restoreModules()
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
      }),
    ) as BundleComponents
  }

  function signedBundleManifest(
    components: BundleComponents,
    files: Map<string, string>,
    overrides: Record<string, unknown> = {},
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
    overrides: Record<string, unknown> = {},
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

  /**
   * A signer for the INNER module manifest. `fingerprint` is what goes into a
   * trust context's `trustedKeyFingerprints` to make `classifyModuleTrust` say
   * 'trusted' rather than 'signed'.
   */
  type ModuleSigner = {
    fingerprint: string
    sign: (manifest: Record<string, unknown>) => { algorithm: 'ed25519'; publicKey: string; signature: string }
  }

  function moduleSigner(): ModuleSigner {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
    return {
      fingerprint: createHash('sha256').update(publicKeyDer).digest('hex'),
      sign: (manifest) => {
        const parsed = validateThirdPartyModuleManifest({
          ...manifest,
          signature: { algorithm: 'ed25519', publicKey: publicKeyDer.toString('base64'), signature: 'ZGVm' },
        })
        assert.equal(parsed.ok, true)
        if (!parsed.ok) throw new Error('test module manifest did not validate')
        const payload = Buffer.from(moduleCanonicalPayload(parsed.manifest), 'utf8')
        return {
          algorithm: 'ed25519',
          publicKey: publicKeyDer.toString('base64'),
          signature: sign(null, payload, privateKey).toString('base64'),
        }
      },
    }
  }

  async function createBundle(
    root: string,
    components: BundleComponents,
    options: { signed?: boolean } = {},
  ): Promise<string> {
    const bundle = join(root, 'bundle')
    await mkdir(bundle, { recursive: true })
    const files = new Map<string, string>()
    if (components.mcp) {
      files.set(
        components.mcp.path,
        `${JSON.stringify(
          {
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
          },
          null,
          2,
        )}\n`,
      )
    }
    if (components.skills) {
      files.set(
        `${components.skills.path}/SKILL.md`,
        '---\nname: local-skill\ndescription: Local test skill.\n---\n# Local Skill\n\nInstall me.\n',
      )
    }
    if (components.module) {
      const moduleManifest: Record<string, unknown> = {
        id: 'bundle-module',
        displayName: 'Bundle Module',
        version: 1,
        permissions: components.module.permissions ?? ['network'],
      }
      const signed = components.module.signer
        ? { ...moduleManifest, signature: components.module.signer.sign(moduleManifest) }
        : moduleManifest
      files.set(`${components.module.path}/manifest.json`, `${JSON.stringify(signed, null, 2)}\n`)
    }
    if (components.cli) {
      files.set(
        `${components.cli.path}/plugin.json`,
        `${JSON.stringify(
          {
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
          },
          null,
          2,
        )}\n`,
      )
    }
    if (components.automation) {
      files.set(components.automation.path, components.automation.source ?? AUTOMATION_PAYLOAD)
    }
    const manifest =
      options.signed === false ? unsignedBundleManifest(components, files) : signedBundleManifest(components, files)
    files.set('plugin.json', `${JSON.stringify(manifest, null, 2)}\n`)
    for (const [path, source] of files) {
      const destination = join(bundle, path)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, source, 'utf8')
    }
    return bundle
  }

  // The real automations app front door over a real per-project store — the same
  // object `marketplace-plugin-ipc.ts` resolves, reached the same way, so the
  // installer's automation arm is tested against the path it actually uses rather
  // than a stand-in that could disagree with it about the input shape.
  function automationInstaller(workspaceRoot: string): MarketplaceAutomationInstaller {
    const registry = createBuiltInAutomationProviderRegistry()
    const frontDoor = registerAutomationsIpc(
      { registerIpc: () => undefined },
      {
        engine: {
          runNow: async () => ({
            ok: false as const,
            problem: { code: 'not_stubbed', message: 'Installing never runs an automation.' },
          }),
          finalizeRun: async () => ({
            ok: false as const,
            problem: { code: 'not_stubbed', message: 'Installing never finalizes a run.' },
          }),
        },
        triggerProviders: registry.listTriggerProviders(),
        actionProviders: registry.listActionProviders(),
        getWorkspaceSyncSnapshot: () =>
          ({
            sequence: 1,
            state: {
              activeWorkspaceId: 'ws-1',
              primaryWorkspaceWindowId: 'primary',
              workspaceWindows: [],
              workspaces: [{ id: 'ws-1', folderPath: workspaceRoot }],
            },
          }) as unknown as WorkspaceSyncSnapshot,
        now: () => Date.parse('2026-07-30T12:00:00.000Z'),
      },
    )
    return async (input) => {
      const result = await frontDoor.installCatalogueDefinition(input)
      if (!result.ok) return result
      return { ok: true, value: { definition: result.value.definition, alreadyAdded: result.value.alreadyAdded } }
    }
  }

  async function installedAutomations(workspaceRoot: string): Promise<AutomationDefinition[]> {
    const definitions = await new AutomationsStore(workspaceRoot).listDefinitions()
    assert.equal(definitions.ok, true)
    return definitions.ok ? definitions.values : []
  }

  async function installInput(
    temp: string,
    bundle: string,
    options: {
      lookupPlugin?: PluginLookup
      mcpClients?: McpClientTarget[]
      automationDefaultCli?: string | null
      automations?: MarketplaceAutomationInstaller | null
    } = {},
  ): Promise<{
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

    const lookupPlugin: PluginLookup =
      options.lookupPlugin ??
      ((id) => {
        if (id === 'codex') return { manifest: mcpPluginManifest(id, 'codex') }
        return undefined
      })
    const mcpConfigService = createMcpConfigService({
      lookupPlugin,
      homeDir: () => join(temp, 'home'),
    })
    const mcpSettings: McpSettings = { syncEnabled: false, servers: {} }
    const automationDefaultCli =
      options.automationDefaultCli === null ? undefined : (options.automationDefaultCli ?? 'claude-code')
    const installAutomationDefinition =
      options.automations === null ? undefined : (options.automations ?? automationInstaller(workspaceRoot))
    return {
      input: {
        localFolder: bundle,
        workspaceRoot,
        mcpSettings,
        mcpClients: options.mcpClients ?? ['codex'],
        skillHarnesses: ['agents'],
        ...(automationDefaultCli ? { automationDefaultCli } : {}),
      },
      services: {
        mcpConfigService,
        trustContext: () => ({ trustedModules: new Map() }),
        moduleRoot: () => moduleRoot,
        pluginRoot: () => pluginRoot,
        reloadPlugins: () => undefined,
        ...(installAutomationDefinition ? { installAutomationDefinition } : {}),
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
      assert.deepEqual(
        result.installed.map((component) => component.kind),
        ['mcp', 'skills', 'module', 'cli'],
      )
      // G7: the bundle landed a module, and no module outside
      // LIVE_ENABLED_MODULE_IDS loads until the app is launched again.
      assert.equal(result.restartRequired, true)
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
      assert.deepEqual(
        result.installed?.map((component) => component.kind),
        ['mcp'],
      )
      assert.ok(
        result.issues?.some(
          (issue) =>
            issue.path === 'clients.opencode' && /writer for format "generic" is not implemented/.test(issue.message),
        ),
        `expected opencode warning in install issues, got ${JSON.stringify(result.issues)}`,
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
      assert.deepEqual(
        activeServers.map((server) => server.id),
        ['bundle-mcp'],
      )
      assert.equal(activeServers[0]?.clients.includes('codex'), true)

      const codexConfig = await readFile(join(workspaceRoot, '.codex', 'config.toml'), 'utf8')
      assert.match(codexConfig, /\[mcp_servers\.bundle-mcp\]/)
      assert.match(codexConfig, /command = "node"/)
      assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'local-skill', 'SKILL.md')), true)

      const sender = createMockWebContents()
      await withElectronMock(join(temp, 'electron-user-data'), sender, async () => {
        const runtimeModule = (await import('../terminal-runtime')) as RuntimeModule
        const syncInputs: Array<{ settings: McpSettings; clients: string[] }> = []
        const runtime = runtimeModule.createTerminalRuntime({
          diagnosticsEnabled: false,
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
      assert.deepEqual(
        result.installed?.map((component) => component.kind),
        ['mcp'],
      )
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
      assert.deepEqual(
        result.installed.map((component) => component.kind),
        ['mcp', 'skills'],
      )
      // An mcp/skills bundle is in effect the moment it lands: nothing to relaunch.
      assert.equal(result.restartRequired, false)

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
        ['components.automation.trigger', 'components.automation.action'],
      )
      assert.equal(
        existsSync(join(workspaceRoot, '.codex', 'config.toml')),
        false,
        'preflight refuses before any component is written',
      )
    })
  }

  async function testAutomationAndSkillBundleInstallsBoth(): Promise<void> {
    await withTempDir(async (temp) => {
      // Each kind installs its own way in one bundle: the skill is copied into the
      // workspace harness dir, the automation becomes a definition in the
      // project's store. Neither path is a file copy for the other.
      const components: BundleComponents = {
        skills: { path: 'skills/local-skill' },
        automation: { path: 'automation/automation.json' },
      }
      const bundle = await createBundle(temp, components, { signed: false })
      const { input, services, workspaceRoot } = await installInput(temp, bundle)

      const result = await installMarketplacePlugin(input, services)

      assert.equal(result.ok, true, result.ok ? '' : result.message)
      if (!result.ok) return
      assert.deepEqual(
        result.installed.map((component) => component.kind),
        ['skills', 'automation'],
      )
      assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'local-skill', 'SKILL.md')), true)

      const automations = await installedAutomations(workspaceRoot)
      assert.equal(automations.length, 1)
      const automation = automations[0]
      assert.equal(automation.name, 'Nightly dependency sweep')
      assert.equal(automation.status, 'enabled', 'the payload ships paused; an added automation arrives on')
      assert.notEqual(automation.runInWorktree, false, 'a shelf item never opts the user out of run isolation')
      assert.equal(automation.nextRunAt !== null, true, 'scheduled at install, not at the next app start')
      assert.equal(automation.sourceCatalogueId, 'bundle-plugin', 'provenance is the catalogue entry, not the store id')
      assert.notEqual(automation.id, 'bundle-plugin', 'the store issues its own id')
      assert.equal(
        result.installed.find((component) => component.kind === 'automation')?.id,
        automation.id,
        'the receipt names the store-issued id, which is what update and uninstall have to work from',
      )
    })
  }

  async function testSecondInstallIntoSameProjectReportsAlreadyAdded(): Promise<void> {
    await withTempDir(async (temp) => {
      const components: BundleComponents = { automation: { path: 'automation/automation.json' } }
      const bundle = await createBundle(temp, components, { signed: false })
      const { input, services, workspaceRoot } = await installInput(temp, bundle)

      const first = await installMarketplacePlugin(input, services)
      const second = await installMarketplacePlugin(input, services)

      assert.equal(first.ok && second.ok, true)
      if (!first.ok || !second.ok) return
      assert.match(second.installed[0]?.message ?? '', /already added/i)
      assert.equal(second.installed[0]?.id, first.installed[0]?.id)
      assert.equal((await installedAutomations(workspaceRoot)).length, 1, 'a second Get creates nothing')
    })
  }

  async function testAutomationInstallWithNoCliRefusesBeforeAnyWrite(): Promise<void> {
    await withTempDir(async (temp) => {
      // The automation launches an agent and names no CLI of its own, so it would
      // resolve the app's last-selected CLI at 02:00 — with nobody there to pick
      // one. Refuse at install instead, and refuse before the sibling skill lands.
      const components: BundleComponents = {
        skills: { path: 'skills/local-skill' },
        automation: { path: 'automation/automation.json' },
      }
      const bundle = await createBundle(temp, components, { signed: false })
      const { input, services, workspaceRoot } = await installInput(temp, bundle, { automationDefaultCli: null })

      const result = await installMarketplacePlugin(input, services)

      assert.equal(result.ok, false)
      if (result.ok) return
      assert.equal(result.component, 'automation')
      assert.match(result.message, /no CLI is selected/i)
      assert.equal(result.installed, undefined, 'the plan fails before any component is installed')
      assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'local-skill', 'SKILL.md')), false)
      assert.equal((await installedAutomations(workspaceRoot)).length, 0)
    })
  }

  async function testAutomationInstallWithNoProjectRefuses(): Promise<void> {
    await withTempDir(async (temp) => {
      const components: BundleComponents = { automation: { path: 'automation/automation.json' } }
      const bundle = await createBundle(temp, components, { signed: false })
      const { input, services, workspaceRoot } = await installInput(temp, bundle)

      const result = await installMarketplacePlugin({ ...input, workspaceRoot: '  ' }, services)

      assert.equal(result.ok, false)
      if (result.ok) return
      assert.equal(result.component, 'automation')
      assert.match(result.message, /Open the project/)
      assert.equal((await installedAutomations(workspaceRoot)).length, 0, 'no project is guessed at')
    })
  }

  async function testAutomationInstallWithAutomationsOffRefuses(): Promise<void> {
    await withTempDir(async (temp) => {
      const components: BundleComponents = { automation: { path: 'automation/automation.json' } }
      const bundle = await createBundle(temp, components, { signed: false })
      const { input, services, workspaceRoot } = await installInput(temp, bundle, { automations: null })

      const result = await installMarketplacePlugin(input, services)

      assert.equal(result.ok, false)
      if (result.ok) return
      assert.equal(result.component, 'automation')
      assert.match(result.message, /Automations are switched off/)
      assert.equal((await installedAutomations(workspaceRoot)).length, 0)
    })
  }

  async function testAutomationNamingItsOwnCliNeedsNoFallback(): Promise<void> {
    await withTempDir(async (temp) => {
      // The CLI precondition is about the fallback, not about the kind: an
      // automation that names its own CLI installs with no last-selected one.
      const components: BundleComponents = {
        automation: {
          path: 'automation/automation.json',
          source: `${JSON.stringify(
            {
              name: 'Nightly dependency sweep',
              status: 'enabled',
              trigger: {
                kind: 'schedule',
                config: { kind: 'schedule', cadence: { type: 'daily', timeLocal: '03:00' }, timezone: 'UTC' },
              },
              action: { kind: 'spawn-agent', config: { prompt: 'Check for outdated dependencies.', cli: 'codex' } },
            },
            null,
            2,
          )}\n`,
        },
      }
      const bundle = await createBundle(temp, components, { signed: false })
      const { input, services, workspaceRoot } = await installInput(temp, bundle, { automationDefaultCli: null })

      const result = await installMarketplacePlugin(input, services)

      assert.equal(result.ok, true, result.ok ? '' : result.message)
      assert.equal((await installedAutomations(workspaceRoot)).length, 1)
    })
  }

  // The trust prompt discloses the BUNDLE's permissions, so a module manifest
  // asking for more than plugin.json declared would be trusted for access the
  // user never saw. The bundle is refused, before anything is written.
  async function testRejectsModuleDeclaringUndisclosedPermissionsBeforeWrites(): Promise<void> {
    await withTempDir(async (temp) => {
      const components: BundleComponents = {
        mcp: { path: 'mcp.json' },
        module: { path: 'module', permissions: ['network', 'process:spawn'] },
      }
      const bundle = await createBundle(temp, components)
      const { input, services, workspaceRoot, moduleRoot } = await installInput(temp, bundle)

      const result = await installMarketplacePlugin(input, services)

      assert.equal(result.ok, false)
      if (result.ok) return
      assert.equal(result.component, 'module')
      assert.match(result.message, /does not disclose: process:spawn/)
      assert.ok(
        result.issues?.some((issue) => issue.path === 'permissions' && /"process:spawn"/.test(issue.message)),
        `expected an undisclosed-permission issue, got ${JSON.stringify(result.issues)}`,
      )
      // Preflight refusal: the mcp component that sorts before the module in the
      // plan must not have been written either.
      assert.equal(existsSync(join(workspaceRoot, '.codex', 'config.toml')), false)
      assert.equal(existsSync(moduleRoot), false)
    })
  }

  // The install itself never writes trust; it reports the identity a grant would
  // bind to, which is what the lifecycle records after the whole bundle lands.
  async function testModuleComponentSurfacesTrustIdentity(): Promise<void> {
    await withTempDir(async (temp) => {
      const components: BundleComponents = { module: { path: 'module' } }
      const bundle = await createBundle(temp, components)
      const { input, services } = await installInput(temp, bundle)

      const result = await installMarketplacePlugin(input, services)

      assert.equal(result.ok, true, result.ok ? '' : result.message)
      if (!result.ok) return
      const module = result.installed.find((component) => component.kind === 'module')
      assert.equal(module?.trustStatus, 'unsigned', 'an unsigned module manifest reports its real status')
      assert.match(module?.manifestFp ?? '', /^[0-9a-f]{64}$/)
    })
  }

  // G1. A `verified` first-party bundle installs with no trust prompt, so a
  // module inside it must be signed by a trusted publisher in its own manifest.
  // An unsigned inner manifest is refused in preflight, before any file is
  // written — and the SAME bundle still installs when the caller has not claimed
  // it is verified.
  async function testVerifiedBundleRefusesUntrustedModuleManifestBeforeWrites(): Promise<void> {
    await withTempDir(async (temp) => {
      const components: BundleComponents = { module: { path: 'module' } }
      const bundle = await createBundle(temp, components)
      const { input, services, moduleRoot } = await installInput(temp, bundle)

      const refused = await installMarketplacePlugin(input, services, { requireTrustedModuleComponents: true })
      assert.equal(refused.ok, false)
      if (refused.ok) return
      assert.equal(refused.component, 'module')
      assert.match(refused.message, /must be signed by a trusted publisher/)
      assert.match(refused.message, /unsigned/)
      assert.deepEqual(refused.installed ?? [], [], 'nothing was written before the refusal')
      assert.equal(existsSync(join(moduleRoot, 'bundle-module')), false)

      // Not a blanket ban on the bundle: without the verified claim it installs.
      const installed = await installMarketplacePlugin(input, services)
      assert.equal(installed.ok, true)
    })
  }

  // The other half of G1: a module manifest signed by a publisher the trust
  // context lists installs through the verified path untouched.
  async function testVerifiedBundleAcceptsTrustedPublisherModuleManifest(): Promise<void> {
    await withTempDir(async (temp) => {
      const signer = moduleSigner()
      const bundle = await createBundle(temp, { module: { path: 'module', signer } })
      const { input, services, moduleRoot } = await installInput(temp, bundle)
      const trusted = {
        ...services,
        trustContext: () => ({ trustedModules: new Map(), trustedKeyFingerprints: new Set([signer.fingerprint]) }),
      }

      const result = await installMarketplacePlugin(input, trusted, { requireTrustedModuleComponents: true })
      assert.equal(result.ok, true)
      if (!result.ok) return
      const module = result.installed.find((component) => component.kind === 'module')
      assert.equal(module?.trustStatus, 'trusted')
      assert.equal(existsSync(join(moduleRoot, 'bundle-module', 'manifest.json')), true)

      // A module signed by SOMEBODY — but not a trusted publisher — is 'signed',
      // which the verified path still refuses: the standing has to be earned by
      // the key, not by carrying a signature at all.
      const strangerBundle = await createBundle(temp, { module: { path: 'module', signer: moduleSigner() } })
      const stranger = await installInput(temp, strangerBundle)
      const refused = await installMarketplacePlugin(stranger.input, trusted, { requireTrustedModuleComponents: true })
      assert.equal(refused.ok, false)
      if (refused.ok) return
      assert.match(refused.message, /is signed/)
    })
  }

  async function main(): Promise<void> {
    await testInstallsEveryComponentThroughRealPaths()
    await testVerifiedBundleRefusesUntrustedModuleManifestBeforeWrites()
    await testVerifiedBundleAcceptsTrustedPublisherModuleManifest()
    await testRejectsModuleDeclaringUndisclosedPermissionsBeforeWrites()
    await testModuleComponentSurfacesTrustIdentity()
    await testInstallsUnsignedMcpSkillsBundle()
    await testRejectsUnsignedModuleBundleBeforeWrites()
    await testRejectsUnsignedCliBundleBeforeWrites()
    await testRejectsAutomationPayloadThatIsNotADefinition()
    await testAutomationAndSkillBundleInstallsBoth()
    await testSecondInstallIntoSameProjectReportsAlreadyAdded()
    await testAutomationInstallWithNoCliRefusesBeforeAnyWrite()
    await testAutomationInstallWithNoProjectRefuses()
    await testAutomationInstallWithAutomationsOffRefuses()
    await testAutomationNamingItsOwnCliNeedsNoFallback()
    await testMcpFanOutWarningDoesNotReportCleanSuccess()
    await testLocalInstallRejectsSignedComponentDigestMismatchBeforeWrites()
    await testMcpSkillBundleIsVisibleAndLaunchesTerminalWithInstalledMcp()
    await testInvalidBundleSignatureRejectsBeforeWrites()
    await testPartialFailureReportsInstalledComponents()
    console.log('plugin-bundle-installer tests passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
