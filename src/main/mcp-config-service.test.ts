import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { McpSettings } from '../shared/electron-api'
import type { PluginManifest, PluginMcpConfigFormat } from '../shared/plugin-manifest'
import { MANAGED_SPRINTENGINE_MCP_SERVER_ID, createMcpConfigService, type PluginLookup } from './mcp-config-service'
import { createPluginRegistry } from './plugin-registry'
import { __resetPluginRegistryForTest, __setPluginRegistryForTest } from './plugin-registry-instance'
import { buildManagedSprintEngineSyncInputForLaunch } from './terminal-runtime'

const BUNDLED_ROOT = join(process.cwd(), 'resources', 'plugins')

async function main(): Promise<void> {
  const registry = createPluginRegistry({
    bundledRoot: BUNDLED_ROOT,
    userRoot: join(process.cwd(), '.does-not-exist', 'multicode', 'plugins'),
  })
  const report = registry.loadSync()
  assert.deepEqual(report.rejected, [], `bundled plugins should validate: ${JSON.stringify(report.rejected)}`)
  const lookupPlugin: PluginLookup = (id) => {
    const plugin = registry.get(id)
    return plugin ? { manifest: plugin.manifest as PluginManifest } : undefined
  }

  const temp = await mkdtemp(join(tmpdir(), 'multicode-mcp-config-'))
  const workspaceRoot = join(temp, 'workspace')
  await mkdir(workspaceRoot, { recursive: true })

  const homeRoot = join(temp, 'home')
  await mkdir(homeRoot, { recursive: true })

  const service = createMcpConfigService({
    lookupPlugin,
    homeDir: () => homeRoot,
    userDataDir: () => join(temp, 'user-data'),
  })
  const codexSettings: McpSettings = {
    syncEnabled: true,
    servers: {
      context7: {
        id: 'context7',
        name: 'Context7',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
        envVarNames: ['CONTEXT7_TOKEN'],
        enabled: true,
        clients: ['codex'],
        scope: 'workspace',
        source: 'bundled',
        riskLevel: 'network',
      },
      figma: {
        id: 'figma',
        name: 'Figma',
        transport: 'http',
        url: 'https://mcp.figma.com/mcp',
        envVarNames: ['FIGMA_OAUTH_TOKEN'],
        enabled: true,
        clients: ['codex'],
        scope: 'workspace',
        source: 'bundled',
        riskLevel: 'secrets',
      },
    },
  }

  const codexResult = service.sync({ workspaceRoot, settings: codexSettings, clients: ['codex'] })
  assert.equal(codexResult.ok, true)
  const codexConfig = await readFile(join(workspaceRoot, '.codex', 'config.toml'), 'utf-8')
  assert.match(codexConfig, /\[mcp_servers\.context7\]/)
  assert.match(codexConfig, /env_vars = \["CONTEXT7_TOKEN"\]/)
  assert.match(codexConfig, /\[mcp_servers\.figma\]/)
  assert.match(codexConfig, /bearer_token_env_var = "FIGMA_OAUTH_TOKEN"/)

  const claudePath = join(workspaceRoot, '.mcp.json')
  await writeFile(
    claudePath,
    JSON.stringify({
      mcpServers: {
        unmanaged: { type: 'http', url: 'https://example.com/mcp' },
        context7: { type: 'stdio', command: 'old', args: [] },
      },
    }, null, 2),
    'utf-8'
  )

  const claudeSettings: McpSettings = {
    syncEnabled: true,
    servers: {
      context7: {
        id: 'context7',
        name: 'Context7',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
        enabled: false,
        clients: ['claude'],
        scope: 'workspace',
        source: 'bundled',
        riskLevel: 'network',
      },
      sentry: {
        id: 'sentry',
        name: 'Sentry',
        transport: 'http',
        url: 'https://mcp.sentry.dev/mcp',
        enabled: true,
        clients: ['claude'],
        scope: 'workspace',
        source: 'bundled',
        riskLevel: 'network',
      },
    },
  }

  const claudeResult = service.sync({ workspaceRoot, settings: claudeSettings, clients: ['claude'] })
  assert.equal(claudeResult.ok, true)
  const claudeConfig = JSON.parse(await readFile(claudePath, 'utf-8')) as {
    mcpServers: Record<string, unknown>
  }
  assert.equal(Boolean(claudeConfig.mcpServers.unmanaged), true)
  assert.equal(Boolean(claudeConfig.mcpServers.context7), false)
  assert.deepEqual(claudeConfig.mcpServers.sentry, {
    type: 'http',
    url: 'https://mcp.sentry.dev/mcp',
  })

  const blocked = service.sync({
    workspaceRoot,
    clients: ['codex'],
    settings: {
      syncEnabled: true,
      servers: {
        required: {
          id: 'required',
          name: 'Required',
          transport: 'stdio',
          command: 'definitely-missing-mcp-command',
          enabled: true,
          required: true,
          clients: ['codex'],
          scope: 'workspace',
          source: 'custom',
          riskLevel: 'local-command',
        },
      },
    },
  })
  assert.equal(blocked.ok, false)

  const pluginManifest = (id: string, format: PluginMcpConfigFormat): PluginManifest => ({
    id,
    displayName: id,
    version: 1,
    binary: id,
    permissionPresets: {},
    launch: { argv: ['{{binary}}'] },
    promptInjection: { mode: 'positional-arg' },
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
  })

  const pluginLookup: PluginLookup = (id) => {
    if (id === 'third-party-codex') return { manifest: pluginManifest(id, 'codex') }
    if (id === 'generic-agent') return { manifest: pluginManifest(id, 'generic') }
    return lookupPlugin(id)
  }
  const pluginService = createMcpConfigService({
    lookupPlugin: pluginLookup,
    homeDir: () => homeRoot,
  })
  const pluginSettings: McpSettings = {
    syncEnabled: true,
    servers: {
      pluginContext: {
        id: 'plugin-context',
        name: 'Plugin Context',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
        enabled: true,
        clients: ['third-party-codex'],
        scope: 'workspace',
        source: 'custom',
        riskLevel: 'network',
      },
    },
  }

  const pluginResult = pluginService.sync({
    workspaceRoot,
    settings: pluginSettings,
    clients: ['third-party-codex'],
  })
  assert.equal(pluginResult.ok, true)
  assert.deepEqual(pluginResult.targets.map((target) => target.client), ['third-party-codex'])
  const pluginConfig = await readFile(join(workspaceRoot, '.third-party-codex', 'config.toml'), 'utf-8')
  assert.match(pluginConfig, /\[mcp_servers\.plugin-context\]/)

  const unsupportedResult = pluginService.sync({
    workspaceRoot,
    clients: ['generic-agent'],
    settings: {
      syncEnabled: true,
      servers: {
        generic: {
          id: 'generic',
          name: 'Generic',
          transport: 'http',
          url: 'https://example.com/mcp',
          enabled: true,
          clients: ['generic-agent'],
          scope: 'workspace',
          source: 'custom',
          riskLevel: 'network',
        },
      },
    },
  })
  assert.equal(unsupportedResult.ok, true)
  assert.deepEqual(unsupportedResult.targets, [])
  assert.equal(
    unsupportedResult.issues.some((issue) =>
      issue.level === 'warning'
      && issue.client === 'generic-agent'
      && issue.message.includes('format "generic"')
    ),
    true
  )

  const siblingRoot = join(temp, 'sibling-workspace')
  await mkdir(join(siblingRoot, '.multi-code', 'sprintengine', 'managed'), { recursive: true })
  const managedStatePath = join(siblingRoot, '.multi-code', 'sprintengine', 'managed', 'run.yaml')
  await writeFile(managedStatePath, 'sprintengine:\n  name: managed\n  status: active\n', 'utf-8')
  const userPluginRoot = join(temp, 'user-plugins')
  const pluginRoot = join(userPluginRoot, 'writer-plugin')
  const soulsRoot = join(pluginRoot, 'sprintengine-souls')
  await mkdir(join(soulsRoot, 'roles'), { recursive: true })
  await mkdir(join(soulsRoot, 'skills', 'plugin_writer'), { recursive: true })
  await writeFile(
    join(pluginRoot, 'plugin.json'),
    JSON.stringify({
      id: 'writer-plugin',
      displayName: 'Writer Plugin',
      version: 1,
      binary: 'writer',
      permissionPresets: { default: { label: 'Default', args: [] } },
      launch: { argv: ['writer'] },
      promptInjection: { mode: 'stdin-pipe' },
      completion: { mode: 'process-exit' },
      capabilities: { resumeSession: false, sessionIdFromCaller: false, toolUse: false, mcpServers: false },
      souls: { directory: 'sprintengine-souls' },
    }),
    'utf-8'
  )
  const launchRegistry = createPluginRegistry({ bundledRoot: join(temp, 'empty-bundled-plugins'), userRoot: userPluginRoot })
  const launchRegistryReport = launchRegistry.loadSync()
  __setPluginRegistryForTest(launchRegistry, launchRegistryReport, userPluginRoot)
  const managedService = createMcpConfigService({
    lookupPlugin,
    homeDir: () => homeRoot,
    userDataDir: () => join(temp, 'managed-user-data'),
    runtimeRoot: () => process.cwd(),
  })
  const managedSettings: McpSettings = { syncEnabled: false, servers: {} }
  const managedResult = managedService.sync({
    workspaceRoot: siblingRoot,
    settings: managedSettings,
    clients: ['codex', 'claude'],
    managedSprintEngine: {
      ...buildManagedSprintEngineSyncInputForLaunch(managedStatePath, siblingRoot),
      actorId: 'workspace-user',
    },
  })
  __resetPluginRegistryForTest()
  assert.equal(managedResult.ok, true)

  const managedCodexConfig = await readFile(join(siblingRoot, '.codex', 'config.toml'), 'utf-8')
  assert.match(managedCodexConfig, new RegExp(`\\[mcp_servers\\.${MANAGED_SPRINTENGINE_MCP_SERVER_ID}\\]`))
  assert.match(managedCodexConfig, /--state-path/)
  assert.match(managedCodexConfig, /SPRINTENGINE_MCP_USER_AUTHORIZED/)

  const managedClaudeConfig = JSON.parse(await readFile(join(siblingRoot, '.mcp.json'), 'utf-8')) as {
    mcpServers: Record<string, { command: string, args: string[], env: Record<string, string> }>
  }
  const managedClaudeServer = managedClaudeConfig.mcpServers[MANAGED_SPRINTENGINE_MCP_SERVER_ID]
  assert.equal(Boolean(managedClaudeServer), true)
  assert.equal(managedClaudeServer.env.SPRINTENGINE_MCP_USER_ID, 'workspace-user')
  assert.equal(managedClaudeServer.env.SPRINTENGINE_MCP_USER_AUTHORIZED, '1')
  assert.equal(managedClaudeServer.args.includes('--workspace'), true)
  assert.equal(managedClaudeServer.args.includes(siblingRoot), true)
  assert.deepEqual(
    managedClaudeServer.args.slice(
      managedClaudeServer.args.indexOf('--extra-dir'),
      managedClaudeServer.args.indexOf('--extra-dir') + 2
    ),
    ['--extra-dir', soulsRoot]
  )
  assert.deepEqual(
    managedClaudeServer.args.slice(
      managedClaudeServer.args.indexOf('--user-dir'),
      managedClaudeServer.args.indexOf('--user-dir') + 2
    ),
    ['--user-dir', userPluginRoot]
  )

  const mcpMessage = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'sprintengine.roles.list',
      arguments: { workspaceRoot: siblingRoot },
    },
  }
  const launched = spawnSync(managedClaudeServer.command, managedClaudeServer.args, {
    cwd: siblingRoot,
    env: { ...process.env, ...managedClaudeServer.env },
    input: `${JSON.stringify(mcpMessage)}\n`,
    encoding: 'utf-8',
    timeout: 10_000,
  })
  assert.equal(launched.status, 0, launched.stderr || launched.error?.message)
  const response = JSON.parse(launched.stdout.trim()) as {
    result: { ok: boolean, result: { roles: Array<{ id: string }> } }
  }
  assert.equal(response.result.ok, true)
  assert.equal(response.result.result.roles.some((role) => role.id === 'developer'), true)

  __setPluginRegistryForTest(launchRegistry, launchRegistryReport, userPluginRoot)
  const managedInputForFailures = buildManagedSprintEngineSyncInputForLaunch(managedStatePath, siblingRoot)
  __resetPluginRegistryForTest()

  const missingRuntimeService = createMcpConfigService({
    lookupPlugin,
    homeDir: () => homeRoot,
    userDataDir: () => join(temp, 'missing-runtime-user-data'),
    runtimeRoot: () => null,
  })
  const missingRuntimeResult = missingRuntimeService.sync({
    workspaceRoot: siblingRoot,
    settings: { syncEnabled: false, servers: {} },
    clients: ['codex'],
    managedSprintEngine: managedInputForFailures,
  })
  assert.equal(missingRuntimeResult.ok, false)
  assert.equal(
    missingRuntimeResult.ok === false && missingRuntimeResult.message?.includes('Bundled Sprint Engine MCP runtime was not found.'),
    true,
    `missing runtime should surface the launcher diagnostic, got: ${missingRuntimeResult.ok === false ? missingRuntimeResult.message : 'ok'}`
  )

  const noMcpPluginLookup: PluginLookup = () => undefined
  const noMcpService = createMcpConfigService({
    lookupPlugin: noMcpPluginLookup,
    homeDir: () => homeRoot,
    userDataDir: () => join(temp, 'no-mcp-plugin-user-data'),
    runtimeRoot: () => process.cwd(),
  })
  const noMcpResult = noMcpService.sync({
    workspaceRoot: siblingRoot,
    settings: { syncEnabled: false, servers: {} },
    clients: ['codex'],
    managedSprintEngine: managedInputForFailures,
  })
  assert.equal(noMcpResult.ok, false)
  const noMcpIssues = noMcpResult.issues ?? []
  assert.equal(
    noMcpIssues.some((issue) => issue.level === 'error' && issue.message.includes('does not support MCP config sync')),
    true,
    `missing-mcpConfig plugin should fail required sync, got: ${JSON.stringify(noMcpIssues)}`
  )

  const unsupportedFormatLookup: PluginLookup = (id) => {
    if (id === 'codex') {
      return {
        manifest: {
          id: 'codex',
          displayName: 'Codex (generic)',
          version: 1,
          binary: 'codex',
          permissionPresets: {},
          launch: { argv: ['codex'] },
          promptInjection: { mode: 'positional-arg' },
          completion: { mode: 'process-exit' },
          capabilities: { resumeSession: false, sessionIdFromCaller: false, toolUse: true, mcpServers: true },
          mcpConfig: { path: '{{workspaceRoot}}/.codex/config.toml', format: 'generic' },
        } as PluginManifest,
      }
    }
    return undefined
  }
  const unsupportedFormatService = createMcpConfigService({
    lookupPlugin: unsupportedFormatLookup,
    homeDir: () => homeRoot,
    userDataDir: () => join(temp, 'unsupported-format-user-data'),
    runtimeRoot: () => process.cwd(),
  })
  const unsupportedFormatResult = unsupportedFormatService.sync({
    workspaceRoot: siblingRoot,
    settings: { syncEnabled: false, servers: {} },
    clients: ['codex'],
    managedSprintEngine: managedInputForFailures,
  })
  assert.equal(unsupportedFormatResult.ok, false)
  const unsupportedFormatIssues = unsupportedFormatResult.issues ?? []
  assert.equal(
    unsupportedFormatIssues.some((issue) => issue.level === 'error' && issue.message.includes('cannot launch a Sprint Engine agent')),
    true,
    `unsupported format should fail required sync, got: ${JSON.stringify(unsupportedFormatIssues)}`
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
