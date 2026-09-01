/**
 * Supervise-cycle tests (MC-1592), exercised end-to-end through
 * `superviseWorkspace`:
 *
 * 1. Fail-soft: a stage that throws must log a diagnostic and be skipped
 *    without aborting the tick — later stages, crucially spawning, still run
 *    from the same snapshot (the recovery-and-dispatch stage throws via a
 *    failing terminal write, and a ready task must still spawn the same tick).
 * 2. Planner preference: triage acting (a triage paste into the planner's
 *    terminal) must NOT suppress pool spawning the same tick — triage is a
 *    scheduling preference, not an early-returning pipeline stage.
 *
 * Runner: esbuild bundle -> node, `node:assert/strict`.
 */
import assert from 'node:assert/strict'
import type { AgentCli, CliRuntimeSettings, McpSettings, TerminalSessionSnapshot } from '../electron-api'
import type { AgentState } from './agent-state'
import type { SprintEngineState, SprintEngineWorkspaceView } from './run-types'
import type { SprintEngineAutoState } from './automation-types'
import type { ArchitectTriageMessage, SprintEngineAutoRunCyclePorts } from './auto-run-cycle'
import type { AutoRunCandidate, SprintEngineDispatchAttempt } from './auto-run'
import { createSprintEngineAutoRunCycleState, spawnAutoRunCandidate, superviseWorkspace } from './auto-run-cycle'

type Captured = {
  spawns: Array<{ sessionId: string; agentId?: string; initialPrompt?: string; cwd?: string }>
  diagnostics: Array<{ title?: string; details?: string }>
  taskWorktreeRequests?: string[]
  writes: Array<{ sessionId: string; data: string }>
}

const STATE_PATH = '/tmp/workspace/.multi-code/sprintengine/team/run.yaml'

function agentSession(agentId: string, role?: string): TerminalSessionSnapshot {
  return {
    sessionId: `session-${agentId}`,
    kind: 'agent',
    processAlive: true,
    workspaceId: 'workspace-1',
    agentId,
    sprintEngineStatePath: STATE_PATH,
    cli: 'claude-code',
    startedAt: 1,
    // Real spawns stamp the session with its sprint role/work; the picker's
    // booting-supply match reads it (`session.agentSession?.role`).
    ...(role ? { agentSession: { role, workId: null } } : {}),
  } as unknown as TerminalSessionSnapshot
}

function viewAgent(id: string): AgentState {
  return {
    id,
    name: id,
    status: 'idle',
    execution: { mode: 'current_workspace', worktreeId: null, cwd: null },
    messages: [],
    streamBuffer: '',
    kind: 'sprintengine',
    cli: 'claude-code',
    cliStartRequested: true,
    cliHasLaunched: true,
    cliSessionId: 'session-developer-1',
  } as unknown as AgentState
}

function makePorts(
  captured: Captured,
  workspace: SprintEngineWorkspaceView,
  sessions: TerminalSessionSnapshot[],
  options: {
    terminalWriteFails?: boolean
    taskWorktreeResult?: { ok: boolean; isolated: boolean; worktreePath: string | null; message?: string }
  } = {},
): SprintEngineAutoRunCyclePorts {
  return {
    terminalList: async () => sessions,
    // With terminalWriteFails, the dispatch paste throws (a non-IPC error, so
    // it is swallowed fail-soft, not re-thrown like a TerminalListIpcError).
    terminalWrite: async (sessionId: string, data: string) => {
      if (options.terminalWriteFails) throw new Error('terminal write failed')
      captured.writes.push({ sessionId, data })
    },
    terminalKill: async () => {},
    terminalStatus: async () => ({ processAlive: false }),
    terminalSpawn: async (args) => {
      captured.spawns.push({
        sessionId: args.sessionId,
        agentId: (args.metadata as { agentId?: string })?.agentId,
        initialPrompt: args.initialPrompt,
        cwd: args.cwd,
      })
      return { ok: true, sessionId: args.sessionId }
    },
    pathExists: async () => true,
    readSprintEngineProjection: async () => ({ ok: true, unchanged: true } as never),
    autoApproveSprintEngineArtifact: async () => ({ ok: true } as never),
    memoryResolveRoot: async () => ({ ok: false, status: 'disabled', relativeRoot: null } as never),
    ensureSprintEngineTaskWorktree: async (input: { taskId: string }) => {
      captured.taskWorktreeRequests?.push(input.taskId)
      return options.taskWorktreeResult ?? { ok: true, isolated: false, worktreePath: null }
    },
    publishDiagnostic: async (input) => { captured.diagnostics.push({ title: input.title, details: input.details }) },
    applyTerminalRevealPolicy: () => {},
    isAgentTabVisible: () => false,
    getPluginCatalogEntries: () => [],
    getSpawnSettings: () => ({ projectKnowledgeRoots: null }),
    getWorkspace: () => workspace,
    setSprintEngineState: () => {},
    setSprintEngineAutomationMode: () => {},
    setFolderMissing: () => {},
    updateAgent: () => {},
    markSprintEngineAgentNotificationDelivered: () => {},
    applyAutomationStopReason: () => {},
    dispatchAssignTerminalSession: () => {},
    dispatchUpdateTerminalLaunchState: () => {},
    refreshWorkspaceProjection: async () => ({ status: 'unchanged', state: workspace.sprintEngineState ?? null }),
    enterDormancy: () => {},
    tearDownDepartedTaskScopedWorker: async () => ({ recorded: false, removedAgent: false, removedTab: false, closedSessionId: null }),
    randomUUID: () => `uuid-${captured.spawns.length}`,
  } as unknown as SprintEngineAutoRunCyclePorts
}

function autoState(): SprintEngineAutoState {
  return {
    desiredMode: 'run_agents',
    runtimeState: 'running',
    cliPermissionPreset: 'manual',
    maxConcurrentAgents: 3,
    deliveredAgentNotificationEventKeys: [],
  }
}

