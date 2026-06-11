import assert from 'node:assert/strict'
import type { IpcMain } from 'electron'

import {
  MODULE_NOTIFICATIONS_EVENT_CHANNEL,
  MODULE_NOTIFICATIONS_RECENT_CHANNEL,
  type ModuleNotification,
} from '../../shared/modules/notifications'
import type { CapabilityManifest } from '../../shared/modules/manifest'
import { loadMainModules, type CapabilityModule } from './load-modules'
import { createMainKernel } from './main-host'

function createFakeIpcMain(): { ipcMain: IpcMain; handlers: Map<string, (...args: unknown[]) => unknown> } {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ipcMain = {
    handle(channel: string, handler: (...args: unknown[]) => unknown): void {
      handlers.set(channel, handler)
    },
  } as unknown as IpcMain
  return { ipcMain, handlers }
}

function testNotifyStampsScopedModuleIdentity(): void {
  const delivered: ModuleNotification[] = []
  const { ipcMain } = createFakeIpcMain()
  const kernel = createMainKernel(ipcMain, { deliverNotification: (n) => delivered.push(n) })

  const host = kernel.hostFor('weather-panel')
  // A caller-supplied sourceModuleId must be ignored: identity is host scope.
  host.notify({
    severity: 'info',
    title: 'Forecast ready',
    body: 'Tomorrow looks clear.',
    sourceModuleId: 'git',
  } as never)

  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].sourceModuleId, 'weather-panel')
  assert.equal(delivered[0].severity, 'info')
  assert.equal(delivered[0].title, 'Forecast ready')
  assert.equal(delivered[0].body, 'Tomorrow looks clear.')
  assert.equal(typeof delivered[0].emittedAt, 'number')
}

function testInvalidNotifyPayloadThrows(): void {
  const { ipcMain } = createFakeIpcMain()
  const kernel = createMainKernel(ipcMain)
  const host = kernel.hostFor('weather-panel')

  assert.throws(() => host.notify({ severity: 'fatal', title: 'x' } as never), /severity/)
  assert.throws(() => host.notify({ severity: 'info', title: '   ' }), /non-empty title/)
  assert.throws(() => host.notify({ severity: 'info', title: 'ok', body: 42 } as never), /body/)
  assert.throws(() => host.notify(undefined as never), /payload object/)
}

function testIdenticalRepeatIsDroppedAndDistinctPasses(): void {
  let clock = 1_000
  const delivered: ModuleNotification[] = []
  const { ipcMain } = createFakeIpcMain()
  const kernel = createMainKernel(ipcMain, { deliverNotification: (n) => delivered.push(n), now: () => clock })
  const host = kernel.hostFor('weather-panel')

  host.notify({ severity: 'warning', title: 'API slow' })
  clock += 100
  host.notify({ severity: 'warning', title: 'API slow' })
  clock += 100
  host.notify({ severity: 'warning', title: 'API degraded' })

  assert.deepEqual(
    delivered.map((n) => n.title),
    ['API slow', 'API degraded'],
    'an identical repeat within the window is dropped; distinct payloads pass'
  )

  // After the window passes, the same payload is allowed again.
  clock += 11_000
  host.notify({ severity: 'warning', title: 'API slow' })
  assert.equal(delivered.length, 3)
}

function testRateCapBoundsAModuleButNotOthers(): void {
  let clock = 1_000
  const delivered: ModuleNotification[] = []
  const { ipcMain } = createFakeIpcMain()
  const kernel = createMainKernel(ipcMain, { deliverNotification: (n) => delivered.push(n), now: () => clock })
  const noisy = kernel.hostFor('noisy')
  const quiet = kernel.hostFor('quiet')

  for (let i = 0; i < 30; i += 1) {
    clock += 10
    noisy.notify({ severity: 'info', title: `tick ${i}` })
  }
  assert.equal(delivered.length, 20, 'the per-module rate cap bounds the channel')

  quiet.notify({ severity: 'info', title: 'unaffected' })
  assert.equal(delivered.at(-1)?.sourceModuleId, 'quiet', 'one module flooding must not silence another')

  // A fresh window restores the capped module.
  clock += 11_000
  noisy.notify({ severity: 'info', title: 'recovered' })
  assert.equal(delivered.at(-1)?.title, 'recovered')
}

