import assert from 'node:assert/strict'

import type { AutomationRendererRequest, AutomationRendererResponse } from '../../shared/automation'
import type { AutomationDefinition, AutomationRun } from '../../shared/automations/contracts'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import type { Workspace } from '../../renderer/src/types/workspace'
import { createBuiltInAutomationActionProviders, createLocalAutomationExecutor } from './executor-local'

function workspace(id: string, folderPath: string | null, overrides: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name: id,
    mode: 'standard',
    folderPath,
    templateId: 'standard-test',
    layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
    agents: {},
    worktreeState: { containerPath: null, entries: {}, updatedAt: null },
    memory: { relativeRoot: null },
    editorState: { openFiles: [], activeFilePath: null },
    sprintEngineState: null,
    sprintEngineAutoState: {
      desiredMode: 'manual',
      runtimeState: 'idle',
      keepDoneAgentTerminals: false,
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 0,
      pendingSpawns: [],
      deliveredAgentNotificationEventKeys: [],
    },
    multiloopAutoState: {
      enabled: false,
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 0,
      pendingSpawns: [],
    },
    createdAt: 1,
    ...overrides,
  }
}

function snapshot(workspaces: Workspace[]): WorkspaceSyncSnapshot {
  return {
    sequence: 1,
    state: {
      workspaces,
      activeWorkspaceId: workspaces[0]?.id ?? null,
      primaryWorkspaceWindowId: 'primary',
      workspaceWindows: [
        {
          id: 'primary',
          kind: 'primary',
          workspaceIds: workspaces.map((entry) => entry.id),
          activeWorkspaceId: workspaces[0]?.id ?? null,
          bounds: null,
          isMaximized: false,
          displayId: null,
          createdAt: 0,
          lastFocusedAt: 0,
        },
      ],
    },
  }
}

function definition(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: 'nightly-review',
    name: 'Nightly review',
    status: 'enabled',
    trigger: { kind: 'schedule', config: { kind: 'schedule', cadence: { type: 'interval', everyMinutes: 30 }, timezone: 'UTC' } },
    action: { kind: 'spawn-agent', config: { folderPath: '/repo/a', prompt: 'Review the repo.' } },
    autonomyDefault: 'review_only',
    nextRunAt: '2026-06-17T10:00:00.000Z',
    lastRunAt: null,
    lastRunId: null,
    createdAt: '2026-06-17T09:00:00.000Z',
    updatedAt: '2026-06-17T09:00:00.000Z',
    ...overrides,
  }
}

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'nightly-review',
    status: 'running',
    dueAt: '2026-06-17T10:00:00.000Z',
    startedAt: '2026-06-17T10:00:00.000Z',
    completedAt: null,
    ...overrides,
  }
}

function executorHarness(initialWorkspaces: Workspace[] = []) {
  const workspaces = [...initialWorkspaces]
  const requests: AutomationRendererRequest[] = []
  const delegateToRenderer = async (request: AutomationRendererRequest): Promise<AutomationRendererResponse> => {
    requests.push(request)
    if (request.kind === 'workspace.create') {
      const id = 'ws-created'
      workspaces.push(workspace(id, request.folderPath ?? null, { name: request.name ?? id }))
      return { ok: true, workspaceId: id }
    }

    if (request.kind === 'agent.launch') {
      const target = workspaces.find((candidate) => candidate.id === request.workspaceId)
      if (!target) return { ok: false, code: 'unknown_workspace', message: 'unknown workspace' }
      const agentId = `agent-${Object.keys(target.agents).length + 1}`
      target.agents[agentId] = {
        id: agentId,
        name: request.name ?? agentId,
        status: 'idle',
        execution: { mode: 'current_workspace', worktreeId: null, cwd: null },
        messages: [],
        streamBuffer: '',
        runtimeKind: 'terminal',
        cli: request.cli ?? 'codex',
        cliSessionId: `session-${agentId}`,
        cliStartRequested: true,
        cliHasLaunched: true,
      } as Workspace['agents'][string]
      return { ok: true, workspaceId: request.workspaceId, agentId }
    }

    return { ok: false, code: 'unsupported', message: 'unsupported request' }
  }

  return {
    requests,
    workspaces,
    executor: createLocalAutomationExecutor({
      delegateToRenderer,
      getWorkspaceSyncSnapshot: () => snapshot(workspaces),
      now: (() => {
        let current = 0
        return () => {
          current += 30_000
          return current
        }
      })(),
      sleep: async () => undefined,
    }),
  }
}

