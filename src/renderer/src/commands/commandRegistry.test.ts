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
  'specialist.spawn.nuclear-review',
  'voice.toggle',
  'sprintengine.refresh.board',
  'multiloop.open.settings',
  'watchtower.run.review',
  'switchboard.open.runner',
  'git.worktrees.open',
  'git.refresh',
  'git.fetch',
  'git.commit',
  'terminal.new',
  'terminal.focus',
  'terminal.stop',
]) {
  assert.ok(getCommandDefinition(id), `missing expected real command ${id}`)
}

// Every registry command is user-bindable through the Shortcuts settings tab
// (KeyboardShortcutsTab.buildShortcutRows maps the whole registry), so each one
// must declare a concrete dispatch adapter that the keyboard path
// (RendererCommandDispatcher -> WorkspaceManager.runCommand or the panel-command
// bridge) can actually route. The 'command-palette' kind is palette-only and has
// no keybinding route, so a bound shortcut would silently no-op — the
// git.worktrees.open defect from T8 review finding A10. This guard fails if any
// future command is added as palette-only while remaining user-bindable.
const DISPATCHABLE_HANDLER_KINDS = new Set([
  'workspace-manager',
  'context-bound',
  'app-menu',
  'panel-event',
])
for (const command of COMMAND_REGISTRY) {
  assert.equal(
    DISPATCHABLE_HANDLER_KINDS.has(command.handlerPath.kind),
    true,
    `user-bindable command ${command.id} lacks a concrete dispatch adapter (handlerPath.kind=${command.handlerPath.kind})`,
  )
}

assert.equal(getCommandDefinition('quickOpen.open'), undefined)
assert.equal(getCommandDefinition('git.discardAll'), undefined)
assert.equal(getCommandDefinition('editor.save'), undefined, 'editor save remains Monaco-owned and is not registry-backed in T3')
