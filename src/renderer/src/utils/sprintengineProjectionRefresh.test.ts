import assert from 'node:assert/strict'
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
  } as Workspace
}

function portsFor(input: {
  data?: unknown
  ok?: boolean
  message?: string
  applied: SprintEngineState[]
}): SprintEngineProjectionRefreshPorts {
  return {
    readSprintEngineProjection: async () => input.ok === false
      ? { ok: false, message: input.message ?? 'projection read failed' }
      : { ok: true, data: input.data ?? projection('in_progress') },
    setSprintEngineState: (_workspaceId, state) => {
      if (state) input.applied.push(state)
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
  const result = await refreshSprintEngineWorkspaceProjection({
    workspace: workspace(),
    signatures: new Map(),
    cause: 'supervisor',
    ports: portsFor({ ok: false, message: 'boom', applied }),
  })

  assert.deepEqual(result, { status: 'error', message: 'boom' })
  assert.equal(applied.length, 0)
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

await testChangedRefresh()
await testColdStateRefreshWithContext()
await testUnchangedDedupe()
await testForcedRefreshUpdatesSignature()
await testReadError()
await testMissingContextSkip()

console.log('sprintengine projection refresh tests passed')
