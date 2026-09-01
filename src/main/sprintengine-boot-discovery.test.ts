import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  DiagnosticLogInput,
  TerminalSessionSnapshot,
  TerminalSpawnResult,
} from '../shared/electron-api'
import { parseSprintEngineAutomationIntentRecord } from '../shared/sprintengine/automation-intent'
import { SPRINT_ENGINE_RUN_SCHEMA_VERSION } from '../shared/sprintengine/store-schema'
import type { TerminalSpawnArgs } from '../shared/sprintengine/auto-run-executor'
import type { SprintEngineLaunchSettings } from '../shared/sprintengine/launch-settings'
import type { SprintRuntimeRunRegistration } from '../shared/sprintengine/runtime-bridge'
import { createSprintRuntime, type SprintRuntimeDeps } from './sprint-runtime'
import { discoverSprintRunsAtBoot, sprintAutoRunDisabledByEnv } from './sprintengine-boot-discovery'
import { listKnownWorkspaceRoots, uniqueResolvedRoots } from './workspace-roots'

// The scan, the sidecar reads and the projection reads all run against a REAL
// temp project tree: this item's whole claim is that main finds runs on disk
// with no window, so faking the disk would fake the feature. Only the terminal
// runtime, the clock and the timers are substituted.

void main()

const LAUNCH_SETTINGS: SprintEngineLaunchSettings = {
  cliRuntimes: { claude: { command: 'claude', useWsl: false } },
  mcp: { syncEnabled: false, servers: {} },
  projectKnowledgeRoots: {},
  lastSelectedCli: null,
  lastAgentSpawnPermissionPreset: null,
  sprintEngineRoleSettings: { enabled: {} },
}

const STARTUP_SPAWN_DELAY_MS = 10_000

async function main(): Promise<void> {
  await assertAutoRunningRunResumesWithNoWindow()
  await assertManualAndTerminalRunsAreNotRegistered()
  await assertRendererRegistrationReconcilesInsteadOfResetting()
  await assertScanIsRootsScopedAndKillSwitchHonoured()
  await assertOneUnreadableRunDoesNotStopTheRest()
  assertKnownWorkspaceRootsAreResolvedAndDeduped()
  console.log('sprintengine-boot-discovery tests passed')
}

