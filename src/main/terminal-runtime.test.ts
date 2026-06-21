import assert from 'node:assert/strict'
import Module from 'node:module'
import { mkdir, mkdtemp } from 'node:fs/promises'
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
    await assertStandardAgentSpawnKeepsEnabledOptionalMcpSettings(runtimeModule)
    await assertSprintEngineSpawnDisablesOptionalMcpSettings(runtimeModule)
    await assertWorktreeSpawnRegistersProjectRootNotWorktreeCwd(runtimeModule)
    assertRegistrationRootDerivation(runtimeModule)
    await assertSprintEngineSpawnReportsSyncFailureWithoutPtySpawn(runtimeModule)
    await assertSprintEngineSpawnReportsThrownHttpMcpSetupFailureWithoutPtySpawn(runtimeModule)
    await assertSprintEngineSpawnReleasesUnusedRunWhenPtySpawnFails(runtimeModule)
    await assertSprintEngineRunCleanupWaitsForLastTerminal(runtimeModule)
    await assertSprintEngineAgentHeartbeatAndLeaveUseManagedMcp(runtimeModule)
    await assertSprintEngineShutdownWaitsForLeaveBeforeRelease(runtimeModule)
    await assertSprintEngineTeardownIsSessionObjectScoped(runtimeModule)
    await assertSprintEngineConcurrentSpawnFailureKeepsReservedRun(runtimeModule)
    await assertSprintEngineSpawnDerivesFallbackAgentIdBeforeMcpSync(runtimeModule)
    await assertAgentSpawnExposesAgentIdentityEnv(runtimeModule)
    await assertTerminalReattachUsesReplayChannel(runtimeModule)
    await assertHiddenTerminalOutputSkipsLiveIpcAndReplaysOnAttach(runtimeModule)
    await assertStaleSweepReapsOnlyUnseenHiddenTerminals(runtimeModule)
    await assertIdleSweepSuspendsRatherThanDisposes(runtimeModule)
  } finally {
    moduleWithLoad._load = originalLoad
  }
}

