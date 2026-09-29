// The model's reasoning, one quiet block per stretch of thinking, kept at the
// point in the turn where it happened.

import { useId, useRef } from 'react'
import { RowButton } from '../../ui'
import { ConversationMarkdown, useConversationLinkContext } from './conversationLinks'
import { useConversationDisclosure } from './conversationViewState'
import { useLiveRowMotion } from './liveVisibility'
import { ChevronRightGlyph, ThoughtGlyph } from './toolRows/ToolKindGlyph'

// The first line of the reasoning as plain words, for the closed header: enough
// to tell one block from the next without opening it. Markdown marks are
// dropped because the header is a single line of plain text. Only the lines up
// to the first worth showing are read: the block re-renders on every streamed
// token, and splitting the whole trace each time is work thrown away.
export function reasoningPreview(text: string): string {
  let line = ''
  for (let start = 0; start < text.length;) {
    const end = text.indexOf('\n', start)
    const part = text.slice(start, end === -1 ? text.length : end).trim()
    if (part && !/^(```|---|\*\*\*)/u.test(part)) {
      line = part
      break
    }
    if (end === -1) break
    start = end + 1
  }
  if (!line) return ''
  return line
    .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/u, '')
    .replace(/(\*\*|__|`)/gu, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .trim()
}

// Closed is the resting state: reasoning is how the answer was reached, not
// the answer. The header names how long the model thought and previews what
// about; opened, the text reads as markdown inside a bounded scroll so a long
// trace cannot push the conversation a screen down. While the model is still
// thinking the header shimmers "Thinking" instead.
export function ReasoningBlock({
  text,
  duration,
  live = false,
  disclosureId,
}: {
  text: string
  // How long it streamed, already worded as the turn's step durations are.
  duration?: string
  live?: boolean
  disclosureId: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLiveRowMotion(ref, live)
  const context = useConversationLinkContext()
  const [open, setOpen] = useConversationDisclosure(
    `${context?.workspaceId ?? ''}:${context?.agentId ?? ''}`,
    `thought:${disclosureId}`,
    false,
  )
  const bodyId = useId()
  const label = live ? 'Thinking' : duration ? `Thought for ${duration}` : 'Thought'
  const preview = open ? '' : reasoningPreview(text)
  return (
    // How the model reached its answer, not the answer: a copied transcript
    // leaves it out, as the reply's own copy does.
    <div ref={ref} className="mb-1" data-reasoning-block="" data-copy-exclude="">
      <RowButton
        density="row"
        className="group/tool-row text-meta"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => setOpen(!open)}
      >
        <span className="flex shrink-0 text-[color:var(--text-disabled)] group-hover/tool-row:text-[color:var(--text-subtle)]">
          <ThoughtGlyph />
        </span>
        <span
          className={`shrink-0 ${live ? 'chat-shimmer text-[color:var(--text-muted)]' : 'text-[color:var(--text-subtle)] group-hover/tool-row:text-[color:var(--text-muted)]'}`}
        >
          {label}
          {live ? (
            // The shimmer's bright band: a masked copy of the label (index.css).
            <span className="chat-shimmer__glint" aria-hidden="true">
              <span className="chat-shimmer__band" data-text={label} />
            </span>
          ) : null}
        </span>
        {preview ? (
          <span className="min-w-0 truncate text-[color:var(--text-disabled)] group-hover/tool-row:text-[color:var(--text-subtle)]">
            {preview}
          </span>
        ) : null}
        <ChevronRightGlyph
          className={`icon-xs ml-auto shrink-0 text-[color:var(--text-disabled)] transition-transform group-hover/tool-row:text-[color:var(--text-subtle)] ${open ? 'rotate-90' : ''}`}
        />
      </RowButton>
      {open ? (
        // An aside, not the reply: indented off a hairline rule and set in the
        // muted tone, so bold, code and lists still read as themselves without
        // the trace competing with the answer it led to.
        <div
          id={bodyId}
          className="mb-1 ml-3 mt-0.5 max-h-96 overflow-y-auto border-l border-[color:var(--border-subtle)] pl-3 text-[color:var(--text-muted)]"
        >
          <ConversationMarkdown text={text} streaming={live} tone="muted" />
        </div>
      ) : null}
    </div>
  )
}
