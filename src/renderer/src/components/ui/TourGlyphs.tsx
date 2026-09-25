import type { JSX } from 'react'

// The diff tour's four marks, mirrored in design-system/glyphs/ (tour.svg,
// play.svg, pause.svg, step-list.svg). 16-grid, 1.4 line work, currentColor —
// the same discipline as the Commit window's action marks beside them.

type GlyphProps = { className?: string }

/**
 * A tour: two stops joined by a route that doubles back on itself. It names the
 * thing (the recent-tours menu, the Start card) — not an action, so it never
 * sits on a button that does something other than open a tour.
 */
export function TourGlyph({ className = 'icon-sm' }: GlyphProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <circle cx="3.75" cy="11.75" r="1.6" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12.25" cy="4.25" r="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M5.35 11.75H9a2 2 0 0 0 0-4H7a1.75 1.75 0 0 1 0-3.5h3.65"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Play: advance on its own, at reading pace. */
export function PlayGlyph({ className = 'icon-sm' }: GlyphProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M5.25 3.9v8.2a.6.6 0 0 0 .92.5l6.2-4.1a.6.6 0 0 0 0-1l-6.2-4.1a.6.6 0 0 0-.92.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Pause: stop advancing. Play's pressed twin, never shown beside it. */
export function PauseGlyph({ className = 'icon-sm' }: GlyphProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M5.75 3.75v8.5M10.25 3.75v8.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

/** The step list: three stops, each with its line. */
export function StepListGlyph({ className = 'icon-sm' }: GlyphProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <circle cx="3.5" cy="4.5" r="0.95" fill="currentColor" />
      <circle cx="3.5" cy="8" r="0.95" fill="currentColor" />
      <circle cx="3.5" cy="11.5" r="0.95" fill="currentColor" />
      <path d="M6.5 4.5h6.25M6.5 8h6.25M6.5 11.5h6.25" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
