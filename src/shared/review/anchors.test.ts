import assert from 'node:assert/strict'
import {
  isAnchorWithinExtent,
  shiftAnchor,
  validateAnchor,
  type ReviewAnchor,
} from './anchors'

const tests: Array<{ name: string; body: () => void }> = []
function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

function anchorErrors(value: unknown): string[] {
  const errors: string[] = []
  validateAnchor(value, 'anchor', errors)
  return errors
}

run('validateAnchor accepts a well-formed anchor', () => {
  assert.deepEqual(anchorErrors({ side: 'new', startLine: 3, endLine: 5 }), [])
  assert.deepEqual(anchorErrors({ side: 'old', startLine: 1, endLine: 1, anchoredAtSha: 'abc' }), [])
})

run('validateAnchor rejects a non-positive or non-integer line', () => {
  assert.match(anchorErrors({ side: 'new', startLine: 0, endLine: 2 }).join('\n'), /anchor\.startLine/)
  assert.match(anchorErrors({ side: 'new', startLine: 1.5, endLine: 2 }).join('\n'), /anchor\.startLine/)
})

run('validateAnchor rejects endLine before startLine', () => {
  assert.match(anchorErrors({ side: 'new', startLine: 9, endLine: 4 }).join('\n'), /endLine.*startLine/)
})

run('validateAnchor rejects an unknown side, naming the value', () => {
  assert.match(anchorErrors({ side: 'left', startLine: 1, endLine: 2 }).join('\n'), /anchor\.side has unknown value "left"/)
})

run('isAnchorWithinExtent bounds the whole span', () => {
  const anchor: ReviewAnchor = { side: 'new', startLine: 3, endLine: 5 }
  assert.ok(isAnchorWithinExtent(anchor, { min: 1, max: 10 }))
  assert.ok(!isAnchorWithinExtent(anchor, { min: 1, max: 4 }))
  assert.ok(!isAnchorWithinExtent(anchor, { min: 4, max: 10 }))
})

run('shiftAnchor shifts a span sitting after an edit', () => {
  const shifted = shiftAnchor({ side: 'new', startLine: 5, endLine: 7 }, [{ start: 1, removed: 2, added: 4 }])
  assert.deepEqual(shifted, { side: 'new', startLine: 7, endLine: 9 })
})

run('shiftAnchor leaves a span before the edit untouched', () => {
  const shifted = shiftAnchor({ side: 'new', startLine: 5, endLine: 7 }, [{ start: 20, removed: 1, added: 5 }])
  assert.deepEqual(shifted, { side: 'new', startLine: 5, endLine: 7 })
})

run('shiftAnchor grows the end when lines are inserted inside the span', () => {
  const shifted = shiftAnchor({ side: 'new', startLine: 5, endLine: 10 }, [{ start: 7, removed: 1, added: 3 }])
  assert.deepEqual(shifted, { side: 'new', startLine: 5, endLine: 12 })
})

run('shiftAnchor returns null when the span is deleted outright', () => {
  const shifted = shiftAnchor({ side: 'new', startLine: 5, endLine: 7 }, [{ start: 4, removed: 6, added: 0 }])
  assert.equal(shifted, null)
})

run('shiftAnchor is order-independent across deltas', () => {
  const deltas = [
    { start: 30, removed: 0, added: 2 },
    { start: 1, removed: 0, added: 3 },
  ]
  const shifted = shiftAnchor({ side: 'new', startLine: 5, endLine: 7 }, deltas)
  // Only the leading insertion (+3) precedes the span.
  assert.deepEqual(shifted, { side: 'new', startLine: 8, endLine: 10 })
})

function main(): void {
  for (const test of tests) {
    try {
      test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      console.error(`not ok - ${test.name}`)
      throw error
    }
  }
  console.log('anchors.test.ts: ok')
}

main()
