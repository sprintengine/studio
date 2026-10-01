import type { JSX } from 'react'
import type { ConversationToolKind } from '../../../../shared/conversation-runtime'
import { McpGlyph } from './CapabilityGlyphs'

// One mark per kind of step an agent takes, so a row says what it did before
// its label is read: a column of steps scans as "read, read, ran, edited" by
// shape alone. Mirrored in design-system/glyphs/ as tool-<kind>.svg. 16-grid,
// 1.4 line work, currentColor — the tone comes from the row, which inks a
// running step in the accent and a failed one in the error tone.

const paths: Record<Exclude<ConversationToolKind, 'mcp'>, string> = {
  // A prompt caret and a cursor line.
  command: 'M3.5 4.5 7 8l-3.5 3.5M8.5 11.5h4',
  // A page with its corner folded and two lines of text.
  file_read: 'M9 2.5H4.5v11h7V5L9 2.5ZM9 2.5V5h2.5M6.5 8.5h3M6.5 10.5h3',
  // A pencil.
  file_edit: 'M10.5 3 13 5.5 6 12.5H3.5V10L10.5 3ZM9 4.5 11.5 7',
  // A page with a plus.
  file_write: 'M9 2.5H4.5v11h7V5L9 2.5ZM9 2.5V5h2.5M8 7.5v4M6 9.5h4',
  // A magnifier.
  search: 'M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM10.25 10.25 13.5 13.5',
  // A folder.
  list: 'M2.5 4.5v8h11v-6.5H8L6.5 4.5h-4Z',
  // A globe: rim, meridian, equator.
  web: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11ZM8 2.5c-1.6 1.6-2.4 3.4-2.4 5.5s.8 3.9 2.4 5.5M8 2.5c1.6 1.6 2.4 3.4 2.4 5.5s-.8 3.9-2.4 5.5M2.5 8h11',
  // A small robot head.
  subagent: 'M3.5 6h9v6.5h-9V6ZM8 3.5V6M6 9h.01M10 9h.01',
  // A checklist.
  todo: 'M2.75 4.5 4 5.75 6 3.5M2.75 10.5 4 11.75 6 9.5M8.5 5h5M8.5 11h5',
  // A wrench.
  other:
    'M10.2 2.7a3 3 0 0 0-3.9 3.9L2.8 10.1a1.4 1.4 0 0 0 2 2l3.5-3.5a3 3 0 0 0 3.9-3.9L10.4 6.5 9.2 6.3 9 5.1l1.2-2.4Z',
}

/**
 * The kind of a tool step, as a mark. Decorative: the row's label already says
 * what the step did, so the glyph is `aria-hidden` and carries its kind as
 * `data-tool-glyph` for anything that needs to read it back. An MCP call wears
 * the plug the capability inventory uses for MCP — one concept, one drawing.
 */
export function ToolKindGlyph({
  kind,
  className = 'icon-xs shrink-0',
}: {
  kind: ConversationToolKind
  className?: string
}): JSX.Element {
  if (kind === 'mcp')
    return (
      <span className="contents" data-tool-glyph="mcp">
        <McpGlyph className={className} />
      </span>
    )
  const known = (Object.hasOwn(paths, kind) ? kind : 'other') as keyof typeof paths
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true" data-tool-glyph={known}>
      <path d={paths[known]} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
