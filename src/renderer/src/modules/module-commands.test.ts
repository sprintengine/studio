import assert from 'node:assert/strict'

import { isCommandEnabled } from '../commands/availability'
import { getEffectiveKeybindings } from '../commands/effectiveKeybindings'
import { createRendererHost } from './renderer-host'
import { voiceDictationRendererModule } from './voice-dictation-module'

// The module command path (MC-1533) exercised against a REAL registration
// rather than a hand-rolled lookalike: the namespaced id, the scope, and the
// legacy-id alias that keeps a persisted override for the shell command this
// one replaced working.

const kernel = createRendererHost()
voiceDictationRendererModule.registerRenderer?.(kernel.hostFor(voiceDictationRendererModule.manifest.id))

const commands = kernel.getModuleCommands()
const byId = new Map(commands.map((command) => [command.id, command]))

assert.deepEqual(
  [...byId.keys()].sort(),
  ['voice-dictation.toggle'],
  'a module command registers under `<moduleId>.<id>`, never its bare id',
)

// A global-scope module command is offered wherever the shell pushes 'global'.
const toggle = byId.get('voice-dictation.toggle')!
assert.deepEqual(toggle.scopes, ['global'])
assert.equal(toggle.availability, undefined)
assert.equal(toggle.availabilityPredicate, undefined)
assert.equal(isCommandEnabled(toggle, ['global', 'workspace'], {}), true)
assert.equal(isCommandEnabled(toggle, ['workspace'], {}), false, 'out of scope stays unoffered')

// Persisted overrides keyed by the LEGACY shell id keep working.
assert.deepEqual(
  getEffectiveKeybindings('voice-dictation.toggle', { overrides: { 'voice.toggle': ['Primary+Shift+R'] } }, toggle),
  ['Primary+Shift+R'],
  'a legacy-id override resolves for the re-namespaced id',
)
assert.deepEqual(
  getEffectiveKeybindings('voice-dictation.toggle', { disabled: { 'voice.toggle': true } }, toggle),
  [],
  'a legacy-id disable suppresses the re-namespaced id',
)

// An availability predicate is evaluated against the published context view,
// and fails closed when no context is wired.
kernel.hostFor('notebook').registerCommand({
  id: 'refresh',
  title: 'Refresh notebook',
  category: 'Notebook',
  scopes: ['panel:notebook'],
  availability: (context) => Boolean(context.activeWorkspaceId) && context.activeWorkspaceMode === 'notebook',
  run: () => undefined,
})
const refresh = kernel.getModuleCommands().find((command) => command.id === 'notebook.refresh')!
assert.equal(refresh.availability, undefined)
assert.equal(typeof refresh.availabilityPredicate, 'function')
const notebookScopes = ['global', 'workspace', 'panel:notebook'] as const
assert.equal(
  isCommandEnabled(refresh, notebookScopes, {}, { activeWorkspaceId: 'ws', activeWorkspaceMode: 'notebook' }),
  true,
)
assert.equal(
  isCommandEnabled(refresh, notebookScopes, {}, { activeWorkspaceId: 'ws', activeWorkspaceMode: 'standard' }),
  false,
)
assert.equal(isCommandEnabled(refresh, notebookScopes, {}), false, 'fail closed with no context')

// A typo'd panel scope fails registration loudly instead of registering a
// permanently dead command.
assert.throws(
  () =>
    kernel.hostFor('calendar').registerCommand({
      id: 'open.settings',
      title: 'Settings',
      category: 'Calendar',
      scopes: ['panel:calender'],
      run: () => undefined,
    }),
  /would never be offered/,
)

console.log('module command registrations guard passed')