function superviseArgs(
  ports: SprintEngineAutoRunCyclePorts,
  workspace: SprintEngineWorkspaceView,
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>,
): Parameters<typeof superviseWorkspace> {
  return [
    ports,
    createSprintEngineAutoRunCycleState(),
    workspace,
    cliRuntimes,
    {} as McpSettings,
    ref(new Set<string>()),
    ref(new Map<string, number>()),
    ref(new Map<string, number>()),
    ref(new Map<string, SprintEngineDispatchAttempt>()),
    ref(new Map<string, SprintEngineDispatchAttempt>()),
    ref(new Map<string, ArchitectTriageMessage>()),
    ref(new Set<string>()),
    ref(new Map<string, string>()),
    ref(new Map<string, number>()),
    ref(new Map<string, number>()),
  ]
}

function ref<T>(value: T): { current: T } {
  return { current: value }
}

async function testAThrowingStageDoesNotPreventSpawning(): Promise<void> {
  // developer-1 is a live agent working in-progress task T-b, with a pending
  // notification to deliver to its terminal — so the recovery-and-dispatch stage
  // pastes to it and throws. T-open is ready, unowned developer work that the
  // reconciler must still spawn a fresh worker for this same tick. developer-1
  // owns an active task, so it is occupied (not idle continuation capacity),
  // which is why the ready task is dispatched fresh rather than reserved.
  const task = (over: Record<string, unknown>) => ({
    id: 'T', title: '', description: '', role: 'developer', status: 'todo', ownerAgentId: null,
    dependsOn: [], ownedPaths: [], acceptanceCriteria: [], implementationNotes: [],
    evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] }, notes: [], comments: [],
    startedAt: null, completedAt: null, boardColumn: 'ready', ...over,
  })
  const state = {
    name: 'team',
    goal: '',
    roleCounts: {},
    roleRuntimes: { developer: { cli: 'claude-code' } },
    sprintEngineAgents: {
      'developer-1': { role: 'developer', status: 'running', currentTaskId: 'T-b' },
    },
    events: [
      { type: 'agent_notification_requested', id: 'E1', targetAgentId: 'developer-1', taskId: 'T-b', notificationKind: 'task_resume_requested' },
    ],
    artifacts: [],
    tasks: [
      task({ id: 'T-b', title: 'In-progress work', status: 'in_progress', ownerAgentId: 'developer-1', boardColumn: 'in_progress' }),
      task({ id: 'T-open', title: 'Ready developer work' }),
    ],
  } as unknown as SprintEngineState

  const workspace = {
    id: 'workspace-1',
    name: 'Fail-soft workspace',
    folderPath: '/tmp/workspace',
    agents: { 'developer-1': viewAgent('developer-1') },
    sprintEngineState: state,
    sprintEngineAutoState: autoState(),
    sprintEngineContext: { teamSlug: 'team', statePath: STATE_PATH },
    memory: { relativeRoot: '' },
  } as unknown as SprintEngineWorkspaceView

  const captured: Captured = { spawns: [], diagnostics: [], writes: [] }
  const ports = makePorts(captured, workspace, [agentSession('developer-1')], { terminalWriteFails: true })
  const cliRuntimes = { 'claude-code': { command: 'claude', useWsl: false } } as unknown as Record<AgentCli, CliRuntimeSettings>

  await superviseWorkspace(...superviseArgs(ports, workspace, cliRuntimes))

  assert.equal(captured.spawns.length, 1, `the ready task still spawns despite the thrown stage; spawns=${JSON.stringify(captured.spawns)}`)
  assert.equal(captured.spawns[0].agentId, 'developer-2', 'a fresh worker is minted for the ready task')
  assert.ok(
    captured.diagnostics.some((d) => d.title === 'Sprint supervisor stage skipped'),
    `the thrown stage logs a "stage skipped" diagnostic; diagnostics=${JSON.stringify(captured.diagnostics.map((d) => d.title))}`,
  )
}

async function testTriageActingDoesNotSuppressPoolSpawning(): Promise<void> {
  // The planner has a live session and an architect-actionable needs_input
  // task exists, so the planner-preference path pastes the triage prompt into
  // the architect terminal ("triage acted"). Under the retired stage ordering
  // that early-returned the whole tick; the reconciler must still spawn the
  // ready unowned developer task the same tick.
  const task = (over: Record<string, unknown>) => ({
    id: 'T', title: '', description: '', role: 'developer', status: 'todo', ownerAgentId: null,
    dependsOn: [], ownedPaths: [], acceptanceCriteria: [], implementationNotes: [],
    evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] }, notes: [], comments: [],
    startedAt: null, completedAt: null, boardColumn: 'ready', ...over,
  })
  const state = {
    name: 'team',
    goal: '',
    roleCounts: { architect: 1 },
    roleRuntimes: { developer: { cli: 'claude-code' }, architect: { cli: 'claude-code' } },
    sprintEngineAgents: {
      architect: { role: 'architect', status: 'running', currentTaskId: null },
    },
    events: [],
    artifacts: [],
    tasks: [
      task({
        id: 'T-blocked', title: 'Needs planner input', status: 'needs_input', boardColumn: 'needs_input',
        needsInput: { kind: 'architect', reason: 'plan ambiguity' },
      }),
      task({ id: 'T-open', title: 'Ready developer work' }),
    ],
  } as unknown as SprintEngineState

  const architectAgent = {
    ...viewAgent('architect'),
    cliSessionId: 'session-architect',
  } as AgentState
  const workspace = {
    id: 'workspace-1',
    name: 'Planner-preference workspace',
    folderPath: '/tmp/workspace',
    agents: { architect: architectAgent },
    sprintEngineState: state,
    sprintEngineAutoState: autoState(),
    sprintEngineContext: { teamSlug: 'team', statePath: STATE_PATH },
    memory: { relativeRoot: '' },
  } as unknown as SprintEngineWorkspaceView

  const captured: Captured = { spawns: [], diagnostics: [], writes: [] }
  const ports = makePorts(captured, workspace, [agentSession('architect')])
  const cliRuntimes = { 'claude-code': { command: 'claude', useWsl: false } } as unknown as Record<AgentCli, CliRuntimeSettings>

  await superviseWorkspace(...superviseArgs(ports, workspace, cliRuntimes))

  assert.ok(
    captured.writes.some((write) => write.sessionId === 'session-architect' && write.data.includes('triage')),
    `triage acted: the planner terminal received the triage prompt; writes=${JSON.stringify(captured.writes.map((w) => w.sessionId))}`,
  )
  assert.equal(captured.spawns.length, 1, `pool spawning still ran the same tick; spawns=${JSON.stringify(captured.spawns)}`)
  assert.equal(captured.spawns[0].agentId, 'developer-1', 'the ready developer task got a fresh pool worker')
}

