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
type CallManagedSprintEngineTool = NonNullable<Parameters<typeof import('./terminal-runtime')['createTerminalRuntime']>[0]['callManagedSprintEngineTool']>
type ToolCallInput = Parameters<CallManagedSprintEngineTool>[0]

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
  emitData(data: string): void
  emitExit(event?: { exitCode: number, signal?: number }): void
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
    await assertSprintEngineAgentHeartbeatAndLeaveUseManagedMcp(runtimeModule)
    await assertSprintEngineShutdownWaitsForLeaveBeforeRelease(runtimeModule)
    await assertSprintEngineTeardownIsSessionObjectScoped(runtimeModule)
    await assertSprintEngineConcurrentSpawnFailureKeepsReservedRun(runtimeModule)
    await assertSprintEngineSpawnDerivesFallbackAgentIdBeforeMcpSync(runtimeModule)
    await assertTerminalReattachUsesReplayChannel(runtimeModule)
    await assertStaleSweepReapsOnlyUnseenHiddenTerminals(runtimeModule)
  } finally {
    moduleWithLoad._load = originalLoad
  }
}

async function assertStaleSweepReapsOnlyUnseenHiddenTerminals(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-stale-'))
  mockPty.spawnCalls = []
  mockSender.sent = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
  })

  try {
    const hiddenSpawn = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: 'session_stale_hidden',
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      kind: 'terminal',
      shellOnly: true,
      visible: false,
    })
    assert.equal(hiddenSpawn.ok, true, JSON.stringify(hiddenSpawn))

    const visibleSpawn = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: 'session_stale_visible',
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      kind: 'terminal',
      shellOnly: true,
      visible: true,
    })
    assert.equal(visibleSpawn.ok, true, JSON.stringify(visibleSpawn))

    const beforeSweep = runtime.ipcHandlers.listTerminals().map((session) => session.sessionId).sort()
    assert.deepEqual(beforeSweep, ['session_stale_hidden', 'session_stale_visible'])

    const freshSweep = runtimeModule.reapStaleTerminals(Date.now())
    assert.deepEqual(freshSweep, [], 'recently spawned terminals must survive the sweep')

    const wellPastStale = Date.now() + 25 * 60 * 60 * 1000
    const reaped = runtimeModule.reapStaleTerminals(wellPastStale)
    assert.deepEqual(reaped, ['session_stale_hidden'], 'only the unseen hidden terminal is reaped')

    const afterSweep = runtime.ipcHandlers.listTerminals().map((session) => session.sessionId)
    assert.deepEqual(afterSweep, ['session_stale_visible'])
    const hiddenProcess = mockPty.spawnCalls.find((call) => call.process)?.process
    assert.equal(hiddenProcess?.killed, true, 'reaping must kill the underlying pty')
    assert.equal(
      mockSender.sent.some((event) => event.channel === 'terminal:exit:session_stale_hidden'),
      false,
      'reaped terminals must not emit terminal:exit so renderer launch flags survive for resume'
    )
  } finally {
    await runtime.shutdown()
  }
}

