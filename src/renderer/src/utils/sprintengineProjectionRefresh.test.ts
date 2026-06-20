import assert from 'node:assert/strict'
import type {
  BacklogItemLinkPayload,
  BacklogMutationResult,
  BacklogObjectStorePayload,
  BacklogReadResult,
} from '../../../shared/electron-api'
import type { SprintEngineAutomationEvent, SprintEngineState, Workspace } from '../types/workspace'
import {
  canStopPollingCompletedSprintEngineProjection,
  refreshSprintEngineWorkspaceProjection,
  type SprintEngineProjectionRefreshPorts,
} from './sprintengineProjectionRefresh'

function projection(taskStatus: string, updatedAt = '2026-06-07T15:00:00Z', runStatus = 'executing'): unknown {
  return {
    ok: true,
    projectionVersion: 1,
    source: 'folder_store',
    generatedAt: updatedAt,
    updatedAt,
    run: {
      id: 'unified-refresh',
      name: 'Unified Refresh',
      goal: 'Keep board and auto-run state together',
      status: runStatus,
      rosterConfigured: true,
      updatedAt,
    },
    roster: {},
    tasks: [{
      id: 'T1',
      title: 'Fixture task',
      role: 'developer',
      status: taskStatus,
      folderStatus: taskStatus,
      dependsOn: [],
      qualityGates: [],
      activity: [],
    }],
    artifacts: [],
    activity: [],
  }
}

function workspace(): Workspace {
  return {
    id: 'workspace-1',
    name: 'Workspace',
    folderPath: '/tmp/workspace',
    mode: 'sprintengine',
    agents: {},
    layoutModel: null,
    sprintEngineContext: {
      statePath: '/tmp/workspace/.multi-code/sprintengine/unified-refresh/run.yaml',
      teamSlug: 'unified-refresh',
      teamName: 'Unified Refresh',
    },
    sprintEngineState: {
      name: 'Unified Refresh',
      goal: '',
      rosterConfigured: true,
      updatedAt: null,
      roleCounts: {
        architect: 0,
        developer: 0,
        frontend: 0,
        product: 0,
        code_reviewer: 0,
        nuclear_reviewer: 0,
        spec_reviewer: 0,
        tester: 0,
        performance: 0,
        security: 0,
        cross_platform: 0,
      },
      sprintEngineAgents: {},
      events: [],
      tasks: [],
      artifacts: [],
    } satisfies SprintEngineState,
  } as unknown as Workspace
}

function portsFor(input: {
  data?: unknown
  ok?: boolean
  message?: string
  token?: string
  applied: SprintEngineState[]
  backlogStore?: BacklogObjectStorePayload
  backlogReadResult?: BacklogReadResult
  backlogMutations?: Array<{
    workspaceRoot: string
    relativePath: string
    link: BacklogItemLinkPayload
    status?: 'completed'
  }>
  backlogMutationResult?: BacklogMutationResult
  diagnostics?: string[]
  automationEvents?: SprintEngineAutomationEvent[]
}): SprintEngineProjectionRefreshPorts {
  return {
    readSprintEngineProjection: async (_statePath, knownToken) => {
      if (input.ok === false) return { ok: false, message: input.message ?? 'projection read failed' }
      const token = input.token ?? 'tok-1'
      if (knownToken && knownToken === token) return { ok: true, data: null, token, unchanged: true }
      return { ok: true, data: input.data ?? projection('in_progress'), token }
    },
    setSprintEngineState: (_workspaceId, state) => {
      if (state) input.applied.push(state)
    },
    applySprintEngineAutomationEvent: (_workspaceId, event) => {
      input.automationEvents?.push(event)
    },
    readBacklogObjectStore: async () => input.backlogReadResult ?? {
      ok: true,
      store: input.backlogStore ?? { schemaVersion: 1, items: [] },
    },
    addOrUpdateBacklogLink: async (args) => {
      input.backlogMutations?.push(args)
      return input.backlogMutationResult ?? { ok: true, store: input.backlogStore ?? { schemaVersion: 1, items: [] } }
    },
    publishDiagnostic: (diagnostic) => {
      input.diagnostics?.push(diagnostic.message)
    },
    now: () => 1000,
  }
}

