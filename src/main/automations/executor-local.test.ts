import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AutomationRendererRequest, AutomationRendererResponse } from '../../shared/automation'
import type { AutomationActionProvider, AutomationDefinition, AutomationRun } from '../../shared/automations/contracts'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import type { Workspace } from '../../renderer/src/types/workspace'
import { SPRINT_ENGINE_AUTOMATION_INTEGRATION_ID, SPRINT_ENGINE_RUN_ACTION_KIND } from './actions/sprint-engine'
import {
  SWITCHBOARD_AUTOMATION_INTEGRATION_ID,
  SWITCHBOARD_RUNNER_TICK_ACTION_KIND,
  WATCHTOWER_AUTOMATION_INTEGRATION_ID,
  WATCHTOWER_REVIEW_ACTION_KIND,
} from './actions/switchboard'
import { createBuiltInAutomationActionProviders, createLocalAutomationExecutor, type LocalAutomationExecutorOptions } from './executor-local'
import {
  AutomationProviderRegistrationError,
  createAutomationProviderRegistry,
  createBuiltInAutomationProviderRegistry,
  namespacedProviderId,
} from './provider-registry'
import { REPO_EVENT_TRIGGER_KIND } from './triggers/repo-event'

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

function executorHarness(
  initialWorkspaces: Workspace[] = [],
  options: {
    isWorkspaceDirty?: LocalAutomationExecutorOptions['isWorkspaceDirty'] | null
    actionProviders?: LocalAutomationExecutorOptions['actionProviders']
    isIntegrationAvailable?: LocalAutomationExecutorOptions['isIntegrationAvailable']
  } = {}
) {
  const workspaces = [...initialWorkspaces]
  const requests: AutomationRendererRequest[] = []
  const isWorkspaceDirty = options.isWorkspaceDirty === null
    ? undefined
    : options.isWorkspaceDirty ?? (async () => ({ dirty: false }))
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
      ...(isWorkspaceDirty ? { isWorkspaceDirty } : {}),
      ...(options.actionProviders ? { actionProviders: options.actionProviders } : {}),
      ...(options.isIntegrationAvailable ? { isIntegrationAvailable: options.isIntegrationAvailable } : {}),
    }),
  }
}

