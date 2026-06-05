import assert from 'node:assert/strict'
import { COMMAND_REGISTRY, getCommandDefinition } from './commandRegistry'
import { normalizeKeybinding } from './keybindings'

const ids = new Set<string>()
for (const command of COMMAND_REGISTRY) {
  assert.equal(ids.has(command.id), false, `duplicate command id: ${command.id}`)
  ids.add(command.id)
  assert.equal(command.title.length > 0, true, `missing title: ${command.id}`)
  assert.equal(command.scopes.length > 0, true, `missing scope: ${command.id}`)
  for (const keybinding of command.defaultKeybindings ?? []) {
    assert.notEqual(normalizeKeybinding(keybinding), null, `invalid keybinding ${keybinding} on ${command.id}`)
  }
}

for (const id of [
  'app.settings.open',
  'commandPalette.open',
  'panel.files.toggle',
  'specialist.spawn.architect',
  'voice.toggle',
  'sprintengine.refresh.board',
  'multiloop.open.settings',
  'watchtower.run.review',
  'switchboard.open.runner',
  'git.worktrees.open',
  'terminal.new',
]) {
  assert.ok(getCommandDefinition(id), `missing expected real command ${id}`)
}

assert.equal(getCommandDefinition('quickOpen.open'), undefined)
assert.equal(getCommandDefinition('git.discardAll'), undefined)
assert.equal(getCommandDefinition('editor.save'), undefined, 'editor save remains Monaco-owned and is not registry-backed in T3')
