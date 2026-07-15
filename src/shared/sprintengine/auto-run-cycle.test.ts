/**
 * Supervise-cycle fail-soft test (MC-1592). A stage that throws must log a
 * diagnostic and be skipped without aborting the tick — later stages, crucially
 * spawning, still run from the same snapshot. Exercised end-to-end through
 * `superviseWorkspace`: the recovery-and-dispatch stage throws (a dispatch paste
 * whose terminal write fails), and a ready task must still spawn the same tick.
 *
 * Runner: esbuild bundle -> node, `node:assert/strict`.
 */
import assert from 'node:assert/strict'
import type { AgentCli, CliRuntimeSettings, McpSettings, TerminalSessionSnapshot } from '../electron-api'
import type { AgentState } from './agent-state'
import type { SprintEngineState, SprintEngineWorkspaceView } from './run-types'
import type { SprintEngineAutoState } from './automation-types'
import type { ArchitectTriageMessage, SprintEngineAutoRunCyclePorts } from './auto-run-cycle'
import type { RoleContinuationGrace, SprintEngineDispatchAttempt } from './auto-run'
import { createSprintEngineAutoRunCycleState, superviseWorkspace } from './auto-run-cycle'

type Captured = {
  spawns: Array<{ sessionId: string; agentId?: string }>
  diagnostics: Array<{ title?: string; details?: string }>
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
): SprintEngineAutoRunCyclePorts {
  return {
    terminalList: async () => sessions,
    // The dispatch paste fails: this is the stage that throws (a non-IPC error,
    // so it is swallowed fail-soft, not re-thrown like a TerminalListIpcError).
    terminalWrite: async () => { throw new Error('terminal write failed') },
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
    setSprintEngineAutoPendingSpawns: () => {},
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
    pendingSpawns: [],
    deliveredAgentNotificationEventKeys: [],
  }
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

  const captured: Captured = { spawns: [], diagnostics: [] }
  const ports = makePorts(captured, workspace, [agentSession('developer-1')])
  const cliRuntimes = { 'claude-code': { command: 'claude', useWsl: false } } as unknown as Record<AgentCli, CliRuntimeSettings>

  await superviseWorkspace(
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
    ref(new Map<string, RoleContinuationGrace>()),
    ref(new Map<string, string>()),
    ref(new Map<string, number>()),
    ref(new Map<string, number>()),
  )

  assert.equal(captured.spawns.length, 1, `the ready task still spawns despite the thrown stage; spawns=${JSON.stringify(captured.spawns)}`)
  assert.equal(captured.spawns[0].agentId, 'developer-2', 'a fresh worker is minted for the ready task')
  assert.ok(
    captured.diagnostics.some((d) => d.title === 'Sprint supervisor stage skipped'),
    `the thrown stage logs a "stage skipped" diagnostic; diagnostics=${JSON.stringify(captured.diagnostics.map((d) => d.title))}`,
  )
}

async function main(): Promise<void> {
  await testAThrowingStageDoesNotPreventSpawning()
  console.log('auto-run-cycle.test.ts: all tests passed')
}

void main()
