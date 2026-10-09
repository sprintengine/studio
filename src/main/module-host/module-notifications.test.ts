import assert from 'node:assert/strict'
import type { IpcMain } from 'electron'

import { MODULE_EVENTS_CHANNEL } from '../../shared/modules/events'
import {
  MODULE_NOTIFICATIONS_RECENT_CHANNEL,
  type ModuleNotificationDelivery,
} from '../../shared/modules/notifications'
import type { CapabilityManifest } from '../../shared/modules/manifest'
import { loadMainModules, type CapabilityModule } from './load-modules'
import { createMainKernel } from './main-host'
import { test } from 'vitest'

test('module-notifications', async () => {
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
    const { ipcMain } = createFakeIpcMain()
    const kernel = createMainKernel(ipcMain)
    const delivered = kernel.recentNotifications()

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
    const { ipcMain } = createFakeIpcMain()
    const kernel = createMainKernel(ipcMain, { now: () => clock })
    const delivered = kernel.recentNotifications()
    const host = kernel.hostFor('weather-panel')

    host.notify({ severity: 'warning', title: 'API slow' })
    clock += 100
    host.notify({ severity: 'warning', title: 'API slow' })
    clock += 100
    host.notify({ severity: 'warning', title: 'API degraded' })

    assert.deepEqual(
      delivered.map((n) => n.title),
      ['API slow', 'API degraded'],
      'an identical repeat within the window is dropped; distinct payloads pass',
    )

    // After the window passes, the same payload is allowed again.
    clock += 11_000
    host.notify({ severity: 'warning', title: 'API slow' })
    assert.equal(delivered.length, 3)
  }

  function testRateCapBoundsAModuleButNotOthers(): void {
    let clock = 1_000
    const { ipcMain } = createFakeIpcMain()
    const kernel = createMainKernel(ipcMain, { now: () => clock })
    const delivered = kernel.recentNotifications()
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
    const emitter: CapabilityModule = {
      manifest: { id: 'emitter', displayName: 'Emitter', version: 1, defaultEnabled: true },
      registerMain: (host) => host.notify({ severity: 'info', title: 'Emitter ready' }),
    }

    const { ipcMain } = createFakeIpcMain()
    const { report, kernel } = loadMainModules({ ipcMain, modules: [emitter] })

    assert.deepEqual(report.loaded, ['emitter'])
    // A module that notifies during registerMain lands in the kernel's buffer.
    const delivered = kernel.recentNotifications()
    assert.equal(delivered.length, 1)
    assert.equal(delivered[0].sourceModuleId, 'emitter')
  }

  function testEventChannelNameIsReservedAgainstModules(): void {
    const claimer: CapabilityModule = {
      manifest: { id: 'claimer', displayName: 'Claimer', version: 1, defaultEnabled: true },
      registerMain: (host) => host.registerIpc(MODULE_EVENTS_CHANNEL, () => null),
    }

    const { ipcMain } = createFakeIpcMain()
    const { report, kernel } = loadMainModules({ ipcMain, modules: [claimer] })

    assert.deepEqual(report.loaded, [])
    assert.match(report.errors[0]?.message ?? '', /already registered by module "@host"/)
    assert.equal(kernel.ownedChannels().get(MODULE_EVENTS_CHANNEL), '@host')
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
        throw new Error('exploded reading /Users/someone/.sprintengine/modules/broken-module/main.cjs')
      },
    }
    const failingBundled: CapabilityModule = {
      manifest: { id: 'bundled-broken', displayName: 'Bundled broken', version: 1, defaultEnabled: true },
      registerMain: () => {
        throw new Error('bundled boom')
      },
    }

    const { ipcMain } = createFakeIpcMain()
    const { report, kernel } = loadMainModules({
      ipcMain,
      modules: [blockedThirdParty, failingThirdParty, failingBundled],
      ineligible: { 'untrusted-module': 'untrusted' },
    })
    const delivered = kernel.recentNotifications()

    assert.equal(report.errors.length, 3)
    assert.deepEqual(
      delivered.map((n) => n.sourceModuleId).sort(),
      ['broken-module', 'untrusted-module'],
      'only third-party load errors graduate to notifications',
    )
    for (const notification of delivered) {
      assert.equal(notification.severity, 'error')
    }
    const broken = delivered.find((n) => n.sourceModuleId === 'broken-module')
    assert.equal(
      broken?.body,
      'Module startup failed.',
      'a message containing an absolute path is replaced, never forwarded',
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
})

// ── Delivery to the bell ────────────────────────────────────────────────────

function fakeIpcMain(): { ipcMain: IpcMain; handlers: Map<string, (...args: unknown[]) => unknown> } {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ipcMain = {
    handle(channel: string, handler: (...args: unknown[]) => unknown): void {
      handlers.set(channel, handler)
    },
  } as unknown as IpcMain
  return { ipcMain, handlers }
}

