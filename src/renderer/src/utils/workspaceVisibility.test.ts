import assert from 'node:assert/strict'
import {
  AUTOMATIONS_HOST_WORKSPACE_MODE,
  GUIDED_BRIEF_WORKSPACE_MODE,
  SPRINT_ENGINE_WORKSPACE_MODE,
  STANDARD_WORKSPACE_MODE,
  REVIEW_WORKSPACE_MODE,
  REVIEWS_HOST_WORKSPACE_MODE,
  type BundledWorkspaceMode,
} from '../types/workspace'
import { isModeHiddenFromRail } from '../../../shared/workspace-mode'
import { isAutomationsHostWorkspace, isHiddenFromRail, isSprintRunWorkspace } from './workspaceVisibility'

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
  // Sprint runs moved to the instance-level Sprints door (item 1767), which
  // lists every run from disk. Their workspaces stay as the residency for the
  // run's agent terminals, but never as a Projects-list row.
  [SPRINT_ENGINE_WORKSPACE_MODE]: true,
  [GUIDED_BRIEF_WORKSPACE_MODE]: false,
  // Automations moved to an instance-level surface (the sidebar door), so their
  // host workspaces are rail-hidden background runtime containers — never a
  // Projects-list row, switch target, or palette result.
  [AUTOMATIONS_HOST_WORKSPACE_MODE]: true,
  // A review workspace is a real project-scoped workspace, so it stays a rail
  // row — unlike the Reviews *host* below, which is the door's background
  // container in the same sense as the automations host.
  [REVIEW_WORKSPACE_MODE]: false,
  [REVIEWS_HOST_WORKSPACE_MODE]: true,
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

run('isSprintRunWorkspace is true only for the sprint-run mode', () => {
  for (const mode of BUNDLED_MODES) {
    assert.equal(
      isSprintRunWorkspace({ mode }),
      mode === SPRINT_ENGINE_WORKSPACE_MODE,
      `unexpected isSprintRunWorkspace for ${mode}`,
    )
  }
  // The Design Wizard is a sibling mode, not a run: it keeps its Projects row.
  assert.equal(isHiddenFromRail({ mode: GUIDED_BRIEF_WORKSPACE_MODE }), false)
})

// Item 1807: rail-hidden-ness is one rule in `shared/workspace-mode.ts` because
// main needs the same answer (the review guide's workspace fallback) and cannot
// import the renderer. These two must never be able to disagree.
run('the renderer predicate is the shared rule, over the same mode literals', () => {
  assert.equal(AUTOMATIONS_HOST_WORKSPACE_MODE, 'automations-host')
  assert.equal(SPRINT_ENGINE_WORKSPACE_MODE, 'sprintengine')
  for (const mode of [...BUNDLED_MODES, 'custom-plugin-mode']) {
    assert.equal(isModeHiddenFromRail(mode), isHiddenFromRail({ mode }), `shared rule differs for ${mode}`)
  }
})

run('predicates treat an unknown custom mode as a normal visible workspace', () => {
  assert.equal(isAutomationsHostWorkspace({ mode: 'custom-plugin-mode' }), false)
  assert.equal(isSprintRunWorkspace({ mode: 'custom-plugin-mode' }), false)
  assert.equal(isHiddenFromRail({ mode: 'custom-plugin-mode' }), false)
})
