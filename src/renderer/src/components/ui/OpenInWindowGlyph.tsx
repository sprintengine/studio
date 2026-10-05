import type { JSX } from 'react'

// "In a window of its own": a box with an arrow leaving it by the top-right
// corner. Mirrored in design-system/glyphs/open-in-window.svg. 16-grid, 1.5
// line work, currentColor.
//
// One mark for the idea wherever it shows: the Diff tab's "Open in separate
// window", the pane strip's "Pop out pane", and a pane tab that is showing in
// a pop-out window right now. A tab wears it in its glyph slot, so it says
// "this one is elsewhere" in the drawing the person just clicked to send it
// there.

export function OpenInWindowGlyph({ className = 'icon-sm' }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M6.5 3H3v10h10V9.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9.5 3H13v3.5M13 3 7.5 8.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
