import assert from 'node:assert/strict'
import { test } from 'vitest'

import { readTerminalWebglPresence } from './terminalWebglPresence'

type FakeElement = {
  isConnected: boolean
  closest: (selector: string) => unknown
  checkVisibility?: (options?: { checkVisibilityCSS?: boolean; visibilityProperty?: boolean }) => boolean
}

function element(options: { connected?: boolean; cold?: boolean; visible?: boolean; probe?: boolean } = {}) {
  const fake: FakeElement = {
    isConnected: options.connected ?? true,
    closest: (selector) => (options.cold && selector === '[data-layer-state="cold"]' ? {} : null),
  }
  if (options.probe !== false) {
    fake.checkVisibility = (probeOptions) => {
      // The CSS visibility property is what hides a warm layer; the call must
      // ask about it or a warm layer reads as seen.
      assert.equal(probeOptions?.visibilityProperty, true)
      return options.visible ?? true
    }
  }
  return fake as unknown as Element
}

test('presence of a terminal element', () => {
  assert.equal(readTerminalWebglPresence(element(), true), 'on-screen')
  assert.equal(readTerminalWebglPresence(element({ visible: false }), true), 'parked', 'warm layer or background tab')
  assert.equal(readTerminalWebglPresence(element(), false), 'parked', 'the window is hidden')
  assert.equal(readTerminalWebglPresence(element({ cold: true }), true), 'off', 'a cold layer')
  assert.equal(readTerminalWebglPresence(element({ connected: false }), true), 'off')
  assert.equal(readTerminalWebglPresence(null, true), 'off')
  assert.equal(
    readTerminalWebglPresence(element({ probe: false }), true),
    'on-screen',
    'an engine that cannot tell treats the pane as seen, as before',
  )
})