function completedWorkspace(runtimeState: 'paused' | 'complete'): Workspace {
  const base = workspace()
  return {
    ...base,
    sprintEngineState: {
      ...base.sprintEngineState!,
      tasks: [
        { id: 'T1', title: 'Done task', role: 'developer', status: 'done' },
      ],
    },
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState,
      reason: runtimeState === 'paused' ? 'terminal_closed' : 'all_tasks_done',
      pendingSpawns: [],
      deliveredAgentNotificationEventKeys: [],
    },
  } as unknown as Workspace
}

// A finished run that was demoted to `paused` (e.g. by an end-of-run terminal
// close) must self-heal back to complete even when the projection bytes are
// unchanged — otherwise it stays stuck because `runner_complete` only fires on
// changed polls.
async function testUnchangedHealsStuckCompletedRun(): Promise<void> {
  const applied: SprintEngineState[] = []
  const automationEvents: SprintEngineAutomationEvent[] = []
  const tokens = new Map([['workspace-1', 'tok-1']])
  const result = await refreshSprintEngineWorkspaceProjection({
    workspace: completedWorkspace('paused'),
    tokens,
    cause: 'supervisor',
    ports: portsFor({ token: 'tok-1', applied, automationEvents }),
  })

  assert.equal(result.status, 'unchanged')
  assert.equal(applied.length, 0)
  assert.deepEqual(automationEvents, [{ type: 'runner_complete', message: 'All tasks are complete.' }])
}

// An already-complete run must not re-fire the event on every unchanged poll —
// that would churn the store and re-render on each tick.
async function testUnchangedDoesNotRefireWhenAlreadyComplete(): Promise<void> {
  const applied: SprintEngineState[] = []
  const automationEvents: SprintEngineAutomationEvent[] = []
  const tokens = new Map([['workspace-1', 'tok-1']])
  const result = await refreshSprintEngineWorkspaceProjection({
    workspace: completedWorkspace('complete'),
    tokens,
    cause: 'supervisor',
    ports: portsFor({ token: 'tok-1', applied, automationEvents }),
  })

  assert.equal(result.status, 'unchanged')
  assert.equal(automationEvents.length, 0)
}

async function testChangedRefresh(): Promise<void> {
  const applied: SprintEngineState[] = []
  const result = await refreshSprintEngineWorkspaceProjection({
    workspace: workspace(),
    tokens: new Map(),
    cause: 'supervisor',
    ports: portsFor({ data: projection('in_progress'), applied }),
  })

  assert.equal(result.status, 'changed')
  assert.equal(applied.length, 1)
  assert.equal(applied[0].tasks[0].status, 'in_progress')
}

async function testColdStateRefreshWithContext(): Promise<void> {
  const applied: SprintEngineState[] = []
  const coldWorkspace = { ...workspace(), sprintEngineState: null } as Workspace
  const result = await refreshSprintEngineWorkspaceProjection({
    workspace: coldWorkspace,
    tokens: new Map(),
    cause: 'supervisor',
    ports: portsFor({ data: projection('in_progress'), applied }),
  })

  assert.equal(result.status, 'changed')
  assert.equal(applied.length, 1)
  assert.equal(applied[0].tasks[0].status, 'in_progress')
}

async function testUnchangedDedupe(): Promise<void> {
  const applied: SprintEngineState[] = []
  const data = projection('done')
  // The reader is told our last-seen token; a matching token short-circuits to
  // an `unchanged` result with no read/parse and no store mutation.
  const tokens = new Map([['workspace-1', 'tok-1']])
  const result = await refreshSprintEngineWorkspaceProjection({
    workspace: workspace(),
    tokens,
    cause: 'auto-run',
    ports: portsFor({ data, token: 'tok-1', applied }),
  })

  assert.equal(result.status, 'unchanged')
  assert.equal(applied.length, 0)
}

