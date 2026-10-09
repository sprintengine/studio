import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { afterAll, beforeAll, test } from 'vitest'

import { shouldRedirectToComposer, typedCharacter, typesForItself } from './typeToComposer'

// What counts as typing that belongs in the composer, and where it is taken
// from.

let dom: JSDOM
const saved: Record<string, unknown> = {}

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>')
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  for (const key of ['HTMLElement', 'Element']) {
    saved[key] = anyGlobal[key]
    anyGlobal[key] = (dom.window as unknown as Record<string, unknown>)[key]
  }
})

afterAll(() => {
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(saved)) anyGlobal[key] = value
  dom.window.close()
})

function chat(html: string): Document {
  dom.window.document.body.innerHTML = html
  return dom.window.document
}

const plain = { metaKey: false, ctrlKey: false, altKey: false }

test('a printable character is typing, with or without Shift', () => {
  assert.equal(typedCharacter({ ...plain, key: 'a' }), 'a')
  assert.equal(typedCharacter({ ...plain, key: 'A' }), 'A')
  assert.equal(typedCharacter({ ...plain, key: 'é' }), 'é')
  assert.equal(typedCharacter({ ...plain, key: '?' }), '?')
})

test('a chord, a named key, Space and a composition are not', () => {
  assert.equal(typedCharacter({ ...plain, key: 'c', metaKey: true }), null)
  assert.equal(typedCharacter({ ...plain, key: 'q', ctrlKey: true }), null)
  assert.equal(typedCharacter({ ...plain, key: 'å', altKey: true }), null)
  assert.equal(typedCharacter({ ...plain, key: 'Escape' }), null)
  assert.equal(typedCharacter({ ...plain, key: 'ArrowDown' }), null)
  assert.equal(typedCharacter({ ...plain, key: 'PageDown' }), null)
  assert.equal(typedCharacter({ ...plain, key: ' ' }), null)
  assert.equal(typedCharacter({ ...plain, key: 'k', isComposing: true }), null)
})

test('a key pressed in the transcript is redirected', () => {
  const doc = chat('<div role="log" tabindex="-1"><p id="row">Reply</p></div>')
  assert.equal(shouldRedirectToComposer(doc.getElementById('row'), doc), true)
})

test('a field that types for itself keeps its keys', () => {
  const doc = chat(
    '<textarea id="t"></textarea><input id="i" type="text"><input id="c" type="checkbox"><div id="e" contenteditable="true"></div>',
  )
  assert.equal(typesForItself(doc.getElementById('t')), true)
  assert.equal(typesForItself(doc.getElementById('i')), true)
  assert.equal(typesForItself(doc.getElementById('c')), false)
  assert.equal(shouldRedirectToComposer(doc.getElementById('t'), doc), false)
})

test('nothing is taken from inside a menu or list, or while a menu or popover is open', () => {
  const inside = chat('<div role="menu"><div role="menuitem" id="item">Copy</div></div>')
  assert.equal(shouldRedirectToComposer(inside.getElementById('item'), inside), false)
  const menu = chat('<div role="log"><p id="row">Reply</p></div><div role="menu"></div>')
  assert.equal(shouldRedirectToComposer(menu.getElementById('row'), menu), false)
  const popover = chat(
    '<div role="log"><p id="row">Reply</p></div><button aria-haspopup="listbox" aria-expanded="true"></button>',
  )
  assert.equal(shouldRedirectToComposer(popover.getElementById('row'), popover), false)
})

test('a listbox that lives on the page, or a menu in a layer kept out of sight, does not stop typing', () => {
  // The Git panel's change groups and the Backlog's list are listboxes for
  // good, and pane tabs and workspaces stay mounted when they are not shown.
  const doc = chat(
    '<div role="log"><p id="row">Reply</p></div>' +
      '<div role="listbox" aria-label="Changes"></div>' +
      '<div class="invisible"><div role="menu"></div></div>' +
      '<div inert><button aria-haspopup="menu" aria-expanded="true"></button></div>' +
      '<div aria-hidden="true"><div role="dialog" aria-modal="true"></div></div>',
  )
  assert.equal(shouldRedirectToComposer(doc.getElementById('row'), doc), true)
})

test('a key an input method is still composing is not typing', () => {
  assert.equal(typedCharacter({ ...plain, key: 'Process' }), null)
  assert.equal(typedCharacter({ ...plain, key: 'a', keyCode: 229 }), null)
})

test('nothing is taken while text is selected', () => {
  const doc = chat('<div role="log"><p id="row">Reply text</p></div>')
  const row = doc.getElementById('row')!
  const range = doc.createRange()
  range.selectNodeContents(row)
  doc.getSelection()!.removeAllRanges()
  doc.getSelection()!.addRange(range)
  assert.equal(shouldRedirectToComposer(row, doc), false)
  doc.getSelection()!.removeAllRanges()
  assert.equal(shouldRedirectToComposer(row, doc), true)
})
