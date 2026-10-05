import assert from 'node:assert/strict'
import { test } from 'vitest'

import { VISIT_STAMP_INTERVAL_MS, visitStampDue } from './useVisitStamp'

test('a chat this window has not stamped is stamped as soon as it is in front', () => {
  assert.equal(visitStampDue({ now: 1_000, stampedAt: null, turnEndedAt: null, visitedAt: 900 }), true)
})

test('a chat stamped a moment ago waits out the interval', () => {
  assert.equal(visitStampDue({ now: 5_000, stampedAt: 1_000, turnEndedAt: 500, visitedAt: 1_000 }), false)
  assert.equal(
    visitStampDue({ now: 1_000 + VISIT_STAMP_INTERVAL_MS, stampedAt: 1_000, turnEndedAt: 500, visitedAt: 1_000 }),
    true,
  )
})

test('a finish newer than the last visit is stamped at once, interval or not', () => {
  assert.equal(visitStampDue({ now: 2_000, stampedAt: 1_000, turnEndedAt: 1_500, visitedAt: 1_000 }), true)
})

test('a finish this window already stamped past is not stamped again early', () => {
  // The machine keeping the clock has not answered with the new visit yet.
  assert.equal(visitStampDue({ now: 2_000, stampedAt: 1_800, turnEndedAt: 1_500, visitedAt: 1_000 }), false)
})
