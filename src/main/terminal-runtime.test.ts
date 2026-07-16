import assert from 'node:assert/strict'
import Module from 'node:module'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

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
type AgentPhaseEvent = Parameters<Parameters<TerminalRuntime['registerAgentPhaseListener']>[0]>[0]
type AgentStateFrame = Parameters<TerminalRuntime['ingestAgentStateFrame']>[0]

type SentEvent = {
  channel: string
  payload: unknown
}

type MockPtyProcess = {
  pid: number
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
    // The gate-behavior sweeps below spawn only a handful of agents, which the
    // default recency floor (keep the N most recent alive) would spare wholesale.
    // Disable the floor so each per-session gate is exercised in isolation; the
    // dedicated floor assertion re-enables it.
    runtimeModule.setKeepRecentTerminalsAlive(0)
    await assertIdleSweepRecencyFloorSparesMostRecent(runtimeModule)
    await assertUserLockHoldsReaperAndSuspendedRevealIsIdempotent(runtimeModule)
    await assertSprintEngineSpawnSyncsManagedMcpBeforePtySpawn(runtimeModule)
    await assertStandardAgentSpawnKeepsEnabledOptionalMcpSettings(runtimeModule)
    await assertSprintEngineSpawnDisablesOptionalMcpSettings(runtimeModule)
    await assertWorktreeSpawnRegistersProjectRootNotWorktreeCwd(runtimeModule)
    await assertMultiRepoSpawnAllowsEveryDeclaredProjectAndNothingElse(runtimeModule)
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
    await assertSelfExitedAgentWritesSidecarButDisposeDoesNot(runtimeModule)
    await assertIdleSweepDisposesIdleSprintEngineAgent(runtimeModule)
    await assertDebugModeEnsureInstallsDebugSkill(runtimeModule)
    await assertConnectorSpawnInstallsSkillAndExcludesMcpConfig(runtimeModule)
    await assertAgentSessionExitListenerFiresSystemTaggedForAnySystem(runtimeModule)
    await assertResolveAgentExecutionIdMatchesLiveSession(runtimeModule)
    await assertLaunchRegistryRootsIncludeUserRolesWhenPresent(runtimeModule)
    await assertHeadlessSpawnAttachesToLaterWindow(runtimeModule)
    await assertGuardedSweepHoldsSessionsWithLiveSubtreeWork(runtimeModule)
    await assertPendingWakeupFrameHoldsIdleReaper(runtimeModule)
    await assertAgentPhaseListenerFiresOnlyForAcceptedFrames(runtimeModule)
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

// A ScheduleWakeup hook frame must hold the idle reaper until the wake time:
// the timer lives inside the CLI process, and the agent reads as 'idle' while
// waiting — the exact state the reaper hunts. The hold rides the PURE policy
// (no probe), so even the unguarded sync sweep respects it; a stop frame
// disarms it and the session reaps normally.
async function assertPendingWakeupFrameHoldsIdleReaper(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-wakeup-hold-'))
  mockPty.spawnCalls = []
  mockSender.sent = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
  })

  const spawnResult = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
    sessionId: 'session-wakeup',
    cols: 120,
    rows: 30,
    cwd: workspaceRoot,
    cli: 'codex',
    kind: 'agent',
    shellOnly: false,
    workspaceId: 'ws-wakeup',
    agentId: 'session-wakeup',
    visible: false,
    mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
  })
  assert.equal(spawnResult.ok, true, JSON.stringify(spawnResult))

  try {
    const scheduledAt = Date.now()
    // The agent schedules a 40-minute wakeup mid-turn (PostToolUse), then its
    // turn ends (Stop → idle). The Stop must NOT clear the pending wakeup.
    runtime.ingestAgentStateFrame({
      type: 'agent_state',
      agentId: 'session-wakeup',
      workspaceId: 'ws-wakeup',
      sessionId: null,
      phase: 'thinking',
      event: 'PostToolUse',
      ts: scheduledAt,
      wakeup: { delaySeconds: 40 * 60 },
    })
    runtime.ingestAgentStateFrame({
      type: 'agent_state',
      agentId: 'session-wakeup',
      workspaceId: 'ws-wakeup',
      sessionId: null,
      phase: 'idle',
      event: 'Stop',
      ts: scheduledAt + 1_000,
    })

    // 30 minutes on: rested well past the 15m idle threshold, but the wakeup
    // fires at +40m — the pure policy must hold it.
    const restedButPending = scheduledAt + 30 * 60 * 1000
    assert.ok(
      !runtimeModule.runIdleAgentReapSweep(restedButPending).includes('session-wakeup'),
      'an idle agent with a pending wakeup must be held by the pure policy'
    )

    // 70 minutes on: the wake time passed with no re-arm — reaps normally.
    const wakeupExpired = scheduledAt + 70 * 60 * 1000
    assert.ok(
      runtimeModule.runIdleAgentReapSweep(wakeupExpired).includes('session-wakeup'),
      'an expired wakeup must not park the session'
    )
  } finally {
    runtime.ipcHandlers.killTerminal('session-wakeup')
  }
}

