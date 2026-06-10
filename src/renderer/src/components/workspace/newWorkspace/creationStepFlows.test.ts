import assert from 'node:assert/strict'

import { STEPS_BY_MODE, stepsForMode } from './creationStepFlows'

// 'standard' is shell-owned and resolves to the standard flow directly.
assert.deepEqual(stepsForMode('standard'), STEPS_BY_MODE.standard, 'standard resolves to the standard flow')

// Contributed types resolve through their registry creationStepsId. The bundled
// modules register eagerly when ./creationStepFlows pulls in ../../../modules.
assert.deepEqual(stepsForMode('switchboard'), STEPS_BY_MODE.switchboard, 'switchboard resolves via the registry')
assert.deepEqual(stepsForMode('sprintengine'), STEPS_BY_MODE.sprintengine, 'sprintengine resolves via the registry')
assert.deepEqual(stepsForMode('multiloop'), STEPS_BY_MODE.multiloop, 'multiloop resolves via the registry')
assert.deepEqual(stepsForMode('guided-brief'), STEPS_BY_MODE['guided-brief'], 'guided-brief resolves via the registry')

// AC3: a mode id with no registry entry routes to the standard wizard step flow
// without throwing, so a persisted unknown/plugin mode never strands the wizard.
assert.deepEqual(stepsForMode('totally-unknown-mode'), STEPS_BY_MODE.standard, 'unknown mode id falls back to standard')
assert.deepEqual(stepsForMode(''), STEPS_BY_MODE.standard, 'empty mode id falls back to standard')

console.log('creation step flow tests passed')
