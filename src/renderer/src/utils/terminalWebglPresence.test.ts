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

const shown = { visibilityState: 'visible' as DocumentVisibilityState }
const hidden = { visibilityState: 'hidden' as DocumentVisibilityState }

test('presence of a terminal element', () => {
  assert.equal(readTerminalWebglPresence(element(), shown), 'on-screen')
  assert.equal(readTerminalWebglPresence(element({ visible: false }), shown), 'parked', 'warm layer or background tab')
  assert.equal(readTerminalWebglPresence(element(), hidden), 'parked', 'the window is hidden')
  assert.equal(readTerminalWebglPresence(element({ cold: true }), shown), 'off', 'a cold layer')
  assert.equal(readTerminalWebglPresence(element({ connected: false }), shown), 'off')
  assert.equal(readTerminalWebglPresence(null, shown), 'off')
  assert.equal(
    readTerminalWebglPresence(element({ probe: false }), shown),
    'on-screen',
    'an engine that cannot tell treats the pane as seen, as before',
  )
})