// The generic phase-listener seam. Two properties carry the weight, because a
// consumer finalizes real work (opens a PR, deletes a worktree) off these events:
// only frames the runtime ACCEPTED may be published (never a stale frame, never a
// frame for a dead pty), and the wakeup a listener sees must be the one armed on
// the SESSION — the turn-end frame that a consumer acts on never carries one, so
// a passthrough of frame.wakeup would read "no wakeup" for every self-paced agent.
async function assertAgentPhaseListenerFiresOnlyForAcceptedFrames(
  runtimeModule: RuntimeModule
): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-phase-'))
  mockPty.spawnCalls = []
  mockSender.sent = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
  })

  const events: AgentPhaseEvent[] = []
  // Registered FIRST and throwing synchronously: a faulting listener must take
  // down neither the listeners behind it nor the frame ingest itself.
  const unregisterThrowing = runtime.registerAgentPhaseListener(() => {
    throw new Error('listener boom')
  })
  const unregister = runtime.registerAgentPhaseListener((event) => {
    events.push(event)
  })

  const spawnAgentTerminal = async (sessionId: string, agentId: string): Promise<MockPtyProcess> => {
    const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId,
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      cli: 'claude-code',
      kind: 'agent',
      shellOnly: false,
      workspaceId: 'ws-phase',
      agentId,
      visible: false,
      mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    const spawned = mockPty.spawnCalls[mockPty.spawnCalls.length - 1]?.process
    assert.ok(spawned, `expected a pty for ${sessionId}`)
    return spawned
  }

  const frame = (overrides: Partial<AgentStateFrame> & Pick<AgentStateFrame, 'phase' | 'event' | 'ts'>): AgentStateFrame => ({
    type: 'agent_state',
    agentId: 'agent-phase',
    workspaceId: 'ws-phase',
    sessionId: null,
    ...overrides,
  })

  const listenerFailures: unknown[] = []
  const originalConsoleError = console.error
  console.error = (...args: unknown[]): void => {
    listenerFailures.push(args[0])
  }

  try {
    const pty = await spawnAgentTerminal('session-phase', 'agent-phase')
    const scheduledAt = Date.now()
    const wakeupAt = scheduledAt + 20 * 60 * 1000

    // Mid-turn: the ScheduleWakeup PostToolUse frame is the ONLY frame the
    // reporter ever attaches a wakeup to.
    runtime.ingestAgentStateFrame(frame({
      phase: 'thinking',
      event: 'PostToolUse',
      ts: scheduledAt,
      wakeup: { delaySeconds: 20 * 60 },
    }))
    // Turn end: carries no wakeup of its own, but must still report the armed one.
    runtime.ingestAgentStateFrame(frame({
      phase: 'idle',
      event: 'Stop',
      ts: scheduledAt + 1_000,
      transcriptPath: '/tmp/transcript.jsonl',
    }))
    await delay(20)

    assert.deepEqual(
      events.map((event) => event.event),
      ['PostToolUse', 'Stop'],
      'the raw reporter event name must ride the event unmodified, and a throwing listener ahead of this one must not have suppressed delivery'
    )
    assert.equal(
      listenerFailures.length,
      2,
      'each faulting listener call must be reported, not swallowed'
    )
    assert.deepEqual(
      events[1],
      {
        workspaceId: 'ws-phase',
        agentId: 'agent-phase',
        executionId: null,
        phase: 'idle',
        previousPhase: 'thinking',
        event: 'Stop',
        ts: scheduledAt + 1_000,
        pendingWakeupAt: wakeupAt,
        transcriptPath: '/tmp/transcript.jsonl',
      },
      'a turn end must report the session-resolved pending wakeup, not the frame’s (absent) one'
    )
    assert.ok(
      (events[1]?.pendingWakeupAt ?? 0) > Date.now(),
      'the armed wakeup must still be in the future on the turn-end event'
    )

    // A stale frame (older than the recorded phase) is rejected upstream of the
    // listener, so no consumer can act on a phase the runtime itself ignored.
    const before = events.length
    runtime.ingestAgentStateFrame(frame({ phase: 'thinking', event: 'PreToolUse', ts: scheduledAt - 1 }))
    await delay(20)
    assert.equal(events.length, before, 'a stale frame must not reach a phase listener')

    // A late frame for a dead pty must not reach a listener either: it would let
    // a consumer finalize a run whose agent is already gone.
    pty.emitExit({ exitCode: 0 })
    await delay(20)
    const beforeDeadFrame = events.length
    runtime.ingestAgentStateFrame(frame({ phase: 'idle', event: 'Stop', ts: Date.now() + 5_000 }))
    await delay(20)
    assert.equal(events.length, beforeDeadFrame, 'a frame for a dead pty must not reach a phase listener')

    // Unregister stops delivery — the registration seam is a real subscription.
    unregister()
    unregisterThrowing()
    const pty2 = await spawnAgentTerminal('session-phase-2', 'agent-phase-2')
    runtime.ingestAgentStateFrame(frame({
      agentId: 'agent-phase-2',
      phase: 'idle',
      event: 'Stop',
      ts: Date.now(),
    }))
    await delay(20)
    assert.equal(
      events.some((event) => event.agentId === 'agent-phase-2'),
      false,
      'an unregistered listener must not receive further phase events'
    )

    // A consumer's reaction to a phase event is asynchronous — summarize the
    // transcript, open a PR, remove the worktree — so shutdown must WAIT on it
    // rather than tear the runtime down on top of half-finished finalization.
    // Gated rather than timed: the listener hangs until we release it, so
    // shutdown can only settle early by failing to track the work at all.
    let releaseFinalization = (): void => {}
    const finalization = new Promise<void>((resolve) => {
      releaseFinalization = resolve
    })
    let finalizationCompleted = false
    const unregisterSlow = runtime.registerAgentPhaseListener(async () => {
      await finalization
      finalizationCompleted = true
    })
    runtime.ingestAgentStateFrame(frame({
      agentId: 'agent-phase-2',
      phase: 'idle',
      event: 'Stop',
      ts: Date.now(),
    }))

    let shutdownSettled = false
    const shutdownComplete = runtime.shutdown().then(() => {
      shutdownSettled = true
    })
    // Let the pty report its exit, so shutdown's terminal wait is satisfied and
    // the ONLY thing it can still be blocked on is the listener's finalization.
    await delay(20)
    pty2.emitExit({ exitCode: 0 })
    await delay(100)
    assert.equal(
      shutdownSettled,
      false,
      'shutdown must not settle while a phase listener is still finalizing'
    )

    releaseFinalization()
    await shutdownComplete
    unregisterSlow()
    assert.equal(
      finalizationCompleted,
      true,
      'shutdown must drain in-flight phase-listener work'
    )
  } finally {
    console.error = originalConsoleError
    unregister()
    unregisterThrowing()
    await runtime.shutdown()
  }
}

