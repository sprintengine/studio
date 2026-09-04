import assert from 'node:assert/strict'

import { classifyTurnBoundary, isWorkingPhase } from './checkpoint-turns'

// Turn boundaries from the hooks-authoritative phase
// (the-diff-an-agent-made / checkpoint-turn-reactor). Getting this wrong scopes
// every diff in the product to the wrong span, so it is pinned exhaustively.

let failures = 0
function run(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

run('work beginning opens a turn, from every resting phase', () => {
  for (const from of ['idle', 'awaiting_input', 'stalled', 'starting'] as const) {
    assert.equal(classifyTurnBoundary(from, 'thinking'), 'open', `${from} -> thinking`)
    assert.equal(classifyTurnBoundary(from, 'tool_use'), 'open', `${from} -> tool_use`)
  }
  // A session whose phase we have never seen: its first working frame opens.
  assert.equal(classifyTurnBoundary(undefined, 'thinking'), 'open')
  assert.equal(classifyTurnBoundary(null, 'tool_use'), 'open')
})

run('thinking <-> tool_use churn never re-opens the turn it is inside', () => {
  // The whole point: a baseline recaptured on every tool call would collapse
  // each turn's diff to its last step.
  assert.equal(classifyTurnBoundary('thinking', 'tool_use'), null)
  assert.equal(classifyTurnBoundary('tool_use', 'thinking'), null)
  assert.equal(classifyTurnBoundary('thinking', 'thinking'), null)
  assert.equal(classifyTurnBoundary('tool_use', 'tool_use'), null)
})

run('handing control back closes the turn', () => {
  for (const from of ['thinking', 'tool_use'] as const) {
    assert.equal(classifyTurnBoundary(from, 'idle'), 'close')
    assert.equal(classifyTurnBoundary(from, 'awaiting_input'), 'close')
    // A lost Stop frame lands a finished agent in `stalled`; without this the
    // turn would never close and never get its checkpoint.
    assert.equal(classifyTurnBoundary(from, 'stalled'), 'close')
  }
})

run('an agent dying mid-turn still closes it', () => {
  // The work it did before dying is exactly what someone will want to see, and
  // no later frame is coming to close the turn.
  assert.equal(classifyTurnBoundary('thinking', 'exited'), 'close')
  assert.equal(classifyTurnBoundary('tool_use', 'failed'), 'close')
  // A CLI restarting under us ends the turn it was in, too.
  assert.equal(classifyTurnBoundary('tool_use', 'starting'), 'close')
})

run('`starting` is a lifecycle stamp and opens nothing', () => {
  // Resuming a suspended terminal must capture nothing at all: this is the same
  // trap that made the sidebar working clock start on a resume.
  assert.equal(classifyTurnBoundary(undefined, 'starting'), null)
  assert.equal(classifyTurnBoundary('idle', 'starting'), null)
  assert.equal(classifyTurnBoundary('awaiting_input', 'starting'), null)
  assert.equal(isWorkingPhase('starting'), false)
})

run('moving between resting phases is not a boundary', () => {
  assert.equal(classifyTurnBoundary('idle', 'awaiting_input'), null)
  assert.equal(classifyTurnBoundary('awaiting_input', 'idle'), null)
  assert.equal(classifyTurnBoundary('idle', 'stalled'), null)
  assert.equal(classifyTurnBoundary('idle', 'exited'), null)
  assert.equal(classifyTurnBoundary('awaiting_input', 'failed'), null)
})

run('isWorkingPhase names exactly the two working phases', () => {
  assert.equal(isWorkingPhase('thinking'), true)
  assert.equal(isWorkingPhase('tool_use'), true)
  for (const phase of ['starting', 'idle', 'awaiting_input', 'stalled', 'exited', 'failed'] as const) {
    assert.equal(isWorkingPhase(phase), false, phase)
  }
  assert.equal(isWorkingPhase(undefined), false)
  assert.equal(isWorkingPhase(null), false)
})

if (failures > 0) {
  console.error(`checkpoint-turns.test.ts: ${failures} failing`)
  process.exit(1)
}
console.log('checkpoint-turns.test.ts: ok')
