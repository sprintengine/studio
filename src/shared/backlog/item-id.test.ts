import assert from 'node:assert/strict'
import {
  allocateNextBacklogId,
  deriveDefaultBacklogKey,
  findDuplicateBacklogIds,
  formatBacklogDisplayId,
  formatBacklogNumericId,
  isValidBacklogKey,
  parseBacklogNumericId,
  planBacklogIdAllocation,
} from './item-id'

const tests: Array<{ name: string; body: () => void }> = []

function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

run('parseBacklogNumericId reads bare integers and prefixed forms', () => {
  assert.equal(parseBacklogNumericId('240'), 240)
  assert.equal(parseBacklogNumericId(240), 240)
  assert.equal(parseBacklogNumericId(' 7 '), 7)
  // Tolerant of a prefixed id (a hand-written MC-240, a #240, or an external key)
  assert.equal(parseBacklogNumericId('MC-240'), 240)
  assert.equal(parseBacklogNumericId('#240'), 240)
  assert.equal(parseBacklogNumericId('PROJ-1234'), 1234)
})

run('parseBacklogNumericId rejects absent / non-positive / non-numeric', () => {
  assert.equal(parseBacklogNumericId(undefined), undefined)
  assert.equal(parseBacklogNumericId(null), undefined)
  assert.equal(parseBacklogNumericId(''), undefined)
  assert.equal(parseBacklogNumericId('0'), undefined)
  assert.equal(parseBacklogNumericId('abc'), undefined)
})

run('formatBacklogNumericId is the inverse for clean integers', () => {
  assert.equal(formatBacklogNumericId(240), '240')
  assert.equal(parseBacklogNumericId(formatBacklogNumericId(42)), 42)
})

run('allocateNextBacklogId is max + 1, holes preserved, min 1', () => {
  assert.equal(allocateNextBacklogId([]), 1)
  assert.equal(allocateNextBacklogId([1, 2, 3]), 4)
  // Holes are never refilled — a deleted id stays vacant.
  assert.equal(allocateNextBacklogId([1, 5, 2]), 6)
  assert.equal(allocateNextBacklogId([3, null, undefined, 0, -2]), 4)
})

run('planBacklogIdAllocation assigns missing ids oldest-first past the max', () => {
  const assignments = planBacklogIdAllocation([
    { relativePath: 'backlog/c.md', numericId: 5 },
    { relativePath: 'backlog/a.md', numericId: null, createdAt: '2026-01-01T00:00:00Z' },
    { relativePath: 'backlog/b.md', numericId: undefined, createdAt: '2026-02-01T00:00:00Z' },
  ])
  // Max existing is 5, so missing items continue from 6 in createdAt order.
  assert.deepEqual(assignments, { 'backlog/a.md': 6, 'backlog/b.md': 7 })
})

run('planBacklogIdAllocation: undated items take the tail, ordered by path', () => {
  const assignments = planBacklogIdAllocation([
    { relativePath: 'backlog/z.md', numericId: null },
    { relativePath: 'backlog/m.md', numericId: null, createdAt: '2026-03-01T00:00:00Z' },
    { relativePath: 'backlog/a.md', numericId: null },
  ])
  assert.deepEqual(assignments, { 'backlog/m.md': 1, 'backlog/a.md': 2, 'backlog/z.md': 3 })
})

run('planBacklogIdAllocation is idempotent on a fully-id`d backlog', () => {
  const assignments = planBacklogIdAllocation([
    { relativePath: 'backlog/a.md', numericId: 1 },
    { relativePath: 'backlog/b.md', numericId: 2 },
  ])
  assert.deepEqual(assignments, {})
})

run('formatBacklogDisplayId composes KEY-number with no padding', () => {
  assert.equal(formatBacklogDisplayId({ key: 'MC', numericId: 240 }), 'MC-240')
  assert.equal(formatBacklogDisplayId({ key: 'MC', numericId: 2 }), 'MC-2')
})

run('formatBacklogDisplayId: an external identity wins', () => {
  assert.equal(formatBacklogDisplayId({ key: 'MC', numericId: 240, external: { displayId: 'PROJ-17' } }), 'PROJ-17')
  // An empty/blank external id falls back to the native scheme.
  assert.equal(formatBacklogDisplayId({ key: 'MC', numericId: 9, external: { displayId: '  ' } }), 'MC-9')
})

run('deriveDefaultBacklogKey: initials for multi-word, prefix for single word', () => {
  assert.equal(deriveDefaultBacklogKey('ACME Web'), 'AW')
  assert.equal(deriveDefaultBacklogKey('multicode'), 'MUL')
  assert.equal(deriveDefaultBacklogKey('my-cool-project'), 'MCP')
  assert.equal(deriveDefaultBacklogKey('   '), 'BL')
  assert.equal(deriveDefaultBacklogKey('123'), 'BL') // alpha-led keys only
})

run('isValidBacklogKey accepts short alpha-led tokens, rejects junk', () => {
  assert.ok(isValidBacklogKey('MC'))
  assert.ok(isValidBacklogKey('ACME'))
  assert.ok(isValidBacklogKey('team-1'))
  assert.ok(!isValidBacklogKey('1MC'))
  assert.ok(!isValidBacklogKey('MY KEY'))
  assert.ok(!isValidBacklogKey(''))
  assert.ok(!isValidBacklogKey('waytoolongkeyvalue'))
})

run('findDuplicateBacklogIds names every colliding path, sorted by id', () => {
  const duplicates = findDuplicateBacklogIds([
    { relativePath: 'backlog/a.md', numericId: 3 },
    { relativePath: 'backlog/b.md', numericId: 3 },
    { relativePath: 'backlog/c.md', numericId: 1 },
    { relativePath: 'backlog/d.md', numericId: 1 },
    { relativePath: 'backlog/e.md', numericId: 9 },
    { relativePath: 'backlog/f.md', numericId: null },
  ])
  assert.deepEqual(duplicates, [
    { numericId: 1, relativePaths: ['backlog/c.md', 'backlog/d.md'] },
    { numericId: 3, relativePaths: ['backlog/a.md', 'backlog/b.md'] },
  ])
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
  console.log('item-id.test.ts: ok')
}

main()