// Headless spawn + window attach (sprint-runtime-ownership Phase 3): the main
// scheduler spawns sprint agents with no window using the headless sender —
// the PTY runs and retains scrollback while every outbound send no-ops — and
// a window that opens later reattaches through the spawnTerminal
// existing-session branch, adopting the real WebContents and replaying the
// buffered output.
async function assertHeadlessSpawnAttachesToLaterWindow(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-headless-'))
  mockPty.spawnCalls = []
  mockSender.sent = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
  })

  const { createHeadlessTerminalSender } = require('./terminal-session') as
    typeof import('./terminal-session')

  const headless = await runtime.ipcHandlers.spawnTerminal(createHeadlessTerminalSender(), {
    sessionId: 'session-headless',
    cols: 100,
    rows: 30,
    cwd: workspaceRoot,
    cli: 'codex',
    kind: 'agent',
    shellOnly: false,
    workspaceId: 'ws-headless',
    agentId: 'session-headless',
    visible: false,
    mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
  })
  assert.equal(headless.ok, true, JSON.stringify(headless))
  assert.equal(mockPty.spawnCalls.length, 1, 'headless spawn still creates the PTY')

  try {
    // Output emitted with no window buffers into retained scrollback without
    // throwing (the headless sender reports destroyed, so nothing sends).
    mockPty.spawnCalls[0]!.process.emitData('headless output before any window\r\n')

    // A window opens later: the same-sessionId spawn adopts the real sender
    // and replays the buffered scrollback instead of respawning.
    const reattach = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: 'session-headless',
      cols: 100,
      rows: 30,
      cwd: workspaceRoot,
      cli: 'codex',
      kind: 'agent',
      shellOnly: false,
      workspaceId: 'ws-headless',
      agentId: 'session-headless',
      visible: true,
      mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
    })
    assert.equal(reattach.ok, true, JSON.stringify(reattach))
    assert.equal(mockPty.spawnCalls.length, 1, 'reattach adopts the live session; no second PTY')
    const replay = mockSender.sent.find((event) => event.channel === 'terminal:replay:session-headless')
    assert.ok(replay, 'reattach replays scrollback to the newly attached window')
    assert.ok(
      String(replay?.payload ?? '').includes('headless output before any window'),
      'replay carries output produced while headless'
    )
  } finally {
    runtime.ipcHandlers.killTerminal('session-headless')
  }
}

