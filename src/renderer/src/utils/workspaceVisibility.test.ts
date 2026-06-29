import assert from 'node:assert/strict'
import {
  AUTOMATIONS_HOST_WORKSPACE_MODE,
  GUIDED_BRIEF_WORKSPACE_MODE,
  MULTILOOP_WORKSPACE_MODE,
  SPRINT_ENGINE_WORKSPACE_MODE,
  STANDARD_WORKSPACE_MODE,
  SWITCHBOARD_WORKSPACE_MODE,
  type BundledWorkspaceMode,
} from '../types/workspace'
import { isAutomationsHostWorkspace, isHiddenFromRail } from './workspaceVisibility'

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
// just asserted by a comment.
const EXPECTED_HIDDEN: Record<BundledWorkspaceMode, boolean> = {
  [STANDARD_WORKSPACE_MODE]: false,
  [SPRINT_ENGINE_WORKSPACE_MODE]: false,
  [SWITCHBOARD_WORKSPACE_MODE]: false,
  [MULTILOOP_WORKSPACE_MODE]: false,
  [GUIDED_BRIEF_WORKSPACE_MODE]: false,
  // The Automations workspace is now a visible, user-created type that hosts its
  // run terminals in plain sight, so nothing is currently rail-hidden.
  [AUTOMATIONS_HOST_WORKSPACE_MODE]: false,
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

run('isHiddenFromRail hides exactly the modes flagged hidden', () => {
  for (const mode of BUNDLED_MODES) {
    assert.equal(isHiddenFromRail({ mode }), EXPECTED_HIDDEN[mode], `unexpected isHiddenFromRail for ${mode}`)
  }
})

run('predicates treat an unknown custom mode as a normal visible workspace', () => {
  assert.equal(isAutomationsHostWorkspace({ mode: 'custom-plugin-mode' }), false)
  assert.equal(isHiddenFromRail({ mode: 'custom-plugin-mode' }), false)
})
