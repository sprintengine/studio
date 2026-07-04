import assert from 'node:assert/strict'
import Module from 'node:module'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { WebContents } from 'electron'
import type { McpSettings, TerminalSpawnResult } from '../shared/electron-api'
import { MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR } from './sprintengine-managed-mcp-sync'
import { createTerminalSnapshotSidecarStore } from './terminal-snapshot-sidecar'

type RuntimeModule = typeof import('./terminal-runtime')
type SyncMcpConfig = NonNullable<Parameters<typeof import('./terminal-runtime')['createTerminalRuntime']>[0]['syncMcpConfig']>
type SyncInput = Parameters<SyncMcpConfig>[0]
type SyncResult = Awaited<ReturnType<SyncMcpConfig>>
type ReleaseManagedSprintEngineRun = NonNullable<Parameters<typeof import('./terminal-runtime')['createTerminalRuntime']>[0]['releaseManagedSprintEngineRun']>
type ReleaseInput = Parameters<ReleaseManagedSprintEngineRun>[0]
type CallManagedSprintEngineTool = NonNullable<Parameters<typeof import('./terminal-runtime')['createTerminalRuntime']>[0]['callManagedSprintEngineTool']>
type ToolCallInput = Parameters<CallManagedSprintEngineTool>[0]
type TerminalRuntime = ReturnType<RuntimeModule['createTerminalRuntime']>
type AgentSpawnInput = Parameters<TerminalRuntime['spawnAgentSession']>[0]
type AgentSpawnDescriptor = AgentSpawnInput['descriptor']
type AgentSessionExitEvent = Parameters<Parameters<TerminalRuntime['registerAgentSessionExitListener']>[0]>[0]

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
    await assertDescriptorSpawnExposesAgentIdentityEnv(runtimeModule)
    await assertIngestAgentStateFrameUpdatesSession(runtimeModule)
    await assertTerminalReattachUsesReplayChannel(runtimeModule)
    await assertHiddenTerminalOutputSkipsLiveIpcAndReplaysOnAttach(runtimeModule)
    await assertStaleSweepReapsOnlyUnseenHiddenTerminals(runtimeModule)
    await assertIdleSweepSuspendsRatherThanDisposes(runtimeModule)
    await assertSuspendSnapshotSidecarsSurviveRestart(runtimeModule)
    await assertIdleSweepDisposesIdleSprintEngineAgent(runtimeModule)
    await assertDebugModeEnsureInstallsDebugSkill(runtimeModule)
    await assertAgentSessionExitListenerFiresSystemTaggedForAnySystem(runtimeModule)
    await assertResolveAgentExecutionIdMatchesLiveSession(runtimeModule)
    await assertLaunchRegistryRootsIncludeUserRolesWhenPresent(runtimeModule)
  } finally {
    moduleWithLoad._load = originalLoad
  }
}

// F1 regression: the managed spawn path must surface the user-authored role
// registry root (~/.multicode/sprintengine-roles) so agent.join can resolve
// rostered authored roles. The list mirrors the read path, appending the root
// only when the directory exists. HOME is redirected so the assertion exercises
// real defaultUserRoleRegistryRoot()/existsSync logic against a temp home.
async function assertLaunchRegistryRootsIncludeUserRolesWhenPresent(
  runtimeModule: RuntimeModule
): Promise<void> {
  const tempHome = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-user-roles-'))
  const userRolesRoot = join(tempHome, '.multicode', 'sprintengine-roles')
  const originalHome = process.env.HOME
  process.env.HOME = tempHome
  try {
    assert.ok(
      !runtimeModule.sprintEngineRegistryRootsForLaunch().includes(userRolesRoot),
      'absent user-roles dir must not be added to launch registry roots'
    )

    await mkdir(userRolesRoot, { recursive: true })
    assert.ok(
      runtimeModule.sprintEngineRegistryRootsForLaunch().includes(userRolesRoot),
      'present user-roles dir must be on the launch registry roots'
    )
  } finally {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
  }
}

