import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { standIn } from '../../../tests/stand-in'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { WebContents } from 'electron'
import type { MarketplacePluginInstallInput, McpClientTarget, McpSettings } from '../../shared/electron-api'
import { canonicalManifestPayload, validateMarketplacePluginManifest } from '../../shared/marketplace'
import type { PluginManifest, PluginMcpConfigFormat } from '../../shared/plugin-manifest'
import { createMcpConfigService, type PluginLookup } from '../mcp-config-service'
import {
  canonicalManifestPayload as moduleCanonicalPayload,
  validateThirdPartyModuleManifest,
} from '../../shared/modules/third-party-manifest'
import { findMarketplaceResourcePath } from '../marketplace/resources'
import { readTrustedMarketplacePublisherFingerprintsSync } from '../marketplace/trusted-publishers'
import type { ModuleTrustContext } from './module-signature'
import { installMarketplacePlugin } from './plugin-bundle-installer'
import { planThirdPartyMainModules } from './third-party-main-loader'
import { discoverUserModules } from './user-module-registry'
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
    // A kind this Studio retired; built only to prove it is refused.
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
      // Signed the way `sprintengine-module sign` signs: with the digests of the
      // module's files, of which this one ships none besides its manifest.
      const withFiles = { ...moduleManifest, files: {} }
      const signed = components.module.signer
        ? { ...withFiles, signature: components.module.signer.sign(withFiles) }
        : moduleManifest
      files.set(`${components.module.path}/manifest.json`, `${JSON.stringify(signed, null, 2)}\n`)
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

  async function installInput(
    temp: string,
    bundle: string,
    options: {
      lookupPlugin?: PluginLookup
      mcpClients?: McpClientTarget[]
    } = {},
  ): Promise<{
    input: MarketplacePluginInstallInput
    services: Parameters<typeof installMarketplacePlugin>[1]
    workspaceRoot: string
    moduleRoot: string
  }> {
    const workspaceRoot = join(temp, 'workspace')
    const moduleRoot = join(temp, 'modules')
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
    return {
      input: {
        localFolder: bundle,
        workspaceRoot,
        mcpSettings,
        mcpClients: options.mcpClients ?? ['codex'],
        skillHarnesses: ['agents'],
      },
      services: {
        mcpConfigService,
        trustContext: () => ({ trustedModules: new Map() }),
        moduleRoot: () => moduleRoot,
      },
      workspaceRoot,
      moduleRoot,
    }
  }

  async function testInstallsEveryComponentThroughRealPaths(): Promise<void> {
    await withTempDir(async (temp) => {
      const components: BundleComponents = {
        mcp: { path: 'mcp.json' },
        skills: { path: 'skills/local-skill' },
        module: { path: 'module' },
      }
      const bundle = await createBundle(temp, components)
      const { input, services, workspaceRoot, moduleRoot } = await installInput(temp, bundle)

      const result = await installMarketplacePlugin(input, services)

      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.equal(result.trust, 'signed')
      assert.equal(result.loadEligible, false, 'signed but untrusted bundle is not auto-trusted')
      assert.deepEqual(
        result.installed.map((component) => component.kind),
        ['mcp', 'skills', 'module'],
      )
      // G7: the bundle landed a module, and no module outside
      // LIVE_ENABLED_MODULE_IDS loads until the app is launched again.
      assert.equal(result.restartRequired, true)
      assert.equal(result.mcpSettings?.servers['bundle-mcp']?.enabled, true)

      const codexConfig = await readFile(join(workspaceRoot, '.codex', 'config.toml'), 'utf8')
      assert.match(codexConfig, /\[mcp_servers\.bundle-mcp\]/)
      assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'local-skill', 'SKILL.md')), true)
      assert.equal(existsSync(join(moduleRoot, 'bundle-module', 'manifest.json')), true)
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
            const syncResult = await services.mcpConfigService.sync(syncInput)
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

  // The GitHub-URL lane: main may let an unsigned module through when the
  // person trusted it as code, and only then. It lands unsigned — nothing about
  // installing it makes it load; the trust decision is the lifecycle's.
  async function testUnsignedModuleInstallsOnlyWhenAllowed(): Promise<void> {
    await withTempDir(async (temp) => {
      const components: BundleComponents = { module: { path: 'module' } }
      const bundle = await createBundle(temp, components, { signed: false })
      const { input, services, moduleRoot } = await installInput(temp, bundle)

      const result = await installMarketplacePlugin(input, services, { allowUnsignedCode: true })

      assert.equal(result.ok, true, result.ok ? '' : result.message)
      if (!result.ok) return
      assert.equal(result.trust, 'unsigned')
      assert.equal(result.loadEligible, false)
      assert.equal(result.installed[0]?.trustStatus, 'unsigned')
      assert.equal(existsSync(join(moduleRoot, 'bundle-module', 'manifest.json')), true)
    })
  }

  async function testRefusesRetiredAutomationComponentBeforeWrites(): Promise<void> {
    await withTempDir(async (temp) => {
      // A bundle built for an older Studio, when automations shipped as files.
      // It is refused by name, before its sibling MCP server is written: an
      // install that quietly dropped one component would be an install that
      // did not do what the bundle said.
      const components: BundleComponents = {
        mcp: { path: 'mcp.json' },
        automation: { path: 'automation/automation.json' },
      }
      const bundle = await createBundle(temp, components, { signed: false })
      const { input, services, workspaceRoot } = await installInput(temp, bundle)

      const result = await installMarketplacePlugin(input, services)

      assert.equal(result.ok, false)
      if (result.ok) return
      assert.match(result.message, /Automation components are no longer supported/)
      assert.ok(result.issues?.some((issue) => issue.path === 'components.automation'))
      assert.equal(
        existsSync(join(workspaceRoot, '.codex', 'config.toml')),
        false,
        'preflight refuses before any component is written',
      )
    })
  }

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
    await testUnsignedModuleInstallsOnlyWhenAllowed()
    await testRefusesRetiredAutomationComponentBeforeWrites()
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