// The in-session memory reaper must SUSPEND idle agents (freeze-the-view), not
// dispose them: a disposed session loses its painted scrollback and falls
// through to the renderer's resume-spawn on reopen, silently relaunching the
// agent. Suspending keeps the session with `suspended = true` so reopening
// replays the frozen history and only resumes on the first keystroke. Live
// workspaces (the hot set) are never reaped, so they are untouched.
async function assertIdleSweepSuspendsRatherThanDisposes(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-idle-suspend-'))
  mockPty.spawnCalls = []
  mockSender.sent = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
  })

  const spawnHiddenAgent = async (sessionId: string, agentWorkspaceId: string): Promise<MockPtyProcess> => {
    const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId,
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      cli: 'codex',
      kind: 'agent',
      shellOnly: false,
      workspaceId: agentWorkspaceId,
      agentId: sessionId,
      visible: false,
      mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    const spawned = mockPty.spawnCalls[mockPty.spawnCalls.length - 1]?.process
    assert.ok(spawned, `expected a pty for ${sessionId}`)
    return spawned
  }

  try {
    // The oldest-interacted agent is the one that falls out of the 5-workspace
    // hot set. Spawn it first, then let the clock advance a touch so the five
    // fresher agents deterministically own the hot set regardless of tie-break.
    const oldProcess = await spawnHiddenAgent('session-old', 'ws-old')
    await delay(10)
    for (let i = 0; i < 5; i += 1) {
      await spawnHiddenAgent(`session-h${i}`, `ws-h${i}`)
    }

    // Fresh sweep leaves everything alive (nothing past the idle threshold yet).
    assert.deepEqual(
      runtimeModule.runIdleAgentReapSweep(Date.now()),
      [],
      'recently active agents must not be suspended'
    )

    const wellPastIdle = Date.now() + 2 * 60 * 60 * 1000 + 1_000
    const reaped = runtimeModule.runIdleAgentReapSweep(wellPastIdle)
    assert.deepEqual(reaped, ['session-old'], 'only the non-hot idle agent is reaped')

    // Suspend finalizes when the killed pty reports exit.
    oldProcess.emitExit({ exitCode: 0 })
    await delay(20)

    assert.equal(oldProcess.killed, true, 'suspending must kill the underlying pty to reclaim RAM')

    const oldStatus = runtime.ipcHandlers.getTerminalStatus('session-old')
    assert.deepEqual(
      oldStatus,
      { processAlive: false, suspended: true },
      'reaped agent must be suspended (frozen + resumable), not gone'
    )

    const stillListed = runtime.ipcHandlers.listTerminals().map((session) => session.sessionId)
    assert.ok(
      stillListed.includes('session-old'),
      'suspended session must be retained so its painted scrollback can replay on reopen'
    )

    assert.equal(
      mockSender.sent.some((event) => event.channel === 'terminal:exit:session-old'),
      false,
      'a suspend is not an exit: the view must stay painted, so no terminal:exit is emitted'
    )

    // The hot-set agents the user is actively working with stay live.
    assert.deepEqual(
      runtime.ipcHandlers.getTerminalStatus('session-h0'),
      { processAlive: true, suspended: false },
      'live (hot) workspaces must never be suspended by the reaper'
    )
  } finally {
    await runtime.shutdown()
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

async function assertHiddenTerminalOutputSkipsLiveIpcAndReplaysOnAttach(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-hidden-replay-'))
  mockPty.spawnCalls = []
  mockSender.sent = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
  })

  try {
    const hiddenSpawn = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: 'session_hidden_replay',
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      kind: 'terminal',
      shellOnly: true,
      visible: false,
    })
    assert.equal(hiddenSpawn.ok, true, JSON.stringify(hiddenSpawn))
    assert.equal(mockPty.spawnCalls.length, 1)

    mockPty.spawnCalls[0]?.process.emitData('hidden terminal output\r\n')
    await delay(20)
    assert.equal(
      mockSender.sent.some((event) => event.channel === 'terminal:data:session_hidden_replay'),
      false,
      'hidden terminal output must not fan out over live terminal:data IPC'
    )

    mockSender.sent = []
    const reattach = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: 'session_hidden_replay',
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      resume: true,
      kind: 'terminal',
      shellOnly: true,
      visible: true,
    })

    assert.equal(reattach.ok, true, JSON.stringify(reattach))
    assert.deepEqual(
      mockSender.sent.filter((event) => event.channel === 'terminal:replay:session_hidden_replay'),
      [{ channel: 'terminal:replay:session_hidden_replay', payload: 'hidden terminal output\r\n' }]
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

function assertRegistrationRootDerivation(runtimeModule: RuntimeModule): void {
  const root = join(tmpdir(), 'project-root')
  const statePath = join(root, '.multi-code', 'sprintengine', 'team', 'run.yaml')
  const worktreeCwd = join(root, '.multi-code', 'sprintengine', 'team', 'worktree')
  assert.equal(
    runtimeModule.deriveSprintEngineRegistrationRoot(statePath, worktreeCwd),
    root,
    'worktree launches register the project root (parent of .multi-code), not the worktree cwd'
  )
  assert.equal(
    runtimeModule.deriveSprintEngineRegistrationRoot(statePath, root),
    root,
    'standard launches keep registering the project root'
  )
  const exoticStatePath = join(tmpdir(), 'elsewhere', 'run.yaml')
  assert.equal(
    runtimeModule.deriveSprintEngineRegistrationRoot(exoticStatePath, root),
    root,
    'state paths outside a .multi-code layout fall back to the launch cwd'
  )
}

async function assertWorktreeSpawnRegistersProjectRootNotWorktreeCwd(runtimeModule: RuntimeModule): Promise<void> {
  // Live-reproduced regression: a worktree-mode agent launches with
  // cwd <root>/.multi-code/sprintengine/<run>/worktree while run.yaml lives
  // in that directory's parent. Registering the cwd as workspaceRoot and the
  // sole allowed root made every worktree spawn fail run registration with
  // HTTP 400 invalid_run_registration: statePath is outside allowedRoots.
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-worktree-'))
  const runDir = join(workspaceRoot, '.multi-code', 'sprintengine', 'v2-5-capture-everywhere')
  const sprintEngineStatePath = join(runDir, 'run.yaml')
  const worktreeCwd = join(runDir, 'worktree')
  await mkdir(worktreeCwd, { recursive: true })
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
        managedSprintEngineRunId: 'registered-run-worktree',
        runTokenEnv: { [MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR]: 'run-token-worktree' },
      }
    },
    releaseManagedSprintEngineRun: async () => undefined,
  })

  try {
    const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: 'session_worktree',
      cols: 120,
      rows: 30,
      cwd: worktreeCwd,
      sprintEngineStatePath,
      agentId: 'architect',
      cli: 'claude-code',
      kind: 'agent',
      shellOnly: false,
      mcpSettings: { syncEnabled: true, servers: {} } satisfies McpSettings,
    })

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(syncInputs.length, 1)
    assert.equal(
      syncInputs[0]?.workspaceRoot,
      worktreeCwd,
      'MCP config files still sync into the launch cwd (the worktree)'
    )
    assert.equal(
      syncInputs[0]?.managedSprintEngine?.workspaceRoot,
      workspaceRoot,
      'run registration uses the project root so the statePath is inside it'
    )
    assert.deepEqual(
      syncInputs[0]?.managedSprintEngine?.allowedRoots,
      [workspaceRoot],
      'allowed roots cover the run store and the worktree beneath the project root'
    )
    runtime.ipcHandlers.killTerminal('session_worktree')
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