async function assertSprintEngineAgentHeartbeatAndLeaveUseManagedMcp(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-sprintengine-liveness-'))
  const sprintEngineStatePath = join(workspaceRoot, '.multi-code', 'sprintengine', 'run.yaml')
  const toolCalls: ToolCallInput[] = []
  const releasedRuns: ReleaseInput[] = []
  const order: string[] = []
  mockPty.spawnCalls = []
  mockSender.sent = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
    syncMcpConfig: async (): Promise<SyncResult> => ({
      ok: true,
      managedSprintEngineRunId: 'liveness-run-1',
      runTokenEnv: { [MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR]: 'liveness-token' },
    }),
    callManagedSprintEngineTool: async (input) => {
      toolCalls.push(input)
      order.push(input.toolName)
      return { ok: true }
    },
    releaseManagedSprintEngineRun: async (input) => {
      releasedRuns.push(input)
      order.push('release')
    },
  })

  try {
    const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: 'session_liveness',
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      sprintEngineStatePath,
      agentId: 'frontend-2',
      cli: 'codex',
      kind: 'agent',
      shellOnly: false,
      mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
    })
    assert.equal(result.ok, true, JSON.stringify(result))

    const heartbeats = await runtimeModule.sendSprintEngineAgentHeartbeats()
    assert.deepEqual(heartbeats, ['frontend-2'])
    assert.deepEqual(toolCalls[0], {
      runId: 'liveness-run-1',
      toolName: 'sprintengine.agent.heartbeat',
      arguments: {
        agentId: 'frontend-2',
        role: 'frontend',
      },
    })

    runtime.ipcHandlers.killTerminal('session_liveness')
    mockPty.spawnCalls[0]?.process.emitExit({ exitCode: 0 })
    await delay(20)

    const leaveCalls = toolCalls.filter((call) => call.toolName === 'sprintengine.agent.leave')
    assert.deepEqual(leaveCalls, [{
      runId: 'liveness-run-1',
      toolName: 'sprintengine.agent.leave',
      arguments: {
        agentId: 'frontend-2',
        role: 'frontend',
        reason: 'terminal disposed',
      },
    }])
    assert.deepEqual(releasedRuns, [{
      runId: 'liveness-run-1',
      workspaceRoot,
      clients: ['codex', 'claude-code'],
      cleanupMcpConfig: true,
    }])
    assert.deepEqual(order, ['sprintengine.agent.heartbeat', 'sprintengine.agent.leave', 'release'])
  } finally {
    await runtime.shutdown()
  }
}

async function assertSprintEngineShutdownWaitsForLeaveBeforeRelease(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-sprintengine-shutdown-'))
  const sprintEngineStatePath = join(workspaceRoot, '.multi-code', 'sprintengine', 'run.yaml')
  const releasedRuns: ReleaseInput[] = []
  const order: string[] = []
  let resolveLeave: (() => void) | undefined
  mockPty.spawnCalls = []
  mockSender.sent = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
    syncMcpConfig: async (): Promise<SyncResult> => ({
      ok: true,
      managedSprintEngineRunId: 'shutdown-run-1',
      runTokenEnv: { [MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR]: 'shutdown-token' },
    }),
    callManagedSprintEngineTool: async (input) => {
      order.push(input.toolName)
      if (input.toolName === 'sprintengine.agent.leave') {
        await new Promise<void>((resolve) => {
          resolveLeave = resolve
        })
      }
      return { ok: true }
    },
    releaseManagedSprintEngineRun: async (input) => {
      releasedRuns.push(input)
      order.push('release')
    },
  })

  const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
    sessionId: 'session_shutdown_liveness',
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
  assert.equal(result.ok, true, JSON.stringify(result))

  const shutdown = runtime.shutdown()
  mockPty.spawnCalls[0]?.process.emitExit({ exitCode: 0 })
  await delay(20)
  assert.deepEqual(releasedRuns, [], 'shutdown must not release the MCP run before agent.leave settles')

  resolveLeave?.()
  await shutdown
  assert.deepEqual(releasedRuns, [{
    runId: 'shutdown-run-1',
    workspaceRoot,
    clients: ['codex', 'claude-code'],
    cleanupMcpConfig: true,
  }])
  assert.deepEqual(order, ['sprintengine.agent.leave', 'release'])
}

