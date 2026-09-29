import assert from 'node:assert/strict'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMain } from 'electron'

import type {
  ConversationEvent,
  ConversationEventType,
  ConversationSessionSummary,
} from '../../shared/conversation-runtime'
import type {
  AutomationActionProvider,
  AutomationDefinition,
  AutomationRun,
  AutomationTriggerProvider,
  AutomationsProvidersResult,
} from '../../shared/automations/contracts'
import type {
  AutomationsEngine,
  AutomationsEngineEvaluationResult,
  AutomationsEngineOptions,
} from '../automations/engine'
import { AutomationsStore } from '../automations/store'
import { runGitCommand } from '../git-utils'
import type { ConversationLaunchRequest, ConversationLaunchResult } from '../conversation-launch-service'
import type { AutomationProviderPermissionChecker } from '../automations/provider-registry'
import type { CapabilityModule } from '../module-host/load-modules'
import type { IpcInvokeHandler } from '../module-host/main-host'
import { loadMainModules } from '../module-host/load-modules'
import {
  AutomationsProviderRegistryToken,
  ConversationLaunchServiceToken,
  ConversationRuntimeToken,
  WorkspaceSyncServiceToken,
} from '../module-host/service-tokens'
import {
  AUTOMATIONS_LIST_CHANNEL,
  AUTOMATIONS_PROVIDERS_LIST_CHANNEL,
  AUTOMATIONS_RUN_EVENT_CHANNEL,
} from '../../shared/automations/contracts'
import { WEBHOOK_TRIGGER_KIND } from '../automations/triggers/webhook'
import { broadcastAutomationsRunEvent, createAutomationsModule } from './automations-module'
import { everyAutomationApprovedLedger } from '../../../tests/automation-approvals'
import { test } from 'vitest'