async function assertSpawnAgentCreatesWorkspaceAndLaunchesOnBus(): Promise<void> {
  const harness = executorHarness()
  const result = await harness.executor({
    workspaceRoot: '/repo/a',
    definition: definition(),
    run: run(),
    triggerPayload: { kind: 'schedule' },
  })

  assert.equal(result.status, 'completed')
  assert.equal(result.workspaceId, 'ws-created')
  assert.equal(result.agentId, 'agent-1')
  assert.equal(typeof result.promptFingerprint, 'string')
  assert.equal('prompt' in result, false, 'full prompt is not persisted on the run patch')
  assert.deepEqual(harness.requests.map((request) => request.kind), ['workspace.create', 'agent.launch'])

  const launch = harness.requests[1]
  assert.equal(launch.kind, 'agent.launch')
  assert.match(launch.kind === 'agent.launch' ? launch.prompt ?? '' : '', /review_only/)
  assert.match(launch.kind === 'agent.launch' ? launch.prompt ?? '' : '', /Do not edit files/)
  assert.equal(harness.workspaces[0]?.agents['agent-1']?.cliHasLaunched, true)
}

async function assertAllowChangesDirtyWorkspaceBlocksBeforeLaunch(): Promise<void> {
  const dirtyWorkspace = workspace('ws-dirty', '/repo/dirty', {
    editorState: {
      activeFilePath: '/repo/dirty/file.ts',
      openFiles: [{ path: '/repo/dirty/file.ts', name: 'file.ts', language: 'ts', isDirty: true }],
    },
  })
  const harness = executorHarness([dirtyWorkspace])
  const result = await harness.executor({
    workspaceRoot: '/repo/dirty',
    definition: definition({
      autonomyDefault: 'allow_changes',
      action: { kind: 'spawn-agent', config: { folderPath: '/repo/dirty', prompt: 'Fix this.' } },
    }),
    run: run(),
    triggerPayload: { kind: 'schedule' },
  })

  assert.equal(result.status, 'blocked')
  assert.match(result.blockedReason ?? '', /unsaved editor changes/)
  assert.deepEqual(harness.requests, [], 'dirty allow_changes runs do not delegate a launch')
}

async function assertMissingIntegrationBlocksWithoutFakeSuccess(): Promise<void> {
  const cleanWorkspace = workspace('ws-clean', '/repo/a')
  const requests: AutomationRendererRequest[] = []
  const executor = createLocalAutomationExecutor({
    delegateToRenderer: async (request) => {
      requests.push(request)
      return { ok: false, code: 'should_not_launch', message: 'should not launch' }
    },
    getWorkspaceSyncSnapshot: () => snapshot([cleanWorkspace]),
    isIntegrationAvailable: (id) => id !== 'mcp:sentry',
    sleep: async () => undefined,
  })

  const result = await executor({
    workspaceRoot: '/repo/a',
    definition: definition({
      action: {
        kind: 'spawn-agent',
        config: { folderPath: '/repo/a', prompt: 'Check Sentry.', requiredIntegrations: ['mcp:sentry'] },
      },
    }),
    run: run(),
    triggerPayload: { kind: 'schedule' },
  })

  assert.equal(result.status, 'blocked')
  assert.match(result.blockedReason ?? '', /mcp:sentry/)
  assert.deepEqual(requests, [], 'missing integration blocks before renderer launch')
}

async function assertUnknownWorkspaceIdDoesNotCreateFallbackWorkspace(): Promise<void> {
  const harness = executorHarness([workspace('ws-known', '/repo/a')])
  const result = await harness.executor({
    workspaceRoot: '/repo/a',
    definition: definition({
      action: {
        kind: 'spawn-agent',
        config: { workspaceId: 'ws-missing', folderPath: '/repo/a', prompt: 'Review the repo.' },
      },
    }),
    run: run(),
    triggerPayload: { kind: 'schedule' },
  })

  assert.equal(result.status, 'failed')
  assert.match(result.summary ?? '', /ws-missing/)
  assert.deepEqual(harness.requests, [], 'unknown explicit workspaceId does not create or launch')
}

async function assertRunSkillLoopIsPresetAndRunCommandIsNotRegistered(): Promise<void> {
  const providers = createBuiltInAutomationActionProviders()
  assert.deepEqual(providers.map((provider) => provider.kind).sort(), ['run-skill-loop', 'spawn-agent'])

  const harness = executorHarness([workspace('ws-loop', '/repo/loop')])
  const result = await harness.executor({
    workspaceRoot: '/repo/loop',
    definition: definition({
      action: {
        kind: 'run-skill-loop',
        config: { folderPath: '/repo/loop', prompt: 'Keep checking the backlog.', skill: 'backlog' },
      },
    }),
    run: run(),
    triggerPayload: { kind: 'schedule' },
  })

  assert.equal(result.status, 'completed')
  const launch = harness.requests[0]
  assert.equal(launch.kind, 'agent.launch')
  assert.match(launch.kind === 'agent.launch' ? launch.prompt ?? '' : '', /^\/loop backlog/m)
  assert.match(launch.kind === 'agent.launch' ? launch.prompt ?? '' : '', /review_only/)
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})

async function main(): Promise<void> {
  await assertSpawnAgentCreatesWorkspaceAndLaunchesOnBus()
  await assertAllowChangesDirtyWorkspaceBlocksBeforeLaunch()
  await assertMissingIntegrationBlocksWithoutFakeSuccess()
  await assertUnknownWorkspaceIdDoesNotCreateFallbackWorkspace()
  await assertRunSkillLoopIsPresetAndRunCommandIsNotRegistered()
}
