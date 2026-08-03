import assert from 'node:assert/strict'

import { getRendererHost } from '../../../modules'
import { SPRINT_ENGINE_WORKSPACE_MODE } from '../../../types/workspace'
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
assert.deepEqual(stepsForMode('guided-brief'), STEPS_BY_MODE['guided-brief'], 'guided-brief resolves via the registry')

// The sprint flow is deleted (MC-2062): sprint creation is the New sprint
// dialog, so the registry entry names no flow, the flow registry carries none,
// and no step of any flow is a sprint step. The mode still resolves — to the
// zero-config shared fields — because the hub must never crash on a persisted
// mode id; every live route to it opens the dialog instead of the hub.
assert.ok(!(SPRINT_ENGINE_WORKSPACE_MODE in STEPS_BY_MODE), 'the flow registry carries no sprint flow')
for (const [flowId, steps] of Object.entries(STEPS_BY_MODE)) {
  for (const step of steps) {
    assert.ok(
      !step.startsWith(`${SPRINT_ENGINE_WORKSPACE_MODE}-`),
      `${flowId} carries no sprint step (${step})`,
    )
  }
}
assert.deepEqual(
  stepsForMode(SPRINT_ENGINE_WORKSPACE_MODE),
  ['workspace'],
  'the sprint mode id falls back to the zero-config flow instead of crashing the hub',
)

// A mode id with no registry entry routes to the standard flow without
// throwing, so a persisted unknown/plugin mode never strands the hub.
assert.deepEqual(stepsForMode('totally-unknown-mode'), STEPS_BY_MODE.standard, 'unknown mode id falls back to standard')
assert.deepEqual(stepsForMode(''), STEPS_BY_MODE.standard, 'empty mode id falls back to standard')

// Novice-first flow contract: the developer-configuration steps are off the
// create gate in every default flow (they live in Settings / the optional
// Advanced setup disclosure), every flow leads with the shared name/folder
// fields, and the retired 'mode' pivot never reappears — the hub's rail is the
// type choice.
const CONFIG_STEPS = ['mcp-servers', 'knowledge'] as const
for (const [flowId, steps] of Object.entries(STEPS_BY_MODE)) {
  for (const configStep of CONFIG_STEPS) {
    assert.ok(!steps.includes(configStep), `${flowId} flow must not gate on ${configStep}`)
  }
  assert.equal(steps[0], 'workspace', `${flowId} flow starts at workspace`)
  assert.ok(!(steps as string[]).includes('mode'), `${flowId} flow carries no retired mode pivot`)
}

// The novice critical paths stay short.
assert.deepEqual(STEPS_BY_MODE['guided-brief'], ['workspace', 'guided-idea'])

// Creating a standard workspace is folder -> Create, full stop. The layout step
// asked the user to confirm a selection the panel had already made (Solo Dev),
// so it was removed; a different layout comes from the Command Palette after the
// workspace exists. Re-adding a step here puts a page back in front of the
// shortest path into the product.
assert.deepEqual(STEPS_BY_MODE.standard, ['workspace'], 'standard creation has no config steps')

// The footer's "Skip the rest and create" is only honest if every step AFTER a
// flow's required-intent step is defaulted — skipping must never silently accept
// a blank the user was actually meant to fill in. With the sprint flow gone
// there is no defaulted refinement step left, so the invariant tightens: an
// intent step must be its flow's LAST step.
const INTENT_STEPS = ['guided-idea'] as const
for (const [flowId, steps] of Object.entries(STEPS_BY_MODE)) {
  const intentIndex = steps.findIndex((step) => (INTENT_STEPS as readonly string[]).includes(step))
  if (intentIndex < 0) continue
  assert.equal(
    intentIndex,
    steps.length - 1,
    `${flowId}: the intent step must be last — a step after it must be defaulted, and no defaulted refinement steps remain`,
  )
}

// Zero-config quick flows are exactly the shared fields — the hub shows no
// Advanced setup disclosure for them; they defer that configuration to Settings
// (see NewWorkspacePanel's showAdvancedSetup, which lists 'standard' explicitly
// because it is zero-config too but keeps the disclosure it always had).
assert.deepEqual(STEPS_BY_MODE.switchboard, ['workspace'])
assert.deepEqual(STEPS_BY_MODE.automations, ['workspace'])

// A registered type with no creationStepsId (module-contributed workspace
// types) resolves to the zero-config flow: its createTemplate() is the layout,
// so the standard layout-picker step must not appear and override it. Unknown
// UNREGISTERED ids still fall back to standard (asserted above).
{
  getRendererHost()
    .hostFor('flow-test-module')
    .registerWorkspaceType({
      id: 'flow-test-module',
      label: 'Flow Test',
      description: 'Module-contributed type used by creationStepFlows tests.',
      icon: () => null,
      createTemplate: () => ({
        id: 'flow-test',
        name: 'Flow Test',
        description: 'test',
        previewSlots: [],
        layout: { layout: { type: 'row', children: [] } },
      }),
    })
  assert.deepEqual(
    stepsForMode('flow-test-module'),
    ['workspace'],
    'module-contributed type with no creationStepsId gets the zero-config flow'
  )
}

// A registered type WITH a contributed creationStep resolves to the shared
// fields plus its one module step — never the standard flow.
{
  getRendererHost()
    .hostFor('flow-step-module')
    .registerWorkspaceType({
      id: 'flow-step-module',
      label: 'Flow Step Test',
      description: 'Module-contributed type with a creation step.',
      icon: () => null,
      creationStep: {
        id: 'flow-step',
        heading: 'Configure the thing',
        Component: () => null,
      },
      createTemplate: () => ({
        id: 'flow-step-test',
        name: 'Flow Step Test',
        description: 'test',
        previewSlots: [],
        layout: { layout: { type: 'row', children: [] } },
      }),
    })
  assert.deepEqual(
    stepsForMode('flow-step-module'),
    ['workspace', 'module-step'],
    'module-contributed type with a creationStep gets the module step'
  )
}

console.log('creation step flow tests passed')
