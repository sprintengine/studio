import assert from 'node:assert/strict'
import { syncManagedSprintEngineMcpConfig } from './sprintengine-managed-mcp-sync'
import type { McpSyncInput } from '../shared/electron-api'

async function main(): Promise<void> {
  const unregistered: string[] = []
  const input: McpSyncInput = {
    workspaceRoot: '/workspace',
    settings: { syncEnabled: false, servers: {} },
    clients: ['codex'],
    managedSprintEngine: {
      statePath: '/workspace/.multi-code/sprintengine/team/run.yaml',
      workspaceRoot: '/workspace',
      allowedRoots: ['/workspace'],
      registryRoots: [],
      actorId: 'multicode-app',
      agentId: 'developer-1',
      role: 'developer',
      cli: 'codex',
    },
  }

  await assert.rejects(
    () => syncManagedSprintEngineMcpConfig(input, {
      mcpConfigService: {
        sync: () => {
          throw new Error('config write failed')
        },
      },
      sprintEngineMcpHub: {
        ensureStarted: async () => ({
          url: 'http://127.0.0.1:49152/mcp',
          authTokenEnvVar: 'MULTICODE_SPRINTENGINE_MCP_TOKEN',
          authToken: 'secret-token',
        }),
        registerSession: async () => ({
          sessionId: 'registered-session',
          headerName: 'X-Multicode-Session-Id',
          headers: { 'X-Multicode-Session-Id': 'registered-session' },
        }),
        unregisterSession: async (sessionId) => {
          unregistered.push(sessionId)
        },
      },
    }),
    /config write failed/
  )

  assert.deepEqual(unregistered, ['registered-session'])
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
