import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { McpSettings } from '../shared/electron-api'
import type { PluginManifest, PluginMcpConfigFormat } from '../shared/plugin-manifest'
import { MANAGED_SPRINTENGINE_MCP_SERVER_ID, createMcpConfigService, type PluginLookup } from './mcp-config-service'
import { MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR } from './sprintengine-managed-mcp-sync'
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

  const codexFileConflictRoot = join(temp, 'codex-file-conflict-workspace')
  await mkdir(codexFileConflictRoot, { recursive: true })
  await writeFile(join(codexFileConflictRoot, '.codex'), '', 'utf-8')
  const codexFileConflictResult = service.sync({
    workspaceRoot: codexFileConflictRoot,
    settings: codexSettings,
    clients: ['codex'],
  })
  assert.equal(codexFileConflictResult.ok, false)
  assert.equal(
    codexFileConflictResult.ok === false
      && codexFileConflictResult.message.includes('.codex')
      && codexFileConflictResult.message.includes('directory')
      && codexFileConflictResult.message.includes('file'),
    true,
    `Codex config parent file conflict should be reported as an actionable sync failure, got: ${JSON.stringify(codexFileConflictResult)}`
  )

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
        clients: ['claude-code'],
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
        clients: ['claude-code'],
        scope: 'workspace',
        source: 'bundled',
        riskLevel: 'network',
      },
    },
  }

  const claudeResult = service.sync({ workspaceRoot, settings: claudeSettings, clients: ['claude-code'] })
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

  // --- OpenCode writer (format 'opencode'): real bundled manifest ---
  const opencodeRoot = join(temp, 'opencode-workspace')
  await mkdir(join(opencodeRoot, '.multi-code', 'sprintengine', 'managed'), { recursive: true })
  const opencodeStatePath = join(opencodeRoot, '.multi-code', 'sprintengine', 'managed', 'run.yaml')
  await writeFile(opencodeStatePath, 'sprintengine:\n  name: managed\n  status: active\n', 'utf-8')
  const opencodeConfigPath = join(opencodeRoot, 'opencode.json')
  // Pre-existing user config: a top-level key and a user-authored server that must survive sync.
  await writeFile(
    opencodeConfigPath,
    JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      model: 'anthropic/claude-opus-4',
      mcp: { 'user-remote': { type: 'remote', url: 'https://user.example.com/mcp' } },
    }, null, 2),
    'utf-8'
  )
  const opencodeService = createMcpConfigService({
    lookupPlugin,
    homeDir: () => homeRoot,
    userDataDir: () => join(temp, 'opencode-user-data'),
    runtimeRoot: () => process.cwd(),
  })
  // The sync path consumes only statePath + http; build inline so this block
  // does not depend on the plugin-registry override set up later in this test.
  const opencodeManagedInput = {
    statePath: opencodeStatePath,
    workspaceRoot: opencodeRoot,
    actorId: 'workspace-user',
    http: {
      url: 'http://127.0.0.1:49160/mcp',
      authTokenEnvVar: MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR,
    },
  }
  const opencodeSettings: McpSettings = {
    syncEnabled: true,
    servers: {
      'local-helper': {
        id: 'local-helper',
        name: 'Local Helper',
        transport: 'stdio',
        command: 'node',
        args: ['/srv/helper.js', '--flag'],
        env: { HELPER_TOKEN: 'abc' },
        enabled: true,
        clients: ['opencode'],
        scope: 'workspace',
        source: 'custom',
        riskLevel: 'local-command',
      },
    },
  }
  const opencodeResult = opencodeService.sync({
    workspaceRoot: opencodeRoot,
    settings: opencodeSettings,
    clients: ['opencode'],
    managedSprintEngine: opencodeManagedInput,
  })
  assert.equal(opencodeResult.ok, true)
  const opencodeConfig = JSON.parse(await readFile(opencodeConfigPath, 'utf-8')) as {
    $schema?: string
    model?: string
    mcp: Record<string, Record<string, unknown>>
  }
  // Top-level user keys preserved.
  assert.equal(opencodeConfig.$schema, 'https://opencode.ai/config.json')
  assert.equal(opencodeConfig.model, 'anthropic/claude-opus-4')
  // User-authored server preserved.
  assert.deepEqual(opencodeConfig.mcp['user-remote'], { type: 'remote', url: 'https://user.example.com/mcp' })
  // Managed remote server: env-backed bearer via {env:VAR} interpolation, no literal token.
  assert.deepEqual(opencodeConfig.mcp[MANAGED_SPRINTENGINE_MCP_SERVER_ID], {
    type: 'remote',
    url: 'http://127.0.0.1:49160/mcp',
    headers: { Authorization: `Bearer {env:${MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR}}` },
  })
  // Local/stdio server: command string array + environment record.
  assert.deepEqual(opencodeConfig.mcp['local-helper'], {
    type: 'local',
    command: ['node', '/srv/helper.js', '--flag'],
    environment: { HELPER_TOKEN: 'abc' },
  })
  const opencodeRaw = await readFile(opencodeConfigPath, 'utf-8')
  assert.doesNotMatch(opencodeRaw, /\$\{/, 'opencode uses {env:VAR}, never shell-style ${VAR} interpolation')

  // Idempotent re-sync: no duplicated managed entry, same three servers.
  const opencodeRerun = opencodeService.sync({
    workspaceRoot: opencodeRoot,
    settings: opencodeSettings,
    clients: ['opencode'],
    managedSprintEngine: opencodeManagedInput,
  })
  assert.equal(opencodeRerun.ok, true)
  const opencodeConfigRerun = JSON.parse(await readFile(opencodeConfigPath, 'utf-8')) as {
    mcp: Record<string, unknown>
  }
  assert.deepEqual(
    Object.keys(opencodeConfigRerun.mcp).sort(),
    ['local-helper', 'user-remote', MANAGED_SPRINTENGINE_MCP_SERVER_ID].sort()
  )

  // Removing the managed server preserves user-authored + other managed servers.
  const opencodeCleanup = opencodeService.removeManagedSprintEngine({
    workspaceRoot: opencodeRoot,
    clients: ['opencode'],
  })
  assert.equal(opencodeCleanup.ok, true)
  const opencodeCleaned = JSON.parse(await readFile(opencodeConfigPath, 'utf-8')) as {
    mcp: Record<string, unknown>
  }
  assert.equal(Boolean(opencodeCleaned.mcp[MANAGED_SPRINTENGINE_MCP_SERVER_ID]), false)
  assert.deepEqual(opencodeCleaned.mcp['user-remote'], { type: 'remote', url: 'https://user.example.com/mcp' })
  assert.deepEqual(opencodeCleaned.mcp['local-helper'], {
    type: 'local',
    command: ['node', '/srv/helper.js', '--flag'],
    environment: { HELPER_TOKEN: 'abc' },
  })

  // Removing the only managed server strips the mcp block entirely, keeping other config.
  const opencodeSoloRoot = join(temp, 'opencode-solo-workspace')
  await mkdir(opencodeSoloRoot, { recursive: true })
  await writeFile(
    join(opencodeSoloRoot, 'opencode.json'),
    JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: { [MANAGED_SPRINTENGINE_MCP_SERVER_ID]: { type: 'remote', url: 'http://127.0.0.1:1/mcp' } },
    }, null, 2),
    'utf-8'
  )
  const opencodeSoloCleanup = opencodeService.removeManagedSprintEngine({
    workspaceRoot: opencodeSoloRoot,
    clients: ['opencode'],
  })
  assert.equal(opencodeSoloCleanup.ok, true)
  const opencodeSolo = JSON.parse(await readFile(join(opencodeSoloRoot, 'opencode.json'), 'utf-8')) as Record<string, unknown>
  assert.equal('mcp' in opencodeSolo, false, 'empty managed block should be stripped, not left as {}')
  assert.equal(opencodeSolo.$schema, 'https://opencode.ai/config.json')

  // Honest failure for a shape OpenCode cannot express (SSE): error issue, no fake write.
  const opencodeUnsupported = opencodeService.sync({
    workspaceRoot: opencodeRoot,
    clients: ['opencode'],
    settings: {
      syncEnabled: true,
      servers: {
        'sse-server': {
          id: 'sse-server',
          name: 'SSE Server',
          transport: 'sse',
          url: 'https://sse.example.com/mcp',
          enabled: true,
          required: true,
          clients: ['opencode'],
          scope: 'workspace',
          source: 'custom',
          riskLevel: 'network',
        },
      },
    },
  })
  assert.equal(opencodeUnsupported.ok, false)
  const opencodeUnsupportedIssues = opencodeUnsupported.issues ?? []
  assert.equal(
    opencodeUnsupportedIssues.some((issue) =>
      issue.level === 'error' && issue.serverId === 'sse-server' && issue.message.includes('SSE')
    ),
    true,
    `unsupported SSE shape should emit an error issue, got: ${JSON.stringify(opencodeUnsupportedIssues)}`
  )

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
  await mkdir(join(siblingRoot, '.codex'), { recursive: true })
  const managedStatePath = join(siblingRoot, '.multi-code', 'sprintengine', 'managed', 'run.yaml')
  await writeFile(managedStatePath, 'sprintengine:\n  name: managed\n  status: active\n', 'utf-8')
  await writeFile(
    join(siblingRoot, '.codex', 'config.toml'),
    [
      '[mcp_servers.unmanaged]',
      'url = "https://example.com/mcp"',
      'enabled = true',
      '',
    ].join('\n'),
    'utf-8'
  )
  await writeFile(
    join(siblingRoot, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        unmanaged: { type: 'http', url: 'https://example.com/mcp' },
      },
    }, null, 2),
    'utf-8'
  )
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
  const managedSettings: McpSettings = {
    syncEnabled: true,
    servers: {
      'managed-helper': {
        id: 'managed-helper',
        name: 'Managed Helper',
        transport: 'http',
        url: 'https://helper.example.com/mcp',
        enabled: true,
        clients: ['codex', 'claude-code'],
        scope: 'workspace',
        source: 'custom',
        riskLevel: 'low',
      },
    },
  }
  const managedHttpResult = managedService.sync({
    workspaceRoot: siblingRoot,
    settings: managedSettings,
    clients: ['codex', 'claude-code'],
    managedSprintEngine: {
      ...buildManagedSprintEngineSyncInputForLaunch(managedStatePath, siblingRoot),
      actorId: 'workspace-user',
      http: {
        url: 'http://127.0.0.1:49152/mcp',
        authTokenEnvVar: MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR,
      },
    },
  })
  assert.equal(managedHttpResult.ok, true)
  const managedHttpCodexConfig = await readFile(join(siblingRoot, '.codex', 'config.toml'), 'utf-8')
  assert.match(managedHttpCodexConfig, /\[mcp_servers\.unmanaged\]/)
  assert.match(managedHttpCodexConfig, /\[mcp_servers\.managed-helper\]/)
  assert.match(managedHttpCodexConfig, new RegExp(`\\[mcp_servers\\.${MANAGED_SPRINTENGINE_MCP_SERVER_ID}\\]`))
  assert.match(managedHttpCodexConfig, /url = "http:\/\/127\.0\.0\.1:49152\/mcp"/)
  assert.match(managedHttpCodexConfig, new RegExp(`bearer_token_env_var = "${MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR}"`))
  assert.doesNotMatch(managedHttpCodexConfig, /required = true/)
  assert.doesNotMatch(managedHttpCodexConfig, /Authorization/)
  assert.doesNotMatch(managedHttpCodexConfig, /X-Multicode-Session-Id/)
  assert.doesNotMatch(managedHttpCodexConfig, /env_http_headers/)
  assert.doesNotMatch(managedHttpCodexConfig, /session-a/)
  assert.doesNotMatch(managedHttpCodexConfig, /multicode-sprintengine-mcp/)
  assert.doesNotMatch(managedHttpCodexConfig, /--state-path/)
  assert.doesNotMatch(managedHttpCodexConfig, /SPRINTENGINE_STATE_PATH/)
  const managedHttpClaudeConfig = JSON.parse(await readFile(join(siblingRoot, '.mcp.json'), 'utf-8')) as {
    mcpServers: Record<string, { type: string, url: string, headers?: Record<string, string> }>
  }
  assert.deepEqual(managedHttpClaudeConfig.mcpServers[MANAGED_SPRINTENGINE_MCP_SERVER_ID], {
    type: 'http',
    url: 'http://127.0.0.1:49152/mcp',
    headers: {
      Authorization: `Bearer \${${MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR}}`,
    },
  })
  assert.deepEqual(managedHttpClaudeConfig.mcpServers.unmanaged, {
    type: 'http',
    url: 'https://example.com/mcp',
  })
  assert.deepEqual(managedHttpClaudeConfig.mcpServers['managed-helper'], {
    type: 'http',
    url: 'https://helper.example.com/mcp',
  })
  const managedHttpClaudeRaw = await readFile(join(siblingRoot, '.mcp.json'), 'utf-8')
  assert.doesNotMatch(managedHttpClaudeRaw, /multicode-sprintengine-mcp/)
  assert.doesNotMatch(managedHttpClaudeRaw, /--state-path/)
  assert.doesNotMatch(managedHttpClaudeRaw, /SPRINTENGINE_STATE_PATH/)
  assert.doesNotMatch(managedHttpClaudeRaw, /session-a/)

  const cleanupResult = managedService.removeManagedSprintEngine({
    workspaceRoot: siblingRoot,
    clients: ['codex', 'claude-code'],
  })
  assert.equal(cleanupResult.ok, true)
  const cleanedCodexConfig = await readFile(join(siblingRoot, '.codex', 'config.toml'), 'utf-8')
  assert.match(cleanedCodexConfig, /\[mcp_servers\.unmanaged\]/)
  assert.match(cleanedCodexConfig, /\[mcp_servers\.managed-helper\]/)
  assert.doesNotMatch(cleanedCodexConfig, new RegExp(MANAGED_SPRINTENGINE_MCP_SERVER_ID))
  const cleanedClaudeConfig = JSON.parse(await readFile(join(siblingRoot, '.mcp.json'), 'utf-8')) as {
    mcpServers: Record<string, unknown>
  }
  assert.deepEqual(cleanedClaudeConfig.mcpServers, {
    unmanaged: { type: 'http', url: 'https://example.com/mcp' },
    'managed-helper': { type: 'http', url: 'https://helper.example.com/mcp' },
  })

  const managedResult = managedService.sync({
    workspaceRoot: siblingRoot,
    settings: managedSettings,
    clients: ['codex', 'claude-code'],
    managedSprintEngine: {
      ...buildManagedSprintEngineSyncInputForLaunch(managedStatePath, siblingRoot),
      actorId: 'workspace-user',
    },
  })
  __resetPluginRegistryForTest()
  assert.equal(managedResult.ok, false)
  assert.equal(
    managedResult.ok === false && managedResult.message?.includes('Managed Sprint Engine HTTP MCP connection was not supplied'),
    true,
    `missing HTTP metadata should block managed launch, got: ${managedResult.ok === false ? managedResult.message : 'ok'}`
  )

  __setPluginRegistryForTest(launchRegistry, launchRegistryReport, userPluginRoot)
  const managedInputForFailures = buildManagedSprintEngineSyncInputForLaunch(managedStatePath, siblingRoot)
  const managedHttpInputForFailures = {
    ...managedInputForFailures,
    http: {
      url: 'http://127.0.0.1:49152/mcp',
      authTokenEnvVar: MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR,
    },
  }
  const missingRunTokenEnvResult = managedService.sync({
    workspaceRoot: siblingRoot,
    settings: { syncEnabled: false, servers: {} },
    clients: ['codex'],
    managedSprintEngine: {
      ...managedInputForFailures,
      http: {
        url: 'http://127.0.0.1:49152/mcp',
      },
    },
  })
  assert.equal(missingRunTokenEnvResult.ok, false)
  assert.equal(
    (missingRunTokenEnvResult.issues ?? []).some((issue) =>
      issue.level === 'error'
      && issue.message.includes('env-backed bearer token')
    ),
    true,
    `missing run-token env var should fail required managed HTTP sync, got: ${JSON.stringify(missingRunTokenEnvResult.issues ?? [])}`
  )
  __resetPluginRegistryForTest()

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
    managedSprintEngine: managedHttpInputForFailures,
  })
  assert.equal(noMcpResult.ok, false)
  const noMcpIssues = noMcpResult.issues ?? []
  assert.equal(
    noMcpIssues.some((issue) =>
      issue.level === 'error'
      && issue.message.includes('HTTP MCP config sync')
      && issue.message.includes('Sprint Engine autonomous mode requires')
    ),
    true,
    `missing-mcpConfig plugin should fail required sync, got: ${JSON.stringify(noMcpIssues)}`
  )

  const noMcpCapabilityLookup: PluginLookup = (id) => {
    if (id === 'codex') {
      return {
        manifest: {
          id: 'codex',
          displayName: 'Codex without MCP capability',
          version: 1,
          binary: 'codex',
          permissionPresets: {},
          launch: { argv: ['codex'] },
          promptInjection: { mode: 'positional-arg' },
          completion: { mode: 'process-exit' },
          capabilities: { resumeSession: false, sessionIdFromCaller: false, toolUse: true, mcpServers: false },
          mcpConfig: { path: '{{workspaceRoot}}/.codex/config.toml', format: 'codex' },
        } as PluginManifest,
      }
    }
    return undefined
  }
  const noMcpCapabilityService = createMcpConfigService({
    lookupPlugin: noMcpCapabilityLookup,
    homeDir: () => homeRoot,
    userDataDir: () => join(temp, 'no-mcp-capability-user-data'),
    runtimeRoot: () => process.cwd(),
  })
  const noMcpCapabilityResult = noMcpCapabilityService.sync({
    workspaceRoot: siblingRoot,
    settings: { syncEnabled: false, servers: {} },
    clients: ['codex'],
    managedSprintEngine: managedHttpInputForFailures,
  })
  assert.equal(noMcpCapabilityResult.ok, false)
  const noMcpCapabilityIssues = noMcpCapabilityResult.issues ?? []
  assert.equal(
    noMcpCapabilityIssues.some((issue) =>
      issue.level === 'error'
      && issue.message.includes('HTTP MCP servers')
      && issue.message.includes('Sprint Engine autonomous mode requires HTTP MCP support')
    ),
    true,
    `missing MCP capability should fail required sync, got: ${JSON.stringify(noMcpCapabilityIssues)}`
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
    managedSprintEngine: managedHttpInputForFailures,
  })
  assert.equal(unsupportedFormatResult.ok, false)
  const unsupportedFormatIssues = unsupportedFormatResult.issues ?? []
  assert.equal(
    unsupportedFormatIssues.some((issue) =>
      issue.level === 'error'
      && issue.message.includes('Sprint Engine autonomous mode requires')
      && issue.message.includes('HTTP MCP-capable config writer')
      && issue.message.includes('env-backed bearer token support')
    ),
    true,
    `unsupported format should fail required sync, got: ${JSON.stringify(unsupportedFormatIssues)}`
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
