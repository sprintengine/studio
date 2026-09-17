// Locating elements on a board by what they say rather than by id.
//
// An agent describes a shape the way a person would — "the auth flow box" — and
// the board spells it however whoever drew it felt like: `Auth Flow`, `auth-flow`,
// `authFlow`. Matching on the literal string turns a normal request into a
// scavenger hunt through ids, so the comparison drops case and every separator
// before it looks.

import type { CanvasElement, CanvasSkeleton } from './types'
import { canvasElementBox, canvasElementLabel, indexScene, toSkeleton } from './skeleton'

export type CanvasFindBox = { x: number; y: number; width: number; height: number }

export type CanvasFindQuery = {
  /** Case- and separator-insensitive substring of a label, frame name or id. */
  query?: string
  /** An element kind, matched exactly. */
  type?: string
  /** Anything that touches this rectangle. Intersection, not containment. */
  bbox?: CanvasFindBox
  ids?: string[]
}

/**
 * The comparison key: lower case with whitespace, hyphens and underscores
 * dropped, so the three spellings of one name collapse to `authflow`.
 */
export function normalizeCanvasSearchText(value: string): string {
  return String(value).toLowerCase().replace(/[\s\-_]+/g, '')
}

export function findElements(elements: CanvasElement[], query: CanvasFindQuery = {}): CanvasSkeleton[] {
  const index = indexScene(elements)
  const skeletons = toSkeleton(elements)
  const needle = query.query !== undefined ? normalizeCanvasSearchText(query.query) : ''
  const wanted = query.ids ? new Set(query.ids) : null

  return skeletons.filter((skeleton) => {
    const id = skeleton.id ?? ''
    if (wanted && !wanted.has(id)) return false
    if (query.type !== undefined && skeleton.type !== query.type) return false

    const element = index.byId.get(id)
    if (query.bbox && element && !intersects(canvasElementBox(element), query.bbox)) return false

    if (needle) {
      // The haystack is what the element says (its own text or the label folded
      // into it), its frame name, and its id — an agent that read an outline has
      // the ids in hand and should be able to use them here too.
      const haystack = [skeleton.text ?? '', skeleton.name ?? '', element ? canvasElementLabel(element, index) : '', id]
        .map(normalizeCanvasSearchText)
        .join('\u0001')
      if (!haystack.includes(needle)) return false
    }
    return true
  })
}

function intersects(box: CanvasFindBox, other: CanvasFindBox): boolean {
  const right = box.x + box.width
  const bottom = box.y + box.height
  const otherRight = other.x + other.width
  const otherBottom = other.y + other.height
  return box.x <= otherRight && right >= other.x && box.y <= otherBottom && bottom >= other.y
}
