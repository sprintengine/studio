import React from 'react'

// The code block's two header marks that the vocabulary did not have yet. Both
// sit on the 16-grid at the ui/ primitives' stroke (1.4), in `currentColor`, so
// they ink and size exactly like the copy glyph beside them
// (design-system/glyphs/wrap-lines.svg and terminal-prompt.svg are the
// framework-neutral samples).

type GlyphProps = { className?: string }

/**
 * Wrap long lines: a full line, a line that runs to the edge and turns back
 * under itself with an arrowhead, and the short line it continues on. The turn
 * is the whole meaning — without it the mark is a paragraph icon.
 */
export function WrapLinesGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M2.5 3.5h11M2.5 8h8.25a2.25 2.25 0 0 1 0 4.5H8M9.5 11 8 12.5 9.5 14M2.5 12.5h3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * A terminal at its prompt: the frame, the `>` and the cursor waiting after it.
 * It stands for "put this at a terminal's prompt", which is why it is the
 * prompt and not a play triangle — nothing runs until the person presses Enter,
 * and a play mark would promise that it does.
 */
export function TerminalPromptGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M5 6.5 7 8.5 5 10.5M8.5 10.5h3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
