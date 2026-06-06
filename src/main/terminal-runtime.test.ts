import assert from 'node:assert/strict'
import Module from 'node:module'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { WebContents } from 'electron'
import type { McpSettings, TerminalSpawnResult } from '../shared/electron-api'
import { MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR } from './sprintengine-managed-mcp-sync'

type RuntimeModule = typeof import('./terminal-runtime')
type SyncMcpConfig = NonNullable<Parameters<typeof import('./terminal-runtime')['createTerminalRuntime']>[0]['syncMcpConfig']>
type SyncInput = Parameters<SyncMcpConfig>[0]
type SyncResult = Awaited<ReturnType<SyncMcpConfig>>
type ReleaseManagedSprintEngineRun = NonNullable<Parameters<typeof import('./terminal-runtime')['createTerminalRuntime']>[0]['releaseManagedSprintEngineRun']>
type ReleaseInput = Parameters<ReleaseManagedSprintEngineRun>[0]

type SentEvent = {
  channel: string
  payload: unknown
}

type MockPtyProcess = {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(callback: (data: string) => void): { dispose(): void }
  onExit(callback: (event: { exitCode: number, signal?: number }) => void): { dispose(): void }
  writes: string[]
  killed: boolean
}

type SpawnCall = {
  command: string
  args: string[]
  options: Record<string, unknown>
  process: MockPtyProcess
}

const mockPty = {
  spawnCalls: [] as SpawnCall[],
  spawnError: null as Error | null,
  beforeSpawn: null as null | (() => void | Promise<void>),
  spawn(command: string, args: string[], options: Record<string, unknown>): MockPtyProcess {
    if (mockPty.spawnError) {
      const error = mockPty.spawnError
      mockPty.spawnError = null
      throw error
    }
    if (mockPty.beforeSpawn) {
      const callback = mockPty.beforeSpawn
      mockPty.beforeSpawn = null
      const result = callback()
      if (result && typeof (result as Promise<void>).then === 'function') {
        throw new Error('mockPty.beforeSpawn must be synchronous')
      }
    }
    const process = createMockPtyProcess()
    mockPty.spawnCalls.push({ command, args, options, process })
    return process
  },
}

const mockSender = createMockWebContents()
const mockElectron = {
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => join(tmpdir(), 'multicode-terminal-runtime-test-user-data'),
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: mockSender,
      },
    ],
  },
}

const moduleWithLoad = Module as typeof Module & {
  _load(request: string, parent: NodeModule | null, isMain: boolean): unknown
}
const originalLoad = moduleWithLoad._load

moduleWithLoad._load = function loadWithMainProcessMocks(
  request: string,
  parent: NodeModule | null,
  isMain: boolean
): unknown {
  if (request === 'electron') return mockElectron
  if (request === 'node-pty') return mockPty
  return originalLoad.call(this, request, parent, isMain)
}

async function main(): Promise<void> {
  try {
    const runtimeModule = require('./terminal-runtime') as RuntimeModule
    await assertSprintEngineSpawnSyncsManagedMcpBeforePtySpawn(runtimeModule)
    await assertSprintEngineSpawnReportsSyncFailureWithoutPtySpawn(runtimeModule)
    await assertSprintEngineSpawnReportsThrownHttpMcpSetupFailureWithoutPtySpawn(runtimeModule)
    await assertSprintEngineSpawnReleasesUnusedRunWhenPtySpawnFails(runtimeModule)
    await assertSprintEngineRunCleanupWaitsForLastTerminal(runtimeModule)
    await assertSprintEngineConcurrentSpawnFailureKeepsReservedRun(runtimeModule)
    await assertSprintEngineSpawnDerivesFallbackAgentIdBeforeMcpSync(runtimeModule)
  } finally {
    moduleWithLoad._load = originalLoad
  }
}

