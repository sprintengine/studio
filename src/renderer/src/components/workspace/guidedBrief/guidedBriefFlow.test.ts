import assert from 'node:assert/strict'
import {
  guidedBriefHandoffChecklist,
  guidedBriefPlanningDecisionNotes,
  guidedBriefPlanningValidationNotes,
  guidedBriefSprintEngineGoal,
} from './handoff'
import { joinWorkspacePath, basename } from './paths'
import { stripAnsiAndOverwrites } from './parseStream'
import {
  guidedBriefSkipToHandoffState,
  isMidStageGuidedRuntime,
  progressForStage,
  stepCounterLabel,
  type GuidedBriefRuntimeState,
} from './types'

const guidedDefaults = {
  guidedRoleCliDefaults: {
    product: 'codex' as const,
    architect: 'codex' as const,
    frontend: 'codex' as const,
  },
  buildRoleCounts: {
    architect: 1,
    product: 1,
    frontend: 1,
    developer: 1,
    code_reviewer: 1,
    spec_reviewer: 1,
    performance: 0,
    tester: 1,
    security: 0,
  },
  buildRoleCliDefaults: {
    architect: 'codex' as const,
    product: 'codex' as const,
    frontend: 'codex' as const,
    developer: 'codex' as const,
    code_reviewer: 'codex' as const,
    spec_reviewer: 'codex' as const,
    performance: 'codex' as const,
    tester: 'codex' as const,
    security: 'codex' as const,
  },
  buildCliPermissionPreset: 'default' as const,
  buildStartRunner: true,
  buildAutoApproveArtifacts: false,
}

assert.equal(joinWorkspacePath('/workspace', 'product', 'requirements.md'), '/workspace/product/requirements.md')
assert.equal(joinWorkspacePath('/workspace/', 'product'), '/workspace/product')
assert.equal(joinWorkspacePath('C:\\workspace', 'product', 'requirements.md'), 'C:\\workspace\\product\\requirements.md')
assert.equal(basename('/workspace/my-folder'), 'my-folder')
assert.equal(basename('C:\\workspace\\my-folder'), 'my-folder')

const strategistWorkingHasUi = progressForStage('strategist-working', 'yes')
assert.equal(strategistWorkingHasUi.total, 4)
assert.equal(strategistWorkingHasUi.active, 1)
assert.equal(strategistWorkingHasUi.done, 1)

const strategistReadyHasUi = progressForStage('strategist-ready', 'yes')
assert.equal(strategistReadyHasUi.active, 1, 'ready stays on the same active dash as working')

const designerWorkingHasUi = progressForStage('designer-working', 'yes')
assert.equal(designerWorkingHasUi.active, 2)

const handoffHasUi = progressForStage('handoff', 'yes')
assert.equal(handoffHasUi.active, 3)

const architectWorkingHasUi = progressForStage('architect-working', 'yes', {
  wantsProductDiscussion: true,
  wantsArchitectureDiscussion: true,
  wantsFrontendDiscussion: true,
})
assert.equal(architectWorkingHasUi.total, 5, 'architecture adds one progress dash')
assert.equal(architectWorkingHasUi.active, 2)
assert.match(
  stepCounterLabel('architect-ready', 'yes', {
    wantsProductDiscussion: true,
    wantsArchitectureDiscussion: true,
    wantsFrontendDiscussion: true,
  }),
  /Step 3 of 5 · plan ready/,
)

const strategistWorkingNoUi = progressForStage('strategist-working', 'no')
assert.equal(strategistWorkingNoUi.total, 3, 'no-UI flow has three progress dashes')
assert.equal(strategistWorkingNoUi.active, 1)

const handoffNoUi = progressForStage('handoff', 'no')
assert.equal(handoffNoUi.active, 2, 'handoff is the second active dash in the no-UI flow')

assert.match(stepCounterLabel('strategist-working', 'yes'), /Step 2 of 4 · strategist working/)
assert.match(stepCounterLabel('strategist-ready', 'yes'), /Step 2 of 4 · brief ready/)
assert.match(stepCounterLabel('handoff', 'no'), /Step 3 of 3 · handoff/)

