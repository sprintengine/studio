import assert from 'node:assert/strict'
import { test } from 'vitest'

import { shouldSendTerminalPaintVisibility } from './terminalPaintVisibility'

const base = { lastSent: undefined, mainVisible: false, paneMounted: true, paneAttachedHidden: false }

test('a change of what the window wants is always sent', () => {
  assert.equal(shouldSendTerminalPaintVisibility({ ...base, shouldPaint: true, lastSent: false }), true)
  assert.equal(shouldSendTerminalPaintVisibility({ ...base, shouldPaint: false }), true)
})

test('nothing is sent while main already agrees', () => {
  assert.equal(
    shouldSendTerminalPaintVisibility({ ...base, shouldPaint: true, lastSent: true, mainVisible: true }),
    false,
  )
  assert.equal(shouldSendTerminalPaintVisibility({ ...base, shouldPaint: false, lastSent: false }), false)
})

// A pane that mounted in an inactive workspace told main it was on screen.
// Main keeps feeding it — and waiting on its acks — until it is told otherwise.
test('a pane of this window that main reports painted, and should not be, is hidden again', () => {
  assert.equal(
    shouldSendTerminalPaintVisibility({ ...base, shouldPaint: false, lastSent: false, mainVisible: true }),
    true,
  )
  assert.equal(
    shouldSendTerminalPaintVisibility({
      ...base,
      shouldPaint: false,
      lastSent: false,
      mainVisible: true,
      paneMounted: false,
    }),
    false,
    'another window’s pane is that window’s to say: two windows never take turns overruling each other',
  )
})

test('a hidden pane is shown again only once it has attached reporting itself hidden', () => {
  assert.equal(
    shouldSendTerminalPaintVisibility({ ...base, shouldPaint: true, lastSent: true, paneAttachedHidden: true }),
    true,
    'it read its window as hidden, in a state this manager never rendered',
  )
  assert.equal(
    shouldSendTerminalPaintVisibility({ ...base, shouldPaint: true, lastSent: true }),
    false,
    'a pane between mount and attach (a remount) is left to its attach: shown now, it would get live output ahead of its replay',
  )
})