async function assertSprintEngineSpawnReleasesUnusedRunWhenPtySpawnFails(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-release-'))
  const sprintEngineStatePath = join(workspaceRoot, '.multi-code', 'sprintengine', 'run.yaml')
  const releasedRuns: ReleaseInput[] = []
  mockPty.spawnCalls = []
  mockPty.spawnError = new Error('pty spawn failed')
  mockSender.sent = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
    syncMcpConfig: async (): Promise<SyncResult> => ({ ok: true, managedSprintEngineRunId: 'registered-run-failed-spawn' }),
    releaseManagedSprintEngineRun: async (input) => {
      releasedRuns.push(input)
    },
  })

  try {
    const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: 'session_spawn_failure',
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      sprintEngineStatePath,
      agentId: 'developer-1',
      cli: 'codex',
      kind: 'agent',
      shellOnly: false,
      mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
    })

    assert.equal(result.ok, false)
    assert.deepEqual(releasedRuns, [{
      runId: 'registered-run-failed-spawn',
      workspaceRoot,
      clients: ['codex', 'claude'],
      cleanupMcpConfig: true,
    }])
    assert.equal(mockPty.spawnCalls.length, 0)
  } finally {
    mockPty.spawnError = null
    await runtime.shutdown()
  }
}

async function assertSprintEngineRunCleanupWaitsForLastTerminal(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-shared-run-'))
  const sprintEngineStatePath = join(workspaceRoot, '.multi-code', 'sprintengine', 'run.yaml')
  const releasedRuns: ReleaseInput[] = []
  mockPty.spawnCalls = []
  mockSender.sent = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
    syncMcpConfig: async (): Promise<SyncResult> => ({
      ok: true,
      managedSprintEngineRunId: 'shared-run-1',
      runTokenEnv: { [MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR]: 'shared-run-token' },
    }),
    releaseManagedSprintEngineRun: async (input) => {
      releasedRuns.push(input)
    },
  })

  try {
    for (const sessionId of ['session_shared_a', 'session_shared_b']) {
      const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId,
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        sprintEngineStatePath,
        agentId: sessionId === 'session_shared_a' ? 'developer-1' : 'reviewer-1',
        cli: 'codex',
        kind: 'agent',
        shellOnly: false,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(result.ok, true, JSON.stringify(result))
    }

    runtime.ipcHandlers.killTerminal('session_shared_a')
    assert.deepEqual(releasedRuns, [])
    runtime.ipcHandlers.killTerminal('session_shared_b')
    assert.deepEqual(releasedRuns, [{
      runId: 'shared-run-1',
      workspaceRoot,
      clients: ['codex', 'claude'],
      cleanupMcpConfig: true,
    }])
  } finally {
    await runtime.shutdown()
  }
}

async function assertSprintEngineConcurrentSpawnFailureKeepsReservedRun(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-reserved-run-'))
  const sprintEngineStatePath = join(workspaceRoot, '.multi-code', 'sprintengine', 'run.yaml')
  const releasedRuns: ReleaseInput[] = []
  let secondSpawn: Promise<TerminalSpawnResult> | undefined
  mockPty.spawnCalls = []
  mockPty.spawnError = null
  mockSender.sent = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
    syncMcpConfig: async (): Promise<SyncResult> => ({
      ok: true,
      managedSprintEngineRunId: 'reserved-shared-run',
      runTokenEnv: { [MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR]: 'reserved-run-token' },
    }),
    releaseManagedSprintEngineRun: async (input) => {
      releasedRuns.push(input)
    },
  })

  try {
    mockPty.beforeSpawn = () => {
      mockPty.spawnError = new Error('second pty spawn failed')
      secondSpawn = runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'session_reserved_failure',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        sprintEngineStatePath,
        agentId: 'reviewer-1',
        cli: 'codex',
        kind: 'agent',
        shellOnly: false,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
    }

    const successfulFirst = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: 'session_reserved_success',
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      sprintEngineStatePath,
      agentId: 'developer-1',
      cli: 'codex',
      kind: 'agent',
      shellOnly: false,
      mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
    })
    const failedSecond = await secondSpawn

    assert.equal(successfulFirst.ok, true, JSON.stringify(successfulFirst))
    assert.equal(failedSecond?.ok, false)
    assert.deepEqual(releasedRuns, [], 'failed concurrent spawn must not release a run reserved by another launch')

    runtime.ipcHandlers.killTerminal('session_reserved_success')
    assert.deepEqual(releasedRuns, [{
      runId: 'reserved-shared-run',
      workspaceRoot,
      clients: ['codex', 'claude'],
      cleanupMcpConfig: true,
    }])
  } finally {
    mockPty.spawnError = null
    mockPty.beforeSpawn = null
    await runtime.shutdown()
  }
}

