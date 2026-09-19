import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentLaunchRequest, AgentLaunchResult } from '../../shared/agent-launch'
import type { AutomationActionProvider, AutomationDefinition, AutomationRun } from '../../shared/automations/contracts'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import type { Workspace } from '../../renderer/src/types/workspace'
import { AUTOMATIONS_HOST_WORKSPACE_MODE } from '../../shared/workspace-mode'
import type { WorkspaceCreateRequest } from '../workspace-registry-service'
import type { WorkspaceMutationActor } from '../workspace-sync-service'
import {
  RunWorktreeUnavailableError,
  createBuiltInAutomationActionProviders,
  createLocalAutomationExecutor,
  defaultCreateRunWorktree,
  type LocalAutomationExecutorOptions,
} from './executor-local'
import { MCP_CONFIG_WORKTREE_EXCLUDE_ENTRIES, excludeMcpConfigFromWorktree } from '../git'
import { runGitCommand } from '../git-utils'
import {
  AutomationProviderRegistrationError,
  type AutomationProviderPermissionChecker,
  createAutomationProviderRegistry,
  createBuiltInAutomationProviderRegistry,
  namespacedProviderId,
  type RegisteredAutomationProvider,
} from './provider-registry'
import { WEBHOOK_TRIGGER_KIND } from './triggers/webhook'
import { test } from 'vitest'