test('automations-module', async () => {
  function createFakeIpcMain(): {
    ipcMain: IpcMain
    handled: string[]
    activeHandlers: Set<string>
    handlers: Map<string, IpcInvokeHandler>
  } {
    const handled: string[] = []
    const activeHandlers = new Set<string>()
    const handlers = new Map<string, IpcInvokeHandler>()
    const ipcMain = {
      handle(channel: string, handler: IpcInvokeHandler): void {
        handled.push(channel)
        activeHandlers.add(channel)
        handlers.set(channel, handler)
      },
      removeHandler(channel: string): void {
        activeHandlers.delete(channel)
        handlers.delete(channel)
      },
    } as unknown as IpcMain
    return { ipcMain, handled, activeHandlers, handlers }
  }

  type FakeConversationRuntime = {
    runtime: unknown
    listenerCount: () => number
    emit: (type: ConversationEventType, payload?: Record<string, unknown>) => void
    sessions: ConversationSessionSummary[]
    stopped: string[]
    transcriptReads: unknown[]
  }

  // Minimal conversation runtime exposing only the seams the automations module
  // uses: the event stream, the session list, stopping a session, and reading a
  // chat's transcript.
  function createFakeConversationRuntime(
    options: { sessions?: ConversationSessionSummary[]; transcript?: ConversationEvent[] } = {},
  ): FakeConversationRuntime {
    const listeners = new Set<(event: ConversationEvent) => void>()
    const sessions = options.sessions ?? []
    const stopped: string[] = []
    const transcriptReads: unknown[] = []
    let seq = 0
    const runtime = {
      onEvent: (listener: (event: ConversationEvent) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      listSessions: (input: { workspaceId?: string; agentId?: string } = {}) => ({
        ok: true,
        sessions: sessions.filter(
          (session) =>
            (!input.workspaceId || session.workspaceId === input.workspaceId) &&
            (!input.agentId || session.agentId === input.agentId),
        ),
      }),
      stopSession: async (input: { sessionId: string }) => {
        stopped.push(input.sessionId)
        return { ok: true }
      },
      readTranscript: async (input: unknown) => {
        transcriptReads.push(input)
        return { ok: true, events: options.transcript ?? [] }
      },
    }
    return {
      runtime,
      listenerCount: () => listeners.size,
      emit: (type, payload) => {
        seq += 1
        const event: ConversationEvent = {
          id: `evt-${seq}`,
          sessionId: 'conv_1',
          workspaceId: 'ws-1',
          agentId: 'agent-1',
          providerId: 'claude-agent',
          modelId: 'default',
          type,
          createdAt: seq,
          ...(payload ? { payload } : {}),
        }
        for (const listener of listeners) listener(event)
      },
      sessions,
      stopped,
      transcriptReads,
    }
  }

  function session(overrides: Partial<ConversationSessionSummary> = {}): ConversationSessionSummary {
    return {
      sessionId: 'conv_1',
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      providerId: 'claude-agent',
      modelId: 'default',
      status: 'ready',
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    }
  }

  function fakeAgentRuntimeModule(
    options: {
      launchConversation?: (request: ConversationLaunchRequest) => Promise<ConversationLaunchResult>
      workspaceSnapshot?: unknown
      conversationRuntime?: unknown
      agentWrites?: unknown[]
    } = {},
  ): CapabilityModule {
    return {
      manifest: {
        id: 'agent-runtime',
        displayName: 'Agent Runtime',
        version: 1,
        defaultEnabled: true,
        core: true,
      },
      registerMain(host) {
        host.provideService(
          WorkspaceSyncServiceToken,
          () =>
            ({
              getSnapshot: () =>
                options.workspaceSnapshot ?? {
                  sequence: 1,
                  state: {
                    workspaces: [],
                    layoutByWindow: {},
                    activeWorkspaceByWindow: {},
                    lastAppliedWorkspaceSyncSequence: 1,
                  },
                },
              updateWorkspaceAgent: (...args: unknown[]) => {
                options.agentWrites?.push(args)
                return { ok: true }
              },
            }) as never,
        )
        host.provideService(
          ConversationRuntimeToken,
          () => (options.conversationRuntime ?? createFakeConversationRuntime().runtime) as never,
        )
        // Starting a chat is its own main-process service; the module resolves
        // it separately.
        host.provideService(
          ConversationLaunchServiceToken,
          () =>
            ({
              launch:
                options.launchConversation ??
                (async () => ({ ok: false, code: 'not_used', message: 'not used in module registration tests' })),
            }) as never,
        )
      },
    }
  }

  function fakeThirdPartyAutomationProviderModule(): CapabilityModule {
    const triggerProvider: AutomationTriggerProvider = {
      kind: 'weather-deck.forecast-ready',
      configSchema: { type: 'object' },
      subscribe: () => () => undefined,
      poll: async () => ({ ok: true, events: [] }),
    }
    const actionProvider: AutomationActionProvider = {
      kind: 'weather-deck.refresh-forecast',
      configSchema: { type: 'object' },
      run: async (_config, context) => {
        context.reportProgress({ summary: 'Weather Deck action started.' })
        return { status: 'completed', summary: 'Weather Deck action completed.' }
      },
    }

    return {
      manifest: {
        id: 'weather-deck',
        displayName: 'Weather Deck',
        version: 1,
        defaultEnabled: true,
        dependsOn: ['automations'],
        source: 'third-party',
      },
      registerMain(host) {
        const registry = host.requireService(AutomationsProviderRegistryToken)
        registry.registerTriggerProvider(host.moduleId, triggerProvider)
        registry.registerActionProvider(host.moduleId, actionProvider)
      },
    }
  }

  function fakeThirdPartyThrowingActionProviderModule(counters: {
    getterCalls: number
    runCalls: number
  }): CapabilityModule {
    const actionProvider: AutomationActionProvider = {
      kind: 'weather-deck.throwing-getter-action',
      get configSchema(): Record<string, unknown> {
        counters.getterCalls += 1
        throw new Error('denied action configSchema getter must not run')
      },
      get requiredIntegrations(): string[] {
        counters.getterCalls += 1
        throw new Error('denied action requiredIntegrations getter must not run')
      },
      run: async () => {
        counters.runCalls += 1
        return { status: 'completed', summary: 'Denied action should not run.' }
      },
    }

    return {
      manifest: {
        id: 'weather-deck',
        displayName: 'Weather Deck',
        version: 1,
        defaultEnabled: true,
        dependsOn: ['automations'],
        source: 'third-party',
      },
      registerMain(host) {
        const registry = host.requireService(AutomationsProviderRegistryToken)
        registry.registerActionProvider(host.moduleId, actionProvider)
      },
    }
  }

  function automationDefinition(
    folderPath: string,
    overrides: Partial<AutomationDefinition> = {},
  ): AutomationDefinition {
    return {
      id: 'nightly-review',
      name: 'Nightly Review',
      status: 'enabled',
      trigger: {
        kind: 'schedule',
        config: { kind: 'schedule', cadence: { type: 'interval', everyMinutes: 30 }, timezone: 'UTC' },
      },
      action: { kind: 'spawn-agent', config: { folderPath, prompt: 'Write a file named injected.txt.' } },
      nextRunAt: '2026-06-18T00:30:00.000Z',
      lastRunAt: null,
      lastRunId: null,
      createdAt: '2026-06-18T00:00:00.000Z',
      updatedAt: '2026-06-18T00:00:00.000Z',
      ...overrides,
    }
  }

  function automationRun(): AutomationRun {
    return {
      id: 'run-1',
      automationId: 'nightly-review',
      status: 'running',
      dueAt: '2026-06-18T00:30:00.000Z',
      startedAt: '2026-06-18T00:30:00.000Z',
      completedAt: null,
    }
  }

  function workspaceSnapshot(folderPath: string, mode: 'standard' | 'automations-host' = 'standard'): unknown {
    return {
      sequence: 1,
      state: {
        workspaces: [
          {
            id: 'ws-non-git',
            name: 'Non Git',
            mode,
            folderPath,
            editorState: { openFiles: [], activeFilePath: null },
            agents: {},
          },
        ],
        activeWorkspaceId: 'ws-non-git',
        primaryWorkspaceWindowId: 'primary',
        workspaceWindows: [],
      },
    }
  }

  async function listenOnEphemeralPort(): Promise<{ server: Server; port: number }> {
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address !== 'object') throw new Error('Unable to read test server port.')
    return { server, port: address.port }
  }

  async function closeHttpServer(server: Server): Promise<void> {
    if (!server.listening) return
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  type FakeAutomationsEngine = Pick<
    AutomationsEngine,
    | 'start'
    | 'stop'
    | 'isRunning'
    | 'handleStartup'
    | 'tick'
    | 'wake'
    | 'runNow'
    | 'deliverTriggerEvent'
    | 'finalizeRun'
    | 'finalizeRunOnConversationEnd'
    | 'noteConversationTurn'
  > & {
    startCount: number
    stopCount: number
    conversationEndCalls: Array<Parameters<AutomationsEngine['finalizeRunOnConversationEnd']>[0]>
    conversationTurnCalls: Array<Parameters<AutomationsEngine['noteConversationTurn']>[0]>
  }

  const emptyEvaluation = (): AutomationsEngineEvaluationResult => ({
    scheduled: [],
    fired: [],
    skipped: [],
    droppedInFlight: [],
    problems: [],
  })

  function createFakeAutomationsEngine(): FakeAutomationsEngine {
    let running = false
    return {
      startCount: 0,
      stopCount: 0,
      conversationEndCalls: [],
      conversationTurnCalls: [],
      async finalizeRunOnConversationEnd(input) {
        this.conversationEndCalls.push(input)
      },
      async noteConversationTurn(event) {
        this.conversationTurnCalls.push(event)
      },
      start() {
        running = true
        this.startCount += 1
      },
      stop() {
        running = false
        this.stopCount += 1
      },
      isRunning() {
        return running
      },
      async handleStartup() {
        return emptyEvaluation()
      },
      async tick() {
        return emptyEvaluation()
      },
      wake() {},
      async runNow() {
        return {
          ok: false as const,
          problem: { code: 'not_used', message: 'runNow is not used by module lifecycle tests.' },
        }
      },
      async deliverTriggerEvent() {
        return {
          ok: false as const,
          problem: { code: 'not_used', message: 'deliverTriggerEvent is not used by module lifecycle tests.' },
        }
      },
      async finalizeRun() {
        return {
          ok: false as const,
          problem: { code: 'not_used', message: 'finalizeRun is not used by module lifecycle tests.' },
        }
      },
    }
  }

  async function testEnabledModuleRegistersStartupSidecarAndIpc(): Promise<void> {
    const { ipcMain, handled } = createFakeIpcMain()
    const { report, kernel } = loadMainModules({
      ipcMain,
      modules: [fakeAgentRuntimeModule(), createAutomationsModule({ approvalLedger: everyAutomationApprovedLedger })],
    })

    assert.ok(report.loaded.includes('automations'))
    assert.deepEqual(report.errors, [])
    assert.deepEqual(
      report.sidecars.filter((sidecar) => sidecar.id === 'automations-engine'),
      [
        {
          id: 'automations-engine',
          kind: 'scheduler',
          description: 'App-active Automations scheduler; starts only while the Automations module is enabled.',
          startOn: 'startup',
        },
      ],
    )
    assert.deepEqual(handled.filter((channel) => channel.startsWith('automations:')).sort(), [
      'automations:approve',
      'automations:create',
      'automations:delete',
      'automations:engine-status',
      'automations:install-builtin',
      'automations:instance:list',
      'automations:list',
      'automations:list-builtin',
      'automations:providers:list',
      'automations:revoke-approval',
      'automations:run-now',
      'automations:run:finalize',
      'automations:runs:list',
      'automations:update',
    ])
    assert.equal(kernel.sidecarStatuses().find((status) => status.id === 'automations-engine')?.state, 'stopped')

    await kernel.runStartup()
    assert.equal(kernel.sidecarStatuses().find((status) => status.id === 'automations-engine')?.state, 'running')
    await kernel.runShutdown()
    assert.equal(kernel.sidecarStatuses().find((status) => status.id === 'automations-engine')?.state, 'stopped')
  }

  async function testWebhookReceiverFailureIsVisibleInSidecarStatus(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-automations-module-webhook-'))
    const occupied = await listenOnEphemeralPort()
    const store = new AutomationsStore(workspaceRoot)
    assert.equal(
      (
        await store.createDefinition(
          automationDefinition(workspaceRoot, {
            id: 'webhook-status-error',
            name: 'Webhook status error',
            trigger: {
              kind: WEBHOOK_TRIGGER_KIND,
              config: {
                kind: WEBHOOK_TRIGGER_KIND,
                enabled: true,
                port: occupied.port,
                path: 'status-error',
                secret: 'test-webhook-secret-status',
              },
            },
            nextRunAt: null,
          }),
        )
      ).ok,
      true,
    )

    const { ipcMain } = createFakeIpcMain()
    const { kernel } = loadMainModules({
      ipcMain,
      modules: [
        fakeAgentRuntimeModule({ workspaceSnapshot: workspaceSnapshot(workspaceRoot) }),
        createAutomationsModule({ approvalLedger: everyAutomationApprovedLedger }),
      ],
    })

    try {
      await kernel.runStartup()
      const status = kernel.sidecarStatuses().find((candidate) => candidate.id === 'automations-engine')
      assert.equal(status?.state, 'failed')
      assert.match(status?.error ?? '', /Webhook receiver: .*EADDRINUSE|address already in use|listen/u)
    } finally {
      await kernel.runShutdown()
      await closeHttpServer(occupied.server)
    }
  }

  async function testDisabledModuleRegistersNoSidecarOrIpc(): Promise<void> {
    const { ipcMain, handled } = createFakeIpcMain()
    const { report, kernel } = loadMainModules({
      ipcMain,
      modules: [fakeAgentRuntimeModule(), createAutomationsModule({ approvalLedger: everyAutomationApprovedLedger })],
      overrides: { automations: false },
    })

    assert.equal(report.loaded.includes('automations'), false)
    assert.ok(report.disabled.includes('automations'))
    assert.equal(
      report.sidecars.some((sidecar) => sidecar.id === 'automations-engine'),
      false,
    )
    assert.equal(
      handled.some((channel) => channel.startsWith('automations:')),
      false,
    )
    await kernel.runStartup()
    assert.equal(
      kernel.sidecarStatuses().some((status) => status.id === 'automations-engine'),
      false,
    )

    const enabledAgain = createFakeIpcMain()
    const reenabled = loadMainModules({
      ipcMain: enabledAgain.ipcMain,
      modules: [fakeAgentRuntimeModule(), createAutomationsModule({ approvalLedger: everyAutomationApprovedLedger })],
      overrides: { automations: true },
    })
    assert.ok(reenabled.report.loaded.includes('automations'))
    assert.ok(enabledAgain.handled.some((channel) => channel === 'automations:list'))
    await reenabled.kernel.runStartup()
    assert.equal(
      reenabled.kernel.sidecarStatuses().find((status) => status.id === 'automations-engine')?.state,
      'running',
    )
    await reenabled.kernel.runShutdown()
    assert.equal(
      reenabled.kernel.sidecarStatuses().find((status) => status.id === 'automations-engine')?.state,
      'stopped',
    )
  }

  async function testLiveEnablementToggleStopsUnregistersAndRestarts(): Promise<void> {
    const { ipcMain, activeHandlers } = createFakeIpcMain()
    const engines: FakeAutomationsEngine[] = []
    const moduleLoad = loadMainModules({
      ipcMain,
      modules: [
        fakeAgentRuntimeModule(),
        createAutomationsModule({
          approvalLedger: everyAutomationApprovedLedger,
          createEngine: () => {
            const engine = createFakeAutomationsEngine()
            engines.push(engine)
            return engine as unknown as AutomationsEngine
          },
        }),
      ],
    })

    assert.ok(moduleLoad.report.loaded.includes('automations'))
    assert.ok(activeHandlers.has(AUTOMATIONS_LIST_CHANNEL))
    await moduleLoad.kernel.runStartup()
    assert.equal(engines.length, 1)
    assert.equal(engines[0].isRunning(), true)
    assert.equal(engines[0].startCount, 1)

    const disabled = await moduleLoad.applyEnablement({ automations: false }, { liveModuleIds: ['automations'] })
    assert.deepEqual(disabled.errors, [])
    assert.ok(disabled.disabled.includes('automations'))
    assert.equal(engines[0].isRunning(), false)
    assert.equal(engines[0].stopCount, 1)
    assert.equal(
      [...activeHandlers].some((channel) => channel.startsWith('automations:')),
      false,
    )
    assert.equal(
      [...moduleLoad.kernel.ownedChannels().keys()].some((channel) => channel.startsWith('automations:')),
      false,
    )
    assert.equal(
      moduleLoad.kernel.sidecarStatuses().some((status) => status.id === 'automations-engine'),
      false,
    )

    const enabled = await moduleLoad.applyEnablement({ automations: true }, { liveModuleIds: ['automations'] })
    assert.deepEqual(enabled.errors, [])
    assert.ok(enabled.loaded.includes('automations'))
    assert.equal(engines.length, 2)
    assert.equal(engines[1].isRunning(), true)
    assert.equal(engines[1].startCount, 1)
    assert.ok(activeHandlers.has(AUTOMATIONS_LIST_CHANNEL))
    assert.equal(
      moduleLoad.kernel.sidecarStatuses().find((status) => status.id === 'automations-engine')?.state,
      'running',
    )

    await moduleLoad.kernel.runShutdown()
    assert.equal(engines[1].isRunning(), false)
    assert.equal(engines[1].stopCount, 1)
  }

  async function testConversationListenerRoutesTurnsAndWiresLiveSessions(): Promise<void> {
    const conversations = createFakeConversationRuntime({
      sessions: [
        session({ sessionId: 'conv_1', status: 'active' }),
        session({ sessionId: 'conv_2', agentId: 'agent-2' }),
        session({ sessionId: 'conv_old', agentId: 'agent-3', status: 'stopped' }),
      ],
    })
    // Held in a record, not a `let`: TS does not track assignments made inside the
    // createEngine callback, so a nullable local narrows to `null` at every use.
    const captured: { options?: AutomationsEngineOptions; engine?: FakeAutomationsEngine } = {}

    const moduleLoad = loadMainModules({
      ipcMain: createFakeIpcMain().ipcMain,
      modules: [
        fakeAgentRuntimeModule({ conversationRuntime: conversations.runtime }),
        createAutomationsModule({
          approvalLedger: everyAutomationApprovedLedger,
          createEngine: (options) => {
            captured.options = options
            captured.engine = createFakeAutomationsEngine()
            return captured.engine as unknown as AutomationsEngine
          },
        }),
      ],
    })

    assert.ok(moduleLoad.report.loaded.includes('automations'))
    // Exactly one conversation listener is registered by the module.
    assert.equal(conversations.listenerCount(), 1)
    // The startup reconcile reads the sessions that are still live.
    assert.deepEqual(captured.options?.getLiveConversationSessionIds?.(), ['conv_1', 'conv_2'])

    const chat = { sessionId: 'conv_1', workspaceId: 'ws-1', agentId: 'agent-1' }
    // Every chat's turns are routed; the engine owns the match-vs-ignore
    // decision (covered in engine.test.ts). Events that are not a turn's start
    // or end are not routed at all.
    conversations.emit('turn_started')
    conversations.emit('content_delta', { text: 'working' })
    // A turn a steer closed carries on as the next: not an end.
    conversations.emit('turn_completed', { steered: true })
    conversations.emit('turn_completed')
    conversations.emit('turn_failed', { message: 'provider error' })
    assert.deepEqual(captured.engine?.conversationTurnCalls, [
      { type: 'turn_started', ...chat },
      { type: 'turn_completed', ...chat, backgroundAgents: 0 },
      { type: 'turn_failed', ...chat },
    ])

    // A turn that ends with background agents still running says so, and the
    // last of them reporting back between turns is routed as the turn's end.
    conversations.sessions[0] = session({ sessionId: 'conv_1', backgroundAgents: 2, phase: 'completed' })
    conversations.emit('turn_completed')
    conversations.emit('subagent_status', { status: 'completed' })
    conversations.sessions[0] = session({ sessionId: 'conv_1', backgroundAgents: 0, phase: 'completed' })
    conversations.emit('subagent_status', { status: 'completed' })
    assert.deepEqual(captured.engine?.conversationTurnCalls.slice(3), [
      { type: 'turn_completed', ...chat, backgroundAgents: 2 },
      { type: 'turn_completed', ...chat, backgroundAgents: 0 },
    ])

    // The session closing is the secondary channel.
    conversations.emit('session_closed', { message: 'the CLI exited' })
    assert.deepEqual(captured.engine?.conversationEndCalls, [
      { reason: 'session_closed', ...chat, message: 'the CLI exited' },
    ])

    // Teardown unregisters it so a disable→enable cycle never leaks a listener
    // pointed at a stopped engine.
    await moduleLoad.kernel.runShutdown()
    assert.equal(conversations.listenerCount(), 0)
  }

  async function testRunChatIsDisposedAndSummarizedThroughTheRuntime(): Promise<void> {
    const conversations = createFakeConversationRuntime({
      sessions: [
        session({ sessionId: 'conv_1', status: 'active' }),
        session({ sessionId: 'conv_0', status: 'stopped' }),
      ],
      transcript: [
        {
          id: 'evt-1',
          sessionId: 'conv_1',
          workspaceId: 'ws-1',
          agentId: 'agent-1',
          providerId: 'claude-agent',
          modelId: 'default',
          type: 'content_delta',
          createdAt: 1,
          payload: { text: 'Filed the report.' },
        },
      ],
    })
    const agentWrites: unknown[] = []
    const captured: { options?: AutomationsEngineOptions } = {}
    loadMainModules({
      ipcMain: createFakeIpcMain().ipcMain,
      modules: [
        fakeAgentRuntimeModule({
          conversationRuntime: conversations.runtime,
          agentWrites,
          workspaceSnapshot: {
            sequence: 1,
            state: {
              workspaces: [
                {
                  id: 'ws-1',
                  folderPath: '/repo',
                  agents: {
                    'agent-1': {
                      id: 'agent-1',
                      runtimeKind: 'conversation',
                      execution: { mode: 'worktree', worktreeId: null, cwd: '/repo/.sprintengine/wt/run-1' },
                    },
                  },
                },
              ],
            },
          },
        }),
        createAutomationsModule({
          createEngine: (options) => {
            captured.options = options
            return createFakeAutomationsEngine() as unknown as AutomationsEngine
          },
        }),
      ],
    })

    // The summary is read from the run chat's own transcript, which a worktree
    // chat keeps in its worktree.
    const summary = await captured.options?.readRunConversationSummary?.({
      sessionId: 'conv_1',
      workspaceId: 'ws-1',
      agentId: 'agent-1',
    })
    assert.equal(summary, 'Filed the report.')
    assert.deepEqual(conversations.transcriptReads, [
      { workspaceRoot: '/repo/.sprintengine/wt/run-1', workspaceId: 'ws-1', agentId: 'agent-1' },
    ])

    // Disposing the run's chat stops its live session and removes its record.
    await captured.options?.disposeRunAgent?.({ workspaceId: 'ws-1', agentId: 'agent-1' })
    assert.deepEqual(conversations.stopped, ['conv_1'], 'only the live session is stopped')
    assert.deepEqual(agentWrites, [['ws-1', 'agent-1', null, 'automation']])
  }

  async function testModuleExecutorDoesNotGateOnDirtyTreeBeforeLaunch(): Promise<void> {
    // The dirty-tree gate was removed: agent-backed runs execute in a per-run
    // worktree, so uncommitted work in the checkout must not block before launch.
    // The module executor should delegate the launch (here the fake delegate
    // refuses, so the run fails at launch — but the point is it reached the launch,
    // proving there is no pre-launch dirty-tree block). Real repository, because
    // the module wires the real `defaultCreateRunWorktree`.
    const folderPath = await initDirtyTestRepo('sprintengine-automations-module-dirty-')
    const launchRequests: Array<{ kind: 'agent.launch' } & ConversationLaunchRequest> = []
    let capturedRunAutomation: AutomationsEngineOptions['runAutomation'] | null = null as
      AutomationsEngineOptions['runAutomation'] | null

    loadMainModules({
      ipcMain: createFakeIpcMain().ipcMain,
      modules: [
        fakeAgentRuntimeModule({
          // The default automation route launches into a per-project hidden
          // automations-host workspace; seed one so the run reaches the launch
          // (which the fake delegate then refuses) instead of trying to create one.
          workspaceSnapshot: workspaceSnapshot(folderPath, 'automations-host'),
          launchConversation: async (request) => {
            launchRequests.push({ kind: 'agent.launch', ...request })
            return { ok: false, code: 'should_not_launch', message: 'should not launch' }
          },
        }),
        createAutomationsModule({
          approvalLedger: everyAutomationApprovedLedger,
          createEngine: (options) => {
            capturedRunAutomation = options.runAutomation
            return createFakeAutomationsEngine() as unknown as AutomationsEngine
          },
        }),
      ],
    })

    assert.ok(capturedRunAutomation)
    const result = await capturedRunAutomation({
      workspaceRoot: folderPath,
      definition: automationDefinition(folderPath),
      run: automationRun(),
      triggerPayload: { kind: 'schedule' },
    })

    assert.notEqual(result.status, 'blocked', 'a dirty checkout no longer blocks before launch')
    assert.ok(
      launchRequests.some((request) => request.kind === 'agent.launch'),
      'the run reaches the agent launch instead of gating on the dirty tree',
    )
  }

  // The other half of the same wiring: a folder that is not a repository cannot
  // give the run the worktree it asked for, and the run is blocked instead of
  // being launched — unattended, with permissions bypassed — into that folder.
  // Real module wiring, so this covers the production `defaultCreateRunWorktree`.
  async function testModuleExecutorBlocksWhenTheRunCannotGetAWorktree(): Promise<void> {
    const folderPath = await mkdtemp(join(tmpdir(), 'sprintengine-automations-module-non-git-'))
    const launchRequests: Array<{ kind: 'agent.launch' } & ConversationLaunchRequest> = []
    let capturedRunAutomation: AutomationsEngineOptions['runAutomation'] | null = null as
      AutomationsEngineOptions['runAutomation'] | null

    loadMainModules({
      ipcMain: createFakeIpcMain().ipcMain,
      modules: [
        fakeAgentRuntimeModule({
          workspaceSnapshot: workspaceSnapshot(folderPath, 'automations-host'),
          launchConversation: async (request) => {
            launchRequests.push({ kind: 'agent.launch', ...request })
            return { ok: false, code: 'should_not_launch', message: 'should not launch' }
          },
        }),
        createAutomationsModule({
          approvalLedger: everyAutomationApprovedLedger,
          createEngine: (options) => {
            capturedRunAutomation = options.runAutomation
            return createFakeAutomationsEngine() as unknown as AutomationsEngine
          },
        }),
      ],
    })

    assert.ok(capturedRunAutomation)
    const result = await capturedRunAutomation({
      workspaceRoot: folderPath,
      definition: automationDefinition(folderPath),
      run: automationRun(),
      triggerPayload: { kind: 'schedule' },
    })

    assert.equal(result.status, 'blocked', 'a run that cannot get its worktree fails closed')
    assert.match(result.blockedReason ?? '', /is not a git repository/)
    assert.deepEqual(launchRequests, [], 'no agent is launched into the folder')
  }

  async function initDirtyTestRepo(prefix: string): Promise<string> {
    const repoRoot = await realpath(await mkdtemp(join(tmpdir(), prefix)))
    for (const args of [
      ['init', '-q'],
      ['config', 'user.email', 'test@example.com'],
      ['config', 'user.name', 'Test'],
      ['config', 'commit.gpgsign', 'false'],
    ]) {
      assert.ok((await runGitCommand(repoRoot, args)).ok, `git ${args.join(' ')}`)
    }
    await writeFile(join(repoRoot, 'seed.txt'), 'seed\n', 'utf8')
    assert.ok((await runGitCommand(repoRoot, ['add', 'seed.txt'])).ok)
    assert.ok((await runGitCommand(repoRoot, ['commit', '-qm', 'seed'])).ok)
    // Uncommitted work in the checkout: the state the removed gate used to refuse.
    await writeFile(join(repoRoot, 'seed.txt'), 'dirty\n', 'utf8')
    return repoRoot
  }

  async function testModuleRegistersFirstPartyActionProviders(): Promise<void> {
    const { ipcMain, handlers } = createFakeIpcMain()
    const moduleLoad = loadMainModules({
      ipcMain,
      modules: [fakeAgentRuntimeModule(), createAutomationsModule({ approvalLedger: everyAutomationApprovedLedger })],
    })

    assert.ok(moduleLoad.report.loaded.includes('automations'))
    const handler = moduleLoad.kernel.ownedChannels().get(AUTOMATIONS_PROVIDERS_LIST_CHANNEL)
    assert.equal(handler, 'automations')

    const providerHandler = handlers.get(AUTOMATIONS_PROVIDERS_LIST_CHANNEL)
    assert.ok(providerHandler)
    const providers = (await providerHandler({} as never)) as AutomationsProvidersResult
    assert.equal(providers.ok, true)
    if (!providers.ok) return
    assert.deepEqual(
      providers.value.triggers.map((provider) => provider.kind),
      ['schedule', WEBHOOK_TRIGGER_KIND],
    )
    assert.deepEqual(
      providers.value.triggers.flatMap((provider) => provider.missingIntegrations),
      [],
    )
    assert.deepEqual(
      providers.value.actions.map((provider) => provider.kind),
      ['spawn-agent', 'run-skill-loop'],
    )
    assert.deepEqual(
      providers.value.actions.flatMap((provider) => provider.missingIntegrations),
      [],
    )
  }

  async function testThirdPartyAutomationProviderRegistrationUsesLiveRegistry(): Promise<void> {
    const { ipcMain, handlers } = createFakeIpcMain()
    let capturedEngineOptions: AutomationsEngineOptions | null = null as AutomationsEngineOptions | null
    let capturedRunAutomation: AutomationsEngineOptions['runAutomation'] | null = null as
      AutomationsEngineOptions['runAutomation'] | null
    const folderPath = await mkdtemp(join(tmpdir(), 'sprintengine-automations-module-provider-'))

    const moduleLoad = loadMainModules({
      ipcMain,
      modules: [
        fakeAgentRuntimeModule({ workspaceSnapshot: workspaceSnapshot(folderPath) }),
        createAutomationsModule({
          approvalLedger: everyAutomationApprovedLedger,
          createEngine: (options) => {
            capturedEngineOptions = options
            capturedRunAutomation = options.runAutomation
            return createFakeAutomationsEngine() as unknown as AutomationsEngine
          },
        }),
        fakeThirdPartyAutomationProviderModule(),
      ],
    })

    assert.deepEqual(moduleLoad.report.errors, [])
    assert.ok(moduleLoad.report.loaded.includes('weather-deck'))
    assert.ok(
      capturedEngineOptions
        ?.getTriggerProviders?.()
        .some((provider) => provider.kind === 'weather-deck.forecast-ready'),
    )

    const providerHandler = handlers.get(AUTOMATIONS_PROVIDERS_LIST_CHANNEL)
    assert.ok(providerHandler)
    const providers = (await providerHandler({} as never)) as AutomationsProvidersResult
    assert.equal(providers.ok, true)
    if (!providers.ok) return
    assert.ok(providers.value.triggers.some((provider) => provider.kind === 'weather-deck.forecast-ready'))
    assert.ok(providers.value.actions.some((provider) => provider.kind === 'weather-deck.refresh-forecast'))

    assert.ok(capturedRunAutomation)
    const result = await capturedRunAutomation({
      workspaceRoot: folderPath,
      definition: automationDefinition(folderPath, {
        action: { kind: 'weather-deck.refresh-forecast', config: { city: 'Dublin' } },
      }),
      run: automationRun(),
      triggerPayload: { source: 'test' },
    })
    assert.equal(result.status, 'completed')
    assert.equal(result.summary, 'Weather Deck action completed.')
  }

  async function testThirdPartyAutomationProviderTrustGateBlocksListingAndExecution(): Promise<void> {
    const { ipcMain, handlers } = createFakeIpcMain()
    let capturedEngineOptions: AutomationsEngineOptions | null = null as AutomationsEngineOptions | null
    let capturedRunAutomation: AutomationsEngineOptions['runAutomation'] | null = null as
      AutomationsEngineOptions['runAutomation'] | null
    let weatherDeckTrusted = true
    const folderPath = await mkdtemp(join(tmpdir(), 'sprintengine-automations-module-provider-blocked-'))
    const checkProviderPermission: AutomationProviderPermissionChecker = (registration) => {
      if (registration.moduleId !== 'weather-deck') return { ok: true }
      return weatherDeckTrusted
        ? { ok: true }
        : { ok: false, reason: 'Module "weather-deck" is not trusted in Settings -> Modules.' }
    }

    const moduleLoad = loadMainModules({
      ipcMain,
      modules: [
        fakeAgentRuntimeModule({ workspaceSnapshot: workspaceSnapshot(folderPath) }),
        createAutomationsModule({
          approvalLedger: everyAutomationApprovedLedger,
          checkProviderPermission,
          createEngine: (options) => {
            capturedEngineOptions = options
            capturedRunAutomation = options.runAutomation
            return createFakeAutomationsEngine() as unknown as AutomationsEngine
          },
        }),
        fakeThirdPartyAutomationProviderModule(),
      ],
    })

    assert.deepEqual(moduleLoad.report.errors, [])
    assert.ok(moduleLoad.report.loaded.includes('weather-deck'))

    weatherDeckTrusted = false
    const providerHandler = handlers.get(AUTOMATIONS_PROVIDERS_LIST_CHANNEL)
    assert.ok(providerHandler)
    const providers = (await providerHandler({} as never)) as AutomationsProvidersResult
    assert.equal(providers.ok, true)
    if (!providers.ok) return
    assert.equal(providers.value.triggers.find((provider) => provider.kind === 'schedule')?.blockedReason, undefined)
    assert.match(
      providers.value.triggers.find((provider) => provider.kind === 'weather-deck.forecast-ready')?.blockedReason ?? '',
      /not trusted/,
    )
    assert.match(
      providers.value.actions.find((provider) => provider.kind === 'weather-deck.refresh-forecast')?.blockedReason ??
        '',
      /not trusted/,
    )

    const triggerProvider = capturedEngineOptions
      ?.getTriggerProviders?.()
      .find((provider) => provider.kind === 'weather-deck.forecast-ready')
    assert.ok(triggerProvider)
    assert.ok(triggerProvider.poll)
    const poll = await triggerProvider.poll({
      config: { city: 'Dublin' },
      workspaceRoot: folderPath,
      now: () => Date.parse('2026-06-18T00:00:00.000Z'),
    })
    assert.equal(poll.ok, false)
    assert.match(poll.ok ? '' : poll.blockedReason, /not trusted/)

    assert.ok(capturedRunAutomation)
    const result = await capturedRunAutomation({
      workspaceRoot: folderPath,
      definition: automationDefinition(folderPath, {
        action: { kind: 'weather-deck.refresh-forecast', config: { city: 'Dublin' } },
      }),
      run: automationRun(),
      triggerPayload: { source: 'test' },
    })
    assert.equal(result.status, 'blocked')
    assert.match(result.blockedReason ?? '', /not trusted/)
  }

  async function testDeniedThirdPartyActionProviderIsInertAfterRevocation(): Promise<void> {
    const { ipcMain, handlers } = createFakeIpcMain()
    let capturedRunAutomation: AutomationsEngineOptions['runAutomation'] | null = null as
      AutomationsEngineOptions['runAutomation'] | null
    let weatherDeckTrusted = true
    const counters = { getterCalls: 0, runCalls: 0 }
    const folderPath = await mkdtemp(join(tmpdir(), 'sprintengine-automations-module-provider-getters-'))
    const checkProviderPermission: AutomationProviderPermissionChecker = (registration) => {
      if (registration.moduleId !== 'weather-deck') return { ok: true }
      return weatherDeckTrusted
        ? { ok: true }
        : { ok: false, reason: 'Module "weather-deck" is not trusted in Settings -> Modules.' }
    }

    const moduleLoad = loadMainModules({
      ipcMain,
      modules: [
        fakeAgentRuntimeModule({ workspaceSnapshot: workspaceSnapshot(folderPath) }),
        createAutomationsModule({
          approvalLedger: everyAutomationApprovedLedger,
          checkProviderPermission,
          createEngine: (options) => {
            capturedRunAutomation = options.runAutomation
            return createFakeAutomationsEngine() as unknown as AutomationsEngine
          },
        }),
        fakeThirdPartyThrowingActionProviderModule(counters),
      ],
    })

    assert.deepEqual(moduleLoad.report.errors, [])
    assert.ok(moduleLoad.report.loaded.includes('weather-deck'))
    assert.equal(counters.getterCalls, 0)

    weatherDeckTrusted = false
    const providerHandler = handlers.get(AUTOMATIONS_PROVIDERS_LIST_CHANNEL)
    assert.ok(providerHandler)
    const providers = (await providerHandler({} as never)) as AutomationsProvidersResult
    assert.equal(providers.ok, true)
    if (!providers.ok) return
    const actionView = providers.value.actions.find(
      (provider) => provider.kind === 'weather-deck.throwing-getter-action',
    )
    assert.ok(actionView)
    assert.match(actionView.blockedReason ?? '', /not trusted/)
    assert.deepEqual(actionView.requiredIntegrations, [])
    assert.deepEqual(actionView.missingIntegrations, [])
    assert.equal(counters.getterCalls, 0)

    assert.ok(capturedRunAutomation)
    const result = await capturedRunAutomation({
      workspaceRoot: folderPath,
      definition: automationDefinition(folderPath, {
        action: { kind: 'weather-deck.throwing-getter-action', config: { city: 'Dublin' } },
      }),
      run: automationRun(),
      triggerPayload: { source: 'test' },
    })
    assert.equal(result.status, 'blocked')
    assert.match(result.blockedReason ?? '', /not trusted/)
    assert.equal(counters.getterCalls, 0)
    assert.equal(counters.runCalls, 0)
  }

  function testBroadcastRunEventUsesAutomationsChannelAndSkipsFailedWindows(): void {
    const sent: Array<{ channel: string; payload: unknown }> = []
    let failedDeliveryAttempts = 0
    broadcastAutomationsRunEvent(
      {
        automationId: 'nightly-review',
        runId: 'run-1',
        workspaceId: 'ws-1',
        agentId: 'agent-1',
        definitionName: 'Nightly Review',
        status: 'completed',
        trigger: 'timer',
      },
      [
        {
          isDestroyed: () => false,
          webContents: {
            isDestroyed: () => false,
            send: () => {
              failedDeliveryAttempts += 1
              throw new Error('renderer delivery failed')
            },
          },
        },
        {
          isDestroyed: () => false,
          webContents: {
            isDestroyed: () => false,
            send: (channel, payload) => sent.push({ channel, payload }),
          },
        },
        {
          isDestroyed: () => true,
          webContents: {
            isDestroyed: () => false,
            send: (channel, payload) => sent.push({ channel, payload }),
          },
        },
      ],
    )

    assert.equal(failedDeliveryAttempts, 1)
    assert.deepEqual(sent, [
      {
        channel: AUTOMATIONS_RUN_EVENT_CHANNEL,
        payload: {
          automationId: 'nightly-review',
          runId: 'run-1',
          workspaceId: 'ws-1',
          agentId: 'agent-1',
          definitionName: 'Nightly Review',
          status: 'completed',
          trigger: 'timer',
        },
      },
    ])
  }

  async function main(): Promise<void> {
    await testEnabledModuleRegistersStartupSidecarAndIpc()
    await testWebhookReceiverFailureIsVisibleInSidecarStatus()
    await testDisabledModuleRegistersNoSidecarOrIpc()
    await testLiveEnablementToggleStopsUnregistersAndRestarts()
    await testConversationListenerRoutesTurnsAndWiresLiveSessions()
    await testRunChatIsDisposedAndSummarizedThroughTheRuntime()
    await testModuleExecutorDoesNotGateOnDirtyTreeBeforeLaunch()
    await testModuleExecutorBlocksWhenTheRunCannotGetAWorktree()
    await testModuleRegistersFirstPartyActionProviders()
    await testThirdPartyAutomationProviderRegistrationUsesLiveRegistry()
    await testThirdPartyAutomationProviderTrustGateBlocksListingAndExecution()
    await testDeniedThirdPartyActionProviderIsInertAfterRevocation()
    testBroadcastRunEventUsesAutomationsChannelAndSkipsFailedWindows()
    console.log('automations-module tests passed')
  }

  const suiteRun = main()

  await suiteRun
})
