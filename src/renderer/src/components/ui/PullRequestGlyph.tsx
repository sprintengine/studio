// The pull request marks — where a conversation's work went, in the three
// shapes GitHub itself has taught people to read (epic `pull-request-marks`,
// decision 1; design-system/components/glyphs/component.md → "Pull request").
//
// Open is the branch beside main with an arrow that has not gone in, merged is
// the branch gone into main, closed is the branch ending in a cross. All three
// share one branch-and-node armature, so they read as a family; what differs is
// where the branch ends, and that difference IS the state — every one survives
// grayscale. Colour only agrees, and the tone map that supplies it is shared
// (`pullRequestTone`), so no surface invents its own.
//
// Three states and no more. A draft is an OPEN pull request and wears the open
// mark; the word "draft" belongs in the tooltip. There is no "unknown" mark
// either — nothing is drawn unless a pull request definitely exists, so a
// lookup that could not be made draws what no pull request draws (decision 3).
//
// 16-grid, stroke 1.4, `currentColor`. The caller owns the size (`icon-xs`
// beside meta copy, `icon-sm` in a row's leading slot) and the ink; the glyph
// owns only the geometry. Framework-neutral twins:
// design-system/glyphs/pull-request-{open,merged,closed}.svg.

import type { PullRequestState } from '../../../../shared/git/pull-request'

const OPEN = (
  <>
    <circle cx="4.5" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
    <circle cx="4.5" cy="12.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
    <circle cx="11.5" cy="12.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
    <path d="M4.5 5.1v5.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <path
      d="M11.5 10.9V6.2a1.9 1.9 0 0 0-1.9-1.9H7.9"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M9.6 2.6 7.9 4.3l1.7 1.7"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </>
)

const MERGED = (
  <>
    <circle cx="4.5" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
    <circle cx="4.5" cy="12.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
    <circle cx="11.5" cy="8.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
    <path d="M4.5 5.1v5.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <path
      d="M4.5 5.2c.4 2.2 2 3.3 5.4 3.3"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </>
)

const CLOSED = (
  <>
    <circle cx="4.5" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
    <circle cx="4.5" cy="12.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
    <circle cx="11.5" cy="12.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
    <path d="M4.5 5.1v5.8M11.5 10.9V8.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <path d="m9.6 3.2 3.8 3.8M13.4 3.2 9.6 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </>
)

/** The drawings, exported so `LifecycleGlyph` draws the same marks rather than a second copy. */
export const PULL_REQUEST_SHAPES: Record<PullRequestState, JSX.Element> = {
  open: OPEN,
  merged: MERGED,
  closed: CLOSED,
}

export function PullRequestGlyph({
  state,
  label,
  className,
}: {
  state: PullRequestState
  /** Accessible name; omit when adjacent text already names the state. */
  label?: string
  /** Size and ink, from the caller — normally `icon-xs` or `icon-sm`. */
  className?: string
}): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={`shrink-0 ${className ?? ''}`}
      {...(label ? ({ role: 'img', 'aria-label': label } as const) : ({ 'aria-hidden': true } as const))}
    >
      {label ? <title>{label}</title> : null}
      {PULL_REQUEST_SHAPES[state]}
    </svg>
  )
}