async function testMissingCliRoleDoesNotFreezeSiblings(): Promise<void> {
  // Two ready reviewer tasks, siblings with no dependency between them.
  // `nuclear_reviewer` is absent from `roleRuntimes` (the 2026-07-19 gap: a
  // registry role that never got a CLI), so its runtime resolves no CLI;
  // `spec_reviewer` has one. The CLI-less role must be SKIPPED without aborting
  // the tick, so the sibling spec_reviewer still spawns the same tick, and its
  // "missing CLI selection" diagnostic surfaces ONCE across repeated ticks (the
  // old code returned 'failed', froze the sibling, and re-published every ~4s).
  const task = (over: Record<string, unknown>) => ({
    id: 'T', title: '', description: '', role: 'developer', status: 'todo', ownerAgentId: null,
    dependsOn: [], ownedPaths: [], acceptanceCriteria: [], implementationNotes: [],
    evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] }, notes: [], comments: [],
    startedAt: null, completedAt: null, boardColumn: 'ready', ...over,
  })
  const state = {
    name: 'team',
    goal: '',
    roleCounts: {},
    // nuclear_reviewer intentionally absent -> resolveSprintEngineAgentRuntime
    // returns no CLI for it; spec_reviewer resolves claude-code.
    roleRuntimes: { spec_reviewer: { cli: 'claude-code' } },
    sprintEngineAgents: {},
    events: [],
    artifacts: [],
    tasks: [
      task({ id: 'T-nuclear', title: 'CLI-less review', role: 'nuclear_reviewer' }),
      task({ id: 'T-spec', title: 'Sibling review', role: 'spec_reviewer' }),
    ],
  } as unknown as SprintEngineState

  const workspace = {
    id: 'workspace-1',
    name: 'Missing-CLI workspace',
    folderPath: '/tmp/workspace',
    agents: {},
    sprintEngineState: state,
    sprintEngineAutoState: autoState(),
    sprintEngineContext: { teamSlug: 'team', statePath: STATE_PATH },
    memory: { relativeRoot: '' },
  } as unknown as SprintEngineWorkspaceView

  const captured: Captured = { spawns: [], diagnostics: [], writes: [] }
  const ports = makePorts(captured, workspace, [])
  const cliRuntimes = { 'claude-code': { command: 'claude', useWsl: false } } as unknown as Record<AgentCli, CliRuntimeSettings>

  // Reuse ONE args tuple across two ticks so the shared cycle state (index 1)
  // carries the missing-CLI notice set between ticks — exercising the dedup.
  const args = superviseArgs(ports, workspace, cliRuntimes)
  await superviseWorkspace(...args)
  await superviseWorkspace(...args)

  assert.ok(
    captured.spawns.some((s) => (s.agentId ?? '').startsWith('spec_reviewer')),
    `the CLI-less nuclear_reviewer must not freeze the sibling spec_reviewer; spawns=${JSON.stringify(captured.spawns)}`,
  )
  const missingCliDiags = captured.diagnostics.filter((d) => d.title === 'Roster runner skipped agent')
  assert.equal(
    missingCliDiags.length,
    1,
    `the missing-CLI notice publishes once across ticks (dedup); diagnostics=${JSON.stringify(captured.diagnostics.map((d) => d.title))}`,
  )
}

async function testMissingCliSpawnDedupesAndReportsDistinctResult(): Promise<void> {
  // The decision layer (spawnAutoRunCandidate) owns BOTH the missing-CLI dedup
  // and the distinct return value that lets retry-capped callers count the
  // attempt. This exercises it directly — the shared mechanism behind all five
  // spawn sites, including the three (notification, respawn, architect-triage)
  // that previously did not pass the notice set and so re-warned every ~4s.
  const state = {
    roleRuntimes: { developer: { cli: 'claude-code' } }, // nuclear_reviewer absent → no CLI
    sprintEngineAgents: {},
    tasks: [],
  } as unknown as SprintEngineState
  const workspace = {
    id: 'workspace-1',
    name: 'Decision-layer workspace',
    folderPath: '/tmp/workspace',
    agents: {},
    sprintEngineState: state,
    sprintEngineContext: { teamSlug: 'team', statePath: STATE_PATH },
  } as unknown as SprintEngineWorkspaceView
  const cliRuntimes = { 'claude-code': { command: 'claude', useWsl: false } } as unknown as Record<AgentCli, CliRuntimeSettings>
  const candidate = { agentId: 'nuclear_reviewer-1', label: 'Nuclear', role: 'nuclear_reviewer', taskId: 'T-x' } as unknown as AutoRunCandidate

  const captured: Captured = { spawns: [], diagnostics: [], writes: [] }
  const ports = makePorts(captured, workspace, [])
  const notice = new Set<string>()
  const inFlight = ref(new Set<string>())
  const r1 = await spawnAutoRunCandidate(ports, workspace, state, candidate, cliRuntimes, {} as McpSettings, inFlight, { missingCliNoticeKeys: notice })
  const r2 = await spawnAutoRunCandidate(ports, workspace, state, candidate, cliRuntimes, {} as McpSettings, inFlight, { missingCliNoticeKeys: notice })
  assert.equal(r1, 'missing_cli', 'a role with no resolved CLI returns missing_cli, distinct from a coverage skip')
  assert.equal(r2, 'missing_cli', 'the repeated attempt still reports missing_cli')
  assert.equal(
    captured.diagnostics.filter((d) => d.title === 'Roster runner skipped agent').length,
    1,
    `a shared notice set dedupes the missing-CLI diagnostic across calls; diagnostics=${captured.diagnostics.length}`,
  )

  // With NO notice set the decision layer cannot dedupe, so each attempt warns —
  // the pre-fix per-tick spam the three unwired sites produced.
  const captured2: Captured = { spawns: [], diagnostics: [], writes: [] }
  const ports2 = makePorts(captured2, workspace, [])
  await spawnAutoRunCandidate(ports2, workspace, state, candidate, cliRuntimes, {} as McpSettings, ref(new Set<string>()), {})
  await spawnAutoRunCandidate(ports2, workspace, state, candidate, cliRuntimes, {} as McpSettings, ref(new Set<string>()), {})
  assert.equal(
    captured2.diagnostics.filter((d) => d.title === 'Roster runner skipped agent').length,
    2,
    'with no notice set every attempt warns (the pre-fix spam each unwired site produced)',
  )
}

