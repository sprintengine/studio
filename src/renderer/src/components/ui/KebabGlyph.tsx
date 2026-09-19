import type { JSX } from 'react'
// The overflow mark: three dots stacked, meaning "more actions here".
//
// One drawing, because there were two. `OverflowMenu` drew it on a 14-grid with
// `r=1.2` dots at y 3 / 7 / 11; the Git panel's group band hand-rolled a
// 16-grid copy with `r=1.15` at 3.4 / 8 / 12.6. The same mark, at two pitches,
// one of them off the icon ramp entirely — which is the drift the glyph rule
// exists to prevent, and the reason `design-system/glyphs/` ships a
// framework-neutral twin of every mark in the product.
//
// It is drawn on the 16-grid like the rest of `design-system/glyphs/`, and it
// is the one mark in that folder made of FILLS rather than strokes: a dot has
// no line work, and a stroked dot is a circle of some radius pretending to be a
// point. `currentColor` still, which is the rule that actually matters.
//
// `aria-hidden`, always. The button that hosts it carries the name.

type KebabGlyphProps = {
  className?: string
}

export function KebabGlyph({ className = 'icon-xs' }: KebabGlyphProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true" focusable="false">
      <circle cx="8" cy="3.4" r="1.15" fill="currentColor" />
      <circle cx="8" cy="8" r="1.15" fill="currentColor" />
      <circle cx="8" cy="12.6" r="1.15" fill="currentColor" />
    </svg>
  )
}
