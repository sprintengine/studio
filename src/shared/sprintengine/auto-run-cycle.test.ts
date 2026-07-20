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
import type { SprintEngineDispatchAttempt } from './auto-run'
import { createSprintEngineAutoRunCycleState, superviseWorkspace } from './auto-run-cycle'

type Captured = {
  spawns: Array<{ sessionId: string; agentId?: string }>
  diagnostics: Array<{ title?: string; details?: string }>
  writes: Array<{ sessionId: string; data: string }>
}

const STATE_PATH = '/tmp/workspace/.multi-code/sprintengine/team/run.yaml'

function agentSession(agentId: string): TerminalSessionSnapshot {
  return {
    sessionId: `session-${agentId}`,
    kind: 'agent',
    processAlive: true,
    workspaceId: 'workspace-1',
    agentId,
    sprintEngineStatePath: STATE_PATH,
    cli: 'claude-code',
    startedAt: 1,
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
  options: { terminalWriteFails?: boolean } = {},
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
      captured.spawns.push({ sessionId: args.sessionId, agentId: (args.metadata as { agentId?: string })?.agentId })
      return { ok: true, sessionId: args.sessionId }
    },
    pathExists: async () => true,
    readSprintEngineProjection: async () => ({ ok: true, unchanged: true } as never),
    autoApproveSprintEngineArtifact: async () => ({ ok: true } as never),
    memoryResolveRoot: async () => ({ ok: false, status: 'disabled', relativeRoot: null } as never),
    publishDiagnostic: async (input) => { captured.diagnostics.push({ title: input.title, details: input.details }) },
    applyTerminalRevealPolicy: () => {},
    isAgentTabVisible: () => false,
    getPluginCatalogEntries: () => [],
    getSpawnSettings: () => ({ projectKnowledgeRoots: null, sprintEngineModelCatalog: [] }),
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
    cliPermissionPreset: 'default',
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
        id: 'T-blocked', title: 'Needs planner input', status: 'needs_input', boardColumn: 'blocked',
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
  // sweep role that never got a CLI), so its runtime resolves no CLI;
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

async function main(): Promise<void> {
  await testAThrowingStageDoesNotPreventSpawning()
  await testTriageActingDoesNotSuppressPoolSpawning()
  await testMissingCliRoleDoesNotFreezeSiblings()
  console.log('auto-run-cycle.test.ts: all tests passed')
}

void main()
