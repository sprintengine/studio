import assert from 'node:assert/strict'
import { test } from 'vitest'

import { createRendererHost } from './renderer-host'

// A module opens only the surfaces it registered: another module's id, an
// unknown id, a disabled module and an unwired shell all answer false and
// open nothing.
function harness() {
  const kernel = createRendererHost()
  const opened: string[] = []
  const Component = () => null
  kernel.hostFor('acme.compass').registerGlobalSurface({ id: 'compass', Component })
  kernel.hostFor('acme.compass').registerModalSurface({ id: 'compass-picker', label: 'Pick', Component })
  kernel.hostFor('acme.other').registerGlobalSurface({ id: 'other-page', Component })
  kernel.hostFor('acme.other').registerModalSurface({ id: 'other-modal', label: 'Other', Component })
  return { kernel, opened, compass: kernel.hostFor('acme.compass') }
}

test('before the shell wires its opener, nothing opens', () => {
  const { compass } = harness()
  assert.equal(compass.openGlobalSurface('compass'), false)
  assert.equal(compass.openModalSurface('compass-picker'), false)
})

test('a module opens its own global and modal surfaces', () => {
  const { kernel, opened, compass } = harness()
  kernel.setSurfaceOpener({
    openGlobalSurface: (id) => opened.push(`global:${id}`),
    openModalSurface: (id) => opened.push(`modal:${id}`),
  })
  assert.equal(compass.openGlobalSurface('compass'), true)
  assert.equal(compass.openGlobalSurface(' compass '), true, 'a global id is looked up as it was stored, trimmed')
  assert.equal(compass.openModalSurface('compass-picker'), true)
  assert.deepEqual(opened, ['global:compass', 'global:compass', 'modal:compass-picker'])
})

test("another module's surface, an unknown id, or the wrong kind answers false", () => {
  const { kernel, opened, compass } = harness()
  kernel.setSurfaceOpener({
    openGlobalSurface: (id) => opened.push(`global:${id}`),
    openModalSurface: (id) => opened.push(`modal:${id}`),
  })
  assert.equal(compass.openGlobalSurface('other-page'), false)
  assert.equal(compass.openModalSurface('other-modal'), false)
  assert.equal(compass.openGlobalSurface('extensions-home'), false)
  assert.equal(compass.openModalSurface('settings'), false)
  assert.equal(compass.openGlobalSurface('compass-picker'), false)
  assert.equal(compass.openModalSurface('compass'), false)
  assert.equal(compass.openGlobalSurface(undefined as never), false)
  assert.deepEqual(opened, [])
})

test('a disabled module opens nothing', () => {
  const { kernel, opened, compass } = harness()
  kernel.setSurfaceOpener({
    openGlobalSurface: (id) => opened.push(`global:${id}`),
    openModalSurface: (id) => opened.push(`modal:${id}`),
  })
  let enabled = false
  kernel.setModuleEnablementResolver((moduleId) => moduleId !== 'acme.compass' || enabled)
  assert.equal(compass.openGlobalSurface('compass'), false)
  assert.equal(compass.openModalSurface('compass-picker'), false)
  enabled = true
  assert.equal(compass.openGlobalSurface('compass'), true)
  assert.deepEqual(opened, ['global:compass'])
})