// Phase 2 of the Backlog item ↔ agent link: a launched agent terminal carries
// its durable identity (workspaceId + agentId) and name as MULTICODE_* env vars
// so a typed handoff can record the same link the drag-drop path writes. Only
// the values actually present are emitted.
async function assertAgentSpawnExposesAgentIdentityEnv(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-identity-'))
  mockPty.spawnCalls = []
  mockSender.sent = []

  // Simulate the app's own process inheriting a stale identity (e.g. launched
  // from inside an agent shell): it must never leak into spawned terminals.
  const priorAgentId = process.env.MULTICODE_AGENT_ID
  process.env.MULTICODE_AGENT_ID = 'stale-leak-from-app-process'

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
    syncMcpConfig: async (): Promise<SyncResult> => ({ ok: true }),
  })

  try {
    const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: 'session_identity_env',
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      cli: 'claude-code',
      kind: 'agent',
      shellOnly: false,
      workspaceId: 'ws-42',
      agentId: 'agent-7',
      agentName: 'Fred Walsh',
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(mockPty.spawnCalls.length, 1)
    const env = (mockPty.spawnCalls[0]?.options.env ?? {}) as Record<string, string>
    assert.equal(env.MULTICODE_WORKSPACE_ID, 'ws-42')
    assert.equal(env.MULTICODE_AGENT_ID, 'agent-7', 'agent identity overrides any stale inherited id')
    assert.equal(env.MULTICODE_AGENT_NAME, 'Fred Walsh')

    // No agent identity passed → identity vars are stripped, including the stale
    // value inherited from the app process, so a plain terminal claims none.
    mockPty.spawnCalls = []
    const plain = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: 'session_identity_env_plain',
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      kind: 'terminal',
      terminalId: 'term-1',
      shellOnly: true,
    })
    assert.equal(plain.ok, true, JSON.stringify(plain))
    const plainEnv = (mockPty.spawnCalls[0]?.options.env ?? {}) as Record<string, string>
    assert.equal(plainEnv.MULTICODE_AGENT_ID, undefined, 'stale inherited identity must not leak into plain terminals')
    assert.equal(plainEnv.MULTICODE_WORKSPACE_ID, undefined)
  } finally {
    if (priorAgentId === undefined) delete process.env.MULTICODE_AGENT_ID
    else process.env.MULTICODE_AGENT_ID = priorAgentId
    await runtime.shutdown()
  }
}

