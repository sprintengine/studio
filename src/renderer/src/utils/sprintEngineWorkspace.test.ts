import assert from 'node:assert/strict'

import { isSprintEngineWorkspace } from './sprintEngineWorkspace'

// Membership: sprintengine mode or a sprintengine bag entry with context/state.
assert.equal(isSprintEngineWorkspace({ mode: 'sprintengine' }), true)
assert.equal(isSprintEngineWorkspace({ mode: 'default', moduleState: { sprintengine: { context: { team: 't' } } } }), true)
assert.equal(isSprintEngineWorkspace({ mode: 'default', moduleState: { sprintengine: {} } }), false)
assert.equal(isSprintEngineWorkspace({ mode: 'default' }), false)

console.log('sprintEngineWorkspace tests passed')
