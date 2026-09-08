import assert from 'node:assert/strict'

import { panelTabAccentClass } from './panelTabAccent'

const enabled = {}

// Enabled: the panel tab keeps its tool identity accent.
assert.ok(panelTabAccentClass('sprintengine', enabled).includes('--tool-sprintengine'), 'enabled sprintengine tab keeps its accent')

// AC4: disabling the owning module degrades the tab accent to the muted default.
assert.ok(panelTabAccentClass('sprintengine', { 'sprint-engine': false }).includes('--text-muted'), 'disabled sprint-engine module mutes the sprintengine tab accent')
assert.ok(!panelTabAccentClass('sprintengine', { 'sprint-engine': false }).includes('--tool-sprintengine'), 'disabled sprintengine tab drops the tool accent')

// Re-enable recovery: flipping the module back on restores the tool accent.
assert.equal(
  panelTabAccentClass('sprintengine', { 'sprint-engine': true }),
  panelTabAccentClass('sprintengine', enabled),
  're-enabling sprint-engine restores the tab accent',
)

console.log('panel tab accent tests passed')