const thirdPartyManifest = (id: string, displayName: string): CapabilityManifest => ({
  id,
  displayName,
  version: 1,
  defaultEnabled: true,
  source: 'third-party',
})

test('a notify is delivered to the clients, stamped with id and display name', () => {
  const { ipcMain } = fakeIpcMain()
  const delivered: ModuleNotificationDelivery[] = []
  const kernel = createMainKernel(ipcMain, {
    deliverModuleNotification: (notification) => delivered.push(notification),
    resolveModuleManifest: (id) => (id === 'acme.radar' ? thirdPartyManifest(id, 'PR Radar') : undefined),
  })
  const host = kernel.hostFor('acme.radar')
  host.notify({
    severity: 'error',
    title: 'CI went red on acme/app#12',
    target: { surfaceId: ' acme.radar ', viewId: 'activity' },
  })
  kernel.hostFor('unknown.module').notify({ severity: 'info', title: 'Hello' })

  assert.equal(delivered.length, 2)
  assert.equal(delivered[0]?.sourceModuleId, 'acme.radar')
  assert.equal(delivered[0]?.sourceModuleName, 'PR Radar')
  assert.deepEqual(delivered[0]?.target, { surfaceId: 'acme.radar', viewId: 'activity' }, 'the target is trimmed')
  assert.equal(delivered[1]?.sourceModuleName, 'unknown.module', 'no manifest, the id names the row')
  assert.notEqual(delivered[0]?.id, delivered[1]?.id, 'every delivery has its own id')
  assert.deepEqual(
    kernel.recentNotifications().map((notification) => notification.title),
    ['CI went red on acme/app#12', 'Hello'],
    'the recent buffer keeps what was delivered',
  )
})

test('supports("notifications") is true only where delivery is wired', () => {
  const unwired = createMainKernel(fakeIpcMain().ipcMain)
  assert.equal(unwired.hostFor('acme.radar').supports('notifications'), false)
  const wired = createMainKernel(fakeIpcMain().ipcMain, { deliverModuleNotification: () => undefined })
  assert.equal(wired.hostFor('acme.radar').supports('notifications'), true)
})

test('a window that boots late reads the backlog through the host channel', async () => {
  const { ipcMain, handlers } = fakeIpcMain()
  const kernel = createMainKernel(ipcMain, { deliverModuleNotification: () => undefined })
  kernel.hostFor('acme.board').notify({ severity: 'info', title: 'Standup ready' })
  assert.equal(kernel.ownedChannels().get(MODULE_NOTIFICATIONS_RECENT_CHANNEL), '@host')
  const recent = (await handlers.get(MODULE_NOTIFICATIONS_RECENT_CHANNEL)?.({})) as ModuleNotificationDelivery[]
  assert.equal(recent.length, 1)
  assert.equal(recent[0]?.title, 'Standup ready')
  recent[0]!.title = 'mutated'
  assert.equal(kernel.recentNotifications()[0]?.title, 'Standup ready', 'the backlog hands out copies')
  assert.throws(
    () => kernel.hostFor('impostor').registerIpc(MODULE_NOTIFICATIONS_RECENT_CHANNEL, () => []),
    /already registered by module "@host"/,
  )
})

test('a malformed target throws; the same words about another door are not a repeat', () => {
  let clock = 1_000
  const delivered: ModuleNotificationDelivery[] = []
  const kernel = createMainKernel(fakeIpcMain().ipcMain, {
    now: () => clock,
    deliverModuleNotification: (notification) => delivered.push(notification),
  })
  const host = kernel.hostFor('acme.radar')
  assert.throws(() => host.notify({ severity: 'info', title: 'x', target: { surfaceId: '  ' } }), /surfaceId/)
  assert.throws(() => host.notify({ severity: 'info', title: 'x', target: 'acme.radar' } as never), /target/)
  assert.throws(
    () => host.notify({ severity: 'info', title: 'x', target: { surfaceId: 'acme.radar', viewId: 3 } } as never),
    /viewId/,
  )
  host.notify({ severity: 'error', title: 'CI failed', target: { surfaceId: 'acme.radar', viewId: 'pr-1' } })
  clock += 10
  host.notify({ severity: 'error', title: 'CI failed', target: { surfaceId: 'acme.radar', viewId: 'pr-2' } })
  clock += 10
  host.notify({ severity: 'error', title: 'CI failed', target: { surfaceId: 'acme.radar', viewId: 'pr-2' } })
  assert.deepEqual(
    delivered.map((notification) => notification.target?.viewId),
    ['pr-1', 'pr-2'],
    'two doors are two rows; the identical repeat is still dropped',
  )
})

test('a client that cannot be reached does not make notify throw', () => {
  const kernel = createMainKernel(fakeIpcMain().ipcMain, {
    deliverModuleNotification: () => {
      throw new Error('window gone')
    },
  })
  assert.doesNotThrow(() => kernel.hostFor('acme.radar').notify({ severity: 'info', title: 'Still kept' }))
  assert.equal(kernel.recentNotifications().length, 1)
})
