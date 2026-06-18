import assert from 'node:assert/strict'
import type { IpcMain } from 'electron'

import type { CapabilityModule } from '../module-host/load-modules'
import { loadMainModules } from '../module-host/load-modules'
import {
  AutomationDelegateToken,
  WorkspaceSyncServiceToken,
} from '../module-host/service-tokens'
import { createAutomationsModule } from './automations-module'

function createFakeIpcMain(): { ipcMain: IpcMain; handled: string[] } {
  const handled: string[] = []
  const ipcMain = {
    handle(channel: string, _handler: unknown): void {
      handled.push(channel)
    },
  } as unknown as IpcMain
  return { ipcMain, handled }
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

async function main(): Promise<void> {
  await testEnabledModuleRegistersStartupSidecarAndIpc()
  await testDisabledModuleRegistersNoSidecarOrIpc()
  console.log('automations-module tests passed')
}

void main()
