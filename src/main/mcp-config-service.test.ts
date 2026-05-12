import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { McpSettings } from '../shared/electron-api'
import { createMcpConfigService } from './mcp-config-service'

async function main(): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'multicode-mcp-config-'))
  const workspaceRoot = join(temp, 'workspace')
  await mkdir(workspaceRoot, { recursive: true })

  const service = createMcpConfigService()
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
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
