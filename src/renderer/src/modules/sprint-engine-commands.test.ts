import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isCommandEnabled } from '../commands/availability'
import { getEffectiveKeybindings } from '../commands/effectiveKeybindings'
import { LEGACY_COMMAND_ID_ALIASES } from '../commands/keybindings'
import { createRendererHost } from './renderer-host'
import { registerSprintEngineCommands, SPRINT_ENGINE_COMMAND_LEGACY_ALIASES } from './sprint-engine-commands'

const kernel = createRendererHost()
registerSprintEngineCommands(kernel.hostFor('sprint-engine'))
const commands = kernel.getModuleCommands()
const byId = new Map(commands.map((command) => [command.id, command]))

assert.equal(commands.length, 12, 'eleven board commands plus New sprint')
assert.ok(byId.has('sprint-engine.new'), 'the New sprint command is global')
assert.deepEqual(byId.get('sprint-engine.new')?.scopes, ['global'])
assert.deepEqual(byId.get('sprint-engine.new')?.defaultKeybindings, ['primary+shift+n'])

const inbox = byId.get('sprint-engine.goto.inbox')!
assert.deepEqual(inbox.scopes, ['panel:sprint-engine'])
assert.equal(inbox.category, 'Sprint')
assert.equal(inbox.title, 'Inbox')
assert.equal(
  isCommandEnabled(inbox, ['global', 'workspace', 'panel:sprint-engine'], { sprintengineWorkspace: true }),
  true,
  'navigation is offered in the module panel scope',
)
assert.equal(
  isCommandEnabled(inbox, ['global', 'workspace'], {}),
  false,
  'navigation is absent outside the module panel scope',
)

const verify = byId.get('sprint-engine.verify.progress')!
assert.equal(
  isCommandEnabled(verify, ['panel:sprint-engine'], { sprintengineWorkspace: true }),
  false,
  'verify-progress needs an architect',
)
assert.equal(
  isCommandEnabled(verify, ['panel:sprint-engine'], { sprintengineWorkspace: true, sprintengineHasArchitect: true }),
  true,
)

for (const [currentId, legacyId] of Object.entries(SPRINT_ENGINE_COMMAND_LEGACY_ALIASES)) {
  assert.equal(
    LEGACY_COMMAND_ID_ALIASES[currentId],
    legacyId,
    `${currentId} keeps the ${legacyId} keybinding alias`,
  )
  const command = byId.get(currentId)
  assert.ok(command, `${currentId} is registered`)
  assert.deepEqual(
    getEffectiveKeybindings(currentId, { overrides: { [legacyId]: ['Primary+Shift+9'] } }, command),
    ['Primary+Shift+9'],
    `a persisted ${legacyId} override still wins`,
  )
}

const modal = kernel.getModalSurface('sprint-engine-new')
assert.equal(modal, undefined, 'the modal surface is registered from the module, not this helper')

const paletteSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/ui/CommandPalette.tsx'),
  'utf8',
)
assert.equal(
  paletteSource.includes('sprintEngineCommands'),
  false,
  'the palette does not hard-code a Sprint Engine command list',
)
assert.equal(
  paletteSource.includes("id: 'sprintengine."),
  false,
  'the palette does not hard-code legacy sprintengine command ids',
)
const registrySource = readFileSync(
  join(process.cwd(), 'src/renderer/src/commands/commandRegistry.ts'),
  'utf8',
)
assert.equal(
  registrySource.includes("id: 'sprintengine."),
  false,
  'the shell registry no longer owns Sprint Engine command ids',
)
const moduleSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/modules/sprint-engine-module.ts'),
  'utf8',
)
assert.match(moduleSource, /registerSprintEngineCommands\(host\)/, 'the module registers the commands')
assert.match(moduleSource, /registerModalSurface/, 'the module registers the New sprint modal surface')
