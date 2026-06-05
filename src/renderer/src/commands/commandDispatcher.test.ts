import assert from 'node:assert/strict'
import { RendererCommandDispatcher, type CommandDispatcherKeyEvent } from './commandDispatcher'
import type { KeybindingSettings } from '../types/workspace'

function key(event: Partial<CommandDispatcherKeyEvent>): CommandDispatcherKeyEvent {
  return {
    key: event.key ?? '',
    code: event.code,
    ctrlKey: event.ctrlKey ?? false,
    metaKey: event.metaKey ?? false,
    altKey: event.altKey ?? false,
    shiftKey: event.shiftKey ?? false,
    target: event.target,
    defaultPrevented: event.defaultPrevented ?? false,
  }
}

const settings: KeybindingSettings = {
  overrides: {},
  disabled: {},
}

const dispatcher = new RendererCommandDispatcher(500)

let result = dispatcher.resolve(
  key({ key: 'k', code: 'KeyK', ctrlKey: true }),
  { activeScopes: ['global'], platform: 'linux', keybindingOverrides: settings.overrides, disabledCommandIds: new Set(), now: 0 },
)
assert.equal(result.kind, 'matched')
assert.equal(result.kind === 'matched' ? result.commandId : null, 'commandPalette.open')

result = dispatcher.resolve(
  key({ key: 'p', code: 'KeyP', ctrlKey: true, shiftKey: true }),
  { activeScopes: ['global'], platform: 'linux', now: 10 },
)
assert.equal(result.kind, 'matched')
assert.equal(result.kind === 'matched' ? result.commandId : null, 'commandPalette.open')

result = dispatcher.resolve(
  key({ key: 'p', code: 'KeyP', ctrlKey: true }),
  { activeScopes: ['global'], platform: 'linux', now: 20 },
)
assert.equal(result.kind, 'unmatched')

result = dispatcher.resolve(
  key({ key: 'ArrowRight', code: 'ArrowRight', metaKey: true, altKey: true }),
  { activeScopes: ['global', 'workspace', 'workspace-navigation'], platform: 'darwin', now: 25 },
)
assert.equal(result.kind, 'matched')
assert.equal(result.kind === 'matched' ? result.commandId : null, 'workspace.switch.next')

result = dispatcher.resolve(
  key({ key: ',', code: 'Comma', ctrlKey: true }),
  { activeScopes: ['global', 'workspace', 'panel:sprintengine'], platform: 'linux', now: 30 },
)
assert.equal(result.kind, 'matched')
assert.equal(result.kind === 'matched' ? result.commandId : null, 'sprintengine.open.settings')

result = dispatcher.resolve(
  key({ key: ',', code: 'Comma', ctrlKey: true }),
  { activeScopes: ['global', 'workspace'], platform: 'linux', now: 40 },
)
assert.equal(result.kind, 'matched')
assert.equal(result.kind === 'matched' ? result.commandId : null, 'app.settings.open')

result = dispatcher.resolve(
  key({ key: 'k', code: 'KeyK', ctrlKey: true }),
  {
    activeScopes: ['global'],
    platform: 'linux',
    disabledCommandIds: new Set(['commandPalette.open']),
    now: 50,
  },
)
assert.equal(result.kind, 'unmatched')

result = dispatcher.resolve(
  key({ key: 'l', code: 'KeyL', ctrlKey: true }),
  {
    activeScopes: ['global'],
    platform: 'linux',
    keybindingOverrides: { 'commandPalette.open': ['Primary+L'] },
    now: 60,
  },
)
assert.equal(result.kind, 'matched')
assert.equal(result.kind === 'matched' ? result.commandId : null, 'commandPalette.open')

const suppressed = () => true
result = dispatcher.resolve(
  key({ key: 'k', code: 'KeyK', ctrlKey: true }),
  { activeScopes: ['global'], platform: 'linux', isSuppressedTarget: suppressed, now: 70 },
)
assert.equal(result.kind, 'unmatched')

result = dispatcher.resolve(
  key({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }),
  { activeScopes: ['global'], platform: 'linux', isSuppressedTarget: suppressed, now: 80 },
)
assert.equal(result.kind, 'matched')
assert.equal(result.kind === 'matched' ? result.commandId : null, 'voice.toggle')

const chordDispatcher = new RendererCommandDispatcher(500)
result = chordDispatcher.resolve(
  key({ key: 'g', code: 'KeyG' }),
  { activeScopes: ['global', 'workspace', 'panel:sprintengine'], platform: 'linux', now: 100 },
)
assert.equal(result.kind, 'pending')
result = chordDispatcher.resolve(
  key({ key: 'i', code: 'KeyI' }),
  { activeScopes: ['global', 'workspace', 'panel:sprintengine'], platform: 'linux', now: 300 },
)
assert.equal(result.kind, 'matched')
assert.equal(result.kind === 'matched' ? result.commandId : null, 'sprintengine.goto.inbox')

const timedOutDispatcher = new RendererCommandDispatcher(100)
result = timedOutDispatcher.resolve(
  key({ key: 'g', code: 'KeyG' }),
  { activeScopes: ['global', 'workspace', 'panel:sprintengine'], platform: 'linux', now: 1000 },
)
assert.equal(result.kind, 'pending')
result = timedOutDispatcher.resolve(
  key({ key: 'i', code: 'KeyI' }),
  { activeScopes: ['global', 'workspace', 'panel:sprintengine'], platform: 'linux', now: 1201 },
)
assert.equal(result.kind, 'unmatched')

result = chordDispatcher.resolve(
  key({ key: 'g', code: 'KeyG' }),
  { activeScopes: ['global', 'workspace'], platform: 'linux', now: 1300 },
)
assert.equal(result.kind, 'unmatched')