async function testDeadClaimantRespawnCountsMissingCliRetry(): Promise<void> {
  // A dead-claimant respawn (backlog 1716): an in-progress task is owned by a
  // managed roster agent whose terminal is not live, so the dispatch plan wants
  // to respawn it — but the owner's role resolves NO CLI. The executor used to
  // `continue` on the opaque 'skipped' BEFORE recordPromptRetry, so the retry
  // cap never advanced and the respawn re-planned every ~4s forever. With the
  // missing-CLI outcome distinguished, the attempt counts a retry (bounding the
  // loop) and the notice is deduped.
  const task = (over: Record<string, unknown>) => ({
    id: 'T', title: '', description: '', role: 'developer', status: 'todo', ownerAgentId: null,
    dependsOn: [], ownedPaths: [], acceptanceCriteria: [], implementationNotes: [],
    evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] }, notes: [], comments: [],
    startedAt: null, completedAt: null, boardColumn: 'ready', ...over,
  })
  const state = {
    name: 'team',
    goal: '',
    roleCounts: {},
    // nuclear_reviewer absent from roleRuntimes AND the agent record carries no
    // cli, so its runtime resolves no CLI — the 2026-07-19 gap.
    roleRuntimes: { developer: { cli: 'claude-code' } },
    sprintEngineAgents: {
      'nuclear_reviewer-1': { role: 'nuclear_reviewer', status: 'running', currentTaskId: 'T-owned' },
    },
    events: [],
    artifacts: [],
    tasks: [
      task({
        id: 'T-owned', title: 'Claimed review', role: 'nuclear_reviewer',
        status: 'in_progress', ownerAgentId: 'nuclear_reviewer-1', boardColumn: 'in_progress',
      }),
    ],
  } as unknown as SprintEngineState

  const claimant = { ...viewAgent('nuclear_reviewer-1'), cli: undefined } as unknown as AgentState
  const workspace = {
    id: 'workspace-1',
    name: 'Respawn workspace',
    folderPath: '/tmp/workspace',
    agents: { 'nuclear_reviewer-1': claimant },
    sprintEngineState: state,
    sprintEngineAutoState: autoState(),
    sprintEngineContext: { teamSlug: 'team', statePath: STATE_PATH },
    memory: { relativeRoot: '' },
  } as unknown as SprintEngineWorkspaceView

  const captured: Captured = { spawns: [], diagnostics: [], writes: [] }
  // No live sessions → the claimant is not live → it is a respawn candidate.
  const ports = makePorts(captured, workspace, [])
  const cliRuntimes = { 'claude-code': { command: 'claude', useWsl: false } } as unknown as Record<AgentCli, CliRuntimeSettings>

  const args = superviseArgs(ports, workspace, cliRuntimes)
  // Index 8 is the shared continuation ledger (the respawn retry cap lives here).
  const continuationLedger = args[8] as { current: Map<string, SprintEngineDispatchAttempt> }
  await superviseWorkspace(...args)

  const attempts = [...continuationLedger.current.values()].map((entry) => entry.attempts ?? 0)
  assert.ok(
    attempts.some((count) => count >= 1),
    `the CLI-less dead-claimant respawn counts a retry so the loop is bounded; ledger=${JSON.stringify([...continuationLedger.current.entries()])}`,
  )
  assert.equal(
    captured.diagnostics.filter((d) => d.title === 'Roster runner skipped agent').length,
    1,
    `the missing-CLI notice publishes once for the respawn path; diagnostics=${JSON.stringify(captured.diagnostics.map((d) => d.title))}`,
  )
}

function poolTask(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, title: id, description: '', role: 'developer', status: 'todo', ownerAgentId: null,
    dependsOn: [], ownedPaths: [], acceptanceCriteria: [], implementationNotes: [],
    evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] }, notes: [], comments: [],
    startedAt: null, completedAt: null, boardColumn: 'ready', ...over,
  }
}

function poolWorkspace(state: SprintEngineState, name: string): SprintEngineWorkspaceView {
  return {
    id: 'workspace-1',
    name,
    folderPath: '/tmp/workspace',
    agents: {},
    sprintEngineState: state,
    sprintEngineAutoState: autoState(),
    sprintEngineContext: { teamSlug: 'team', statePath: STATE_PATH },
    memory: { relativeRoot: '' },
  } as unknown as SprintEngineWorkspaceView
}

