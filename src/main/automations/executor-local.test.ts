import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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
import {
  createBuiltInAutomationActionProviders,
  createLocalAutomationExecutor,
  defaultCreateRunWorktree,
  excludeRunSignalFromWorktree,
  type LocalAutomationExecutorOptions,
} from './executor-local'
import { RUN_SIGNAL_FILENAME } from './run-signal'
import { runGitCommand } from '../git-utils'
import {
  AutomationProviderRegistrationError,
  type AutomationProviderPermissionChecker,
  createAutomationProviderRegistry,
  createBuiltInAutomationProviderRegistry,
  namespacedProviderId,
  type RegisteredAutomationProvider,
} from './provider-registry'
import { REPO_EVENT_TRIGGER_KIND } from './triggers/repo-event'
import { WEBHOOK_TRIGGER_KIND } from './triggers/webhook'

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

const LAUNCHABLE_WATCHTOWER_REVIEW_PRESETS = [
  'lean_code_review',
  'ui_brand_alignment_review',
  'performance_focused_review',
  'security_deep_review',
  'full_product_review',
] as const

const launchableWatchtowerReviewPresets = new Set<string>(LAUNCHABLE_WATCHTOWER_REVIEW_PRESETS)

function executorHarness(
  initialWorkspaces: Workspace[] = [],
  options: {
    actionProviders?: LocalAutomationExecutorOptions['actionProviders']
    isIntegrationAvailable?: LocalAutomationExecutorOptions['isIntegrationAvailable']
    createRunWorktree?: LocalAutomationExecutorOptions['createRunWorktree']
    resolveAgentExecutionId?: LocalAutomationExecutorOptions['resolveAgentExecutionId']
  } = {}
) {
  const workspaces = [...initialWorkspaces]
  const requests: AutomationRendererRequest[] = []
  const delegateToRenderer = async (request: AutomationRendererRequest): Promise<AutomationRendererResponse> => {
    requests.push(request)
    if (request.kind === 'workspace.create') {
      const id = 'ws-created'
      // Honor the explicit mode the executor threads through (T2 create-with-mode),
      // mirroring the renderer addWorkspace path, so a created automations host is
      // observed as `automations-host` on the bus.
      workspaces.push(workspace(id, request.folderPath ?? null, {
        name: request.name ?? id,
        mode: request.mode ?? 'standard',
      }))
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
      // Hermetic by default: no real `git worktree` subprocess in unit tests.
      createRunWorktree: options.createRunWorktree ?? (async () => null),
      ...(options.actionProviders ? { actionProviders: options.actionProviders } : {}),
      ...(options.isIntegrationAvailable ? { isIntegrationAvailable: options.isIntegrationAvailable } : {}),
      ...(options.resolveAgentExecutionId ? { resolveAgentExecutionId: options.resolveAgentExecutionId } : {}),
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
        if (!launchableWatchtowerReviewPresets.has(input.preset)) {
          return { ok: false, message: 'Watchtower preset has no review agents.' }
        }
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

async function assertDefaultRunCreatesHostWorkspaceAndLaunchesOnBus(): Promise<void> {
  // Default route, no host open for the folder: the executor creates a hidden
  // automations-host workspace (never a standard one) and launches one agent.
  const harness = executorHarness()
  const result = await harness.executor({
    workspaceRoot: '/repo/a',
    definition: definition(),
    run: run(),
    triggerPayload: { kind: 'schedule' },
  })

  assert.equal(result.status, 'running')
  assert.equal(result.workspaceId, 'ws-created')
  assert.equal(result.agentId, 'agent-1')
  assert.equal(typeof result.promptFingerprint, 'string')
  assert.equal('prompt' in result, false, 'full prompt is not persisted on the run patch')
  assert.deepEqual(harness.requests.map((request) => request.kind), ['workspace.create', 'agent.launch'])

  const create = harness.requests[0]
  assert.equal(create.kind, 'workspace.create')
  assert.equal(create.kind === 'workspace.create' ? create.mode : '', 'automations-host',
    'host route creates the workspace with explicit automations-host mode')
  assert.equal(harness.workspaces.find((entry) => entry.id === 'ws-created')?.mode, 'automations-host')

  const launch = harness.requests[1]
  assert.equal(launch.kind, 'agent.launch')
  assert.match(launch.kind === 'agent.launch' ? launch.prompt ?? '' : '', /review_only/)
  assert.match(launch.kind === 'agent.launch' ? launch.prompt ?? '' : '', /Do not edit files/)
  assert.equal(harness.workspaces.find((entry) => entry.id === 'ws-created')?.agents['agent-1']?.cliHasLaunched, true)
}

async function assertDefaultRunReusesExistingHostWorkspace(): Promise<void> {
  // A second run for the same folder reuses the open host — no duplicate host,
  // no workspace.create.
  const host = workspace('ws-host', '/repo/a', { mode: 'automations-host' })
  const harness = executorHarness([host])
  const result = await harness.executor({
    workspaceRoot: '/repo/a',
    definition: definition(),
    run: run(),
    triggerPayload: { kind: 'schedule' },
  })

  assert.equal(result.status, 'running')
  assert.equal(result.workspaceId, 'ws-host')
  assert.equal(result.agentId, 'agent-1')
  assert.deepEqual(harness.requests.map((request) => request.kind), ['agent.launch'])
  const launch = harness.requests[0]
  assert.equal(launch.kind, 'agent.launch')
  assert.equal(launch.kind === 'agent.launch' ? launch.workspaceId : '', 'ws-host')
}

async function assertDefaultRunNeverHijacksStandardWorkspace(): Promise<void> {
  // A folder-matched standard workspace must not be reused or mutated by a
  // default automation run; the run creates its own host instead.
  const standard = workspace('ws-standard', '/repo/a')
  const harness = executorHarness([standard])
  const result = await harness.executor({
    workspaceRoot: '/repo/a',
    definition: definition(),
    run: run(),
    triggerPayload: { kind: 'schedule' },
  })

  assert.equal(result.status, 'running')
  assert.equal(result.workspaceId, 'ws-created')
  assert.deepEqual(harness.requests.map((request) => request.kind), ['workspace.create', 'agent.launch'])
  assert.equal(harness.workspaces.find((entry) => entry.id === 'ws-created')?.mode, 'automations-host')
  assert.equal(Object.keys(standard.agents).length, 0, 'the standard workspace is never hijacked')
}

async function assertExplicitConfigWorkspaceIdLaunchesIntoNamedWorkspace(): Promise<void> {
  // An explicit config workspaceId (legacy/MCP) wins over the host route and
  // launches into that named standard workspace; the host is untouched.
  const host = workspace('ws-host', '/repo/a', { mode: 'automations-host' })
  const standardWorkspace = workspace('ws-standard', '/repo/a')
  const harness = executorHarness([host, standardWorkspace])
  const result = await harness.executor({
    workspaceRoot: '/repo/a',
    definition: definition({
      action: { kind: 'spawn-agent', config: { workspaceId: 'ws-standard', prompt: 'Review the repo.' } },
    }),
    run: run(),
    triggerPayload: { kind: 'schedule' },
  })

  assert.equal(result.status, 'running')
  assert.equal(result.workspaceId, 'ws-standard')
  assert.deepEqual(harness.requests.map((request) => request.kind), ['agent.launch'])
  assert.equal(Object.keys(host.agents).length, 0)
}

async function assertExecutionIdRecordedWhenResolvable(): Promise<void> {
  // The executor resolves the launched agent's terminal executionId at
  // launch-confirm time and records it on the run patch for exit-correlation.
  const host = workspace('ws-host', '/repo/a', { mode: 'automations-host' })
  const calls: Array<{ workspaceId: string; agentId: string }> = []
  const harness = executorHarness([host], {
    resolveAgentExecutionId: (input) => {
      calls.push(input)
      return 'exec-from-runtime'
    },
  })
  const result = await harness.executor({
    workspaceRoot: '/repo/a',
    definition: definition(),
    run: run(),
    triggerPayload: { kind: 'schedule' },
  })

  assert.equal(result.status, 'running')
  assert.equal(result.executionId, 'exec-from-runtime')
  // Resolved against the confirmed (workspaceId, agentId), not raw config.
  assert.deepEqual(calls, [{ workspaceId: 'ws-host', agentId: 'agent-1' }])
}

async function assertExecutionIdMissDoesNotFailLaunch(): Promise<void> {
  // A resolution miss (agent not yet on the runtime, or no resolver) leaves
  // executionId undefined and must NOT fail the launch — the poll-scan covers it.
  const host = workspace('ws-host', '/repo/a', { mode: 'automations-host' })
  const harness = executorHarness([host], {
    resolveAgentExecutionId: () => undefined,
  })
  const result = await harness.executor({
    workspaceRoot: '/repo/a',
    definition: definition(),
    run: run(),
    triggerPayload: { kind: 'schedule' },
  })

  assert.equal(result.status, 'running')
  assert.equal(result.agentId, 'agent-1')
  assert.equal(result.executionId, undefined)
  assert.equal('executionId' in result, true, 'executionId key present even on a miss')
}

async function assertExecutionIdAbsentWithoutResolver(): Promise<void> {
  // With no resolver wired (the executor's default), the launch still succeeds
  // and the run simply carries no executionId.
  const host = workspace('ws-host', '/repo/a', { mode: 'automations-host' })
  const harness = executorHarness([host])
  const result = await harness.executor({
    workspaceRoot: '/repo/a',
    definition: definition(),
    run: run(),
    triggerPayload: { kind: 'schedule' },
  })

  assert.equal(result.status, 'running')
  assert.equal(result.executionId, undefined)
}

async function assertRunWorktreeIsThreadedToLaunchAndPatch(): Promise<void> {
  // When the executor creates a per-run worktree, the agent launches with that
  // worktree path and the run patch records worktreePath + branch.
  const host = workspace('ws-host', '/repo/a', { mode: 'automations-host' })
  const harness = executorHarness([host], {
    createRunWorktree: async (input) => ({
      worktreePath: `/repo/a/.multi-code/automations/worktrees/${input.runId}`,
      branch: `automations/${input.runId}`,
    }),
  })
  const result = await harness.executor({
    workspaceRoot: '/repo/a',
    definition: definition({ autonomyDefault: 'allow_changes' }),
    run: run(),
    triggerPayload: { kind: 'schedule' },
  })

  assert.equal(result.status, 'running')
  assert.equal(result.worktreePath, '/repo/a/.multi-code/automations/worktrees/run-1')
  assert.equal(result.branch, 'automations/run-1')

  const launch = harness.requests[0]
  assert.equal(launch.kind, 'agent.launch')
  assert.equal(
    launch.kind === 'agent.launch' ? launch.worktreePath : '',
    '/repo/a/.multi-code/automations/worktrees/run-1',
  )
}

async function assertDirtyWorkspaceNoLongerBlocksLaunch(): Promise<void> {
  // The dirty-tree gate was removed: agent-backed runs execute in their own
  // worktree, so uncommitted changes in the checkout must not block a launch.
  const host = workspace('ws-host', '/repo/dirty', {
    mode: 'automations-host',
    editorState: {
      activeFilePath: '/repo/dirty/file.ts',
      openFiles: [{ path: '/repo/dirty/file.ts', name: 'file.ts', language: 'ts', isDirty: true }],
    },
  })
  const harness = executorHarness([host])
  const result = await harness.executor({
    workspaceRoot: '/repo/dirty',
    definition: definition({
      autonomyDefault: 'allow_changes',
      action: { kind: 'spawn-agent', config: { folderPath: '/repo/dirty', prompt: 'Fix this.' } },
    }),
    run: run(),
    triggerPayload: { kind: 'schedule' },
  })

  assert.equal(result.status, 'running')
  assert.equal(result.agentId, 'agent-1')
  assert.deepEqual(harness.requests.map((request) => request.kind), ['agent.launch'])
}

async function assertNonGitWorkspaceNoLongerBlocksLaunch(): Promise<void> {
  const folderPath = await mkdtemp(join(tmpdir(), 'multicode-automations-non-git-'))
  const host = workspace('ws-host', folderPath, { mode: 'automations-host' })
  const harness = executorHarness([host])
  const result = await harness.executor({
    workspaceRoot: folderPath,
    definition: definition({
      autonomyDefault: 'allow_changes',
      action: { kind: 'spawn-agent', config: { folderPath, prompt: 'Fix this.' } },
    }),
    run: run(),
    triggerPayload: { kind: 'schedule' },
  })

  assert.equal(result.status, 'running')
  assert.deepEqual(harness.requests.map((request) => request.kind), ['agent.launch'])
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

async function assertDeniedKindCollisionUsesBlockedWrapperDispatch(): Promise<void> {
  const requests: AutomationRendererRequest[] = []
  let originalProviderRunCount = 0
  const collisionProvider: AutomationActionProvider = {
    kind: 'spawn-agent',
    configSchema: { type: 'object' },
    run: async () => {
      originalProviderRunCount += 1
      return { status: 'completed', summary: 'Denied third-party provider must not run.' }
    },
  }
  const registrations: RegisteredAutomationProvider<AutomationActionProvider>[] = [{
    providerId: 'weather-deck.spawn-agent',
    moduleId: 'weather-deck',
    providerType: 'action',
    kind: 'spawn-agent',
    configSchema: { type: 'object' },
    requiredIntegrations: [],
    provider: collisionProvider,
  }]
  const denyProvider: AutomationProviderPermissionChecker = () => ({
    ok: false,
    reason: 'Module "weather-deck" is not trusted in Settings -> Modules.',
  })
  const executor = createLocalAutomationExecutor({
    delegateToRenderer: async (request) => {
      requests.push(request)
      return { ok: false, code: 'should_not_launch', message: 'should not launch' }
    },
    getWorkspaceSyncSnapshot: () => snapshot([workspace('ws-clean', '/repo/a')]),
    actionProviderRegistrations: registrations,
    checkProviderPermission: denyProvider,
    sleep: async () => undefined,
  })

  const result = await executor({
    workspaceRoot: '/repo/a',
    definition: definition({
      action: { kind: 'spawn-agent', config: { folderPath: '/repo/a', prompt: 'Should not launch.' } },
    }),
    run: run(),
    triggerPayload: { kind: 'schedule' },
  })

  assert.equal(result.status, 'blocked')
  assert.match(result.blockedReason ?? '', /not trusted/)
  assert.equal(originalProviderRunCount, 0)
  assert.deepEqual(requests, [], 'denied kind-collision wrapper must not reach spawn-agent launch')
}

async function assertDeniedBuiltInSpawnAgentUsesBlockedWrapperDispatch(): Promise<void> {
  const requests: AutomationRendererRequest[] = []
  const registry = createBuiltInAutomationProviderRegistry()
  const denySpawnAgent: AutomationProviderPermissionChecker = (registration) => {
    if (registration.providerId === 'automations.spawn-agent') {
      return {
        ok: false,
        reason: 'Built-in spawn-agent denied for regression coverage.',
      }
    }
    return { ok: true }
  }
  const executor = createLocalAutomationExecutor({
    delegateToRenderer: async (request) => {
      requests.push(request)
      return { ok: false, code: 'should_not_launch', message: 'should not launch' }
    },
    getWorkspaceSyncSnapshot: () => snapshot([workspace('ws-clean', '/repo/a')]),
    actionProviderRegistrations: registry.listActionProviderRegistrations(),
    checkProviderPermission: denySpawnAgent,
    sleep: async () => undefined,
  })

  const result = await executor({
    workspaceRoot: '/repo/a',
    definition: definition({
      action: { kind: 'spawn-agent', config: { folderPath: '/repo/a', prompt: 'Should not launch.' } },
    }),
    run: run(),
    triggerPayload: { kind: 'schedule' },
  })

  assert.equal(result.status, 'blocked')
  assert.match(result.blockedReason ?? '', /Built-in spawn-agent denied/)
  assert.deepEqual(requests, [], 'denied built-in wrapper must not reach spawn-agent launch')
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

  const harness = executorHarness([workspace('ws-loop', '/repo/loop', { mode: 'automations-host' })])
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

  assert.equal(result.status, 'running')
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

function watchtowerPresetEnum(provider: AutomationActionProvider): string[] {
  const properties = (provider.configSchema as { properties?: Record<string, unknown> }).properties
  const preset = properties?.preset as { enum?: unknown } | undefined
  assert.ok(Array.isArray(preset?.enum), 'watchtower-review schema should enumerate presets')
  assert.ok(preset.enum.every((value) => typeof value === 'string'), 'watchtower-review preset enum should contain strings')
  return preset.enum
}

async function assertWatchtowerSchemaOnlyAcceptsLaunchablePresets(): Promise<void> {
  const calls: string[] = []
  const actionProviders = firstPartyActionProviders(calls)
  const provider = actionProviders.find((candidate) => candidate.kind === WATCHTOWER_REVIEW_ACTION_KIND)
  assert.ok(provider, 'watchtower-review action provider should be registered')

  const acceptedPresets = watchtowerPresetEnum(provider)
  assert.deepEqual(acceptedPresets, LAUNCHABLE_WATCHTOWER_REVIEW_PRESETS)
  assert.equal(acceptedPresets.includes('custom'), false)

  const harness = executorHarness([workspace('ws-front-door', '/repo/a')], {
    actionProviders,
    isIntegrationAvailable: () => true,
  })
  for (const preset of acceptedPresets) {
    const result = await harness.executor({
      workspaceRoot: '/repo/a',
      definition: definition({ action: { kind: WATCHTOWER_REVIEW_ACTION_KIND, config: { preset } } }),
      run: run(),
      triggerPayload: { kind: 'schedule' },
    })
    assert.equal(result.status, 'completed', `accepted Watchtower preset should start: ${preset}`)
  }
  assert.deepEqual(calls, acceptedPresets.map((preset) => `watchtower:/repo/a:${preset}`))
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
  assert.equal(builtIns.getTriggerProvider(`automations.${WEBHOOK_TRIGGER_KIND}`)?.kind, WEBHOOK_TRIGGER_KIND)
  assert.equal(builtIns.getTriggerProvider(`switchboard.${REPO_EVENT_TRIGGER_KIND}`)?.kind, REPO_EVENT_TRIGGER_KIND)
  assert.equal(builtIns.getActionProvider('automations.spawn-agent')?.kind, 'spawn-agent')
  assert.equal(builtIns.getActionProvider('automations.run-skill-loop')?.kind, 'run-skill-loop')
  assert.equal(builtIns.getActionProvider(`switchboard.${SWITCHBOARD_RUNNER_TICK_ACTION_KIND}`)?.kind, SWITCHBOARD_RUNNER_TICK_ACTION_KIND)
  assert.equal(builtIns.getActionProvider(`switchboard.${WATCHTOWER_REVIEW_ACTION_KIND}`)?.kind, WATCHTOWER_REVIEW_ACTION_KIND)
  assert.equal(builtIns.getActionProvider(`sprint-engine.${SPRINT_ENGINE_RUN_ACTION_KIND}`)?.kind, SPRINT_ENGINE_RUN_ACTION_KIND)
  assert.equal(builtIns.getActionProvider('other.spawn-agent'), undefined)
  assert.deepEqual(builtIns.listTriggerProviders().map((provider) => provider.kind), [
    'schedule',
    WEBHOOK_TRIGGER_KIND,
    REPO_EVENT_TRIGGER_KIND,
  ])
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

async function initSignalTestRepo(): Promise<string> {
  // realpath resolves the macOS /var -> /private/var symlink so the path matches
  // git's reported worktree path (createGitWorktree compares them).
  const repoRoot = await realpath(await mkdtemp(join(tmpdir(), 'automations-signal-')))
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'test@example.com'],
    ['config', 'user.name', 'Test'],
    ['config', 'commit.gpgsign', 'false'],
  ]) {
    const result = await runGitCommand(repoRoot, args)
    assert.ok(result.ok, `git ${args.join(' ')} failed: ${result.message ?? ''}`)
  }
  await writeFile(join(repoRoot, 'seed.txt'), 'seed\n', 'utf8')
  assert.ok((await runGitCommand(repoRoot, ['add', 'seed.txt'])).ok)
  assert.ok((await runGitCommand(repoRoot, ['commit', '-qm', 'seed'])).ok)
  return repoRoot
}

async function countSignalExcludeEntries(worktreePath: string): Promise<number> {
  const resolved = await runGitCommand(worktreePath, ['rev-parse', '--git-path', 'info/exclude'])
  assert.ok(resolved.ok, 'rev-parse exclude path')
  const content = await readFile(resolved.stdout.trim(), 'utf8')
  return content.split('\n').filter((line) => line.trim() === RUN_SIGNAL_FILENAME).length
}

async function assertSignalFileExcludedInRealWorktree(): Promise<void> {
  // Real git integration: the signal file in the run's worktree must be invisible
  // to both `git status` and `git add -A` so it never lands in the run's PR.
  const repoRoot = await initSignalTestRepo()
  try {
    const created = await defaultCreateRunWorktree({ workspaceRoot: repoRoot, runId: 'run-excl' })
    assert.ok(created, 'worktree created')
    await writeFile(join(created!.worktreePath, RUN_SIGNAL_FILENAME), '{"status":"completed"}\n', 'utf8')

    const status = await runGitCommand(created!.worktreePath, ['status', '--porcelain'])
    assert.ok(status.ok)
    assert.ok(
      !status.stdout.includes(RUN_SIGNAL_FILENAME),
      `signal file must not appear in git status, got: ${status.stdout}`
    )

    const addDryRun = await runGitCommand(created!.worktreePath, ['add', '-A', '-n'])
    assert.ok(addDryRun.ok)
    assert.ok(
      !addDryRun.stdout.includes(RUN_SIGNAL_FILENAME),
      `signal file must not be staged by git add -A, got: ${addDryRun.stdout}`
    )
    assert.equal(await countSignalExcludeEntries(created!.worktreePath), 1, 'exclude written once on creation')
  } finally {
    await rm(repoRoot, { recursive: true, force: true })
  }
}

async function assertSignalExcludeIsIdempotent(): Promise<void> {
  const repoRoot = await initSignalTestRepo()
  try {
    const created = await defaultCreateRunWorktree({ workspaceRoot: repoRoot, runId: 'run-idem' })
    assert.ok(created, 'worktree created')
    assert.equal(await countSignalExcludeEntries(created!.worktreePath), 1, 'one entry after creation')
    // Re-running the exclude step must not duplicate the entry.
    await excludeRunSignalFromWorktree(created!.worktreePath)
    await excludeRunSignalFromWorktree(created!.worktreePath)
    assert.equal(await countSignalExcludeEntries(created!.worktreePath), 1, 'still one entry after repeats')
  } finally {
    await rm(repoRoot, { recursive: true, force: true })
  }
}

async function assertWorktreeReturnedWhenExcludeWriteFails(): Promise<void> {
  // A failed exclude write is best-effort: the run still gets its worktree.
  const repoRoot = await initSignalTestRepo()
  try {
    const created = await defaultCreateRunWorktree(
      { workspaceRoot: repoRoot, runId: 'run-fail' },
      async () => {
        throw new Error('simulated exclude write failure')
      }
    )
    assert.ok(created, 'worktree still returned despite exclude failure')
    assert.equal(created!.branch, 'automations/run-fail')
    assert.ok(created!.worktreePath.includes('run-fail'))
  } finally {
    await rm(repoRoot, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})

async function main(): Promise<void> {
  assertBuiltInProviderRegistryUsesNamespacedIdsAndRejectsDuplicates()
  await assertDefaultRunCreatesHostWorkspaceAndLaunchesOnBus()
  await assertDefaultRunReusesExistingHostWorkspace()
  await assertDefaultRunNeverHijacksStandardWorkspace()
  await assertExplicitConfigWorkspaceIdLaunchesIntoNamedWorkspace()
  await assertRunWorktreeIsThreadedToLaunchAndPatch()
  await assertExecutionIdRecordedWhenResolvable()
  await assertExecutionIdMissDoesNotFailLaunch()
  await assertExecutionIdAbsentWithoutResolver()
  await assertDirtyWorkspaceNoLongerBlocksLaunch()
  await assertNonGitWorkspaceNoLongerBlocksLaunch()
  await assertMissingIntegrationBlocksWithoutFakeSuccess()
  await assertRequiredIntegrationFailsClosed()
  await assertDeniedKindCollisionUsesBlockedWrapperDispatch()
  await assertDeniedBuiltInSpawnAgentUsesBlockedWrapperDispatch()
  await assertUnknownWorkspaceIdDoesNotCreateFallbackWorkspace()
  await assertRunSkillLoopIsPresetAndRunCommandIsNotRegistered()
  await assertFirstPartyActionsInvokeFrontDoors()
  await assertWatchtowerSchemaOnlyAcceptsLaunchablePresets()
  await assertFirstPartyMissingIntegrationBlocksBeforeFrontDoor()
  await assertSignalFileExcludedInRealWorktree()
  await assertSignalExcludeIsIdempotent()
  await assertWorktreeReturnedWhenExcludeWriteFails()
}
