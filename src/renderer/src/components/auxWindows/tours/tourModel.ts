import type { LiveTour, LiveTourStep } from '../../../../../shared/tours/tour-types'
import { joinFilePath } from '../../../utils/paths'
import type { BranchDiffItem } from '../branchSteps'

// Diff tours, as the viewer plays them — everything that can be decided
// without Monaco or React. `useDiffTour` does the drawing; this file decides
// what is drawn where.

/**
 * One file of a tour, as the viewer's item list holds it.
 *
 * A branch item, because a tour's two sides are revisions like a commit
 * step's — the base SHA and a head SHA or the working tree — so the loader
 * that already reads commit steps reads these, and the editor stays mounted
 * across them exactly as it does across a step.
 */
export type TourDiffItem = BranchDiffItem & {
  /** The repository the tour was written against (a worktree agent's may not be the pane's). */
  repoRoot: string
  /** A renamed file's path on the old side. */
  originalRelativePath?: string
  /**
   * A deleted file is played as its old content, whole and read-only, with the
   * removed tint: both sides read the old text, so there is one editor's worth
   * of lines to point at and nothing collapses into an inline deletion zone.
   */
  mirrorOriginal?: boolean
}

export function isTourItem(item: unknown): item is TourDiffItem {
  return (
    typeof item === 'object' && item !== null && 'repoRoot' in item && (item as { kind?: string }).kind === 'branch'
  )
}

/** The tour's files, one each, in the order its steps first reach them. */
export function tourItems(tour: LiveTour): TourDiffItem[] {
  const seen = new Map<string, TourDiffItem>()
  for (const step of tour.steps) {
    const path = step.anchor.path
    if (seen.has(path)) continue
    const deleted = step.fileStatus === 'deleted'
    seen.set(path, {
      path: joinFilePath(tour.repoRoot, path),
      relativePath: path,
      status: step.fileStatus,
      kind: 'branch',
      originalRev: step.fileStatus === 'new' ? null : tour.revisions.base,
      modifiedRev: deleted ? null : tour.revisions.head,
      additions: 0,
      deletions: 0,
      repoRoot: tour.repoRoot,
      ...(step.anchor.oldPath ? { originalRelativePath: step.anchor.oldPath } : {}),
      ...(deleted ? { mirrorOriginal: true } : {}),
    })
  }
  return [...seen.values()]
}

/** For each step, the index of its file in `tourItems`. */
export function stepFileIndexes(tour: LiveTour, items: readonly TourDiffItem[]): number[] {
  const index = new Map(items.map((item, position) => [item.relativePath, position]))
  return tour.steps.map((step) => index.get(step.anchor.path) ?? -1)
}

/** Which of the diff editor's two editors a step's lines are lines of. */
export function stepEditorSide(step: Pick<LiveTourStep, 'anchor' | 'fileStatus'>): 'original' | 'modified' {
  // A deleted file is mirrored into both editors (see `mirrorOriginal`), and the
  // modified one is the editor present in either layout.
  if (step.fileStatus === 'deleted') return 'modified'
  return step.anchor.side === 'old' ? 'original' : 'modified'
}

/**
 * The layout a step must be played in, or null for "the person's own".
 *
 * An old-side step points at lines of the ORIGINAL editor, which unified view
 * draws only as inline deletion zones that cannot be decorated or hung a
 * callout from — so it plays side by side. A deleted file is one editor's worth
 * of text and plays unified.
 */
export function forcedLayout(
  step: Pick<LiveTourStep, 'anchor' | 'fileStatus'> | null,
): 'unified' | 'side-by-side' | null {
  if (!step) return null
  if (step.fileStatus === 'deleted') return 'unified'
  if (step.anchor.side === 'old') return 'side-by-side'
  return null
}

/** A line change as Monaco reports it (`ILineChange`), the part used here. */
export type LineChangeLike = {
  originalStartLineNumber: number
  originalEndLineNumber: number
  modifiedStartLineNumber: number
  modifiedEndLineNumber: number
}

/**
 * The lines on the OTHER side that correspond to `[start, end]` on `from`.
 *
 * A range touching a change maps to that change's span on the other side (an
 * empty span — a pure insert or delete — maps to the line the gap sits after).
 * An unchanged range maps by the running offset of every change above it,
 * which is exactly how the diff editor aligns the two sides.
 */