function firstPartyActionProviders(calls: string[] = []): AutomationActionProvider[] {
  return createBuiltInAutomationActionProviders({
    switchboard: {
      readAllTasks: async (input) => ({ ok: true, workspaceRoot: input.workspaceRoot, switchboardRoot: '', tasks: [], problems: [] }),
      tickRunner: async (input) => {
        calls.push(`switchboard:${input.workspaceRoot}`)
        return {
          ok: true,
          workspaceRoot: input.workspaceRoot,
          enabled: true,
          running: true,
          paused: false,
          provider: 'electron-session',
          cli: 'codex',
          maxConcurrency: 1,
          queues: ['ready'],
          activeExecutions: [],
          lastError: null,
          updatedAt: null,
        }
      },
      startWatchtowerReview: async (input) => {
        calls.push(`watchtower:${input.workspaceRoot}:${input.preset}`)
        return {
          ok: true,
          run: {
            schemaVersion: 1,
            runId: 'watchtower-run-1',
            status: 'running',
            createdAt: '2026-06-18T00:00:00.000Z',
            completedAt: null,
            workspaceRoot: input.workspaceRoot,
            preset: input.preset,
            agents: [],
            counts: { valid: 0, invalid: 0, ingested: 0 },
          },
        }
      },
    },
    sprintEngine: {
      setRunnerMode: async (input) => {
        calls.push(`sprint-mode:${input.statePath}:${input.cliWatchPolling}`)
        return { ok: true, data: {} }
      },
      replenishRoster: async (input) => {
        calls.push(`sprint-roster:${input.statePath}:${input.role ?? ''}`)
        return { ok: true, data: {} }
      },
    },
  })
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

async function assertSpawnAgentUsesExistingStandardWorkspace(): Promise<void> {
  const harness = executorHarness([workspace('ws-standard', '/repo/a')])
  const result = await harness.executor({
    workspaceRoot: '/repo/a',
    definition: definition(),
    run: run(),
    triggerPayload: { kind: 'schedule' },
  })

  assert.equal(result.status, 'completed')
  assert.equal(result.workspaceId, 'ws-standard')
  assert.equal(result.agentId, 'agent-1')
  assert.deepEqual(harness.requests.map((request) => request.kind), ['agent.launch'])
  const launch = harness.requests[0]
  assert.equal(launch.kind, 'agent.launch')
  assert.equal(launch.kind === 'agent.launch' ? launch.workspaceId : '', 'ws-standard')
}

async function assertSpawnAgentCreatesStandardTargetWhenOnlyAutomationsWorkspaceIsOpen(): Promise<void> {
  const automationsWorkspace = workspace('ws-automations', '/repo/a', { mode: 'automations' })
  const harness = executorHarness([automationsWorkspace])
  const result = await harness.executor({
    workspaceRoot: '/repo/a',
    definition: definition(),
    run: run(),
    triggerPayload: { kind: 'schedule' },
  })

  assert.equal(result.status, 'completed')
  assert.equal(result.workspaceId, 'ws-created')
  assert.equal(result.agentId, 'agent-1')
  assert.deepEqual(harness.requests.map((request) => request.kind), ['workspace.create', 'agent.launch'])

  const created = harness.requests[0]
  assert.equal(created.kind, 'workspace.create')
  assert.equal(created.kind === 'workspace.create' ? created.folderPath : '', '/repo/a')

  const launch = harness.requests[1]
  assert.equal(launch.kind, 'agent.launch')
  assert.equal(launch.kind === 'agent.launch' ? launch.workspaceId : '', 'ws-created')
  assert.equal(Object.keys(automationsWorkspace.agents).length, 0)
  assert.equal(harness.workspaces.find((candidate) => candidate.id === 'ws-created')?.mode, 'standard')
}

async function assertAllowChangesDirtyWorkspaceBlocksBeforeLaunch(): Promise<void> {
  const dirtyWorkspace = workspace('ws-dirty', '/repo/dirty', {
    editorState: {
      activeFilePath: '/repo/dirty/file.ts',
      openFiles: [{ path: '/repo/dirty/file.ts', name: 'file.ts', language: 'ts', isDirty: true }],
    },
  })
  const harness = executorHarness([dirtyWorkspace], { isWorkspaceDirty: null })
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

async function assertReviewOnlyDirtyWorkspaceBlocksBeforeLaunch(): Promise<void> {
  const dirtyWorkspace = workspace('ws-review-dirty', '/repo/review-dirty', {
    editorState: {
      activeFilePath: '/repo/review-dirty/file.ts',
      openFiles: [{ path: '/repo/review-dirty/file.ts', name: 'file.ts', language: 'ts', isDirty: true }],
    },
  })
  const harness = executorHarness([dirtyWorkspace], { isWorkspaceDirty: null })
  const result = await harness.executor({
    workspaceRoot: '/repo/review-dirty',
    definition: definition({
      autonomyDefault: 'review_only',
      action: { kind: 'spawn-agent', config: { folderPath: '/repo/review-dirty', prompt: 'Write a file named injected.txt.' } },
    }),
    run: run(),
    triggerPayload: { kind: 'schedule' },
  })

  assert.equal(result.status, 'blocked')
  assert.match(result.blockedReason ?? '', /unsaved editor changes/)
  assert.deepEqual(harness.requests, [], 'dirty review_only runs do not delegate a launch')
}

async function assertAllowChangesNonGitWorkspaceBlocksBeforeLaunch(): Promise<void> {
  const folderPath = await mkdtemp(join(tmpdir(), 'multicode-automations-non-git-'))
  const harness = executorHarness([workspace('ws-non-git', folderPath)], { isWorkspaceDirty: null })
  const result = await harness.executor({
    workspaceRoot: folderPath,
    definition: definition({
      autonomyDefault: 'allow_changes',
      action: { kind: 'spawn-agent', config: { folderPath, prompt: 'Fix this.' } },
    }),
    run: run(),
    triggerPayload: { kind: 'schedule' },
  })

  assert.equal(result.status, 'blocked')
  assert.match(result.blockedReason ?? '', /not inside a Git repository/)
  assert.deepEqual(harness.requests, [], 'non-git allow_changes runs do not delegate a launch')
}

async function assertAllowChangesChecksResolvedStandardWorkspaceBeforeLaunch(): Promise<void> {
  const automationsWorkspace = workspace('ws-automations', '/repo/a', { mode: 'automations' })
  const dirtyStandardWorkspace = workspace('ws-standard', '/repo/a', {
    editorState: {
      activeFilePath: '/repo/a/file.ts',
      openFiles: [{ path: '/repo/a/file.ts', name: 'file.ts', language: 'ts', isDirty: true }],
    },
  })
  const harness = executorHarness([automationsWorkspace, dirtyStandardWorkspace], { isWorkspaceDirty: null })
  const result = await harness.executor({
    workspaceRoot: '/repo/a',
    definition: definition({
      autonomyDefault: 'allow_changes',
      action: { kind: 'spawn-agent', config: { folderPath: '/repo/a', prompt: 'Fix this.' } },
    }),
    run: run(),
    triggerPayload: { kind: 'schedule' },
  })

  assert.equal(result.status, 'blocked')
  assert.match(result.blockedReason ?? '', /unsaved editor changes/)
  assert.deepEqual(harness.requests, [], 'dirty resolved standard workspace blocks before renderer delegation')
  assert.equal(Object.keys(automationsWorkspace.agents).length, 0)
  assert.equal(Object.keys(dirtyStandardWorkspace.agents).length, 0)
}

async function assertAllowChangesWorkspaceIdUsesResolvedWorkspaceForDirtyCheck(): Promise<void> {
  const targetWorkspace = workspace('ws-target', '/repo/target')
  const requests: AutomationRendererRequest[] = []
  const dirtyChecks: Array<{ workspaceId?: string; folderPath: string; workspace: Workspace | null }> = []
  const executor = createLocalAutomationExecutor({
    delegateToRenderer: async (request) => {
      requests.push(request)
      return { ok: false, code: 'should_not_launch', message: 'should not launch' }
    },
    getWorkspaceSyncSnapshot: () => snapshot([targetWorkspace]),
    isWorkspaceDirty: async (input) => {
      dirtyChecks.push(input)
      return input.folderPath === '/repo/target'
        ? { dirty: true, reason: 'Target workspace repo is dirty.' }
        : { dirty: false }
    },
    sleep: async () => undefined,
  })

  const result = await executor({
    workspaceRoot: '/repo/default',
    definition: definition({
      autonomyDefault: 'allow_changes',
      action: { kind: 'spawn-agent', config: { workspaceId: 'ws-target', prompt: 'Fix target.' } },
    }),
    run: run(),
    triggerPayload: { kind: 'schedule' },
  })

  assert.equal(result.status, 'blocked')
  assert.match(result.blockedReason ?? '', /Target workspace repo is dirty/)
  assert.equal(dirtyChecks.length, 1)
  assert.equal(dirtyChecks[0]?.workspaceId, 'ws-target')
  assert.equal(dirtyChecks[0]?.folderPath, '/repo/target')
  assert.equal(dirtyChecks[0]?.workspace?.id, 'ws-target')
  assert.deepEqual(requests, [], 'workspaceId allow_changes checks the target workspace before launch')
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

async function assertRequiredIntegrationFailsClosed(): Promise<void> {
  const withoutResolver = executorHarness([workspace('ws-clean', '/repo/a')])
  const noResolverResult = await withoutResolver.executor({
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

  assert.equal(noResolverResult.status, 'blocked')
  assert.match(noResolverResult.blockedReason ?? '', /mcp:sentry/)
  assert.deepEqual(withoutResolver.requests, [], 'required integrations fail closed when no resolver is configured')

  const cleanWorkspace = workspace('ws-clean', '/repo/a')
  const requests: AutomationRendererRequest[] = []
  const unknownResolverExecutor = createLocalAutomationExecutor({
    delegateToRenderer: async (request) => {
      requests.push(request)
      return { ok: false, code: 'should_not_launch', message: 'should not launch' }
    },
    getWorkspaceSyncSnapshot: () => snapshot([cleanWorkspace]),
    isIntegrationAvailable: () => undefined,
    sleep: async () => undefined,
  })
  const unknownResolverResult = await unknownResolverExecutor({
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

  assert.equal(unknownResolverResult.status, 'blocked')
  assert.match(unknownResolverResult.blockedReason ?? '', /mcp:sentry/)
  assert.deepEqual(requests, [], 'required integrations fail closed when resolver cannot verify availability')
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

async function assertFirstPartyActionsInvokeFrontDoors(): Promise<void> {
  const calls: string[] = []
  const providers = firstPartyActionProviders(calls)
  assert.deepEqual(
    providers.map((provider) => provider.kind).sort(),
    [
      'run-skill-loop',
      'spawn-agent',
      SPRINT_ENGINE_RUN_ACTION_KIND,
      SWITCHBOARD_RUNNER_TICK_ACTION_KIND,
      WATCHTOWER_REVIEW_ACTION_KIND,
    ].sort()
  )
  const harness = executorHarness([workspace('ws-front-door', '/repo/a')], {
    actionProviders: providers,
    isIntegrationAvailable: () => true,
  })

  const switchboard = await harness.executor({
    workspaceRoot: '/repo/a',
    definition: definition({ action: { kind: SWITCHBOARD_RUNNER_TICK_ACTION_KIND, config: {} } }),
    run: run(),
    triggerPayload: { kind: 'schedule' },
  })
  assert.equal(switchboard.status, 'completed')
  assert.match(switchboard.summary ?? '', /Switchboard runner tick completed/)

  const watchtower = await harness.executor({
    workspaceRoot: '/repo/a',
    definition: definition({ action: { kind: WATCHTOWER_REVIEW_ACTION_KIND, config: { preset: 'lean_code_review' } } }),
    run: run(),
    triggerPayload: { kind: 'schedule' },
  })
  assert.equal(watchtower.status, 'completed')
  assert.equal(watchtower.summary, 'Started Watchtower review watchtower-run-1.')

  const sprintEngine = await harness.executor({
    workspaceRoot: '/repo/a',
    definition: definition({
      action: { kind: SPRINT_ENGINE_RUN_ACTION_KIND, config: { team: 'ship-squad', role: 'developer' } },
    }),
    run: run(),
    triggerPayload: { kind: 'schedule' },
  })
  assert.equal(sprintEngine.status, 'completed')
  assert.match(sprintEngine.summary ?? '', /ship-squad/)

  assert.deepEqual(calls, [
    'switchboard:/repo/a',
    'watchtower:/repo/a:lean_code_review',
    'sprint-mode:/repo/a/.multi-code/sprintengine/ship-squad/run.yaml:enabled',
    'sprint-roster:/repo/a/.multi-code/sprintengine/ship-squad/run.yaml:developer',
  ])
}

async function assertFirstPartyMissingIntegrationBlocksBeforeFrontDoor(): Promise<void> {
  const cases = [
    {
      kind: SWITCHBOARD_RUNNER_TICK_ACTION_KIND,
      config: {},
      integration: SWITCHBOARD_AUTOMATION_INTEGRATION_ID,
    },
    {
      kind: WATCHTOWER_REVIEW_ACTION_KIND,
      config: { preset: 'lean_code_review' },
      integration: WATCHTOWER_AUTOMATION_INTEGRATION_ID,
    },
    {
      kind: SPRINT_ENGINE_RUN_ACTION_KIND,
      config: { team: 'ship-squad' },
      integration: SPRINT_ENGINE_AUTOMATION_INTEGRATION_ID,
    },
  ]

  for (const blockedCase of cases) {
    const calls: string[] = []
    const harness = executorHarness([workspace('ws-front-door', '/repo/a')], {
      actionProviders: firstPartyActionProviders(calls),
      isIntegrationAvailable: (id) => id !== blockedCase.integration,
    })

    const result = await harness.executor({
      workspaceRoot: '/repo/a',
      definition: definition({ action: { kind: blockedCase.kind, config: blockedCase.config } }),
      run: run(),
      triggerPayload: { kind: 'schedule' },
    })

    assert.equal(result.status, 'blocked')
    assert.match(result.blockedReason ?? '', new RegExp(blockedCase.integration))
    assert.deepEqual(calls, [])
  }
}

function assertBuiltInProviderRegistryUsesNamespacedIdsAndRejectsDuplicates(): void {
  const builtIns = createBuiltInAutomationProviderRegistry({
    switchboard: {
      readAllTasks: async () => {
        throw new Error('not used')
      },
      tickRunner: async () => {
        throw new Error('not used')
      },
      startWatchtowerReview: async () => {
        throw new Error('not used')
      },
    },
    sprintEngine: {
      setRunnerMode: async () => {
        throw new Error('not used')
      },
      replenishRoster: async () => {
        throw new Error('not used')
      },
    },
  })
  assert.equal(namespacedProviderId('automations', 'schedule'), 'automations.schedule')
  assert.equal(builtIns.getTriggerProvider('automations.schedule')?.kind, 'schedule')
  assert.equal(builtIns.getTriggerProvider(`switchboard.${REPO_EVENT_TRIGGER_KIND}`)?.kind, REPO_EVENT_TRIGGER_KIND)
  assert.equal(builtIns.getActionProvider('automations.spawn-agent')?.kind, 'spawn-agent')
  assert.equal(builtIns.getActionProvider('automations.run-skill-loop')?.kind, 'run-skill-loop')
  assert.equal(builtIns.getActionProvider(`switchboard.${SWITCHBOARD_RUNNER_TICK_ACTION_KIND}`)?.kind, SWITCHBOARD_RUNNER_TICK_ACTION_KIND)
  assert.equal(builtIns.getActionProvider(`switchboard.${WATCHTOWER_REVIEW_ACTION_KIND}`)?.kind, WATCHTOWER_REVIEW_ACTION_KIND)
  assert.equal(builtIns.getActionProvider(`sprint-engine.${SPRINT_ENGINE_RUN_ACTION_KIND}`)?.kind, SPRINT_ENGINE_RUN_ACTION_KIND)
  assert.equal(builtIns.getActionProvider('other.spawn-agent'), undefined)
  assert.deepEqual(builtIns.listTriggerProviders().map((provider) => provider.kind), ['schedule', REPO_EVENT_TRIGGER_KIND])
  assert.deepEqual(builtIns.listActionProviders().map((provider) => provider.kind), [
    'spawn-agent',
    'run-skill-loop',
    SWITCHBOARD_RUNNER_TICK_ACTION_KIND,
    WATCHTOWER_REVIEW_ACTION_KIND,
    SPRINT_ENGINE_RUN_ACTION_KIND,
  ])
  assert.equal(WATCHTOWER_AUTOMATION_INTEGRATION_ID, 'module:watchtower')
  assert.equal(SPRINT_ENGINE_AUTOMATION_INTEGRATION_ID, 'module:sprint-engine')

  const duplicateRegistry = createAutomationProviderRegistry()
  const duplicateProvider: AutomationActionProvider = {
    kind: 'spawn-agent',
    configSchema: {},
    run: async () => ({}),
  }
  assert.equal(duplicateRegistry.registerActionProvider('automations', duplicateProvider), 'automations.spawn-agent')
  assert.throws(
    () => duplicateRegistry.registerActionProvider('automations', duplicateProvider),
    (error) => error instanceof AutomationProviderRegistrationError
      && error.providerId === 'automations.spawn-agent'
      && /Duplicate automation action provider registration/.test(error.message)
  )
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})

async function main(): Promise<void> {
  assertBuiltInProviderRegistryUsesNamespacedIdsAndRejectsDuplicates()
  await assertSpawnAgentCreatesWorkspaceAndLaunchesOnBus()
  await assertSpawnAgentUsesExistingStandardWorkspace()
  await assertSpawnAgentCreatesStandardTargetWhenOnlyAutomationsWorkspaceIsOpen()
  await assertAllowChangesDirtyWorkspaceBlocksBeforeLaunch()
  await assertReviewOnlyDirtyWorkspaceBlocksBeforeLaunch()
  await assertAllowChangesNonGitWorkspaceBlocksBeforeLaunch()
  await assertAllowChangesChecksResolvedStandardWorkspaceBeforeLaunch()
  await assertAllowChangesWorkspaceIdUsesResolvedWorkspaceForDirtyCheck()
  await assertMissingIntegrationBlocksWithoutFakeSuccess()
  await assertRequiredIntegrationFailsClosed()
  await assertUnknownWorkspaceIdDoesNotCreateFallbackWorkspace()
  await assertRunSkillLoopIsPresetAndRunCommandIsNotRegistered()
  await assertFirstPartyActionsInvokeFrontDoors()
  await assertFirstPartyMissingIntegrationBlocksBeforeFrontDoor()
}