// The guarded sweep must HOLD an idle-past-threshold agent whose pty subtree
// still has live work under it — the canonical case is a `run_in_background`
// shell idling toward a result (0% CPU, no port; only the shell-snapshot
// wrapper signature marks it). Killing the CLI would kill that shell and the
// resumed session would report "No completion record was found for this
// background shell command". Once the subtree probes clean, the same session
// reaps normally on the next sweep.
async function assertGuardedSweepHoldsSessionsWithLiveSubtreeWork(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-guarded-sweep-'))
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
    const busyProcess = await spawnHiddenAgent('session-bg-shell', 'ws-guard-busy')
    await spawnHiddenAgent('session-guard-quiet', 'ws-guard-quiet')

    const wellPastIdle = Date.now() + 30 * 60 * 1000 + 1_000
    // ps tree: the busy agent's pty root has a Claude tool-shell child (a
    // backgrounded `sleep`-style waiter: 0% CPU, no listening port).
    const busyPsTree = [
      `${busyProcess.pid} 1 0.0 /bin/zsh -l startup.sh`,
      `${busyProcess.pid + 100_000} ${busyProcess.pid} 0.0 /bin/zsh -c source /Users/dev/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'sleep 300'`,
    ].join('\n')

    const heldSweep = await runtimeModule.runGuardedTerminalReapSweeps(wellPastIdle, {
      subtree: { platform: 'darwin', runPs: async () => busyPsTree, runLsofListening: async () => '' },
    })
    assert.ok(
      !heldSweep.idleReaped.includes('session-bg-shell'),
      'an idle agent with a live background tool shell must be held, not reaped'
    )
    assert.ok(
      heldSweep.idleReaped.includes('session-guard-quiet'),
      'an idle agent whose subtree probes clean must still reap in the same sweep'
    )
    assert.equal(busyProcess.killed, false, 'holding must not touch the pty')

    // The background shell finished: the subtree probes clean and the same
    // session now reaps normally.
    const cleanSweep = await runtimeModule.runGuardedTerminalReapSweeps(wellPastIdle + 1_000, {
      subtree: {
        platform: 'darwin',
        runPs: async () => `${busyProcess.pid} 1 0.0 /bin/zsh -l startup.sh`,
        runLsofListening: async () => '',
      },
    })
    assert.ok(
      cleanSweep.idleReaped.includes('session-bg-shell'),
      'once the background work finishes the held session must reap on the next sweep'
    )
  } finally {
    runtime.ipcHandlers.killTerminal('session-bg-shell')
    runtime.ipcHandlers.killTerminal('session-guard-quiet')
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

// Recency floor ("Always keep running"): with the configured keep-alive count
// set, an idle sweep reaps only down to that many live agent terminals, sparing
// the most recently used — so a user's active set can never be paused wholesale.
async function assertIdleSweepRecencyFloorSparesMostRecent(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-recency-floor-'))
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
    runtimeModule.setKeepRecentTerminalsAlive(2)

    const oldProcess = await spawnHiddenAgent('floor-old', 'ws-floor-old')
    await spawnHiddenAgent('floor-mid', 'ws-floor-mid')
    await spawnHiddenAgent('floor-new', 'ws-floor-new')
    // Stagger real keystrokes so the recency order is unambiguous (spawn
    // timestamps can share a millisecond): mid, then new, most recent last.
    await delay(5)
    runtime.ipcHandlers.writeTerminal('floor-mid', 'x')
    await delay(5)
    runtime.ipcHandlers.writeTerminal('floor-new', 'x')

    // All three are idle past the threshold, but the floor of 2 spares the two
    // most recently used — only the oldest is suspended.
    const wellPastIdle = Date.now() + 30 * 60 * 1000 + 1_000
    assert.deepEqual(
      runtimeModule.runIdleAgentReapSweep(wellPastIdle),
      ['floor-old'],
      'the sweep must reap only down to the keep-alive floor, oldest-rested first'
    )

    // Finalize the suspend (the killed pty reports exit) so the suspended
    // session drops out of the live-agent population.
    oldProcess.emitExit({ exitCode: 0 })
    await delay(20)

    // A later sweep still holds: the survivors ARE the floor.
    assert.deepEqual(
      runtimeModule.runIdleAgentReapSweep(wellPastIdle + 60_000),
      [],
      'the spared agents form the floor and must stay alive on subsequent sweeps'
    )
  } finally {
    runtimeModule.setKeepRecentTerminalsAlive(0)
    await runtime.shutdown()
  }
}

