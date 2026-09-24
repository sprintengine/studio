import assert from 'node:assert/strict'
import { test } from 'vitest'

import { shouldSendTerminalPaintVisibility } from './terminalPaintVisibility'

test('a change of what the window wants is always sent', () => {
  assert.equal(
    shouldSendTerminalPaintVisibility({ shouldPaint: true, lastSent: false, mainVisible: false, paneMounted: false }),
    true,
  )
  assert.equal(
    shouldSendTerminalPaintVisibility({
      shouldPaint: false,
      lastSent: undefined,
      mainVisible: false,
      paneMounted: true,
    }),
    true,
  )
})

test('nothing is sent while main already agrees', () => {
  assert.equal(
    shouldSendTerminalPaintVisibility({ shouldPaint: true, lastSent: true, mainVisible: true, paneMounted: true }),
    false,
  )
  assert.equal(
    shouldSendTerminalPaintVisibility({ shouldPaint: false, lastSent: false, mainVisible: false, paneMounted: true }),
    false,
  )
})

// A pane that mounted in a minimized window, or in an inactive workspace,
// told main it was on screen. Main keeps feeding it — and waiting on its acks —
// until it is told otherwise.
test('a session main reports painted that should not be is hidden again', () => {
  assert.equal(
    shouldSendTerminalPaintVisibility({ shouldPaint: false, lastSent: false, mainVisible: true, paneMounted: true }),
    true,
  )
})

test('a hidden session is shown again only while a pane is mounted for it', () => {
  assert.equal(
    shouldSendTerminalPaintVisibility({ shouldPaint: true, lastSent: true, mainVisible: false, paneMounted: true }),
    true,
    'a pane that read its window as hidden, in a state this manager never rendered',
  )
  assert.equal(
    shouldSendTerminalPaintVisibility({ shouldPaint: true, lastSent: true, mainVisible: false, paneMounted: false }),
    false,
    'a pane that is gone was hidden by its own teardown; nothing here would draw',
  )
})