async function testConcurrencyCapHoldsAcrossTicksWhileSessionsBoot(): Promise<void> {
  // MC-1750: cap 3, 8 ready developer tasks. Spawned sessions become live
  // immediately but never claim (no runtime record — the boot window). Under
  // the pre-fix accounting each tick saw zero occupancy and spawned 3 more
  // (the 17-terminal burst); with booting sessions occupying slots, ticks 2
  // and 3 must spawn nothing.
  const state = {
    name: 'team', goal: '', roleCounts: {},
    roleRuntimes: { developer: { cli: 'claude-code' } },
    sprintEngineAgents: {},
    events: [], artifacts: [],
    tasks: Array.from({ length: 8 }, (_, i) => poolTask(`T-${i + 1}`)),
  } as unknown as SprintEngineState

  const workspace = poolWorkspace(state, 'Cap workspace')
  const captured: Captured = { spawns: [], diagnostics: [], writes: [] }
  const sessions: TerminalSessionSnapshot[] = []
  const basePorts = makePorts(captured, workspace, sessions) as unknown as Record<string, unknown>
  const ports = {
    ...basePorts,
    // A spawn's session is live on the next terminal list — but its agent has
    // not claimed, so the engine still has no runtime record for it.
    terminalSpawn: async (args: { sessionId: string; metadata?: { agentId?: string } }) => {
      const agentId = args.metadata?.agentId
      captured.spawns.push({ sessionId: args.sessionId, agentId })
      if (agentId) sessions.push(agentSession(agentId, 'developer'))
      return { ok: true, sessionId: args.sessionId }
    },
  } as unknown as SprintEngineAutoRunCyclePorts
  const cliRuntimes = { 'claude-code': { command: 'claude', useWsl: false } } as unknown as Record<AgentCli, CliRuntimeSettings>

  const args = superviseArgs(ports, workspace, cliRuntimes)
  await superviseWorkspace(...args)
  assert.equal(captured.spawns.length, 3, `tick 1 spawns exactly the cap; spawns=${JSON.stringify(captured.spawns)}`)
  await superviseWorkspace(...args)
  await superviseWorkspace(...args)
  assert.equal(
    captured.spawns.length,
    3,
    `booting sessions occupy slots, so later ticks spawn nothing until claims land; spawns=${JSON.stringify(captured.spawns)}`,
  )
}

async function testBootingSessionIsNotDoubleCoveredForTheSameDemand(): Promise<void> {
  // The developer-17 ghost shape: one ready task, cap 3 (slots free). Tick 1
  // mints one worker; tick 2 runs before that session claims. The booting
  // session both supplies the demand key and occupies a slot — no second mint.
  const state = {
    name: 'team', goal: '', roleCounts: {},
    roleRuntimes: { developer: { cli: 'claude-code' } },
    sprintEngineAgents: {},
    events: [], artifacts: [],
    tasks: [poolTask('T-only')],
  } as unknown as SprintEngineState

  const workspace = poolWorkspace(state, 'Double-cover workspace')
  const captured: Captured = { spawns: [], diagnostics: [], writes: [] }
  const sessions: TerminalSessionSnapshot[] = []
  const basePorts = makePorts(captured, workspace, sessions) as unknown as Record<string, unknown>
  const ports = {
    ...basePorts,
    terminalSpawn: async (args: { sessionId: string; metadata?: { agentId?: string } }) => {
      const agentId = args.metadata?.agentId
      captured.spawns.push({ sessionId: args.sessionId, agentId })
      if (agentId) sessions.push(agentSession(agentId, 'developer'))
      return { ok: true, sessionId: args.sessionId }
    },
  } as unknown as SprintEngineAutoRunCyclePorts
  const cliRuntimes = { 'claude-code': { command: 'claude', useWsl: false } } as unknown as Record<AgentCli, CliRuntimeSettings>

  const args = superviseArgs(ports, workspace, cliRuntimes)
  await superviseWorkspace(...args)
  await superviseWorkspace(...args)
  assert.equal(
    captured.spawns.length,
    1,
    `one ready task gets exactly one worker across ticks; spawns=${JSON.stringify(captured.spawns)}`,
  )
}

async function testGhostSessionIsReapedAfterBootAllowance(): Promise<void> {
  // A live session with NO engine runtime record (spawned, never claimed —
  // immortal developer-17). Within the boot allowance it is left alone; past
  // it, the reaper tears it down.
  const state = {
    name: 'team', goal: '', roleCounts: {},
    roleRuntimes: { developer: { cli: 'claude-code' } },
    sprintEngineAgents: {},
    events: [], artifacts: [],
    // One in-progress owned task keeps the run non-terminal and produces no
    // demand (so nothing spawns and muddies the assertion).
    tasks: [poolTask('T-busy', { status: 'in_progress', ownerAgentId: 'developer-9', boardColumn: 'in_progress' })],
  } as unknown as SprintEngineState

  const workspace = poolWorkspace(state, 'Ghost workspace')
  const captured: Captured = { spawns: [], diagnostics: [], writes: [] }
  const teardowns: string[] = []
  const sessions: TerminalSessionSnapshot[] = [agentSession('ghost-1')]
  const basePorts = makePorts(captured, workspace, sessions) as unknown as Record<string, unknown>
  const ports = {
    ...basePorts,
    tearDownDepartedTaskScopedWorker: async (_workspaceId: string, agentId: string) => {
      teardowns.push(agentId)
      return { recorded: false, removedAgent: true, removedTab: true, closedSessionId: `session-${agentId}` }
    },
  } as unknown as SprintEngineAutoRunCyclePorts
  const cliRuntimes = { 'claude-code': { command: 'claude', useWsl: false } } as unknown as Record<AgentCli, CliRuntimeSettings>

  const args = superviseArgs(ports, workspace, cliRuntimes)
  const idleClock = args[13].current as Map<string, number>

  // Tick 1: the ghost is observed and its idle clock starts — still within the
  // boot allowance, so nothing is torn down.
  await superviseWorkspace(...args)
  assert.equal(teardowns.length, 0, 'a booting session inside the allowance is left alone')
  assert.ok(idleClock.has(`${STATE_PATH}:ghost-1`), 'the ghost is aged on the idle clock')

  // Age it past the allowance and tick again: reaped.
  idleClock.set(`${STATE_PATH}:ghost-1`, Date.now() - 6 * 60_000)
  await superviseWorkspace(...args)
  assert.deepEqual(teardowns, ['ghost-1'], `the aged ghost is torn down; teardowns=${JSON.stringify(teardowns)}`)
}