test('executor-local', async () => {
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
      trigger: {
        kind: 'schedule',
        config: { kind: 'schedule', cadence: { type: 'interval', everyMinutes: 30 }, timezone: 'UTC' },
      },
      action: { kind: 'spawn-agent', config: { folderPath: '/repo/a', prompt: 'Review the repo.' } },
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

  // What the harness records, across BOTH outbound ports, each tagged with the
  // kind the retired renderer-delegate request used to carry so ordering
  // assertions read the same.
  type RecordedExecutorRequest =
    | ({ kind: 'agent.launch' } & AgentLaunchRequest)
    | ({ kind: 'workspace.create'; actor: WorkspaceMutationActor } & WorkspaceCreateRequest)

  // The negative-path port set: every outbound port records and refuses, so a
  // test asserting "this never launched" fails loudly if the executor reaches any
  // of them. Agent launch became a main-process port in MC-2159 and workspace
  // creation in MC-2158, so both are covered here.
  function refusingPorts(requests: RecordedExecutorRequest[]) {
    return {
      createWorkspace: ((input, actor) => {
        requests.push({ kind: 'workspace.create', ...input, actor })
        return { ok: false, reason: 'should_not_launch', message: 'should not launch' }
      }) as LocalAutomationExecutorOptions['createWorkspace'],
      launchAgent: async (request: AgentLaunchRequest): Promise<AgentLaunchResult> => {
        requests.push({ kind: 'agent.launch', ...request })
        return { ok: false, code: 'should_not_launch', message: 'should not launch' }
      },
    }
  }

  function executorHarness(
    initialWorkspaces: Workspace[] = [],
    options: {
      actionProviders?: LocalAutomationExecutorOptions['actionProviders']
      isIntegrationAvailable?: LocalAutomationExecutorOptions['isIntegrationAvailable']
      createRunWorktree?: LocalAutomationExecutorOptions['createRunWorktree']
      resolveAgentExecutionId?: LocalAutomationExecutorOptions['resolveAgentExecutionId']
      executionIdTimeoutMs?: LocalAutomationExecutorOptions['executionIdTimeoutMs']
    } = {},
  ) {
    const workspaces = [...initialWorkspaces]
    // Both ports land in one ordered list so a test can still assert "created the
    // workspace, THEN launched into it". `agent.launch` is no longer a renderer
    // request (MC-2159) — it goes through the main-owned launch port below — but
    // recording it in the same shape keeps the ordering assertions honest.
    const requests: RecordedExecutorRequest[] = []

    // Workspace creation is main's (MC-2158): the executor calls the registry
    // rather than asking a window and polling the bus. Recorded in the same
    // ordered list so "created the host, THEN launched into it" still asserts.
    const createWorkspace: LocalAutomationExecutorOptions['createWorkspace'] = (input, actor) => {
      requests.push({ kind: 'workspace.create', ...input, actor })
      const existing = input.mode
        ? workspaces.find(
            (candidate) =>
              candidate.mode === input.mode && (candidate.folderPath ?? null) === (input.folderPath ?? null),
          )
        : undefined
      // Reuse is main's call and holds across callers, so the fake honours it too.
      if (existing) {
        return {
          ok: true,
          result: {
            workspace: existing as never,
            windowId: 'primary',
            folderPath: input.folderPath ?? null,
            reused: true,
          },
        }
      }
      const id = 'ws-created'
      const created = workspace(id, input.folderPath ?? null, {
        name: input.name ?? id,
        mode: input.mode ?? 'standard',
      })
      workspaces.push(created)
      return {
        ok: true,
        result: {
          workspace: created as never,
          windowId: 'primary',
          folderPath: input.folderPath ?? null,
          reused: false,
        },
      }
    }

    // Stands in for the main-process AgentLaunchService: composes nothing, but
    // mints the ids and the agent record a real launch would leave behind, so the
    // executor's post-launch correlation has the same surface to read.
    const launchAgent = async (request: AgentLaunchRequest): Promise<AgentLaunchResult> => {
      requests.push({ kind: 'agent.launch', ...request })
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
      return {
        ok: true,
        workspaceId: request.workspaceId,
        agentId,
        sessionId: `session-${agentId}`,
        cli: request.cli ?? 'claude-code',
        executionId: `session-${agentId}`,
      }
    }

    return {
      requests,
      workspaces,
      executor: createLocalAutomationExecutor({
        createWorkspace,
        launchAgent,
        getWorkspaceSyncSnapshot: () => snapshot(workspaces),
        now: (() => {
          let current = 0
          return () => {
            current += 30_000
            return current
          }
        })(),
        sleep: async () => undefined,
        // Hermetic by default: no real `git worktree` subprocess in unit tests, but
        // the run still gets the isolation it asked for — a run that cannot get a
        // worktree is blocked now, so "no worktree" is not a neutral default.
        createRunWorktree:
          options.createRunWorktree ??
          (async (input) => ({
            worktreePath: `${input.workspaceRoot}/.sprintengine/automations/worktrees/${input.runId}`,
            branch: `automations/${input.runId}`,
          })),
        ...(options.actionProviders ? { actionProviders: options.actionProviders } : {}),
        ...(options.isIntegrationAvailable ? { isIntegrationAvailable: options.isIntegrationAvailable } : {}),
        ...(options.resolveAgentExecutionId ? { resolveAgentExecutionId: options.resolveAgentExecutionId } : {}),
        ...(options.executionIdTimeoutMs ? { executionIdTimeoutMs: options.executionIdTimeoutMs } : {}),
      }),
    }
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
    assert.deepEqual(
      harness.requests.map((request) => request.kind),
      ['workspace.create', 'agent.launch'],
    )

    const create = harness.requests[0]
    assert.equal(create.kind, 'workspace.create')
    assert.equal(
      create.kind === 'workspace.create' ? create.mode : '',
      'automations-host',
      'host route creates the workspace with explicit automations-host mode',
    )
    assert.equal(harness.workspaces.find((entry) => entry.id === 'ws-created')?.mode, 'automations-host')

    const launch = harness.requests[1]
    assert.equal(launch.kind, 'agent.launch')
    assert.match(
      launch.kind === 'agent.launch' ? (launch.prompt ?? '') : '',
      /You may modify files only when the requested task requires it\./,
    )
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
    assert.deepEqual(
      harness.requests.map((request) => request.kind),
      ['agent.launch'],
    )
    const launch = harness.requests[0]
    assert.equal(launch.kind, 'agent.launch')
    assert.equal(launch.kind === 'agent.launch' ? launch.workspaceId : '', 'ws-host')
  }

  async function assertDefaultRunReusesRestartRestoredHost(): Promise<void> {
    // Before MC-2158 this was the hardest case in the file: after a restart main
    // rebuilt every workspace as a routing placeholder reading mode 'standard',
    // so the executor's host-by-folder lookup MISSED, it delegated a create, and
    // the renderer had to report the reused host's real mode back for the run's
    // host-mode assertion to pass. Main owns the registry now, so a restart
    // survivor carries its real mode and the lookup simply hits — the run reaches
    // its host with no create at all.
    const restoredHost = workspace('ws-restored-host', '/repo/a', {
      mode: AUTOMATIONS_HOST_WORKSPACE_MODE,
      name: 'Automations',
    })
    const harness = executorHarness([restoredHost])
    const result = await harness.executor({
      workspaceRoot: '/repo/a',
      definition: definition(),
      run: run(),
      triggerPayload: { kind: 'schedule' },
    })

    assert.equal(
      result.status,
      'running',
      `restored-host run must launch, got: ${result.summary ?? result.blockedReason ?? ''}`,
    )
    assert.equal(result.workspaceId, 'ws-restored-host')
    assert.deepEqual(
      harness.requests.map((request) => request.kind),
      ['agent.launch'],
      'a restart survivor needs no create: main never lost its mode',
    )
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
    assert.deepEqual(
      harness.requests.map((request) => request.kind),
      ['workspace.create', 'agent.launch'],
    )
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
    assert.deepEqual(
      harness.requests.map((request) => request.kind),
      ['agent.launch'],
    )
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

  async function assertExecutionIdResolvesAfterPtySpawnRace(): Promise<void> {
    // The pty is spawned after the workspace-sync bus confirms the agent, so the
    // terminal session (and its executionId) can register only after launch-confirm.
    // The executor polls until it appears rather than probing once and missing.
    const host = workspace('ws-host', '/repo/a', { mode: 'automations-host' })
    let probes = 0
    const harness = executorHarness([host], {
      executionIdTimeoutMs: 600_000,
      resolveAgentExecutionId: () => {
        probes += 1
        return probes < 3 ? undefined : 'exec-late'
      },
    })
    const result = await harness.executor({
      workspaceRoot: '/repo/a',
      definition: definition(),
      run: run(),
      triggerPayload: { kind: 'schedule' },
    })

    assert.equal(result.status, 'running')
    assert.equal(result.executionId, 'exec-late', 'executionId resolved by the bounded poll')
    assert.equal(probes, 3, 'polled until the terminal session registered')
  }

  async function assertExecutionIdMissDoesNotFailLaunch(): Promise<void> {
    // A permanent resolution miss (the CLI never registers a session) leaves
    // executionId undefined and must NOT fail the launch — the run still correlates
    // on (workspaceId, agentId).
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
        worktreePath: `/repo/a/.sprintengine/automations/worktrees/${input.runId}`,
        branch: `automations/${input.runId}`,
      }),
    })
    const result = await harness.executor({
      workspaceRoot: '/repo/a',
      definition: definition(),
      run: run(),
      triggerPayload: { kind: 'schedule' },
    })

    assert.equal(result.status, 'running')
    assert.equal(result.worktreePath, '/repo/a/.sprintengine/automations/worktrees/run-1')
    assert.equal(result.branch, 'automations/run-1')

    const launch = harness.requests[0]
    assert.equal(launch.kind, 'agent.launch')
    assert.equal(
      launch.kind === 'agent.launch' ? launch.worktreePath : '',
      '/repo/a/.sprintengine/automations/worktrees/run-1',
    )
  }

  async function assertConnectorRunForcesWorktreeAndThreadsConnectorId(): Promise<void> {
    // A connectorId forces a per-run worktree even when the definition opts out
    // (runInWorktree === false) and threads the connectorId to the launch so the
    // renderer resolves the connector MCP + skill for the isolated environment.
    const host = workspace('ws-host', '/repo/a', { mode: 'automations-host' })
    const harness = executorHarness([host], {
      createRunWorktree: async (input) => ({
        worktreePath: `/repo/a/.sprintengine/automations/worktrees/${input.runId}`,
        branch: `automations/${input.runId}`,
      }),
    })
    const result = await harness.executor({
      workspaceRoot: '/repo/a',
      definition: definition({
        runInWorktree: false,
        action: {
          kind: 'spawn-agent',
          config: { folderPath: '/repo/a', prompt: 'Deploy the service.', connectorId: 'railway' },
        },
      }),
      run: run(),
      triggerPayload: { kind: 'schedule' },
    })

    assert.equal(result.status, 'running')
    // The connectorId overrode runInWorktree === false — the run still got a worktree.
    assert.equal(result.worktreePath, '/repo/a/.sprintengine/automations/worktrees/run-1')
    const launch = harness.requests[0]
    assert.equal(launch.kind, 'agent.launch')
    assert.equal(launch.kind === 'agent.launch' ? launch.connectorId : '', 'railway')
    assert.equal(
      launch.kind === 'agent.launch' ? launch.worktreePath : '',
      '/repo/a/.sprintengine/automations/worktrees/run-1',
      'connector launch runs in the forced worktree',
    )
  }

  async function assertConnectorRunWithoutWorktreeFailsClosed(): Promise<void> {
    // Data-safety invariant: a connector run whose worktree cannot be created FAILS
    // rather than falling back to the workspace checkout. The connector's `.mcp.json`
    // must never be written into the user's real checkout, so no launch is delegated.
    const host = workspace('ws-host', '/repo/a', { mode: 'automations-host' })
    const harness = executorHarness([host], {
      createRunWorktree: async () => {
        throw new RunWorktreeUnavailableError('not_a_git_repository', 'Choose a folder inside a Git repository.')
      },
    })
    const result = await harness.executor({
      workspaceRoot: '/repo/a',
      definition: definition({
        action: {
          kind: 'spawn-agent',
          config: { folderPath: '/repo/a', prompt: 'Deploy the service.', connectorId: 'railway' },
        },
      }),
      run: run(),
      triggerPayload: { kind: 'schedule' },
    })

    assert.equal(result.status, 'blocked')
    assert.match(result.blockedReason ?? '', /railway/)
    assert.match(result.blockedReason ?? '', /isolated worktree/)
    assert.match(result.blockedReason ?? '', /is not a git repository/)
    assert.deepEqual(harness.requests, [], 'connector run without a worktree never delegates a launch')
  }

  async function assertNonConnectorRunHonorsRunInWorktreeOptOut(): Promise<void> {
    // Regression guard for the no-connectorId path: runInWorktree === false with no
    // connectorId still launches directly (no worktree, no failure) — the connector
    // branch must not have changed baseline spawn behaviour.
    const host = workspace('ws-host', '/repo/a', { mode: 'automations-host' })
    // The opt-out never asks for a worktree at all, so the harness creator is not
    // consulted: the run launches directly in the checkout, by the user's choice.
    const harness = executorHarness([host])
    const result = await harness.executor({
      workspaceRoot: '/repo/a',
      definition: definition({
        runInWorktree: false,
        action: { kind: 'spawn-agent', config: { folderPath: '/repo/a', prompt: 'Review the repo.' } },
      }),
      run: run(),
      triggerPayload: { kind: 'schedule' },
    })

    assert.equal(result.status, 'running')
    assert.equal(result.worktreePath, undefined, 'opt-out run carries no worktree')
    const launch = harness.requests[0]
    assert.equal(launch.kind, 'agent.launch')
    assert.equal(launch.kind === 'agent.launch' ? launch.connectorId : 'unset', undefined)
    assert.equal(launch.kind === 'agent.launch' ? launch.worktreePath : 'unset', undefined)
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
        action: { kind: 'spawn-agent', config: { folderPath: '/repo/dirty', prompt: 'Fix this.' } },
      }),
      run: run(),
      triggerPayload: { kind: 'schedule' },
    })

    assert.equal(result.status, 'running')
    assert.equal(result.agentId, 'agent-1')
    assert.deepEqual(
      harness.requests.map((request) => request.kind),
      ['agent.launch'],
    )
  }

  async function assertNonGitWorkspaceNoLongerBlocksLaunch(): Promise<void> {
    const folderPath = await mkdtemp(join(tmpdir(), 'multicode-automations-non-git-'))
    const host = workspace('ws-host', folderPath, { mode: 'automations-host' })
    const harness = executorHarness([host])
    const result = await harness.executor({
      workspaceRoot: folderPath,
      definition: definition({
        action: { kind: 'spawn-agent', config: { folderPath, prompt: 'Fix this.' } },
      }),
      run: run(),
      triggerPayload: { kind: 'schedule' },
    })

    assert.equal(result.status, 'running')
    assert.deepEqual(
      harness.requests.map((request) => request.kind),
      ['agent.launch'],
    )
  }

  async function assertMissingIntegrationBlocksWithoutFakeSuccess(): Promise<void> {
    const cleanWorkspace = workspace('ws-clean', '/repo/a')
    const requests: RecordedExecutorRequest[] = []
    const executor = createLocalAutomationExecutor({
      ...refusingPorts(requests),
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
    const requests: RecordedExecutorRequest[] = []
    const unknownResolverExecutor = createLocalAutomationExecutor({
      ...refusingPorts(requests),
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
    const requests: RecordedExecutorRequest[] = []
    let originalProviderRunCount = 0
    const collisionProvider: AutomationActionProvider = {
      kind: 'spawn-agent',
      configSchema: { type: 'object' },
      run: async () => {
        originalProviderRunCount += 1
        return { status: 'completed', summary: 'Denied third-party provider must not run.' }
      },
    }
    const registrations: RegisteredAutomationProvider<AutomationActionProvider>[] = [
      {
        providerId: 'weather-deck.spawn-agent',
        moduleId: 'weather-deck',
        providerType: 'action',
        kind: 'spawn-agent',
        configSchema: { type: 'object' },
        requiredIntegrations: [],
        provider: collisionProvider,
      },
    ]
    const denyProvider: AutomationProviderPermissionChecker = () => ({
      ok: false,
      reason: 'Module "weather-deck" is not trusted in Settings -> Modules.',
    })
    const executor = createLocalAutomationExecutor({
      ...refusingPorts(requests),
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
    const requests: RecordedExecutorRequest[] = []
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
      ...refusingPorts(requests),
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
    assert.match(launch.kind === 'agent.launch' ? (launch.prompt ?? '') : '', /^\/loop backlog/m)
    assert.match(
      launch.kind === 'agent.launch' ? (launch.prompt ?? '') : '',
      /You may modify files only when the requested task requires it\./,
    )
  }

  function assertBuiltInProviderRegistryUsesNamespacedIdsAndRejectsDuplicates(): void {
    const builtIns = createBuiltInAutomationProviderRegistry()
    assert.equal(namespacedProviderId('automations', 'schedule'), 'automations.schedule')
    assert.equal(builtIns.getTriggerProvider('automations.schedule')?.kind, 'schedule')
    assert.equal(builtIns.getTriggerProvider(`automations.${WEBHOOK_TRIGGER_KIND}`)?.kind, WEBHOOK_TRIGGER_KIND)
    assert.equal(builtIns.getActionProvider('automations.spawn-agent')?.kind, 'spawn-agent')
    assert.equal(builtIns.getActionProvider('automations.run-skill-loop')?.kind, 'run-skill-loop')
    assert.equal(builtIns.getActionProvider('other.spawn-agent'), undefined)
    assert.deepEqual(
      builtIns.listTriggerProviders().map((provider) => provider.kind),
      ['schedule', WEBHOOK_TRIGGER_KIND],
    )
    assert.deepEqual(
      builtIns.listActionProviders().map((provider) => provider.kind),
      ['spawn-agent', 'run-skill-loop'],
    )

    const duplicateRegistry = createAutomationProviderRegistry()
    const duplicateProvider: AutomationActionProvider = {
      kind: 'spawn-agent',
      configSchema: {},
      run: async () => ({}),
    }
    assert.equal(duplicateRegistry.registerActionProvider('automations', duplicateProvider), 'automations.spawn-agent')
    assert.throws(
      () => duplicateRegistry.registerActionProvider('automations', duplicateProvider),
      (error) =>
        error instanceof AutomationProviderRegistrationError &&
        error.providerId === 'automations.spawn-agent' &&
        /Duplicate automation action provider registration/.test(error.message),
    )
  }

  async function initWorktreeTestRepo(): Promise<string> {
    // realpath resolves the macOS /var -> /private/var symlink so the path matches
    // git's reported worktree path (createGitWorktree compares them).
    const repoRoot = await realpath(await mkdtemp(join(tmpdir(), 'automations-worktree-')))
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

  async function assertMcpConfigExcludedInRealWorktree(): Promise<void> {
    // Connector-worktree exclusion: the generated managed MCP config
    // (`.mcp.json` + `.codex/config.toml`) must be invisible to git so it never
    // shows up in the connector chat's `git status` or commits. Real git worktree.
    const repoRoot = await initWorktreeTestRepo()
    try {
      const created = await defaultCreateRunWorktree({ workspaceRoot: repoRoot, runId: 'run-mcp' })
      assert.ok(created, 'worktree created')
      await excludeMcpConfigFromWorktree(created!.worktreePath)

      const resolved = await runGitCommand(created!.worktreePath, ['rev-parse', '--git-path', 'info/exclude'])
      assert.ok(resolved.ok, 'rev-parse exclude path')
      const content = await readFile(resolved.stdout.trim(), 'utf8')
      for (const entry of MCP_CONFIG_WORKTREE_EXCLUDE_ENTRIES) {
        assert.ok(
          content.split('\n').some((line) => line.trim() === entry),
          `info/exclude must contain ${entry}, got: ${content}`,
        )
      }

      // The excluded files must not surface in git status once present on disk.
      await writeFile(join(created!.worktreePath, '.mcp.json'), '{"servers":{}}\n', 'utf8')
      const status = await runGitCommand(created!.worktreePath, ['status', '--porcelain'])
      assert.ok(status.ok)
      assert.ok(!status.stdout.includes('.mcp.json'), `.mcp.json must not appear in git status, got: ${status.stdout}`)

      // Idempotent: a repeat call does not duplicate the entries.
      await excludeMcpConfigFromWorktree(created!.worktreePath)
      const after = await readFile(resolved.stdout.trim(), 'utf8')
      for (const entry of MCP_CONFIG_WORKTREE_EXCLUDE_ENTRIES) {
        assert.equal(
          after.split('\n').filter((line) => line.trim() === entry).length,
          1,
          `${entry} must appear exactly once after repeats`,
        )
      }
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  async function main(): Promise<void> {
    assertBuiltInProviderRegistryUsesNamespacedIdsAndRejectsDuplicates()
    await assertDefaultRunCreatesHostWorkspaceAndLaunchesOnBus()
    await assertDefaultRunReusesExistingHostWorkspace()
    await assertDefaultRunReusesRestartRestoredHost()
    await assertDefaultRunNeverHijacksStandardWorkspace()
    await assertExplicitConfigWorkspaceIdLaunchesIntoNamedWorkspace()
    await assertRunWorktreeIsThreadedToLaunchAndPatch()
    await assertConnectorRunForcesWorktreeAndThreadsConnectorId()
    await assertConnectorRunWithoutWorktreeFailsClosed()
    await assertNonConnectorRunHonorsRunInWorktreeOptOut()
    await assertExecutionIdRecordedWhenResolvable()
    await assertExecutionIdResolvesAfterPtySpawnRace()
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
    await assertMcpConfigExcludedInRealWorktree()
  }

  await suiteRun
})
