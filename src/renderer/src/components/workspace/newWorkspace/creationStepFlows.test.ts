import assert from 'node:assert/strict'

import { STEPS_BY_MODE, isAdvancedSetupStep, stepsForMode } from './creationStepFlows'

// 'standard' is shell-owned and resolves to the standard flow directly.
assert.deepEqual(stepsForMode('standard'), STEPS_BY_MODE.standard, 'standard resolves to the standard flow')

// T2 AC1/AC2: 'chat' is a shell-owned pseudo-type — not a registered workspace
// type and with no creationStepsId — so it resolves inline (like 'standard') to a
// flow that ends at the 'mode' step, where NewWorkspacePanel embeds AgentComposer
// as the chat config surface. It must not fall through to the standard flow.
assert.deepEqual(stepsForMode('chat'), ['workspace', 'mode'], 'chat resolves to the shell-owned workspace→mode flow ending at the mode step')
assert.equal(stepsForMode('chat').at(-1), 'mode', 'chat flow ends at the mode step (composer-hosted, no post-mode wizard steps)')

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

// T8 (tester C5): the optional Advanced setup disclosure rides the flow's final
// step but is never hosted on the 'mode' pivot. Verify per flow.
for (const [flowId, steps] of Object.entries(STEPS_BY_MODE)) {
  const lastStep = steps[steps.length - 1]
  // Disclosure never appears on the mode-selection screen, in any flow.
  assert.ok(!isAdvancedSetupStep(steps, 'mode'), `${flowId} keeps Advanced setup off the mode step`)
  if (lastStep === 'mode') {
    // Zero-config quick flows end at the mode pivot — no in-wizard disclosure.
    assert.ok(!isAdvancedSetupStep(steps, lastStep), `${flowId} (mode-terminal) shows no in-wizard Advanced setup`)
  } else {
    // Every flow with a real final config step hosts the disclosure there only.
    assert.ok(isAdvancedSetupStep(steps, lastStep), `${flowId} shows Advanced setup on its final step ${lastStep}`)
    for (const step of steps.slice(0, -1)) {
      assert.ok(!isAdvancedSetupStep(steps, step), `${flowId} hides Advanced setup on the non-final step ${step}`)
    }
  }
}
// Standard flow specifics from the C5 reproduction: absent on 'mode', present on
// the final 'standard-layout' (Pick an IDE layout).
assert.ok(!isAdvancedSetupStep(STEPS_BY_MODE.standard, 'mode'), 'standard: absent from Choose a mode')
assert.ok(isAdvancedSetupStep(STEPS_BY_MODE.standard, 'standard-layout'), 'standard: present on Pick an IDE layout')

console.log('creation step flow tests passed')
