import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMain } from 'electron'

import type { AutomationRendererRequest, AutomationRendererResponse } from '../../shared/automation'
import type { AutomationDefinition, AutomationRun, AutomationsProvidersResult } from '../../shared/automations/contracts'
import type { AutomationsEngine, AutomationsEngineOptions } from '../automations/engine'
import type { CapabilityModule } from '../module-host/load-modules'
import type { IpcInvokeHandler } from '../module-host/main-host'
import { loadMainModules } from '../module-host/load-modules'
import {
  AutomationDelegateToken,
  SprintEngineAutomationFrontDoorsToken,
  SwitchboardAutomationFrontDoorsToken,
  WorkspaceSyncServiceToken,
} from '../module-host/service-tokens'
import {
  AUTOMATIONS_LIST_CHANNEL,
  AUTOMATIONS_PROVIDERS_LIST_CHANNEL,
  AUTOMATIONS_RUN_EVENT_CHANNEL,
} from '../../shared/automations/contracts'
import { SPRINT_ENGINE_RUN_ACTION_KIND } from '../automations/actions/sprint-engine'
import { SWITCHBOARD_RUNNER_TICK_ACTION_KIND, WATCHTOWER_REVIEW_ACTION_KIND } from '../automations/actions/switchboard'
import { broadcastAutomationsRunEvent, createAutomationsModule } from './automations-module'

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

function fakeAgentRuntimeModule(options: {
  delegateRequest?: (request: AutomationRendererRequest) => Promise<AutomationRendererResponse>
  workspaceSnapshot?: unknown
} = {}): CapabilityModule {
  return {
    manifest: {
      id: 'agent-runtime',
      displayName: 'Agent Runtime',
      version: 1,
      defaultEnabled: true,
      core: true,
    },
    registerMain(host) {
      host.provideService(AutomationDelegateToken, () => ({
        request: options.delegateRequest ?? (async () => ({ ok: false, message: 'not used in module registration tests' })),
        handleResponse: () => undefined,
      } as never))
      host.provideService(WorkspaceSyncServiceToken, () => ({
        getSnapshot: () => options.workspaceSnapshot ?? ({
          sequence: 1,
          state: {
            workspaces: [],
            layoutByWindow: {},
            activeWorkspaceByWindow: {},
            lastAppliedWorkspaceSyncSequence: 1,
          },
        }),
      } as never))
    },
  }
}

function fakeSwitchboardAutomationFrontDoorModule(): CapabilityModule {
  return {
    manifest: {
      id: 'switchboard',
      displayName: 'Switchboard',
      version: 1,
      defaultEnabled: true,
      dependsOn: ['agent-runtime'],
    },
    registerMain(host) {
      host.provideService(SwitchboardAutomationFrontDoorsToken, () => ({
        tickRunner: async (input) => ({
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
        }),
        startWatchtowerReview: async (input) => ({
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
        }),
      }))
    },
  }
}

function fakeSprintEngineAutomationFrontDoorModule(): CapabilityModule {
  return {
    manifest: {
      id: 'sprint-engine',
      displayName: 'Sprint Engine',
      version: 1,
      defaultEnabled: true,
      dependsOn: ['agent-runtime'],
    },
    registerMain(host) {
      host.provideService(SprintEngineAutomationFrontDoorsToken, () => ({
        setRunnerMode: async () => ({ ok: true, data: {} }),
        replenishRoster: async () => ({ ok: true, data: {} }),
      }))
    },
  }
}

