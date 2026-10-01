import type { JSX } from 'react'

export type MarkdownAlertKind = 'note' | 'tip' | 'important' | 'warning' | 'caution'

// One mark per alert kind in a rendered document, so the urgency reads by shape
// before the title is read and survives greyscale. 16-grid, 1.4 line work,
// currentColor — the tone comes from the alert's title.
const paths: Record<MarkdownAlertKind, string> = {
  // A ring with an "i".
  note: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11ZM8 7.5v3.25M8 5.25h.01',
  // A light bulb over its base.
  tip: 'M6 11.5h4M6.5 13.5h3M5.9 9.6A4 4 0 1 1 10.1 9.6c-.4.35-.6.8-.6 1.3v.6h-3v-.6c0-.5-.2-.95-.6-1.3Z',
  // A speech bubble with a "!".
  important: 'M3 3.5h10v7.5H8L5 13.5V11H3V3.5ZM8 5.5v2.5M8 9.75h.01',
  // A triangle with a "!".
  warning: 'M8 2.5 14 13H2L8 2.5ZM8 6.5V9.25M8 11.25h.01',
  // An octagon with a "!".
  caution: 'M5.7 2.5h4.6l3.2 3.2v4.6l-3.2 3.2H5.7l-3.2-3.2V5.7l3.2-3.2ZM8 5.25V8.5M8 10.75h.01',
}

export function MarkdownAlertGlyph({
  kind,
  className = 'icon-xs shrink-0',
}: {
  kind: MarkdownAlertKind
  className?: string
}): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true" data-alert-glyph={kind}>
      <path d={paths[kind]} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
