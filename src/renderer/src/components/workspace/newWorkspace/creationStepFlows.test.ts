import assert from 'node:assert/strict'

import { STEPS_BY_MODE, stepsForMode } from './creationStepFlows'

// 'standard' is shell-owned and resolves to the standard flow directly.
assert.deepEqual(stepsForMode('standard'), STEPS_BY_MODE.standard, 'standard resolves to the standard flow')

// 'chat' is a shell-owned pseudo-type — not a registered workspace type and
// with no creationStepsId — so it resolves inline (like 'standard') to a flow
// with no config steps: the hub pane embeds AgentComposer, which owns the
// chat's whole config and create action. It must not fall through to the
// standard flow.
assert.deepEqual(stepsForMode('chat'), ['workspace'], 'chat resolves to the shell-owned zero-config flow')

// Contributed types resolve through their registry creationStepsId. The bundled
// modules register eagerly when ./creationStepFlows pulls in ../../../modules.
assert.deepEqual(stepsForMode('switchboard'), STEPS_BY_MODE.switchboard, 'switchboard resolves via the registry')
assert.deepEqual(stepsForMode('sprintengine'), STEPS_BY_MODE.sprintengine, 'sprintengine resolves via the registry')
assert.deepEqual(stepsForMode('multiloop'), STEPS_BY_MODE.multiloop, 'multiloop resolves via the registry')
assert.deepEqual(stepsForMode('guided-brief'), STEPS_BY_MODE['guided-brief'], 'guided-brief resolves via the registry')

// A mode id with no registry entry routes to the standard flow without
// throwing, so a persisted unknown/plugin mode never strands the hub.
assert.deepEqual(stepsForMode('totally-unknown-mode'), STEPS_BY_MODE.standard, 'unknown mode id falls back to standard')
assert.deepEqual(stepsForMode(''), STEPS_BY_MODE.standard, 'empty mode id falls back to standard')

// Novice-first flow contract: the developer-configuration steps are off the
// create gate in every default flow (they live in Settings / the optional
// Advanced setup disclosure), every flow leads with the shared name/folder
// fields, and the retired 'mode' pivot never reappears — the hub's rail is the
// type choice.
const CONFIG_STEPS = ['mcp-servers', 'skill-packs', 'knowledge'] as const
for (const [flowId, steps] of Object.entries(STEPS_BY_MODE)) {
  for (const configStep of CONFIG_STEPS) {
    assert.ok(!steps.includes(configStep), `${flowId} flow must not gate on ${configStep}`)
  }
  assert.equal(steps[0], 'workspace', `${flowId} flow starts at workspace`)
  assert.ok(!(steps as string[]).includes('mode'), `${flowId} flow carries no retired mode pivot`)
}

// The novice critical paths stay short.
assert.deepEqual(STEPS_BY_MODE.sprintengine, ['workspace', 'sprintengine-team', 'sprintengine-roster'])
assert.deepEqual(STEPS_BY_MODE['guided-brief'], ['workspace', 'guided-idea'])

// Zero-config quick flows are exactly the shared fields — the hub shows no
// Advanced setup disclosure for them (it renders only when a flow has real
// config steps; see NewWorkspacePanel's showAdvancedSetup).
assert.deepEqual(STEPS_BY_MODE.switchboard, ['workspace'])
assert.deepEqual(STEPS_BY_MODE.automations, ['workspace'])

console.log('creation step flow tests passed')
