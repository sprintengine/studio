import assert from 'node:assert/strict'

import { CANVAS_DEFAULT_STACK_GAP, innermostSharedGroup, layoutMoves } from './layoutMath'
import type { LayoutBox } from './layoutMath'
import { test } from 'vitest'

test('layoutMath', async () => {
  function run(name: string, body: () => void): void {
    try {
      body()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}`)
      throw error
    }
  }

  const boxes: LayoutBox[] = [
    { id: 'a', x: 0, y: 0, width: 100, height: 50 },
    { id: 'b', x: 200, y: 80, width: 60, height: 90 },
    { id: 'c', x: 400, y: 30, width: 40, height: 20 },
  ]

  const at = (moves: ReturnType<typeof layoutMoves>, id: string): { x: number; y: number } => {
    const move = moves.find((entry) => entry.id === id)
    assert.ok(move, `no move for ${id}`)
    return { x: move!.x, y: move!.y }
  }

  run('align puts every box on the selection edge, and only moves one axis', () => {
    const left = layoutMoves(boxes, { op: 'align', elementIds: [], to: 'left' })
    assert.deepEqual(
      left.map((move) => move.x),
      [0, 0, 0],
    )
    assert.deepEqual(
      left.map((move) => move.y),
      [0, 80, 30],
    )

    const right = layoutMoves(boxes, { op: 'align', elementIds: [], to: 'right' })
    // The selection's right edge is 440; each box's own width comes off it.
    assert.deepEqual(
      right.map((move) => move.x),
      [340, 380, 400],
    )

    const bottom = layoutMoves(boxes, { op: 'align', elementIds: [], to: 'bottom' })
    assert.deepEqual(
      bottom.map((move) => move.y),
      [120, 80, 150],
    )

    // Centred on the selection's own middle, not on the origin.
    const centre = layoutMoves(boxes, { op: 'align', elementIds: [], to: 'center-x' })
    assert.equal(at(centre, 'a').x, 220 - 50)
    assert.equal(at(centre, 'c').x, 220 - 20)
  })

  run('distribute leaves the outer two where they are and evens the air between', () => {
    const moves = layoutMoves(boxes, { op: 'distribute', elementIds: [], direction: 'horizontal' })
    assert.equal(at(moves, 'a').x, 0)
    assert.equal(at(moves, 'c').x, 400)
    // 440 of span less 200 of boxes, shared over two gaps.
    const gap = (440 - 200) / 2
    assert.equal(at(moves, 'b').x, 100 + gap)
    assert.equal(at(moves, 'c').x, 100 + gap + 60 + gap)
    // Nothing moves on the other axis.
    assert.deepEqual(
      moves.map((move) => move.y),
      [0, 80, 30],
    )
  })

  run('fewer than three boxes have nothing to distribute', () => {
    const two = boxes.slice(0, 2)
    const moves = layoutMoves(two, { op: 'distribute', elementIds: [], direction: 'horizontal' })
    assert.deepEqual(moves, [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 200, y: 80 },
    ])
  })

  run('stack runs from where the first box is, the gap apart', () => {
    const moves = layoutMoves(boxes, { op: 'stack', elementIds: [], direction: 'vertical' })
    // Ordered by y: a (0), c (30), b (80).
    assert.equal(at(moves, 'a').y, 0)
    assert.equal(at(moves, 'c').y, 50 + CANVAS_DEFAULT_STACK_GAP)
    assert.equal(at(moves, 'b').y, 50 + CANVAS_DEFAULT_STACK_GAP + 20 + CANVAS_DEFAULT_STACK_GAP)
    // The cross axis is left alone: a vertical stack is not also an alignment.
    assert.equal(at(moves, 'b').x, 200)
  })

  run('a gap of zero is a gap, not a missing one', () => {
    const moves = layoutMoves(boxes, { op: 'stack', elementIds: [], direction: 'horizontal', gap: 0 })
    assert.equal(at(moves, 'a').x, 0)
    assert.equal(at(moves, 'b').x, 100)
    assert.equal(at(moves, 'c').x, 160)
  })

  run('the innermost shared group is the first id everybody carries', () => {
    assert.equal(
      innermostSharedGroup([
        ['inner', 'outer'],
        ['inner', 'outer'],
      ]),
      'inner',
    )
    assert.equal(
      innermostSharedGroup([
        ['own', 'outer'],
        ['other', 'outer'],
      ]),
      'outer',
    )
    assert.equal(innermostSharedGroup([['a'], ['b']]), null)
    assert.equal(innermostSharedGroup([]), null)
    assert.equal(innermostSharedGroup([[]]), null)
  })
})