async function assertSprintEngineSpawnReportsThrownHttpMcpSetupFailureWithoutPtySpawn(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-thrown-setup-'))
  const sprintEngineStatePath = join(workspaceRoot, '.multi-code', 'sprintengine', 'run.yaml')
  const failureMessage = 'Timed out starting Sprint Engine MCP HTTP hub.'
  mockPty.spawnCalls = []
  mockSender.sent = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
    syncMcpConfig: async (): Promise<SyncResult> => {
      throw new Error(failureMessage)
    },
  })

  try {
    const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: 'session_thrown_setup_failure',
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      sprintEngineStatePath,
      agentId: 'developer-1',
      cli: 'codex',
      kind: 'agent',
      shellOnly: false,
      mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
    })
    const failedSnapshot = runtime.ipcHandlers.listTerminals().find((session) => session.sessionId === 'session_thrown_setup_failure')

    assert.deepEqual(result, {
      ok: false,
      sessionId: 'session_thrown_setup_failure',
      message: failureMessage,
      exitCode: 1,
    })
    assert.equal(mockPty.spawnCalls.length, 0)
    assert.deepEqual(failedSnapshot?.activity, {
      kind: 'failed',
      at: failedSnapshot?.activity.kind === 'failed' ? failedSnapshot.activity.at : undefined,
      exitCode: 1,
      message: failureMessage,
    })
  } finally {
    await runtime.shutdown()
  }
}

async function assertSprintEngineSpawnSyncsManagedMcpBeforePtySpawn(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-success-'))
  const sprintEngineStatePath = join(workspaceRoot, '.multi-code', 'sprintengine', 'run.yaml')
  const order: string[] = []
  const syncInputs: SyncInput[] = []
  const releasedRuns: ReleaseInput[] = []
  mockPty.spawnCalls = []
  mockSender.sent = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
    syncMcpConfig: async (input): Promise<SyncResult> => {
      order.push('sync')
      syncInputs.push(input)
      return {
        ok: true,
        managedSprintEngineRunId: 'registered-run-1',
        runTokenEnv: { [MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR]: 'run-token-1' },
      }
    },
    releaseManagedSprintEngineRun: async (input) => {
      releasedRuns.push(input)
    },
  })

  try {
    const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: 'session_success',
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      sprintEngineStatePath,
      agentId: 'developer-1',
      cli: 'codex',
      kind: 'agent',
      shellOnly: false,
      mcpSettings: { syncEnabled: true, servers: {} } satisfies McpSettings,
    })

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(order, ['sync'], JSON.stringify({ result, spawnCalls: mockPty.spawnCalls.length, sent: mockSender.sent }))
    assert.equal(mockPty.spawnCalls.length, 1)
    assert.equal(
      (mockPty.spawnCalls[0]?.options.env as Record<string, string> | undefined)?.[MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR],
      'run-token-1'
    )
    assert.equal(syncInputs.length, 1)
    assert.deepEqual(syncInputs[0]?.clients, ['codex'])
    assert.equal(syncInputs[0]?.workspaceRoot, workspaceRoot)
    assert.equal(syncInputs[0]?.managedSprintEngine?.statePath, sprintEngineStatePath)
    assert.equal(syncInputs[0]?.managedSprintEngine?.workspaceRoot, workspaceRoot)
    assert.deepEqual(syncInputs[0]?.managedSprintEngine?.allowedRoots, [workspaceRoot])
    assert.equal(syncInputs[0]?.managedSprintEngine?.agentId, 'developer-1')
    assert.equal(syncInputs[0]?.managedSprintEngine?.role, 'developer')
    assert.equal(syncInputs[0]?.managedSprintEngine?.cli, 'codex')
    assert.equal(runtime.ipcHandlers.getTerminalStatus('session_success').processAlive, true)
    assert.deepEqual(releasedRuns, [])
    runtime.ipcHandlers.killTerminal('session_success')
    assert.deepEqual(releasedRuns, [{
      runId: 'registered-run-1',
      workspaceRoot,
      clients: ['codex', 'claude'],
      cleanupMcpConfig: true,
    }])
  } finally {
    await runtime.shutdown()
  }
}