// The in-session memory reaper must SUSPEND idle agents (freeze-the-view), not
// dispose them: a disposed session loses its painted scrollback and falls
// through to the renderer's resume-spawn on reopen, silently relaunching the
// agent. Suspending keeps the session with `suspended = true` so reopening
// replays the frozen history and only resumes on the first keystroke. An agent
// whose authoritative hook phase is non-idle (here: awaiting_input) is never
// reaped regardless of how long it has been idle by keystroke.
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
    // Three hidden idle agents (no hook frames → recency floor) and one that is
    // authoritatively awaiting user input (a hook frame protects it).
    const oldProcess = await spawnHiddenAgent('session-old', 'ws-old')
    await spawnHiddenAgent('session-idle-b', 'ws-b')
    await spawnHiddenAgent('session-awaiting', 'ws-awaiting')

    // Mark the protected agent as awaiting_input via an authoritative hook frame.
    runtime.ingestAgentStateFrame({
      type: 'agent_state',
      agentId: 'session-awaiting',
      workspaceId: 'ws-awaiting',
      sessionId: null,
      phase: 'awaiting_input',
      event: null,
      ts: Date.now(),
    })

    // Fresh sweep leaves everything alive (nothing past the idle threshold yet).
    assert.deepEqual(
      runtimeModule.runIdleAgentReapSweep(Date.now()),
      [],
      'recently active agents must not be suspended'
    )

    // Past the idle threshold: both hookless idle agents reap; the awaiting_input
    // agent is protected by its hook phase, not by any hot-set membership.
    const wellPastIdle = Date.now() + 30 * 60 * 1000 + 1_000
    const reaped = runtimeModule.runIdleAgentReapSweep(wellPastIdle).sort()
    assert.deepEqual(
      reaped,
      ['session-idle-b', 'session-old'],
      'every idle agent past the threshold reaps; the awaiting_input agent does not'
    )

    // Suspend finalizes when the killed pty reports exit.
    oldProcess.emitExit({ exitCode: 0 })
    await delay(20)

    assert.equal(oldProcess.killed, true, 'suspending must kill the underlying pty to reclaim RAM')

    const oldStatus = await runtime.ipcHandlers.getTerminalStatus('session-old')
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

    // The awaiting-input agent stays live: a terminal blocked on the user must
    // never be frozen out from under them.
    assert.deepEqual(
      await runtime.ipcHandlers.getTerminalStatus('session-awaiting'),
      { processAlive: true, suspended: false },
      'an agent awaiting user input must never be suspended by the reaper'
    )
  } finally {
    await runtime.shutdown()
  }
}

