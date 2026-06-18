import assert from 'node:assert/strict'
import type { IpcMain } from 'electron'

import type { AutomationsEngine } from '../automations/engine'
import type { CapabilityModule } from '../module-host/load-modules'
import { loadMainModules } from '../module-host/load-modules'
import {
  AutomationDelegateToken,
  WorkspaceSyncServiceToken,
} from '../module-host/service-tokens'
import { AUTOMATIONS_LIST_CHANNEL } from '../../shared/automations/contracts'
import { createAutomationsModule } from './automations-module'

function createFakeIpcMain(): { ipcMain: IpcMain; handled: string[]; activeHandlers: Set<string> } {
  const handled: string[] = []
  const activeHandlers = new Set<string>()
  const ipcMain = {
    handle(channel: string, _handler: unknown): void {
      handled.push(channel)
      activeHandlers.add(channel)
    },
    removeHandler(channel: string): void {
      activeHandlers.delete(channel)
    },
  } as unknown as IpcMain
  return { ipcMain, handled, activeHandlers }
}

function fakeAgentRuntimeModule(): CapabilityModule {
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
        request: async () => ({ ok: false, message: 'not used in module registration tests' }),
        handleResponse: () => undefined,
      } as never))
      host.provideService(WorkspaceSyncServiceToken, () => ({
        getSnapshot: () => ({
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

async function main(): Promise<void> {
  await testEnabledModuleRegistersStartupSidecarAndIpc()
  await testDisabledModuleRegistersNoSidecarOrIpc()
  await testLiveEnablementToggleStopsUnregistersAndRestarts()
  console.log('automations-module tests passed')
}

void main()
