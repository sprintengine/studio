import assert from 'node:assert/strict'

import { panelTabAccentClass } from './panelTabAccent'

const enabled = {}

// Enabled: each panel tab keeps its tool identity accent.
assert.ok(panelTabAccentClass('watchtower', enabled).includes('--tool-watchtower'), 'enabled watchtower tab keeps its accent')
assert.ok(panelTabAccentClass('switchboard', enabled).includes('--tool-switchboard'), 'enabled switchboard tab keeps its accent')
assert.ok(panelTabAccentClass('sprintengine', enabled).includes('--tool-sprintengine'), 'enabled sprintengine tab keeps its accent')

// AC4: disabling the owning module degrades the tab accent to the muted default.
// watchtower + switchboard both belong to the switchboard module.
assert.ok(panelTabAccentClass('watchtower', { switchboard: false }).includes('--text-muted'), 'disabled switchboard module mutes the watchtower tab accent')
assert.ok(panelTabAccentClass('switchboard', { switchboard: false }).includes('--text-muted'), 'disabled switchboard module mutes the switchboard tab accent')
assert.ok(panelTabAccentClass('sprintengine', { 'sprint-engine': false }).includes('--text-muted'), 'disabled sprint-engine module mutes the sprintengine tab accent')
assert.ok(!panelTabAccentClass('sprintengine', { 'sprint-engine': false }).includes('--tool-sprintengine'), 'disabled sprintengine tab drops the tool accent')

// Re-enable recovery: flipping the module back on restores the tool accent.
assert.equal(
  panelTabAccentClass('sprintengine', { 'sprint-engine': true }),
  panelTabAccentClass('sprintengine', enabled),
  're-enabling sprint-engine restores the tab accent',
)
assert.equal(
  panelTabAccentClass('switchboard', { switchboard: true }),
  panelTabAccentClass('switchboard', enabled),
  're-enabling switchboard restores the tab accent',
)

console.log('panel tab accent tests passed')
