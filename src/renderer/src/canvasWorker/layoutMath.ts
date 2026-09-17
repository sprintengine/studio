// Arranging a selection, as arithmetic over boxes.
//
// Each of the three arranging operations answers the same question — where does
// each selected box go — and nothing else. Whatever follows from a box moving
// (its label travels with it, every arrow fastened to it is re-routed) is the
// update path's business, so these operations feed their answers through it
// rather than reimplementing any of it.

import type { CanvasLayoutRequest } from '../../../shared/canvas/types'

export type LayoutBox = { id: string; x: number; y: number; width: number; height: number }

export type LayoutMove = { id: string; x: number; y: number }

/** A stack with no gap given reads as one block; this is a readable default. */
export const CANVAS_DEFAULT_STACK_GAP = 40

/** Where each box ends up, or an empty list when the operation is a no-op. */
export function layoutMoves(boxes: LayoutBox[], request: CanvasLayoutRequest): LayoutMove[] {
  if (boxes.length === 0) return []
  switch (request.op) {
    case 'align':
      return alignMoves(boxes, request.to)
    case 'distribute':
      return distributeMoves(boxes, request.direction ?? 'horizontal')
    case 'stack':
      return stackMoves(boxes, request.direction ?? 'vertical', request.gap)
    default:
      return []
  }
}

function bounds(boxes: LayoutBox[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const box of boxes) {
    minX = Math.min(minX, box.x)
    minY = Math.min(minY, box.y)
    maxX = Math.max(maxX, box.x + box.width)
    maxY = Math.max(maxY, box.y + box.height)
  }
  return { minX, minY, maxX, maxY }
}

function alignMoves(boxes: LayoutBox[], to: CanvasLayoutRequest['to']): LayoutMove[] {
  const { minX, minY, maxX, maxY } = bounds(boxes)
  return boxes.map((box) => {
    switch (to) {
      case 'left':
        return { id: box.id, x: minX, y: box.y }
      case 'right':
        return { id: box.id, x: maxX - box.width, y: box.y }
      case 'top':
        return { id: box.id, x: box.x, y: minY }
      case 'bottom':
        return { id: box.id, x: box.x, y: maxY - box.height }
      case 'center-x':
        return { id: box.id, x: (minX + maxX) / 2 - box.width / 2, y: box.y }
      case 'center-y':
        return { id: box.id, x: box.x, y: (minY + maxY) / 2 - box.height / 2 }
      default:
        return { id: box.id, x: box.x, y: box.y }
    }
  })
}

/**
 * Even gaps between the boxes, with the two outermost left where they are.
 *
 * Distributing by gap rather than by centre is what somebody asking for an even
 * row means: boxes of different widths spaced by their centres leave visibly
 * uneven air between them, which is the thing being looked at.
 */
function distributeMoves(boxes: LayoutBox[], direction: 'horizontal' | 'vertical'): LayoutMove[] {
  if (boxes.length < 3) return boxes.map((box) => ({ id: box.id, x: box.x, y: box.y }))
  const horizontal = direction === 'horizontal'
  const ordered = [...boxes].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y))
  const extent = (box: LayoutBox): number => (horizontal ? box.width : box.height)
  const start = horizontal ? ordered[0].x : ordered[0].y
  const last = ordered[ordered.length - 1]
  const end = (horizontal ? last.x : last.y) + extent(last)
  const occupied = ordered.reduce((sum, box) => sum + extent(box), 0)
  const gap = (end - start - occupied) / (ordered.length - 1)

  const moves: LayoutMove[] = []
  let cursor = start
  for (const box of ordered) {
    moves.push(horizontal ? { id: box.id, x: cursor, y: box.y } : { id: box.id, x: box.x, y: cursor })
    cursor += extent(box) + gap
  }
  return moves
}

/** One after another along the axis, `gap` apart, starting where the first is. */
function stackMoves(
  boxes: LayoutBox[],
  direction: 'horizontal' | 'vertical',
  requestedGap: number | undefined,
): LayoutMove[] {
  const gap =
    typeof requestedGap === 'number' && Number.isFinite(requestedGap) ? requestedGap : CANVAS_DEFAULT_STACK_GAP
  const horizontal = direction === 'horizontal'
  const ordered = [...boxes].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y))
  const extent = (box: LayoutBox): number => (horizontal ? box.width : box.height)

  const moves: LayoutMove[] = []
  let cursor = horizontal ? ordered[0].x : ordered[0].y
  for (const box of ordered) {
    moves.push(horizontal ? { id: box.id, x: cursor, y: box.y } : { id: box.id, x: box.x, y: cursor })
    cursor += extent(box) + gap
  }
  return moves
}

/**
 * The innermost group every one of these elements already shares.
 *
 * `groupIds` runs innermost first, so the first id present on all of them is
 * the group somebody would have selected by clicking one of the shapes — which
 * is the one an ungroup is asking about.
 */
export function innermostSharedGroup(groupIdLists: string[][]): string | null {
  if (groupIdLists.length === 0) return null
  const [first, ...rest] = groupIdLists
  for (const groupId of first) {
    if (rest.every((ids) => ids.includes(groupId))) return groupId
  }
  return null
}