export function mapRangeAcross(
  changes: readonly LineChangeLike[],
  start: number,
  end: number,
  from: 'original' | 'modified',
): [number, number] {
  const fromStart = (c: LineChangeLike) => (from === 'modified' ? c.modifiedStartLineNumber : c.originalStartLineNumber)
  const fromEnd = (c: LineChangeLike) => (from === 'modified' ? c.modifiedEndLineNumber : c.originalEndLineNumber)
  const toStart = (c: LineChangeLike) => (from === 'modified' ? c.originalStartLineNumber : c.modifiedStartLineNumber)
  const toEnd = (c: LineChangeLike) => (from === 'modified' ? c.originalEndLineNumber : c.modifiedEndLineNumber)

  const mapLine = (line: number): number => {
    let offset = 0
    for (const change of changes) {
      const fs = fromStart(change)
      const fe = fromEnd(change)
      // An empty span on this side (end 0) sits after line `fs`.
      const empty = fe === 0
      if (!empty && line >= fs && line <= fe) {
        const ts = toStart(change)
        const te = toEnd(change)
        if (te === 0) return Math.max(1, ts)
        return Math.min(te, ts + (line - fs))
      }
      const lastBefore = empty ? fs : fe
      if (lastBefore < line) {
        const fromLen = empty ? 0 : fe - fs + 1
        const toLen = toEnd(change) === 0 ? 0 : toEnd(change) - toStart(change) + 1
        offset += toLen - fromLen
      }
    }
    return Math.max(1, line + offset)
  }
  const a = mapLine(start)
  const b = mapLine(end)
  return a <= b ? [a, b] : [b, a]
}

/** Words per minute a person reads code commentary at, for Play. */
const READING_WPM = 200
const PLAY_MIN_MS = 5_000
const PLAY_MAX_MS = 45_000

/**
 * How long Play stays on a step: the time to read its words, plus a settling
 * beat for the eye to find the lines, clamped so a one-line step is not a blink
 * and an essay is not a stall.
 */
export function readingTimeMs(step: Pick<LiveTourStep, 'title' | 'body'>): number {
  const words = `${step.title} ${step.body}`.split(/\s+/).filter(Boolean).length
  const reading = (words / READING_WPM) * 60_000 + 2_500
  return Math.round(Math.min(PLAY_MAX_MS, Math.max(PLAY_MIN_MS, reading)))
}

export type TourPlayState = {
  /** Null before Start. */
  index: number | null
  visited: string[]
}

/** Move to a step and remember it was seen. */
export function visit(state: TourPlayState, steps: readonly Pick<LiveTourStep, 'id'>[], index: number): TourPlayState {
  if (steps.length === 0) return { index: null, visited: state.visited }
  const clamped = Math.min(Math.max(index, 0), steps.length - 1)
  const id = steps[clamped].id
  return { index: clamped, visited: state.visited.includes(id) ? state.visited : [...state.visited, id] }
}

/** The pager's sentence, which is also its live-region text. */
export function stepPositionLabel(index: number | null, count: number): string {
  if (index === null || count === 0) return `${count} ${count === 1 ? 'step' : 'steps'}`
  return `Step ${index + 1} of ${count}`
}

/**
 * Whether the viewer should take a `tour.goto`. Only when the owner turned
 * Follow on and the tour is actually playing on screen — the agent pointing
 * somewhere is otherwise a chip, never a jump.
 */
export function gotoDecision(input: { showing: boolean; started: boolean; follow: boolean }): {
  moved: boolean
  reason: string
} {
  if (!input.showing) return { moved: false, reason: 'not_showing' }
  if (!input.started) return { moved: false, reason: 'not_started' }
  if (!input.follow) return { moved: false, reason: 'follow_off' }
  return { moved: true, reason: 'moved' }
}

/**
 * The keys a tour takes while focus is in the diff: `]` next, `[` previous.
 * Nothing with a modifier — F7, ⇧F7, ⌘↑ and ⌘↓ stay the change and file
 * steppers they already are.
 */
export function tourKeyAction(event: {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
}): 'next' | 'prev' | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null
  if (event.key === ']') return 'next'
  if (event.key === '[') return 'prev'
  return null
}
