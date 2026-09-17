// Where an arrow's two ends actually go.
//
// The converter fastens an arrow to a shape but does not route it: it reads the
// points it was handed, works out how far each end sits from the shape it is
// bound to, and stores that as the binding's focus and gap. Hand it an arrow
// still sitting at its default 100x0 and the binding is recorded against
// geometry nobody meant — the arrow renders from the middle of one box to
// somewhere past the other, and the board's own lint calls it out.
//
// So the endpoints are computed here, before conversion: centre to centre,
// trimmed to each shape's outline, and pushed out by the clearance the editor
// leaves between an arrowhead and the thing it points at. Pure and DOM-free,
// which is the point — this is the part of arrow drawing that is arithmetic
// rather than typography.

import type { CanvasElement, CanvasPoint } from '../../../shared/canvas/types'

export type Box = { x: number; y: number; width: number; height: number; type: string }

/** The clearance the editor leaves between an arrow's tip and its shape. */
export const CANVAS_ARROW_GAP = 4

/** Below this an arrow between two shapes has nowhere to go; it is left alone. */
const MIN_ARROW_LENGTH = 1

export function boxOf(element: CanvasElement): Box {
  return {
    x: num(element.x),
    y: num(element.y),
    width: num(element.width),
    height: num(element.height),
    type: typeof element.type === 'string' ? element.type : 'rectangle',
  }
}

export function centreOf(box: Box): [number, number] {
  return [box.x + box.width / 2, box.y + box.height / 2]
}

/**
 * Where the ray from a box's centre towards `towards` leaves the box.
 *
 * Each shape has its own outline: a rectangle is clipped on whichever side the
 * ray reaches first, a diamond on |dx|/a + |dy|/b = 1, an ellipse on the
 * ellipse itself. A frame, an image or anything unfamiliar is treated as its
 * bounding rectangle, which is what the editor draws it as.
 */
export function edgePoint(box: Box, towards: [number, number]): [number, number] {
  const [cx, cy] = centreOf(box)
  const dx = towards[0] - cx
  const dy = towards[1] - cy
  if (dx === 0 && dy === 0) return [cx, cy]
  const a = box.width / 2
  const b = box.height / 2
  if (a <= 0 || b <= 0) return [cx, cy]

  let t: number
  if (box.type === 'ellipse') {
    t = 1 / Math.hypot(dx / a, dy / b)
  } else if (box.type === 'diamond') {
    t = 1 / (Math.abs(dx) / a + Math.abs(dy) / b)
  } else {
    t = Math.min(a / Math.abs(dx || Number.EPSILON), b / Math.abs(dy || Number.EPSILON))
  }
  return [cx + dx * t, cy + dy * t]
}

/** The same point, pushed `gap` further out along the ray that reached it. */
function withGap(from: [number, number], point: [number, number], gap: number): [number, number] {
  const dx = point[0] - from[0]
  const dy = point[1] - from[1]
  const length = Math.hypot(dx, dy)
  if (length === 0) return point
  return [point[0] + (dx / length) * gap, point[1] + (dy / length) * gap]
}

/** One end of an arrow: a shape it is fastened to, or a point it just sits at. */
export type ArrowEnd = {
  /** The shape this end is bound to. */
  box?: Box | null
  /** Where the end sits when it is bound to nothing. */
  free?: [number, number] | null
}

export type ArrowGeometry = { x: number; y: number; points: CanvasPoint[] }

/**
 * An arrow's absolute geometry from what its two ends are fastened to.
 *
 * `middle` is the arrow's intermediate points in absolute coordinates; they are
 * kept as they are, because a bend is the thing somebody drew, and they aim the
 * two ends — an arrow that doglegs leaves its shape heading for the corner it
 * was drawn through rather than for the far shape's centre.
 */
export function arrowGeometry(
  start: ArrowEnd,
  end: ArrowEnd,
  middle: CanvasPoint[] = [],
  gap = CANVAS_ARROW_GAP,
): ArrowGeometry | null {
  let from = start.free ?? null
  let to = end.free ?? null

  const firstBend = middle.length > 0 ? ([middle[0][0], middle[0][1]] as [number, number]) : null
  const lastBend =
    middle.length > 0 ? ([middle[middle.length - 1][0], middle[middle.length - 1][1]] as [number, number]) : null

  if (start.box && end.box) {
    const a = centreOf(start.box)
    const b = centreOf(end.box)
    from = withGap(a, edgePoint(start.box, firstBend ?? b), gap)
    to = withGap(b, edgePoint(end.box, lastBend ?? a), gap)
  } else if (start.box) {
    const a = centreOf(start.box)
    const aim = firstBend ?? to
    if (!aim) return null
    from = withGap(a, edgePoint(start.box, aim), gap)
  } else if (end.box) {
    const b = centreOf(end.box)
    const aim = lastBend ?? from
    if (!aim) return null
    to = withGap(b, edgePoint(end.box, aim), gap)
  }

  if (!from || !to) return null
  if (Math.hypot(to[0] - from[0], to[1] - from[1]) < MIN_ARROW_LENGTH) return null

  const points: CanvasPoint[] = [[0, 0]]
  for (const point of middle) points.push([point[0] - from[0], point[1] - from[1]])
  points.push([to[0] - from[0], to[1] - from[1]])
  return { x: from[0], y: from[1], points }
}

/** Absolute points of a linear element, from its origin and relative points. */
export function absolutePoints(element: CanvasElement): CanvasPoint[] {
  const x = num(element.x)
  const y = num(element.y)
  const points = Array.isArray(element.points) ? element.points : []
  return points.map((point) => [x + num(point?.[0]), y + num(point?.[1])] as CanvasPoint)
}

/** An origin and relative points, from absolute ones. */
export function relativePoints(points: CanvasPoint[]): ArrowGeometry | null {
  if (points.length < 2) return null
  const [ox, oy] = points[0]
  return { x: ox, y: oy, points: points.map((point) => [point[0] - ox, point[1] - oy] as CanvasPoint) }
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
