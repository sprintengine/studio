import type { JSX } from 'react'
// The kind mark is a kit primitive (ui/ToolKindGlyph) so its drawings live
// beside their framework-neutral copies in design-system/glyphs; the chat's
// modules keep reaching it through here, next to the chat's own marks.
export { ToolKindGlyph } from '../../../ui/ToolKindGlyph'

export function ChevronRightGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M4.5 2.5L8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

// Marks for the turn's own events, drawn to the same 16-grid, 1.4 line work
// and currentColor as the tool marks so they sit in the same column.
function TurnGlyph({ d, className = 'icon-xs shrink-0' }: { d: string; className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// A lightbulb: the model's reasoning before it acts.
export function ThoughtGlyph({ className }: { className?: string }): JSX.Element {
  return (
    <TurnGlyph
      className={className}
      d="M6 12h4M6.75 14h2.5M8 2.5a4 4 0 0 0-2.4 7.2c.6.45.9.95.9 1.3h3c0-.35.3-.85.9-1.3A4 4 0 0 0 8 2.5Z"
    />
  )
}

// Two arrows closing on a line: the conversation pressed into less context.
export function CompactGlyph({ className }: { className?: string }): JSX.Element {
  return <TurnGlyph className={className} d="M2.5 8h11M8 2.5V6M6 4l2 2 2-2M8 13.5V10M6 12l2-2 2 2" />
}
