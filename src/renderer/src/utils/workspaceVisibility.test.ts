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

// Every bundled mode and whether the rail should hide it. Keep this exhaustive:
// adding a bundled mode without a row here is a compile error via the typed map.
const VISIBLE_MODES: BundledWorkspaceMode[] = [
  STANDARD_WORKSPACE_MODE,
  SPRINT_ENGINE_WORKSPACE_MODE,
  SWITCHBOARD_WORKSPACE_MODE,
  MULTILOOP_WORKSPACE_MODE,
  GUIDED_BRIEF_WORKSPACE_MODE,
]

run('isAutomationsHostWorkspace is true only for the automations-host mode', () => {
  assert.equal(isAutomationsHostWorkspace({ mode: AUTOMATIONS_HOST_WORKSPACE_MODE }), true)
  for (const mode of VISIBLE_MODES) {
    assert.equal(isAutomationsHostWorkspace({ mode }), false, `expected ${mode} not to be automations-host`)
  }
})

run('isHiddenFromRail hides only the automations-host mode', () => {
  assert.equal(isHiddenFromRail({ mode: AUTOMATIONS_HOST_WORKSPACE_MODE }), true)
  for (const mode of VISIBLE_MODES) {
    assert.equal(isHiddenFromRail({ mode }), false, `expected ${mode} to stay visible in the rail`)
  }
})

run('predicates treat an unknown custom mode as a normal visible workspace', () => {
  assert.equal(isAutomationsHostWorkspace({ mode: 'custom-plugin-mode' }), false)
  assert.equal(isHiddenFromRail({ mode: 'custom-plugin-mode' }), false)
})
