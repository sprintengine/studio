import assert from 'node:assert/strict'

import { isSprintEngineWorkspace } from './sprintEngineWorkspace'

// Membership: sprintengine mode or a sprint engine context, nothing else.
assert.equal(isSprintEngineWorkspace({ mode: 'sprintengine', sprintEngineContext: null }), true)
assert.equal(isSprintEngineWorkspace({ mode: 'default', sprintEngineContext: { team: 't' } }), true)
assert.equal(isSprintEngineWorkspace({ mode: 'default', sprintEngineContext: null }), false)
assert.equal(isSprintEngineWorkspace({ mode: 'default' }), false)

console.log('sprintEngineWorkspace tests passed')
