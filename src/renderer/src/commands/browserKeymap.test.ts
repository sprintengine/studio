import { expect, test } from 'vitest'

import { defaultKeybindingsHere } from './browserKeymap'

test('a desktop window keeps every default', () => {
  expect(defaultKeybindingsHere(['Primary+W'], false)).toEqual(['Primary+W'])
})

test('a browser tab gets the chords the browser leaves alone', () => {
  expect(defaultKeybindingsHere(['Primary+W'], true)).toEqual(['Alt+W'])
  expect(defaultKeybindingsHere(['Primary+N'], true)).toEqual(['Alt+N'])
  expect(defaultKeybindingsHere(['Primary+3'], true)).toEqual(['Alt+3'])
  expect(defaultKeybindingsHere(['Ctrl+Tab', 'Meta+Shift+]'], true)).toEqual(['Alt+]'])
  expect(defaultKeybindingsHere(['Primary+K', 'Primary+Shift+P'], true)).toEqual(['Primary+K'])
  // A chord a focused page can take is left as it is.
  expect(defaultKeybindingsHere(['Primary+Shift+M'], true)).toEqual(['Primary+Shift+M'])
})