// --- MC-2057: coordinator engagement asks the seat, not the role name -------

/** A roleless run: `configuredRoles: []`, one seat id, everything else absent. */
function rolelessState(over: Record<string, unknown>): SprintEngineState {
  return {
    name: 'team', goal: '', roleCounts: {}, configuredRoles: [],
    roleRuntimes: { '(roleless)': { cli: 'claude-code' } },
    sprintEngineAgents: {}, events: [], artifacts: [],
    tasks: [],
    ...over,
  } as unknown as SprintEngineState
}

async function testRolelessTriageEngagesTheCoordinatorSeat(): Promise<void> {
  // F1: the engagement lookup was `candidate.role === 'architect'`, which a
  // roleless roster can never satisfy — so an architect-KIND blocker on the new
  // default sprint kind was never triaged, by anyone, ever. The blocker carries
  // an owner, so no dispatch/wake/revival path covers for it either.
  const state = rolelessState({
    sprintEngineAgents: { coordinator: { status: 'running', currentTaskId: null } },
    tasks: [
      poolTask('T-blocked', {
        role: undefined, status: 'needs_input', boardColumn: 'needs_input', ownerAgentId: 'agent-1',
        needsInput: { kind: 'architect', reason: 'plan ambiguity' },
      }),
    ],
  })
  const workspace = poolWorkspace(state, 'Roleless triage workspace')
  ;(workspace as { agents: Record<string, unknown> }).agents = {
    coordinator: { ...viewAgent('coordinator'), cliSessionId: 'session-coordinator' },
  }

  const captured: Captured = { spawns: [], diagnostics: [], writes: [] }
  const ports = makePorts(captured, workspace, [agentSession('coordinator')])
  const cliRuntimes = { 'claude-code': { command: 'claude', useWsl: false } } as unknown as Record<AgentCli, CliRuntimeSettings>

  await superviseWorkspace(...superviseArgs(ports, workspace, cliRuntimes))

  const triageWrite = captured.writes.find((write) => write.data.includes('sprintengine.triage.needs_input'))
  assert.ok(
    triageWrite,
    `the roleless seat is engaged for triage; writes=${JSON.stringify(captured.writes.map((w) => w.sessionId))}`,
  )
  assert.equal(triageWrite?.sessionId, 'session-coordinator', 'triage lands in the coordinator terminal')
  assert.ok(
    triageWrite?.data.includes('"id": "coordinator"'),
    `the triage payload carries the seat's own id; prompt=${JSON.stringify(triageWrite?.data.slice(0, 400))}`,
  )
  assert.ok(!triageWrite?.data.includes('"id": "architect"'), 'and never the architect literal')
  assert.ok(triageWrite?.data.includes('T-blocked'), 'and names the blocked task')
}

async function testRolelessCoordinatorGetsTheAutonomousPlanningOverride(): Promise<void> {
  // F5: the override was gated on `nextRun.role === 'architect'`, so the
  // planning seat of the default sprint kind was the one seat that could not
  // plan autonomously under `run_agents_and_approve_artifacts` — it stopped on
  // exactly the plan-review questions that mode exists to suppress.
  const state = rolelessState({ tasks: [] })
  const workspace = poolWorkspace(state, 'Roleless planning workspace')
  ;(workspace as { sprintEngineAutoState: SprintEngineAutoState }).sprintEngineAutoState = {
    ...autoState(),
    desiredMode: 'run_agents_and_approve_artifacts',
  }
  ;(workspace as { agents: Record<string, unknown> }).agents = { coordinator: viewAgent('coordinator') }

  const captured: Captured = { spawns: [], diagnostics: [], writes: [] }
  const ports = makePorts(captured, workspace, [])
  const cliRuntimes = { 'claude-code': { command: 'claude', useWsl: false } } as unknown as Record<AgentCli, CliRuntimeSettings>

  // No tasks yet: bootstrap spawns the seat with its generated startup prompt.
  await superviseWorkspace(...superviseArgs(ports, workspace, cliRuntimes))

  const seatSpawn = captured.spawns.find((spawn) => spawn.agentId === 'coordinator')
  assert.ok(seatSpawn, `the roleless seat is bootstrapped; spawns=${JSON.stringify(captured.spawns)}`)
  assert.ok(
    seatSpawn?.initialPrompt?.includes('## Autonomous Planning Override'),
    `the seat's startup prompt carries the override; prompt=${JSON.stringify(seatSpawn?.initialPrompt?.slice(0, 300))}`,
  )

  // A task-scoped worker on the same run is not the seat and must not get it.
  const workerState = rolelessState({
    sprintEngineAgents: { coordinator: { status: 'running', currentTaskId: 'T-gate' } },
    artifacts: [{ id: 'A-plan', kind: 'architect_plan', title: 'Plan', taskId: 'T-gate', status: 'approved' }],
    tasks: [
      poolTask('T-gate', { role: undefined, status: 'in_progress', boardColumn: 'in_progress', ownerAgentId: 'coordinator' }),
      poolTask('T-work', { role: undefined }),
    ],
  })
  const workerWorkspace = poolWorkspace(workerState, 'Roleless worker workspace')
  ;(workerWorkspace as { sprintEngineAutoState: SprintEngineAutoState }).sprintEngineAutoState = {
    ...autoState(),
    desiredMode: 'run_agents_and_approve_artifacts',
  }
  const workerCaptured: Captured = { spawns: [], diagnostics: [], writes: [] }
  const workerPorts = makePorts(workerCaptured, workerWorkspace, [agentSession('coordinator')])
  await superviseWorkspace(...superviseArgs(workerPorts, workerWorkspace, cliRuntimes))

  const workerSpawn = workerCaptured.spawns.find((spawn) => spawn.agentId !== 'coordinator')
  assert.ok(workerSpawn, `the ready work task mints a worker; spawns=${JSON.stringify(workerCaptured.spawns.map((s) => s.agentId))}`)
  // Assert the prompt EXISTS before asserting what it lacks: `undefined?.includes(x)`
  // is `undefined`, so a negative-only check would pass on a spawn that carried
  // no startup prompt at all.
  assert.ok(
    workerSpawn?.initialPrompt?.includes('## First MCP Calls'),
    `the worker is spawned with a real startup prompt; prompt=${JSON.stringify(workerSpawn?.initialPrompt?.slice(0, 200))}`,
  )
  assert.ok(
    !workerSpawn?.initialPrompt?.includes('## Autonomous Planning Override'),
    `a task-scoped worker gets no planning override; agentId=${workerSpawn?.agentId}`,
  )
}

