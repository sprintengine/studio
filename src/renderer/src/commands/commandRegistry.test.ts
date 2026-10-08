import assert from 'node:assert/strict'
import { COMMAND_REGISTRY, getCommandDefinition } from './commandRegistry'
import { keydownMatchesKeybindings } from './commandDispatcher'
import { findKeybindingConflicts, hasBlockingKeybindingConflict } from './conflicts'
import { normalizeKeybinding } from './keybindings'
import type { CommandScope, ShellCommandScope } from './types'
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

  // Layout tabs use the physical Control key even on macOS, where Primary is
  // Command and Command+Tab is reserved for switching applications. These
  // commands also have to cross the editable-target guard because agent tabs
  // are normally focused inside xterm, Monaco, or a composer.
  const nextLayoutTab = getCommandDefinition('layout.tab.next')
  const previousLayoutTab = getCommandDefinition('layout.tab.previous')
  assert.deepEqual(nextLayoutTab?.defaultKeybindings, ['ctrl+tab', 'shift+meta+]'])
  assert.deepEqual(previousLayoutTab?.defaultKeybindings, ['ctrl+shift+tab', 'shift+meta+['])
  assert.equal(nextLayoutTab?.allowInEditableTarget, true)
  assert.equal(previousLayoutTab?.allowInEditableTarget, true)
  assert.deepEqual(nextLayoutTab?.scopes, ['global'])
  assert.deepEqual(previousLayoutTab?.scopes, ['global'])
  assert.equal(nextLayoutTab?.availability, undefined)
  assert.equal(previousLayoutTab?.availability, undefined)
})

test('the chat turn chords share the terminal prompt chords without a blocking conflict', () => {
  const previous = getCommandDefinition('chat.turn.previous')
  const next = getCommandDefinition('chat.turn.next')
  assert.deepEqual(previous?.defaultKeybindings, ['primary+shift+arrowup'])
  assert.deepEqual(next?.defaultKeybindings, ['primary+shift+arrowdown'])
  // Outside editable targets only: in the composer the chord is the text
  // field's select-to-start/end.
  assert.equal(previous?.allowInEditableTarget, undefined)
  for (const command of [previous!, next!]) {
    assert.equal(hasBlockingKeybindingConflict(findKeybindingConflicts(command, COMMAND_REGISTRY)), false)
  }
})

test('the New chat chord and the waiting-chats chord ship free of conflicts on every platform', () => {
  const stay = getCommandDefinition('chat.new.launchInBackground')
  const waiting = getCommandDefinition('chat.nextWaiting')
  assert.deepEqual(stay?.defaultKeybindings, ['primary+enter'])
  assert.deepEqual(stay?.scopes, ['new-chat'], 'resolved by the composer, never by the window dispatcher')
  assert.deepEqual(waiting?.defaultKeybindings, ['primary+shift+j'])
  assert.deepEqual(waiting?.scopes, ['global'])
  assert.equal(waiting?.allowInEditableTarget, true, 'a person reaches for it from a composer')
  for (const command of [stay!, waiting!]) {
    assert.deepEqual(findKeybindingConflicts(command, COMMAND_REGISTRY), [], `${command.id} collides with nothing`)
  }
})

test('one keydown matches a binding exactly as the dispatcher would', () => {
  const enter = { key: 'Enter', code: 'Enter' }
  assert.equal(keydownMatchesKeybindings({ ...enter, metaKey: true }, ['Primary+Enter'], 'darwin'), true)
  assert.equal(keydownMatchesKeybindings({ ...enter, ctrlKey: true }, ['Primary+Enter'], 'windows'), true)
  assert.equal(keydownMatchesKeybindings({ ...enter, ctrlKey: true }, ['Primary+Enter'], 'darwin'), false)
  assert.equal(keydownMatchesKeybindings(enter, ['Primary+Enter'], 'darwin'), false, 'plain Enter is not it')
  assert.equal(
    keydownMatchesKeybindings({ ...enter, metaKey: true, shiftKey: true }, ['Primary+Enter'], 'darwin'),
    false,
    'an extra modifier is another chord',
  )
  assert.equal(keydownMatchesKeybindings({ ...enter, metaKey: true }, [], 'darwin'), false, 'disabled: nothing')
  assert.equal(keydownMatchesKeybindings({ ...enter, metaKey: true }, ['Primary+K Enter'], 'darwin'), false)
})

test("the shell's scopes are a closed list, and New chat's stays the shell's own", () => {
  const scopes: readonly ShellCommandScope[] = [
    'global',
    'new-chat',
    // @ts-expect-error a misspelt scope fails to compile rather than matching nothing
    'new-chats',
  ]
  // Every shell scope is a scope a dispatcher can be asked about; the open
  // `CommandScope` the module SDK mirrors does not name `new-chat`.
  const published: readonly CommandScope[] = scopes
  assert.equal(published.length, 3)
})

// Sentence case everywhere (design-system/foundations/principles.md): a
// command's title is copy, read in the palette and the Shortcuts list, and
// only a proper noun (or a surface's own name) and the word after a "Group:"
// prefix are capitalised.
const PROPER_NOUNS = new Set(['Git', 'New'])
test('command titles are in sentence case', () => {
  for (const command of COMMAND_REGISTRY) {
    for (const clause of command.title.split(': ')) {
      const words = clause.split(' ').slice(1)
      const capitalised = words.filter((word) => /^\(?[A-Z][a-z]/.test(word) && !PROPER_NOUNS.has(word))
      assert.deepEqual(capitalised, [], `"${command.title}" is not in sentence case`)
    }
  }
})
