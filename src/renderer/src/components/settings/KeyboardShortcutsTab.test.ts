import assert from 'node:assert/strict'
import { COMMAND_REGISTRY, RendererCommandDispatcher } from '../../commands'
import type { KeybindingSettings } from '../../types/workspace'
import {
  buildShortcutRows,
  categoryLabel,
  computeConflicts,
  conflictMessage,
  conflictTone,
  eventToChordString,
  groupRows,
  rowMatchesQuery,
  type RecorderKeyEvent,
} from './KeyboardShortcutsTab'

const EMPTY: KeybindingSettings = { overrides: {}, disabled: {} }

function rowFor(id: string, keybindings: KeybindingSettings = EMPTY) {
  const row = buildShortcutRows(COMMAND_REGISTRY, keybindings).find((r) => r.id === id)
  assert.ok(row, `expected a row for ${id}`)
  return row
}

// --- Defaults preserve registry behavior -----------------------------------
const paletteDefault = rowFor('commandPalette.open')
assert.deepEqual(paletteDefault.defaults, ['primary+k', 'primary+shift+p'])
assert.deepEqual(paletteDefault.effective, ['primary+k', 'primary+shift+p'])
assert.equal(paletteDefault.overrides, null)
assert.equal(paletteDefault.disabled, false)
assert.equal(paletteDefault.customized, false)

// --- Override (add/change a binding) ---------------------------------------
const paletteOverride = rowFor('commandPalette.open', {
  overrides: { 'commandPalette.open': ['Primary+J', 'Primary+J'] },
  disabled: {},
})
assert.deepEqual(paletteOverride.overrides, ['primary+j'], 'override is normalized and de-duplicated')
assert.deepEqual(paletteOverride.effective, ['primary+j'], 'effective follows the override')
assert.deepEqual(paletteOverride.defaults, ['primary+k', 'primary+shift+p'], 'defaults are still surfaced')
assert.equal(paletteOverride.customized, true)

// --- Disable / reset --------------------------------------------------------
const paletteDisabled = rowFor('commandPalette.open', {
  overrides: {},
  disabled: { 'commandPalette.open': true },
})
assert.deepEqual(paletteDisabled.effective, [], 'disabled command has no effective binding')
assert.equal(paletteDisabled.disabled, true)
assert.equal(paletteDisabled.customized, true)
// Reset == empty deltas == back to defaults, not customized.
assert.equal(rowFor('commandPalette.open', EMPTY).customized, false)

// --- Search by title, category, and effective key --------------------------
assert.equal(rowMatchesQuery(paletteDefault, 'palette', 'darwin'), true, 'matches command title')
assert.equal(rowMatchesQuery(paletteDefault, 'command palette', 'darwin'), true, 'matches category label')
assert.equal(rowMatchesQuery(paletteDefault, 'cmd', 'darwin'), true, 'matches rendered key (Cmd on darwin)')
assert.equal(rowMatchesQuery(paletteDefault, 'ctrl', 'windows'), true, 'matches rendered key (Ctrl on windows)')
assert.equal(rowMatchesQuery(paletteDefault, 'primary+k', 'darwin'), true, 'matches canonical key')
assert.equal(rowMatchesQuery(paletteDefault, 'nope-zzz', 'darwin'), false, 'rejects non-matches')
assert.equal(rowMatchesQuery(paletteDefault, '   ', 'darwin'), true, 'blank query matches everything')

// --- Conflict text names the conflicting command ---------------------------
// Bind the global Open Settings command onto the palette's global Primary+K.
const conflicted = buildShortcutRows(COMMAND_REGISTRY, {
  overrides: { 'app.settings.open': ['Primary+K'] },
  disabled: {},
})
const conflicts = computeConflicts(conflicted)
const settingsConflicts = conflicts.get('app.settings.open') ?? []
assert.ok(settingsConflicts.length > 0, 'global vs global same-key is a conflict')
assert.equal(conflictTone(settingsConflicts), 'error', 'same-scope conflict is blocking/error')
const message = conflictMessage(settingsConflicts)
assert.ok(message && message.startsWith('Conflicts with '), 'message leads with Conflicts with')
assert.ok(message.includes('Open Command Palette'), 'message names the conflicting command title')
// Disabling one side clears the conflict (no effective binding contributed).
const afterDisable = computeConflicts(
  buildShortcutRows(COMMAND_REGISTRY, {
    overrides: { 'app.settings.open': ['Primary+K'] },
    disabled: { 'app.settings.open': true },
  }),
)
assert.equal(afterDisable.has('app.settings.open'), false, 'disabling removes the command from conflicts')
// No conflicts -> no message/tone.
assert.equal(conflictMessage([]), null)
assert.equal(conflictTone([]), null)

// --- Recorder key parsing (save vs cancel) ---------------------------------
function press(partial: Partial<RecorderKeyEvent> & { key: string }): RecorderKeyEvent {
  return { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...partial }
}
// Save: platform primary accelerator maps to the abstract Primary modifier.
assert.equal(eventToChordString(press({ key: 'k', metaKey: true }), 'darwin'), 'primary+k')
assert.equal(eventToChordString(press({ key: 'k', ctrlKey: true }), 'windows'), 'primary+k')
assert.equal(eventToChordString(press({ key: 'k', ctrlKey: true }), 'darwin'), 'ctrl+k', 'literal Control stays Ctrl on darwin')
assert.equal(eventToChordString(press({ key: 'K', metaKey: true, shiftKey: true }), 'darwin'), 'primary+shift+k')
assert.equal(eventToChordString(press({ key: ' ', ctrlKey: true }), 'darwin'), 'ctrl+space', 'space key is captured, not treated as +')
assert.equal(eventToChordString(press({ key: '+', ctrlKey: true }), 'darwin'), 'ctrl++', 'literal plus is captured')
assert.equal(eventToChordString(press({ key: ' ', ctrlKey: true }), 'linux'), 'primary+space', 'ctrl maps to Primary off darwin')
// Cancel/wait: lone modifiers produce no chord.
assert.equal(eventToChordString(press({ key: 'Shift', shiftKey: true }), 'darwin'), null)
assert.equal(eventToChordString(press({ key: 'Meta', metaKey: true }), 'darwin'), null)
assert.equal(eventToChordString(press({ key: 'Dead' }), 'linux'), null)

