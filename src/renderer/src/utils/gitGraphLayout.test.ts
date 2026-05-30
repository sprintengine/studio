import assert from 'node:assert/strict'
import {
  computeGitGraphLayout,
  type GitGraphInputCommit,
  type GitGraphLine,
} from './gitGraphLayout'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`fail - ${name}`)
    throw error
  }
}

function commit(hash: string, parents: string[] = []): GitGraphInputCommit {
  return { hash, parents }
}

function hasLine(lines: GitGraphLine[], kind: GitGraphLine['kind'], from: number, to: number): boolean {
  return lines.some((line) => line.kind === kind && line.fromColumn === from && line.toColumn === to)
}

run('empty history produces no rows', () => {
  const layout = computeGitGraphLayout([])
  assert.deepEqual(layout.rows, [])
  assert.equal(layout.columns, 0)
})

run('linear history stays in a single column', () => {
  const layout = computeGitGraphLayout([
    commit('A', ['B']),
    commit('B', ['C']),
    commit('C', []),
  ])

  assert.equal(layout.columns, 1)
  assert.deepEqual(layout.rows.map((row) => row.column), [0, 0, 0])

  // A is a tip: only an outgoing edge down to its parent's lane.
  assert.ok(hasLine(layout.rows[0].lines, 'out', 0, 0))
  assert.ok(!layout.rows[0].lines.some((line) => line.kind === 'in'))
  // B sits mid-history: incoming from A, outgoing to C.
  assert.ok(hasLine(layout.rows[1].lines, 'in', 0, 0))
  assert.ok(hasLine(layout.rows[1].lines, 'out', 0, 0))
  // C is the root: incoming only, no outgoing.
  assert.ok(hasLine(layout.rows[2].lines, 'in', 0, 0))
  assert.ok(!layout.rows[2].lines.some((line) => line.kind === 'out'))
})

run('branch point: two tips share a parent and converge', () => {
  // X and Y are independent tips that both have P as their only parent.
  const layout = computeGitGraphLayout([
    commit('X', ['P']),
    commit('Y', ['P']),
    commit('P', []),
  ])

  assert.equal(layout.columns, 2)
  const [rowX, rowY, rowP] = layout.rows

  assert.equal(rowX.column, 0)
  assert.ok(hasLine(rowX.lines, 'out', 0, 0))

  // Y opens a second lane but does not duplicate P's lane: it routes left into it.
  assert.equal(rowY.column, 1)
  assert.ok(hasLine(rowY.lines, 'through', 0, 0), 'P lane passes straight through Y row')
  assert.ok(hasLine(rowY.lines, 'out', 1, 0), 'Y connects left into the shared parent lane')

  // P collapses the converging lane(s); no merge-style duplicate lane survives.
  assert.equal(rowP.column, 0)
  assert.ok(hasLine(rowP.lines, 'in', 0, 0))
})

run('merge commit forks two lanes that rejoin at the base', () => {
  // M merges A and B; both descend to a shared base.
  const layout = computeGitGraphLayout([
    commit('M', ['A', 'B']),
    commit('A', ['base']),
    commit('B', ['base']),
    commit('base', []),
  ])

  assert.equal(layout.columns, 2)
  const [rowM, rowA, rowB, rowBase] = layout.rows

  // Merge node forks: one out-edge per parent, into distinct lanes.
  assert.equal(rowM.column, 0)
  assert.ok(hasLine(rowM.lines, 'out', 0, 0), 'first parent inherits the node lane')
  assert.ok(hasLine(rowM.lines, 'out', 0, 1), 'second parent opens a new lane')

  assert.equal(rowA.column, 0)
  assert.ok(hasLine(rowA.lines, 'through', 1, 1), 'B lane passes through A row')

  // B rejoins base rather than duplicating its lane.
  assert.equal(rowB.column, 1)
  assert.ok(hasLine(rowB.lines, 'out', 1, 0), 'B connects left into the base lane')

  assert.equal(rowBase.column, 0)
  assert.ok(hasLine(rowBase.lines, 'in', 0, 0))
})

run('octopus merge forks one lane per parent', () => {
  const layout = computeGitGraphLayout([
    commit('M', ['A', 'B', 'C']),
    commit('A', []),
    commit('B', []),
    commit('C', []),
  ])

  assert.ok(layout.columns >= 3)
  const merge = layout.rows[0]
  assert.equal(merge.column, 0)
  assert.ok(hasLine(merge.lines, 'out', 0, 0))
  assert.ok(hasLine(merge.lines, 'out', 0, 1))
  assert.ok(hasLine(merge.lines, 'out', 0, 2))
})

run('independent roots stack without phantom connectors', () => {
  const layout = computeGitGraphLayout([
    commit('A', []),
    commit('B', []),
  ])

  assert.equal(layout.columns, 1)
  assert.deepEqual(layout.rows.map((row) => row.column), [0, 0])
  assert.deepEqual(layout.rows[0].lines, [])
  assert.deepEqual(layout.rows[1].lines, [])
})

run('orphan branch alongside mainline keeps a parallel lane', () => {
  // mainline: M1 -> M2 ; orphan tip O with no shared ancestry.
  const layout = computeGitGraphLayout([
    commit('M1', ['M2']),
    commit('O', []),
    commit('M2', []),
  ])

  // O occupies its own lane while the mainline lane passes through.
  const rowO = layout.rows[1]
  assert.equal(rowO.column, 1)
  assert.ok(hasLine(rowO.lines, 'through', 0, 0), 'mainline lane is undisturbed by the orphan')
  assert.equal(layout.columns, 2)
})

console.log('gitGraphLayout tests passed')