async function assertSprintEngineSpawnReportsSyncFailureWithoutPtySpawn(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-failure-'))
  const sprintEngineStatePath = join(workspaceRoot, '.multi-code', 'sprintengine', 'run.yaml')
  const failureMessage = 'MCP sync writer for format "generic" is not implemented yet; cannot launch a Sprint Engine agent.'
  mockPty.spawnCalls = []
  mockSender.sent = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
    syncMcpConfig: async (): Promise<SyncResult> => ({ ok: false, message: failureMessage }),
  })

  try {
    const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: 'session_failure',
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      sprintEngineStatePath,
      agentId: 'developer-1',
      cli: 'codex',
      kind: 'agent',
      shellOnly: false,
      mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
    })
    const failedSnapshot = runtime.ipcHandlers.listTerminals().find((session) => session.sessionId === 'session_failure')

    assert.deepEqual(result, {
      ok: false,
      sessionId: 'session_failure',
      message: failureMessage,
      exitCode: 1,
    })
    assert.equal(mockPty.spawnCalls.length, 0)
    assert.equal(failedSnapshot?.processAlive, false)
    assert.deepEqual(failedSnapshot?.activity, {
      kind: 'failed',
      at: failedSnapshot?.activity.kind === 'failed' ? failedSnapshot.activity.at : undefined,
      exitCode: 1,
      message: failureMessage,
    })
    assert.deepEqual(
      mockSender.sent.filter((event) => event.channel.startsWith('terminal:error:') || event.channel.startsWith('terminal:exit:')),
      [
        { channel: 'terminal:error:session_failure', payload: failureMessage },
        { channel: 'terminal:exit:session_failure', payload: 1 },
      ]
    )
  } finally {
    await runtime.shutdown()
  }
}

async function assertSprintEngineSpawnDerivesFallbackAgentIdBeforeMcpSync(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-missing-identity-'))
  const sprintEngineStatePath = join(workspaceRoot, '.multi-code', 'sprintengine', 'run.yaml')
  const syncInputs: SyncInput[] = []
  mockPty.spawnCalls = []
  mockSender.sent = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
    syncMcpConfig: async (input): Promise<SyncResult> => {
      syncInputs.push(input)
      return {
        ok: true,
        managedSprintEngineRunId: 'registered-run-fallback',
        runTokenEnv: { [MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR]: 'fallback-run-token' },
      }
    },
  })

  try {
    const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: 'session_missing_identity',
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      sprintEngineStatePath,
      cli: 'codex',
      kind: 'agent',
      shellOnly: false,
      mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
    })

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(syncInputs[0]?.managedSprintEngine?.agentId, 'session_missing_identity')
    assert.equal(syncInputs[0]?.managedSprintEngine?.role, undefined)
    assert.equal(mockPty.spawnCalls.length, 1)
    assert.equal(
      (mockPty.spawnCalls[0]?.options.env as Record<string, string> | undefined)?.[MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR],
      'fallback-run-token'
    )
  } finally {
    await runtime.shutdown()
  }
}

function createMockWebContents(): { isDestroyed(): boolean, send(channel: string, payload: unknown): void, sent: SentEvent[] } {
  return {
    sent: [],
    isDestroyed: () => false,
    send(channel: string, payload: unknown): void {
      this.sent.push({ channel, payload })
    },
  }
}

function createMockPtyProcess(): MockPtyProcess {
  return {
    writes: [],
    killed: false,
    write(data: string): void {
      this.writes.push(data)
    },
    resize: () => undefined,
    kill(): void {
      this.killed = true
    },
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
