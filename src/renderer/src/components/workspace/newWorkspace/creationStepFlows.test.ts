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

// Novice-first flow contract: the developer-configuration steps are off the linear
// gate in every default flow (they live in Settings / the optional advanced
// surface), and every flow leads with workspace then the mode pivot.
const CONFIG_STEPS = ['mcp-servers', 'skill-packs', 'knowledge'] as const
for (const [flowId, steps] of Object.entries(STEPS_BY_MODE)) {
  for (const configStep of CONFIG_STEPS) {
    assert.ok(!steps.includes(configStep), `${flowId} flow must not gate on ${configStep}`)
  }
  assert.equal(steps[0], 'workspace', `${flowId} flow starts at workspace`)
  assert.equal(steps[1], 'mode', `${flowId} flow keeps the mode pivot second`)
}

// The novice critical paths stay short.
assert.deepEqual(STEPS_BY_MODE.sprintengine, ['workspace', 'mode', 'sprintengine-team', 'sprintengine-roster'])
assert.deepEqual(STEPS_BY_MODE['guided-brief'], ['workspace', 'mode', 'guided-idea'])

console.log('creation step flow tests passed')