// The first-party review module's own manifest was signed before `files`
// existed, and nobody but the owner can re-sign it. Its bundle's plugin.json,
// signed by the same trusted publisher, digests every file of the module, so
// installing the bundle vouches for the module's code: the install records the
// content it verified, and discovery holds the folder to exactly that.
test('the shipped review bundle installs trusted, and code swapped in afterwards is refused', async () => {
  const bundlePath = findMarketplaceResourcePath('plugins/review')
  assert.ok(bundlePath)
  const temp = await mkdtemp(join(tmpdir(), 'mc-marketplace-review-'))
  try {
    const moduleRoot = join(temp, 'modules')
    const baseContext: ModuleTrustContext = {
      trustedModules: new Map(),
      trustedKeyFingerprints: readTrustedMarketplacePublisherFingerprintsSync({ isPackaged: true }),
    }
    const services: Parameters<typeof installMarketplacePlugin>[1] = {
      trustContext: () => baseContext,
      mcpConfigService: createMcpConfigService({ lookupPlugin: () => undefined, homeDir: () => join(temp, 'home') }),
      moduleRoot: () => moduleRoot,
    }

    const result = await installMarketplacePlugin({ localFolder: bundlePath }, services, {
      requireTrustedModuleComponents: true,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    const module = result.installed.find((component) => component.kind === 'module')
    assert.equal(module?.id, 'review')
    assert.equal(module?.trustStatus, 'trusted')
    assert.match(module?.manifestFp ?? '', /^[0-9a-f]{64}$/)

    // What the install receipt records is what vouches at every later launch.
    const vouched: ModuleTrustContext = {
      ...baseContext,
      verifiedModuleInstalls: new Map([['review', module!.manifestFp!]]),
    }
    const listed = await discoverUserModules(moduleRoot, vouched)
    assert.deepEqual(listed.rejected, [])
    assert.equal(listed.modules[0]?.trust.status, 'trusted')
    assert.equal(listed.modules[0]?.trust.via, 'publisher')
    assert.ok(listed.modules[0]?.trust.verifiedFiles?.['dist/main.cjs'])
    const planned = planThirdPartyMainModules(listed)
    assert.deepEqual(planned.ineligible, {}, 'the first-party module stays load eligible')

    // The review module signs its own `files`, so the first-party signature
    // covers its code even without the install record.
    const unvouched = await discoverUserModules(moduleRoot, baseContext)
    assert.deepEqual(unvouched.rejected, [])
    assert.equal(unvouched.modules[0]?.trust.status, 'trusted')

    // Code swapped in after the install no longer matches what was vouched for.
    await writeFile(join(moduleRoot, 'review', 'dist', 'main.cjs'), 'exports.registerMain = () => {}\n')
    const swapped = await discoverUserModules(moduleRoot, vouched)
    assert.deepEqual(swapped.modules, [], JSON.stringify(swapped.rejected))
    assert.ok(
      swapped.rejected[0]?.issues.some(
        (issue) => issue.path === 'files.dist/main.cjs' && /does not match the signed digests/.test(issue.message),
      ),
      JSON.stringify(swapped.rejected),
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

// The install prompt's grant is recorded for a signed module, and a grant
// covers code only through the module's own `files`. A signed module without
// them — outside a trusted publisher's bundle, whose digests vouch for it —
// would be granted and never load, so the bundle is refused before any write.
test('a signed module without file digests is refused unless a trusted publisher bundle vouches for it', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'mc-marketplace-undigested-'))
  try {
    const bundle = join(temp, 'bundle')
    const moduleDir = join(bundle, 'module')
    await mkdir(moduleDir, { recursive: true })
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const declaration = validateThirdPartyModuleManifest({ id: 'undigested', displayName: 'Undigested', version: 1 })
    assert.ok(declaration.ok)
    if (!declaration.ok) return
    const manifestSource = `${JSON.stringify({
      ...declaration.manifest,
      signature: {
        algorithm: 'ed25519',
        publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        signature: sign(null, Buffer.from(moduleCanonicalPayload(declaration.manifest), 'utf8'), privateKey).toString(
          'base64',
        ),
      },
    })}\n`
    await writeFile(join(moduleDir, 'manifest.json'), manifestSource)
    const unsignedBundle = {
      id: 'undigested-plugin',
      displayName: 'Undigested Plugin',
      version: 1,
      permissions: [],
      components: {
        module: {
          path: 'module',
          files: [{ path: 'module/manifest.json', sha256: createHash('sha256').update(manifestSource).digest('hex') }],
        },
      },
    }
    const bundleKeys = generateKeyPairSync('ed25519')
    const validated = validateMarketplacePluginManifest({
      ...unsignedBundle,
      signature: { algorithm: 'ed25519', publicKey: 'YWJj', signature: 'ZGVm' },
    })
    assert.ok(validated.ok)
    if (!validated.ok) return
    await writeFile(
      join(bundle, 'plugin.json'),
      JSON.stringify({
        ...validated.manifest,
        signature: {
          algorithm: 'ed25519',
          publicKey: bundleKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
          signature: sign(
            null,
            Buffer.from(canonicalManifestPayload(validated.manifest), 'utf8'),
            bundleKeys.privateKey,
          ).toString('base64'),
        },
      }),
    )
    const moduleRoot = join(temp, 'modules')
    const result = await installMarketplacePlugin(
      { localFolder: bundle },
      {
        trustContext: () => ({ trustedModules: new Map() }),
        mcpConfigService: createMcpConfigService({ lookupPlugin: () => undefined, homeDir: () => join(temp, 'home') }),
        moduleRoot: () => moduleRoot,
      },
    )
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.component, 'module')
    assert.match(result.message, /lists no digests of its code/)
    assert.equal(existsSync(join(moduleRoot, 'undigested')), false)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