async function assertSprintEngineTeardownIsSessionObjectScoped(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-sprintengine-respawn-'))
  const sprintEngineStatePath = join(workspaceRoot, '.multi-code', 'sprintengine', 'run.yaml')
  const toolCalls: ToolCallInput[] = []
  const releasedRuns: ReleaseInput[] = []
  const leaveResolvers: Array<() => void> = []
  let registrationCount = 0
  mockPty.spawnCalls = []
  mockSender.sent = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
    syncMcpConfig: async (): Promise<SyncResult> => {
      registrationCount += 1
      return {
        ok: true,
        managedSprintEngineRunId: `respawn-run-${registrationCount}`,
        runTokenEnv: { [MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR]: `respawn-token-${registrationCount}` },
      }
    },
    callManagedSprintEngineTool: async (input) => {
      toolCalls.push(input)
      if (input.toolName === 'sprintengine.agent.leave') {
        await new Promise<void>((resolve) => {
          leaveResolvers.push(resolve)
        })
      }
      return { ok: true }
    },
    releaseManagedSprintEngineRun: async (input) => {
      releasedRuns.push(input)
    },
  })

  try {
    const first = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: 'session_respawn',
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
    assert.equal(first.ok, true, JSON.stringify(first))

    runtime.ipcHandlers.killTerminal('session_respawn')
    await delay(20)
    assert.equal(leaveResolvers.length, 1)

    const second = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: 'session_respawn',
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
    assert.equal(second.ok, true, JSON.stringify(second))

    runtime.ipcHandlers.killTerminal('session_respawn')
    await delay(20)
    assert.equal(leaveResolvers.length, 2, 'new session object with same id must get its own leave')

    leaveResolvers.forEach((resolve) => resolve())
    await delay(20)
    assert.deepEqual(
      toolCalls.filter((call) => call.toolName === 'sprintengine.agent.leave').map((call) => call.runId),
      ['respawn-run-1', 'respawn-run-2']
    )
    assert.deepEqual(releasedRuns.map((run) => run.runId), ['respawn-run-1', 'respawn-run-2'])
  } finally {
    leaveResolvers.forEach((resolve) => resolve())
    await runtime.shutdown()
  }
}

async function assertTerminalReattachUsesReplayChannel(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-replay-'))
  mockPty.spawnCalls = []
  mockSender.sent = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
  })

  try {
    const firstSpawn = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: 'session_replay',
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      kind: 'terminal',
      shellOnly: true,
    })
    assert.equal(firstSpawn.ok, true, JSON.stringify(firstSpawn))
    assert.equal(mockPty.spawnCalls.length, 1)

    mockPty.spawnCalls[0]?.process.emitData('retained terminal output\r\n')
    await delay(20)
    assert.equal(
      mockSender.sent.some((event) => event.channel === 'terminal:data:session_replay'),
      true,
      'initial live output should still use terminal:data'
    )

    mockSender.sent = []
    const reattach = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: 'session_replay',
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      resume: true,
      kind: 'terminal',
      shellOnly: true,
    })

    assert.equal(reattach.ok, true, JSON.stringify(reattach))
    assert.deepEqual(
      mockSender.sent.filter((event) => event.channel === 'terminal:replay:session_replay'),
      [{ channel: 'terminal:replay:session_replay', payload: 'retained terminal output\r\n' }]
    )
    assert.equal(
      mockSender.sent.some((event) => event.channel === 'terminal:data:session_replay'),
      false,
      'reattached retained output must not be delivered as live terminal data'
    )
  } finally {
    await runtime.shutdown()
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
      clients: ['codex', 'claude-code'],
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
      clients: ['codex', 'claude-code'],
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
      clients: ['codex', 'claude-code'],
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
      clients: ['codex', 'claude-code'],
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
  const dataCallbacks = new Set<(data: string) => void>()
  const exitCallbacks = new Set<(event: { exitCode: number, signal?: number }) => void>()
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
    onData(callback) {
      dataCallbacks.add(callback)
      return { dispose: () => dataCallbacks.delete(callback) }
    },
    onExit(callback) {
      exitCallbacks.add(callback)
      return { dispose: () => exitCallbacks.delete(callback) }
    },
    emitData(data: string): void {
      for (const callback of dataCallbacks) callback(data)
    },
    emitExit(event = { exitCode: 0 }): void {
      for (const callback of exitCallbacks) callback(event)
    },
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
