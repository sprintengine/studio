import assert from 'node:assert/strict'
import type {
  BacklogItemLinkPayload,
  BacklogMutationResult,
  BacklogObjectStorePayload,
  BacklogReadResult,
} from '../../../shared/electron-api'
import type { BacklogItemStatus } from './backlog'
import type {
  SprintEngineAutoState,
  SprintEngineAutomationEvent,
  SprintEngineAutomationRuntimeState,
  SprintEngineState,
  Workspace,
} from '../types/workspace'
import {
  canStopPollingCompletedSprintEngineProjection,
  enterSprintEngineDormancy,
  refreshSprintEngineWorkspaceProjection,
  type SprintEngineDormancyPorts,
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
  permanent?: boolean
  token?: string
  applied: SprintEngineState[]
  backlogStore?: BacklogObjectStorePayload
  backlogReadResult?: BacklogReadResult
  // Widened past `completed` with the port itself (MC-2017): the epic-child
  // fan-out also writes `in_progress` and the pre-sprint status on cancel.
  backlogMutations?: Array<{
    workspaceRoot: string
    relativePath: string
    link: BacklogItemLinkPayload
    status?: BacklogItemStatus
  }>
  backlogMutationResult?: BacklogMutationResult
  diagnostics?: string[]
  automationEvents?: SprintEngineAutomationEvent[]
  teardownCalls?: string[]
  teardownError?: boolean
  markerCalls?: Array<{ workspaceId: string; at: number | undefined }>
}): SprintEngineProjectionRefreshPorts {
  return {
    readSprintEngineProjection: async (_statePath, knownToken) => {
      if (input.ok === false) {
        return {
          ok: false,
          message: input.message ?? 'projection read failed',
          ...(input.permanent !== undefined ? { permanent: input.permanent } : {}),
        }
      }
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
    tearDownCompletedRunAgents: async (workspaceId) => {
      input.teardownCalls?.push(workspaceId)
      if (input.teardownError) throw new Error('teardown failed')
    },
    setCompletionTeardownAt: (workspaceId, at) => {
      input.markerCalls?.push({ workspaceId, at })
    },
    now: () => 1000,
  }
}

// The reconcile fires teardown without awaiting it; drain the microtask queue so
// its post-teardown marker write has run before asserting.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

function autoState(
  runtimeState?: SprintEngineAutomationRuntimeState,
  completionTeardownAt?: number,
): SprintEngineAutoState {
  return {
    desiredMode: 'run_agents',
    runtimeState,
    cliPermissionPreset: 'default',
    maxConcurrentAgents: 1,
    deliveredAgentNotificationEventKeys: [],
    completionTeardownAt,
  }
}

function completedWorkspace(
  runtimeState: 'paused' | 'complete',
  options?: { completionTeardownAt?: number },
): Workspace {
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
        deliveredAgentNotificationEventKeys: [],
      completionTeardownAt: options?.completionTeardownAt,
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

  assert.deepEqual(result, { status: 'error', message: 'boom', permanent: false })
  assert.equal(applied.length, 0)
  assert.deepEqual(diagnostics, ['boom'])
}

async function testPermanentReadErrorSkipsBackgroundDiagnostic(): Promise<void> {
  // A permanent failure (run directory gone, unreadable store) on a background
  // cause must not notify: the poller gives up on the workspace, and dozens of
  // stale workspaces would otherwise each warn on every launch.
  const diagnostics: string[] = []
  const result = await refreshSprintEngineWorkspaceProjection({
    workspace: workspace(),
    tokens: new Map(),
    cause: 'supervisor',
    ports: portsFor({ ok: false, message: 'run data is missing', permanent: true, applied: [], diagnostics }),
  })

  assert.deepEqual(result, { status: 'error', message: 'run data is missing', permanent: true })
  assert.deepEqual(diagnostics, [])
}

async function testPermanentReadErrorStillNotifiesManualRefresh(): Promise<void> {
  // The user asked for this workspace's data: surface why nothing loaded.
  const diagnostics: string[] = []
  const result = await refreshSprintEngineWorkspaceProjection({
    workspace: workspace(),
    tokens: new Map(),
    cause: 'manual',
    ports: portsFor({ ok: false, message: 'run data is missing', permanent: true, applied: [], diagnostics }),
  })

  assert.deepEqual(result, { status: 'error', message: 'run data is missing', permanent: true })
  assert.deepEqual(diagnostics, ['run data is missing'])
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

// MC-1612: a run spanning projects opens one pull request per project, so the item
// that started it carries one link each. Attaching only the primary's would leave the
// other project's pull request unreachable from the work that asked for it.
async function testCompletedMultiProjectRunLinksEveryPullRequest(): Promise<void> {
  const backlogMutations: Array<{
    workspaceRoot: string
    relativePath: string
    link: BacklogItemLinkPayload
    status?: 'completed'
  }> = []
  const completedProjection = projection('done', '2026-06-07T15:00:00Z', 'complete') as {
    run: Record<string, unknown>
  }
  completedProjection.run.vcs = {
    mode: 'run_worktree',
    worktreePath: '.multi-code/sprintengine/unified-refresh/worktree',
    branchName: 'sprintengine/unified-refresh',
    pullRequestUrl: 'https://github.com/acme/multicode/pull/1',
    pullRequestState: 'open',
    repos: [
      {
        id: 'primary',
        root: '.',
        worktreePath: '.multi-code/sprintengine/unified-refresh/worktree',
        branchName: 'sprintengine/unified-refresh',
        pullRequestUrl: 'https://github.com/acme/multicode/pull/1',
        pullRequestState: 'open',
      },
      {
        id: 'mobile',
        root: '../multicode-mobile',
        worktreePath: '.multi-code/sprintengine/unified-refresh/worktree-mobile',
        branchName: 'sprintengine/unified-refresh',
        pullRequestUrl: 'https://github.com/acme/multicode-mobile/pull/9',
        pullRequestState: 'open',
      },
    ],
  }

  const result = await refreshSprintEngineWorkspaceProjection({
    workspace: workspace(),
    tokens: new Map(),
    cause: 'supervisor',
    ports: portsFor({
      data: completedProjection,
      applied: [],
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

  assert.equal(result.status, 'changed')
  // The run link, then one link per project — each naming its project, because with
  // two of them "Pull request" alone says nothing about which is which.
  assert.deepEqual(
    backlogMutations.map((mutation) => [mutation.link.id, mutation.link.label, mutation.link.target.url]),
    [
      ['sprint-engine:unified-refresh', 'Sprint Engine run', undefined],
      ['sprint-engine:pull-request', 'Pull request (workspace)', 'https://github.com/acme/multicode/pull/1'],
      ['sprint-engine:pull-request:mobile', 'Pull request (multicode-mobile)', 'https://github.com/acme/multicode-mobile/pull/9'],
    ],
  )
  // `external` is lifecycle-neutral: the PR links never move the item's status.
  assert.deepEqual(
    backlogMutations.slice(1).map((mutation) => [mutation.link.type, mutation.status]),
    [['external', undefined], ['external', undefined]],
  )
}

// The single-project control for the above: one project, one link — the same id and
// the same unlabeled "Pull request" it carried before runs could span projects. A
// project name in the label would be noise with nothing to tell it apart from.
async function testCompletedSingleProjectRunLinksOneUnlabeledPullRequest(): Promise<void> {
  const backlogMutations: Array<{
    workspaceRoot: string
    relativePath: string
    link: BacklogItemLinkPayload
    status?: 'completed'
  }> = []
  const completedProjection = projection('done', '2026-06-07T15:00:00Z', 'complete') as {
    run: Record<string, unknown>
  }
  completedProjection.run.vcs = {
    mode: 'run_worktree',
    worktreePath: '.multi-code/sprintengine/unified-refresh/worktree',
    branchName: 'sprintengine/unified-refresh',
    pullRequestUrl: 'https://github.com/acme/multicode/pull/1',
    pullRequestState: 'open',
    repos: [{
      id: 'primary',
      root: '.',
      worktreePath: '.multi-code/sprintengine/unified-refresh/worktree',
      branchName: 'sprintengine/unified-refresh',
      pullRequestUrl: 'https://github.com/acme/multicode/pull/1',
      pullRequestState: 'open',
    }],
  }

  await refreshSprintEngineWorkspaceProjection({
    workspace: workspace(),
    tokens: new Map(),
    cause: 'supervisor',
    ports: portsFor({
      data: completedProjection,
      applied: [],
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

  assert.deepEqual(
    backlogMutations.map((mutation) => [mutation.link.id, mutation.link.label, mutation.link.target.url]),
    [
      ['sprint-engine:unified-refresh', 'Sprint Engine run', undefined],
      ['sprint-engine:pull-request', 'Pull request', 'https://github.com/acme/multicode/pull/1'],
    ],
  )
}

// Cancellation (MC-1604b) recolors the run-link chip to `canceled` but — unlike
// completion — never drives the Backlog item status: a canceled sprint is a
// decision, not a finish, so the item stays whatever the user left it.
async function testCanceledProjectionRecolorsBacklogLinkWithoutDrivingItem(): Promise<void> {
  const applied: SprintEngineState[] = []
  const automationEvents: SprintEngineAutomationEvent[] = []
  const backlogMutations: Array<{
    workspaceRoot: string
    relativePath: string
    link: BacklogItemLinkPayload
    status?: 'completed'
  }> = []
  const result = await refreshSprintEngineWorkspaceProjection({
    // Non-dormant at entry (no autoState) so the full lifecycle path runs.
    workspace: workspace(),
    tokens: new Map(),
    cause: 'supervisor',
    ports: portsFor({
      data: projection('canceled', '2026-06-07T15:00:00Z', 'canceled'),
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
        }],
      },
    }),
  })

  assert.equal(result.status, 'changed')
  assert.deepEqual(automationEvents, [], 'cancellation is parked by the runtime, not by the projection reconcile')
  assert.equal(backlogMutations.length, 1)
  assert.equal(backlogMutations[0].relativePath, 'backlog/refresh.md')
  assert.equal(backlogMutations[0].link.status, 'canceled', 'the chip recolors to canceled')
  assert.equal(backlogMutations[0].status, undefined, 'cancellation never drives the item status')
}

// A canceled run reaches its terminal `canceled` automation state via the
// runtime broadcast, so it is already dormant when the first post-cancel refresh
// reads the canceled projection — there is no non-dormant completing tick to
// write the chip. So the chip recolor must fire on a ROUTINE (non-forced) dormant
// tick too (T6), not only on a forced refresh; otherwise the chip stays Active
// forever. It stays otherwise display-only (no teardown), and self-skips once the
// chip already matches.
async function testDormantCanceledRefreshRecolorsLinkOnRoutineTick(): Promise<void> {
  const dormantCanceled = {
    ...workspace(),
    sprintEngineAutoState: autoState('canceled', 500),
  } as unknown as Workspace
  const activeLinkStore = {
    schemaVersion: 1 as const,
    items: [{
      id: 'backlog_refresh',
      source: { type: 'file' as const, relativePath: 'backlog/refresh.md' },
      status: 'in_progress' as const,
      metadata: {},
      links: [{
        id: 'sprint-engine:unified-refresh',
        moduleId: 'sprint-engine',
        type: 'execution' as const,
        label: 'Sprint Engine run',
        target: {
          kind: 'sprintengine.run',
          id: 'unified-refresh',
          path: '.multi-code/sprintengine/unified-refresh/run.yaml',
        },
        status: 'active' as const,
      }],
    }],
  }

  // Routine (non-forced) dormant poll: the chip recolors to canceled, and the
  // refresh stays otherwise display-only (no agent teardown).
  const routineMutations: Array<{ workspaceRoot: string; relativePath: string; link: BacklogItemLinkPayload; status?: 'completed' }> = []
  const routineTeardown: string[] = []
  await refreshSprintEngineWorkspaceProjection({
    workspace: dormantCanceled,
    tokens: new Map(),
    cause: 'supervisor',
    ports: portsFor({
      data: projection('canceled', '2026-06-07T15:00:00Z', 'canceled'),
      applied: [],
      backlogMutations: routineMutations,
      teardownCalls: routineTeardown,
      backlogStore: activeLinkStore,
    }),
  })
  assert.equal(routineMutations.length, 1, 'a routine dormant poll recolors a canceled run link')
  assert.equal(routineMutations[0].link.status, 'canceled')
  assert.equal(routineMutations[0].status, undefined, 'cancellation never drives the item status')
  assert.deepEqual(routineTeardown, [], 'the routine canceled refresh stays otherwise display-only (no teardown)')

  // Idempotent: once the chip already reads canceled, a routine poll self-skips
  // the link write (the refresh reads the store fresh each tick).
  const settledLinkStore = {
    ...activeLinkStore,
    items: [{
      ...activeLinkStore.items[0],
      links: [{ ...activeLinkStore.items[0].links[0], status: 'canceled' as const }],
    }],
  }
  const settledMutations: Array<{ workspaceRoot: string; relativePath: string; link: BacklogItemLinkPayload; status?: 'completed' }> = []
  await refreshSprintEngineWorkspaceProjection({
    workspace: dormantCanceled,
    tokens: new Map(),
    cause: 'supervisor',
    ports: portsFor({
      data: projection('canceled', '2026-06-07T15:00:00Z', 'canceled'),
      applied: [],
      backlogMutations: settledMutations,
      backlogStore: settledLinkStore,
    }),
  })
  assert.equal(settledMutations.length, 0, 'a routine poll self-skips once the chip already reads canceled')
}

// An epic launched as a sprint carries the run's execution link, but its status
// derives up from its children — a finished run must complete the epic's link chip
// without driving the epic to completed while children are still open. The leaf in
// the same store still completes, so only the epic is spared.
async function testCompletedProjectionSparesEpicStatus(): Promise<void> {
  const applied: SprintEngineState[] = []
  const backlogMutations: Array<{
    workspaceRoot: string
    relativePath: string
    link: BacklogItemLinkPayload
    status?: 'completed'
  }> = []
  const runLink = (id: string): BacklogItemLinkPayload => ({
    id: `sprint-engine:${id}`,
    moduleId: 'sprint-engine',
    type: 'execution',
    label: 'Sprint Engine run',
    target: { kind: 'sprintengine.run', id: 'unified-refresh', path: '.multi-code/sprintengine/unified-refresh/run.yaml' },
    status: 'active',
  })
  await refreshSprintEngineWorkspaceProjection({
    workspace: workspace(),
    tokens: new Map(),
    cause: 'supervisor',
    ports: portsFor({
      data: projection('done', '2026-06-07T15:00:00Z', 'complete'),
      applied,
      backlogMutations,
      backlogStore: {
        schemaVersion: 1,
        items: [
          {
            id: 'epic_relay',
            source: { type: 'file', relativePath: 'backlog/epics/relay.md' },
            metadata: {},
            links: [runLink('epic')],
          },
          {
            id: 'leaf_child',
            source: { type: 'file', relativePath: 'backlog/relay-child.md' },
            metadata: {},
            links: [runLink('child')],
          },
        ],
      },
    }),
  })

  const epicWrite = backlogMutations.find((mutation) => mutation.relativePath === 'backlog/epics/relay.md')
  const leafWrite = backlogMutations.find((mutation) => mutation.relativePath === 'backlog/relay-child.md')
  assert.ok(epicWrite, 'the epic run link is still reconciled to completed')
  assert.equal(epicWrite?.link.status, 'completed', 'the epic link chip reflects the finished run')
  assert.equal(epicWrite?.status, undefined, 'the finished run never drives the epic status to completed')
  assert.equal(leafWrite?.status, 'completed', 'a leaf item launched as a sprint still completes on the run finishing')
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

// A finished-but-not-yet-dormant run (tasks all done, lifecycle still `paused`
// after an end-of-run terminal close) transitions into dormancy through the
// reconcile: it fires `runner_complete` and tears down once, then records the
// marker. A run already dormant (`complete`) is display-only and covered
// separately — refresh never tears it down.
async function testFinishedPausedRunTransitionsAndTearsDown(): Promise<void> {
  const teardownCalls: string[] = []
  const markerCalls: Array<{ workspaceId: string; at: number | undefined }> = []
  const automationEvents: SprintEngineAutomationEvent[] = []
  const tokens = new Map([['workspace-1', 'tok-1']])
  await refreshSprintEngineWorkspaceProjection({
    workspace: completedWorkspace('paused'),
    tokens,
    cause: 'supervisor',
    ports: portsFor({ applied: [], teardownCalls, markerCalls, automationEvents }),
  })
  await flushMicrotasks()
  assert.deepEqual(automationEvents, [{ type: 'runner_complete', message: 'All tasks are complete.' }])
  assert.deepEqual(teardownCalls, ['workspace-1'], 'a not-yet-dormant finished run tears down once')
  assert.deepEqual(
    markerCalls,
    [{ workspaceId: 'workspace-1', at: 1000 }],
    'marker records completion teardown after it resolves',
  )
}

// A dormant workspace whose completion teardown already ran (marker SET) is
// DISPLAY-only: a changed read still hydrates the board via setSprintEngineState,
// but no lifecycle port fires — no reconcile event, no teardown, no marker write,
// no backlog-link write. This is what keeps a deliberately re-opened terminal
// (its teardown long done) from being torn down again and stops every idle
// activity source on a finished run. The marker-unset heal is a separate case
// (testDormantWorkspaceRefreshHealsInterruptedTeardown).
async function testDormantWorkspaceRefreshIsDisplayOnly(): Promise<void> {
  const applied: SprintEngineState[] = []
  const automationEvents: SprintEngineAutomationEvent[] = []
  const teardownCalls: string[] = []
  const markerCalls: Array<{ workspaceId: string; at: number | undefined }> = []
  const backlogMutations: Array<{
    workspaceRoot: string
    relativePath: string
    link: BacklogItemLinkPayload
    status?: 'completed'
  }> = []
  const result = await refreshSprintEngineWorkspaceProjection({
    // Dormant (runtimeState complete) with the marker SET: teardown already ran,
    // so an empty teardown log proves the display-only skip, not a pending heal.
    workspace: completedWorkspace('complete', { completionTeardownAt: 500 }),
    tokens: new Map(),
    cause: 'manual',
    force: true,
    ports: portsFor({
      data: projection('done', '2026-06-07T15:00:00Z', 'complete'),
      applied,
      automationEvents,
      teardownCalls,
      markerCalls,
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
  await flushMicrotasks()
  assert.equal(result.status, 'changed')
  assert.equal(applied.length, 1, 'display state is still hydrated on a dormant run')
  assert.deepEqual(automationEvents, [], 'no reconcile lifecycle event on a dormant run')
  assert.deepEqual(teardownCalls, [], 'no teardown on a dormant run')
  assert.deepEqual(markerCalls, [], 'no marker write on a dormant run')
  assert.equal(backlogMutations.length, 0, 'no backlog-link write on a dormant run')
}

// An unchanged poll on a fully-dormant run (marker set) also skips lifecycle: the
// self-heal reconcile (which the same path runs for a not-yet-dormant finished
// run) must not fire once the run is already dormant and torn down.
async function testDormantWorkspaceUnchangedRefreshSkipsLifecycle(): Promise<void> {
  const automationEvents: SprintEngineAutomationEvent[] = []
  const teardownCalls: string[] = []
  const tokens = new Map([['workspace-1', 'tok-1']])
  const result = await refreshSprintEngineWorkspaceProjection({
    workspace: completedWorkspace('complete', { completionTeardownAt: 500 }),
    tokens,
    cause: 'supervisor',
    ports: portsFor({ token: 'tok-1', applied: [], automationEvents, teardownCalls }),
  })
  await flushMicrotasks()
  assert.equal(result.status, 'unchanged')
  assert.deepEqual(automationEvents, [], 'no self-heal event on an already-dormant run')
  assert.deepEqual(teardownCalls, [], 'no teardown on an already-dormant run')
}

// T9: an app quit during the fire-and-forget completion teardown persists
// `runtimeState:'complete'` with the marker UNSET. On reload the run is already
// dormant, so the refresh takes its display-only branch — but that branch must
// still complete the pending teardown ONCE and set the marker, while preserving
// the display-only contract: no reconcile lifecycle event (the run is already
// `complete`, so the runtime guard fires none) and no backlog-link write. Both a
// changed read and an unchanged poll heal it.
async function testDormantWorkspaceRefreshHealsInterruptedTeardown(): Promise<void> {
  const automationEvents: SprintEngineAutomationEvent[] = []
  const teardownCalls: string[] = []
  const markerCalls: Array<{ workspaceId: string; at: number | undefined }> = []
  const backlogMutations: Array<{
    workspaceRoot: string
    relativePath: string
    link: BacklogItemLinkPayload
    status?: 'completed'
  }> = []
  const result = await refreshSprintEngineWorkspaceProjection({
    // Dormant (complete) with the marker UNSET — the interrupted-teardown state.
    workspace: completedWorkspace('complete'),
    tokens: new Map(),
    cause: 'manual',
    force: true,
    ports: portsFor({
      data: projection('done', '2026-06-07T15:00:00Z', 'complete'),
      applied: [],
      automationEvents,
      teardownCalls,
      markerCalls,
      backlogMutations,
    }),
  })
  await flushMicrotasks()
  assert.equal(result.status, 'changed')
  assert.deepEqual(automationEvents, [], 'no lifecycle event re-fired on an already-complete run')
  assert.deepEqual(teardownCalls, ['workspace-1'], 'the interrupted teardown runs exactly once')
  assert.deepEqual(
    markerCalls,
    [{ workspaceId: 'workspace-1', at: 1000 }],
    'the completion-teardown marker is healed once',
  )
  assert.equal(backlogMutations.length, 0, 'display-only contract intact: no backlog-link write')
}

// enterSprintEngineDormancy is the centralized completion transition. Driven the
// way the store drives it — applied events flip runtimeState, the marker setter
// records completionTeardownAt, and each call re-reads that live state — it fires
// runner_complete at most once and tears down exactly once across repeats.
async function testEnterDormancyIsIdempotentAcrossRepeats(): Promise<void> {
  let runtimeState: SprintEngineAutomationRuntimeState = 'running'
  let completionTeardownAt: number | undefined
  const teardownCalls: string[] = []
  const events: SprintEngineAutomationEvent[] = []
  const ports: SprintEngineDormancyPorts = {
    applySprintEngineAutomationEvent: (_workspaceId, event) => {
      events.push(event)
      if (event.type === 'runner_complete') runtimeState = 'complete'
    },
    tearDownCompletedRunAgents: async (workspaceId) => { teardownCalls.push(workspaceId) },
    setCompletionTeardownAt: (_workspaceId, at) => { completionTeardownAt = at },
    now: () => 1000,
  }
  for (let i = 0; i < 3; i += 1) {
    enterSprintEngineDormancy(
      { id: 'workspace-1', sprintEngineAutoState: autoState(runtimeState, completionTeardownAt) } as Workspace,
      ports,
    )
    await flushMicrotasks()
  }
  assert.deepEqual(
    events,
    [{ type: 'runner_complete', message: 'All tasks are complete.' }],
    'runner_complete fires at most once',
  )
  assert.deepEqual(teardownCalls, ['workspace-1'], 'teardown runs exactly once across repeat invocations')
  assert.equal(completionTeardownAt, 1000, 'marker set after teardown resolves')
}

// The marker is one-shot: a completed run that already tore down must NOT fire
// again, even though roster agent records get recreated by projection reads and
// the user may have re-opened a role's panel (board resume). A dormant run is
// display-only, so refresh short-circuits before lifecycle regardless.
async function testCompletedRunWithMarkerSkipsTeardown(): Promise<void> {
  const teardownCalls: string[] = []
  const markerCalls: Array<{ workspaceId: string; at: number | undefined }> = []
  const tokens = new Map([['workspace-1', 'tok-1']])
  const ws = {
    ...completedWorkspace('complete', { completionTeardownAt: 500 }),
    agents: {
      architect: { id: 'architect', name: 'Architect', kind: 'sprintengine' },
    },
  } as unknown as Workspace
  await refreshSprintEngineWorkspaceProjection({
    workspace: ws,
    tokens,
    cause: 'supervisor',
    ports: portsFor({ applied: [], teardownCalls, markerCalls }),
  })
  await flushMicrotasks()
  assert.deepEqual(teardownCalls, [], 'no re-teardown after the marker is set')
  assert.deepEqual(markerCalls, [], 'marker untouched on an already-torn-down run')
}

// A formerly-complete run that gained open tasks again (scope expansion, sprint
// chaining) clears the marker so the NEXT completion tears down again.
async function testReopenedRunClearsMarker(): Promise<void> {
  const teardownCalls: string[] = []
  const markerCalls: Array<{ workspaceId: string; at: number | undefined }> = []
  const ws = workspace()
  ;(ws as { sprintEngineAutoState?: SprintEngineAutoState }).sprintEngineAutoState =
    autoState('running', 500)
  ;(ws.sprintEngineState as SprintEngineState).tasks = [
    { id: 'T1', title: 'New task', role: 'developer', status: 'in_progress' },
  ] as SprintEngineState['tasks']
  const tokens = new Map([['workspace-1', 'tok-1']])
  await refreshSprintEngineWorkspaceProjection({
    workspace: ws,
    tokens,
    cause: 'supervisor',
    ports: portsFor({ applied: [], teardownCalls, markerCalls }),
  })
  await flushMicrotasks()
  assert.deepEqual(teardownCalls, [], 'no teardown while tasks are open')
  assert.deepEqual(
    markerCalls,
    [{ workspaceId: 'workspace-1', at: undefined }],
    're-opened tasks re-arm the one-shot teardown',
  )
}

// A failing teardown on the completion transition (a not-yet-dormant finished
// run) leaves the marker unset so the next poll retries, and must not fail the
// refresh itself.
async function testTeardownFailureLeavesMarkerUnset(): Promise<void> {
  const teardownCalls: string[] = []
  const markerCalls: Array<{ workspaceId: string; at: number | undefined }> = []
  const tokens = new Map([['workspace-1', 'tok-1']])
  const result = await refreshSprintEngineWorkspaceProjection({
    workspace: completedWorkspace('paused'),
    tokens,
    cause: 'supervisor',
    ports: portsFor({ applied: [], teardownCalls, teardownError: true, markerCalls }),
  })
  await flushMicrotasks()
  assert.equal(result.status, 'unchanged', 'teardown failure does not fail the refresh')
  assert.deepEqual(teardownCalls, ['workspace-1'])
  assert.deepEqual(markerCalls, [], 'failed teardown leaves the marker unset for a retry')
}

// ── MC-2017: a child item moves with its task, and lands with the sprint.
//
// One epic, three children, one task each. The fixtures below vary only what the
// run has done, so each test reads as the acceptance criterion it proves.

const CHILD_PATHS = ['backlog/child-a.md', 'backlog/child-b.md', 'backlog/child-c.md']

function childFanoutProjection(input: {
  taskStatuses: [string, string, string]
  runStatus?: string
  pullRequestState?: 'open' | 'merged'
}): unknown {
  const updatedAt = '2026-07-30T15:00:00Z'
  return {
    ok: true,
    projectionVersion: 1,
    source: 'folder_store',
    generatedAt: updatedAt,
    updatedAt,
    run: {
      id: 'unified-refresh',
      name: 'Unified Refresh',
      goal: 'Deliver the epic',
      status: input.runStatus ?? 'executing',
      rosterConfigured: true,
      updatedAt,
      ...(input.pullRequestState
        ? {
          vcs: {
            mode: 'run_worktree',
            worktreePath: '/tmp/worktree',
            branchName: 'sprint/unified-refresh',
            lastCommitSha: 'abc123',
            pullRequestUrl: 'https://example.test/pr/1',
            pullRequestState: input.pullRequestState,
          },
        }
        : {}),
    },
    roster: {},
    tasks: input.taskStatuses.map((status, index) => ({
      id: `T${index + 1}`,
      title: `Deliver ${CHILD_PATHS[index]}`,
      role: 'developer',
      status,
      folderStatus: status,
      dependsOn: [],
      activity: [],
      backlogRef: { projectRelativePath: CHILD_PATHS[index] },
    })),
    artifacts: [],
    activity: [],
  }
}

// The store an epic launch leaves behind: the epic carrying the run link, and one
// `pending` child link per child remembering the status it held beforehand.
function childFanoutStore(childStatuses: [string, string, string]): BacklogObjectStorePayload {
  const runTarget = {
    kind: 'sprintengine.run',
    id: 'unified-refresh',
    path: '.multi-code/sprintengine/unified-refresh/run.yaml',
  }
  return {
    schemaVersion: 1,
    items: [
      {
        id: 'epic',
        source: { type: 'file', relativePath: 'backlog/epics/delivery.md' },
        metadata: {},
        links: [{
          id: 'sprint-engine:unified-refresh',
          moduleId: 'sprint-engine',
          type: 'execution',
          label: 'Sprint',
          target: runTarget,
          status: 'active',
        }],
      },
      ...CHILD_PATHS.map((relativePath, index) => ({
        id: `child-${index}`,
        source: { type: 'file' as const, relativePath },
        status: childStatuses[index] as BacklogObjectStorePayload['items'][number]['status'],
        metadata: {},
        links: [{
          id: 'sprint-engine:unified-refresh',
          moduleId: 'sprint-engine',
          type: 'execution' as const,
          label: 'Sprint',
          target: runTarget,
          status: 'pending' as const,
          priorStatus: 'ready' as const,
        }],
      })),
    ],
  }
}

type BacklogMutation = {
  workspaceRoot: string
  relativePath: string
  link: BacklogItemLinkPayload
  status?: BacklogItemStatus
}

async function runChildFanoutRefresh(input: {
  data: unknown
  store: BacklogObjectStorePayload
  workspace?: Workspace
}): Promise<BacklogMutation[]> {
  const backlogMutations: BacklogMutation[] = []
  await refreshSprintEngineWorkspaceProjection({
    workspace: input.workspace ?? workspace(),
    tokens: new Map(),
    cause: 'supervisor',
    force: true,
    ports: portsFor({
      data: input.data,
      applied: [],
      backlogMutations,
      backlogStore: input.store,
    }),
  })
  return backlogMutations
}

// Acceptance: starting a sprint from an epic moves each child to in_progress only
// as its OWN task claims — not all at once on run start.
async function testChildMovesOnlyWhenItsOwnTaskClaims(): Promise<void> {
  const mutations = await runChildFanoutRefresh({
    data: childFanoutProjection({ taskStatuses: ['in_progress', 'todo', 'todo'] }),
    store: childFanoutStore(['ready', 'ready', 'ready']),
  })

  assert.deepEqual(
    mutations.map((mutation) => [mutation.relativePath, mutation.link.status, mutation.status]),
    [
      // Every child binds to its task — the edge is what the Epic tab draws, and
      // an unclaimed child has one too. Only the CLAIMED child moves status.
      ['backlog/child-a.md', 'active', 'in_progress'],
      ['backlog/child-b.md', 'pending', undefined],
      ['backlog/child-c.md', 'pending', undefined],
    ],
    'only the claimed child moves; the two unclaimed ones stay exactly where they were',
  )
  assert.deepEqual(
    mutations.map((mutation) => mutation.link.target.taskId),
    ['T1', 'T2', 'T3'],
    'each child is bound to the task whose backlogRef names it',
  )

  // Re-running against the store the writes above produced is a no-op: the
  // binding is cached on the link, so a per-tick reconcile does not churn.
  const settled = childFanoutStore(['in_progress', 'ready', 'ready'])
  settled.items[1].links![0] = { ...mutations[0].link }
  settled.items[2].links![0] = { ...mutations[1].link }
  settled.items[3].links![0] = { ...mutations[2].link }
  const rerun = await runChildFanoutRefresh({
    data: childFanoutProjection({ taskStatuses: ['in_progress', 'todo', 'todo'] }),
    store: settled,
  })
  assert.deepEqual(rerun, [], 'a settled fan-out writes nothing on the next tick')
}

// Acceptance: a completed run whose pull request is unmerged leaves every child
// in_progress — there is no point completing an item that sits on a branch.
async function testCompletedButUnmergedRunLeavesChildrenInProgress(): Promise<void> {
  const mutations = await runChildFanoutRefresh({
    data: childFanoutProjection({
      taskStatuses: ['done', 'done', 'done'],
      runStatus: 'complete',
      pullRequestState: 'open',
    }),
    store: childFanoutStore(['in_progress', 'in_progress', 'in_progress']),
  })

  const childMutations = mutations.filter((mutation) => mutation.relativePath.startsWith('backlog/child'))
  assert.equal(childMutations.length, 3, 'every child link is rebound to its finished task')
  for (const mutation of childMutations) {
    assert.equal(mutation.link.status, 'active', 'a done task on an unmerged branch stays in flight')
    assert.equal(mutation.status, undefined, 'the child is already in_progress and is not moved')
  }
  // Acceptance: the epic's own file is never written a status.
  const epicMutation = mutations.find((mutation) => mutation.relativePath.includes('/epics/'))
  assert.equal(epicMutation?.status, undefined, 'the epic derives its status and is never written one')
}

// Acceptance: merging the pull request moves every done task's child to completed
// — observed from DORMANCY, because the merge happens long after the run finished.
async function testMergedRunCompletesEveryChildFromDormancy(): Promise<void> {
  const dormant = {
    ...workspace(),
    sprintEngineAutoState: autoState('complete', 500),
  } as unknown as Workspace
  const mutations = await runChildFanoutRefresh({
    workspace: dormant,
    data: childFanoutProjection({
      taskStatuses: ['done', 'done', 'done'],
      runStatus: 'complete',
      pullRequestState: 'merged',
    }),
    store: childFanoutStore(['in_progress', 'in_progress', 'in_progress']),
  })

  assert.deepEqual(
    mutations
      .filter((mutation) => mutation.relativePath.startsWith('backlog/child'))
      .map((mutation) => [mutation.relativePath, mutation.link.status, mutation.status]),
    [
      ['backlog/child-a.md', 'completed', 'completed'],
      ['backlog/child-b.md', 'completed', 'completed'],
      ['backlog/child-c.md', 'completed', 'completed'],
    ],
    'a landed sprint completes every child, even though nothing is polling the run any more',
  )
}

// Acceptance: cancelling a sprint returns every non-completed child to the status
// it held before the sprint started. A child that already landed stays completed.
async function testCanceledRunRestoresChildrenToTheirPreSprintStatus(): Promise<void> {
  const mutations = await runChildFanoutRefresh({
    data: childFanoutProjection({ taskStatuses: ['canceled', 'canceled', 'done'], runStatus: 'canceled' }),
    store: childFanoutStore(['in_progress', 'in_progress', 'completed']),
  })

  const childMutations = mutations.filter((mutation) => mutation.relativePath.startsWith('backlog/child'))
  assert.deepEqual(
    childMutations.map((mutation) => [mutation.relativePath, mutation.link.status, mutation.status]),
    [
      ['backlog/child-a.md', 'canceled', 'ready'],
      ['backlog/child-b.md', 'canceled', 'ready'],
      ['backlog/child-c.md', 'canceled', undefined],
    ],
    'the two in-flight children go back to `ready`; the finished one is not un-finished',
  )
  for (const mutation of childMutations) {
    assert.equal(
      mutation.link.priorStatus,
      undefined,
      'the restore target is consumed, so a later status cannot be reverted a second time',
    )
  }
}

function testCanStopPollingCompletedProjection(): void {
  const state = completedWorkspace('complete').sprintEngineState!
  // Terminal + hydrated + completion teardown already ran → safe to stop polling.
  assert.equal(
    canStopPollingCompletedSprintEngineProjection({
      sprintEngineAutoState: autoState('complete', 500),
      sprintEngineState: state,
    }),
    true,
  )
  // Terminal + hydrated but teardown has not run yet → keep polling so the
  // reconcile (which runs inside the poll) can perform it. Guards the race where
  // the auto-run supervisor flips runtimeState to `complete` before the poller
  // ever ran teardown. Deliberately independent of agent records: roster records
  // are recreated by projection reads and a user may re-open a role's panel
  // after completion — neither may restart polling.
  assert.equal(
    canStopPollingCompletedSprintEngineProjection({
      sprintEngineAutoState: autoState('complete'),
      sprintEngineState: state,
    }),
    false,
  )
  // Complete but not yet hydrated (cold run after restart) → keep polling so the
  // first read can populate the board/run summary.
  assert.equal(
    canStopPollingCompletedSprintEngineProjection({
      sprintEngineAutoState: autoState('complete', 500),
      sprintEngineState: null,
    }),
    false,
  )
  // Complete + torn down but the hydrated state is a STALE pre-completion
  // snapshot (the scheduler flips complete milliseconds before the engine
  // writes the final projection) → keep polling until the final write has been
  // read, or the board freezes at N-1/N with a phantom in-progress task.
  const staleState = {
    ...state,
    tasks: [
      { id: 'T1', title: 'Done task', role: 'developer', status: 'done' },
      { id: 'T2', title: 'Still running', role: 'developer', status: 'in_progress' },
    ],
  } as SprintEngineState
  assert.equal(
    canStopPollingCompletedSprintEngineProjection({
      sprintEngineAutoState: autoState('complete', 500),
      sprintEngineState: staleState,
    }),
    false,
  )
  // Finished but still stuck in `paused` → keep polling so the self-heal can
  // promote it to `complete` first.
  assert.equal(
    canStopPollingCompletedSprintEngineProjection({
      sprintEngineAutoState: autoState('paused', 500),
      sprintEngineState: state,
    }),
    false,
  )
  // Active run → keep polling.
  assert.equal(
    canStopPollingCompletedSprintEngineProjection({
      sprintEngineAutoState: autoState('running'),
      sprintEngineState: state,
    }),
    false,
  )
  // No automation lifecycle yet → keep polling.
  assert.equal(
    canStopPollingCompletedSprintEngineProjection({
      sprintEngineAutoState: autoState(),
      sprintEngineState: state,
    }),
    false,
  )

  // ── Cancellation (T6): a canceled run's runtimeState is `canceled`, never
  // `complete`, so the completion arm never matched it and the poller read it
  // forever. It stops once the hydrated state itself reads canceled + torn down.
  const canceledState = { ...state, canceled: true } as SprintEngineState
  assert.equal(
    canStopPollingCompletedSprintEngineProjection({
      sprintEngineAutoState: autoState('canceled', 500),
      sprintEngineState: canceledState,
    }),
    true,
    'canceled + hydrated-canceled + torn down → stop polling',
  )
  // Canceled runtime but the hydrated state is a STALE pre-cancel snapshot (the
  // flag has not been read yet) → keep polling for the one read that hydrates the
  // canceled board and recolors its Backlog chip.
  assert.equal(
    canStopPollingCompletedSprintEngineProjection({
      sprintEngineAutoState: autoState('canceled', 500),
      sprintEngineState: state,
    }),
    false,
    'canceled runtime but state not yet hydrated canceled → keep polling',
  )
  // Canceled + hydrated but the shared teardown has not run yet → keep polling.
  assert.equal(
    canStopPollingCompletedSprintEngineProjection({
      sprintEngineAutoState: autoState('canceled'),
      sprintEngineState: canceledState,
    }),
    false,
    'canceled but teardown not run → keep polling',
  )
  // Canceled but not yet hydrated at all (cold restart) → keep polling.
  assert.equal(
    canStopPollingCompletedSprintEngineProjection({
      sprintEngineAutoState: autoState('canceled', 500),
      sprintEngineState: null,
    }),
    false,
    'canceled cold run → keep polling for its one hydration read',
  )

  // ── Empty-graph completed (T6): a run with zero tasks has no per-task
  // projection write to wait for, so `isCompletedSprintEngineRun` (which requires
  // ≥1 task) would poll it forever. A hydrated (non-null) empty state is already
  // its final snapshot once complete + torn down.
  const emptyState = { ...state, tasks: [] } as SprintEngineState
  assert.equal(
    canStopPollingCompletedSprintEngineProjection({
      sprintEngineAutoState: autoState('complete', 500),
      sprintEngineState: emptyState,
    }),
    true,
    'empty-graph complete + hydrated + torn down → stop polling',
  )
  // An empty run that is NOT terminal (still running / no lifecycle) must keep
  // polling — the empty carve-out is gated on terminal runtimeState + teardown.
  assert.equal(
    canStopPollingCompletedSprintEngineProjection({
      sprintEngineAutoState: autoState('running'),
      sprintEngineState: emptyState,
    }),
    false,
    'empty but still running → keep polling',
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
await testPermanentReadErrorSkipsBackgroundDiagnostic()
await testPermanentReadErrorStillNotifiesManualRefresh()
await testMissingContextSkip()
await testCompletedProjectionRefreshesMatchingBacklogLink()
await testCompletedMultiProjectRunLinksEveryPullRequest()
await testCompletedSingleProjectRunLinksOneUnlabeledPullRequest()
await testCanceledProjectionRecolorsBacklogLinkWithoutDrivingItem()
await testDormantCanceledRefreshRecolorsLinkOnRoutineTick()
await testCompletedProjectionSparesEpicStatus()
await testNonterminalProjectionDoesNotCompleteBacklogLink()
await testBacklogRefreshFailureWarnsAndLeavesItemUnchanged()
await testFinishedPausedRunTransitionsAndTearsDown()
await testDormantWorkspaceRefreshIsDisplayOnly()
await testDormantWorkspaceUnchangedRefreshSkipsLifecycle()
await testDormantWorkspaceRefreshHealsInterruptedTeardown()
await testEnterDormancyIsIdempotentAcrossRepeats()
await testCompletedRunWithMarkerSkipsTeardown()
await testReopenedRunClearsMarker()
await testTeardownFailureLeavesMarkerUnset()
await testChildMovesOnlyWhenItsOwnTaskClaims()
await testCompletedButUnmergedRunLeavesChildrenInProgress()
await testMergedRunCompletesEveryChildFromDormancy()
await testCanceledRunRestoresChildrenToTheirPreSprintStatus()

console.log('sprintengine projection refresh tests passed')