// T1 decoupled the core runtime from Switchboard: the runtime now fires its
// agent-session-exit listener for ANY system (filtering moved into the
// switchboard module) and reports live executions as system-tagged entries.
// This locks in that generic behavior — the runtime must not special-case
// switchboard/watchtower, and the exit payload must carry system +
// workspace identity for every agent session.
async function assertAgentSessionExitListenerFiresSystemTaggedForAnySystem(
  runtimeModule: RuntimeModule
): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-agent-exit-'))
  mockPty.spawnCalls = []
  mockSender.sent = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
  })

  const events: AgentSessionExitEvent[] = []
  const unregister = runtime.registerAgentSessionExitListener((event) => {
    events.push(event)
  })

  const spawnAgent = async (
    overrides: Pick<AgentSpawnDescriptor, 'executionId' | 'system'> & { workspaceId: string }
  ): Promise<MockPtyProcess> => {
    const descriptor: AgentSpawnDescriptor = {
      executionId: overrides.executionId,
      system: overrides.system,
      workId: `work-${overrides.executionId}`,
      role: 'agent',
      displayName: `Agent ${overrides.executionId}`,
      command: ['codex'],
      cwd: workspaceRoot,
    }
    const result = await runtime.spawnAgentSession({
      workspaceId: overrides.workspaceId,
      workspaceRoot,
      descriptor,
      mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    const spawned = mockPty.spawnCalls[mockPty.spawnCalls.length - 1]?.process
    assert.ok(spawned, `expected a pty for ${overrides.executionId}`)
    return spawned
  }

  try {
    // A switchboard session and a sprintengine session prove the runtime is
    // system-agnostic: both must surface in the inventory and both must fire
    // the exit listener. The runtime no longer knows what switchboard is.
    const switchboardPty = await spawnAgent({
      executionId: 'exec-switchboard',
      system: 'switchboard',
      workspaceId: 'ws-switchboard',
    })
    const sprintEnginePty = await spawnAgent({
      executionId: 'exec-sprintengine',
      system: 'sprintengine',
      workspaceId: 'ws-sprintengine',
    })

    const liveById = new Map(
      runtime.getLiveAgentExecutionIds().map((execution) => [execution.executionId, execution.system])
    )
    assert.deepEqual(
      liveById,
      new Map([
        ['exec-switchboard', 'switchboard'],
        ['exec-sprintengine', 'sprintengine'],
      ]),
      'getLiveAgentExecutionIds must return system-tagged entries for every live agent session, not a switchboard-only id list'
    )

    switchboardPty.emitExit({ exitCode: 7 })
    sprintEnginePty.emitExit({ exitCode: 0 })
    await delay(20)

    const byExecution = new Map(events.map((event) => [event.executionId, event]))
    assert.deepEqual(
      byExecution.get('exec-switchboard'),
      {
        system: 'switchboard',
        workspaceRoot,
        workspaceId: 'ws-switchboard',
        executionId: 'exec-switchboard',
        exitCode: 7,
      },
      'switchboard session exit must fire the generic listener with the full system-tagged payload'
    )
    assert.deepEqual(
      byExecution.get('exec-sprintengine'),
      {
        system: 'sprintengine',
        workspaceRoot,
        workspaceId: 'ws-sprintengine',
        executionId: 'exec-sprintengine',
        exitCode: 0,
      },
      'a non-switchboard session must also fire the listener: filtering is the module’s job, not the runtime’s'
    )

    // Unregister stops delivery — the registration seam is a real subscription.
    unregister()
    const afterUnregister = await spawnAgent({
      executionId: 'exec-after-unregister',
      system: 'switchboard',
      workspaceId: 'ws-switchboard',
    })
    afterUnregister.emitExit({ exitCode: 1 })
    await delay(20)
    assert.equal(
      events.some((event) => event.executionId === 'exec-after-unregister'),
      false,
      'an unregistered listener must not receive further exit events'
    )
  } finally {
    unregister()
    await runtime.shutdown()
  }
}

async function assertResolveAgentExecutionIdMatchesLiveSession(
  runtimeModule: RuntimeModule
): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-resolve-exec-'))
  mockPty.spawnCalls = []
  mockSender.sent = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
  })

  const spawnAgent = async (
    overrides: Pick<AgentSpawnDescriptor, 'executionId' | 'system'> & { workspaceId: string }
  ): Promise<MockPtyProcess> => {
    const descriptor: AgentSpawnDescriptor = {
      executionId: overrides.executionId,
      system: overrides.system,
      workId: `work-${overrides.executionId}`,
      role: 'agent',
      displayName: `Agent ${overrides.executionId}`,
      command: ['codex'],
      cwd: workspaceRoot,
    }
    const result = await runtime.spawnAgentSession({
      workspaceId: overrides.workspaceId,
      workspaceRoot,
      descriptor,
      mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    const spawned = mockPty.spawnCalls[mockPty.spawnCalls.length - 1]?.process
    assert.ok(spawned, `expected a pty for ${overrides.executionId}`)
    return spawned
  }

  try {
    // The descriptor spawn keys the session's agentId to its executionId, so
    // resolveAgentExecutionId is exercised by matching (workspaceId, agentId).
    const agentPty = await spawnAgent({
      executionId: 'exec-resolve-1',
      system: 'manual',
      workspaceId: 'ws-resolve',
    })

    assert.equal(
      runtime.resolveAgentExecutionId({ workspaceId: 'ws-resolve', agentId: 'exec-resolve-1' }),
      'exec-resolve-1',
      'a live session must resolve its executionId by (workspaceId, agentId)'
    )
    // Wrong workspaceId or agentId yields no match.
    assert.equal(
      runtime.resolveAgentExecutionId({ workspaceId: 'ws-other', agentId: 'exec-resolve-1' }),
      undefined
    )
    assert.equal(
      runtime.resolveAgentExecutionId({ workspaceId: 'ws-resolve', agentId: 'no-such-agent' }),
      undefined
    )

    // After the pty exits, the session is no longer live and must not resolve.
    agentPty.emitExit({ exitCode: 0 })
    await delay(20)
    assert.equal(
      runtime.resolveAgentExecutionId({ workspaceId: 'ws-resolve', agentId: 'exec-resolve-1' }),
      undefined,
      'a dead session must not resolve an executionId'
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

// SprintEngine agents are no longer exempt from the idle reaper, AND the reaper
// DISPOSES them (not suspend/freeze-the-view): dispose fires `agent.leave`,
// which releases the agent's targets and resets it to `idle` (liveness is
// derived, not stored — no `left`/`dead` status), leaving its retained
// `lastOwnedTaskId` for the dispatch's ownership-keyed revival to respawn it
// when work returns. A frozen-but-not-disposed sprint agent would instead break
// the dispatch.
// Durable freeze-the-view: a suspended agent's painted screen must survive an
// app restart. Suspend writes a snapshot sidecar; quit (runtime shutdown) dumps
// each live agent's raw retained stream; a fresh runtime — the terminals map is
// empty after shutdown, exactly like a relaunch — rehydrates a suspended
// placeholder from the sidecar (status reports suspended, reveal replays the
// painted screen), and resume/dispose consume the sidecar so nothing stale
// lingers.
async function assertSuspendSnapshotSidecarsSurviveRestart(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-sidecar-ws-'))
  const userDataDir = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-sidecar-data-'))
  const sidecarStore = createTerminalSnapshotSidecarStore({
    resolveUserDataDir: () => userDataDir,
  })
  mockPty.spawnCalls = []
  mockSender.sent = []

  const waitFor = async (label: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
    const start = Date.now()
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
      await delay(20)
    }
  }

  const runtimeOptions = {
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
    snapshotSidecars: sidecarStore,
  }

  const spawnAgent = async (
    runtime: TerminalRuntime,
    sessionId: string,
    agentWorkspaceId: string
  ): Promise<MockPtyProcess> => {
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

  // ── "Run 1": suspend one agent, leave the other live, then quit. ──
  const runtime = runtimeModule.createTerminalRuntime(runtimeOptions)
  try {
    const frozenProcess = await spawnAgent(runtime, 'session-frozen', 'ws-frozen')
    frozenProcess.emitData('frozen painted output\r\n')
    const liveProcess = await spawnAgent(runtime, 'session-live', 'ws-live')
    liveProcess.emitData('live painted output\r\n')
    await delay(20)

    runtime.ipcHandlers.suspendTerminal('session-frozen')
    frozenProcess.emitExit({ exitCode: 0 })
    // The suspend-time sidecar lands once the async headless render settles.
    await waitFor('suspend-time sidecar write', () => sidecarStore.read('session-frozen') !== null)
    const frozenSidecar = sidecarStore.read('session-frozen')
    assert.ok(
      frozenSidecar?.snapshot?.includes('frozen painted output'),
      'suspend must persist a serialized snapshot carrying the painted content'
    )
  } finally {
    await runtime.shutdown()
  }

  // Quit dumped the still-live agent's raw retained stream.
  const liveSidecar = sidecarStore.read('session-live')
  assert.ok(
    liveSidecar?.rawReplay?.includes('live painted output'),
    'runtime shutdown must dump each live agent terminal\'s retained stream to its sidecar'
  )

  // ── "Run 2": a fresh runtime (empty terminals map = post-relaunch state). ──
  const runtime2 = runtimeModule.createTerminalRuntime(runtimeOptions)
  try {
    assert.deepEqual(
      await runtime2.ipcHandlers.getTerminalStatus('session-frozen', mockSender as unknown as WebContents),
      { processAlive: false, suspended: true },
      'a persisted suspend must rehydrate as suspended so the renderer pauses instead of launching'
    )
    mockSender.sent = []
    runtime2.ipcHandlers.setTerminalVisible('session-frozen', true, mockSender as unknown as WebContents)
    const frozenReplay = mockSender.sent.find((event) => event.channel === 'terminal:replay:session-frozen')
    assert.ok(
      typeof frozenReplay?.payload === 'string' && frozenReplay.payload.includes('frozen painted output'),
      'revealing the rehydrated terminal must replay the painted screen'
    )

    // Quit-path sidecars carry raw bytes; rehydration renders them to a
    // faithful snapshot before the placeholder is revealed.
    assert.deepEqual(
      await runtime2.ipcHandlers.getTerminalStatus('session-live', mockSender as unknown as WebContents),
      { processAlive: false, suspended: true },
      'a quit-dumped live agent must also rehydrate as suspended'
    )
    mockSender.sent = []
    runtime2.ipcHandlers.setTerminalVisible('session-live', true, mockSender as unknown as WebContents)
    const liveReplay = mockSender.sent.find((event) => event.channel === 'terminal:replay:session-live')
    assert.ok(
      typeof liveReplay?.payload === 'string' && liveReplay.payload.includes('live painted output'),
      'revealing a quit-dumped terminal must replay its painted screen'
    )

    // Resume consumes the sidecar (dispose-then-respawn under the same id).
    mockPty.spawnCalls = []
    const resumed = await runtime2.ipcHandlers.resumeTerminal(mockSender as unknown as WebContents, {
      sessionId: 'session-frozen',
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      cli: 'codex',
      kind: 'agent',
      shellOnly: false,
      workspaceId: 'ws-frozen',
      agentId: 'session-frozen',
      mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
    })
    assert.equal(resumed.ok, true, JSON.stringify(resumed))
    assert.equal(mockPty.spawnCalls.length, 1, 'resume must re-spawn a fresh pty under the same session id')
    assert.equal(
      sidecarStore.read('session-frozen'),
      null,
      'resume disposes the placeholder, which deletes the consumed sidecar'
    )

    // Dispose is terminal: killing the rehydrated placeholder deletes its sidecar.
    runtime2.ipcHandlers.killTerminal('session-live')
    assert.equal(
      sidecarStore.read('session-live'),
      null,
      'disposing a rehydrated placeholder must delete its sidecar (gone means gone)'
    )
  } finally {
    await runtime2.shutdown()
  }
}

async function assertIdleSweepDisposesIdleSprintEngineAgent(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-sprintengine-idle-dispose-'))
  const sprintEngineStatePath = join(workspaceRoot, '.multi-code', 'sprintengine', 'run.yaml')
  const toolCalls: ToolCallInput[] = []
  mockPty.spawnCalls = []
  mockSender.sent = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
    syncMcpConfig: async (): Promise<SyncResult> => ({
      ok: true,
      managedSprintEngineRunId: 'idle-dispose-run',
      runTokenEnv: { [MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR]: 'idle-dispose-token' },
    }),
    callManagedSprintEngineTool: async (input) => {
      toolCalls.push(input)
      return { ok: true }
    },
    releaseManagedSprintEngineRun: async () => undefined,
  })

  try {
    const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: 'session_sprint_idle',
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      sprintEngineStatePath,
      workspaceId: 'ws-sprint',
      agentId: 'frontend-9',
      cli: 'codex',
      kind: 'agent',
      shellOnly: false,
      visible: false,
      mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
    })
    assert.equal(result.ok, true, JSON.stringify(result))

    // A hookless sprint agent (no lifecycle frame → phase null) is NOT reaped,
    // even well past the threshold: a long autonomous turn has no keystrokes, and
    // disposing it would drop its in-flight work. Only an AUTHORITATIVELY idle
    // sprint agent is reapable.
    const wellPastIdle = Date.now() + 30 * 60 * 1000 + 1_000
    assert.deepEqual(
      runtimeModule.runIdleAgentReapSweep(wellPastIdle),
      [],
      'a hookless (null-phase) sprint agent is protected from the reaper',
    )

    // Now an authoritative `idle` hook frame marks it genuinely at-rest.
    runtime.ingestAgentStateFrame({
      type: 'agent_state',
      agentId: 'frontend-9',
      workspaceId: 'ws-sprint',
      sessionId: null,
      phase: 'idle',
      event: null,
      ts: Date.now(),
    })

    // Fresh after the frame: not yet past the threshold relative to going idle.
    assert.deepEqual(runtimeModule.runIdleAgentReapSweep(Date.now()), [], 'a freshly-idle sprint agent is not reaped')

    // While its run's dispatch loop is ACTIVELY running, the idle sprint agent is
    // protected even past the threshold — active runs are owned by the claim-aware
    // 5-min AutoRun retirement; disposing from here would race the dispatch.
    runtimeModule.setActiveSprintRunStatePaths([sprintEngineStatePath])
    assert.deepEqual(
      runtimeModule.runIdleAgentReapSweep(wellPastIdle),
      [],
      'an idle sprint agent whose run is actively dispatching is protected',
    )

    // Once its run is no longer active (completed/stopped), the agent is
    // reclaimable past the threshold (the parked-until-teardown gap this closes).
    runtimeModule.setActiveSprintRunStatePaths([])
    assert.deepEqual(
      runtimeModule.runIdleAgentReapSweep(wellPastIdle),
      ['session_sprint_idle'],
      'an authoritatively-idle sprint agent of an INACTIVE run past the threshold is reaped',
    )

    mockPty.spawnCalls[0]?.process.emitExit({ exitCode: 0 })
    await delay(20)

    // Reclaimed by DISPOSE, not suspend: the session is gone (not frozen+retained).
    assert.deepEqual(
      await runtime.ipcHandlers.getTerminalStatus('session_sprint_idle'),
      { processAlive: false, suspended: false },
      'a reaped sprint agent is disposed (gone), not suspended (frozen + retained)',
    )
    assert.ok(
      !runtime.ipcHandlers.listTerminals().some((session) => session.sessionId === 'session_sprint_idle'),
      'a disposed sprint session is not retained in the terminal list',
    )

    // Dispose fired agent.leave, which marks the agent `left` so the dispatch
    // revival path can bring it back when its role next has claimable work.
    const leaveCalls = toolCalls.filter((call) => call.toolName === 'sprintengine.agent.leave')
    assert.equal(leaveCalls.length, 1, 'disposing the idle sprint agent fires sprintengine.agent.leave (→ left → revivable)')
    assert.equal(leaveCalls[0]?.arguments?.agentId, 'frontend-9')
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
    assert.equal((await runtime.ipcHandlers.getTerminalStatus('session_success')).processAlive, true)
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

// A reporter frame updates the matching session's authoritative phase, bridges
// it to the legacy activity field, ignores stale out-of-order frames, and is a
// safe no-op for an unknown agent id.
async function assertIngestAgentStateFrameUpdatesSession(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-ingest-'))
  mockPty.spawnCalls = []
  mockSender.sent = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
    syncMcpConfig: async (): Promise<SyncResult> => ({ ok: true }),
  })

  const snapshotFor = (sessionId: string) =>
    runtime.ipcHandlers.listTerminals().find((session) => session.sessionId === sessionId)

  try {
    const spawn = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: 'sess-ingest',
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      cli: 'claude-code',
      kind: 'agent',
      shellOnly: false,
      workspaceId: 'ws-ingest',
      agentId: 'agent-ingest',
      agentName: 'Ingest',
    })
    assert.equal(spawn.ok, true, JSON.stringify(spawn))

    // Before any hook frame, an agent session exposes an inferred AgentState
    // derived from its activity (spawns working → inferred thinking).
    const initial = snapshotFor('sess-ingest')
    assert.equal(initial?.agentState?.source, 'inferred')
    assert.equal(initial?.agentState?.phase, 'thinking')

    const frame = (phase: string, ts: number) => ({
      type: 'agent_state' as const,
      agentId: 'agent-ingest',
      workspaceId: 'ws-ingest',
      sessionId: null,
      phase: phase as Parameters<typeof runtime.ingestAgentStateFrame>[0]['phase'],
      event: null,
      ts,
    })

    // awaiting_input → recorded as hook phase, bridged activity reads idle.
    runtime.ingestAgentStateFrame(frame('awaiting_input', 1000))
    let snap = snapshotFor('sess-ingest')
    assert.equal(snap?.agentState?.phase, 'awaiting_input')
    assert.equal(snap?.agentState?.source, 'hook')
    assert.equal(snap?.agentState?.since, 1000)
    assert.equal(snap?.activity.kind, 'idle')

    // A stale (older-ts) frame must not roll the phase backward.
    runtime.ingestAgentStateFrame(frame('tool_use', 500))
    snap = snapshotFor('sess-ingest')
    assert.equal(snap?.agentState?.phase, 'awaiting_input', 'stale frame rolled the phase back')

    // A newer tool_use frame applies and bridges activity to working.
    runtime.ingestAgentStateFrame(frame('tool_use', 2000))
    snap = snapshotFor('sess-ingest')
    assert.equal(snap?.agentState?.phase, 'tool_use')
    assert.equal(snap?.activity.kind, 'working')
    assert.equal(
      snap?.activity.kind === 'working' ? snap.activity.since : -1,
      2000,
      'working since anchors to the first working frame',
    )

    // Broadcast-storm guard: once "working", further within-working frames
    // (thinking ↔ tool_use) update the phase in place but must NOT re-broadcast,
    // and must preserve the working `since` so a "working for Xs" reading can
    // accumulate. The idle→working transition above already broadcast once;
    // these three churn frames must add zero broadcasts.
    const broadcastsBefore = mockSender.sent.filter((e) => e.channel === 'terminal:sessions-changed').length
    runtime.ingestAgentStateFrame(frame('thinking', 2001))
    runtime.ingestAgentStateFrame(frame('tool_use', 2002))
    runtime.ingestAgentStateFrame(frame('thinking', 2003))
    snap = snapshotFor('sess-ingest')
    assert.equal(snap?.agentState?.phase, 'thinking', 'phase tracks the latest within-working frame')
    assert.equal(snap?.agentState?.since, 2003)
    assert.equal(
      snap?.activity.kind === 'working' ? snap.activity.since : -1,
      2000,
      'working since must be preserved across thinking ↔ tool_use churn',
    )
    const broadcastsAfter = mockSender.sent.filter((e) => e.channel === 'terminal:sessions-changed').length
    assert.equal(broadcastsAfter, broadcastsBefore, 'within-working churn must not re-broadcast')

    // Output arbitration: for a hook agent the output path must NOT override an
    // authoritative awaiting_input phase back to "working" — the permission
    // prompt's own bytes would otherwise fight the hook. Drive to awaiting_input,
    // emit output, and assert both the phase and the bridged activity hold.
    runtime.ingestAgentStateFrame(frame('awaiting_input', 3000))
    snap = snapshotFor('sess-ingest')
    assert.equal(snap?.activity.kind, 'idle', 'awaiting_input bridges to idle')
    const ptyProcess = mockPty.spawnCalls.at(-1)?.process
    assert.ok(ptyProcess, 'expected a spawned pty for the ingest session')
    ptyProcess?.emitData('Allow tool? (y/n) ')
    snap = snapshotFor('sess-ingest')
    assert.equal(snap?.agentState?.phase, 'awaiting_input', 'output must not change the authoritative phase')
    assert.equal(snap?.activity.kind, 'idle', 'output must not flip a hook awaiting_input agent to working')

    // …but the working frame that fires when the approved tool completes
    // (PostToolUse → thinking) DOES clear awaiting_input. This is the only
    // mid-turn clearer, which is why PostToolUse stays registered (see
    // AGENT_STATE_HOOK_EVENTS); without it the "needs input" signal would stay
    // lit until Stop.
    runtime.ingestAgentStateFrame(frame('thinking', 3001))
    snap = snapshotFor('sess-ingest')
    assert.equal(snap?.agentState?.phase, 'thinking', 'a post-approval working frame must clear awaiting_input')
    assert.equal(snap?.activity.kind, 'working')

    // An unknown agent id is a safe no-op (no throw, nothing changed).
    runtime.ingestAgentStateFrame({
      type: 'agent_state',
      agentId: 'no-such-agent',
      workspaceId: 'ws-ingest',
      sessionId: null,
      phase: 'idle',
      event: null,
      ts: 3000,
    })
    snap = snapshotFor('sess-ingest')
    assert.equal(snap?.agentState?.phase, 'thinking', 'unknown-agent frame must not touch other sessions')

    // The CLI/harness session id the hook reports is captured onto the session
    // (distinct from our terminal id) so resume can target the conversation.
    // Routing is by the per-terminal agent id, so concurrent spawns can't
    // cross-assign it. (Frame ts must lead the prior applied frame.)
    assert.equal(snap?.cliSessionId, undefined, 'no cli session id before any hook reports one')
    runtime.ingestAgentStateFrame({
      type: 'agent_state',
      agentId: 'agent-ingest',
      workspaceId: 'ws-ingest',
      sessionId: 'codex-conv-abc123',
      phase: 'thinking',
      event: null,
      ts: 4000,
    })
    snap = snapshotFor('sess-ingest')
    assert.equal(snap?.cliSessionId, 'codex-conv-abc123', 'hook session_id is captured for resume')

    // On a real process exit the hook phase is cleared, so a stale working /
    // awaiting_input phase cannot outlive the pty and keep the attention glyph
    // lit. The snapshot then infers `exited` from the exit activity (source
    // 'inferred', not a stranded 'hook' awaiting_input).
    ptyProcess?.emitExit({ exitCode: 0 })
    snap = snapshotFor('sess-ingest')
    assert.equal(snap?.processAlive, false, 'exit marks the session not alive')
    assert.equal(snap?.activity.kind, 'exited', 'exit sets exited activity')
    assert.equal(snap?.agentState?.phase, 'exited', 'exit clears the hook phase to inferred exited')
    assert.equal(snap?.agentState?.source, 'inferred', 'post-exit phase is inferred from activity, not a stale hook')
  } finally {
    await runtime.shutdown()
  }
}