// Designer stage transitions: working and ready share the third dash in the
// has-UI flow, handoff moves to the fourth. In the no-UI flow designer is
// entirely skipped, so handoff sits on dash 2 of 3.
const designerReady = progressForStage('designer-ready', 'yes')
assert.equal(designerReady.total, 4)
assert.equal(designerReady.active, 2, 'designer-ready stays on the designer dash')

const handoffYes = progressForStage('handoff', 'yes')
assert.equal(handoffYes.active, 3, 'handoff is the fourth dash when there is a UI')

const designerWorkingNoUi = progressForStage('designer-working', 'no')
assert.equal(designerWorkingNoUi.total, 3, 'no-UI never grows past three dashes')
assert.equal(designerWorkingNoUi.active, 2, 'designer stage in a no-UI run is treated as handoff territory')

assert.match(stepCounterLabel('designer-working', 'yes'), /Step 3 of 4 · designer working/)
assert.match(stepCounterLabel('designer-ready', 'yes'), /Step 3 of 4 · mockups ready/)

const hasUiChecklist = guidedBriefHandoffChecklist({
  ...guidedDefaults,
  workspaceRoot: '/workspace',
  workspaceName: 'Workspace',
  idea: 'Build a dashboard.',
  hasUi: 'yes',
  wantsProductDiscussion: true,
  wantsArchitectureDiscussion: true,
  wantsFrontendDiscussion: true,
  stage: 'handoff',
  acceptedProductBrief: { kind: 'product', title: 'Product brief', path: 'product/.versions/brief.md', hash: 'briefhash' },
  acceptedArchitecturePlan: { kind: 'product', title: 'Architecture plan', path: 'product/.versions/plan.md', hash: 'planhash' },
  acceptedUiDirection: { kind: 'product', title: 'UI direction', path: 'product/.versions/ui.md', hash: 'uihash' },
  acceptedMockups: [{ kind: 'mockup', title: 'Dashboard', path: 'mockups/.versions/app.html', hash: 'mockhash' }],
  activeMockupPath: 'mockups/app.html',
  strategistSessionId: null,
  architectSessionId: null,
  designerSessionId: null,
})
assert.deepEqual(
  hasUiChecklist.map((item) => item.label),
  ['Accepted brief', 'Architecture plan', 'UI direction', 'Dashboard', 'Build handoff'],
  'has-UI handoff lists brief, architecture plan, UI direction, mockups, and build handoff',
)

const noUiChecklist = guidedBriefHandoffChecklist({
  ...guidedDefaults,
  workspaceRoot: '/workspace',
  workspaceName: 'Workspace',
  idea: 'Build a service.',
  hasUi: 'no',
  wantsProductDiscussion: true,
  wantsArchitectureDiscussion: false,
  wantsFrontendDiscussion: false,
  stage: 'handoff',
  acceptedProductBrief: { kind: 'product', title: 'Product brief', path: 'product/.versions/brief.md', hash: 'briefhash' },
  acceptedArchitecturePlan: null,
  acceptedUiDirection: null,
  acceptedMockups: [{ kind: 'mockup', title: 'Ignored', path: 'mockups/.versions/app.html', hash: 'mockhash' }],
  activeMockupPath: null,
  strategistSessionId: null,
  architectSessionId: null,
  designerSessionId: null,
})
assert.deepEqual(
  noUiChecklist.map((item) => item.label),
  ['Accepted brief', 'Build handoff'],
  'no-UI handoff only lists brief and build handoff',
)

assert.equal(
  guidedBriefSprintEngineGoal('## Suggested Sprint Engine Goal\n\nShip the accepted build.\n\n## Risks\n\n- None', 'yes'),
  'Ship the accepted build.',
)

// stripAnsiAndOverwrites is the only parseStream export kept after the
// composer/transcript was removed — sessionAdapter still uses it for marker
// detection on the raw terminal stream.
assert.equal(
  stripAnsiAndOverwrites('\x1b[31mhello\x1b[0m world'),
  'hello world',
  'ANSI colour codes are stripped',
)
assert.equal(
  stripAnsiAndOverwrites('progress 1/3\rprogress 3/3'),
  'progress 3/3',
  'carriage-return overwrites collapse to the last write',
)
assert.equal(
  stripAnsiAndOverwrites('first\nsecond\n'),
  'first\nsecond\n',
  'real line breaks are preserved',
)
assert.equal(
  stripAnsiAndOverwrites('\x1b]0;Title\x07hi'),
  'hi',
  'OSC sequences (window title etc.) are stripped',
)
assert.equal(
  stripAnsiAndOverwrites('plain text \x07with bell'),
  'plain text with bell',
  'control characters are removed',
)

