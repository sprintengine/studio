import assert from 'node:assert/strict'
import {
  getEffectiveKeybindingLabel,
  getEffectiveKeybindings,
  getElectronAccelerator,
  getSpecialistCommandId,
  platformKeybindingsFromApiPlatform,
} from './effectiveKeybindings'

assert.deepEqual(
  getEffectiveKeybindings('panel.git.toggle', {
    overrides: { 'panel.git.toggle': ['primary+shift+h'] },
    disabled: {},
  }),
  ['primary+shift+h'],
)
assert.equal(
  getEffectiveKeybindingLabel('panel.git.toggle', {
    overrides: { 'panel.git.toggle': ['primary+shift+h'] },
    disabled: {},
  }, 'darwin'),
  'Cmd+Shift+H',
)
assert.equal(
  getElectronAccelerator('panel.git.toggle', {
    overrides: { 'panel.git.toggle': ['primary+shift+h'] },
    disabled: {},
  }),
  'CmdOrCtrl+Shift+H',
)
assert.deepEqual(
  getEffectiveKeybindings('panel.git.toggle', {
    overrides: { 'panel.git.toggle': ['primary+shift+h'] },
    disabled: { 'panel.git.toggle': true },
  }),
  [],
)
assert.equal(getElectronAccelerator('panel.git.toggle', { disabled: { 'panel.git.toggle': true } }), null)
assert.equal(getElectronAccelerator('sprintengine.goto.inbox', { overrides: {}, disabled: {} }), null)
assert.equal(getSpecialistCommandId('frontend-design-review'), 'specialist.spawn.frontend-design-review')
// MC-1542: the nuclear-review specialist was retired, so it no longer maps to a command.
assert.equal(getSpecialistCommandId('nuclear-review'), null)
assert.equal(getSpecialistCommandId('qa-test'), null)
assert.equal(platformKeybindingsFromApiPlatform('darwin'), 'darwin')
assert.equal(platformKeybindingsFromApiPlatform('win32'), 'windows')
assert.equal(platformKeybindingsFromApiPlatform('linux'), 'linux')