/**
 * MC-2179, end to end: which run-start actually spends a planning session.
 *
 * Creation composes a handoff prompt onto the coordinator seat regardless of
 * whether the run needs planning, so the prompt cannot be the signal. A run
 * whose graph arrived with it (an epic or selection the engine minted at init)
 * must spend NOTHING on the seat; a run that still has to be planned reaches
 * the same seat with the same prompt through its plan-gate task.
 */
async function testAPrePlannedRunSpendsNoPlanningSessionButAPlanGateStillReachesTheSeat(): Promise<void> {
  const cliRuntimes = { 'claude-code': { command: 'claude', useWsl: false } } as unknown as Record<AgentCli, CliRuntimeSettings>
  const seatAgent = () => ({
    ...viewAgent('coordinator'),
    cliSessionId: null,
    cliStartRequested: false,
    cliHasLaunched: false,
    cliStartupPrompt: 'HANDOFF: review the sources and build the task graph.',
    cliOnboardingPromptSent: false,
  })

  // Pre-planned: the epic's children are already tasks and no plan gate exists.
  const preplanned = rolelessState({
    tasks: [poolTask('T1', { role: undefined }), poolTask('T2', { role: undefined, dependsOn: ['T1'] })],
  })
  const preplannedWorkspace = poolWorkspace(preplanned, 'Pre-planned run')
  ;(preplannedWorkspace as { agents: Record<string, unknown> }).agents = { coordinator: seatAgent() }
  const preplannedCaptured: Captured = { spawns: [], diagnostics: [], writes: [] }
  await superviseWorkspace(
    ...superviseArgs(makePorts(preplannedCaptured, preplannedWorkspace, []), preplannedWorkspace, cliRuntimes),
  )

  assert.deepEqual(
    preplannedCaptured.spawns.filter((spawn) => spawn.agentId === 'coordinator'),
    [],
    `no planning session is spent on a run that arrived planned; spawns=${JSON.stringify(preplannedCaptured.spawns.map((s) => s.agentId))}`,
  )
  assert.ok(
    preplannedCaptured.spawns.some((spawn) => spawn.agentId !== 'coordinator'),
    `its ready work still mints a worker; spawns=${JSON.stringify(preplannedCaptured.spawns.map((s) => s.agentId))}`,
  )

  // Planned: init opened a plan-gate task bound to the run's plan artifact, and
  // every other task roots on it.
  const planned = rolelessState({
    artifacts: [{ id: 'A1', kind: 'architect_plan', title: 'Plan', path: 'plan.md', taskId: 'T0', status: 'ready' }],
    tasks: [poolTask('T0', { role: undefined }), poolTask('T1', { role: undefined, dependsOn: ['T0'] })],
  })
  const plannedWorkspace = poolWorkspace(planned, 'Planned run')
  ;(plannedWorkspace as { agents: Record<string, unknown> }).agents = { coordinator: seatAgent() }
  const plannedCaptured: Captured = { spawns: [], diagnostics: [], writes: [] }
  await superviseWorkspace(
    ...superviseArgs(makePorts(plannedCaptured, plannedWorkspace, []), plannedWorkspace, cliRuntimes),
  )

  const gateSpawn = plannedCaptured.spawns.find((spawn) => spawn.agentId === 'coordinator')
  assert.ok(
    gateSpawn,
    `the plan gate reaches the coordinator seat; spawns=${JSON.stringify(plannedCaptured.spawns.map((s) => s.agentId))}`,
  )
  assert.ok(
    gateSpawn?.initialPrompt?.includes('HANDOFF: review the sources'),
    `and carries the stored handoff prompt; prompt=${JSON.stringify(gateSpawn?.initialPrompt?.slice(0, 200))}`,
  )
}

// --- MC-2136: per-task isolation routes the spawn into its task's own tree ---

function isolatedWorkspace(): { state: SprintEngineState; workspace: SprintEngineWorkspaceView } {
  const state = {
    roleRuntimes: { developer: { cli: 'claude-code' } },
    sprintEngineAgents: {},
    tasks: [{ id: 'T7', repo: 'primary', status: 'ready' }],
    vcs: {
      mode: 'run_worktree',
      taskIsolation: true,
      worktreePath: '.multi-code/sprintengine/team/worktree',
      branchName: 'run/main',
      repos: [{
        id: 'primary',
        root: '.',
        worktreePath: '.multi-code/sprintengine/team/worktree',
        branchName: 'run/main',
      }],
    },
  } as unknown as SprintEngineState
  const workspace = {
    id: 'workspace-1',
    name: 'Isolated run',
    folderPath: '/tmp/workspace',
    agents: {},
    sprintEngineState: state,
    sprintEngineContext: { teamSlug: 'team', statePath: STATE_PATH },
  } as unknown as SprintEngineWorkspaceView
  return { state, workspace }
}

