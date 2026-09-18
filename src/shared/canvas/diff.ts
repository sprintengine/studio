// "What the person changed since you last read this board."
//
// An agent that re-reads a whole board to find out what moved spends its context
// on the ninety shapes that did not. This compares two snapshots and says only
// what a person would say out loud, in sentences short enough to paste into a
// tool answer.

import type { CanvasElement } from './types'
import { canvasElementBox, canvasElementLabel, indexScene } from './skeleton'
import type { CanvasSceneIndex } from './skeleton'

/** Below this, a change is a rounding artefact of the editor, not a move. */
export const CANVAS_DIFF_MOVE_THRESHOLD = 1

/** A change list longer than this is a rewrite; the agent should re-read instead. */
export const CANVAS_DIFF_MAX_LINES = 40

type Snapshot = {
  index: CanvasSceneIndex
  /** Live, non-folded elements by id — a bound label is reported as its container's. */
  subjects: Map<string, CanvasElement>
}

function snapshot(elements: CanvasElement[]): Snapshot {
  const index = indexScene(elements)
  const subjects = new Map<string, CanvasElement>()
  for (const element of index.live) {
    if (index.foldedTextIds.has(element.id)) continue
    subjects.set(element.id, element)
  }
  return { index, subjects }
}

/**
 * Compare two snapshots of one board. Order is added, then removed, then moved
 * or resized, then relabelled, each in the order the elements sit in the scene,
 * so two calls over the same pair produce the same list.
 */
export function summariseChanges(before: CanvasElement[], after: CanvasElement[]): string[] {
  const from = snapshot(before)
  const to = snapshot(after)

  const added: string[] = []
  const removed: string[] = []
  const geometry: string[] = []
  const relabelled: string[] = []

  for (const [id, element] of to.subjects) {
    if (from.subjects.has(id)) continue
    const box = canvasElementBox(element)
    const label = canvasElementLabel(element, to.index)
    added.push(`Added ${element.type} ${label ? `"${label}"` : id} at (${Math.round(box.x)},${Math.round(box.y)})`)
  }

  for (const [id, element] of from.subjects) {
    if (to.subjects.has(id)) continue
    removed.push(`Removed ${nameOf(element, from.index)}`)
  }

  for (const [id, next] of to.subjects) {
    const previous = from.subjects.get(id)
    if (!previous) continue
    const was = canvasElementBox(previous)
    const now = canvasElementBox(next)
    const moved =
      Math.abs(now.x - was.x) >= CANVAS_DIFF_MOVE_THRESHOLD || Math.abs(now.y - was.y) >= CANVAS_DIFF_MOVE_THRESHOLD
    const resized =
      Math.abs(now.width - was.width) >= CANVAS_DIFF_MOVE_THRESHOLD ||
      Math.abs(now.height - was.height) >= CANVAS_DIFF_MOVE_THRESHOLD
    const name = nameOf(next, to.index)
    const at = `(${Math.round(now.x)},${Math.round(now.y)})`
    const size = `${Math.round(now.width)}x${Math.round(now.height)}`
    if (moved && resized) geometry.push(`Moved ${name} to ${at} and resized to ${size}`)
    else if (moved) geometry.push(`Moved ${name} to ${at}`)
    else if (resized) geometry.push(`Resized ${name} to ${size}`)

    // A label lives in its own element, but nobody thinks of it that way: an
    // edited label is reported as the shape being renamed.
    const wasLabel = canvasElementLabel(previous, from.index)
    const nowLabel = canvasElementLabel(next, to.index)
    if (wasLabel !== nowLabel) {
      const subject = wasLabel ? `"${wasLabel}"` : `${next.type} ${id}`
      relabelled.push(`Relabelled ${subject} -> ${nowLabel ? `"${nowLabel}"` : '(no label)'}`)
    }
  }

  const all = [...added, ...removed, ...geometry, ...relabelled]
  if (all.length <= CANVAS_DIFF_MAX_LINES) return all
  return [
    ...all.slice(0, CANVAS_DIFF_MAX_LINES),
    `... and ${all.length - CANVAS_DIFF_MAX_LINES} more change(s). Re-read the board.`,
  ]
}

function nameOf(element: CanvasElement, index: CanvasSceneIndex): string {
  const label = canvasElementLabel(element, index)
  return label ? `"${label}"` : `${element.type} ${element.id}`
}
