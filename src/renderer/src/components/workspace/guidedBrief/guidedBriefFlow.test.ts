import assert from 'node:assert/strict'
import { guidedBriefHandoffChecklist, guidedBriefSprintEngineGoal } from './handoff'
import { joinWorkspacePath, basename } from './paths'
import {
  appendSpecChunk,
  appendUserTurn,
  stripAnsiAndOverwrites,
  type ConversationTurn,
} from './parseStream'
import {
  isMidStageGuidedRuntime,
  progressForStage,
  stepCounterLabel,
  type GuidedBriefRuntimeState,
} from './types'

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
  workspaceRoot: '/workspace',
  workspaceName: 'Workspace',
  idea: 'Build a dashboard.',
  hasUi: 'yes',
  stage: 'handoff',
  acceptedProductBrief: { kind: 'product', title: 'Product brief', path: 'product/.versions/brief.md', hash: 'briefhash' },
  acceptedUiDirection: { kind: 'product', title: 'UI direction', path: 'product/.versions/ui.md', hash: 'uihash' },
  acceptedMockups: [{ kind: 'mockup', title: 'Dashboard', path: 'mockups/.versions/app.html', hash: 'mockhash' }],
  activeMockupPath: 'mockups/app.html',
})
assert.deepEqual(
  hasUiChecklist.map((item) => item.label),
  ['Accepted brief', 'UI direction', 'Dashboard', 'Build handoff'],
  'has-UI handoff lists brief, UI direction, mockups, and build handoff',
)

const noUiChecklist = guidedBriefHandoffChecklist({
  workspaceRoot: '/workspace',
  workspaceName: 'Workspace',
  idea: 'Build a service.',
  hasUi: 'no',
  stage: 'handoff',
  acceptedProductBrief: { kind: 'product', title: 'Product brief', path: 'product/.versions/brief.md', hash: 'briefhash' },
  acceptedUiDirection: null,
  acceptedMockups: [{ kind: 'mockup', title: 'Ignored', path: 'mockups/.versions/app.html', hash: 'mockhash' }],
  activeMockupPath: null,
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

// Parsed conversation: strip ANSI escape sequences, collapse \r overwrites,
// drop control characters that would render as garbage in a plain-English view.
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

let counter = 0
const nextSpecId = () => {
  counter += 1
  return `spec-${counter}`
}
const nextUserId = () => {
  counter += 1
  return `user-${counter}`
}

let turns: ConversationTurn[] = []
turns = appendSpecChunk({
  chunk: '\x1b[32mStrategist: tell me about your idea\x1b[0m\n',
  turns,
  now: 1,
  nextSpecTurnId: nextSpecId,
})
assert.equal(turns.length, 1, 'first chunk creates a spec turn')
assert.equal(turns[0].speaker, 'spec')
assert.equal(turns[0].content, 'Strategist: tell me about your idea\n')

turns = appendSpecChunk({
  chunk: 'follow-up question?\n',
  turns,
  now: 2,
  nextSpecTurnId: nextSpecId,
})
assert.equal(turns.length, 1, 'consecutive spec chunks merge into the same turn')
assert.equal(turns[0].content, 'Strategist: tell me about your idea\nfollow-up question?\n')

turns = appendUserTurn({
  message: 'I want to swap shifts at my cafe.',
  turns,
  now: 3,
  nextUserTurnId: nextUserId,
})
assert.equal(turns.length, 2, 'user send opens a new turn')
assert.equal(turns[1].speaker, 'user')
assert.equal(turns[1].content, 'I want to swap shifts at my cafe.')

turns = appendSpecChunk({
  chunk: 'Got it. Who approves swaps today?\n',
  turns,
  now: 4,
  nextSpecTurnId: nextSpecId,
})
assert.equal(turns.length, 3, 'the next spec chunk after a user turn opens a fresh spec turn')
assert.equal(turns[2].speaker, 'spec')

const emptyAfterStrip = appendSpecChunk({
  chunk: '\x1b[2J\x1b[H',
  turns,
  now: 5,
  nextSpecTurnId: nextSpecId,
})
assert.strictEqual(emptyAfterStrip, turns, 'a chunk that strips to empty does not mutate the turn list')

const emptyUserTurn = appendUserTurn({
  message: '   ',
  turns,
  now: 6,
  nextUserTurnId: nextUserId,
})
assert.strictEqual(emptyUserTurn, turns, 'whitespace-only user sends do not create a turn')

// Mid-stage close gate: confirmation should fire only after the strategist
// session has been launched and before the build is handed off. Idle state
// and the no-runtime case keep the pre-runtime close behaviour intact.
const baseRuntime: GuidedBriefRuntimeState = {
  workspaceRoot: '/workspace',
  workspaceName: 'Workspace',
  idea: 'Build something.',
  hasUi: 'yes',
  stage: 'strategist-working',
  acceptedProductBrief: null,
  acceptedUiDirection: null,
  acceptedMockups: [],
  activeMockupPath: null,
}

assert.equal(isMidStageGuidedRuntime(null), false, 'no runtime → no confirmation')
assert.equal(isMidStageGuidedRuntime(baseRuntime), true, 'strategist-working triggers confirmation')
assert.equal(isMidStageGuidedRuntime({ ...baseRuntime, stage: 'strategist-ready' }), true)
assert.equal(isMidStageGuidedRuntime({ ...baseRuntime, stage: 'designer-working' }), true)
assert.equal(isMidStageGuidedRuntime({ ...baseRuntime, stage: 'designer-ready' }), true)
assert.equal(isMidStageGuidedRuntime({ ...baseRuntime, stage: 'handoff' }), true, 'handoff confirms until Start the build')
