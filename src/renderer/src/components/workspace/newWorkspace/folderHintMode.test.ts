import assert from 'node:assert/strict'

import { folderHintAutoSelectMode } from './folderHintMode'

const allEnabled = { sprintEngineEnabled: true, multiloopEnabled: true }

// No hint, or a hint with neither marker, selects nothing.
assert.equal(folderHintAutoSelectMode(null, allEnabled), null)
assert.equal(folderHintAutoSelectMode(undefined, allEnabled), null)
assert.equal(folderHintAutoSelectMode({}, allEnabled), null)

// Enabled-module markers auto-select their mode; Sprint Engine wins when both.
assert.equal(folderHintAutoSelectMode({ hasSprintEngineTeam: true }, allEnabled), 'sprintengine')
assert.equal(folderHintAutoSelectMode({ hasMultiloop: true }, allEnabled), 'multiloop')
assert.equal(
  folderHintAutoSelectMode({ hasSprintEngineTeam: true, hasMultiloop: true }, allEnabled),
  'sprintengine',
)

// AC6 regression: a disabled module's marker must never auto-select a hidden mode.
assert.equal(
  folderHintAutoSelectMode({ hasMultiloop: true }, { sprintEngineEnabled: true, multiloopEnabled: false }),
  null,
  'multiloop marker does not select multiloop when the module is disabled',
)
assert.equal(
  folderHintAutoSelectMode({ hasSprintEngineTeam: true }, { sprintEngineEnabled: false, multiloopEnabled: true }),
  null,
  'sprint-engine marker does not select sprintengine when the module is disabled',
)

// When the Sprint Engine module is disabled but a Multiloop marker is also
// present and enabled, fall through to the available mode rather than nothing.
assert.equal(
  folderHintAutoSelectMode(
    { hasSprintEngineTeam: true, hasMultiloop: true },
    { sprintEngineEnabled: false, multiloopEnabled: true },
  ),
  'multiloop',
  'falls through to multiloop when sprint-engine is disabled',
)

// Both modules disabled selects nothing.
assert.equal(
  folderHintAutoSelectMode(
    { hasSprintEngineTeam: true, hasMultiloop: true },
    { sprintEngineEnabled: false, multiloopEnabled: false },
  ),
  null,
)

console.log('folder hint mode tests passed')
