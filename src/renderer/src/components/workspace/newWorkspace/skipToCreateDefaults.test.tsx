import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { STEPS_BY_MODE } from './creationStepFlows'
import { shouldShowSkipToCreate } from './stepNavigation'

// "Skip the rest and create" promises that skipping produces exactly what
// walking the remaining pages and changing nothing would have produced. The
// sprint flow — the only flow with defaulted refinement pages after its intent
// page — left with MC-2062 (sprint creation is the New sprint dialog), so the
// promise now holds STRUCTURALLY: in the reduced flow set there is never an
// answerable page with defaulted pages behind it, so the affordance has nothing
// it could skip. This suite pins that structure and the panel wiring it rests
// on, so a future flow that grows a post-intent page re-enters the old proof
// obligations deliberately rather than silently.

const PANEL_PATH = join(process.cwd(), 'src/renderer/src/components/workspace/NewWorkspacePanel.tsx')
const HERE = join(process.cwd(), 'src/renderer/src/components/workspace/newWorkspace')
const panelSource = readFileSync(PANEL_PATH, 'utf8')
const rosterEditorSource = readFileSync(join(HERE, 'useRosterEditor.ts'), 'utf8')

// ---------------------------------------------------------------------------
// The reduced flow set: every flow is the shared fields alone, or the shared
// fields plus one intent page. Nothing sits after an intent page, so a skip
// could never leave a page — answered or defaulted — unseen.
// ---------------------------------------------------------------------------

const INTENT_STEPS = ['guided-idea'] as const
for (const [flowId, steps] of Object.entries(STEPS_BY_MODE)) {
  assert.equal(steps[0], 'workspace', `${flowId} leads with the shared fields`)
  const rest = steps.slice(1)
  assert.ok(rest.length <= 1, `${flowId} carries at most one config page`)
  for (const step of rest) {
    assert.ok(
      (INTENT_STEPS as readonly string[]).includes(step),
      `${flowId}: '${step}' must be an intent page — a defaulted refinement page would revive the skip-parity proof this suite retired`,
    )
  }
}

// ---------------------------------------------------------------------------
// Why the affordance cannot appear: create gates on EVERY step's readiness
// (the panel's requiredStepIds), an intent page is never ready before it is
// answered, and the intent page is the last page — where the skip control is
// withheld because the primary action already IS create.
// ---------------------------------------------------------------------------

assert.match(
  panelSource,
  /const requiredStepIds: StepId\[\] = \['workspace', \.\.\.configSteps\]/,
  'create gates on the whole flow, so a blocked intent page blocks skip too',
)
assert.match(
  panelSource,
  /const createReady = !isChat && firstBlockedStepId == null/,
  'createReady is the every-step gate the skip affordance reads',
)
assert.equal(
  shouldShowSkipToCreate({ createReady: true, isLastStep: true }),
  false,
  'on the last page — where the intent page lives — skip is withheld',
)

// The sprint wizard's pages, state, and create paths are gone from the panel
// (MC-2062): no sprint step renders, no sprint create branch remains. The rail
// row survives by handing off to the New sprint dialog.
assert.doesNotMatch(panelSource, /sprintengine-(team|roster|tools|start)/, 'no sprint page renders in the hub')
assert.doesNotMatch(panelSource, /runSprintEngineNewTeamCreation|runSprintEnginePlanSourcedCreation|buildSprintEngineExistingTeamCreation/, 'no sprint create path remains in the hub')
assert.match(panelSource, /onOpenNewSprintDialog\(folderPath\)/, 'the rail Sprint row hands off to the New sprint dialog')

// And the panel keeps no roster-editing state of its own — the roster editor
// hook owns it (MC-1879), now consumed here only for the Guided Brief handoff.
for (const [what, pattern] of [
  ['no roster counts state', /useState<SprintEngineRoleCounts>/],
  ['no specialist-roles axis', /setSeUseSpecialistRoles/],
  ['no role registry state', /setSeRoleRegistry\(/],
] as const) {
  assert.doesNotMatch(panelSource, pattern, `panel kept no duplicate: ${what}`)
}

// ---------------------------------------------------------------------------
// The roster defaults the hub still ships (the Guided Brief build roster, and
// the New sprint dialog through the same hook) are established once at mount,
// from the resolved roster — not seeded by a page render that a skip (or the
// dialog's lighter surface) might never perform. Same pins as before MC-2062,
// repointed at their surviving consumer.
// ---------------------------------------------------------------------------

for (const [what, pattern] of [
  ['the roster is seeded from the resolved initial roster', /useState<SprintEngineRoleCounts>\(\s*\(\) => cloneRoleCounts\(initial\.roleCounts\),/],
  ['the resolved roster is itself computed once, at mount', /const \[initial\] = useState\(\(\) => resolveInitialSprintEngineRoster\(\{/],
  ['the selection axis opens from the resolved roster', /useState<string \| null>\(\(\) => initial\.selectedRosterId\)/],
  ['plain-agents runs default to 2 agents, roster runs to 3', /const \[poolAgentCount, setPoolAgentCount\] = useState\(\s*\(\) => \(isNoRolesRosterRef\(initial\.selectedRosterId\) \? 2 : 3\),\s*\)/],
] as const) {
  assert.match(rosterEditorSource, pattern, `roster editor default: ${what}`)
}
// MC-2064 deleted the roster `mode` formation axis; nothing may quietly grow it
// back in either home.
for (const [file, source] of [['NewWorkspacePanel.tsx', panelSource], ['useRosterEditor.ts', rosterEditorSource]] as const) {
  assert.doesNotMatch(source, /rosterMode|SprintEngineRosterMode|useSpecialistRoles/, `${file} carries no formation axis`)
}

console.log('skipToCreateDefaults.test.tsx: ok')