async function testPerTaskIsolationSpawnsInTheTasksOwnWorktree(): Promise<void> {
  // The whole point of the terminal-cwd half: the engine commits a task's work
  // from that task's tree, so the agent has to be born inside it. The tree is
  // provisioned here, before the spawn, because a claim provisions too late —
  // by then the session's cwd is already fixed.
  const { state, workspace } = isolatedWorkspace()
  const cliRuntimes = { 'claude-code': { command: 'claude', useWsl: false } } as unknown as Record<AgentCli, CliRuntimeSettings>
  const candidate = { agentId: 'developer-1', label: 'Dev', role: 'developer', taskId: 'T7' } as unknown as AutoRunCandidate
  const captured: Captured = { spawns: [], diagnostics: [], writes: [], taskWorktreeRequests: [] }
  const ports = makePorts(captured, workspace, [], {
    taskWorktreeResult: {
      ok: true,
      isolated: true,
      worktreePath: '.multi-code/sprintengine/team/task-worktrees/T7/primary',
    },
  })
  const result = await spawnAutoRunCandidate(
    ports, workspace, state, candidate, cliRuntimes, {} as McpSettings, ref(new Set<string>()), {},
  )
  assert.equal(result, 'started')
  assert.deepEqual(captured.taskWorktreeRequests, ['T7'], 'the spawn provisions its own task’s tree first')
  assert.equal(
    captured.spawns[0]?.cwd,
    '/tmp/workspace/.multi-code/sprintengine/team/task-worktrees/T7/primary',
    'the terminal opens in the task worktree, not the shared run worktree',
  )
}

async function testFailedTaskWorktreeStillSpawnsAndWarns(): Promise<void> {
  // Provisioning failure degrades the cwd; it must not lose the spawn. And it
  // must be loud — an agent working outside its task's tree is a silent
  // no-op at publish, which is exactly what the diagnostic exists to prevent.
  const { state, workspace } = isolatedWorkspace()
  const cliRuntimes = { 'claude-code': { command: 'claude', useWsl: false } } as unknown as Record<AgentCli, CliRuntimeSettings>
  const candidate = { agentId: 'developer-1', label: 'Dev', role: 'developer', taskId: 'T7' } as unknown as AutoRunCandidate
  const captured: Captured = { spawns: [], diagnostics: [], writes: [], taskWorktreeRequests: [] }
  const ports = makePorts(captured, workspace, [], {
    taskWorktreeResult: { ok: false, isolated: true, worktreePath: null, message: 'run worktree is missing' },
  })
  const result = await spawnAutoRunCandidate(
    ports, workspace, state, candidate, cliRuntimes, {} as McpSettings, ref(new Set<string>()), {},
  )
  assert.equal(result, 'started', 'a provisioning failure is not a spawn failure')
  assert.equal(
    captured.spawns[0]?.cwd,
    '/tmp/workspace/.multi-code/sprintengine/team/worktree',
    'it falls back to the run worktree it would have used before isolation existed',
  )
  const warned = captured.diagnostics.find((entry) => entry.title === 'Task worktree could not be prepared')
  assert.ok(warned, `the degraded cwd is reported; diagnostics=${JSON.stringify(captured.diagnostics.map((d) => d.title))}`)
  assert.match(warned?.details ?? '', /run worktree is missing/u, 'the engine’s own reason survives into the diagnostic')
}

async function testSharedWorktreeRunNeverAsksForATaskTree(): Promise<void> {
  // The normal run must pay nothing for a feature it does not use: no engine
  // process per spawn, and byte-identical cwd.
  const { state, workspace } = isolatedWorkspace()
  ;(state.vcs as { taskIsolation?: boolean }).taskIsolation = false
  const cliRuntimes = { 'claude-code': { command: 'claude', useWsl: false } } as unknown as Record<AgentCli, CliRuntimeSettings>
  const candidate = { agentId: 'developer-1', label: 'Dev', role: 'developer', taskId: 'T7' } as unknown as AutoRunCandidate
  const captured: Captured = { spawns: [], diagnostics: [], writes: [], taskWorktreeRequests: [] }
  const ports = makePorts(captured, workspace, [])
  await spawnAutoRunCandidate(
    ports, workspace, state, candidate, cliRuntimes, {} as McpSettings, ref(new Set<string>()), {},
  )
  assert.deepEqual(captured.taskWorktreeRequests, [], 'a shared-worktree run never provisions a task tree')
  assert.equal(captured.spawns[0]?.cwd, '/tmp/workspace/.multi-code/sprintengine/team/worktree')
}

async function main(): Promise<void> {
  await testAThrowingStageDoesNotPreventSpawning()
  await testTriageActingDoesNotSuppressPoolSpawning()
  await testMissingCliRoleDoesNotFreezeSiblings()
  await testMissingCliSpawnDedupesAndReportsDistinctResult()
  await testDeadClaimantRespawnCountsMissingCliRetry()
  await testConcurrencyCapHoldsAcrossTicksWhileSessionsBoot()
  await testBootingSessionIsNotDoubleCoveredForTheSameDemand()
  await testGhostSessionIsReapedAfterBootAllowance()
  await testRolelessTriageEngagesTheCoordinatorSeat()
  await testRolelessCoordinatorGetsTheAutonomousPlanningOverride()
  await testAPrePlannedRunSpendsNoPlanningSessionButAPlanGateStillReachesTheSeat()
  await testPerTaskIsolationSpawnsInTheTasksOwnWorktree()
  await testFailedTaskWorktreeStillSpawnsAndWarns()
  await testSharedWorktreeRunNeverAsksForATaskTree()
  console.log('auto-run-cycle.test.ts: all tests passed')
}

void main()
