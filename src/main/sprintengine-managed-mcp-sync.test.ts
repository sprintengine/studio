import assert from 'node:assert/strict'
import {
  MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR,
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
