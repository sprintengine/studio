// @vitest-environment jsdom
import assert from 'node:assert/strict'
import { test } from 'vitest'

import { bindFocusSourceAttribute, focusSourceForKey } from './focusSource'

function press(key: string, target: Element, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, ...init })
  target.dispatchEvent(event)
  return event
}

test('a window that has seen no input draws no ring', () => {
  const root = document.createElement('div')
  const unbind = bindFocusSourceAttribute(root, window)
  assert.equal(root.dataset['focusSource'], 'pointer')
  unbind()
})

test('Tab and an arrow on a control hand the ring to the keyboard; a pointer press takes it back', () => {
  const root = document.createElement('div')
  const button = document.body.appendChild(document.createElement('button'))
  const unbind = bindFocusSourceAttribute(root, window)

  press('Tab', button)
  assert.equal(root.dataset['focusSource'], 'keyboard')

  window.dispatchEvent(new Event('pointerdown'))
  assert.equal(root.dataset['focusSource'], 'pointer')

  press('ArrowDown', button)
  assert.equal(root.dataset['focusSource'], 'keyboard')

  unbind()
  window.dispatchEvent(new Event('pointerdown'))
  assert.equal(root.dataset['focusSource'], 'keyboard', 'unbinding stops the tracking')
  button.remove()
})

test('typing, and keys a field keeps for itself, move no focus', () => {
  const textarea = document.createElement('textarea')
  const input = document.createElement('input')
  const checkbox = Object.assign(document.createElement('input'), { type: 'checkbox' })
  const terminal = document.createElement('div')
  terminal.className = 'xterm'
  const xtermField = terminal.appendChild(document.createElement('textarea'))

  const sourceOf = (key: string, target: Element, init: Partial<KeyboardEvent> = {}) =>
    focusSourceForKey({ key, target, metaKey: false, ctrlKey: false, altKey: false, ...init })

  assert.equal(sourceOf('a', document.body), null, 'a letter is typing')
  assert.equal(sourceOf('ArrowUp', textarea), null, 'an arrow in the composer moves its caret')
  assert.equal(sourceOf('ArrowLeft', input), null, 'an arrow in a search field moves its caret')
  assert.equal(sourceOf('ArrowDown', checkbox), 'keyboard', 'an arrow on a checkbox is navigation')
  assert.equal(sourceOf('Tab', xtermField), null, 'Tab in a terminal goes to the shell')
  assert.equal(sourceOf('Tab', textarea), 'keyboard', 'Tab out of the composer moves focus')
  assert.equal(sourceOf('ArrowDown', document.body, { metaKey: true }), null, 'a chord is a shortcut, not navigation')
})