// The descriptor (SprintEngine/switchboard) launch path must also expose the
// agent's identity so the agent-state reporter can map hook frames to the
// session: MULTICODE_AGENT_ID is set to the executionId (=== session.agentId),
// and any stale id inherited by the app process is overridden.
async function assertDescriptorSpawnExposesAgentIdentityEnv(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-descriptor-identity-'))
  mockPty.spawnCalls = []
  mockSender.sent = []

  const priorAgentId = process.env.MULTICODE_AGENT_ID
  process.env.MULTICODE_AGENT_ID = 'stale-leak-from-app-process'

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
    syncMcpConfig: async (): Promise<SyncResult> => ({ ok: true }),
  })

  try {
    const result = await runtime.spawnAgentSession({
      workspaceId: 'ws-desc',
      workspaceRoot,
      descriptor: {
        executionId: 'exec-desc-1',
        system: 'sprintengine',
        workId: 'work-1',
        role: 'developer',
        displayName: 'Dev One',
        command: ['claude'],
        cwd: workspaceRoot,
        cli: 'claude-code',
      },
      mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(mockPty.spawnCalls.length, 1)
    const env = (mockPty.spawnCalls[0]?.options.env ?? {}) as Record<string, string>
    assert.equal(env.MULTICODE_AGENT_ID, 'exec-desc-1', 'descriptor identity equals executionId so reporter frames resolve')
    assert.equal(env.MULTICODE_WORKSPACE_ID, 'ws-desc')
    assert.equal(env.MULTICODE_AGENT_NAME, 'Dev One')
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

// Debug Mode is a guaranteed mode, not a discretionary skill: the spawn path must
// ensure-install the `debug` skill into the session workspace before launch (so
// the injected /debug invocation resolves to a present skill), and must NOT touch
// skills when debug is off. Asserts both the gating and the (workspaceRoot,
// skillId) the runtime requests.
async function assertDebugModeEnsureInstallsDebugSkill(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-debug-install-'))
  mockPty.spawnCalls = []
  mockSender.sent = []
  const ensureCalls: Array<{ workspaceRoot: string; skillId: string }> = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
    ensureBuiltinSkillInstalled: async (root, skillId) => {
      ensureCalls.push({ workspaceRoot: root, skillId })
    },
  })

  const spawnAgent = async (sessionId: string, debugMode: boolean): Promise<void> => {
    const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId,
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      cli: 'codex',
      kind: 'agent',
      shellOnly: false,
      workspaceId: 'ws-debug',
      agentId: sessionId,
      visible: false,
      debugMode,
      mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
  }

  // Debug off: the spawn must not ensure-install anything.
  await spawnAgent('session-debug-off', false)
  assert.deepEqual(ensureCalls, [], 'debug off must not ensure-install any skill')

  // Debug on: ensure-install the debug skill into the session workspace root.
  await spawnAgent('session-debug-on', true)
  assert.deepEqual(
    ensureCalls,
    [{ workspaceRoot, skillId: 'debug' }],
    'debug on ensure-installs the debug skill into the session workspace before launch'
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