// Per-terminal user lock + idempotent suspended reveal:
// 1. A locked (reapExempt) agent survives the idle sweep and the 24h stale
//    backstop; unlocking makes it reapable again.
// 2. Revealing a suspended session resends the painted replay even when main
//    already has visible=true (a renderer reload/remount can miss the unmount
//    hide; edge-triggered reveal left the fresh xterm blank under "Paused").
async function assertUserLockHoldsReaperAndSuspendedRevealIsIdempotent(
  runtimeModule: RuntimeModule
): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-lock-'))
  mockPty.spawnCalls = []
  mockSender.sent = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
  })

  try {
    for (const sessionId of ['session-lock-a', 'session-lock-b']) {
      const spawned = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId,
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'codex',
        kind: 'agent',
        shellOnly: false,
        workspaceId: `ws-${sessionId}`,
        agentId: sessionId,
        visible: false,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(spawned.ok, true, JSON.stringify(spawned))
    }
    mockPty.spawnCalls[0]?.process.emitData('painted output a\r\n')
    mockPty.spawnCalls[1]?.process.emitData('painted output b\r\n')
    await delay(20)

    runtime.ipcHandlers.setTerminalReapExempt('session-lock-a', true)
    assert.equal(
      runtime.ipcHandlers.listTerminals().find((s) => s.sessionId === 'session-lock-a')?.reapExempt,
      true,
      'the lock must surface on the session snapshot for the renderer control'
    )

    // Idle sweep well past the threshold: only the unlocked agent is suspended.
    const wellPastIdle = Date.now() + 30 * 60 * 1000 + 1_000
    assert.deepEqual(
      runtimeModule.runIdleAgentReapSweep(wellPastIdle),
      ['session-lock-b'],
      'the locked agent must survive the idle sweep'
    )
    mockPty.spawnCalls[1]?.process.emitExit({ exitCode: 0 })
    await delay(20)
    assert.deepEqual(
      await runtime.ipcHandlers.getTerminalStatus('session-lock-b'),
      { processAlive: false, suspended: true }
    )

    // Idempotent reveal: the first setVisible(true) is the hidden→visible edge;
    // the second finds visible already true and must STILL resend the replay —
    // a suspended pty is dead, so a fresh xterm that missed the edge can only
    // be painted by this resend.
    mockSender.sent = []
    runtime.ipcHandlers.setTerminalVisible('session-lock-b', true, mockSender as unknown as WebContents)
    runtime.ipcHandlers.setTerminalVisible('session-lock-b', true, mockSender as unknown as WebContents)
    const replays = mockSender.sent.filter((event) => event.channel === 'terminal:replay:session-lock-b')
    assert.equal(replays.length, 2, 'suspended reveal must resend the replay even when already visible')
    assert.ok(
      replays.every((event) => typeof event.payload === 'string' && event.payload.length > 0),
      'suspended reveal replays must carry painted content'
    )

    // 24h stale backstop: the locked agent is hidden and unseen well past the
    // stale window, but the lock is absolute — dispose is forbidden too.
    const wellPastStale = Date.now() + 25 * 60 * 60 * 1000
    const staleReaped = runtimeModule.reapStaleTerminals(wellPastStale)
    assert.equal(
      staleReaped.includes('session-lock-a'),
      false,
      'the locked agent must survive the stale backstop'
    )
    assert.ok(
      runtime.ipcHandlers.listTerminals().some((s) => s.sessionId === 'session-lock-a'),
      'the locked agent must still be listed after the stale sweep'
    )

    // Unlock → the very next idle sweep reclaims it.
    runtime.ipcHandlers.setTerminalReapExempt('session-lock-a', false)
    assert.deepEqual(
      runtimeModule.runIdleAgentReapSweep(wellPastIdle),
      ['session-lock-a'],
      'unlocking must make the agent reapable again'
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
        // Descriptor spawns key the terminal's agentId off the executionId; the
        // pair is what an automation correlates on once the execution is gone.
        agentId: 'exec-switchboard',
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
        agentId: 'exec-sprintengine',
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

// An agent pty that ends on its own — an automation run finishing, a CLI
// crashing — was never suspended and never saw app quit, so it used to write NO
// sidecar. That is the COMMON case for a finished automation agent, and with no
// painted screen on disk its tab had nothing to show on cold load. Self-exit is
// the third write site. A deliberate dispose still means gone: dispose deletes
// the sidecar and then kills the pty, so the exit handler must not resurrect it.
async function assertSelfExitedAgentWritesSidecarButDisposeDoesNot(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-selfexit-ws-'))
  const userDataDir = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-selfexit-data-'))
  const sidecarStore = createTerminalSnapshotSidecarStore({
    resolveUserDataDir: () => userDataDir,
  })
  mockPty.spawnCalls = []
  mockSender.sent = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
    snapshotSidecars: sidecarStore,
  })

  const spawnAgent = async (sessionId: string, kind: 'agent' | 'terminal'): Promise<MockPtyProcess> => {
    const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId,
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      cli: 'codex',
      kind,
      shellOnly: kind === 'terminal',
      workspaceId: 'ws-selfexit',
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
    // The automation case: the run finished and the CLI exited by itself.
    const finished = await spawnAgent('session-selfexit', 'agent')
    finished.emitData('automation run MM-37 complete\r\n')
    await delay(20)
    finished.emitExit({ exitCode: 0 })
    await delay(20)

    const sidecar = sidecarStore.read('session-selfexit')
    assert.ok(
      sidecar?.rawReplay?.includes('automation run MM-37 complete'),
      'an agent pty that exits on its own must persist its painted content, so the tab reopens paused instead of relaunching'
    )

    // A deliberate dispose deletes the sidecar and then kills the pty. The exit
    // that follows must NOT write one back — gone means gone.
    const disposed = await spawnAgent('session-disposed', 'agent')
    disposed.emitData('disposed painted output\r\n')
    await delay(20)
    runtime.ipcHandlers.killTerminal('session-disposed')
    disposed.emitExit({ exitCode: 0 })
    await delay(20)
    assert.equal(
      sidecarStore.read('session-disposed'),
      null,
      'a disposed terminal must not resurrect a sidecar on the exit that dispose itself triggered'
    )

    // Plain shells respawn fresh on reopen; painted-pause is an agent promise.
    const shell = await spawnAgent('session-shell', 'terminal')
    shell.emitData('$ echo hi\r\n')
    await delay(20)
    shell.emitExit({ exitCode: 0 })
    await delay(20)
    assert.equal(
      sidecarStore.read('session-shell'),
      null,
      'a plain shell writes no sidecar on exit'
    )
  } finally {
    await runtime.shutdown()
  }
}

