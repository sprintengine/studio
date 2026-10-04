import { frontTruncate } from '../../ui/FrontTruncatedText'

// What an open conversation's composer strip keeps on its one line, and how it
// gives way as the pane narrows (owner ruling 2026-10-04). Pure, so the order
// is testable without a layout engine.
//
// The strip is ALWAYS one line. It never wraps: an item that does not fit
// leaves for the strip's "⋮" menu, in a fixed order —
//
//   1. the branch truncates from the FRONT, down to `BRANCH_MIN_CHARS`;
//   2. then the branch leaves;
//   3. then the diff counts;
//   4. then the machine's glyph;
//   5. the context ring never leaves.
//
// The branch gives way first because it is the widest and the one with a
// meaningful tail to keep; the machine's glyph last because it is one glyph
// wide and says something nothing else on the strip does.

/** The fewest characters a front-truncated branch keeps before it leaves for the menu. */
export const BRANCH_MIN_CHARS = 10

/**
 * A branch name cut from the front to at most `maxChars` characters, keeping
 * the end — the part that says what the branch is for. Whole leading `/`
 * segments go first ("fix/cli-update-output" → "…cli-update-output", and
 * "feat/a/b-c" → "…a/b-c" → "…b-c"); only when the last segment alone does
 * not fit is a word cut, still keeping its end. Null when even that would keep
 * fewer than `BRANCH_MIN_CHARS` (or the whole of a shorter name): the branch
 * then leaves the strip rather than reading as a stub.
 */
export function frontTruncateBranch(name: string, maxChars: number): string | null {
  return frontTruncate(name, maxChars, BRANCH_MIN_CHARS)
}

/** The strip's measured parts, in pixels. A part that is absent is null. */
export type ComposerStripMeasure = {
  /** The strip's content width (inside its padding). */
  available: number
  /** The gap between two items. */
  gap: number
  /** The context ring's width; null when there is no reading to draw. */
  ring: number | null
  /** The "⋮" menu's button, drawn only while something has left the strip. */
  overflow: number
  /** The remote machine's glyph. */
  machine: number | null
  /** The diff counts. */
  changes: number | null
  /**
   * The branch: its name, the width of one character of its monospace text,
   * and everything the item draws around the text (its padding, a worktree
   * glyph).
   */
  branch: { name: string; charWidth: number; chrome: number } | null
}

/** What the strip draws. `branchText` is the (possibly truncated) branch, or null when it is in the menu. */
export type ComposerStripFit = { branchText: string | null; changes: boolean; machine: boolean }

/** Everything on the line, the branch in full: the fit before anything was measured. */
export function fullComposerStripFit(branch: string | null): ComposerStripFit {
  return { branchText: branch, changes: true, machine: true }
}

export function fitComposerStrip(measure: ComposerStripMeasure): ComposerStripFit {
  const { available, gap } = measure
  // Nothing laid out yet (a detached element, and every element under jsdom):
  // not a 0px strip, so nothing leaves.
  if (available <= 0) return fullComposerStripFit(measure.branch?.name ?? null)
  const lineWidth = (widths: ReadonlyArray<number | null>): number => {
    const present = widths.filter((width): width is number => width !== null)
    if (present.length === 0) return 0
    return present.reduce((sum, width) => sum + width, 0) + gap * (present.length - 1)
  }

  // 1. The branch, as much of it as the line has room for once everything
  //    else is on it.
  if (measure.branch) {
    const others = [measure.machine, measure.changes, measure.ring]
    const othersWidth = lineWidth(others)
    const room = available - othersWidth - (others.some((width) => width !== null) ? gap : 0) - measure.branch.chrome
    const chars = measure.branch.charWidth > 0 ? Math.floor(room / measure.branch.charWidth) : 0
    const text = frontTruncateBranch(measure.branch.name, chars)
    if (text !== null) return { branchText: text, changes: true, machine: true }
  }

  // 2–4. The branch is in the menu (when there is one); then the counts and
  // then the machine follow it, until the line fits. The ring stays whatever
  // is left, because it is the one item that answers "how much room is left
  // in this conversation" and nothing in the menu could.
  const steps: ReadonlyArray<{ changes: boolean; machine: boolean }> = [
    { changes: true, machine: true },
    { changes: false, machine: true },
    { changes: false, machine: false },
  ]
  for (const step of steps) {
    const hidden =
      measure.branch !== null ||
      (!step.changes && measure.changes !== null) ||
      (!step.machine && measure.machine !== null)
    const width = lineWidth([
      step.machine ? measure.machine : null,
      step.changes ? measure.changes : null,
      hidden ? measure.overflow : null,
      measure.ring,
    ])
    if (width <= available) return { branchText: null, ...step }
  }
  return { branchText: null, changes: false, machine: false }
}

/** Whether two fits draw the same strip. */
export function sameComposerStripFit(a: ComposerStripFit, b: ComposerStripFit): boolean {
  return a.branchText === b.branchText && a.changes === b.changes && a.machine === b.machine
}
