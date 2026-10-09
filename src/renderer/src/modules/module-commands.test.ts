import assert from 'node:assert/strict'

import { isCommandEnabled } from '../commands/availability'
import { getEffectiveKeybindings } from '../commands/effectiveKeybindings'
import { LEGACY_COMMAND_ID_ALIASES } from '../commands/keybindings'
import { createRendererHost, type RendererModule } from './renderer-host'
import { test } from 'vitest'

// A test-only module shaped like a bundled one: a manifest and a
// `registerRenderer` that contributes one global command through the host.
const fixtureModule: RendererModule = {
  manifest: {
    id: 'fixture-module',
    displayName: 'Fixture module',
    version: 1,
    publisher: 'sprintengine',
    category: 'connectivity',
    summary: 'Registers one global command for the module command tests.',
    defaultEnabled: true,
  },
  registerRenderer(host) {
    host.registerCommand({
      id: 'toggle',
      title: 'Toggle Fixture',
      category: 'Fixture',
      scopes: ['global'],
      defaultKeybindings: ['Primary+Shift+1'],
      allowInEditableTarget: true,
      run: () => undefined,
    })
  },
}

test('module-commands', async () => {
  // The module command path exercised through a module's own registerRenderer
  // rather than a hand-rolled lookalike: the namespaced id, the scope, and the
  // legacy-id alias that keeps a persisted override for a shell command a
  // module command replaced working.

  const kernel = createRendererHost()
  fixtureModule.registerRenderer?.(kernel.hostFor(fixtureModule.manifest.id))

  const commands = kernel.getModuleCommands()
  const byId = new Map(commands.map((command) => [command.id, command]))

  assert.deepEqual(
    [...byId.keys()].sort(),
    ['fixture-module.toggle'],
    'a module command registers under `<moduleId>.<id>`, never its bare id',
  )

  // A global-scope module command is offered wherever the shell pushes 'global'.
  const toggle = byId.get('fixture-module.toggle')!
  assert.deepEqual(toggle.scopes, ['global'])
  assert.equal(toggle.availability, undefined)
  assert.equal(toggle.availabilityPredicate, undefined)
  assert.equal(isCommandEnabled(toggle, ['global', 'workspace'], {}), true)
  assert.equal(isCommandEnabled(toggle, ['workspace'], {}), false, 'out of scope stays unoffered')

  // Persisted overrides keyed by the LEGACY shell id keep working. No command
  // is migrating today, so a fixture alias stands in for one.
  LEGACY_COMMAND_ID_ALIASES['fixture-module.toggle'] = 'fixture.toggle'
  try {
    assert.deepEqual(
      getEffectiveKeybindings(
        'fixture-module.toggle',
        { overrides: { 'fixture.toggle': ['Primary+Shift+R'] } },
        toggle,
      ),
      ['Primary+Shift+R'],
      'a legacy-id override resolves for the re-namespaced id',
    )
    assert.deepEqual(
      getEffectiveKeybindings('fixture-module.toggle', { disabled: { 'fixture.toggle': true } }, toggle),
      [],
      'a legacy-id disable suppresses the re-namespaced id',
    )
  } finally {
    delete LEGACY_COMMAND_ID_ALIASES['fixture-module.toggle']
  }

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
})
