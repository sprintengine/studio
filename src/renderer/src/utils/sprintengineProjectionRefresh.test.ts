import assert from 'node:assert/strict'
import type {
  BacklogItemLinkPayload,
  BacklogMutationResult,
  BacklogObjectStorePayload,
  BacklogReadResult,
} from '../../../shared/electron-api'
import type { SprintEngineState, Workspace } from '../types/workspace'
import {
  refreshSprintEngineWorkspaceProjection,
  sprintEngineProjectionSignature,
  type SprintEngineProjectionRefreshPorts,
} from './sprintengineProjectionRefresh'

function projection(taskStatus: string, updatedAt = '2026-06-07T15:00:00Z'): unknown {
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
      status: 'executing',
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
}): SprintEngineProjectionRefreshPorts {
  return {
    readSprintEngineProjection: async () => input.ok === false
      ? { ok: false, message: input.message ?? 'projection read failed' }
      : { ok: true, data: input.data ?? projection('in_progress') },
    setSprintEngineState: (_workspaceId, state) => {
      if (state) input.applied.push(state)
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

async function testChangedRefresh(): Promise<void> {
  const applied: SprintEngineState[] = []
  const result = await refreshSprintEngineWorkspaceProjection({
    workspace: workspace(),
    signatures: new Map(),
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
    signatures: new Map(),
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
  const signatures = new Map([['workspace-1', sprintEngineProjectionSignature(data)]])
  const result = await refreshSprintEngineWorkspaceProjection({
    workspace: workspace(),
    signatures,
    cause: 'auto-run',
    ports: portsFor({ data, applied }),
  })

  assert.equal(result.status, 'unchanged')
  assert.equal(applied.length, 0)
}

async function testForcedRefreshUpdatesSignature(): Promise<void> {
  const applied: SprintEngineState[] = []
  const staleData = projection('todo')
  const forcedData = projection('done')
  const signatures = new Map([['workspace-1', sprintEngineProjectionSignature(staleData)]])
  const result = await refreshSprintEngineWorkspaceProjection({
    workspace: workspace(),
    signatures,
    cause: 'manual',
    force: true,
    ports: portsFor({ data: forcedData, applied }),
  })

  assert.equal(result.status, 'changed')
  assert.equal(applied.length, 1)
  assert.equal(applied[0].tasks[0].status, 'done')
  assert.equal(signatures.get('workspace-1'), sprintEngineProjectionSignature(forcedData))
}

async function testReadError(): Promise<void> {
  const applied: SprintEngineState[] = []
  const diagnostics: string[] = []
  const result = await refreshSprintEngineWorkspaceProjection({
    workspace: workspace(),
    signatures: new Map(),
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
    signatures: new Map(),
    cause: 'manual',
    ports: portsFor({ applied: [] }),
  })

  assert.deepEqual(result, { status: 'skipped', reason: 'missing-context' })
}

async function testCompletedProjectionRefreshesMatchingBacklogLink(): Promise<void> {
  const applied: SprintEngineState[] = []
  const backlogMutations: Array<{
    workspaceRoot: string
    relativePath: string
    link: BacklogItemLinkPayload
    status?: 'completed'
  }> = []
  const result = await refreshSprintEngineWorkspaceProjection({
    workspace: workspace(),
    signatures: new Map(),
    cause: 'supervisor',
    ports: portsFor({
      data: projection('done'),
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
    signatures: new Map(),
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
    signatures: new Map(),
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

await testChangedRefresh()
await testColdStateRefreshWithContext()
await testUnchangedDedupe()
await testForcedRefreshUpdatesSignature()
await testReadError()
await testMissingContextSkip()
await testCompletedProjectionRefreshesMatchingBacklogLink()
await testNonterminalProjectionDoesNotCompleteBacklogLink()
await testBacklogRefreshFailureWarnsAndLeavesItemUnchanged()

console.log('sprintengine projection refresh tests passed')
