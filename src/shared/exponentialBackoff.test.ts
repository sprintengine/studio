import assert from 'node:assert/strict'
import { backoffDelayMs } from './exponentialBackoff'

const MIN = 60_000

// The PR merge-poll schedule: 1 → 2 → 4 → 8 → 16 → 32 min, then stop. This is the
// exact sequence the pull-request poll supervisor arms with.
const prBackoff = { baseMs: MIN, factor: 2, maxMs: 32 * MIN, stopAtMax: true }
const prSequence = [0, 1, 2, 3, 4, 5, 6].map((n) => backoffDelayMs(n, prBackoff))
assert.deepEqual(prSequence, [MIN, 2 * MIN, 4 * MIN, 8 * MIN, 16 * MIN, 32 * MIN, null])

// The cap delay itself is included (raw === maxMs is not "exceeded").
assert.equal(backoffDelayMs(5, prBackoff), 32 * MIN)
// One past the cap exhausts the schedule.
assert.equal(backoffDelayMs(6, prBackoff), null)
// Every attempt beyond exhaustion stays null.
assert.equal(backoffDelayMs(20, prBackoff), null)

// A non-stopping schedule clamps to the cap and holds there forever.
const holding = { baseMs: MIN, factor: 2, maxMs: 32 * MIN }
assert.equal(backoffDelayMs(5, holding), 32 * MIN)
assert.equal(backoffDelayMs(6, holding), 32 * MIN)
assert.equal(backoffDelayMs(100, holding), 32 * MIN)

// A cap that falls between powers stops as soon as the raw delay exceeds it,
// never emitting a delay above the cap.
const oddCap = { baseMs: MIN, factor: 2, maxMs: 30 * MIN, stopAtMax: true }
assert.equal(backoffDelayMs(4, oddCap), 16 * MIN) // ≤ 30
assert.equal(backoffDelayMs(5, oddCap), null) // 32 > 30

// Non-doubling factors work too.
const triple = { baseMs: 1000, factor: 3, maxMs: 100_000 }
assert.deepEqual(
  [0, 1, 2, 3].map((n) => backoffDelayMs(n, triple)),
  [1000, 3000, 9000, 27_000],
)

// Guards: negative and non-integer attempts return null.
assert.equal(backoffDelayMs(-1, prBackoff), null)
assert.equal(backoffDelayMs(1.5, prBackoff), null)

console.log('exponentialBackoff: all assertions passed')