// --- Recorder/dispatcher key identity (shifted punctuation) -----------------
// The recorder must record by physical key (event.code), not the shifted char,
// or the saved override never matches at dispatch. Ctrl+Shift+/ produces key
// '?' but code 'Slash'; it must record as primary+shift+/ and resolve through
// the real RendererCommandDispatcher.
const shiftedRecorded = eventToChordString(
  press({ key: '?', code: 'Slash', ctrlKey: true, shiftKey: true }),
  'linux',
)
assert.equal(shiftedRecorded, 'primary+shift+/', 'shifted punctuation records by physical key')
const dispatcher = new RendererCommandDispatcher()
const dispatched = dispatcher.resolve(
  { key: '?', code: 'Slash', ctrlKey: true, shiftKey: true },
  {
    activeScopes: ['global'],
    keybindingOverrides: { 'commandPalette.open': [shiftedRecorded!] },
    platform: 'linux',
  },
)
assert.equal(dispatched.kind, 'matched', 'recorded shifted-punctuation override resolves at dispatch')
assert.equal(
  dispatched.kind === 'matched' ? dispatched.commandId : null,
  'commandPalette.open',
  'override routes to the bound command',
)

// --- Grouping by category ---------------------------------------------------
const groups = groupRows(buildShortcutRows(COMMAND_REGISTRY, EMPTY))
assert.equal(groups[0].category, COMMAND_REGISTRY[0].category, 'first group follows registry order')
assert.equal(categoryLabel('command_palette'), 'Command palette')
const total = groups.reduce((sum, group) => sum + group.rows.length, 0)
assert.equal(total, COMMAND_REGISTRY.length, 'every command appears in exactly one group')

// --- Module commands in the editor ------------------------------------------
// Rows come from the merge point (shell registry + enabled module commands),
// so a module command is editable exactly like a built-in: same row shape,
// same override/disable deltas keyed by its namespaced id, same conflict
// handling. Disabling the module removes the row; the persisted override stays
// in settings and re-attaches on re-enable.
const moduleHello = {
  id: 'demo-module.hello',
  title: 'Say Hello',
  category: 'Demo Module',
  scopes: ['global'] as const,
  defaultKeybindings: ['Primary+Alt+H'] as const,
}
const mergedCommands = [...COMMAND_REGISTRY, moduleHello]

const moduleRow = buildShortcutRows(mergedCommands, EMPTY).find((row) => row.id === 'demo-module.hello')
assert.ok(moduleRow, 'module command appears as an editable shortcut row')
assert.equal(moduleRow.category, 'Demo Module')
assert.deepEqual(moduleRow.effective, ['primary+alt+h'], 'module defaults flow into the effective binding')
assert.equal(categoryLabel('Demo Module'), 'Demo Module', 'module categories label as themselves')

const customizedModuleSettings: KeybindingSettings = {
  overrides: { 'demo-module.hello': ['Primary+Alt+J'] },
  disabled: {},
}
const customizedModuleRow = buildShortcutRows(mergedCommands, customizedModuleSettings)
  .find((row) => row.id === 'demo-module.hello')
assert.deepEqual(customizedModuleRow?.effective, ['primary+alt+j'], 'module command overrides apply like built-ins')
assert.equal(customizedModuleRow?.customized, true)

// Module disabled: the merge point omits the contribution, so the row is gone
// while the stored override is untouched; rebuilding with the module back
// restores the row with the customization intact.
const disabledModuleRows = buildShortcutRows(COMMAND_REGISTRY, customizedModuleSettings)
assert.equal(
  disabledModuleRows.some((row) => row.id === 'demo-module.hello'),
  false,
  'disabling the module removes its row from shortcut editing',
)
const restoredModuleRow = buildShortcutRows(mergedCommands, customizedModuleSettings)
  .find((row) => row.id === 'demo-module.hello')
assert.deepEqual(
  restoredModuleRow?.effective,
  ['primary+alt+j'],
  're-enabling restores the row with the user-customized binding',
)

// A module command bound onto a built-in's keys surfaces through the same
// conflict pipeline as built-in duplicates — no silent shadowing.
const shadowConflicts = computeConflicts(buildShortcutRows(
  [...COMMAND_REGISTRY, { ...moduleHello, defaultKeybindings: ['Primary+K'] as const }],
  EMPTY,
))
const moduleShadowConflicts = shadowConflicts.get('demo-module.hello') ?? []
assert.ok(
  moduleShadowConflicts.some(
    (conflict) => conflict.severity === 'blocking' && conflict.conflictingCommandId === 'commandPalette.open',
  ),
  'module binding on built-in keys is a blocking conflict naming the built-in',
)
assert.ok(
  (shadowConflicts.get('commandPalette.open') ?? []).some(
    (conflict) => conflict.conflictingCommandId === 'demo-module.hello',
  ),
  'the built-in row names the module command as the conflicting side',
)

console.log('KeyboardShortcutsTab.test.ts: ok')
