import assert from 'node:assert/strict'

import { MODULE_BRIDGE_INVOKE_CHANNEL, type ModuleBridgeInvokeResult } from '../../shared/modules/bridge'
import type { CapabilityManifest } from '../../shared/modules/manifest'
import { createFakeIpcMain, type FakeIpcMain } from './ipc-main-fake.test-helper'
import { createMainKernel } from './main-host'

function manifest(overrides: Partial<CapabilityManifest> & { id: string }): CapabilityManifest {
  return {
    displayName: overrides.id,
    version: 1,
    defaultEnabled: true,
    ...overrides,
  }
}

const MANIFESTS: Record<string, CapabilityManifest> = {
  'weather-deck': manifest({
    id: 'weather-deck',
    source: 'third-party',
    permissions: ['network', 'ipc:invoke'],
  }),
  'quiet-deck': manifest({
    id: 'quiet-deck',
    source: 'third-party',
    permissions: ['network'],
  }),
  automations: manifest({ id: 'automations', source: 'bundled' }),
}

function createBridgeFixture(): FakeIpcMain {
  const fake = createFakeIpcMain()
  const kernel = createMainKernel(fake.ipcMain, {
    resolveModuleManifest: (moduleId) => MANIFESTS[moduleId],
  })
  kernel.hostFor('weather-deck').registerIpc('weather-deck:forecast', (_event, city: unknown) => ({
    city,
    summary: 'clear',
  }))
  kernel.hostFor('weather-deck').registerIpc('forecast:global', () => 'unprefixed')
  kernel.hostFor('quiet-deck').registerIpc('quiet-deck:ping', () => 'pong')
  kernel.hostFor('automations').registerIpc('automations:list', () => [])
  return fake
}

async function bridgeInvoke(fake: FakeIpcMain, request: unknown): Promise<ModuleBridgeInvokeResult> {
  return (await fake.invoke(MODULE_BRIDGE_INVOKE_CHANNEL, request)) as ModuleBridgeInvokeResult
}

async function testDispatcherRoutesOwnedThirdPartyChannel(): Promise<void> {
  const fake = createBridgeFixture()
  const outcome = await bridgeInvoke(fake, { channel: 'weather-deck:forecast', payload: 'Dublin' })
  assert.deepEqual(outcome, { ok: true, result: { city: 'Dublin', summary: 'clear' } })
}

async function testDispatcherRefusesUnknownChannel(): Promise<void> {
  const fake = createBridgeFixture()
  const outcome = await bridgeInvoke(fake, { channel: 'weather-deck:missing' })
  assert.equal(outcome.ok, false)
  assert.equal(!outcome.ok && outcome.code, 'unknown_channel')
}

async function testDispatcherRefusesMalformedRequest(): Promise<void> {
  const fake = createBridgeFixture()
  for (const request of [undefined, null, 'weather-deck:forecast', { channel: 42 }]) {
    const outcome = await bridgeInvoke(fake, request)
    assert.equal(outcome.ok, false, `request ${JSON.stringify(request)} must be refused`)
    assert.equal(!outcome.ok && outcome.code, 'unknown_channel')
  }
}

async function testDispatcherRefusesChannelWithoutOwnerPrefix(): Promise<void> {
  const fake = createBridgeFixture()
  const outcome = await bridgeInvoke(fake, { channel: 'forecast:global' })
  assert.equal(outcome.ok, false)
  assert.equal(!outcome.ok && outcome.code, 'not_bridgeable')
}

async function testDispatcherRefusesBundledModuleChannel(): Promise<void> {
  const fake = createBridgeFixture()
  const outcome = await bridgeInvoke(fake, { channel: 'automations:list' })
  assert.equal(outcome.ok, false)
  assert.equal(!outcome.ok && outcome.code, 'not_bridgeable')
}

async function testDispatcherRefusesWithoutInvokePermission(): Promise<void> {
  const fake = createBridgeFixture()
  const outcome = await bridgeInvoke(fake, { channel: 'quiet-deck:ping' })
  assert.equal(outcome.ok, false)
  assert.equal(!outcome.ok && outcome.code, 'permission_missing')
  assert.match(!outcome.ok ? outcome.message : '', /ipc:invoke/)
}

async function testDispatcherRefusesWithoutManifestResolver(): Promise<void> {
  const fake = createFakeIpcMain()
  const kernel = createMainKernel(fake.ipcMain)
  kernel.hostFor('weather-deck').registerIpc('weather-deck:forecast', () => 'clear')
  const outcome = await bridgeInvoke(fake, { channel: 'weather-deck:forecast' })
  assert.equal(outcome.ok, false)
  assert.equal(!outcome.ok && outcome.code, 'not_bridgeable')
}

async function testHandlerErrorsPropagateAsRejections(): Promise<void> {
  const fake = createFakeIpcMain()
  const kernel = createMainKernel(fake.ipcMain, {
    resolveModuleManifest: (moduleId) => MANIFESTS[moduleId],
  })
  kernel.hostFor('weather-deck').registerIpc('weather-deck:forecast', () => {
    throw new Error('forecast requires a city name')
  })
  await assert.rejects(
    () => bridgeInvoke(fake, { channel: 'weather-deck:forecast' }),
    /forecast requires a city name/,
    'application errors keep normal invoke rejection semantics; only bridgeability refusals are structured'
  )
}

async function testUnregisterModuleRemovesBridgedHandler(): Promise<void> {
  const fake = createFakeIpcMain()
  const kernel = createMainKernel(fake.ipcMain, {
    resolveModuleManifest: (moduleId) => MANIFESTS[moduleId],
  })
  kernel.hostFor('weather-deck').registerIpc('weather-deck:forecast', () => 'clear')
  await kernel.unregisterModule('weather-deck')
  const outcome = await bridgeInvoke(fake, { channel: 'weather-deck:forecast' })
  assert.equal(outcome.ok, false)
  assert.equal(!outcome.ok && outcome.code, 'unknown_channel')
}

function testBridgeChannelIsReservedToHost(): void {
  const fake = createFakeIpcMain()
  const kernel = createMainKernel(fake.ipcMain)
  assert.equal(kernel.ownedChannels().get(MODULE_BRIDGE_INVOKE_CHANNEL), '@host')
  assert.throws(
    () => kernel.hostFor('impostor').registerIpc(MODULE_BRIDGE_INVOKE_CHANNEL, () => undefined),
    /already registered by module "@host"/,
    'a module cannot claim the dispatcher channel'
  )
}

async function main(): Promise<void> {
  await testDispatcherRoutesOwnedThirdPartyChannel()
  await testDispatcherRefusesUnknownChannel()
  await testDispatcherRefusesMalformedRequest()
  await testDispatcherRefusesChannelWithoutOwnerPrefix()
  await testDispatcherRefusesBundledModuleChannel()
  await testDispatcherRefusesWithoutInvokePermission()
  await testDispatcherRefusesWithoutManifestResolver()
  await testHandlerErrorsPropagateAsRejections()
  await testUnregisterModuleRemovesBridgedHandler()
  testBridgeChannelIsReservedToHost()

  console.log('module-bridge tests passed')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