async function assertStandardAgentSpawnKeepsEnabledOptionalMcpSettings(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-standard-mcp-'))
  const syncInputs: SyncInput[] = []
  const mcpSettings = createOptionalMcpSettings()
  mockPty.spawnCalls = []
  mockSender.sent = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
    syncMcpConfig: async (input): Promise<SyncResult> => {
      syncInputs.push(input)
      return { ok: true }
    },
  })

  try {
    const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: 'session_standard_optional_mcp',
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      cli: 'claude-code',
      kind: 'agent',
      shellOnly: false,
      mcpSettings,
    })

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(syncInputs.length, 1)
    assert.deepEqual(syncInputs[0]?.settings, mcpSettings)
    assert.equal(syncInputs[0]?.managedSprintEngine, undefined)
    assert.equal(syncInputs[0]?.settings.servers.playwright?.enabled, true)
    assert.equal(mockPty.spawnCalls.length, 1)
  } finally {
    await runtime.shutdown()
  }
}

async function assertSprintEngineSpawnDisablesOptionalMcpSettings(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-sprint-mcp-filter-'))
  const sprintEngineStatePath = join(workspaceRoot, '.multi-code', 'sprintengine', 'run.yaml')
  const syncInputs: SyncInput[] = []
  const mcpSettings = createOptionalMcpSettings()
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
        managedSprintEngineRunId: 'registered-run-filtered-mcp',
        runTokenEnv: { [MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR]: 'filtered-run-token' },
      }
    },
    releaseManagedSprintEngineRun: async () => undefined,
  })

  try {
    const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: 'session_sprint_optional_mcp',
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      sprintEngineStatePath,
      agentId: 'reviewer-1',
      cli: 'claude-code',
      kind: 'agent',
      shellOnly: false,
      mcpSettings,
    })

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(syncInputs.length, 1)
    assert.deepEqual(syncInputs[0]?.clients, ['claude-code'])
    assert.equal(syncInputs[0]?.settings.syncEnabled, false)
    assert.equal(syncInputs[0]?.settings.servers.playwright?.enabled, false)
    assert.equal(syncInputs[0]?.settings.servers.github?.enabled, false)
    assert.deepEqual(syncInputs[0]?.settings.servers.playwright?.clients, ['codex', 'claude-code'])
    assert.equal(mcpSettings.servers.playwright?.enabled, true, 'launch filtering must not mutate app MCP settings')
    assert.equal(syncInputs[0]?.managedSprintEngine?.statePath, sprintEngineStatePath)
    assert.equal(syncInputs[0]?.managedSprintEngine?.agentId, 'reviewer-1')
    assert.equal(syncInputs[0]?.managedSprintEngine?.cli, 'claude-code')
    assert.equal(mockPty.spawnCalls.length, 1)
    assert.equal(
      (mockPty.spawnCalls[0]?.options.env as Record<string, string> | undefined)?.[MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR],
      'filtered-run-token'
    )
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

function createOptionalMcpSettings(): McpSettings {
  return {
    syncEnabled: true,
    servers: {
      playwright: {
        id: 'playwright',
        name: 'Playwright',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
        enabled: true,
        clients: ['codex', 'claude-code'],
        scope: 'workspace',
        source: 'bundled',
        riskLevel: 'local-command',
      },
      github: {
        id: 'github',
        name: 'GitHub',
        transport: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        enabled: true,
        clients: ['claude-code'],
        scope: 'workspace',
        source: 'custom',
        riskLevel: 'network',
      },
    },
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
