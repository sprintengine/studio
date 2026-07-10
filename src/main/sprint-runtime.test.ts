import assert from 'node:assert/strict'
import type {
  DiagnosticLogInput,
  TerminalSessionSnapshot,
  TerminalSpawnResult,
} from '../shared/electron-api'
import type { SprintEngineAutomationIntentRecord } from '../shared/sprintengine/automation-intent'
import type { SprintEngineAutomationMode } from '../shared/sprintengine/automation-types'
import type { TerminalSpawnArgs } from '../shared/sprintengine/auto-run-executor'
import type { SprintEngineLaunchSettings } from '../shared/sprintengine/launch-settings'
import type {
  SprintRuntimeOp,
  SprintRuntimeRunRegistration,
} from '../shared/sprintengine/runtime-bridge'
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
    pendingSpawns: [],
    deliveredAgentNotificationEventKeys: [],
    rosterSessions: {},
    agents: {},
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
  sprintEngineModelCatalog: [],
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
  liveSessions: TerminalSessionSnapshot[]
  /** Per-statePath projection payload + mode-intent record served to the runtime. */
  projections: Map<string, unknown>
  modes: Map<string, SprintEngineAutomationIntentRecord | null>
}

function createHarness(options: {
  projection?: unknown
  mode?: SprintEngineAutomationMode | null
  spawnFails?: boolean
} = {}): Harness {
  const clock = { now: 1_000_000 }
  const spawnCalls: TerminalSpawnArgs[] = []
  const killedSessionIds: string[] = []
  const ops: SprintRuntimeOp[] = []
  const powerActive: string[] = []
  const powerInactive: string[] = []
  const projectionReads: string[] = []
  const diagnostics: DiagnosticLogInput[] = []
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
      readProjection: async ({ statePath, knownToken }) => {
        projectionReads.push(statePath)
        if (knownToken === 'token-1') return { ok: true, data: null, token: 'token-1', unchanged: true }
        return { ok: true, data: projections.get(statePath) ?? null, token: 'token-1' }
      },
      autoApproveArtifact: async () => ({ ok: true as const, data: {} }),
      replenishRoster: async () => ({ ok: true as const, data: {} }),
    },
    pathExists: async () => true,
    resolveMemoryRoot: async (_workspaceRoot, relativeRoot) => ({
      ok: false,
      status: 'inaccessible',
      relativeRoot,
      message: 'not used by the fixture',
    }),
    getPluginCatalogEntries: () => [],
    getLaunchSettings: () => LAUNCH_SETTINGS,
    readAutomationMode: async (statePath) => modes.get(statePath) ?? null,
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
  // Stale renderer-persisted residue rides the first registration; the cycle
  // clears it (its task is gone) and broadcasts the new pendingSpawns.
  harness.runtime.registerRun(registration({
    pendingSpawns: [{ taskId: 'T-stale', agentId: 'ghost-1', startedAt: 0 }],
  }))
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
  assert.ok(kinds.has('pending_spawns'), 'pending_spawns broadcast emitted (stale residue cleared)')
  assert.ok(kinds.has('launch_state'), 'launch_state broadcast emitted')
  const assignOp = harness.ops.find((op) => op.kind === 'assign_session')
  assert.ok(assignOp && assignOp.kind === 'assign_session', 'assign_session broadcast emitted')
  assert.equal(assignOp.agentId, 'architect-1')
  assert.equal(assignOp.sessionId, spawn.sessionId)
  assert.equal(assignOp.cli, 'claude')
  const pendingOp = harness.ops.find((op) => op.kind === 'pending_spawns')
  assert.ok(pendingOp && pendingOp.kind === 'pending_spawns')
  assert.deepEqual(pendingOp.pendingSpawns, [], 'stale pending spawn was cleared')
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

async function main(): Promise<void> {
  await testRegistrationActivatesRun()
  await testStartupDelayThenBootstrapSpawn()
  await testStopReasonPausesRun()
  await testAutomationChangedPauseAndResume()
  await testCompletionEntersDormancy()
  await testUnregisterReleasesPower()
  await testReRegistrationKeepsMainOwnedResidue()
  console.log('sprint-runtime tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
