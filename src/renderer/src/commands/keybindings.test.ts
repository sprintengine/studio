import assert from 'node:assert/strict'
import {
  collapseDuplicateKeybindings,
  keybindingToKbdKeys,
  normalizeKeybinding,
  parseKeybinding,
  renderKeybinding,
} from './keybindings'

assert.equal(normalizeKeybinding('CmdOrCtrl + Shift + P'), 'primary+shift+p')
assert.equal(normalizeKeybinding('Command + Option + ArrowLeft'), 'alt+meta+arrowleft')
assert.equal(normalizeKeybinding('Ctrl + ,'), 'ctrl+,')
assert.equal(normalizeKeybinding('Primary++'), 'primary++')
assert.equal(normalizeKeybinding('Ctrl + +'), 'ctrl++')
assert.equal(normalizeKeybinding('Primary+plus'), 'primary++')
assert.equal(normalizeKeybinding("Control + Shift + '"), "ctrl+shift+'")
assert.equal(normalizeKeybinding('F12'), 'f12')
assert.equal(normalizeKeybinding('Space'), 'space')
assert.equal(normalizeKeybinding('G then I'), 'g i')
assert.equal(normalizeKeybinding('Ctrl+K, Ctrl+S'), 'ctrl+k ctrl+s')

assert.deepEqual(
  collapseDuplicateKeybindings(['CmdOrCtrl+K', 'Primary + K', 'Ctrl+K', 'Ctrl + K']),
  ['primary+k', 'ctrl+k']
)

assert.equal(parseKeybinding('Ctrl+K then Ctrl+S then Ctrl+P').ok, false)
assert.equal(parseKeybinding('Ctrl+K+S').ok, false)
assert.equal(parseKeybinding('Ctrl+Shift').ok, false)
assert.equal(parseKeybinding('Hyper+K').ok, false)

assert.equal(renderKeybinding('Primary+K', 'darwin'), 'Cmd+K')
assert.equal(renderKeybinding('Primary+K', 'windows'), 'Ctrl+K')
assert.equal(renderKeybinding('Alt+ArrowLeft', 'darwin'), 'Option+Left')
assert.equal(renderKeybinding('Primary++', 'windows'), 'Ctrl++')
assert.equal(renderKeybinding('g i', 'linux'), 'G then I')
assert.deepEqual(keybindingToKbdKeys('Primary+Shift+P then Enter', 'darwin'), [['Cmd', 'Shift', 'P'], ['Enter']])
assert.deepEqual(keybindingToKbdKeys('Primary++', 'windows'), [['Ctrl', '+']])
