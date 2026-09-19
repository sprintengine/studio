import assert from 'node:assert/strict'
import { AUTOMATIONS_HOST_WORKSPACE_MODE, STANDARD_WORKSPACE_MODE, type BundledWorkspaceMode } from '../types/workspace'
import { isModeHiddenFromRail } from '../../../shared/workspace-mode'
import { isAutomationsHostWorkspace, isHiddenFromRail, isRailHiddenModuleWorkspace } from './workspaceVisibility'
import { getRendererHost } from '../modules'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

// Expected rail-hidden state for every bundled mode. Typed as a
// `Record<BundledWorkspaceMode, boolean>` so adding a member to the union
// without a row here is a compile error — the exhaustiveness guard is real, not
// just asserted by a comment. A module-registered type is not a bundled mode
// and is covered separately below.
const EXPECTED_HIDDEN: Record<BundledWorkspaceMode, boolean> = {
  [STANDARD_WORKSPACE_MODE]: false,
  // Automations moved to an instance-level surface (the sidebar door), so their
  // host workspaces are rail-hidden background runtime containers — never a
  // Projects-list row, switch target, or palette result.
  [AUTOMATIONS_HOST_WORKSPACE_MODE]: true,
}

const BUNDLED_MODES = Object.keys(EXPECTED_HIDDEN) as BundledWorkspaceMode[]

run('isAutomationsHostWorkspace is true only for the automations-host mode', () => {
  for (const mode of BUNDLED_MODES) {
    assert.equal(
      isAutomationsHostWorkspace({ mode }),
      mode === AUTOMATIONS_HOST_WORKSPACE_MODE,
      `unexpected isAutomationsHostWorkspace for ${mode}`,
    )
  }
})

run('isHiddenFromRail hides exactly the bundled modes flagged hidden', () => {
  for (const mode of BUNDLED_MODES) {
    assert.equal(isHiddenFromRail({ mode }), EXPECTED_HIDDEN[mode], `unexpected isHiddenFromRail for ${mode}`)
  }
})

// A module-registered type that declares `hiddenFromRail` is a background
// residency for that module's terminals. No bundled type declares it today, so
// the rule is exercised against a type registered here.
const HIDDEN_TYPE_ID = 'rail-hidden-probe'
getRendererHost()
  .hostFor('automations')
  .registerWorkspaceType({
    id: HIDDEN_TYPE_ID,
    label: 'Rail-hidden probe',
    description: 'Test-only workspace type.',
    icon: () => null,
    hiddenFromPicker: true,
    hiddenFromRail: true,
    createTemplate: () => ({
      id: HIDDEN_TYPE_ID,
      name: 'Rail-hidden probe',
      description: 'Test-only workspace type.',
      previewSlots: [],
      layout: { global: {}, borders: [], layout: { type: 'row', children: [] } },
    }),
  } as never)

run('a registered rail-hidden workspace is hidden while its module is on', () => {
  assert.equal(isRailHiddenModuleWorkspace({ mode: HIDDEN_TYPE_ID }), true)
  assert.equal(isHiddenFromRail({ mode: HIDDEN_TYPE_ID }), true)
})

run('a persisted workspace of that type is not rail-hidden when its module is off', () => {
  const moduleOff = { automations: false }
  assert.equal(isRailHiddenModuleWorkspace({ mode: HIDDEN_TYPE_ID }, moduleOff), false)
  assert.equal(
    isHiddenFromRail({ mode: HIDDEN_TYPE_ID }, moduleOff),
    false,
    'the row comes back as an absence surface rather than vanishing with its door',
  )
})

run('the renderer predicate still matches the shared rule for bundled modes', () => {
  assert.equal(AUTOMATIONS_HOST_WORKSPACE_MODE, 'automations-host')
  for (const mode of [...BUNDLED_MODES, 'custom-plugin-mode']) {
    if (mode === AUTOMATIONS_HOST_WORKSPACE_MODE) {
      assert.equal(isModeHiddenFromRail(mode), isHiddenFromRail({ mode }), `shared rule differs for ${mode}`)
    }
  }
})

run('predicates treat an unknown custom mode as a normal visible workspace', () => {
  assert.equal(isAutomationsHostWorkspace({ mode: 'custom-plugin-mode' }), false)
  assert.equal(isRailHiddenModuleWorkspace({ mode: 'custom-plugin-mode' }), false)
  assert.equal(isHiddenFromRail({ mode: 'custom-plugin-mode' }), false)
})