function testNotificationsFlowThroughLoadedModuleAndRecentBuffer(): void {
  const delivered: ModuleNotification[] = []
  const emitter: CapabilityModule = {
    manifest: { id: 'emitter', displayName: 'Emitter', version: 1, defaultEnabled: true },
    registerMain: (host) => host.notify({ severity: 'info', title: 'Emitter ready' }),
  }

  const { ipcMain, handlers } = createFakeIpcMain()
  const { report, kernel } = loadMainModules({
    ipcMain,
    modules: [emitter],
    deliverNotification: (n) => delivered.push(n),
  })

  assert.deepEqual(report.loaded, ['emitter'])
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].sourceModuleId, 'emitter')

  // The recent buffer is served over the host-owned invoke channel so windows
  // opened after startup can replay launch-time notifications.
  const recentHandler = handlers.get(MODULE_NOTIFICATIONS_RECENT_CHANNEL)
  assert.equal(typeof recentHandler, 'function')
  assert.deepEqual(recentHandler!(), kernel.recentNotifications())
  assert.equal(kernel.recentNotifications().length, 1)
}

function testEventChannelNameIsReservedAgainstModules(): void {
  const claimer: CapabilityModule = {
    manifest: { id: 'claimer', displayName: 'Claimer', version: 1, defaultEnabled: true },
    registerMain: (host) => host.registerIpc(MODULE_NOTIFICATIONS_EVENT_CHANNEL, () => null),
  }

  const { ipcMain } = createFakeIpcMain()
  const { report, kernel } = loadMainModules({ ipcMain, modules: [claimer] })

  assert.deepEqual(report.loaded, [])
  assert.match(report.errors[0]?.message ?? '', /already registered by module "@host"/)
  assert.equal(kernel.ownedChannels().get(MODULE_NOTIFICATIONS_EVENT_CHANNEL), '@host')
}

function thirdPartyManifestOnly(id: string): CapabilityModule {
  const manifest: CapabilityManifest = {
    id,
    displayName: id,
    version: 1,
    defaultEnabled: true,
    source: 'third-party',
    entry: { main: 'main.cjs' },
  }
  return { manifest }
}

function testThirdPartyLoadErrorsBecomeNotificationsBundledStayLogOnly(): void {
  const delivered: ModuleNotification[] = []
  const blockedThirdParty = thirdPartyManifestOnly('untrusted-module')
  const failingThirdParty: CapabilityModule = {
    manifest: {
      id: 'broken-module',
      displayName: 'Broken',
      version: 1,
      defaultEnabled: true,
      source: 'third-party',
      entry: { main: 'main.cjs' },
    },
    registerMain: () => {
      throw new Error('exploded reading /Users/someone/.multicode/modules/broken-module/main.cjs')
    },
  }
  const failingBundled: CapabilityModule = {
    manifest: { id: 'bundled-broken', displayName: 'Bundled broken', version: 1, defaultEnabled: true },
    registerMain: () => {
      throw new Error('bundled boom')
    },
  }

  const { ipcMain } = createFakeIpcMain()
  const { report } = loadMainModules({
    ipcMain,
    modules: [blockedThirdParty, failingThirdParty, failingBundled],
    ineligible: { 'untrusted-module': 'untrusted' },
    deliverNotification: (n) => delivered.push(n),
  })

  assert.equal(report.errors.length, 3)
  assert.deepEqual(
    delivered.map((n) => n.sourceModuleId).sort(),
    ['broken-module', 'untrusted-module'],
    'only third-party load errors graduate to notifications'
  )
  for (const notification of delivered) {
    assert.equal(notification.severity, 'error')
  }
  const broken = delivered.find((n) => n.sourceModuleId === 'broken-module')
  assert.equal(
    broken?.body,
    'Module startup failed.',
    'a message containing an absolute path is replaced, never forwarded'
  )
  const untrusted = delivered.find((n) => n.sourceModuleId === 'untrusted-module')
  assert.match(untrusted?.body ?? '', /not trusted yet/)
}

testNotifyStampsScopedModuleIdentity()
testInvalidNotifyPayloadThrows()
testIdenticalRepeatIsDroppedAndDistinctPasses()
testRateCapBoundsAModuleButNotOthers()
testNotificationsFlowThroughLoadedModuleAndRecentBuffer()
testEventChannelNameIsReservedAgainstModules()
testThirdPartyLoadErrorsBecomeNotificationsBundledStayLogOnly()
console.log('module-notifications tests passed')
