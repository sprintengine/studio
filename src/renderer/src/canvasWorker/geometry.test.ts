import assert from 'node:assert/strict'

import type { CanvasElement } from '../../../shared/canvas/types'
import { CANVAS_ARROW_GAP, absolutePoints, arrowGeometry, boxOf, centreOf, edgePoint, relativePoints } from './geometry'
import type { Box } from './geometry'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const near = (actual: number, expected: number, tolerance = 0.001): void => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`)
}

const rect = (x: number, y: number, width: number, height: number, type = 'rectangle'): Box => ({
  x,
  y,
  width,
  height,
  type,
})

run('a ray leaves a rectangle through the side it reaches first', () => {
  const box = rect(0, 0, 100, 60)
  assert.deepEqual(edgePoint(box, [500, 30]), [100, 30])
  assert.deepEqual(edgePoint(box, [-500, 30]), [0, 30])
  assert.deepEqual(edgePoint(box, [50, -500]), [50, 0])
  assert.deepEqual(edgePoint(box, [50, 500]), [50, 60])
})

run('an ellipse and a diamond are clipped on their own outlines', () => {
  const ellipse = rect(0, 0, 100, 100, 'ellipse')
  const diamond = rect(0, 0, 100, 100, 'diamond')
  // Straight out to the side, all three shapes agree.
  near(edgePoint(ellipse, [500, 50])[0], 100)
  near(edgePoint(diamond, [500, 50])[0], 100)
  // On the diagonal they do not: a square would reach its corner, an ellipse
  // its radius, a diamond its flat edge — furthest first.
  const square = edgePoint(rect(0, 0, 100, 100), [500, 500])
  const round = edgePoint(ellipse, [500, 500])
  const rhombus = edgePoint(diamond, [500, 500])
  assert.ok(square[0] > round[0] && round[0] > rhombus[0])
})

run('an arrow between two shapes starts and ends on their edges', () => {
  const left = rect(0, 0, 100, 100)
  const right = rect(300, 0, 100, 100)
  const geometry = arrowGeometry({ box: left }, { box: right })
  assert.ok(geometry)
  // Out of the right edge of the first box, plus the clearance.
  near(geometry!.x, 100 + CANVAS_ARROW_GAP)
  near(geometry!.y, 50)
  const [, last] = geometry!.points
  // Into the left edge of the second box, less the clearance.
  near(geometry!.x + last[0], 300 - CANVAS_ARROW_GAP)
  near(geometry!.y + last[1], 50)
  assert.deepEqual(geometry!.points[0], [0, 0])
})

run('an arrow bound at one end only leaves the free end where it was', () => {
  const target = rect(300, 0, 100, 100)
  const geometry = arrowGeometry({ free: [10, 50] }, { box: target })
  assert.ok(geometry)
  assert.deepEqual([geometry!.x, geometry!.y], [10, 50])
  const last = geometry!.points[geometry!.points.length - 1]
  near(geometry!.x + last[0], 300 - CANVAS_ARROW_GAP)
})

run('an unbound arrow is exactly the two points it was given', () => {
  const geometry = arrowGeometry({ free: [0, 0] }, { free: [120, 40] })
  assert.deepEqual(geometry, {
    x: 0,
    y: 0,
    points: [
      [0, 0],
      [120, 40],
    ],
  })
})

run('a bend is kept, and it aims the ends that flank it', () => {
  const left = rect(0, 0, 100, 100)
  const right = rect(0, 300, 100, 100)
  const geometry = arrowGeometry({ box: left }, { box: right }, [[300, 200]])
  assert.ok(geometry)
  assert.equal(geometry!.points.length, 3)
  // The first end leaves towards the bend, not towards the far shape: the bend
  // is to the right and below, so the arrow leaves through the right-hand edge
  // at the clearance distance rather than straight down towards the far box.
  const leftEdge = edgePoint(left, [300, 200])
  assert.ok(geometry!.x > 100)
  near(Math.hypot(geometry!.x - leftEdge[0], geometry!.y - leftEdge[1]), CANVAS_ARROW_GAP)
  // The bend itself is untouched, in absolute terms.
  near(geometry!.x + geometry!.points[1][0], 300)
  near(geometry!.y + geometry!.points[1][1], 200)
})

run('two shapes on top of each other do not produce an arrow of no length', () => {
  const box = rect(0, 0, 100, 100)
  assert.equal(arrowGeometry({ box }, { box: rect(0, 0, 100, 100) }), null)
})

run('points round-trip between absolute and relative', () => {
  const element: CanvasElement = {
    id: 'a',
    type: 'arrow',
    version: 1,
    versionNonce: 1,
    x: 50,
    y: 60,
    points: [
      [0, 0],
      [10, 20],
    ],
  }
  assert.deepEqual(absolutePoints(element), [
    [50, 60],
    [60, 80],
  ])
  assert.deepEqual(relativePoints(absolutePoints(element)), {
    x: 50,
    y: 60,
    points: [
      [0, 0],
      [10, 20],
    ],
  })
})

run('a box with no geometry reads as zero rather than NaN', () => {
  const box = boxOf({ id: 'a', type: 'rectangle', version: 1, versionNonce: 1 })
  assert.deepEqual(box, { x: 0, y: 0, width: 0, height: 0, type: 'rectangle' })
  assert.deepEqual(centreOf(box), [0, 0])
})
