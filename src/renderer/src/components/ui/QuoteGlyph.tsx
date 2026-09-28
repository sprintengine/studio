import React from 'react'

// The quote mark: two opening quotation marks, each a block with a tail that
// curls up and forward. It stands for "carry these words into what I write
// next", which is why it is the typographic mark and not a speech bubble — a
// bubble reads as "reply" or "comment", and nothing is sent when it is pressed.
// 16-grid, 1.4 line work, `currentColor`; `design-system/glyphs/quote.svg` is
// the framework-neutral sample.

export function QuoteGlyph({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M3 9.5h3V13H3V9.5Zm0 0c0-2.5.8-4.2 3-5.5M9.5 9.5h3V13h-3V9.5Zm0 0c0-2.5.8-4.2 3-5.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