async function testForcedRefreshUpdatesToken(): Promise<void> {
  const applied: SprintEngineState[] = []
  const forcedData = projection('done')
  // A stale token would normally dedupe, but force bypasses it (no knownToken is
  // sent), so the reader returns full data and we record its fresh token.
  const tokens = new Map([['workspace-1', 'stale-tok']])
  const result = await refreshSprintEngineWorkspaceProjection({
    workspace: workspace(),
    tokens,
    cause: 'manual',
    force: true,
    ports: portsFor({ data: forcedData, token: 'fresh-tok', applied }),
  })

  assert.equal(result.status, 'changed')
  assert.equal(applied.length, 1)
  assert.equal(applied[0].tasks[0].status, 'done')
  assert.equal(tokens.get('workspace-1'), 'fresh-tok')
}

async function testChangedRefreshRecordsToken(): Promise<void> {
  // A changed read must persist the reader's token so the next poll can dedupe.
  const applied: SprintEngineState[] = []
  const tokens = new Map<string, string>()
  const result = await refreshSprintEngineWorkspaceProjection({
    workspace: workspace(),
    tokens,
    cause: 'supervisor',
    ports: portsFor({ data: projection('in_progress'), token: 'tok-99', applied }),
  })

  assert.equal(result.status, 'changed')
  assert.equal(tokens.get('workspace-1'), 'tok-99')
}

async function testReadError(): Promise<void> {
  const applied: SprintEngineState[] = []
  const diagnostics: string[] = []
  const result = await refreshSprintEngineWorkspaceProjection({
    workspace: workspace(),
    tokens: new Map(),
    cause: 'supervisor',
    ports: portsFor({ ok: false, message: 'boom', applied, diagnostics }),
  })

  assert.deepEqual(result, { status: 'error', message: 'boom' })
  assert.equal(applied.length, 0)
  assert.deepEqual(diagnostics, ['boom'])
}

async function testMissingContextSkip(): Promise<void> {
  const result = await refreshSprintEngineWorkspaceProjection({
    workspace: { ...workspace(), sprintEngineContext: null } as Workspace,
    tokens: new Map(),
    cause: 'manual',
    ports: portsFor({ applied: [] }),
  })

  assert.deepEqual(result, { status: 'skipped', reason: 'missing-context' })
}

async function testCompletedProjectionRefreshesMatchingBacklogLink(): Promise<void> {
  const applied: SprintEngineState[] = []
  const automationEvents: SprintEngineAutomationEvent[] = []
  const backlogMutations: Array<{
    workspaceRoot: string
    relativePath: string
    link: BacklogItemLinkPayload
    status?: 'completed'
  }> = []
  const result = await refreshSprintEngineWorkspaceProjection({
    workspace: workspace(),
    tokens: new Map(),
    cause: 'supervisor',
    ports: portsFor({
      data: projection('done', '2026-06-07T15:00:00Z', 'complete'),
      applied,
      automationEvents,
      backlogMutations,
      backlogStore: {
        schemaVersion: 1,
        items: [{
          id: 'backlog_refresh',
          source: { type: 'file', relativePath: 'backlog/refresh.md' },
          status: 'in_progress',
          metadata: {},
          links: [{
            id: 'sprint-engine:unified-refresh',
            moduleId: 'sprint-engine',
            type: 'execution',
            label: 'Sprint Engine run',
            target: {
              kind: 'sprintengine.run',
              id: 'unified-refresh',
              path: '.multi-code/sprintengine/unified-refresh/run.yaml',
            },
            status: 'active',
          }],
        }, {
          id: 'other',
          source: { type: 'file', relativePath: 'backlog/other.md' },
          status: 'in_progress',
          metadata: {},
          links: [{
            id: 'sprint-engine:other',
            moduleId: 'sprint-engine',
            type: 'execution',
            label: 'Sprint Engine run',
            target: {
              kind: 'sprintengine.run',
              id: 'other',
              path: '.multi-code/sprintengine/other/run.yaml',
            },
            status: 'active',
          }],
        }],
      },
    }),
  })

  assert.equal(result.status, 'changed')
  assert.deepEqual(automationEvents, [{ type: 'runner_complete', message: 'All tasks are complete.' }])
  assert.equal(backlogMutations.length, 1)
  assert.equal(backlogMutations[0].workspaceRoot, '/tmp/workspace')
  assert.equal(backlogMutations[0].relativePath, 'backlog/refresh.md')
  assert.equal(backlogMutations[0].status, 'completed')
  assert.equal(backlogMutations[0].link.status, 'completed')
}

