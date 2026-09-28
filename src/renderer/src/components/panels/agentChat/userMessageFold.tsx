import { useId, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { GhostButton } from '../../ui'
import { ChevronRightGlyph } from './toolRows/ToolKindGlyph'
import { useConversationDisclosure } from './conversationViewState'

// A pasted log or file reads as a wall in the transcript, so a message taller
// than a screenful's worth of lines folds to its first lines under a fade until
// asked for. What counts is the height it renders at, in its own lines: a
// sentence that wraps eleven times in a narrow pane is as much of a wall as
// eleven typed lines, and a two-line message holding a long URL is not one.

/** Lines a folded message keeps in view. */
export const USER_MESSAGE_FOLD_LINES = 11

/**
 * The least a fold may hide, in lines. Folding away one or two lines costs the
 * reader a press to recover less than the control and fade take up themselves,
 * so a message that only just overruns shows whole.
 */
export const USER_MESSAGE_FOLD_MIN_HIDDEN_LINES = 3

/** The height a message folds to, or null when it shows whole. */
export function userMessageFoldHeight(contentHeight: number, lineHeight: number): number | null {
  if (!(lineHeight > 0) || !(contentHeight > 0)) return null
  const folded = USER_MESSAGE_FOLD_LINES * lineHeight
  // Half a pixel of slack: rendered heights are fractional, line counts are not.
  return contentHeight - folded >= USER_MESSAGE_FOLD_MIN_HIDDEN_LINES * lineHeight - 0.5 ? folded : null
}

/**
 * The line height text in `element` is set at, in pixels, from its computed
 * style. `normal` has no number to read; the UA's default of about 1.2× the
 * font size is what it lays out.
 */
export function lineHeightOf(element: Element): number {
  const style = getComputedStyle(element)
  const lineHeight = Number.parseFloat(style.lineHeight)
  if (Number.isFinite(lineHeight)) return lineHeight
  const fontSize = Number.parseFloat(style.fontSize)
  return Number.isFinite(fontSize) ? fontSize * 1.2 : 0
}

/**
 * A user message's body, folded when it renders taller than
 * `USER_MESSAGE_FOLD_LINES` of its own lines by at least
 * `USER_MESSAGE_FOLD_MIN_HIDDEN_LINES`. The whole message stays in the DOM
 * either way — only clipped — so a selection across it copies and quotes all
 * of it; the control under it is chrome and stays out of both. Whether it is
 * open is the conversation's disclosure memory, per message.
 *
 * Nothing animates: the list keeps the row's top where it was across the
 * toggle (`preserveDisclosurePosition` in the chat view), and a height tween
 * would fight that correction for as long as it ran.
 */
export function UserMessageFold({
  conversationKey,
  id,
  measureKey,
  className,
  children,
}: {
  conversationKey: string
  id: string
  /** Changes when the content does (the message text), so a recycled row re-measures. */
  measureKey: string
  className?: string
  children: ReactNode
}): JSX.Element {
  const regionId = useId()
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [foldHeight, setFoldHeight] = useState<number | null>(null)
  const [expanded, setExpanded] = useConversationDisclosure(conversationKey, `user-message:${id}`, false)

  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content) return
    // The bubble's own reading line: a paragraph's or an item's, which is
    // what the eye counts; the body's when the message has neither.
    const measure = () => {
      const probe = content.querySelector('p, li') ?? content
      const next = userMessageFoldHeight(content.getBoundingClientRect().height, lineHeightOf(probe))
      setFoldHeight((previous) => (previous === next ? previous : next))
    }
    measure()
    // The pane narrowing rewraps the text, a late font or image grows it.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    return () => observer.disconnect()
  }, [measureKey])

  const foldable = foldHeight !== null
  const collapsed = foldable && !expanded
  return (
    <div className="min-w-0">
      <div
        id={regionId}
        data-user-message-collapsed={collapsed ? 'true' : 'false'}
        className={
          collapsed
            ? 'min-w-0 overflow-hidden [mask-image:linear-gradient(to_bottom,black_calc(100%_-_var(--sem-space-xl)),transparent)]'
            : 'min-w-0'
        }
        style={collapsed ? { maxHeight: foldHeight } : undefined}
      >
        <div ref={contentRef} className={className}>
          {children}
        </div>
      </div>
      {foldable ? (
        <GhostButton
          data-copy-exclude=""
          size="inline"
          tone="subtle"
          align="start"
          aria-expanded={expanded}
          aria-controls={regionId}
          onClick={() => setExpanded(!expanded)}
          className="group/fold mt-1"
        >
          {expanded ? 'Show less' : 'Show full message'}
          {/* The transcript's one disclosure chevron: right while shut, down
              once open. */}
          <ChevronRightGlyph
            className={`icon-xs shrink-0 text-[color:var(--text-disabled)] group-hover/fold:text-[color:var(--text-subtle)] ${expanded ? 'rotate-90' : ''}`}
          />
        </GhostButton>
      ) : null}
    </div>
  )
}