async function assertIdleSweepDisposesIdleSprintEngineAgent(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-sprintengine-idle-dispose-'))
  const sprintEngineStatePath = join(workspaceRoot, '.multi-code', 'sprintengine', 'run.yaml')
  const toolCalls: ToolCallInput[] = []
  const reapDiagnostics: Array<{ message: string; sessionId?: string }> = []
  mockPty.spawnCalls = []
  mockSender.sent = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logDiagnostic: (diagnostic) => reapDiagnostics.push(diagnostic),
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
    // The skip audit persists WHICH gate held a rested agent (once per hour).
    assert.equal(reapDiagnostics.length, 1, 'a rested-but-held agent logs exactly one skip entry')
    assert.ok(
      reapDiagnostics[0].message.includes('in_active_run'),
      `skip entry names the holding gate: ${reapDiagnostics[0].message}`,
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
    // Same holding gate within the rate window: not re-logged (volume bound).
    assert.equal(reapDiagnostics.length, 1, 'an unchanged hold within the hour is deduped')

    // Once its run is no longer active (completed/stopped), the agent is
    // reclaimable past the threshold (the parked-until-teardown gap this closes).
    runtimeModule.setActiveSprintRunStatePaths([])
    assert.deepEqual(
      runtimeModule.runIdleAgentReapSweep(wellPastIdle),
      ['session_sprint_idle'],
      'an authoritatively-idle sprint agent of an INACTIVE run past the threshold is reaped',
    )
    // The reap ACTION is persisted alongside the in-memory ring buffer.
    assert.equal(reapDiagnostics.length, 2, 'the reap action lands in the diagnostics trail')
    assert.ok(
      reapDiagnostics[1].message.includes('disposed a sprint agent'),
      `action entry describes the dispose: ${reapDiagnostics[1].message}`,
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

async function assertMultiRepoSpawnAllowsEveryDeclaredProjectAndNothingElse(runtimeModule: RuntimeModule): Promise<void> {
  // An agent working a task in a project the run declared must be able to reach that
  // project's files; a project the run never declared stays outside its surface.
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-multi-repo-'))
  const declared = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-declared-'))
  const undeclared = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-undeclared-'))
  const runDir = join(workspaceRoot, '.multi-code', 'sprintengine', 'multi-repo')
  const sprintEngineStatePath = join(runDir, 'run.yaml')
  const worktreeCwd = join(runDir, 'worktree')
  const mobileWorktreeCwd = join(runDir, 'worktree-mobile')
  await mkdir(worktreeCwd, { recursive: true })
  await mkdir(mobileWorktreeCwd, { recursive: true })
  await writeFile(
    join(runDir, 'projection.json'),
    JSON.stringify({
      run: {
        vcs: {
          mode: 'run_worktree',
          repos: [
            { id: 'primary', root: '.', worktreePath: relative(workspaceRoot, worktreeCwd), branchName: 'sprintengine/multi-repo' },
            { id: 'mobile', root: relative(workspaceRoot, declared), worktreePath: relative(workspaceRoot, mobileWorktreeCwd), branchName: 'sprintengine/multi-repo' },
          ],
        },
      },
    }),
    'utf-8'
  )
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
        managedSprintEngineRunId: 'registered-run-multi-repo',
        runTokenEnv: { [MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR]: 'run-token-multi-repo' },
      }
    },
    releaseManagedSprintEngineRun: async () => undefined,
  })

  try {
    const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: 'session_multi_repo',
      cols: 120,
      rows: 30,
      cwd: worktreeCwd,
      sprintEngineStatePath,
      agentId: 'developer-1',
      cli: 'claude-code',
      kind: 'agent',
      shellOnly: false,
      mcpSettings: { syncEnabled: true, servers: {} } satisfies McpSettings,
    })

    assert.equal(result.ok, true, JSON.stringify(result))
    const allowedRoots = syncInputs[0]?.managedSprintEngine?.allowedRoots ?? []
    assert.deepEqual(
      allowedRoots,
      [workspaceRoot, realpathSync(declared)],
      'allowed roots are exactly the projects the run declared: its own plus each declared sibling'
    )
    assert.ok(!allowedRoots.includes(undeclared), 'a project the run never declared is not authorized')
    // MC-1613: the session's repo is bound from the worktree it launched in, so
    // its `task.next` only ever offers work living in that tree.
    assert.equal(
      syncInputs[0]?.managedSprintEngine?.repo,
      'primary',
      'a session launched in the primary worktree binds to the primary repo'
    )
    runtime.ipcHandlers.killTerminal('session_multi_repo')

    const mobileResult = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: 'session_multi_repo_mobile',
      cols: 120,
      rows: 30,
      cwd: mobileWorktreeCwd,
      sprintEngineStatePath,
      agentId: 'developer-2',
      cli: 'claude-code',
      kind: 'agent',
      shellOnly: false,
      mcpSettings: { syncEnabled: true, servers: {} } satisfies McpSettings,
    })
    assert.equal(mobileResult.ok, true, JSON.stringify(mobileResult))
    assert.equal(
      syncInputs[1]?.managedSprintEngine?.repo,
      'mobile',
      'the same run spawning into the mobile worktree binds that session to the mobile repo'
    )
    runtime.ipcHandlers.killTerminal('session_multi_repo_mobile')
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(declared, { recursive: true, force: true })
    await rm(undeclared, { recursive: true, force: true })
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

