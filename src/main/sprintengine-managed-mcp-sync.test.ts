import assert from 'node:assert/strict'
import {
  MANAGED_SPRINTENGINE_MCP_RUN_ID_ENV_VAR,
  MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR,
  MANAGED_STUDIO_MCP_SERVER_ID,
  syncManagedSprintEngineMcpConfig,
} from './sprintengine-managed-mcp-sync'
import type { McpSyncInput } from '../shared/electron-api'

async function main(): Promise<void> {
  const unregistered: string[] = []
  const syncInputs: McpSyncInput[] = []
  const input: McpSyncInput = {
    workspaceRoot: '/workspace',
    settings: { syncEnabled: false, servers: {} },
    clients: ['codex'],
    managedSprintEngine: {
      statePath: '/workspace/.sprintengine/sprintengine/team/run.yaml',
      workspaceRoot: '/workspace',
      allowedRoots: ['/workspace'],
      registryRoots: [],
      actorId: 'multicode-app',
      agentId: 'developer-1',
      role: 'developer',
      cli: 'codex',
    },
  }

  const successResult = await syncManagedSprintEngineMcpConfig(input, {
    mcpConfigService: {
      sync: (syncInput) => {
        syncInputs.push(syncInput)
        return { ok: true as const, targets: [], issues: [] }
      },
    },
    sprintEngineMcpHub: {
      ensureStarted: async () => ({
        url: 'http://127.0.0.1:49152/mcp',
        adminToken: 'secret-token',
      }),
      ensureRunRegistered: async () => ({
        runId: 'registered-run',
        runToken: 'run-token',
      }),
      unregisterRun: async (runId) => {
        unregistered.push(runId)
      },
    },
  })
  assert.deepEqual(successResult, {
    ok: true,
    managedSprintEngineRunId: 'registered-run',
    runTokenEnv: { [MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR]: 'run-token' },
  })
  assert.deepEqual([...unregistered], [])
  assert.equal(syncInputs[0]?.managedSprintEngine?.http?.authTokenEnvVar, MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR)
  assert.equal(
    JSON.stringify(syncInputs[0]).includes('run-token'),
    false,
    'shared MCP config input must not contain the literal run token'
  )

  syncInputs.length = 0
  const studioResult = await syncManagedSprintEngineMcpConfig(input, {
    mcpConfigService: {
      sync: (syncInput) => {
        syncInputs.push(syncInput)
        return { ok: true as const, targets: [], issues: [] }
      },
    },
    sprintEngineMcpHub: {
      ensureStarted: async () => ({ url: 'http://127.0.0.1:49152/mcp', adminToken: 'secret-token' }),
      ensureRunRegistered: async () => ({ runId: 'studio-run', runToken: 'run-token' }),
      unregisterRun: async () => {},
    },
    studioGateway: () => ({
      command: '/Applications/SprintEngine Studio.app/Contents/MacOS/SprintEngine Studio',
      bridgeScriptPath: '/Applications/SprintEngine Studio.app/Contents/Resources/automation/mcp-stdio-bridge.mjs',
      userDataDir: '/Users/test/Library/Application Support/multicode',
    }),
  })
  assert.deepEqual(studioResult, {
    ok: true,
    managedSprintEngineRunId: 'studio-run',
    runTokenEnv: { [MANAGED_SPRINTENGINE_MCP_RUN_ID_ENV_VAR]: 'studio-run' },
  })
  const studioSync = syncInputs[0]!
  assert.equal(studioSync.managedSprintEngine, undefined, 'the direct Python MCP is not exposed beside the gateway')
  assert.equal(studioSync.settings.syncEnabled, true)
  assert.deepEqual(studioSync.settings.servers[MANAGED_STUDIO_MCP_SERVER_ID]?.args, [
    '/Applications/SprintEngine Studio.app/Contents/Resources/automation/mcp-stdio-bridge.mjs',
  ])
  assert.equal(studioSync.settings.servers[MANAGED_STUDIO_MCP_SERVER_ID]?.env?.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(studioSync.settings.servers[MANAGED_STUDIO_MCP_SERVER_ID]?.env?.MULTICODE_AGENT_CLI, 'codex')
  assert.equal(studioSync.settings.servers['multicode-sprintengine']?.enabled, false)
  assert.equal(JSON.stringify(studioSync).includes('run-token'), false)

  syncInputs.length = 0
  let ordinaryHubStarts = 0
  const ordinaryResult = await syncManagedSprintEngineMcpConfig(
    { workspaceRoot: '/workspace', settings: { syncEnabled: false, servers: {} }, clients: ['opencode'] },
    {
      mcpConfigService: {
        sync: (syncInput) => {
          syncInputs.push(syncInput)
          return { ok: true as const, targets: [], issues: [] }
        },
      },
      sprintEngineMcpHub: {
        ensureStarted: async () => {
          ordinaryHubStarts += 1
          return { url: '', adminToken: '' }
        },
        ensureRunRegistered: async () => ({ runId: '', runToken: '' }),
        unregisterRun: async () => {},
      },
      studioGateway: () => ({ command: 'electron', bridgeScriptPath: 'C:\\Program Files\\SprintEngine Studio\\mcp-stdio-bridge.mjs', userDataDir: 'C:\\Users\\test\\AppData\\Roaming\\multicode' }),
    }
  )
  assert.equal(ordinaryResult.ok, true)
  assert.equal(ordinaryHubStarts, 0, 'ordinary agents do not start the Python Sprint Engine runtime')
  assert.equal(syncInputs[0]?.settings.servers[MANAGED_STUDIO_MCP_SERVER_ID]?.enabled, true)

  syncInputs.length = 0
  await syncManagedSprintEngineMcpConfig(
    {
      workspaceRoot: '/workspace',
      clients: ['codex'],
      settings: {
        syncEnabled: true,
        servers: {
          global: {
            id: 'global',
            name: 'User global',
            transport: 'http',
            url: 'https://example.com/mcp',
            enabled: true,
            clients: ['codex'],
            scope: 'user',
            source: 'custom',
            riskLevel: 'network',
          },
        },
      },
    },
    {
      mcpConfigService: {
        sync: (syncInput) => {
          syncInputs.push(syncInput)
          return { ok: true as const, targets: [], issues: [] }
        },
      },
      sprintEngineMcpHub: {
        ensureStarted: async () => ({ url: '', adminToken: '' }),
        ensureRunRegistered: async () => ({ runId: '', runToken: '' }),
        unregisterRun: async () => {},
      },
      studioGateway: () => ({ command: 'electron', bridgeScriptPath: '/app/mcp-stdio-bridge.mjs', userDataDir: '/profile' }),
    }
  )
  assert.equal(syncInputs.length, 2, 'custom and app-owned MCP scopes sync independently')
  assert.equal(syncInputs[0]?.settings.servers.global?.scope, 'user')
  assert.equal(syncInputs[0]?.settings.servers[MANAGED_STUDIO_MCP_SERVER_ID], undefined)
  assert.equal(syncInputs[1]?.settings.servers[MANAGED_STUDIO_MCP_SERVER_ID]?.scope, 'workspace')
  assert.equal(syncInputs[1]?.settings.servers.global, undefined, 'Studio MCP never follows a custom server into user scope')

  syncInputs.length = 0
  await assert.rejects(
    () => syncManagedSprintEngineMcpConfig(input, {
      mcpConfigService: {
        sync: (syncInput) => {
          syncInputs.push(syncInput)
          throw new Error('config write failed')
        },
      },
      sprintEngineMcpHub: {
        ensureStarted: async () => ({
          url: 'http://127.0.0.1:49152/mcp',
          adminToken: 'secret-token',
        }),
        ensureRunRegistered: async () => ({
          runId: 'registered-run',
          runToken: 'run-token',
        }),
        unregisterRun: async (runId) => {
          unregistered.push(runId)
        },
      },
    }),
    /config write failed/
  )

  assert.deepEqual([...unregistered], ['registered-run'])
  assert.equal(syncInputs[0]?.managedSprintEngine?.http?.authTokenEnvVar, MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR)
  assert.equal(
    JSON.stringify(syncInputs[0]).includes('run-token'),
    false,
    'shared MCP config input must not contain the literal run token'
  )

  unregistered.length = 0
  await assert.rejects(
    () => syncManagedSprintEngineMcpConfig(input, {
      mcpConfigService: {
        sync: () => {
          throw new Error('config write failed for reused run')
        },
      },
      sprintEngineMcpHub: {
        ensureStarted: async () => ({
          url: 'http://127.0.0.1:49152/mcp',
          adminToken: 'secret-token',
        }),
        ensureRunRegistered: async () => ({
          runId: 'registered-run',
          runToken: 'run-token',
          reused: true,
        }),
        unregisterRun: async (runId) => {
          unregistered.push(runId)
        },
      },
    }),
    /config write failed for reused run/
  )
  assert.deepEqual([...unregistered], [], 'config failure must not unregister an existing shared run token')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
