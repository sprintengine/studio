import assert from 'node:assert/strict'

import { STEPS_BY_MODE } from './creationStepFlows'
import type { StepId } from './creationStepFlows'
import {
  isLastStepIn,
  jumpTargetFor,
  nextStepFrom,
  previousStepFrom,
  shouldShowSkipToCreate,
  stepIndexIn,
  stepWithinFlow,
} from './stepNavigation'

// The hub pages a flow one step at a time. These are the page-turn decisions the
// footer and the progress bar make; the panel owns the `step` state, so a break
// here is invisible to every other test in the tree.

// The sprint flow is the long one — four pages — so it exercises every move.
const SPRINT = STEPS_BY_MODE.sprintengine
assert.deepEqual(SPRINT, ['workspace', 'sprintengine-team', 'sprintengine-roster', 'sprintengine-run'])

function ready(
  step: StepId,
  over: { busy?: boolean; currentStepReady?: boolean } = {},
): { steps: readonly StepId[]; step: StepId; busy: boolean; currentStepReady: boolean } {
  return {
    steps: SPRINT,
    step,
    busy: over.busy ?? false,
    currentStepReady: over.currentStepReady ?? true,
  }
}

// --- Continue advances -------------------------------------------------------

// Walked end to end, Continue visits every page in flow order and then stops:
// the last page's primary action is create, not another page turn.
{
  const walked: StepId[] = ['workspace']
  let step: StepId = 'workspace'
  for (;;) {
    const next = nextStepFrom(ready(step))
    if (!next) break
    walked.push(next)
    step = next
  }
  assert.deepEqual(walked, [...SPRINT], 'Continue walks the whole sprint flow, in order')
  assert.equal(nextStepFrom(ready('sprintengine-run')), null, 'the last page has no Continue')
  assert.ok(isLastStepIn(SPRINT, 'sprintengine-run'), 'the run page is the last page')
  assert.ok(!isLastStepIn(SPRINT, 'sprintengine-roster'), 'the roster page is not')
}

// Continue is gated on the page you are ON — not on the whole flow. An unanswered
// page refuses to advance even though later pages are all defaulted.
assert.equal(
  nextStepFrom(ready('sprintengine-team', { currentStepReady: false })),
  null,
  'Continue refuses to leave an unanswered page',
)

// Mid-create, the flow freezes: the deferred create reads the state of the page
// the user confirmed on, so a page turn under it would create something else.
assert.equal(nextStepFrom(ready('workspace', { busy: true })), null, 'Continue is frozen mid-create')

// --- Back returns ------------------------------------------------------------

assert.equal(previousStepFrom(ready('sprintengine-run')), 'sprintengine-roster', 'Back returns one page')
assert.equal(previousStepFrom(ready('sprintengine-team')), 'workspace', 'Back reaches the first page')
assert.equal(previousStepFrom(ready('workspace')), null, 'the first page has no Back')
assert.equal(previousStepFrom(ready('sprintengine-run', { busy: true })), null, 'Back is frozen mid-create')

// Back is never gated on readiness: a page you cannot answer is exactly the one
// you need to retreat out of (e.g. to re-pick the folder its content depends on).
assert.equal(
  previousStepFrom({ steps: SPRINT, step: 'sprintengine-team', busy: false }),
  'workspace',
  'Back works out of an unanswered page',
)

// Continue then Back is a round trip — the pair are inverses, page by page.
for (let index = 0; index < SPRINT.length - 1; index += 1) {
  const forward = nextStepFrom(ready(SPRINT[index]))
  assert.equal(forward, SPRINT[index + 1])
  assert.equal(previousStepFrom(ready(forward as StepId)), SPRINT[index], 'Back undoes Continue')
}

// --- jumpToStep refuses forward jumps ----------------------------------------

// The progress bar is a back-jump affordance only. A forward jump would skip the
// gate the page it jumps over holds — the whole point of Continue's readiness
// check — so every index at or ahead of the current page is refused.
{
  const flow = { steps: SPRINT, step: 'sprintengine-roster' as StepId, busy: false } // index 2
  assert.equal(jumpTargetFor(flow, 0), 'workspace', 'jump back to the first page')
  assert.equal(jumpTargetFor(flow, 1), 'sprintengine-team', 'jump back one page')
  assert.equal(jumpTargetFor(flow, 2), null, 'the current page is not a jump')
  assert.equal(jumpTargetFor(flow, 3), null, 'a forward jump is refused')
  assert.equal(jumpTargetFor(flow, -1), null, 'a negative index is refused')
  assert.equal(jumpTargetFor(flow, 99), null, 'an out-of-range index is refused')
  assert.equal(jumpTargetFor({ ...flow, busy: true }, 0), null, 'jumps are frozen mid-create')

  // From the first page there is nowhere to jump at all.
  assert.equal(jumpTargetFor({ steps: SPRINT, step: 'workspace', busy: false }, 0), null)
}

// A forward jump stays refused even when every page ahead is ready: readiness is
// not the reason — an un-walked page is.
for (let index = 0; index < SPRINT.length; index += 1) {
  const flow = { steps: SPRINT, step: SPRINT[index], busy: false }
  for (let target = index; target < SPRINT.length; target += 1) {
    assert.equal(jumpTargetFor(flow, target), null, `no jump from ${SPRINT[index]} to ${SPRINT[target]}`)
  }
}

// --- "Skip the rest and create" ----------------------------------------------

// Shown exactly when create is unblocked and pages remain. On the last page the
// primary action already IS create, and while the flow is blocked there is
// nothing to skip TO.
assert.equal(shouldShowSkipToCreate({ createReady: true, isLastStep: false }), true, 'offered mid-flow once create is ready')
assert.equal(shouldShowSkipToCreate({ createReady: true, isLastStep: true }), false, 'withheld on the last page')
assert.equal(shouldShowSkipToCreate({ createReady: false, isLastStep: false }), false, 'withheld while create is blocked')
assert.equal(shouldShowSkipToCreate({ createReady: false, isLastStep: true }), false, 'withheld when blocked on the last page')

// The affordance the item promises: with the sprint's intent page (the team)
// answered, skip is on offer from the team page onward — but never on the run
// page, which is where create lives.
for (const step of SPRINT) {
  assert.equal(
    shouldShowSkipToCreate({ createReady: true, isLastStep: isLastStepIn(SPRINT, step) }),
    step !== 'sprintengine-run',
    `skip-to-create on ${step}`,
  )
}

// --- Flow changes under the user ---------------------------------------------

// A rail switch (or the knowledge step dropping out) changes the flow. A page
// that survives the change is kept; one that does not falls back to the flow's
// first page rather than stranding the user on a page the new type has no render
// for.
assert.equal(stepWithinFlow(SPRINT, 'sprintengine-roster'), 'sprintengine-roster', 'a surviving page is kept')
assert.equal(
  stepWithinFlow(STEPS_BY_MODE.standard, 'sprintengine-roster'),
  'workspace',
  'a page the new flow does not have falls back to its first page',
)
assert.equal(stepWithinFlow(STEPS_BY_MODE.switchboard, 'workspace'), 'workspace', 'a one-page flow stays put')

// A step outside the flow reads as page 0, so a stale step can never index past
// the flow's end and hand Continue an undefined page.
assert.equal(stepIndexIn(SPRINT, 'guided-idea'), 0, 'an unknown step reads as the first page')
assert.equal(nextStepFrom(ready('guided-idea')), 'sprintengine-team', 'and advances from there, not off the end')

console.log('stepNavigation.test.ts: ok')