let nextMockPtyPid = 50_000

function createMockPtyProcess(): MockPtyProcess {
  const dataCallbacks = new Set<(data: string) => void>()
  const exitCallbacks = new Set<(event: { exitCode: number, signal?: number }) => void>()
  return {
    pid: nextMockPtyPid++,
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

// A connector spawn carries two orthogonal signals: connectorSkillId gates the
// skill install (a skill-less connector chat sets none), and connectorLaunch
// gates MCP isolation — the worktree MCP-config git-exclude here (and the
// unlisted-server prune). A skill-only spawn must NOT exclude, and an ordinary
// spawn does neither.
async function assertConnectorSpawnInstallsSkillAndExcludesMcpConfig(
  runtimeModule: RuntimeModule
): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-connector-'))
  mockPty.spawnCalls = []
  mockSender.sent = []
  const ensureCalls: Array<{ workspaceRoot: string; skillId: string }> = []
  const excludeCalls: string[] = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
    ensureBuiltinSkillInstalled: async (root, skillId) => {
      ensureCalls.push({ workspaceRoot: root, skillId })
    },
    excludeWorktreeMcpConfig: async (worktreePath) => {
      excludeCalls.push(worktreePath)
    },
  })

  const spawnConnector = async (
    sessionId: string,
    options: { connectorSkillId?: string; connectorLaunch?: boolean } = {},
  ): Promise<void> => {
    const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId,
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      cli: 'claude-code',
      kind: 'agent',
      shellOnly: false,
      workspaceId: 'ws-connector',
      agentId: sessionId,
      visible: false,
      ...options,
      mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
  }

  // Ordinary spawn: neither the connector install nor the MCP-config exclude
  // runs.
  await spawnConnector('session-connector-off')
  assert.deepEqual(ensureCalls, [], 'ordinary spawn must not install a connector skill')
  assert.deepEqual(excludeCalls, [], 'ordinary spawn must not exclude worktree MCP config')

  // A skill install without connectorLaunch (skill-at-spawn shapes) must not
  // trigger MCP isolation — connectorSkillId never implies pruning/excluding.
  await spawnConnector('session-connector-skill-only', { connectorSkillId: 'use-railway' })
  assert.deepEqual(
    ensureCalls,
    [{ workspaceRoot, skillId: 'use-railway' }],
    'skill-only spawn installs the named skill'
  )
  assert.deepEqual(excludeCalls, [], 'skill-only spawn must not exclude worktree MCP config')

  // A full connector launch (connectorLaunch + driving skill): install the
  // skill AND exclude the generated MCP config from the worktree git.
  await spawnConnector('session-connector-on', { connectorSkillId: 'use-railway', connectorLaunch: true })
  assert.deepEqual(
    ensureCalls,
    [
      { workspaceRoot, skillId: 'use-railway' },
      { workspaceRoot, skillId: 'use-railway' },
    ],
    'connector spawn installs the connector skill into the worktree before launch'
  )
  assert.deepEqual(
    excludeCalls,
    [workspaceRoot],
    'connector spawn excludes the worktree MCP config from git'
  )

  // A skill-less connector launch (plain installed MCP): no skill install, but
  // the MCP isolation still applies.
  await spawnConnector('session-connector-skillless', { connectorLaunch: true })
  assert.equal(ensureCalls.length, 2, 'skill-less connector launch installs no skill')
  assert.deepEqual(
    excludeCalls,
    [workspaceRoot, workspaceRoot],
    'skill-less connector launch still excludes the worktree MCP config'
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