function automationDefinition(folderPath: string): AutomationDefinition {
  return {
    id: 'nightly-review',
    name: 'Nightly Review',
    status: 'enabled',
    trigger: { kind: 'schedule', config: { kind: 'schedule', cadence: { type: 'interval', everyMinutes: 30 }, timezone: 'UTC' } },
    action: { kind: 'spawn-agent', config: { folderPath, prompt: 'Write a file named injected.txt.' } },
    autonomyDefault: 'review_only',
    nextRunAt: '2026-06-18T00:30:00.000Z',
    lastRunAt: null,
    lastRunId: null,
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
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

function workspaceSnapshot(folderPath: string): unknown {
  return {
    sequence: 1,
    state: {
      workspaces: [
        {
          id: 'ws-non-git',
          name: 'Non Git',
          mode: 'standard',
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

type FakeAutomationsEngine = Pick<AutomationsEngine, 'start' | 'stop' | 'isRunning' | 'runNow'> & {
  startCount: number
  stopCount: number
}

function createFakeAutomationsEngine(): FakeAutomationsEngine {
  let running = false
  return {
    startCount: 0,
    stopCount: 0,
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
    async runNow() {
      return {
        ok: false as const,
        problem: { code: 'not_used', message: 'runNow is not used by module lifecycle tests.' },
      }
    },
  }
}

async function testEnabledModuleRegistersStartupSidecarAndIpc(): Promise<void> {
  const { ipcMain, handled } = createFakeIpcMain()
  const { report, kernel } = loadMainModules({
    ipcMain,
    modules: [fakeAgentRuntimeModule(), createAutomationsModule()],
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
    ]
  )
  assert.deepEqual(
    handled.filter((channel) => channel.startsWith('automations:')).sort(),
    [
      'automations:create',
      'automations:delete',
      'automations:get',
      'automations:list',
      'automations:providers:list',
      'automations:run-now',
      'automations:runs:list',
      'automations:update',
    ]
  )
  assert.equal(kernel.sidecarStatuses().find((status) => status.id === 'automations-engine')?.state, 'stopped')

  await kernel.runStartup()
  assert.equal(kernel.sidecarStatuses().find((status) => status.id === 'automations-engine')?.state, 'running')
  await kernel.runShutdown()
  assert.equal(kernel.sidecarStatuses().find((status) => status.id === 'automations-engine')?.state, 'stopped')
}

async function testDisabledModuleRegistersNoSidecarOrIpc(): Promise<void> {
  const { ipcMain, handled } = createFakeIpcMain()
  const { report, kernel } = loadMainModules({
    ipcMain,
    modules: [fakeAgentRuntimeModule(), createAutomationsModule()],
    overrides: { automations: false },
  })

  assert.equal(report.loaded.includes('automations'), false)
  assert.ok(report.disabled.includes('automations'))
  assert.equal(report.sidecars.some((sidecar) => sidecar.id === 'automations-engine'), false)
  assert.equal(handled.some((channel) => channel.startsWith('automations:')), false)
  await kernel.runStartup()
  assert.equal(kernel.sidecarStatuses().some((status) => status.id === 'automations-engine'), false)

  const enabledAgain = createFakeIpcMain()
  const reenabled = loadMainModules({
    ipcMain: enabledAgain.ipcMain,
    modules: [fakeAgentRuntimeModule(), createAutomationsModule()],
    overrides: { automations: true },
  })
  assert.ok(reenabled.report.loaded.includes('automations'))
  assert.ok(enabledAgain.handled.some((channel) => channel === 'automations:list'))
  await reenabled.kernel.runStartup()
  assert.equal(reenabled.kernel.sidecarStatuses().find((status) => status.id === 'automations-engine')?.state, 'running')
  await reenabled.kernel.runShutdown()
  assert.equal(reenabled.kernel.sidecarStatuses().find((status) => status.id === 'automations-engine')?.state, 'stopped')
}

async function testLiveEnablementToggleStopsUnregistersAndRestarts(): Promise<void> {
  const { ipcMain, activeHandlers } = createFakeIpcMain()
  const engines: FakeAutomationsEngine[] = []
  const moduleLoad = loadMainModules({
    ipcMain,
    modules: [
      fakeAgentRuntimeModule(),
      createAutomationsModule({
        createEngine: () => {
          const engine = createFakeAutomationsEngine()
          engines.push(engine)
          return engine as AutomationsEngine
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
  assert.equal([...activeHandlers].some((channel) => channel.startsWith('automations:')), false)
  assert.equal([...moduleLoad.kernel.ownedChannels().keys()].some((channel) => channel.startsWith('automations:')), false)
  assert.equal(moduleLoad.kernel.sidecarStatuses().some((status) => status.id === 'automations-engine'), false)

  const enabled = await moduleLoad.applyEnablement({ automations: true }, { liveModuleIds: ['automations'] })
  assert.deepEqual(enabled.errors, [])
  assert.ok(enabled.loaded.includes('automations'))
  assert.equal(engines.length, 2)
  assert.equal(engines[1].isRunning(), true)
  assert.equal(engines[1].startCount, 1)
  assert.ok(activeHandlers.has(AUTOMATIONS_LIST_CHANNEL))
  assert.equal(
    moduleLoad.kernel.sidecarStatuses().find((status) => status.id === 'automations-engine')?.state,
    'running'
  )

  await moduleLoad.kernel.runShutdown()
  assert.equal(engines[1].isRunning(), false)
  assert.equal(engines[1].stopCount, 1)
}

async function testModuleExecutorUsesRealDirtyCheckBeforeLaunch(): Promise<void> {
  const folderPath = await mkdtemp(join(tmpdir(), 'multicode-automations-module-non-git-'))
  const launchRequests: AutomationRendererRequest[] = []
  let capturedRunAutomation: AutomationsEngineOptions['runAutomation'] | null = null

  loadMainModules({
    ipcMain: createFakeIpcMain().ipcMain,
    modules: [
      fakeAgentRuntimeModule({
        workspaceSnapshot: workspaceSnapshot(folderPath),
        delegateRequest: async (request) => {
          launchRequests.push(request)
          return { ok: false, code: 'should_not_launch', message: 'should not launch' }
        },
      }),
      createAutomationsModule({
        createEngine: (options) => {
          capturedRunAutomation = options.runAutomation
          return createFakeAutomationsEngine() as AutomationsEngine
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

  assert.equal(result.status, 'blocked')
  assert.match(result.blockedReason ?? '', /not inside a Git repository/)
  assert.deepEqual(launchRequests, [])
}

async function testModuleRegistersFirstPartyActionProviders(): Promise<void> {
  const { ipcMain, handlers } = createFakeIpcMain()
  const moduleLoad = loadMainModules({
    ipcMain,
    modules: [
      fakeAgentRuntimeModule(),
      fakeSwitchboardAutomationFrontDoorModule(),
      fakeSprintEngineAutomationFrontDoorModule(),
      createAutomationsModule(),
    ],
  })

  assert.ok(moduleLoad.report.loaded.includes('automations'))
  const handler = moduleLoad.kernel.ownedChannels().get(AUTOMATIONS_PROVIDERS_LIST_CHANNEL)
  assert.equal(handler, 'automations')

  const providerHandler = handlers.get(AUTOMATIONS_PROVIDERS_LIST_CHANNEL)
  assert.ok(providerHandler)
  const providers = await providerHandler({} as never) as AutomationsProvidersResult
  assert.equal(providers.ok, true)
  if (!providers.ok) return
  assert.deepEqual(
    providers.value.actions.map((provider) => provider.kind),
    ['spawn-agent', 'run-skill-loop', SWITCHBOARD_RUNNER_TICK_ACTION_KIND, WATCHTOWER_REVIEW_ACTION_KIND, SPRINT_ENGINE_RUN_ACTION_KIND]
  )
  assert.deepEqual(
    providers.value.actions.flatMap((provider) => provider.missingIntegrations),
    []
  )
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
    ]
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
  await testDisabledModuleRegistersNoSidecarOrIpc()
  await testLiveEnablementToggleStopsUnregistersAndRestarts()
  await testModuleExecutorUsesRealDirtyCheckBeforeLaunch()
  await testModuleRegistersFirstPartyActionProviders()
  testBroadcastRunEventUsesAutomationsChannelAndSkipsFailedWindows()
  console.log('automations-module tests passed')
}

void main()
