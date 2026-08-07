import assert from 'node:assert/strict'
import { join } from 'node:path'
import type {
  DiagnosticLogInput,
  TerminalSessionSnapshot,
  TerminalSpawnResult,
} from '../shared/electron-api'
import type { PluginRegistryListEntry } from '../shared/plugin-manifest'
import type { AgentState } from '../shared/sprintengine/agent-state'
import type {
  SprintEngineAutomationIntentRecord,
  SprintEngineAutomationRuntimeResidue,
} from '../shared/sprintengine/automation-intent'
import type { SprintEngineAutomationMode } from '../shared/sprintengine/automation-types'
import type { TerminalSpawnArgs } from '../shared/sprintengine/auto-run-executor'
import type { SprintEngineLaunchSettings } from '../shared/sprintengine/launch-settings'
import type {
  SprintRuntimeOp,
  SprintRuntimeRunRegistration,
} from '../shared/sprintengine/runtime-bridge'
import { renderAgentLaunchArgv } from './agent-launch-render'
import { createPluginRegistry } from './plugin-registry'
import {
  __resetPluginRegistryForTest,
  __setPluginRegistryForTest,
} from './plugin-registry-instance'
import { createSprintRuntime, type SprintRuntimeDeps } from './sprint-runtime'

// ---------------------------------------------------------------------------
// Fixtures. The scheduler drives the REAL shared cycle
// (src/shared/sprintengine/auto-run-cycle.ts) — only the environment (terminal
// runtime, projection reads, clock, timers, power) is faked.
// ---------------------------------------------------------------------------

const STATE_PATH = '/repo/fixture/.multi-code/sprintengine/team/run.yaml'
const FOLDER_PATH = '/repo/fixture'
const WORKSPACE_ID = 'ws-fixture'

function automationRecord(mode: SprintEngineAutomationMode): SprintEngineAutomationIntentRecord {
  return {
    schemaVersion: 1,
    revision: 1,
    desiredMode: mode,
    changedAt: 0,
    lastWrite: { actor: 'system', deviceId: null, at: new Date(0).toISOString() },
  }
}

/** Raw projection.json payload that yields a bootstrap architect spawn: an
 *  architect on the roster, roleRuntimes binding it to `claude`, no tasks. */
function bootstrapProjection(): unknown {
  return {
    run: {
      name: 'Fixture Run',
      goal: 'Ship the fixture',
      rosterConfigured: true,
      roleRuntimes: { architect: { cli: 'claude' } },
    },
    roster: { 'architect-1': { role: 'architect', status: 'idle', currentTaskId: null } },
    tasks: [],
    artifacts: [],
    activity: [],
  }
}

/** Bootstrap projection whose architect seat also configures a model and a
 *  reasoning-effort level, on a CLI whose bundled manifest declares
 *  reasoningSelection (MC-1885). `roleRuntimes` is the ONLY source here: the
 *  registration carries no agent record, so anything that reaches the spawn came
 *  from the projection. */
function seatEffortProjection(reasoning?: string): unknown {
  return {
    run: {
      name: 'Fixture Run',
      goal: 'Ship the fixture',
      rosterConfigured: true,
      roleRuntimes: {
        architect: {
          cli: 'claude-code',
          model: 'claude-opus-5',
          ...(reasoning ? { reasoning } : {}),
        },
      },
    },
    roster: { 'architect-1': { role: 'architect', status: 'idle', currentTaskId: null } },
    tasks: [],
    artifacts: [],
    activity: [],
  }
}

/** Projection of a user-canceled run: stored run flag + a canceled task. */
function canceledProjection(): unknown {
  return {
    run: {
      name: 'Fixture Run',
      goal: 'Ship the fixture',
      status: 'canceled',
      rosterConfigured: true,
      roleRuntimes: { architect: { cli: 'claude' } },
    },
    roster: { 'architect-1': { role: 'architect', status: 'idle', currentTaskId: null } },
    tasks: [
      {
        id: 'T1',
        title: 'Only task',
        description: '',
        role: 'developer',
        status: 'canceled',
        ownerAgentId: null,
        dependsOn: [],
        ownedPaths: [],
        acceptanceCriteria: [],
        implementationNotes: [],
        evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
        notes: [],
        comments: [],
        startedAt: null,
        completedAt: null,
        boardColumn: 'canceled',
      },
    ],
    artifacts: [],
    activity: [],
  }
}

/** Projection whose single task is done — the run is complete. */
function completedProjection(): unknown {
  return {
    run: {
      name: 'Fixture Run',
      goal: 'Ship the fixture',
      rosterConfigured: true,
      roleRuntimes: { architect: { cli: 'claude' } },
    },
    roster: { 'architect-1': { role: 'architect', status: 'idle', currentTaskId: null } },
    tasks: [
      {
        id: 'T1',
        title: 'Only task',
        description: '',
        role: 'developer',
        status: 'done',
        ownerAgentId: null,
        dependsOn: [],
        ownedPaths: [],
        acceptanceCriteria: [],
        implementationNotes: [],
        evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
        notes: [],
        comments: [],
        startedAt: null,
        completedAt: null,
        boardColumn: 'done',
      },
    ],
    artifacts: [],
    activity: [],
  }
}

function registration(overrides: Partial<SprintRuntimeRunRegistration> = {}): SprintRuntimeRunRegistration {
  return {
    statePath: STATE_PATH,
    workspaceId: WORKSPACE_ID,
    workspaceName: 'Fixture Run',
    folderPath: FOLDER_PATH,
    memoryRelativeRoot: null,
    cliPermissionPreset: 'default',
    maxConcurrentAgents: 3,
    deliveredAgentNotificationEventKeys: [],
    rosterSessions: {},
    agents: {},
    agentConfigs: {},
    ...overrides,
  }
}

const LAUNCH_SETTINGS: SprintEngineLaunchSettings = {
  cliRuntimes: { claude: { command: 'claude', useWsl: false } },
  mcp: {
    syncEnabled: true,
    servers: {
      fixture: {
        id: 'fixture',
        name: 'Fixture MCP',
        transport: 'stdio',
        command: 'fixture-mcp',
        enabled: true,
        clients: [],
        scope: 'workspace',
        source: 'custom',
        riskLevel: 'low',
      },
    },
  },
  projectKnowledgeRoots: {},
  lastSelectedCli: null,
  lastAgentSpawnPermissionPreset: null,
  sprintEngineRoleSettings: { enabled: {} },
}

type Harness = {
  runtime: ReturnType<typeof createSprintRuntime>
  clock: { now: number }
  spawnCalls: TerminalSpawnArgs[]
  killedSessionIds: string[]
  ops: SprintRuntimeOp[]
  powerActive: string[]
  powerInactive: string[]
  projectionReads: string[]
  diagnostics: DiagnosticLogInput[]
  persistedResidue: Array<{ statePath: string; runtime: SprintEngineAutomationRuntimeResidue }>
  liveSessions: TerminalSessionSnapshot[]
  /** Per-statePath projection payload + mode-intent record served to the runtime. */
  projections: Map<string, unknown>
  modes: Map<string, SprintEngineAutomationIntentRecord | null>
}

