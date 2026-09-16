import assert from 'node:assert/strict'
import { COMMAND_REGISTRY, getCommandDefinition } from './commandRegistry'
import { findKeybindingConflicts, hasBlockingKeybindingConflict } from './conflicts'
import type { KeybindingConflictCandidate } from './conflicts'
import { createRendererHost } from '../modules/renderer-host'
import { registerSprintEngineCommands } from '../modules/sprint-engine-commands'

const sprintKernel = createRendererHost()
registerSprintEngineCommands(sprintKernel.hostFor('sprint-engine'))
const sprintSettingsCommand = sprintKernel.getModuleCommand('sprint-engine.open.settings')
assert.ok(sprintSettingsCommand)
const sprintSettings: KeybindingConflictCandidate = {
  commandId: sprintSettingsCommand.id,
  commandTitle: sprintSettingsCommand.title,
  keybindings: sprintSettingsCommand.defaultKeybindings ?? [],
  scopes: sprintSettingsCommand.scopes,
}
const registryWithSprint = [...COMMAND_REGISTRY, sprintSettings]

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

// A same-keybinding command in a mutually exclusive panel scope is a warning,
// not a blocking conflict — the two panels can never be active together.
const notebookSettingsLike: KeybindingConflictCandidate = {
  commandId: 'custom.notebook.settings',
  commandTitle: 'Notebook: Settings',
  keybindings: ['Primary+,'],
  scopes: ['panel:notebook'],
}
const panelConflict = findKeybindingConflicts(sprintSettings, [notebookSettingsLike])
assert.equal(panelConflict.length, 1)
assert.equal(panelConflict[0].severity, 'warning')
assert.equal(panelConflict[0].conflictingCommandTitle, 'Notebook: Settings')
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
    scopes: ['panel:sprint-engine'],
  },
  registryWithSprint
)
assert.equal(sameScopePanelConflict.some((conflict) => (
  conflict.severity === 'blocking' && conflict.conflictingCommandId === 'sprint-engine.open.settings'
)), true)

const globalPanelConflict = findKeybindingConflicts(getCommandDefinition('app.settings.open')!, registryWithSprint)
assert.equal(globalPanelConflict.some((conflict) => (
  conflict.severity === 'blocking' && conflict.conflictingCommandId === 'sprint-engine.open.settings'
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

// The double-tap gesture normalizes to `shift shift`, a two-stroke chord, so it
// collides with nothing an ordinary Shift+key binding claims — the Shortcuts
// tab must not flag Double Shift against every Shift shortcut in the app.
const shiftTapVsShiftKey = findKeybindingConflicts(
  {
    commandId: 'custom.shift',
    commandTitle: 'Custom Shift Binding',
    keybindings: ['Shift+X'],
    scopes: ['global'],
  },
  [
    ...COMMAND_REGISTRY,
    { commandId: 'custom.tap', commandTitle: 'Tap', keybindings: ['Shift Shift'], scopes: ['global'] as const },
  ],
)
assert.equal(shiftTapVsShiftKey.length, 0)

// It does collide with itself, so a user rebinding another command to Double
// Shift is still told.
const shiftTapVsPalette = findKeybindingConflicts(
  {
    commandId: 'custom.myGesture',
    commandTitle: 'My Gesture',
    keybindings: ['Shift Shift'],
    scopes: ['global'],
  },
  COMMAND_REGISTRY,
)
assert.equal(shiftTapVsPalette.some((conflict) => (
  conflict.severity === 'blocking' && conflict.conflictingCommandId === 'search.everywhere'
)), true)

