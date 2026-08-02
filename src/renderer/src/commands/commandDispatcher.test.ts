import assert from 'node:assert/strict'
import { RendererCommandDispatcher, type CommandDispatcherKeyEvent } from './commandDispatcher'
import { COMMAND_REGISTRY } from './commandRegistry'
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
  {
    activeScopes: ['global', 'workspace', 'workspace-navigation'],
    platform: 'darwin',
    availability: { activeWorkspace: true },
    now: 25,
  },
)
assert.equal(result.kind, 'matched')
assert.equal(result.kind === 'matched' ? result.commandId : null, 'workspace.switch.next')

result = dispatcher.resolve(
  key({ key: ',', code: 'Comma', ctrlKey: true }),
  {
    activeScopes: ['global', 'workspace', 'panel:sprintengine'],
    platform: 'linux',
    availability: { activeWorkspace: true, sprintengineWorkspace: true },
    now: 30,
  },
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

// The voice toggle is a module contribution now (MC-1861): it matches only
// when the enabled-module contribution list carries it, and its
// allowInEditableTarget flag keeps it firing in suppressed (editable) targets.
const voiceModuleContribution = {
  id: 'voice-dictation.toggle',
  title: 'Toggle Voice Transcription',
  category: 'voice',
  scopes: ['global'] as const,
  defaultKeybindings: ['Primary+Shift+1'],
  allowInEditableTarget: true,
}
result = dispatcher.resolve(
  key({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }),
  {
    activeScopes: ['global'],
    platform: 'linux',
    commands: [...COMMAND_REGISTRY, voiceModuleContribution],
    isSuppressedTarget: suppressed,
    now: 80,
  },
)
assert.equal(result.kind, 'matched')
assert.equal(result.kind === 'matched' ? result.commandId : null, 'voice-dictation.toggle')

// The binding stays unmatched when the module is disabled (its contribution
// is filtered out of the command universe), so the keystroke falls through
// instead of firing a silent no-op.
result = dispatcher.resolve(
  key({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }),
  { activeScopes: ['global'], platform: 'linux', isSuppressedTarget: suppressed, now: 85 },
)
assert.equal(result.kind, 'unmatched')

const sprintEngineChord = { activeWorkspace: true, sprintengineWorkspace: true }
const chordDispatcher = new RendererCommandDispatcher(500)
result = chordDispatcher.resolve(
  key({ key: 'g', code: 'KeyG' }),
  { activeScopes: ['global', 'workspace', 'panel:sprintengine'], platform: 'linux', availability: sprintEngineChord, now: 100 },
)
assert.equal(result.kind, 'pending')
result = chordDispatcher.resolve(
  key({ key: 'i', code: 'KeyI' }),
  { activeScopes: ['global', 'workspace', 'panel:sprintengine'], platform: 'linux', availability: sprintEngineChord, now: 300 },
)
assert.equal(result.kind, 'matched')
assert.equal(result.kind === 'matched' ? result.commandId : null, 'sprintengine.goto.inbox')

// G then R now resolves to the roster navigation chord in the Sprint Engine panel.
result = chordDispatcher.resolve(
  key({ key: 'g', code: 'KeyG' }),
  { activeScopes: ['global', 'workspace', 'panel:sprintengine'], platform: 'linux', availability: sprintEngineChord, now: 320 },
)
assert.equal(result.kind, 'pending')
result = chordDispatcher.resolve(
  key({ key: 'r', code: 'KeyR' }),
  { activeScopes: ['global', 'workspace', 'panel:sprintengine'], platform: 'linux', availability: sprintEngineChord, now: 360 },
)
assert.equal(result.kind, 'matched')
assert.equal(result.kind === 'matched' ? result.commandId : null, 'sprintengine.goto.roster')

const timedOutDispatcher = new RendererCommandDispatcher(100)
result = timedOutDispatcher.resolve(
  key({ key: 'g', code: 'KeyG' }),
  { activeScopes: ['global', 'workspace', 'panel:sprintengine'], platform: 'linux', availability: sprintEngineChord, now: 1000 },
)
assert.equal(result.kind, 'pending')
result = timedOutDispatcher.resolve(
  key({ key: 'i', code: 'KeyI' }),
  { activeScopes: ['global', 'workspace', 'panel:sprintengine'], platform: 'linux', availability: sprintEngineChord, now: 1201 },
)
assert.equal(result.kind, 'unmatched')

// The Sprint Engine chord stays inert outside the panel scope even with the
// availability flags set.
result = chordDispatcher.resolve(
  key({ key: 'g', code: 'KeyG' }),
  { activeScopes: ['global', 'workspace'], platform: 'linux', availability: sprintEngineChord, now: 1300 },
)
assert.equal(result.kind, 'unmatched')

// Chord revalidation against the live context. A chord started in the Sprint
// Engine panel must NOT complete after the active scopes change within the
// timeout — the second stroke re-derives candidates from the current context
// rather than reusing the set captured on the first stroke.
const scopeLostMidChord = new RendererCommandDispatcher(500)
result = scopeLostMidChord.resolve(
  key({ key: 'g', code: 'KeyG' }),
  { activeScopes: ['global', 'workspace', 'panel:sprintengine'], platform: 'linux', availability: sprintEngineChord, now: 2000 },
)
assert.equal(result.kind, 'pending')
result = scopeLostMidChord.resolve(
  key({ key: 'r', code: 'KeyR' }),
  { activeScopes: ['global', 'workspace'], platform: 'linux', availability: { activeWorkspace: true }, now: 2100 },
)
assert.equal(result.kind, 'unmatched')

// Same protection when the command is disabled between strokes.
const disabledMidChord = new RendererCommandDispatcher(500)
result = disabledMidChord.resolve(
  key({ key: 'g', code: 'KeyG' }),
  { activeScopes: ['global', 'workspace', 'panel:sprintengine'], platform: 'linux', availability: sprintEngineChord, now: 2200 },
)
assert.equal(result.kind, 'pending')
result = disabledMidChord.resolve(
  key({ key: 'r', code: 'KeyR' }),
  {
    activeScopes: ['global', 'workspace', 'panel:sprintengine'],
    platform: 'linux',
    availability: sprintEngineChord,
    disabledCommandIds: new Set(['sprintengine.goto.roster']),
    now: 2300,
  },
)
assert.equal(result.kind, 'unmatched')

// And when availability is lost mid-chord while the scope is still active.
const availabilityLostMidChord = new RendererCommandDispatcher(500)
result = availabilityLostMidChord.resolve(
  key({ key: 'g', code: 'KeyG' }),
  { activeScopes: ['global', 'workspace', 'panel:sprintengine'], platform: 'linux', availability: sprintEngineChord, now: 2400 },
)
assert.equal(result.kind, 'pending')
result = availabilityLostMidChord.resolve(
  key({ key: 'r', code: 'KeyR' }),
  { activeScopes: ['global', 'workspace', 'panel:sprintengine'], platform: 'linux', availability: {}, now: 2500 },
)
assert.equal(result.kind, 'unmatched')

// T13: git.worktrees.open must be reachable by a bound shortcut, not only the
// command palette. A user-configured override resolves to the registry id so the
// WorkspaceManager.runCommand route added in T13 actually fires instead of
// silently no-opping (T8 review finding A10).
const worktreeDispatcher = new RendererCommandDispatcher(500)
result = worktreeDispatcher.resolve(
  key({ key: 'w', code: 'KeyW', ctrlKey: true, altKey: true }),
  {
    activeScopes: ['global', 'workspace'],
    platform: 'linux',
    availability: { activeWorkspace: true },
    keybindingOverrides: { 'git.worktrees.open': ['Primary+Alt+W'] },
    now: 4000,
  },
)
assert.equal(result.kind, 'matched')
assert.equal(result.kind === 'matched' ? result.commandId : null, 'git.worktrees.open')

// Without an active workspace the binding stays unmatched, so the shortcut never
// fires a silent no-op in a workspace-less window (availability: activeWorkspace).
result = worktreeDispatcher.resolve(
  key({ key: 'w', code: 'KeyW', ctrlKey: true, altKey: true }),
  {
    activeScopes: ['global', 'workspace'],
    platform: 'linux',
    keybindingOverrides: { 'git.worktrees.open': ['Primary+Alt+W'] },
    now: 4100,
  },
)
assert.equal(result.kind, 'unmatched')

// A still-valid chord completes normally after the revalidation refactor.
const stillValidChord = new RendererCommandDispatcher(500)
result = stillValidChord.resolve(
  key({ key: 'g', code: 'KeyG' }),
  { activeScopes: ['global', 'workspace', 'panel:sprintengine'], platform: 'linux', availability: sprintEngineChord, now: 2600 },
)
assert.equal(result.kind, 'pending')
result = stillValidChord.resolve(
  key({ key: 'k', code: 'KeyK' }),
  { activeScopes: ['global', 'workspace', 'panel:sprintengine'], platform: 'linux', availability: sprintEngineChord, now: 2650 },
)
assert.equal(result.kind, 'matched')
assert.equal(result.kind === 'matched' ? result.commandId : null, 'sprintengine.goto.kanban')

// --- Module-contributed commands (merged via context.commands) --------------
// The dispatcher matches against the merge-point output (shell registry +
// enabled module commands). These cases pin the enablement-reactive behavior
// and the no-silent-shadowing rule.
import { COMMAND_REGISTRY } from './commandRegistry'
import type { CommandContribution } from './types'

const moduleCommand: CommandContribution = {
  id: 'demo-module.hello',
  title: 'Say Hello',
  category: 'Demo Module',
  scopes: ['global'],
  defaultKeybindings: ['Primary+Alt+H'],
}
const enabledCommands: readonly CommandContribution[] = [...COMMAND_REGISTRY, moduleCommand]

const moduleDispatcher = new RendererCommandDispatcher(500)
result = moduleDispatcher.resolve(
  key({ key: 'h', code: 'KeyH', ctrlKey: true, altKey: true }),
  { activeScopes: ['global'], platform: 'linux', commands: enabledCommands, now: 5000 },
)
assert.equal(result.kind, 'matched')
assert.equal(
  result.kind === 'matched' ? result.commandId : null,
  'demo-module.hello',
  'a module command keybinding dispatches like a built-in',
)

// Module disabled -> the merge point omits the command, so the binding is gone
// from key dispatch without any dispatcher-side special case.
result = moduleDispatcher.resolve(
  key({ key: 'h', code: 'KeyH', ctrlKey: true, altKey: true }),
  { activeScopes: ['global'], platform: 'linux', commands: COMMAND_REGISTRY, now: 5100 },
)
assert.equal(result.kind, 'unmatched', 'disabling the module removes its key dispatch')

// User override persisted by command id re-attaches when the module returns.
result = moduleDispatcher.resolve(
  key({ key: 'j', code: 'KeyJ', ctrlKey: true, altKey: true }),
  {
    activeScopes: ['global'],
    platform: 'linux',
    commands: enabledCommands,
    keybindingOverrides: { 'demo-module.hello': ['Primary+Alt+J'] },
    now: 5200,
  },
)
assert.equal(result.kind, 'matched')
assert.equal(
  result.kind === 'matched' ? result.commandId : null,
  'demo-module.hello',
  'a customized module binding works after re-enable',
)

// A module command that duplicates a built-in binding at the same scope
// specificity cannot silently shadow it: shell commands sort first in the
// merge point, so the built-in keeps firing (and the Shortcuts tab surfaces
// the conflict like any other duplicate binding).
const shadowingCommand: CommandContribution = {
  id: 'demo-module.shadow',
  title: 'Shadow Palette',
  category: 'Demo Module',
  scopes: ['global'],
  defaultKeybindings: ['Primary+K'],
}
result = moduleDispatcher.resolve(
  key({ key: 'k', code: 'KeyK', ctrlKey: true }),
  { activeScopes: ['global'], platform: 'linux', commands: [...COMMAND_REGISTRY, shadowingCommand], now: 5300 },
)
assert.equal(result.kind, 'matched')
assert.equal(
  result.kind === 'matched' ? result.commandId : null,
  'commandPalette.open',
  'a built-in keeps priority over a module command bound to the same keys',
)

// Predicate-gated module command: matches only when the published module
// context satisfies the predicate; with no context wired it never matches
// (fail closed), and a module-derived panel scope gets panel specificity.
const predicateCommand: CommandContribution = {
  id: 'calendar.open.settings',
  title: 'Calendar Settings',
  category: 'Calendar',
  scopes: ['panel:calendar'],
  defaultKeybindings: ['Primary+9'],
  availabilityPredicate: (context) => context.activeWorkspaceMode === 'calendar',
}
const predicateDispatcher = new RendererCommandDispatcher()
result = predicateDispatcher.resolve(
  key({ key: '9', code: 'Digit9', ctrlKey: true }),
  {
    activeScopes: ['global', 'workspace', 'panel:calendar'],
    platform: 'linux',
    commands: [predicateCommand],
    moduleContext: { activeWorkspaceId: 'ws-1', activeWorkspaceMode: 'calendar' },
    now: 6000,
  },
)
assert.equal(result.kind, 'matched')
assert.equal(result.kind === 'matched' ? result.commandId : null, 'calendar.open.settings')
result = predicateDispatcher.resolve(
  key({ key: '9', code: 'Digit9', ctrlKey: true }),
  {
    activeScopes: ['global', 'workspace', 'panel:calendar'],
    platform: 'linux',
    commands: [predicateCommand],
    moduleContext: { activeWorkspaceId: 'ws-1', activeWorkspaceMode: 'standard' },
    now: 6100,
  },
)
assert.equal(result.kind, 'unmatched', 'predicate false refuses the binding')
result = predicateDispatcher.resolve(
  key({ key: '9', code: 'Digit9', ctrlKey: true }),
  {
    activeScopes: ['global', 'workspace', 'panel:calendar'],
    platform: 'linux',
    commands: [predicateCommand],
    now: 6200,
  },
)
assert.equal(result.kind, 'unmatched', 'no module context wired fails closed')

// Persisted overrides keyed by a migrated command's LEGACY id keep firing the
// re-namespaced id (Watchtower's module-path migration).
const migratedCommand: CommandContribution = {
  id: 'switchboard.watchtower.run.review',
  title: 'Run review',
  category: 'Watchtower',
  scopes: ['panel:watchtower'],
}
result = predicateDispatcher.resolve(
  key({ key: 'r', code: 'KeyR', ctrlKey: true, shiftKey: true }),
  {
    activeScopes: ['global', 'workspace', 'panel:watchtower'],
    platform: 'linux',
    commands: [migratedCommand],
    keybindingOverrides: { 'watchtower.run.review': ['Primary+Shift+R'] },
    now: 6300,
  },
)
assert.equal(result.kind, 'matched', 'legacy-id override still binds')
assert.equal(result.kind === 'matched' ? result.commandId : null, 'switchboard.watchtower.run.review')

console.log('command dispatcher module command tests passed')
