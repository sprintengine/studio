import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { McpSettings } from '../shared/electron-api'
import type { PluginManifest, PluginMcpConfigFormat } from '../shared/plugin-manifest'
import { STUDIO_MCP_SERVER_ID } from '../shared/product-identity'
import { createMcpConfigService, RETIRED_SPRINTENGINE_MCP_SERVER_ID, type PluginLookup } from './mcp-config-service'
import { syncStudioMcpConfig } from './studio-mcp-sync'
import { createPluginRegistry } from './plugin-registry'
import { test } from 'vitest'

test('mcp-config-service', async () => {
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
      codexFileConflictResult.ok === false &&
        codexFileConflictResult.message.includes('.codex') &&
        codexFileConflictResult.message.includes('directory') &&
        codexFileConflictResult.message.includes('file'),
      true,
      `Codex config parent file conflict should be reported as an actionable sync failure, got: ${JSON.stringify(codexFileConflictResult)}`,
    )

    const claudePath = join(workspaceRoot, '.mcp.json')
    await writeFile(
      claudePath,
      JSON.stringify(
        {
          mcpServers: {
            unmanaged: { type: 'http', url: 'https://example.com/mcp' },
            context7: { type: 'stdio', command: 'old', args: [] },
          },
        },
        null,
        2,
      ),
      'utf-8',
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

    await mkdir(join(workspaceRoot, '.claude'), { recursive: true })
    await writeFile(
      join(workspaceRoot, '.claude', 'settings.local.json'),
      JSON.stringify(
        {
          theme: 'dark',
          enabledMcpjsonServers: ['user-server', STUDIO_MCP_SERVER_ID],
          disabledMcpjsonServers: ['disabled-user-server', STUDIO_MCP_SERVER_ID],
        },
        null,
        2,
      ),
      'utf-8',
    )
    const studioClaudeResult = service.sync({
      workspaceRoot,
      clients: ['claude-code'],
      settings: {
        syncEnabled: true,
        servers: {
          [STUDIO_MCP_SERVER_ID]: {
            id: STUDIO_MCP_SERVER_ID,
            name: 'SprintEngine Studio MCP',
            transport: 'stdio',
            command: process.execPath,
            args: [join(process.cwd(), 'resources', 'automation', 'mcp-stdio-bridge.mjs')],
            enabled: true,
            required: true,
            clients: ['claude-code'],
            scope: 'workspace',
            source: 'bundled',
            riskLevel: 'local-command',
          },
        },
      },
    })
    assert.equal(studioClaudeResult.ok, true, JSON.stringify(studioClaudeResult))
    const claudeLocalSettings = JSON.parse(
      await readFile(join(workspaceRoot, '.claude', 'settings.local.json'), 'utf-8'),
    ) as Record<string, unknown>
    assert.equal(claudeLocalSettings.theme, 'dark', 'unrelated Claude settings are preserved')
    assert.deepEqual(claudeLocalSettings.enabledMcpjsonServers, ['user-server', STUDIO_MCP_SERVER_ID])
    assert.deepEqual(claudeLocalSettings.disabledMcpjsonServers, ['disabled-user-server'])

    // --- OpenCode writer (format 'opencode'): real bundled manifest ---
    const opencodeRoot = join(temp, 'opencode-workspace')
    await mkdir(opencodeRoot, { recursive: true })
    const opencodeConfigPath = join(opencodeRoot, 'opencode.json')
    // Pre-existing user config: a top-level key and a user-authored server that must survive sync.
    await writeFile(
      opencodeConfigPath,
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          model: 'anthropic/claude-opus-4',
          mcp: { 'user-remote': { type: 'remote', url: 'https://user.example.com/mcp' } },
        },
        null,
        2,
      ),
      'utf-8',
    )
    const opencodeService = createMcpConfigService({
      lookupPlugin,
      homeDir: () => homeRoot,
      userDataDir: () => join(temp, 'opencode-user-data'),
    })
    const opencodeSettings: McpSettings = {
      syncEnabled: true,
      servers: {
        'env-remote': {
          id: 'env-remote',
          name: 'Env Remote',
          transport: 'http',
          url: 'http://127.0.0.1:49160/mcp',
          envVarNames: ['ENV_REMOTE_TOKEN'],
          enabled: true,
          clients: ['opencode'],
          scope: 'workspace',
          source: 'custom',
          riskLevel: 'network',
        },
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
    // Env-backed remote server: bearer via {env:VAR} interpolation, no literal token.
    assert.deepEqual(opencodeConfig.mcp['env-remote'], {
      type: 'remote',
      url: 'http://127.0.0.1:49160/mcp',
      headers: { Authorization: 'Bearer {env:ENV_REMOTE_TOKEN}' },
    })
    // Local/stdio server: command string array + environment record.
    assert.deepEqual(opencodeConfig.mcp['local-helper'], {
      type: 'local',
      command: ['node', '/srv/helper.js', '--flag'],
      environment: { HELPER_TOKEN: 'abc' },
    })
    const opencodeRaw = await readFile(opencodeConfigPath, 'utf-8')
    assert.doesNotMatch(opencodeRaw, /\$\{/, 'opencode uses {env:VAR}, never shell-style ${VAR} interpolation')

    // Idempotent re-sync: no duplicated entry, same three servers.
    const opencodeRerun = opencodeService.sync({
      workspaceRoot: opencodeRoot,
      settings: opencodeSettings,
      clients: ['opencode'],
    })
    assert.equal(opencodeRerun.ok, true)
    const opencodeConfigRerun = JSON.parse(await readFile(opencodeConfigPath, 'utf-8')) as {
      mcp: Record<string, unknown>
    }
    assert.deepEqual(Object.keys(opencodeConfigRerun.mcp).sort(), ['local-helper', 'user-remote', 'env-remote'].sort())

    // Forgetting a server takes its entry out and leaves the user's own alone.
    const opencodeForget = opencodeService.sync({
      workspaceRoot: opencodeRoot,
      settings: { syncEnabled: true, servers: {} },
      clients: ['opencode'],
      forgetServerIds: ['env-remote'],
    })
    assert.equal(opencodeForget.ok, true)
    const opencodeCleaned = JSON.parse(await readFile(opencodeConfigPath, 'utf-8')) as {
      mcp: Record<string, unknown>
    }
    assert.equal('env-remote' in opencodeCleaned.mcp, false)
    assert.deepEqual(opencodeCleaned.mcp['user-remote'], { type: 'remote', url: 'https://user.example.com/mcp' })

    // Forgetting the only server strips the mcp block entirely, keeping other config.
    const opencodeSoloRoot = join(temp, 'opencode-solo-workspace')
    await mkdir(opencodeSoloRoot, { recursive: true })
    await writeFile(
      join(opencodeSoloRoot, 'opencode.json'),
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          mcp: { 'env-remote': { type: 'remote', url: 'http://127.0.0.1:1/mcp' } },
        },
        null,
        2,
      ),
      'utf-8',
    )
    const opencodeSoloCleanup = opencodeService.sync({
      workspaceRoot: opencodeSoloRoot,
      settings: { syncEnabled: true, servers: {} },
      clients: ['opencode'],
      forgetServerIds: ['env-remote'],
    })
    assert.equal(opencodeSoloCleanup.ok, true)
    const opencodeSolo = JSON.parse(await readFile(join(opencodeSoloRoot, 'opencode.json'), 'utf-8')) as Record<
      string,
      unknown
    >
    assert.equal('mcp' in opencodeSolo, false, 'an emptied block is stripped, not left as {}')
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
      opencodeUnsupportedIssues.some(
        (issue) => issue.level === 'error' && issue.serverId === 'sse-server' && issue.message.includes('SSE'),
      ),
      true,
      `unsupported SSE shape should emit an error issue, got: ${JSON.stringify(opencodeUnsupportedIssues)}`,
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
    assert.deepEqual(
      pluginResult.targets.map((target) => target.client),
      ['third-party-codex'],
    )
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
      unsupportedResult.issues.some(
        (issue) =>
          issue.level === 'warning' && issue.client === 'generic-agent' && issue.message.includes('format "generic"'),
      ),
      true,
    )

    const siblingRoot = join(temp, 'sibling-workspace')
    await mkdir(join(siblingRoot, '.codex'), { recursive: true })
    await writeFile(
      join(siblingRoot, '.codex', 'config.toml'),
      ['[mcp_servers.unmanaged]', 'url = "https://example.com/mcp"', 'enabled = true', ''].join('\n'),
      'utf-8',
    )
    await writeFile(
      join(siblingRoot, '.mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            unmanaged: { type: 'http', url: 'https://example.com/mcp' },
          },
        },
        null,
        2,
      ),
      'utf-8',
    )
    const managedService = createMcpConfigService({
      lookupPlugin,
      homeDir: () => homeRoot,
      userDataDir: () => join(temp, 'managed-user-data'),
    })
    const managedSettings: McpSettings = {
      syncEnabled: true,
      servers: {
        'env-bearer': {
          id: 'env-bearer',
          name: 'Env Bearer',
          transport: 'http',
          url: 'http://127.0.0.1:49152/mcp',
          envVarNames: ['ENV_BEARER_TOKEN'],
          enabled: true,
          clients: ['codex', 'claude-code'],
          scope: 'workspace',
          source: 'custom',
          riskLevel: 'network',
        },
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
    })
    assert.equal(managedHttpResult.ok, true)
    const managedHttpCodexConfig = await readFile(join(siblingRoot, '.codex', 'config.toml'), 'utf-8')
    assert.match(managedHttpCodexConfig, /\[mcp_servers\.unmanaged\]/)
    assert.match(managedHttpCodexConfig, /\[mcp_servers\.managed-helper\]/)
    assert.match(managedHttpCodexConfig, /\[mcp_servers\.env-bearer\]/)
    assert.match(managedHttpCodexConfig, /url = "http:\/\/127\.0\.0\.1:49152\/mcp"/)
    // Codex names the env var it reads the bearer from; the token itself is never written.
    assert.match(managedHttpCodexConfig, /bearer_token_env_var = "ENV_BEARER_TOKEN"/)
    assert.doesNotMatch(managedHttpCodexConfig, /required = true/)
    assert.doesNotMatch(managedHttpCodexConfig, /Authorization/)
    assert.doesNotMatch(managedHttpCodexConfig, /env_http_headers/)
    const managedHttpClaudeConfig = JSON.parse(await readFile(join(siblingRoot, '.mcp.json'), 'utf-8')) as {
      mcpServers: Record<string, { type: string; url: string; headers?: Record<string, string> }>
    }
    // Claude Code interpolates ${VAR}; again the value stays in the environment.
    assert.deepEqual(managedHttpClaudeConfig.mcpServers['env-bearer'], {
      type: 'http',
      url: 'http://127.0.0.1:49152/mcp',
      headers: {
        Authorization: 'Bearer ${ENV_BEARER_TOKEN}',
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

    // A REQUIRED server is what makes a missing writer an error rather than a
    // skipped CLI: the app promised that server to the agent it is about to
    // launch, so a silent skip would launch it without one.
    const requiredCodexSettings: McpSettings = {
      syncEnabled: true,
      servers: {
        'required-gateway': {
          id: 'required-gateway',
          name: 'Required Gateway',
          transport: 'http',
          url: 'http://127.0.0.1:49152/mcp',
          enabled: true,
          required: true,
          clients: ['codex'],
          scope: 'workspace',
          source: 'bundled',
          riskLevel: 'network',
        },
      },
    }

    const noMcpPluginLookup: PluginLookup = () => undefined
    const noMcpService = createMcpConfigService({
      lookupPlugin: noMcpPluginLookup,
      homeDir: () => homeRoot,
      userDataDir: () => join(temp, 'no-mcp-plugin-user-data'),
    })
    const noMcpResult = noMcpService.sync({
      workspaceRoot: siblingRoot,
      settings: requiredCodexSettings,
      clients: ['codex'],
    })
    assert.equal(noMcpResult.ok, false)
    const noMcpIssues = noMcpResult.issues ?? []
    assert.equal(
      noMcpIssues.some(
        (issue) =>
          issue.level === 'error' &&
          issue.message.includes('no MCP config writer') &&
          issue.message.includes('Studio-launched agents require'),
      ),
      true,
      `missing-mcpConfig plugin should fail required sync, got: ${JSON.stringify(noMcpIssues)}`,
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
    })
    const noMcpCapabilityResult = noMcpCapabilityService.sync({
      workspaceRoot: siblingRoot,
      settings: requiredCodexSettings,
      clients: ['codex'],
    })
    assert.equal(noMcpCapabilityResult.ok, false)
    const noMcpCapabilityIssues = noMcpCapabilityResult.issues ?? []
    assert.equal(
      noMcpCapabilityIssues.some(
        (issue) =>
          issue.level === 'error' &&
          issue.message.includes('managed MCP servers') &&
          issue.message.includes('Studio-launched agents require MCP support'),
      ),
      true,
      `missing MCP capability should fail required sync, got: ${JSON.stringify(noMcpCapabilityIssues)}`,
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
    })
    const unsupportedFormatResult = unsupportedFormatService.sync({
      workspaceRoot: siblingRoot,
      settings: requiredCodexSettings,
      clients: ['codex'],
    })
    assert.equal(unsupportedFormatResult.ok, false)
    const unsupportedFormatIssues = unsupportedFormatResult.issues ?? []
    assert.equal(
      unsupportedFormatIssues.some(
        (issue) =>
          issue.level === 'error' &&
          issue.message.includes('Studio-launched agents require') &&
          issue.message.includes('workspace stdio MCP config writer'),
      ),
      true,
      `unsupported format should fail required sync, got: ${JSON.stringify(unsupportedFormatIssues)}`,
    )

    // Connector-scoped write (pruneUnlistedServers) must leave the worktree config
    // holding exactly the connector server — any MCP server the base repo committed
    // into the worktree is pruned, not merged (T15 / security finding Sec-F1). The
    // normal workspace path stays a merge (covered by the claude sync above, where
    // `unmanaged` survives).
    const connectorRoot = join(temp, 'connector-workspace')
    await mkdir(join(connectorRoot, '.codex'), { recursive: true })
    await writeFile(
      join(connectorRoot, '.mcp.json'),
      JSON.stringify(
        {
          mcpServers: { 'legacy-committed': { type: 'http', url: 'https://legacy.example.com/mcp' } },
        },
        null,
        2,
      ),
      'utf-8',
    )
    await writeFile(
      join(connectorRoot, '.codex', 'config.toml'),
      [
        'model = "gpt-5-codex"',
        '',
        '[mcp_servers.legacy_committed]',
        'command = "legacy"',
        'args = []',
        '',
        '[profiles.default]',
        'approval_policy = "never"',
        '',
      ].join('\n'),
      'utf-8',
    )
    const connectorServer = (clients: McpSettings['servers'][string]['clients']): McpSettings => ({
      syncEnabled: true,
      servers: {
        railway: {
          id: 'railway',
          name: 'Railway',
          transport: 'http',
          url: 'https://mcp.railway.app/mcp',
          enabled: true,
          clients,
          scope: 'workspace',
          source: 'bundled',
          riskLevel: 'network',
        },
      },
    })

    // Control: without the flag, the committed server survives (merge).
    const mergeClaude = service.sync({
      workspaceRoot: connectorRoot,
      settings: connectorServer(['claude-code']),
      clients: ['claude-code'],
    })
    assert.equal(mergeClaude.ok, true)
    const mergedClaudeConfig = JSON.parse(await readFile(join(connectorRoot, '.mcp.json'), 'utf-8')) as {
      mcpServers: Record<string, unknown>
    }
    assert.equal(
      Boolean(mergedClaudeConfig.mcpServers['legacy-committed']),
      true,
      'default sync merges: committed server survives',
    )

    const connectorClaude = service.sync({
      workspaceRoot: connectorRoot,
      settings: connectorServer(['claude-code']),
      clients: ['claude-code'],
      pruneUnlistedServers: true,
    })
    assert.equal(connectorClaude.ok, true)
    const connectorClaudeConfig = JSON.parse(await readFile(join(connectorRoot, '.mcp.json'), 'utf-8')) as {
      mcpServers: Record<string, unknown>
    }
    assert.deepEqual(
      Object.keys(connectorClaudeConfig.mcpServers).sort(),
      ['railway'],
      'connector-scoped write must prune the committed server and leave only the connector',
    )

    const connectorCodex = service.sync({
      workspaceRoot: connectorRoot,
      settings: connectorServer(['codex']),
      clients: ['codex'],
      pruneUnlistedServers: true,
    })
    assert.equal(connectorCodex.ok, true)
    const connectorCodexConfig = await readFile(join(connectorRoot, '.codex', 'config.toml'), 'utf-8')
    assert.doesNotMatch(
      connectorCodexConfig,
      /\[mcp_servers\.legacy_committed\]/,
      'committed codex MCP server must be pruned',
    )
    assert.match(connectorCodexConfig, /\[mcp_servers\.railway\]/, 'connector server must be written to codex config')
    assert.match(
      connectorCodexConfig,
      /\[profiles\.default\]/,
      'unrelated codex config must be preserved through a connector-scoped prune',
    )
    assert.match(
      connectorCodexConfig,
      /model = "gpt-5-codex"/,
      'unrelated codex config must be preserved through a connector-scoped prune',
    )

    await sourceInstalledServerSyncsAndKeepsItsProvenance(service, temp)
    await aForgottenServerLeavesTheConfig(service, temp)
    await theRetiredSprintEngineServerIsForgottenByTheStudioSync(service, temp)
  }

  /**
   * A server a source installed is written into the CLI's config like any other,
   * and comes back out of normalization still saying which source owns it — the
   * sync normalizes every server it is handed, and a `source` flattened to
   * `bundled` there is a Sync that can no longer find what it installed
   * (backlog/2026-09-06-mcp-installs-carry-source-provenance.md).
   */
  async function sourceInstalledServerSyncsAndKeepsItsProvenance(
    service: ReturnType<typeof createMcpConfigService>,
    temp: string,
  ): Promise<void> {
    const { normalizeMcpServerConfig } = await import('./mcp-config-service')
    const root = join(temp, 'source-owned')
    await mkdir(root, { recursive: true })
    const sourceRef = { sourceId: 'github:acme/plugins', itemId: 'context7', commitSha: 'b81f77a' }
    const settings: McpSettings = {
      syncEnabled: true,
      servers: {
        context7: {
          id: 'context7',
          name: 'Context7',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp'],
          enabled: true,
          clients: ['claude-code'],
          scope: 'workspace',
          source: 'source',
          sourceRef,
          riskLevel: 'local-command',
        },
      },
    }
    const result = service.sync({ workspaceRoot: root, settings, clients: ['claude-code'] })
    assert.equal(result.ok, true, 'a source-owned server is a valid server to sync')
    const written = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf-8')) as {
      mcpServers: Record<string, { command?: string }>
    }
    assert.equal(written.mcpServers.context7?.command, 'npx', 'and lands in the CLI config like any other')

    const normalized = normalizeMcpServerConfig(settings.servers.context7)
    assert.equal(normalized?.source, 'source', 'normalization must not flatten it to bundled')
    assert.deepEqual(normalized?.sourceRef, sourceRef)
  }

  /**
   * Uninstalling a plugin forgets its server in settings, and the workspace's own
   * config has to lose it too. A server is pruned only while the settings still
   * name it, so a caller that has already dropped one says so with
   * `forgetServerIds` — without which an uninstalled plugin's server stayed in
   * `.mcp.json` for good
   * (backlog/2026-09-06-a-github-marketplace-plugin-installs-nothing-for-claude-code.md).
   */
  async function aForgottenServerLeavesTheConfig(
    service: ReturnType<typeof createMcpConfigService>,
    temp: string,
  ): Promise<void> {
    const root = join(temp, 'forgotten')
    await mkdir(root, { recursive: true })
    const settings: McpSettings = {
      syncEnabled: true,
      servers: {
        telegram: {
          id: 'telegram',
          name: 'telegram',
          transport: 'stdio',
          command: 'bun',
          args: ['run', 'start'],
          enabled: true,
          clients: ['claude-code'],
          scope: 'workspace',
          source: 'source',
          riskLevel: 'local-command',
        },
        keeper: {
          id: 'keeper',
          name: 'keeper',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'keeper'],
          enabled: true,
          clients: ['claude-code'],
          scope: 'workspace',
          source: 'custom',
          riskLevel: 'local-command',
        },
      },
    }
    assert.equal(service.sync({ workspaceRoot: root, settings, clients: ['claude-code'] }).ok, true)
    const path = join(root, '.mcp.json')
    const before = JSON.parse(await readFile(path, 'utf-8')) as { mcpServers: Record<string, unknown> }
    assert.deepEqual(Object.keys(before.mcpServers).sort(), ['keeper', 'telegram'])

    // What the uninstall does: the server is gone from settings, and named here.
    const remaining: McpSettings = { syncEnabled: true, servers: { keeper: settings.servers.keeper } }
    const after = service.sync({
      workspaceRoot: root,
      settings: remaining,
      clients: ['claude-code'],
      forgetServerIds: ['telegram'],
    })
    assert.equal(after.ok, true)
    const written = JSON.parse(await readFile(path, 'utf-8')) as { mcpServers: Record<string, unknown> }
    assert.deepEqual(Object.keys(written.mcpServers), ['keeper'], 'the forgotten server is gone, the other stays')

    // Without it, the same sync leaves the entry behind — which is the bug.
    service.sync({ workspaceRoot: root, settings, clients: ['claude-code'] })
    const restored = service.sync({ workspaceRoot: root, settings: remaining, clients: ['claude-code'] })
    assert.equal(restored.ok, true)
    const stale = JSON.parse(await readFile(path, 'utf-8')) as { mcpServers: Record<string, unknown> }
    assert.deepEqual(Object.keys(stale.mcpServers).sort(), ['keeper', 'telegram'])
  }

  /**
   * A workspace that ran a sprint kept an HTTP entry for the deleted engine's hub
   * in `.mcp.json` (and in Claude's enabled list), so Claude showed a failed
   * server on every launch. The Studio sync forgets it; a user's own servers and
   * the gateway stay.
   */
  async function theRetiredSprintEngineServerIsForgottenByTheStudioSync(
    service: ReturnType<typeof createMcpConfigService>,
    temp: string,
  ): Promise<void> {
    const root = join(temp, 'retired-sprintengine')
    await mkdir(join(root, '.claude'), { recursive: true })
    await writeFile(
      join(root, '.mcp.json'),
      `${JSON.stringify(
        {
          mcpServers: {
            [RETIRED_SPRINTENGINE_MCP_SERVER_ID]: { type: 'http', url: 'http://127.0.0.1:49152/mcp/run-1' },
            mine: { command: 'npx', args: ['-y', 'mine'] },
          },
        },
        null,
        2,
      )}\n`,
      'utf-8',
    )
    await writeFile(
      join(root, '.claude', 'settings.local.json'),
      `${JSON.stringify({ enabledMcpjsonServers: [RETIRED_SPRINTENGINE_MCP_SERVER_ID, 'mine'] }, null, 2)}\n`,
      'utf-8',
    )

    const result = await syncStudioMcpConfig(
      { workspaceRoot: root, settings: { syncEnabled: true, servers: {} }, clients: ['claude-code'] },
      {
        mcpConfigService: service,
        studioGateway: () => ({ command: process.execPath, bridgeScriptPath: '/app/bridge.mjs', userDataDir: '/data' }),
      },
    )
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    const written = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf-8')) as {
      mcpServers: Record<string, unknown>
    }
    assert.deepEqual(
      Object.keys(written.mcpServers).sort(),
      ['mine', STUDIO_MCP_SERVER_ID].sort(),
      'the retired server is gone; the user server and the gateway stay',
    )
    const claudeSettings = JSON.parse(await readFile(join(root, '.claude', 'settings.local.json'), 'utf-8')) as {
      enabledMcpjsonServers: string[]
    }
    assert.equal(claudeSettings.enabledMcpjsonServers.includes(RETIRED_SPRINTENGINE_MCP_SERVER_ID), false)
    assert.equal(claudeSettings.enabledMcpjsonServers.includes('mine'), true)
    assert.equal(claudeSettings.enabledMcpjsonServers.includes(STUDIO_MCP_SERVER_ID), true)
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