// Mid-stage close gate: confirmation should fire only after the strategist
// session has been launched and before the build is handed off. Idle state
// and the no-runtime case keep the pre-runtime close behaviour intact.
const baseRuntime: GuidedBriefRuntimeState = {
  ...guidedDefaults,
  workspaceRoot: '/workspace',
  workspaceName: 'Workspace',
  idea: 'Build something.',
  hasUi: 'yes',
  wantsProductDiscussion: true,
  wantsArchitectureDiscussion: false,
  wantsFrontendDiscussion: true,
  stage: 'strategist-working',
  acceptedProductBrief: null,
  acceptedArchitecturePlan: null,
  acceptedUiDirection: null,
  acceptedMockups: [],
  activeMockupPath: null,
  strategistSessionId: null,
  architectSessionId: null,
  designerSessionId: null,
}

assert.equal(isMidStageGuidedRuntime(null), false, 'no runtime → no confirmation')
assert.equal(isMidStageGuidedRuntime(baseRuntime), true, 'strategist-working triggers confirmation')
assert.equal(isMidStageGuidedRuntime({ ...baseRuntime, stage: 'strategist-ready' }), true)
assert.equal(isMidStageGuidedRuntime({ ...baseRuntime, stage: 'architect-working' }), true)
assert.equal(isMidStageGuidedRuntime({ ...baseRuntime, stage: 'architect-ready' }), true)
assert.equal(isMidStageGuidedRuntime({ ...baseRuntime, stage: 'designer-working' }), true)
assert.equal(isMidStageGuidedRuntime({ ...baseRuntime, stage: 'designer-ready' }), true)
assert.equal(isMidStageGuidedRuntime({ ...baseRuntime, stage: 'handoff' }), true, 'handoff confirms until Start the build')

const skippedRuntime = guidedBriefSkipToHandoffState({
  ...baseRuntime,
  strategistSessionId: 'strategist-session',
  designerSessionId: 'designer-session',
})
assert.equal(skippedRuntime.stage, 'handoff', 'skip moves directly to handoff/roster')
assert.equal(skippedRuntime.wantsProductDiscussion, false, 'unaccepted product stage no longer blocks Start the build')
assert.equal(skippedRuntime.wantsArchitectureDiscussion, false, 'unaccepted architecture stage no longer blocks Start the build')
assert.equal(skippedRuntime.wantsFrontendDiscussion, false, 'unaccepted frontend stage no longer requires mockups')
assert.equal(skippedRuntime.strategistSessionId, null, 'skip detaches the strategist PTY')
assert.equal(skippedRuntime.designerSessionId, null, 'skip detaches the designer PTY')
assert.deepEqual(
  guidedBriefPlanningDecisionNotes(skippedRuntime),
  [
    'Application includes a visual UI.',
    'Product strategy discussion was not requested or was skipped before roster selection.',
    'Architecture discussion was not requested or was skipped before roster selection.',
    'Frontend design and mockup discussion was not requested or was skipped before roster selection.',
  ],
)
assert.deepEqual(
  guidedBriefPlanningValidationNotes(skippedRuntime),
  [
    'Validate implementation against any accepted Guided brief artifact snapshot hashes.',
    'Resolve missing product or architecture decisions before broad implementation work.',
    'Create or validate UI direction during Sprint Engine planning because the guided frontend stage was skipped.',
  ],
)

const skippedAfterBrief = guidedBriefSkipToHandoffState({
  ...baseRuntime,
  acceptedProductBrief: { kind: 'product', title: 'Product brief', path: 'product/.versions/brief.md', hash: 'briefhash' },
})
assert.equal(skippedAfterBrief.wantsProductDiscussion, true, 'accepted product brief remains required and available')
assert.equal(skippedAfterBrief.wantsFrontendDiscussion, false, 'missing frontend artifacts are still treated as skipped')
