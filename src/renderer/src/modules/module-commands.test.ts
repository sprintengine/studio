import assert from 'node:assert/strict'

import { isCommandEnabled } from '../commands/availability'
import { getEffectiveKeybindings } from '../commands/effectiveKeybindings'
import { createRendererHost } from './renderer-host'
import { switchboardRendererModule } from './switchboard-module'

// The 8 built-in commands migrated onto the module path (MC-1533) — this
// exercises the REAL registrations in switchboard-module, not hand-rolled
// lookalikes: ids (switchboard.* preserved; watchtower re-namespaced
// switchboard.watchtower.*), scopes, the predicate pair that replaced the
// switchboardWorkspace enum entry, and the legacy-id alias that keeps
// persisted watchtower.* overrides working.

const kernel = createRendererHost()
switchboardRendererModule.registerRenderer?.(kernel.hostFor(switchboardRendererModule.manifest.id))

const commands = kernel.getModuleCommands()
const byId = new Map(commands.map((command) => [command.id, command]))

assert.deepEqual(
  [...byId.keys()].sort(),
  [
    'switchboard.open.runner',
    'switchboard.refresh.board',
    'switchboard.watchtower.import.github',
    'switchboard.watchtower.import.jira',
    'switchboard.watchtower.open.active-review',
    'switchboard.watchtower.refresh.board',
    'switchboard.watchtower.run.review',
    'switchboard.watchtower.triage.inbox',
  ],
  'all 8 migrated commands register with their expected ids'
)

// The Switchboard pair rides the availability predicate: same semantics the
// old switchboardWorkspace enum encoded, evaluated against the published view.
const refreshBoard = byId.get('switchboard.refresh.board')!
assert.equal(refreshBoard.availability, undefined)
assert.equal(typeof refreshBoard.availabilityPredicate, 'function')
const switchboardScopes = ['global', 'workspace', 'panel:switchboard', 'panel:watchtower'] as const
assert.equal(
  isCommandEnabled(refreshBoard, switchboardScopes, {}, { activeWorkspaceId: 'ws', activeWorkspaceMode: 'switchboard' }),
  true,
)
assert.equal(
  isCommandEnabled(refreshBoard, switchboardScopes, {}, { activeWorkspaceId: 'ws', activeWorkspaceMode: 'standard' }),
  false,
)
assert.equal(isCommandEnabled(refreshBoard, switchboardScopes, {}), false, 'fail closed with no context')

// Watchtower commands are scope-gated only, under the shell-pushed
// panel:watchtower scope.
const runReview = byId.get('switchboard.watchtower.run.review')!
assert.deepEqual(runReview.scopes, ['panel:watchtower'])
assert.equal(runReview.availability, undefined)
assert.equal(runReview.availabilityPredicate, undefined)
assert.equal(runReview.category, 'Watchtower', 'palette rows keep the Watchtower group label')

// Persisted overrides keyed by the LEGACY watchtower ids keep working.
assert.deepEqual(
  getEffectiveKeybindings(
    'switchboard.watchtower.run.review',
    { overrides: { 'watchtower.run.review': ['Primary+Shift+R'] } },
    runReview,
  ),
  ['Primary+Shift+R'],
  'legacy watchtower.* override resolves for the re-namespaced id'
)
assert.deepEqual(
  getEffectiveKeybindings(
    'switchboard.watchtower.run.review',
    { disabled: { 'watchtower.run.review': true } },
    runReview,
  ),
  [],
  'legacy watchtower.* disable suppresses the re-namespaced id'
)

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
