import assert from 'node:assert/strict'
import { COMMAND_REGISTRY, getCommandDefinition } from './commandRegistry'
import { normalizeKeybinding } from './keybindings'
import { test } from 'vitest'

test('commandRegistry', async () => {
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
    'search.everywhere',
    'panel.files.toggle',
    'panel.knowledge-graph.toggle',
    'panel.canvas.toggle',
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
  const DISPATCHABLE_HANDLER_KINDS = new Set(['workspace-manager', 'context-bound', 'app-menu', 'panel-event'])
  for (const command of COMMAND_REGISTRY) {
    assert.equal(
      DISPATCHABLE_HANDLER_KINDS.has(command.handlerPath.kind),
      true,
      `user-bindable command ${command.id} lacks a concrete dispatch adapter (handlerPath.kind=${command.handlerPath.kind})`,
    )
  }

  assert.equal(getCommandDefinition('quickOpen.open'), undefined)
  assert.equal(getCommandDefinition('git.discardAll'), undefined)
  assert.equal(
    getCommandDefinition('editor.save'),
    undefined,
    'editor save remains Monaco-owned and is not registry-backed in T3',
  )

  // Search Everywhere is a command of its own rather than a third binding on the
  // palette (skills-everywhere, 2026-09-10). Disable and rebind are PER COMMAND,
  // so while `Shift Shift` rode `commandPalette.open`, turning the gesture off
  // turned ⌘K off with it. The two raise the same overlay; only their identity
  // differs, and that identity is the whole point.
  const palette = getCommandDefinition('commandPalette.open')
  const everywhere = getCommandDefinition('search.everywhere')
  assert.deepEqual(palette?.defaultKeybindings, ['primary+k', 'primary+shift+p'])
  assert.deepEqual(everywhere?.defaultKeybindings, ['shift shift'])
  assert.equal(
    (palette?.defaultKeybindings ?? []).includes('shift shift'),
    false,
    'the double-tap gesture must not also ride the palette command, or disabling one disables both',
  )
  assert.equal(everywhere?.scopes.includes('global'), true, 'the gesture is global, like the palette')
  assert.deepEqual(
    everywhere?.handlerPath,
    palette?.handlerPath,
    'both commands raise the same overlay — they differ only in what a user can rebind',
  )
})
