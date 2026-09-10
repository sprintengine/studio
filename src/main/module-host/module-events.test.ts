import assert from 'node:assert/strict'
import type { IpcMain } from 'electron'

import { MODULE_EVENTS_CHANNEL, type ModuleEventEnvelope } from '../../shared/modules/events'
import { loadMainModules, type CapabilityModule } from './load-modules'
import { createMainKernel } from './main-host'

// The module-owned event channel (MC-2090): the main→renderer push a module gets
// through its scoped host, and the subscribe verb the request/response bridge
// does not have. What is pinned here is the routing contract — identity is the
// host's, topic and payload are the module's — plus the two decisions the item
// asked for: no replay buffer, and no flood bound.

function createFakeIpcMain(): { ipcMain: IpcMain; handlers: Map<string, (...args: unknown[]) => unknown> } {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ipcMain = {
    handle(channel: string, handler: (...args: unknown[]) => unknown): void {
      handlers.set(channel, handler)
    },
    removeHandler(channel: string): void {
      handlers.delete(channel)
    },
  } as unknown as IpcMain
  return { ipcMain, handlers }
}

function testEmitStampsScopedIdentityAndTime(): void {
  const delivered: ModuleEventEnvelope[] = []
  const { ipcMain } = createFakeIpcMain()
  let clock = 1_000
  const kernel = createMainKernel(ipcMain, {
    deliverModuleEvent: (event) => delivered.push(event),
    now: () => (clock += 1),
  })

  kernel.hostFor('widgets').emit('run-status', { phase: 'done' })
  kernel.hostFor('weather-deck').emit('outlook-refreshed')

  assert.deepEqual(delivered, [
    { sourceModuleId: 'widgets', topic: 'run-status', payload: { phase: 'done' }, emittedAt: 1_001 },
    { sourceModuleId: 'weather-deck', topic: 'outlook-refreshed', emittedAt: 1_002 },
  ])
  assert.equal(
    'payload' in delivered[1],
    false,
    'a bare signal carries no payload key at all, rather than an explicit undefined',
  )
}

function testEmitValidatesTheTopic(): void {
  const { ipcMain } = createFakeIpcMain()
  const kernel = createMainKernel(ipcMain, { deliverModuleEvent: () => {} })
  const host = kernel.hostFor('widgets')

  assert.throws(() => host.emit('', {}), /non-empty topic/)
  assert.throws(() => host.emit('   ', {}), /non-empty topic/)
  assert.throws(() => host.emit('x'.repeat(129), {}), /at most 128 characters/)
  assert.throws(
    () => host.emit(undefined as unknown as string, {}),
    /non-empty topic/,
    'module code calls emit directly, so the topic is untrusted input',
  )
}

function testTopicIsTrimmedNotRewritten(): void {
  const delivered: ModuleEventEnvelope[] = []
  const { ipcMain } = createFakeIpcMain()
  createMainKernel(ipcMain, { deliverModuleEvent: (event) => delivered.push(event) })
    .hostFor('widgets')
    .emit('  run-status  ')
  assert.equal(delivered[0]?.topic, 'run-status', 'the topic is trimmed, never prefixed by the host')
}

function testNothingIsBufferedForLateWindows(): void {
  // The deliberate difference from notifications, which buffer their recent set
  // so a window opened after startup still sees launch diagnostics. Events are
  // signals: one emitted with no window open is dropped, and a subscriber must
  // be correct having missed it.
  const { ipcMain } = createFakeIpcMain()
  const kernel = createMainKernel(ipcMain)
  assert.doesNotThrow(
    () => kernel.hostFor('widgets').emit('run-status', { phase: 'done' }),
    'an emit with no delivery wired is a no-op, never a throw',
  )
  assert.equal(
    (kernel as unknown as { recentModuleEvents?: unknown }).recentModuleEvents,
    undefined,
    'the kernel exposes no event buffer to replay from',
  )
}

function testEmitIsNotFloodBounded(): void {
  // Notifications drop identical repeats and rate overruns because they are
  // user-visible. Dropping an event would instead make a subscriber wrong — a
  // door that never learns its run finished — so nothing here is bounded.
  const delivered: ModuleEventEnvelope[] = []
  const { ipcMain } = createFakeIpcMain()
  const kernel = createMainKernel(ipcMain, {
    deliverModuleEvent: (event) => delivered.push(event),
    now: () => 0,
  })
  const host = kernel.hostFor('widgets')
  for (let index = 0; index < 100; index += 1) host.emit('run-status', { phase: 'grouping' })
  assert.equal(delivered.length, 100, 'every emit is delivered, identical repeats included')
}

function testEventChannelNameIsReservedAgainstModules(): void {
  const { ipcMain } = createFakeIpcMain()
  const kernel = createMainKernel(ipcMain)
  assert.throws(
    () => kernel.hostFor('impostor').registerIpc(MODULE_EVENTS_CHANNEL, async () => null),
    /already registered by module "@host"/,
    'a module cannot claim the host-owned events channel and impersonate the fan-out',
  )
}

async function testEmitFlowsThroughALoadedModule(): Promise<void> {
  const delivered: ModuleEventEnvelope[] = []
  const { ipcMain } = createFakeIpcMain()
  const module: CapabilityModule = {
    manifest: { id: 'widgets', displayName: 'Widgets', version: 1, defaultEnabled: true },
    registerMain(host) {
      host.onStartup(() => {
        host.emit('run-status', { phase: 'reading' })
      })
    },
  }
  const loaded = loadMainModules({
    ipcMain,
    modules: [module],
    deliverModuleEvent: (event) => delivered.push(event),
  })
  assert.deepEqual(loaded.report.errors, [])
  return loaded.kernel.runStartup().then(() => {
    assert.equal(delivered.length, 1, 'a loaded module reaches the delivery sink through its scoped host')
    assert.equal(delivered[0]?.sourceModuleId, 'widgets')
    assert.equal(delivered[0]?.topic, 'run-status')
  })
}

testEmitStampsScopedIdentityAndTime()
testEmitValidatesTheTopic()
testTopicIsTrimmedNotRewritten()
testNothingIsBufferedForLateWindows()
testEmitIsNotFloodBounded()
testEventChannelNameIsReservedAgainstModules()
testEmitFlowsThroughALoadedModule()
  .then(() => console.log('module-events tests passed'))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
