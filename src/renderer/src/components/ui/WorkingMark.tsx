import type { CSSProperties, JSX } from 'react'
import { stablePick } from './agentGlyph/pick'

// WorkingMark — "an agent is working right now": a 3×3 grid of cells in the
// accent, animated by one of four patterns. Which pattern is picked by `seed`
// (a chat's or an agent's id), so each chat keeps its own mark and a row of
// working chats does not all move in step. Pure CSS keyframes (`working-mark`
// in index.css), no per-frame JS. Reduced motion holds every pattern on the
// same still frame: the four corners and the centre lit.
//
//   orbit  — a lit cell runs round the edge, trailing a fading tail
//   ripple — a diagonal wave washes across, corner to corner
//   think  — cells light in a shuffled order, like it is working something out
//   snake  — a three-cell snake slithers round the edge

export const WORKING_MARK_VARIANTS = ['orbit', 'ripple', 'think', 'snake'] as const
export type WorkingMarkVariant = (typeof WORKING_MARK_VARIANTS)[number]

// The edge of the grid clockwise from the top-left, as row-major cell indexes.
const RING = [0, 1, 2, 5, 8, 7, 6, 3]
// The order `think` lights its cells in.
const THINK_ORDER = [4, 0, 8, 2, 6, 1, 7, 3, 5]

// Each cell's delay into its pattern's loop; null holds a cell still. Negative
// delays start the loop mid-way, so the pattern is already moving on mount.
function cellDelays(variant: WorkingMarkVariant): Array<number | null> {
  const delays: Array<number | null> = Array.from({ length: 9 }, () => null)
  switch (variant) {
    case 'orbit':
      RING.forEach((cell, step) => (delays[cell] = -1200 + step * 150))
      break
    case 'snake':
      RING.forEach((cell, step) => (delays[cell] = -1600 + step * 200))
      break
    case 'ripple':
      for (let cell = 0; cell < 9; cell++) delays[cell] = ((cell % 3) + Math.floor(cell / 3)) * 120
      break
    case 'think':
      THINK_ORDER.forEach((cell, step) => (delays[cell] = step * 200))
      break
  }
  return delays
}

export function WorkingMark({
  label,
  seed,
  variant,
  className,
}: {
  /** Accessible name, e.g. "Agent working". */
  label: string
  /** What picks the pattern: the working chat's or agent's id. */
  seed?: string
  /** A specific pattern instead of the seeded pick (previews, tests). */
  variant?: WorkingMarkVariant
  className?: string
}): JSX.Element {
  const pattern = variant ?? stablePick(seed ?? label, WORKING_MARK_VARIANTS)
  return (
    <span
      role="img"
      aria-label={label}
      data-variant={pattern}
      className={`working-mark working-mark--${pattern} ${className ?? ''}`}
    >
      {cellDelays(pattern).map((delay, cell) => (
        <i
          key={cell}
          aria-hidden
          className={delay === null ? 'working-mark__cell working-mark__cell--still' : 'working-mark__cell'}
          style={delay === null ? undefined : ({ animationDelay: `${delay}ms` } as CSSProperties)}
        />
      ))}
    </span>
  )
}
