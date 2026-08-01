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
assert.ok(sprintSettings)
// A same-keybinding command in a mutually exclusive panel scope is a warning,
// not a blocking conflict — the two panels can never be active together.
const switchboardSettingsLike: KeybindingConflictCandidate = {
  commandId: 'custom.switchboard.settings',
  commandTitle: 'Switchboard: Settings',
  keybindings: ['Primary+,'],
  scopes: ['panel:switchboard'],
}
const panelConflict = findKeybindingConflicts(sprintSettings, [switchboardSettingsLike])
assert.equal(panelConflict.length, 1)
assert.equal(panelConflict[0].severity, 'warning')
assert.equal(panelConflict[0].conflictingCommandTitle, 'Switchboard: Settings')
assert.equal(hasBlockingKeybindingConflict(panelConflict), false)

// Any two panel:* scopes are one open exclusivity family, so the same keys in
// different panel scopes warn instead of blocking — including module-derived
// scopes the shell has never heard of.
const moduleScopeConflict = findKeybindingConflicts(
  {
    commandId: 'calendar.open.settings',
    commandTitle: 'Calendar: Settings',
    keybindings: ['Primary+,'],
    scopes: ['panel:calendar'],
  },
  [sprintSettings]
)
assert.equal(moduleScopeConflict.length, 1)
assert.equal(moduleScopeConflict[0].severity, 'warning')

// Overlapping panel scopes stay a blocking conflict — mutual exclusivity
// never demotes a same-scope collision.
const sharedPanelScopeConflict = findKeybindingConflicts(
  {
    commandId: 'calendar.open.settings',
    commandTitle: 'Calendar: Settings',
    keybindings: ['Primary+,'],
    scopes: ['panel:calendar'],
  },
  [{
    commandId: 'calendar.other.settings',
    commandTitle: 'Calendar: Other',
    keybindings: ['Primary+,'],
    scopes: ['panel:calendar'],
  }]
)
assert.equal(sharedPanelScopeConflict.length, 1)
assert.equal(sharedPanelScopeConflict[0].severity, 'blocking')

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
