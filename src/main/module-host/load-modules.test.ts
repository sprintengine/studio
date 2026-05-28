import assert from 'node:assert/strict'
import type { IpcMain } from 'electron'

import { loadMainModules, type CapabilityModule } from './load-modules'
import { createServiceToken } from './main-host'

function createFakeIpcMain(): { ipcMain: IpcMain; handled: string[] } {
  const handled: string[] = []
  const ipcMain = {
    handle(channel: string, _handler: unknown): void {
      handled.push(channel)
    },
  } as unknown as IpcMain
  return { ipcMain, handled }
}

function main(): void {
  testEnabledModulesRegisterInDependencyOrder()
  testDisabledModuleNeverRegisters()
  testCrossModuleServiceWiring()
  testThrowingModuleIsIsolated()
  testDuplicateChannelIsReportedNotFatal()
  testLifecycleAndSidecarsCollected()

  console.log('module-host tests passed')
}

function testEnabledModulesRegisterInDependencyOrder(): void {
  const order: string[] = []
  const runtime: CapabilityModule = {
    manifest: { id: 'runtime', displayName: 'Runtime', version: 1, defaultEnabled: true, core: true },
    registerMain: () => order.push('runtime'),
  }
  const feature: CapabilityModule = {
    manifest: {
      id: 'feature',
      displayName: 'Feature',
      version: 1,
      defaultEnabled: true,
      dependsOn: ['runtime'],
    },
    registerMain: () => order.push('feature'),
  }

  const { ipcMain } = createFakeIpcMain()
  const { report } = loadMainModules({ ipcMain, modules: [feature, runtime] })

  assert.deepEqual(order, ['runtime', 'feature'])
  assert.deepEqual(report.loaded, ['runtime', 'feature'])
  assert.deepEqual(report.errors, [])
}

function testDisabledModuleNeverRegisters(): void {
  let registered = false
  const off: CapabilityModule = {
    manifest: { id: 'off', displayName: 'Off', version: 1, defaultEnabled: false },
    registerMain: () => {
      registered = true
    },
  }

  const { ipcMain } = createFakeIpcMain()
  const { report } = loadMainModules({ ipcMain, modules: [off] })

  assert.equal(registered, false, 'disabled module must not register')
  assert.deepEqual(report.loaded, [])
  assert.deepEqual(report.disabled, ['off'])
}

function testCrossModuleServiceWiring(): void {
  const token = createServiceToken<{ value: number }>('test.service')
  let received: { value: number } | null = null

  const provider: CapabilityModule = {
    manifest: { id: 'provider', displayName: 'Provider', version: 1, defaultEnabled: true },
    registerMain: (host) => {
      host.provideService(token, () => ({ value: 42 }))
    },
  }
  const consumer: CapabilityModule = {
    manifest: {
      id: 'consumer',
      displayName: 'Consumer',
      version: 1,
      defaultEnabled: true,
      dependsOn: ['provider'],
    },
    registerMain: (host) => {
      received = host.requireService(token)
    },
  }

  const { ipcMain } = createFakeIpcMain()
  const { report } = loadMainModules({ ipcMain, modules: [consumer, provider] })

  assert.deepEqual(report.errors, [])
  assert.deepEqual(received, { value: 42 })
}

function testThrowingModuleIsIsolated(): void {
  const bad: CapabilityModule = {
    manifest: { id: 'bad', displayName: 'Bad', version: 1, defaultEnabled: true },
    registerMain: () => {
      throw new Error('boom')
    },
  }
  const good: CapabilityModule = {
    manifest: { id: 'good', displayName: 'Good', version: 1, defaultEnabled: true },
    registerMain: (host) => host.registerIpc('good:ping', () => 'pong'),
  }

  const { ipcMain, handled } = createFakeIpcMain()
  const { report } = loadMainModules({ ipcMain, modules: [bad, good] })

  assert.deepEqual(report.loaded, ['good'], 'a throwing module must not abort the others')
  assert.equal(report.errors.length, 1)
  assert.equal(report.errors[0].id, 'bad')
  assert.deepEqual(handled, ['good:ping'])
}

function testDuplicateChannelIsReportedNotFatal(): void {
  const first: CapabilityModule = {
    manifest: { id: 'first', displayName: 'First', version: 1, defaultEnabled: true },
    registerMain: (host) => host.registerIpc('shared:channel', () => 1),
  }
  const second: CapabilityModule = {
    manifest: { id: 'second', displayName: 'Second', version: 1, defaultEnabled: true },
    registerMain: (host) => host.registerIpc('shared:channel', () => 2),
  }

  const { ipcMain, handled } = createFakeIpcMain()
  const { report, kernel } = loadMainModules({ ipcMain, modules: [first, second] })

  assert.deepEqual(report.loaded, ['first'])
  assert.equal(report.errors.length, 1)
  assert.equal(report.errors[0].id, 'second')
  assert.deepEqual(handled, ['shared:channel'], 'channel handled exactly once')
  assert.equal(kernel.ownedChannels().get('shared:channel'), 'first')
}

function testLifecycleAndSidecarsCollected(): void {
  const mod: CapabilityModule = {
    manifest: { id: 'svc', displayName: 'Svc', version: 1, defaultEnabled: true },
    registerMain: (host) => {
      host.onStartup(() => undefined)
      host.onShutdown(() => undefined)
      host.registerSidecar({ id: 'svc-py', kind: 'python', module: 'svc_core' })
    },
  }

  const { ipcMain } = createFakeIpcMain()
  const { kernel, report } = loadMainModules({ ipcMain, modules: [mod] })

  assert.equal(kernel.startupHooks().length, 1)
  assert.equal(kernel.shutdownHooks().length, 1)
  assert.deepEqual(report.sidecars, [{ id: 'svc-py', kind: 'python', module: 'svc_core' }])
}

main()
