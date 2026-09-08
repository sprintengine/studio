// Pure line-anchor math for the review workspace. A ReviewAnchor points at a
// contiguous span of lines on the new or old side of a diff; the walkthrough UI
// renders hover tips against it, comments hang off it, and freshness re-runs
// (MC-1682) re-project it through `shiftAnchor` when the head sha moves.
//
// Node-free and dependency-free by design — see guards.ts for the discipline.

import { checkEnum, isPositiveInt, describeValue } from './guards'

const ANCHOR_SIDES = ['new', 'old'] as const
export type AnchorSide = (typeof ANCHOR_SIDES)[number]

export interface ReviewAnchor {
  side: AnchorSide
  startLine: number // 1-based, inclusive
  endLine: number // >= startLine
  anchoredAtSha?: string // sha the anchor was computed against (re-anchoring input)
}

// A 1-based, inclusive line span on one side of a file. Used to bound-check an
// anchor against the extent a changeset actually describes.
export interface LineExtent {
  min: number
  max: number
}

// One contiguous edit on the anchor's side, in the pre-edit (source) line
// numbering: `removed` lines starting at `start` are replaced by `added` lines.
// This is exactly diff-hunk shape, so a re-anchoring caller can build the delta
// list straight from the new changeset's hunks. Non-overlapping; order-free
// (shiftAnchor sorts).
export interface LineDelta {
  start: number // 1-based first affected line, in source numbering
  removed: number // lines removed at `start` (>= 0)
  added: number // lines inserted in their place (>= 0)
}

// Validate a ReviewAnchor's own shape (side enum, positive integer lines,
// endLine >= startLine, optional sha). Pushes path-qualified errors; the
// changeset cross-check (anchor within a file's extent) lives in brief.ts.
export function validateAnchor(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push(`${path} must be an object.`)
    return
  }
  const anchor = value as Record<string, unknown>
  checkEnum(anchor.side, ANCHOR_SIDES, `${path}.side`, errors)
  if (!isPositiveInt(anchor.startLine)) {
    errors.push(`${path}.startLine must be a positive integer; got ${describeValue(anchor.startLine)}.`)
  }
  if (!isPositiveInt(anchor.endLine)) {
    errors.push(`${path}.endLine must be a positive integer; got ${describeValue(anchor.endLine)}.`)
  }
  if (isPositiveInt(anchor.startLine) && isPositiveInt(anchor.endLine) && anchor.endLine < anchor.startLine) {
    errors.push(`${path}.endLine (${anchor.endLine}) must be >= startLine (${anchor.startLine}).`)
  }
  if (anchor.anchoredAtSha !== undefined && typeof anchor.anchoredAtSha !== 'string') {
    errors.push(`${path}.anchoredAtSha must be a string when present.`)
  }
}

// True when the anchor's whole span fits inside the line extent it was validated
// against. Callers pass the extent for the anchor's own side.
export function isAnchorWithinExtent(anchor: ReviewAnchor, extent: LineExtent): boolean {
  return anchor.startLine >= extent.min && anchor.endLine <= extent.max
}

// Map one source line number through an ordered, non-overlapping delta list.
// A line after an edited region shifts by the region's net (added - removed). A
// line that falls inside a replaced region collapses onto the replacement: the
// `bias` decides which edge — 'start' snaps to the first surviving line at/after
// the region, 'end' snaps to the last. Never returns a value < 1.
function shiftLine(line: number, sortedDeltas: LineDelta[], bias: 'start' | 'end'): number {
  let shifted = line
  for (const delta of sortedDeltas) {
    const regionEnd = delta.start + delta.removed // exclusive, source numbering
    if (line >= regionEnd) {
      shifted += delta.added - delta.removed
    } else if (line >= delta.start) {
      // Inside the replaced region. `shifted - line` is the net shift from all
      // deltas fully before this one (they are sorted and non-overlapping), so
      // the region's post-edit start is delta.start + priorShift.
      const priorShift = shifted - line
      const regionStart = delta.start + priorShift
      if (bias === 'start') return Math.max(1, regionStart)
      // 'end' bias: last replacement line, or the line just before the region
      // when it was a pure deletion (added === 0).
      return Math.max(1, regionStart + delta.added - 1)
    }
    // line < delta.start: this and every later delta are past the line — nothing
    // more to apply.
  }
  return Math.max(1, shifted)
}

// Re-project an anchor after the diff changed. `deltas` describe edits on the
// anchor's side in source (pre-edit) numbering. Returns the shifted anchor, or
// null when the anchored span collapsed entirely into deleted content (start
// would land after end) — the caller then treats the anchor as orphaned rather
// than silently pointing it somewhere wrong. Consumed by MC-1682 (T10).
export function shiftAnchor(anchor: ReviewAnchor, deltas: LineDelta[]): ReviewAnchor | null {
  const sorted = [...deltas].sort((a, b) => a.start - b.start)
  const startLine = shiftLine(anchor.startLine, sorted, 'start')
  const endLine = shiftLine(anchor.endLine, sorted, 'end')
  if (endLine < startLine) return null
  return { ...anchor, startLine, endLine }
}