// (1) A run whose sidecar says non-manual is registered at boot and the
// scheduler ticks it into a spawn — no window, no renderer registration.
async function assertAutoRunningRunResumesWithNoWindow(): Promise<void> {
  const project = createProject('resumes')
  try {
    const run = writeRun(project, 'team-a', { desiredMode: 'run_agents', projection: bootstrapProjection() })
    const harness = createHarness([project])

    const report = await discoverSprintRunsAtBoot(harness.deps)
    await settle()

    assert.deepEqual(report.registered, [run.statePath], 'the auto-running run was registered')
    assert.equal(report.discovered, 1)
    const registered = harness.runtime.inspectRun(run.statePath)
    assert.ok(registered, 'the scheduler holds the run')
    assert.equal(registered.view.folderPath, project, 'folderPath is the run’s project root')
    assert.equal(registered.view.name, 'Fixture Run', 'name comes from the projection, not the team slug')
    assert.equal(registered.view.sprintEngineAutoState?.desiredMode, 'run_agents', 'sidecar intent adopted')
    assert.equal(registered.view.sprintEngineAutoState?.runtimeState, 'running')
    assert.equal(
      registered.view.sprintEngineAutoState?.cliPermissionPreset,
      'bypass',
      'the sidecar’s permission preset reached the registration',
    )
    assert.deepEqual(
      registered.view.sprintEngineAutoState?.deliveredAgentNotificationEventKeys,
      ['delivered-1'],
      'the sidecar’s runtime residue was adopted, not reset',
    )
    assert.ok(harness.powerActive.includes(run.statePath), 'the run holds the power assertion')

    harness.clock.now += STARTUP_SPAWN_DELAY_MS + 1
    await harness.runtime.tickNow()

    assert.equal(harness.spawnCalls.length, 1, 'the scheduler spawned the bootstrap architect with no window open')
    assert.equal(harness.spawnCalls[0].sprintEngineStatePath, run.statePath)
    assert.equal(harness.spawnCalls[0].cwd, project, 'the spawn runs in the discovered project root')

    harness.runtime.shutdown()
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
}

// (2) Manual mode and a completed run are both discovered and both left alone.
async function assertManualAndTerminalRunsAreNotRegistered(): Promise<void> {
  const project = createProject('skips')
  try {
    const manual = writeRun(project, 'team-manual', { desiredMode: 'manual', projection: bootstrapProjection() })
    const completed = writeRun(project, 'team-done', { desiredMode: 'run_agents', projection: completedProjection() })
    const noIntent = writeRun(project, 'team-fresh', { desiredMode: null, projection: bootstrapProjection() })
    const tooOld = writeRun(project, 'team-legacy', { desiredMode: 'run_agents', projection: bootstrapProjection(1) })
    const harness = createHarness([project])

    const report = await discoverSprintRunsAtBoot(harness.deps)
    await settle()

    assert.equal(report.discovered, 4, 'every run under the root was discovered')
    assert.deepEqual(report.registered, [], 'none of them is scheduled')
    assert.deepEqual(
      new Map(report.skipped.map((skip) => [skip.statePath, skip.reason])),
      new Map([
        [manual.statePath, 'manual'],
        [completed.statePath, 'terminal'],
        [noIntent.statePath, 'no_intent'],
        [tooOld.statePath, 'unsupported_store'],
      ]),
    )
    assert.equal(harness.runtime.inspectRun(manual.statePath), null)
    assert.equal(harness.runtime.inspectRun(completed.statePath), null)
    assert.equal(harness.powerActive.length, 0, 'no run was activated')

    harness.runtime.shutdown()
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
}

// (3) A window opening later re-registers the same run: it takes over identity
// without duplicating the entry or resetting what main has been doing.
async function assertRendererRegistrationReconcilesInsteadOfResetting(): Promise<void> {
  const project = createProject('reconcile')
  try {
    const run = writeRun(project, 'team-a', { desiredMode: 'run_agents', projection: bootstrapProjection() })
    const harness = createHarness([project])

    await discoverSprintRunsAtBoot(harness.deps)
    await settle()
    harness.clock.now += STARTUP_SPAWN_DELAY_MS + 1
    await harness.runtime.tickNow()
    const spawnsBeforeWindow = harness.spawnCalls.length
    assert.equal(spawnsBeforeWindow, 1, 'precondition: the headless scheduler already spawned')

    // The renderer's registration mirrors a lagging store: `idle` lifecycle, no
    // delivered keys, its own workspace id and its own run settings.
    harness.runtime.registerRun(rendererRegistration(run.statePath, project))
    await settle()

    const registered = harness.runtime.inspectRun(run.statePath)
    assert.ok(registered, 'still exactly one entry for the run')
    assert.equal(registered.view.id, 'ws-real', 'the renderer’s workspace id takes over')
    assert.equal(registered.view.name, 'Sprint Workspace', 'renderer identity is adopted')
    assert.equal(registered.view.sprintEngineAutoState?.runtimeState, 'running', 'main’s lifecycle is not reset')
    assert.deepEqual(
      registered.view.sprintEngineAutoState?.deliveredAgentNotificationEventKeys,
      ['delivered-1'],
      'main’s delivered-notification bookkeeping survives the window',
    )
    assert.equal(
      registered.view.sprintEngineAutoState?.maxConcurrentAgents,
      5,
      'renderer-owned run configuration is applied',
    )

    assert.deepEqual(
      harness.adoptCalls.at(-1),
      { statePath: run.statePath, workspaceId: 'ws-real' },
      'the sessions the placeholder id minted were re-homed onto the window’s workspace',
    )
    assert.equal(
      harness.liveSessions[0]?.workspaceId,
      'ws-real',
      'the headless agent terminal is now findable by the board’s workspace-keyed lookup',
    )

    await harness.runtime.tickNow()
    assert.equal(harness.spawnCalls.length, spawnsBeforeWindow, 'the window did not restart the run’s work')

    harness.runtime.shutdown()
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
}

// (4) Discovery scans the roots it is given and nothing else, and the auto-run
// kill switch stops it entirely.
async function assertScanIsRootsScopedAndKillSwitchHonoured(): Promise<void> {
  const scanned = createProject('scanned')
  const unscanned = createProject('unscanned')
  try {
    const inScope = writeRun(scanned, 'team-a', { desiredMode: 'run_agents', projection: bootstrapProjection() })
    writeRun(unscanned, 'team-b', { desiredMode: 'run_agents', projection: bootstrapProjection() })

    const harness = createHarness([scanned])
    const report = await discoverSprintRunsAtBoot(harness.deps)
    await settle()
    assert.equal(report.discovered, 1, 'only the given root is scanned')
    assert.deepEqual(report.registered, [inScope.statePath])
    harness.runtime.shutdown()

    const safeMode = createHarness([scanned, unscanned], { MULTICODE_SAFE_MODE: '1' })
    const safeReport = await discoverSprintRunsAtBoot(safeMode.deps)
    await settle()
    assert.equal(safeReport.disabled, true, 'safe mode disables boot discovery')
    assert.deepEqual(safeReport.registered, [])
    assert.equal(safeReport.discovered, 0, 'the kill switch stops the scan before any disk work')
    safeMode.runtime.shutdown()

    assert.equal(sprintAutoRunDisabledByEnv({ VITE_MULTICODE_DISABLE_SPRINTENGINE_AUTORUN: '1' }), true)
    assert.equal(sprintAutoRunDisabledByEnv({}), false)
  } finally {
    rmSync(scanned, { recursive: true, force: true })
    rmSync(unscanned, { recursive: true, force: true })
  }
}

// (5) A run whose sidecar read blows up costs itself its resume, nothing else.
async function assertOneUnreadableRunDoesNotStopTheRest(): Promise<void> {
  const project = createProject('unreadable')
  try {
    const broken = writeRun(project, 'team-broken', { desiredMode: 'run_agents', projection: bootstrapProjection() })
    const healthy = writeRun(project, 'team-ok', { desiredMode: 'run_agents', projection: bootstrapProjection() })
    const harness = createHarness([project])
    const readAutomationMode = harness.deps.readAutomationMode

    const report = await discoverSprintRunsAtBoot({
      ...harness.deps,
      readAutomationMode: async (statePath) => {
        if (statePath === broken.statePath) throw new Error('sidecar read failed')
        return readAutomationMode(statePath)
      },
    })
    await settle()

    assert.deepEqual(report.registered, [healthy.statePath], 'the healthy run still resumed')
    assert.deepEqual(report.skipped, [{ statePath: broken.statePath, reason: 'unreadable' }])

    harness.runtime.shutdown()
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
}

// (6) The roots both boot discovery and the mobile relay scan: resolved, deduped,
// and never an empty entry (which would scan the process cwd).
function assertKnownWorkspaceRootsAreResolvedAndDeduped(): void {
  const roots = listKnownWorkspaceRoots({
    sequence: 1,
    state: {
      activeWorkspaceId: null,
      primaryWorkspaceWindowId: 'primary',
      workspaceWindows: [],
      workspaces: [
        { folderPath: '/repo/one' },
        { folderPath: '/repo/one/../one' },
        { folderPath: '   ' },
        { folderPath: null },
        { folderPath: '/repo/two' },
      ],
    },
  } as unknown as Parameters<typeof listKnownWorkspaceRoots>[0])

  assert.deepEqual(roots, ['/repo/one', '/repo/two'])
  assert.deepEqual(uniqueResolvedRoots(['/repo/two', '/repo/two', undefined]), ['/repo/two'])
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function createProject(label: string): string {
  return mkdtempSync(join(tmpdir(), `multicode-boot-discovery-${label}-`))
}

/** A run on disk: `run.yaml`, `projection.json`, and optionally `automation.json`. */
function writeRun(
  projectRoot: string,
  teamSlug: string,
  options: { desiredMode: 'run_agents' | 'manual' | null; projection: unknown },
): { statePath: string } {
  const teamDirectory = join(projectRoot, '.multi-code', 'sprintengine', teamSlug)
  mkdirSync(teamDirectory, { recursive: true })
  const statePath = join(teamDirectory, 'run.yaml')
  writeFileSync(statePath, 'name: fixture\n', 'utf8')
  writeFileSync(join(teamDirectory, 'projection.json'), JSON.stringify(options.projection), 'utf8')
  if (options.desiredMode) {
    writeFileSync(
      join(teamDirectory, 'automation.json'),
      JSON.stringify({
        schemaVersion: 1,
        revision: 2,
        desiredMode: options.desiredMode,
        cliPermissionPreset: 'bypass',
        changedAt: 0,
        lastWrite: { actor: 'ui', deviceId: null, at: new Date(0).toISOString() },
        runtime: { deliveredAgentNotificationEventKeys: ['delivered-1'], rosterSessions: {} },
      }),
      'utf8',
    )
  }
  return { statePath }
}

/** Roster + roleRuntimes and no tasks: the cycle answers with a bootstrap architect spawn. */
function bootstrapProjection(schemaVersion = SPRINT_ENGINE_RUN_SCHEMA_VERSION): unknown {
  return {
    run: {
      name: 'Fixture Run',
      goal: 'Ship the fixture',
      schemaVersion,
      rosterConfigured: true,
      roleRuntimes: { architect: { cli: 'claude' } },
    },
    roster: { 'architect-1': { role: 'architect', status: 'idle', currentTaskId: null } },
    tasks: [],
    artifacts: [],
    activity: [],
  }
}

/** Every task done — the run summary reads `completed`. */
function completedProjection(): unknown {
  return {
    run: {
      name: 'Finished Run',
      goal: 'Ship the fixture',
      schemaVersion: SPRINT_ENGINE_RUN_SCHEMA_VERSION,
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

function rendererRegistration(statePath: string, folderPath: string): SprintRuntimeRunRegistration {
  return {
    statePath,
    workspaceId: 'ws-real',
    workspaceName: 'Sprint Workspace',
    folderPath,
    memoryRelativeRoot: 'knowledge',
    cliPermissionPreset: 'manual',
    maxConcurrentAgents: 5,
    deliveredAgentNotificationEventKeys: [],
    runtimeState: 'idle',
    rosterSessions: {},
    agents: {},
    agentConfigs: {},
  }
}

type Harness = {
  runtime: ReturnType<typeof createSprintRuntime>
  deps: Parameters<typeof discoverSprintRunsAtBoot>[0]
  clock: { now: number }
  spawnCalls: TerminalSpawnArgs[]
  powerActive: string[]
  diagnostics: DiagnosticLogInput[]
  adoptCalls: Array<{ statePath: string; workspaceId: string }>
  liveSessions: TerminalSessionSnapshot[]
}

function createHarness(roots: string[], env: NodeJS.ProcessEnv = {}): Harness {
  const clock = { now: 1_000_000 }
  const spawnCalls: TerminalSpawnArgs[] = []
  const powerActive: string[] = []
  const diagnostics: DiagnosticLogInput[] = []
  const adoptCalls: Array<{ statePath: string; workspaceId: string }> = []
  const liveSessions: TerminalSessionSnapshot[] = []

  const readAutomationMode = async (statePath: string) => {
    const raw = await readFile(join(dirname(statePath), 'automation.json'), 'utf8').catch(() => null)
    if (raw === null) return null
    return parseSprintEngineAutomationIntentRecord(JSON.parse(raw))
  }

  const runtimeDeps: SprintRuntimeDeps = {
    terminal: {
      list: () => [...liveSessions],
      write: () => undefined,
      kill: () => undefined,
      status: async () => ({ processAlive: false }),
      spawn: async (args) => {
        spawnCalls.push(args)
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
      // Mirrors `adoptSprintRunSessionWorkspaceId` in terminal-runtime.ts.
      adoptWorkspaceId: ({ statePath, workspaceId }) => {
        adoptCalls.push({ statePath, workspaceId })
        liveSessions.forEach((session, index) => {
          if (session.sprintEngineStatePath !== statePath) return
          liveSessions[index] = { ...session, workspaceId }
        })
      },
    },
    artifacts: {
      ensureTaskWorktree: async () => ({ ok: true, isolated: false, worktreePath: null }),
      // Straight off disk, like the real handler's projection read.
      readProjection: async ({ statePath }) => {
        const raw = await readFile(join(dirname(statePath), 'projection.json'), 'utf8')
        return { ok: true, data: JSON.parse(raw), token: `${clock.now}` }
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
    getPluginCatalogEntries: () => [],
    getLaunchSettings: () => LAUNCH_SETTINGS,
    readAutomationMode,
    persistRuntimeResidue: () => undefined,
    powerManager: {
      markRunActive: (statePath) => powerActive.push(statePath),
      markRunInactive: () => undefined,
      shutdown: () => undefined,
    },
    broadcastOp: () => undefined,
    logDiagnostic: (input) => {
      diagnostics.push(input)
    },
    now: () => clock.now,
    // Inert: every tick is driven explicitly through tickNow().
    timers: { setInterval: () => ({}), clearInterval: () => undefined },
  }

  const runtime = createSprintRuntime(runtimeDeps)
  return {
    runtime,
    clock,
    spawnCalls,
    powerActive,
    diagnostics,
    adoptCalls,
    liveSessions,
    deps: {
      listWorkspaceRoots: () => roots,
      readAutomationMode,
      isRunRegistered: (statePath) => runtime.inspectRun(statePath) !== null,
      registerRun: (registration) => runtime.registerRun(registration),
      env,
    },
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}
