import React from 'react'

// Reviews: an eye — the guided walkthrough of a change. It lives in the review
// tree rather than in the shell's surfaceGlyphs because the pane row it draws
// is contributed, not built in (D7): the module hands the glyph to
// `registerModalSurface({ launcher })` and the pane draws whatever it is
// given. Moved verbatim from the retired ReviewsNavEntry (the Reviews door's
// row icon) when Reviews became a modal opened from the workspace pane
// (2026-09-05), and out of the shell when that row became a contribution
// (2026-09-10).
export function ReviewsGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4Z" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="8" r="1.8" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}