async function testNonterminalProjectionDoesNotCompleteBacklogLink(): Promise<void> {
  const applied: SprintEngineState[] = []
  const backlogMutations: Array<{
    workspaceRoot: string
    relativePath: string
    link: BacklogItemLinkPayload
    status?: 'completed'
  }> = []
  await refreshSprintEngineWorkspaceProjection({
    workspace: workspace(),
    tokens: new Map(),
    cause: 'supervisor',
    ports: portsFor({
      data: projection('in_progress'),
      applied,
      backlogMutations,
      backlogStore: {
        schemaVersion: 1,
        items: [{
          id: 'backlog_refresh',
          source: { type: 'file', relativePath: 'backlog/refresh.md' },
          status: 'in_progress',
          metadata: {},
          links: [{
            id: 'sprint-engine:unified-refresh',
            moduleId: 'sprint-engine',
            type: 'execution',
            label: 'Sprint Engine run',
            target: {
              kind: 'sprintengine.run',
              id: 'unified-refresh',
              path: '.multi-code/sprintengine/unified-refresh/run.yaml',
            },
            status: 'active',
          }],
        }],
      },
    }),
  })

  assert.equal(backlogMutations.length, 0, 'nonterminal projections do not mark Backlog items completed')
}

async function testBacklogRefreshFailureWarnsAndLeavesItemUnchanged(): Promise<void> {
  const applied: SprintEngineState[] = []
  const diagnostics: string[] = []
  const backlogMutations: Array<{
    workspaceRoot: string
    relativePath: string
    link: BacklogItemLinkPayload
    status?: 'completed'
  }> = []
  await refreshSprintEngineWorkspaceProjection({
    workspace: workspace(),
    tokens: new Map(),
    cause: 'supervisor',
    ports: portsFor({
      data: projection('done'),
      applied,
      diagnostics,
      backlogMutations,
      backlogReadResult: { ok: false, message: 'Backlog metadata unreadable' },
    }),
  })

  assert.deepEqual(diagnostics, ['Backlog metadata unreadable'])
  assert.equal(backlogMutations.length, 0)
}

function testCanStopPollingCompletedProjection(): void {
  const state = completedWorkspace('complete').sprintEngineState!
  // Terminal + hydrated → safe to stop polling.
  assert.equal(
    canStopPollingCompletedSprintEngineProjection({
      sprintEngineAutoState: { runtimeState: 'complete' },
      sprintEngineState: state,
    }),
    true,
  )
  // Complete but not yet hydrated (cold run after restart) → keep polling so the
  // first read can populate the board/run summary.
  assert.equal(
    canStopPollingCompletedSprintEngineProjection({
      sprintEngineAutoState: { runtimeState: 'complete' },
      sprintEngineState: null,
    }),
    false,
  )
  // Finished but still stuck in `paused` → keep polling so the self-heal can
  // promote it to `complete` first.
  assert.equal(
    canStopPollingCompletedSprintEngineProjection({
      sprintEngineAutoState: { runtimeState: 'paused' },
      sprintEngineState: state,
    }),
    false,
  )
  // Active run → keep polling.
  assert.equal(
    canStopPollingCompletedSprintEngineProjection({
      sprintEngineAutoState: { runtimeState: 'running' },
      sprintEngineState: state,
    }),
    false,
  )
  // No automation lifecycle yet → keep polling.
  assert.equal(
    canStopPollingCompletedSprintEngineProjection({
      sprintEngineAutoState: null,
      sprintEngineState: state,
    }),
    false,
  )
}

testCanStopPollingCompletedProjection()
await testUnchangedHealsStuckCompletedRun()
await testUnchangedDoesNotRefireWhenAlreadyComplete()
await testChangedRefresh()
await testColdStateRefreshWithContext()
await testUnchangedDedupe()
await testForcedRefreshUpdatesToken()
await testChangedRefreshRecordsToken()
await testReadError()
await testMissingContextSkip()
await testCompletedProjectionRefreshesMatchingBacklogLink()
await testNonterminalProjectionDoesNotCompleteBacklogLink()
await testBacklogRefreshFailureWarnsAndLeavesItemUnchanged()

console.log('sprintengine projection refresh tests passed')