function createHarness(options: {
  projection?: unknown
  mode?: SprintEngineAutomationMode | null
  spawnFails?: boolean
  pluginCatalog?: PluginRegistryListEntry[]
} = {}): Harness {
  const clock = { now: 1_000_000 }
  const spawnCalls: TerminalSpawnArgs[] = []
  const killedSessionIds: string[] = []
  const ops: SprintRuntimeOp[] = []
  const powerActive: string[] = []
  const powerInactive: string[] = []
  const projectionReads: string[] = []
  const diagnostics: DiagnosticLogInput[] = []
  const persistedResidue: Array<{ statePath: string; runtime: SprintEngineAutomationRuntimeResidue }> = []
  const liveSessions: TerminalSessionSnapshot[] = []
  const projections = new Map<string, unknown>([[STATE_PATH, options.projection ?? bootstrapProjection()]])
  const modes = new Map<string, SprintEngineAutomationIntentRecord | null>([
    [STATE_PATH, options.mode === null ? null : automationRecord(options.mode ?? 'run_agents')],
  ])

  const deps: SprintRuntimeDeps = {
    terminal: {
      list: () => [...liveSessions],
      write: () => undefined,
      kill: (sessionId) => {
        killedSessionIds.push(sessionId)
        const index = liveSessions.findIndex((session) => session.sessionId === sessionId)
        if (index >= 0) liveSessions.splice(index, 1)
      },
      status: async (sessionId) => ({
        processAlive: liveSessions.some((session) => session.sessionId === sessionId && session.processAlive),
      }),
      spawn: async (args) => {
        spawnCalls.push(args)
        if (options.spawnFails) {
          return { ok: false, sessionId: args.sessionId, message: 'spawn refused', exitCode: 1 } as TerminalSpawnResult
        }
        const metadata = (args.metadata ?? {}) as Record<string, unknown>
        liveSessions.push({
          sessionId: args.sessionId,
          processAlive: true,
          kind: 'agent',
          workspaceId: metadata.workspaceId as string,
          agentId: metadata.agentId as string,
          sprintEngineStatePath: args.sprintEngineStatePath,
          cli: args.cli,
          cliSessionId: args.sessionId,
        } as unknown as TerminalSessionSnapshot)
        return { ok: true, sessionId: args.sessionId } as TerminalSpawnResult
      },
    },
    artifacts: {
      ensureTaskWorktree: async () => ({ ok: true, isolated: false, worktreePath: null }),
      readProjection: async ({ statePath, knownToken }) => {
        projectionReads.push(statePath)
        if (knownToken === 'token-1') return { ok: true, data: null, token: 'token-1', unchanged: true }
        return { ok: true, data: projections.get(statePath) ?? null, token: 'token-1' }
      },
      autoApproveArtifact: async () => ({ ok: true as const, data: {} }),
    },
    pathExists: async () => true,
    resolveMemoryRoot: async (_workspaceRoot, relativeRoot) => ({
      ok: false,
      status: 'inaccessible',
      relativeRoot,
      message: 'not used by the fixture',
    }),
    getPluginCatalogEntries: () => options.pluginCatalog ?? [],
    getLaunchSettings: () => LAUNCH_SETTINGS,
    readAutomationMode: async (statePath) => modes.get(statePath) ?? null,
    persistRuntimeResidue: (statePath, runtime) => {
      persistedResidue.push({ statePath, runtime })
    },
    powerManager: {
      markRunActive: (statePath) => powerActive.push(statePath),
      markRunInactive: (statePath) => powerInactive.push(statePath),
      shutdown: () => undefined,
    },
    broadcastOp: (op) => ops.push(op),
    logDiagnostic: (input) => {
      diagnostics.push(input)
    },
    now: () => clock.now,
    // Timers are inert: every tick is driven explicitly through tickNow().
    timers: {
      setInterval: () => ({}),
      clearInterval: () => undefined,
    },
  }

  return {
    runtime: createSprintRuntime(deps),
    clock,
    spawnCalls,
    killedSessionIds,
    ops,
    powerActive,
    powerInactive,
    projectionReads,
    diagnostics,
    persistedResidue,
    liveSessions,
    projections,
    modes,
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const STARTUP_SPAWN_DELAY_MS = 10_000

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

// (1) registerRun + run_agents intent record -> run active, power marked,
// tick reads the projection into the run view.
async function testRegistrationActivatesRun(): Promise<void> {
  const harness = createHarness()
  harness.runtime.registerRun(registration())
  await settle()

  assert.ok(harness.powerActive.includes(STATE_PATH), 'run_agents adoption marks the run power-active')
  assert.ok(harness.projectionReads.includes(STATE_PATH), 'the wake tick reads the projection')
  const run = harness.runtime.inspectRun(STATE_PATH)
  assert.ok(run, 'run is registered')
  assert.equal(run.view.sprintEngineAutoState?.desiredMode, 'run_agents')
  assert.equal(run.view.sprintEngineAutoState?.runtimeState, 'running')
  assert.equal(run.view.sprintEngineState?.name, 'Fixture Run', 'projection was normalized into the run view')
  assert.equal(run.view.agents['architect-1']?.cli, 'claude', 'roster reconcile stamped the role runtime')
  assert.equal(harness.spawnCalls.length, 0, 'no spawn inside the startup delay')

  harness.runtime.shutdown()
}

// (2) startup spawn delay, then a bootstrap architect spawn with the full
// payload + broadcasts.
async function testStartupDelayThenBootstrapSpawn(): Promise<void> {
  const harness = createHarness()
  harness.runtime.registerRun(registration())
  await settle()
  assert.equal(harness.spawnCalls.length, 0, 'no spawn before the startup delay elapses')

  harness.clock.now += STARTUP_SPAWN_DELAY_MS + 1
  await harness.runtime.tickNow()

  assert.equal(harness.spawnCalls.length, 1, 'bootstrap architect spawned once the delay elapsed')
  const spawn = harness.spawnCalls[0]
  assert.ok(typeof spawn.sessionId === 'string' && spawn.sessionId.length > 0, 'sessionId minted via the randomUUID port')
  assert.equal(spawn.cli, 'claude', 'cli resolved from roleRuntimes')
  assert.equal(spawn.sprintEngineStatePath, STATE_PATH)
  assert.equal(spawn.cwd, FOLDER_PATH)
  assert.equal(spawn.resume, false, 'fresh bootstrap conversation')
  assert.ok(
    typeof spawn.initialPrompt === 'string' && spawn.initialPrompt.includes('architect-1'),
    'startup prompt was generated for the bootstrap architect',
  )
  assert.deepEqual(spawn.cliRuntimes, LAUNCH_SETTINGS.cliRuntimes, 'cliRuntimes from the mirrored launch settings')
  const metadata = spawn.metadata as Record<string, unknown>
  assert.equal(metadata.workspaceId, WORKSPACE_ID)
  assert.equal(metadata.agentId, 'architect-1')
  assert.deepEqual(metadata.mcpSettings, LAUNCH_SETTINGS.mcp, 'metadata.mcpSettings from the mirrored launch settings')

  const kinds = new Set(harness.ops.map((op) => op.kind))
  assert.ok(kinds.has('agent_updated'), 'agent_updated broadcast emitted')
  assert.ok(kinds.has('launch_state'), 'launch_state broadcast emitted')
  const assignOp = harness.ops.find((op) => op.kind === 'assign_session')
  assert.ok(assignOp && assignOp.kind === 'assign_session', 'assign_session broadcast emitted')
  assert.equal(assignOp.agentId, 'architect-1')
  assert.equal(assignOp.sessionId, spawn.sessionId)
  assert.equal(assignOp.cli, 'claude')
  assert.ok(harness.ops.every((op) => op.statePath === STATE_PATH), 'every broadcast carries the statePath')

  harness.runtime.shutdown()
}

// (3) applyStopReason('agent_terminal_closed') pauses the run: power released,
// no further spawns.
async function testStopReasonPausesRun(): Promise<void> {
  const harness = createHarness()
  harness.runtime.registerRun(registration())
  await settle()
  harness.clock.now += STARTUP_SPAWN_DELAY_MS + 1
  await harness.runtime.tickNow()
  assert.equal(harness.spawnCalls.length, 1, 'precondition: the bootstrap spawn happened')

  harness.runtime.applyStopReason({ statePath: STATE_PATH, reason: 'agent_terminal_closed' })
  const run = harness.runtime.inspectRun(STATE_PATH)
  assert.equal(run?.view.sprintEngineAutoState?.runtimeState, 'paused', 'terminal close pauses the run')
  assert.ok(harness.powerInactive.includes(STATE_PATH), 'pausing releases the power assertion')

  // The renderer that pushed already applied it locally; no echo broadcast.
  assert.ok(!harness.ops.some((op) => op.kind === 'stop_reason'), 'no stop_reason echo back to the windows')

  const spawnsBefore = harness.spawnCalls.length
  await harness.runtime.tickNow()
  assert.equal(harness.spawnCalls.length, spawnsBefore, 'a paused run never spawns')

  harness.runtime.shutdown()
}

// (4) notifyAutomationChanged manual -> pause + power release; re-enable ->
// spawning proceeds again.
async function testAutomationChangedPauseAndResume(): Promise<void> {
  const harness = createHarness()
  harness.runtime.registerRun(registration())
  await settle()
  assert.ok(harness.powerActive.includes(STATE_PATH))

  harness.runtime.notifyAutomationChanged(STATE_PATH, { ...automationRecord('manual'), revision: 2 })
  const paused = harness.runtime.inspectRun(STATE_PATH)
  assert.equal(paused?.view.sprintEngineAutoState?.desiredMode, 'manual')
  assert.ok(harness.powerInactive.includes(STATE_PATH), 'manual releases the power assertion')

  harness.clock.now += STARTUP_SPAWN_DELAY_MS + 1
  await harness.runtime.tickNow()
  assert.equal(harness.spawnCalls.length, 0, 'manual mode never spawns')

  harness.runtime.notifyAutomationChanged(STATE_PATH, { ...automationRecord('run_agents'), revision: 3 })
  await settle()
  await harness.runtime.tickNow()
  assert.equal(harness.spawnCalls.length, 1, 're-enabling automation spawns again')

  harness.runtime.shutdown()
}

// (5) completion: every task done -> dormancy (stop_reason all_tasks_done +
// completion_teardown_at broadcasts, power released); the next tick no-ops.
async function testCompletionEntersDormancy(): Promise<void> {
  const harness = createHarness({ projection: completedProjection() })
  harness.runtime.registerRun(registration())
  await settle()
  harness.clock.now += STARTUP_SPAWN_DELAY_MS + 1
  await harness.runtime.tickNow()

  const stopOp = harness.ops.find((op) => op.kind === 'stop_reason')
  assert.ok(stopOp && stopOp.kind === 'stop_reason', 'completion broadcasts a stop_reason')
  assert.equal(stopOp.reason, 'all_tasks_done')
  const teardownOp = harness.ops.find((op) => op.kind === 'completion_teardown_at')
  assert.ok(teardownOp && teardownOp.kind === 'completion_teardown_at', 'completion broadcasts the teardown marker')
  assert.equal(teardownOp.at, harness.clock.now, 'teardown marker stamped from the injected clock')
  assert.ok(harness.powerInactive.includes(STATE_PATH), 'completion releases the power assertion')
  const run = harness.runtime.inspectRun(STATE_PATH)
  assert.equal(run?.view.sprintEngineAutoState?.runtimeState, 'complete')
  assert.equal(run?.view.sprintEngineAutoState?.completionTeardownAt, harness.clock.now)
  assert.equal(harness.spawnCalls.length, 0, 'a complete run never spawns')

  const opsBefore = harness.ops.length
  await harness.runtime.tickNow()
  assert.equal(harness.ops.length, opsBefore, 'the second tick does nothing (one-shot dormancy)')
  assert.equal(harness.spawnCalls.length, 0)

  harness.runtime.shutdown()
}

// (5b) cancelRun (MC-1604): user cancellation parks the run in the terminal
// `canceled` state with the SAME one-shot teardown as completion (marker + power
// release), but NO `all_tasks_done` stop_reason — the Canceled glyph is derived
// from the stored run flag. A second cancel is a one-shot no-op.
async function testCancelRunEntersDormancy(): Promise<void> {
  const harness = createHarness()
  harness.runtime.registerRun(registration())
  await settle()

  harness.runtime.cancelRun(STATE_PATH)

  const run = harness.runtime.inspectRun(STATE_PATH)
  assert.equal(run?.view.sprintEngineAutoState?.runtimeState, 'canceled', 'cancel parks the run in the terminal canceled state')
  assert.equal(run?.view.sprintEngineAutoState?.completionTeardownAt, harness.clock.now, 'cancel runs the shared one-shot teardown')
  assert.ok(harness.powerInactive.includes(STATE_PATH), 'cancel releases the power assertion')
  const teardownOp = harness.ops.find((op) => op.kind === 'completion_teardown_at')
  assert.ok(teardownOp && teardownOp.kind === 'completion_teardown_at', 'cancel broadcasts the shared teardown marker')
  assert.ok(!harness.ops.some((op) => op.kind === 'stop_reason'), 'cancel does not broadcast an all_tasks_done stop_reason')

  const opsBefore = harness.ops.length
  harness.runtime.cancelRun(STATE_PATH)
  assert.equal(harness.ops.length, opsBefore, 'a second cancel is a one-shot no-op')

  harness.runtime.shutdown()
}

// (5c) The supervisor hard gate also catches a canceled run: a tick over a
// projection carrying the stored cancel flag enters dormancy through the shared
// helper, which derives `runner_canceled` from the flag (not `runner_complete`),
// so a canceled run left in `running` stops polling on the next tick.
async function testCanceledProjectionEntersDormancyViaGate(): Promise<void> {
  const harness = createHarness({ projection: canceledProjection() })
  harness.runtime.registerRun(registration())
  await settle()
  harness.clock.now += STARTUP_SPAWN_DELAY_MS + 1
  await harness.runtime.tickNow()

  const run = harness.runtime.inspectRun(STATE_PATH)
  assert.equal(run?.view.sprintEngineAutoState?.runtimeState, 'canceled', 'the gate parks a canceled projection in the canceled state')
  assert.equal(run?.view.sprintEngineAutoState?.completionTeardownAt, harness.clock.now, 'the shared teardown marker is stamped')
  assert.ok(harness.powerInactive.includes(STATE_PATH), 'a canceled run releases the power assertion')
  assert.ok(!harness.ops.some((op) => op.kind === 'stop_reason'), 'the canceled gate path fires no all_tasks_done stop_reason')
  assert.equal(harness.spawnCalls.length, 0, 'a canceled run never spawns')

  harness.runtime.shutdown()
}

// (6) unregisterRun releases power and forgets the run.
async function testUnregisterReleasesPower(): Promise<void> {
  const harness = createHarness()
  harness.runtime.registerRun(registration())
  await settle()
  assert.ok(harness.runtime.inspectRun(STATE_PATH))

  harness.runtime.unregisterRun(STATE_PATH)
  assert.ok(harness.powerInactive.includes(STATE_PATH), 'unregister releases the power assertion')
  assert.equal(harness.runtime.inspectRun(STATE_PATH), null, 'the run is forgotten')

  const spawnsBefore = harness.spawnCalls.length
  harness.clock.now += STARTUP_SPAWN_DELAY_MS + 1
  await harness.runtime.tickNow()
  assert.equal(harness.spawnCalls.length, spawnsBefore, 'an unregistered run never spawns')

  harness.runtime.shutdown()
}

// Re-registration refresh: config follows the renderer, runtime residue stays
// main-owned once adopted.
async function testReRegistrationKeepsMainOwnedResidue(): Promise<void> {
  const harness = createHarness()
  harness.runtime.registerRun(registration())
  await settle()
  harness.clock.now += STARTUP_SPAWN_DELAY_MS + 1
  await harness.runtime.tickNow()
  assert.equal(harness.spawnCalls.length, 1)
  const launchedAgent = harness.runtime.inspectRun(STATE_PATH)?.view.agents['architect-1']
  assert.ok(launchedAgent?.cliSessionId, 'precondition: main holds live launch state')

  // The renderer re-registers with stale residue (its mirror lags) and a new
  // config value: config is adopted, residue is not.
  harness.runtime.registerRun(registration({ maxConcurrentAgents: 5, agents: {} }))
  const run = harness.runtime.inspectRun(STATE_PATH)
  assert.equal(run?.view.sprintEngineAutoState?.maxConcurrentAgents, 5, 'config refresh adopted')
  assert.equal(run?.view.sprintEngineAutoState?.runtimeState, 'running', 'runtime state survives the refresh')
  assert.equal(
    run?.view.agents['architect-1']?.cliSessionId,
    launchedAgent?.cliSessionId,
    'main-owned agent launch state survives a re-registration',
  )

  harness.runtime.shutdown()
}

// (8) applyResume reaches the scheduler: a renderer-originated pause
// (terminal closed) re-enters `running` through the runner_started recovery
// gesture, re-acquiring the power assertion. Unknown runs are a no-op.
async function testApplyResumeReachesScheduler(): Promise<void> {
  const harness = createHarness()
  harness.runtime.registerRun(registration())
  await settle()
  harness.clock.now += STARTUP_SPAWN_DELAY_MS + 1
  await harness.runtime.tickNow()
  assert.equal(harness.spawnCalls.length, 1, 'precondition: the bootstrap spawn happened')

  harness.runtime.applyStopReason({ statePath: STATE_PATH, reason: 'agent_terminal_closed', context: {} })
  const paused = harness.runtime.inspectRun(STATE_PATH)
  assert.equal(paused?.view.sprintEngineAutoState?.runtimeState, 'paused', 'terminal close pauses the run')
  assert.ok(harness.powerInactive.includes(STATE_PATH), 'pausing releases the power assertion')

  const powerActiveBefore = harness.powerActive.length
  harness.runtime.applyResume(STATE_PATH)
  const resumed = harness.runtime.inspectRun(STATE_PATH)
  assert.equal(resumed?.view.sprintEngineAutoState?.runtimeState, 'running', 'resume re-enters running')
  assert.equal(resumed?.view.sprintEngineAutoState?.desiredMode, 'run_agents', 'resume is a same-mode recovery')
  assert.ok(harness.powerActive.length > powerActiveBefore, 'resume re-acquires the power assertion')
  assert.equal(harness.powerActive[harness.powerActive.length - 1], STATE_PATH)

  // Unknown statePath: silent no-op, never a throw.
  harness.runtime.applyResume('/nowhere/run.yaml')
  await settle()

  harness.runtime.shutdown()
}

const CLAUDE_CATALOG_ENTRY: PluginRegistryListEntry = {
  id: 'claude',
  displayName: 'Claude Code',
  source: 'bundled',
  version: 1,
  binary: 'claude',
  resumeSession: true,
  sessionIdFromCaller: true,
}

// (9) Resume-capability stamping: dispatchAssignTerminalSession stamps the
// plugin catalog's resume capabilities onto MAIN's own agent record (not just
// the bridge op), and syncAgentSessionIdentity mirrors the harness resume id
// captured on the live session into the record on the next tick.
async function testResumeCapabilityStampingOnMainView(): Promise<void> {
  const harness = createHarness({ pluginCatalog: [CLAUDE_CATALOG_ENTRY] })
  harness.runtime.registerRun(registration())
  await settle()
  harness.clock.now += STARTUP_SPAWN_DELAY_MS + 1
  await harness.runtime.tickNow()
  assert.equal(harness.spawnCalls.length, 1, 'precondition: the bootstrap spawn happened')
  const sessionId = harness.spawnCalls[0].sessionId

  const agent = harness.runtime.inspectRun(STATE_PATH)?.view.agents['architect-1']
  assert.equal(agent?.cliSessionId, sessionId, 'main view carries the assigned session id')
  assert.equal(agent?.cliResumeAvailable, true, 'resumeSession capability stamped on main view at assign')
  assert.equal(agent?.cliUsesStableSessionId, true, 'sessionIdFromCaller capability stamped on main view at assign')

  // The agent-state hook later captures the CLI's own resume id onto the live
  // session snapshot; the next tick's syncAgentSessionIdentity mirrors it.
  const liveSession = harness.liveSessions.find((session) => session.sessionId === sessionId)
  assert.ok(liveSession, 'the spawned session is live')
  ;(liveSession as { cliSessionId?: string }).cliSessionId = 'harness-123'
  await harness.runtime.tickNow()
  assert.equal(
    harness.runtime.inspectRun(STATE_PATH)?.view.agents['architect-1']?.harnessSessionId,
    'harness-123',
    'the harness resume id was mirrored into main\'s agent record',
  )

  harness.runtime.shutdown()
}

/** Completed projection with a developer + tester roster (no live architect):
 *  the population a completed run carries — exited and idle-reaped agents. */
function twoAgentCompletedProjection(): unknown {
  return {
    run: {
      name: 'Fixture Run',
      goal: 'Ship the fixture',
      rosterConfigured: true,
      roleRuntimes: { developer: { cli: 'claude' }, tester: { cli: 'claude' } },
    },
    roster: {
      'dev-1': { role: 'developer', status: 'idle', currentTaskId: null },
      'qa-1': { role: 'tester', status: 'idle', currentTaskId: null },
    },
    tasks: [
      {
        id: 'T1',
        title: 'Only task',
        description: '',
        role: 'developer',
        status: 'done',
        ownerAgentId: null,
        dependsOn: [],
        ownedPaths: [],
        acceptanceCriteria: [],
        implementationNotes: [],
        evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
        notes: [],
        comments: [],
        startedAt: null,
        completedAt: null,
        boardColumn: 'done',
      },
    ],
    artifacts: [],
    activity: [],
  }
}

// (10) Completion teardown covers suspended AND already-exited agents: the
// dormancy sweep records a resumable roster session for an idle-reaped
// (suspended) agent and for an agent whose terminal already exited but whose
// record still holds a resume identity, kills only the disposable session,
// and persists the whole residue.
async function testCompletionTeardownCoversSuspendedAndExitedAgents(): Promise<void> {
  const harness = createHarness({ projection: twoAgentCompletedProjection() })
  // Agent B was idle-reaped: its PTY is suspended (processAlive false) but the
  // placeholder still owns a recordable resume identity.
  harness.liveSessions.push({
    sessionId: 'sess-b',
    processAlive: false,
    suspended: true,
    kind: 'agent',
    workspaceId: WORKSPACE_ID,
    agentId: 'qa-1',
    sprintEngineStatePath: STATE_PATH,
    cli: 'claude',
    cliSessionId: 'harness-b',
  } as unknown as TerminalSessionSnapshot)
  // Agent A's terminal already exited — no live session at all — but its
  // record still carries the resumable identity.
  const exitedAgent: AgentState = {
    id: 'dev-1',
    name: 'Dev',
    status: 'idle',
    execution: { mode: 'current_workspace', worktreeId: null, cwd: null },
    messages: [],
    streamBuffer: '',
    kind: 'sprintengine',
    cli: 'claude',
    cliSessionId: 'sess-a',
  }
  harness.runtime.registerRun(registration({ agents: { 'dev-1': exitedAgent } }))
  await settle()
  harness.clock.now += STARTUP_SPAWN_DELAY_MS + 1
  await harness.runtime.tickNow()

  const recordedAgentIds = harness.ops
    .map((op) => (op.kind === 'roster_session_recorded' ? op.agentId : null))
    .filter((agentId): agentId is string => agentId !== null)
  assert.ok(recordedAgentIds.includes('dev-1'), 'the exited agent\'s session was recorded')
  assert.ok(recordedAgentIds.includes('qa-1'), 'the suspended agent\'s session was recorded')
  const devRecorded = harness.ops.find(
    (op) => op.kind === 'roster_session_recorded' && op.agentId === 'dev-1',
  )
  assert.ok(devRecorded && devRecorded.kind === 'roster_session_recorded')
  assert.equal(devRecorded.session.role, 'developer')
  assert.equal(devRecorded.session.cliSessionId, 'sess-a', 'resume token from the exited agent\'s record')
  const qaRecorded = harness.ops.find(
    (op) => op.kind === 'roster_session_recorded' && op.agentId === 'qa-1',
  )
  assert.ok(qaRecorded && qaRecorded.kind === 'roster_session_recorded')
  assert.equal(qaRecorded.session.role, 'tester')
  assert.equal(qaRecorded.session.cliSessionId, 'harness-b', 'resume token from the suspended session snapshot')

  const retiredAgentIds = harness.ops
    .map((op) => (op.kind === 'worker_retired' ? op.agentId : null))
    .filter((agentId): agentId is string => agentId !== null)
  assert.ok(retiredAgentIds.includes('dev-1'), 'the exited agent was retired')
  assert.ok(retiredAgentIds.includes('qa-1'), 'the suspended agent was retired')
  assert.ok(harness.killedSessionIds.includes('sess-b'), 'the suspended session was disposed')
  assert.ok(
    harness.ops.some((op) => op.kind === 'completion_teardown_at' && op.at !== undefined),
    'the completion teardown marker was broadcast',
  )
  assert.ok(harness.powerInactive.includes(STATE_PATH), 'completion releases the power assertion')

  const lastResidue = harness.persistedResidue[harness.persistedResidue.length - 1]
  assert.ok(lastResidue, 'the teardown persisted runtime residue')
  assert.equal(lastResidue.statePath, STATE_PATH)
  assert.ok(lastResidue.runtime.rosterSessions['dev-1'], 'the exited agent\'s roster session persisted')
  assert.ok(lastResidue.runtime.rosterSessions['qa-1'], 'the suspended agent\'s roster session persisted')
  assert.equal(lastResidue.runtime.completionTeardownAt, harness.clock.now, 'the teardown marker persisted')

  harness.runtime.shutdown()
}

// (11) Agent-config merge on re-registration: renderer-owned per-agent config
// (runtime override, rename, queued startup prompt) is adopted without
// disturbing main-owned launch flags; a later registration with the config
// cleared clears the override + prompt while the rename sticks.
async function testAgentConfigMergeOnReRegistration(): Promise<void> {
  const harness = createHarness()
  harness.runtime.registerRun(registration())
  await settle()
  harness.clock.now += STARTUP_SPAWN_DELAY_MS + 1
  await harness.runtime.tickNow()
  const launched = harness.runtime.inspectRun(STATE_PATH)?.view.agents['architect-1']
  assert.ok(launched?.cliSessionId, 'precondition: main holds live launch state')

  // A user edit carries a fresh configEditedAt stamp (newer than the spawn's
  // own startup-prompt-consumption stamp).
  harness.clock.now += 1
  const editStamp = harness.clock.now
  harness.runtime.registerRun(registration({
    agentConfigs: {
      'architect-1': {
        cliRuntimeOverride: { cli: 'codex', model: null },
        name: 'Custom Name',
        cliStartupPrompt: 'do the thing',
        configEditedAt: editStamp,
      },
    },
  }))
  const configured = harness.runtime.inspectRun(STATE_PATH)?.view.agents['architect-1']
  assert.deepEqual(configured?.cliRuntimeOverride, { cli: 'codex', model: null }, 'runtime override adopted')
  assert.equal(configured?.name, 'Custom Name', 'rename adopted')
  assert.equal(configured?.cliStartupPrompt, 'do the thing', 'queued startup prompt adopted')
  assert.equal(configured?.cliSessionId, launched?.cliSessionId, 'launch flags untouched by the config merge')

  // A lagging window's mirror — older stamp, tombstoned fields — must never
  // clobber the newer edit; neither may an unstamped registration.
  harness.runtime.registerRun(registration({
    agentConfigs: {
      'architect-1': { cliRuntimeOverride: null, cliStartupPrompt: null, configEditedAt: editStamp - 10 },
    },
  }))
  harness.runtime.registerRun(registration({
    agentConfigs: { 'architect-1': { cliRuntimeOverride: null, cliStartupPrompt: null } },
  }))
  const protectedConfig = harness.runtime.inspectRun(STATE_PATH)?.view.agents['architect-1']
  assert.deepEqual(protectedConfig?.cliRuntimeOverride, { cli: 'codex', model: null }, 'stale mirror cannot clobber the override')
  assert.equal(protectedConfig?.cliStartupPrompt, 'do the thing', 'stale mirror cannot clobber the queued prompt')

  // An agent absent from the payload is untouched (no opinion, not a clear).
  harness.runtime.registerRun(registration({ agentConfigs: {} }))
  const untouched = harness.runtime.inspectRun(STATE_PATH)?.view.agents['architect-1']
  assert.deepEqual(untouched?.cliRuntimeOverride, { cli: 'codex', model: null }, 'absent config leaves the override alone')

  // The user explicitly cleared the override and prompt (tombstones, newer
  // stamp); the rename (absent field) is retained.
  harness.clock.now += 1
  harness.runtime.registerRun(registration({
    agentConfigs: {
      'architect-1': { cliRuntimeOverride: null, cliStartupPrompt: null, configEditedAt: harness.clock.now },
    },
  }))
  const cleared = harness.runtime.inspectRun(STATE_PATH)?.view.agents['architect-1']
  assert.equal(cleared?.cliRuntimeOverride, undefined, 'explicit tombstone clears the runtime override')
  assert.equal(cleared?.cliStartupPrompt, undefined, 'explicit tombstone clears the startup prompt')
  assert.equal(cleared?.name, 'Custom Name', 'the rename is retained')
  assert.equal(cleared?.cliSessionId, launched?.cliSessionId, 'launch flags still untouched')

  harness.runtime.shutdown()
}

// (12) Sidecar residue adoption on first registration: the automation
// sidecar's runtime block is MAIN's own durable bookkeeping and supersedes the
// renderer-mirrored residue the registration seeded.
async function testSidecarResidueAdoptionOnFirstRegistration(): Promise<void> {
  const harness = createHarness({ projection: completedProjection() })
  const residue: SprintEngineAutomationRuntimeResidue = {
    deliveredAgentNotificationEventKeys: ['EVT-9'],
    completionTeardownAt: 123,
    rosterSessions: {
      dev: { role: 'developer', cli: 'claude-code', cliSessionId: 'old', recordedAt: 1 },
    },
  }
  harness.modes.set(STATE_PATH, { ...automationRecord('run_agents'), runtime: residue })

  harness.runtime.registerRun(registration())
  await settle()

  const run = harness.runtime.inspectRun(STATE_PATH)
  assert.deepEqual(
    run?.view.sprintEngineAutoState?.deliveredAgentNotificationEventKeys,
    ['EVT-9'],
    'sidecar delivered keys adopted',
  )
  assert.equal(
    run?.view.sprintEngineAutoState?.completionTeardownAt,
    123,
    'sidecar completion-teardown marker adopted',
  )
  assert.ok(run?.rosterSessions['dev'], 'sidecar roster session adopted')
  assert.equal(run?.rosterSessions['dev']?.cliSessionId, 'old')

  harness.runtime.shutdown()
}

// (13) Sidecar-mode adoption preserves the renderer-persisted lifecycle: a run
// the user saw paused must not auto-resume on app relaunch. Resume is an
// explicit gesture (applyResume).
async function testAdoptionPreservesPausedLifecycle(): Promise<void> {
  const harness = createHarness()
  harness.runtime.registerRun(registration({
    runtimeState: 'paused',
    reason: 'terminal_closed',
    reasonMessage: 'An agent terminal was closed.',
  }))
  await settle()

  const run = harness.runtime.inspectRun(STATE_PATH)
  assert.equal(run?.view.sprintEngineAutoState?.desiredMode, 'run_agents', 'sidecar mode adopted')
  assert.equal(run?.view.sprintEngineAutoState?.runtimeState, 'paused', 'persisted pause preserved through adoption')
  assert.equal(run?.view.sprintEngineAutoState?.reason, 'terminal_closed', 'pause reason preserved')
  assert.ok(!harness.powerActive.includes(STATE_PATH), 'a paused run never asserts power')

  harness.clock.now += STARTUP_SPAWN_DELAY_MS + 1
  await harness.runtime.tickNow()
  assert.equal(harness.spawnCalls.length, 0, 'a paused run never spawns after relaunch')

  harness.runtime.applyResume(STATE_PATH)
  await settle()
  await harness.runtime.tickNow()
  assert.equal(harness.spawnCalls.length, 1, 'the explicit Resume gesture restarts scheduling')

  harness.runtime.shutdown()
}

// (14) A completed run stays complete through adoption: no power assertion, no
// scheduling, no projection churn.
async function testAdoptionPreservesCompletedLifecycle(): Promise<void> {
  const harness = createHarness({ projection: completedProjection() })
  harness.runtime.registerRun(registration({
    runtimeState: 'complete',
    reason: 'all_tasks_done',
    completionTeardownAt: 123,
  }))
  await settle()

  const run = harness.runtime.inspectRun(STATE_PATH)
  assert.equal(run?.view.sprintEngineAutoState?.desiredMode, 'run_agents')
  assert.equal(run?.view.sprintEngineAutoState?.runtimeState, 'complete', 'completed run stays complete')
  assert.ok(!harness.powerActive.includes(STATE_PATH), 'a completed run never asserts power (no held sleep blocker)')

  harness.clock.now += STARTUP_SPAWN_DELAY_MS + 1
  await harness.runtime.tickNow()
  assert.equal(harness.projectionReads.length, 0, 'a completed run is not ticked')
  assert.equal(harness.spawnCalls.length, 0)

  harness.runtime.shutdown()
}

// (15) Dormancy re-applies the completion transition even when the one-shot
// teardown marker is already set (a stale-mirror adoption can leave the run
// 'running' with the marker set; without the transition it would tick and
// hold the power blocker forever).
async function testDormancyRecompletesWithMarkerSet(): Promise<void> {
  const harness = createHarness({ projection: completedProjection() })
  harness.runtime.registerRun(registration({
    runtimeState: 'running',
    completionTeardownAt: 123,
  }))
  await settle()
  assert.equal(
    harness.runtime.inspectRun(STATE_PATH)?.view.sprintEngineAutoState?.runtimeState,
    'running',
    'precondition: stale mirror adopted the run as running with the marker set',
  )

  harness.clock.now += STARTUP_SPAWN_DELAY_MS + 1
  await harness.runtime.tickNow()
  const run = harness.runtime.inspectRun(STATE_PATH)
  assert.equal(run?.view.sprintEngineAutoState?.runtimeState, 'complete', 'the completion transition still lands')
  const stopOp = harness.ops.find((op) => op.kind === 'stop_reason')
  assert.ok(stopOp && stopOp.kind === 'stop_reason' && stopOp.reason === 'all_tasks_done', 'completion mirrored to windows')
  assert.ok(
    !harness.ops.some((op) => op.kind === 'completion_teardown_at'),
    'the teardown side effects stay one-shot (marker already set)',
  )
  assert.ok(harness.powerInactive.includes(STATE_PATH), 'power released')

  harness.runtime.shutdown()
}

// (16) Unregistering an old run must not orphan a newer run that reused the
// same workspace (new team dir = new statePath, same workspaceId).
async function testUnregisterOldRunKeepsNewRunMapping(): Promise<void> {
  const NEW_STATE_PATH = '/repo/fixture/.multi-code/sprintengine/team-2/run.yaml'
  const harness = createHarness()
  harness.projections.set(NEW_STATE_PATH, bootstrapProjection())
  harness.modes.set(NEW_STATE_PATH, automationRecord('run_agents'))

  harness.runtime.registerRun(registration())
  await settle()
  harness.runtime.registerRun(registration({ statePath: NEW_STATE_PATH }))
  await settle()
  harness.runtime.unregisterRun(STATE_PATH)

  harness.clock.now += STARTUP_SPAWN_DELAY_MS + 1
  await harness.runtime.tickNow()
  assert.ok(harness.projectionReads.includes(NEW_STATE_PATH), 'the new run still resolves its workspace mapping')
  assert.equal(harness.spawnCalls.length, 1, 'the new run progresses to its bootstrap spawn')
  assert.equal(harness.spawnCalls[0]?.sprintEngineStatePath, NEW_STATE_PATH, 'the spawn belongs to the new run')

  harness.runtime.shutdown()
}

// (17) adoptAutomationRecord (the hydration seam): a fresh run registers
// before its sidecar exists; the service's hydration write must reach the
// scheduler or the run sits at 'manual' forever.
async function testHydrationAdoptionActivatesFreshRun(): Promise<void> {
  const harness = createHarness({ mode: null })
  harness.runtime.registerRun(registration({ runtimeState: 'running' }))
  await settle()
  assert.equal(
    harness.runtime.inspectRun(STATE_PATH)?.view.sprintEngineAutoState?.desiredMode,
    'manual',
    'precondition: no sidecar yet, the scheduler stays manual',
  )

  harness.runtime.adoptAutomationRecord(STATE_PATH, automationRecord('run_agents'))
  await settle()
  const run = harness.runtime.inspectRun(STATE_PATH)
  assert.equal(run?.view.sprintEngineAutoState?.desiredMode, 'run_agents', 'hydration adoption activates the run')
  assert.equal(run?.view.sprintEngineAutoState?.runtimeState, 'running')
  assert.ok(harness.powerActive.includes(STATE_PATH))

  harness.clock.now += STARTUP_SPAWN_DELAY_MS + 1
  await harness.runtime.tickNow()
  assert.equal(harness.spawnCalls.length, 1, 'the adopted run schedules')

  harness.runtime.shutdown()
}

// (18) Cycle diagnostics reach the windows: a failed spawn's user-facing
// diagnostic is broadcast (notification-store parity with the retired
// renderer supervisor), not just written to the JSONL.
async function testSpawnFailureDiagnosticBroadcast(): Promise<void> {
  const harness = createHarness({ spawnFails: true })
  harness.runtime.registerRun(registration())
  await settle()
  harness.clock.now += STARTUP_SPAWN_DELAY_MS + 1
  await harness.runtime.tickNow()

  assert.ok(harness.spawnCalls.length >= 1, 'precondition: a spawn was attempted')
  const diagnosticOp = harness.ops.find((op) => op.kind === 'diagnostic')
  assert.ok(diagnosticOp && diagnosticOp.kind === 'diagnostic', 'the diagnostic is broadcast to windows')
  assert.equal(diagnosticOp.statePath, STATE_PATH)
  assert.ok(diagnosticOp.entry.title.includes('was not started'), 'the entry carries the user-facing title')
  assert.ok(typeof diagnosticOp.entry.id === 'string' && diagnosticOp.entry.id.length > 0, 'the entry is notification-store ready')
  assert.ok(
    harness.diagnostics.some((input) => input.title === diagnosticOp.entry.title),
    'the JSONL write still happens',
  )

  harness.runtime.shutdown()
}

// (19) Tab maintenance reaches the windows: a successful auto-run spawn
// broadcasts the reveal policy (tab rename + config sessionId re-stamp).
async function testRevealPolicyBroadcastOnSpawn(): Promise<void> {
  const harness = createHarness()
  harness.runtime.registerRun(registration())
  await settle()
  harness.clock.now += STARTUP_SPAWN_DELAY_MS + 1
  await harness.runtime.tickNow()

  assert.equal(harness.spawnCalls.length, 1, 'precondition: the bootstrap spawn happened')
  const revealOp = harness.ops.find((op) => op.kind === 'reveal_policy')
  assert.ok(revealOp && revealOp.kind === 'reveal_policy', 'the reveal policy is broadcast to windows')
  assert.equal(revealOp.statePath, STATE_PATH)
  assert.equal(revealOp.agentId, 'architect-1')
  assert.equal(revealOp.revealPolicy, 'background', 'auto-run never steals focus')
  assert.equal(revealOp.sessionId, harness.spawnCalls[0]?.sessionId, 'windows re-stamp the tab onto the new session')

  harness.runtime.shutdown()
}

// (20) resumeIfBlocked: resolving a needs_input blocker resumes ONLY a
// `blocked` run — the transition broadcasts `automation_resumed` so every
// window clears its Blocked pill, and scheduling proceeds. A paused run (a
// user gesture) and an unknown statePath are strict no-ops.
async function testResumeIfBlockedResumesOnlyBlockedRuns(): Promise<void> {
  const harness = createHarness()
  harness.runtime.registerRun(registration({
    runtimeState: 'blocked',
    reason: 'blocked_on_input',
    reasonMessage: 'Waiting on T9.',
    reasonTaskId: 'T9',
  }))
  await settle()
  assert.equal(
    harness.runtime.inspectRun(STATE_PATH)?.view.sprintEngineAutoState?.runtimeState,
    'blocked',
    'precondition: adoption preserved the blocked lifecycle',
  )

  harness.runtime.resumeIfBlocked(STATE_PATH)
  const resumed = harness.runtime.inspectRun(STATE_PATH)
  assert.equal(resumed?.view.sprintEngineAutoState?.runtimeState, 'running', 'a blocked run re-enters running')
  assert.equal(resumed?.view.sprintEngineAutoState?.reason, undefined, 'the block reason is cleared')
  assert.ok(
    harness.ops.some((op) => op.kind === 'automation_resumed' && op.statePath === STATE_PATH),
    'the resume is broadcast so every window clears its Blocked pill',
  )
  assert.ok(harness.powerActive.includes(STATE_PATH), 'resume re-acquires the power assertion')

  await settle()
  harness.clock.now += STARTUP_SPAWN_DELAY_MS + 1
  await harness.runtime.tickNow()
  assert.equal(harness.spawnCalls.length, 1, 'the resumed run schedules again')

  // A paused run is a user gesture — resolving an input must not restart it.
  harness.runtime.applyStopReason({ statePath: STATE_PATH, reason: 'agent_terminal_closed' })
  const opsBefore = harness.ops.filter((op) => op.kind === 'automation_resumed').length
  harness.runtime.resumeIfBlocked(STATE_PATH)
  assert.equal(
    harness.runtime.inspectRun(STATE_PATH)?.view.sprintEngineAutoState?.runtimeState,
    'paused',
    'a paused run stays paused',
  )
  assert.equal(
    harness.ops.filter((op) => op.kind === 'automation_resumed').length,
    opsBefore,
    'no resume broadcast for a paused run',
  )

  // Unknown statePath: silent no-op, never a throw.
  harness.runtime.resumeIfBlocked('/nowhere/run.yaml')

  harness.runtime.shutdown()
}

// (21) A blocked run still reconciles sessions: the idle reaper disposes
// sprint PTYs regardless of automation state, and the stranded launch flags
// (cliStartRequested with no live session) must clear — and broadcast — so the
// roster does not show "Starting…" forever. The pass is session-only: no
// projection read, no spawn.
async function testBlockedRunStillReconcilesStaleLaunchFlags(): Promise<void> {
  const harness = createHarness()
  const reapedAgent: AgentState = {
    id: 'architect-1',
    name: 'Architect',
    status: 'idle',
    execution: { mode: 'current_workspace', worktreeId: null, cwd: null },
    messages: [],
    streamBuffer: '',
    kind: 'sprintengine',
    cli: 'claude',
    cliSessionId: 'dead-sess',
    cliStartRequested: true,
    cliHasLaunched: true,
  }
  harness.runtime.registerRun(registration({
    runtimeState: 'blocked',
    reason: 'blocked_on_input',
    agents: { 'architect-1': reapedAgent },
  }))
  await settle()
  assert.equal(
    harness.runtime.inspectRun(STATE_PATH)?.view.sprintEngineAutoState?.runtimeState,
    'blocked',
    'precondition: the run is blocked',
  )

  harness.clock.now += STARTUP_SPAWN_DELAY_MS + 1
  await harness.runtime.tickNow()

  const agent = harness.runtime.inspectRun(STATE_PATH)?.view.agents['architect-1']
  assert.equal(agent?.cliStartRequested, false, 'the stranded launch flag is cleared')
  assert.equal(agent?.cliHasLaunched, false, 'the launch marker is cleared')
  assert.equal(agent?.cliSessionId, undefined, 'the dead session id is dropped')
  const launchOp = harness.ops.find((op) => op.kind === 'launch_state' && op.agentId === 'architect-1')
  assert.ok(launchOp && launchOp.kind === 'launch_state', 'the clear is broadcast to windows')
  assert.equal(launchOp.update.cliStartRequested, false)
  assert.equal(harness.projectionReads.length, 0, 'the session-only pass never reads the projection')
  assert.equal(harness.spawnCalls.length, 0, 'a blocked run still never spawns')

  harness.runtime.shutdown()
}

// (MC-1885) A seat's reasoning-effort level rides `roleRuntimes` from the
// projection to the spawn payload, and from there into the CLI's real argv.
// The registration supplies NO agent record, so the level can only have come
// from the projection — the renderer never stores config on the engine
// (`sprintengine-roster-model-not-honored`).
async function testSeatEffortReachesSpawnedArgv(): Promise<void> {
  const harness = createHarness({ projection: seatEffortProjection('high') })
  harness.runtime.registerRun(registration())
  await settle()

  const run = harness.runtime.inspectRun(STATE_PATH)
  assert.equal(
    run?.view.agents['architect-1']?.cliReasoning,
    'high',
    'roster reconcile stamped the seat level from roleRuntimes alone',
  )

  harness.clock.now += STARTUP_SPAWN_DELAY_MS + 1
  await harness.runtime.tickNow()

  assert.equal(harness.spawnCalls.length, 1, 'the architect seat spawned once')
  const spawn = harness.spawnCalls[0]
  const metadata = spawn.metadata as Record<string, unknown>
  assert.equal(metadata.cliModel, 'claude-opus-5', 'the seat model rides the spawn payload')
  assert.equal(metadata.cliReasoning, 'high', 'the seat level rides the same spawn payload')

  // The payload is only a promise until the launch boundary renders it. Run the
  // real renderer over the spawned metadata and assert the flag on argv.
  await usingBundledRegistry(() => {
    const rendered = renderAgentLaunchArgv({
      cli: spawn.cli as 'claude-code',
      sessionId: spawn.sessionId,
      cliModel: metadata.cliModel as string,
      cliReasoning: metadata.cliReasoning as string,
    })
    assert.ok(
      rendered.argv.join(' ').includes('--effort high'),
      `spawned argv carries the seat's effort flag: ${rendered.argv.join(' ')}`,
    )
    // Resume never re-passes the level (no manifest spreads reasoningArgs on
    // resume), so a re-opened seat cannot double-apply it.
    const resumed = renderAgentLaunchArgv({
      cli: spawn.cli as 'claude-code',
      sessionId: spawn.sessionId,
      resume: true,
      cliModel: metadata.cliModel as string,
      cliReasoning: metadata.cliReasoning as string,
    })
    assert.ok(!resumed.argv.includes('--effort'), 'resume argv carries no effort flag')
  })

  harness.runtime.shutdown()
}

// (MC-1885) A seat with no configured level spawns exactly as it did before the
// level existed: no metadata field, and byte-identical argv.
async function testSeatWithoutEffortSpawnsUnchanged(): Promise<void> {
  const harness = createHarness({ projection: seatEffortProjection() })
  harness.runtime.registerRun(registration())
  await settle()
  harness.clock.now += STARTUP_SPAWN_DELAY_MS + 1
  await harness.runtime.tickNow()

  assert.equal(harness.spawnCalls.length, 1, 'the architect seat spawned once')
  const spawn = harness.spawnCalls[0]
  const metadata = spawn.metadata as Record<string, unknown>
  assert.equal(metadata.cliReasoning, undefined, 'no level configured means no level on the payload')

  await usingBundledRegistry(() => {
    const rendered = renderAgentLaunchArgv({
      cli: spawn.cli as 'claude-code',
      sessionId: spawn.sessionId,
      cliModel: metadata.cliModel as string,
      cliReasoning: metadata.cliReasoning as string | undefined,
    })
    const baseline = renderAgentLaunchArgv({
      cli: spawn.cli as 'claude-code',
      sessionId: spawn.sessionId,
      cliModel: metadata.cliModel as string,
    })
    assert.deepEqual(rendered.argv, baseline.argv, 'argv is byte-identical to a pre-effort launch')
  })

  harness.runtime.shutdown()
}

// (MC-1885) Retirement records the level it ran at alongside the model, so a
// re-opened seat reads back the runtime it actually used.
async function testRetirementRecordsSeatEffort(): Promise<void> {
  const harness = createHarness({ projection: twoAgentCompletedProjection() })
  const exitedAgent: AgentState = {
    id: 'dev-1',
    name: 'Dev',
    status: 'idle',
    execution: { mode: 'current_workspace', worktreeId: null, cwd: null },
    messages: [],
    streamBuffer: '',
    kind: 'sprintengine',
    cli: 'claude',
    cliSessionId: 'sess-a',
    cliModel: 'claude-opus-5',
    cliReasoning: 'xhigh',
  }
  harness.runtime.registerRun(registration({ agents: { 'dev-1': exitedAgent } }))
  await settle()
  harness.clock.now += STARTUP_SPAWN_DELAY_MS + 1
  await harness.runtime.tickNow()

  const recorded = harness.ops.find(
    (op) => op.kind === 'roster_session_recorded' && op.agentId === 'dev-1',
  )
  assert.ok(recorded && recorded.kind === 'roster_session_recorded')
  assert.equal(recorded.session.cliModel, 'claude-opus-5')
  assert.equal(recorded.session.cliReasoning, 'xhigh', 'the retired session records its effort level')

  harness.runtime.shutdown()
}

async function usingBundledRegistry(fn: () => Promise<void> | void): Promise<void> {
  __resetPluginRegistryForTest()
  const registry = createPluginRegistry({
    bundledRoot: join(process.cwd(), 'resources', 'plugins'),
    userRoot: join(process.cwd(), '.does-not-exist', 'multicode', 'plugins'),
  })
  const report = registry.loadSync()
  __setPluginRegistryForTest(registry, report)
  try {
    await fn()
  } finally {
    __resetPluginRegistryForTest()
  }
}

async function main(): Promise<void> {
  await testRegistrationActivatesRun()
  await testStartupDelayThenBootstrapSpawn()
  await testStopReasonPausesRun()
  await testAutomationChangedPauseAndResume()
  await testCompletionEntersDormancy()
  await testCancelRunEntersDormancy()
  await testCanceledProjectionEntersDormancyViaGate()
  await testUnregisterReleasesPower()
  await testReRegistrationKeepsMainOwnedResidue()
  await testApplyResumeReachesScheduler()
  await testResumeCapabilityStampingOnMainView()
  await testCompletionTeardownCoversSuspendedAndExitedAgents()
  await testAgentConfigMergeOnReRegistration()
  await testSidecarResidueAdoptionOnFirstRegistration()
  await testAdoptionPreservesPausedLifecycle()
  await testAdoptionPreservesCompletedLifecycle()
  await testDormancyRecompletesWithMarkerSet()
  await testUnregisterOldRunKeepsNewRunMapping()
  await testHydrationAdoptionActivatesFreshRun()
  await testSpawnFailureDiagnosticBroadcast()
  await testRevealPolicyBroadcastOnSpawn()
  await testResumeIfBlockedResumesOnlyBlockedRuns()
  await testBlockedRunStillReconcilesStaleLaunchFlags()
  await testSeatEffortReachesSpawnedArgv()
  await testSeatWithoutEffortSpawnsUnchanged()
  await testRetirementRecordsSeatEffort()
  console.log('sprint-runtime tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
