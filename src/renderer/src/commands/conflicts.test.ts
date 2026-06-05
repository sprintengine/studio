import assert from 'node:assert/strict'
import { COMMAND_REGISTRY, getCommandDefinition } from './commandRegistry'
import { findKeybindingConflicts, hasBlockingKeybindingConflict } from './conflicts'
import type { KeybindingConflictCandidate } from './conflicts'

const globalCandidate: KeybindingConflictCandidate = {
  commandId: 'custom.global',
  commandTitle: 'Custom Global',
  keybindings: ['CmdOrCtrl+K'],
  scopes: ['global'],
}

const globalConflict = findKeybindingConflicts(globalCandidate, COMMAND_REGISTRY)
assert.equal(globalConflict.length, 1)
assert.equal(globalConflict[0].severity, 'blocking')
assert.equal(globalConflict[0].conflictingCommandId, 'commandPalette.open')
assert.equal(hasBlockingKeybindingConflict(globalConflict), true)

const sprintSettings = getCommandDefinition('sprintengine.open.settings')
const multiloopSettings = getCommandDefinition('multiloop.open.settings')
assert.ok(sprintSettings)
assert.ok(multiloopSettings)
const panelConflict = findKeybindingConflicts(sprintSettings, [multiloopSettings])
assert.equal(panelConflict.length, 1)
assert.equal(panelConflict[0].severity, 'warning')
assert.equal(panelConflict[0].conflictingCommandTitle, 'Multiloop: Settings')
assert.equal(hasBlockingKeybindingConflict(panelConflict), false)

const sameScopePanelConflict = findKeybindingConflicts(
  {
    commandId: 'custom.sprintengine',
    commandTitle: 'Custom Sprint Engine',
    keybindings: ['Primary+,'],
    scopes: ['panel:sprintengine'],
  },
  COMMAND_REGISTRY
)
assert.equal(sameScopePanelConflict.some((conflict) => (
  conflict.severity === 'blocking' && conflict.conflictingCommandId === 'sprintengine.open.settings'
)), true)

const globalPanelConflict = findKeybindingConflicts(getCommandDefinition('app.settings.open')!, COMMAND_REGISTRY)
assert.equal(globalPanelConflict.some((conflict) => (
  conflict.severity === 'blocking' && conflict.conflictingCommandId === 'sprintengine.open.settings'
)), true)
assert.equal(globalPanelConflict.some((conflict) => (
  conflict.severity === 'blocking' && conflict.conflictingCommandId === 'multiloop.open.settings'
)), true)

const workspaceGlobalConflict = findKeybindingConflicts(
  {
    commandId: 'custom.workspace',
    commandTitle: 'Custom Workspace',
    keybindings: ['Primary+K'],
    scopes: ['workspace'],
  },
  COMMAND_REGISTRY
)
assert.equal(workspaceGlobalConflict.some((conflict) => (
  conflict.severity === 'blocking' && conflict.conflictingCommandId === 'commandPalette.open'
)), true)

const unrelated = findKeybindingConflicts(
  {
    commandId: 'custom.terminal',
    commandTitle: 'Custom Terminal',
    keybindings: ['Primary+L'],
    scopes: ['terminal'],
  },
  COMMAND_REGISTRY
)
assert.equal(unrelated.length, 0)
