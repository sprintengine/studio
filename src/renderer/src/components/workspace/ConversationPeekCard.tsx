import React, { useLayoutEffect, useRef, useState } from 'react'

import CliIcon from '../CliIcon'
import { Badge, IconButton, Skeleton, StatusDot, Tooltip, TruncatedText, type Tone } from '../ui'
import { FOCUS_RING_CLASS } from '../ui/tokens'
import { formatRelativeMs, formatRelativeMsAgo } from '../../utils/relativeTime'
import type { AgentCli } from '../../types/workspace'
import type {
  ConversationPeek,
  ConversationPeekAttachment,
  ConversationPeekMessage,
} from '../../../../shared/conversation-peek'

// The conversation peek — one hover surface for "what is this chat", opened
// from a sidebar row and from an agent tab. Design:
// `backlog/mockups/2026-09-07-conversation-peek.html`.
//
// This file is the PRESENTATIONAL half: identity in, markup out, no portal, no
// hover mechanics, no IPC — so it server-renders under the repo's static-markup
// test harness and so the two anchors (row, tab) can hold it in whichever shell
// they already own. `ConversationPeekPopover` and `AgentTabIdentityPopover` are
// the two shells; neither draws any of this itself.
//
// What is deliberately NOT here, because the design cut it: a footer, a "click
// to open · Esc dismisses" hint, and a message count. The card is the messages;
// counting them told the reader nothing the list did not, and a keyboard hint
// on a hover surface is chrome explaining chrome.

/**
 * Identity behind the conversation — everything the card says that is not a
 * message. Assembled by the caller (a tab knows its agent record, a sidebar row
 * knows its session) so this component stays presentational.
 *
 * Role, Runtime and Checkout are gone on purpose (mockup frame 1): "No role"
 * was the answer for almost every agent, the runtime repeated the mark already
 * on the tab, and the checkout repeated the branch already on the topbar. Model
 * and session id earned their place and stayed.
 */
/**
 * One terminal the card can be moved to. The highlighted disc owns the WHOLE
 * body — that terminal's first message, its messages since, its model and its
 * session id. Nothing is merged.
 */
export type ConversationPeekAgent = {
  /** What `readConversationPeek` is asked about. Already the unit of the contract. */
  sessionId: string
  /** The agent's name — the disc's accessible name, never its face. */
  name: string
  /** The disc's face: two letters. */
  initials: string
  /** Runtime id; null when unknown. */
  cli: AgentCli | null
  /** Launch model id; null → the CLI's own default. */
  model: string | null
  /** This terminal's own state, docked on its disc. */
  status: { tone: Tone; pulse: boolean; label: string } | null
}

export type ConversationPeekIdentity = {
  /** The CHAT's name — the tab's or the row's title. Constant across the roster. */
  name: string
  /** Sprint task the agent is claimed on, when applicable. */
  taskId: string | null
  /** The chat's live state, mirroring the dot the anchor already wears; null to omit. */
  status: { tone: Tone; pulse: boolean; label: string } | null
  /**
   * Every terminal this chat can be moved to, the one selected at rest first.
   * Never empty — a chat with nothing to peek at is not offered a card at all.
   *
   * One entry is the ordinary case and draws no roster: the chat IS the
   * terminal, and a selector over one thing is chrome. Two or more draws the
   * discs, and then the selected disc owns the whole body.
   */
  roster: ConversationPeekAgent[]
}

/**
 * Images shown as thumbnails before the rest are counted. The wire cap is
 * `MAX_PEEK_ATTACHMENTS` (8); three is what fits the card's measure beside a
 * "+N" without the strip wrapping into a second row.
 */
const MAX_THUMBNAILS = 3

/**
 * Thread rows before the list is masked at its top edge. The list scrolls at
 * `108px` — about four rows — so a fifth row is the first one that hides
 * something, and the fade is the only honest way to say so without a count.
 */
const THREAD_ROWS_BEFORE_FADE = 4

const CopyGlyph = ({ done }: { done: boolean }) =>
  done ? (
    <svg viewBox="0 0 24 24" className="icon-xs" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12.5 9 17.5 20 6.5" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" className="icon-xs" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </svg>
  )

const FileGlyph = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className ?? 'icon-xs'} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </svg>
)

const ImageGlyph = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className ?? 'icon-xs'} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <circle cx="8.5" cy="10" r="1.5" />
    <path d="m21 16-5-5-6 6" />
  </svg>
)

/**
 * A row's relative age, in the thread's terse voice: `2h`, `32m`, `now` — or
 * null when there is no age to give.
 *
 * `at <= 0` is main's "I could not read a timestamp for this", and it has to be
 * caught HERE rather than left to the formatter: `formatRelativeMsAgo(0, now)`
 * measures from the epoch and answers "56y ago", which is not a missing value,
 * it is a confident wrong one. Nothing is the honest render.
 */
function ageOf(at: number, now: number): string | null {
  if (!Number.isFinite(at) || at <= 0) return null
  return formatRelativeMs(at, now) || 'now'
}

/** The same rule for the first message's "3h ago" label. */
function agoOf(at: number, now: number): string | null {
  if (!Number.isFinite(at) || at <= 0) return null
  return formatRelativeMsAgo(at, now) || 'just now'
}

/**
 * The session id as the mockup draws it: `e4b3d55c…4687`. A chip that merely
 * truncates clips at whatever the measure happens to be, which throws away the
 * tail — and the tail is the half that tells two sessions apart at a glance.
 * The whole id is still what the copy button puts on the clipboard.
 */
export function elideSessionId(sessionId: string): string {
  if (sessionId.length <= 16) return sessionId
  return `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}`
}

/**
 * The section labels, which are how the card says which of the three shapes it
 * is in rather than looking broken (mockup frame 8). A `live` peek is prompts
 * seen since this app launched — not the chat's history — and a reader who is
 * not told that reads a truncated conversation as the whole one.
 */
function labelsFor(source: ConversationPeek['source']): { first: string; since: string } {
  return source === 'live'
    ? { first: 'First message since launch', since: 'Since then' }
    : { first: 'First message', since: 'Since then' }
}

/**
 * A thumbnail button, or a file chip. Both open the thing they name — the image
 * in a viewer, the file the way a path in the terminal already does — which is
 * why attachments live on the card and never in the thread tooltip: a tooltip
 * may hold nothing clickable, and a control needs a focus ring.
 */
function AttachmentThumbnail({
  attachment,
  onOpen,
}: {
  attachment: Extract<ConversationPeekAttachment, { kind: 'image' }>
  onOpen: ((attachmentId: string) => void) | undefined
}) {
  return (
    <button
      type="button"
      // 46×34 is the thumbnail's own aspect box, not spacing: a pasted
      // screenshot is landscape, and this is the smallest box that still reads
      // as one. No token names a media size.
      className={`inline-flex h-[34px] w-[46px] shrink-0 items-center justify-center overflow-hidden rounded-sm border border-[color:var(--border-default)] bg-[color:var(--bg-hover)] text-[color:var(--text-subtle)] hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-active)] hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
      aria-label={`Open ${attachment.label}`}
      onClick={(event) => {
        event.stopPropagation()
        onOpen?.(attachment.id)
      }}
      disabled={!onOpen}
    >
      {attachment.thumbnailDataUrl ? (
        <img src={attachment.thumbnailDataUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        // No thumbnail yet — the glyph stands in rather than a blank box, so a
        // decode still in flight does not read as a broken image.
        <ImageGlyph />
      )}
    </button>
  )
}

function AttachmentChip({
  attachment,
  onOpen,
}: {
  attachment: Extract<ConversationPeekAttachment, { kind: 'file' }>
  onOpen: ((attachmentId: string) => void) | undefined
}) {
  // A file the transcript named but could not resolve to a readable path has
  // nothing to open. It still appears — the message DID carry it — as a chip
  // that says so instead of a button that does nothing.
  const openable = attachment.path !== null && onOpen !== undefined
  const chip = (
    <button
      type="button"
      className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded-sm border border-[color:var(--border-default)] bg-[color:var(--bg-hover)] px-1.5 py-0.5 font-mono text-micro leading-4 text-[color:var(--text-muted)] hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-active)] hover:text-[color:var(--text-strong)] disabled:cursor-default disabled:opacity-70 disabled:hover:border-[color:var(--border-default)] disabled:hover:bg-[color:var(--bg-hover)] disabled:hover:text-[color:var(--text-muted)] ${FOCUS_RING_CLASS}`}
      aria-label={openable ? `Open ${attachment.label}` : `${attachment.label} — no readable path`}
      onClick={(event) => {
        event.stopPropagation()
        onOpen?.(attachment.id)
      }}
      disabled={!openable}
    >
      <FileGlyph className="icon-xs shrink-0" />
      <span className="truncate">{attachment.label}</span>
    </button>
  )
  // The chip shows a basename; where the file has a path, the kit's Tooltip
  // shows which one — the app's own answer for a control that needs a hint,
  // and never the native `title`, which cannot be styled or dismissed. A chip
  // with no path has nothing to add, so it gets no tooltip either.
  return attachment.path ? (
    <Tooltip content={attachment.path} layer="menu">
      {chip}
    </Tooltip>
  ) : (
    chip
  )
}

/**
 * The first message's attachments. Images lead it (they are the message's
 * subject when there are any) and files follow the text, exactly as the mockup
 * places them — and they sit on the FIRST message alone, because that is the
 * one being quoted in full. A later message carries a count on its row instead:
 * a strip of thumbnails inside a one-line row would either wrap it or shrink to
 * nothing.
 */
function FirstMessageThumbnails({
  attachments,
  onOpen,
}: {
  attachments: ConversationPeekAttachment[]
  onOpen: ((attachmentId: string) => void) | undefined
}) {
  const images = attachments.filter(
    (attachment): attachment is Extract<ConversationPeekAttachment, { kind: 'image' }> =>
      attachment.kind === 'image',
  )
  if (images.length === 0) return null
  const shown = images.slice(0, MAX_THUMBNAILS)
  const remainder = images.length - shown.length
  return (
    <div className="mb-2 flex items-center gap-1.5">
      {shown.map((image) => (
        <AttachmentThumbnail key={image.id} attachment={image} onOpen={onOpen} />
      ))}
      {remainder > 0 ? (
        <span
          className="inline-flex h-[34px] shrink-0 items-center rounded-sm border border-dashed border-[color:var(--border-default)] px-1.5 font-mono text-micro text-[color:var(--text-subtle)]"
          aria-label={`${remainder} more ${remainder === 1 ? 'image' : 'images'}`}
          role="img"
        >
          +{remainder}
        </span>
      ) : null}
    </div>
  )
}

function FirstMessageFiles({
  attachments,
  onOpen,
}: {
  attachments: ConversationPeekAttachment[]
  onOpen: ((attachmentId: string) => void) | undefined
}) {
  const files = attachments.filter(
    (attachment): attachment is Extract<ConversationPeekAttachment, { kind: 'file' }> =>
      attachment.kind === 'file',
  )
  if (files.length === 0) return null
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {files.map((file) => (
        <AttachmentChip key={file.id} attachment={file} onOpen={onOpen} />
      ))}
    </div>
  )
}

/**
 * What the thread row's tooltip says. A message longer than the wire cap
 * (`MAX_PEEK_MESSAGE_CHARS`) is CUT with the remainder counted — that is all a
 * hover surface can honestly do, and the message itself is a click away in the
 * chat. A tooltip that scrolled, or that ran down the whole window, is the
 * failure mode the ceiling exists to prevent.
 *
 * Split out and exported because it is the one piece of this component with a
 * decision in it, and a closed tooltip renders nothing to assert against.
 */
export function messageTooltipParts(message: ConversationPeekMessage): {
  text: string
  cut: string | null
} {
  if (message.truncatedChars <= 0) return { text: message.text, cut: null }
  return {
    // Main may or may not have marked the cut itself; one ellipsis either way.
    text: message.text.endsWith('…') ? message.text : `${message.text}…`,
    cut: `+ ${message.truncatedChars.toLocaleString()} characters`,
  }
}

/**
 * One line of the thread. The row shows one line because forty of them have to
 * fit; hovering it finishes the sentence in the app's own `Tooltip` at its
 * multiline measure — the right component precisely BECAUSE it is not
 * interactive.
 */
function ThreadRow({
  message,
  now,
  newest,
}: {
  message: ConversationPeekMessage
  now: number
  newest: boolean
}) {
  const attachmentCount = message.attachments.length
  const hasImage = message.attachments.some((attachment) => attachment.kind === 'image')
  const parts = messageTooltipParts(message)
  const textRef = useRef<HTMLSpanElement>(null)
  const [clipped, setClipped] = useState(false)

  // A tooltip restates a value ONLY when it is actually cut off
  // (design-system/components/tooltip → Usage). A short message that fits its
  // row has nothing to finish, and hovering it to be told what you are already
  // reading is the exact noise the rule exists to stop. Measured the way
  // `TruncatedText` measures — `scrollWidth` against `clientWidth`, +1 for
  // sub-pixel rounding — before paint, so a row never flickers a tooltip on.
  //
  // A message the WIRE cut always earns one, whatever the measure says: the
  // "+ N characters" line is a fact the row cannot carry at any width.
  useLayoutEffect(() => {
    const node = textRef.current
    if (!node) return
    setClipped(node.scrollWidth > node.clientWidth + 1)
    // Not re-measured on the clock: the age gutter is a fixed width, so a tick
    // cannot change whether the text overflows.
  }, [message.text])

  const hasTooltip = clipped || parts.cut !== null
  const tooltip = parts.cut ? (
    <>
      {parts.text}
      <span className="mt-1.5 block text-[color:var(--text-subtle)]">{parts.cut}</span>
    </>
  ) : (
    parts.text
  )
  const age = ageOf(message.at, now)
  const row = (
    <span
      className={`flex min-w-0 flex-1 items-baseline gap-2 rounded-sm ${hasTooltip ? FOCUS_RING_CLASS : ''}`}
      // Both paths, always: the tooltip spec forbids a hover-only reveal, and
      // a bare span is not in the tab order, so the cut-off half of a message
      // was unreachable without a pointer. Only a row that HAS something more
      // to say becomes a tab stop — forty inert stops inside a hover card
      // would be its own bug.
      tabIndex={hasTooltip ? 0 : undefined}
    >
      <span className="w-[30px] shrink-0 text-right font-mono text-micro tabular-nums text-[color:var(--text-subtle)]">
        {age}
      </span>
      <span
        ref={textRef}
        className={`min-w-0 flex-1 truncate text-meta ${
          newest ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-default)]'
        }`}
      >
        {message.text}
      </span>
      {attachmentCount > 0 ? (
        <span
          className="inline-flex shrink-0 items-center gap-0.5 font-mono text-micro text-[color:var(--text-subtle)]"
          role="img"
          aria-label={`${attachmentCount} ${attachmentCount === 1 ? 'attachment' : 'attachments'}`}
        >
          {hasImage ? <ImageGlyph className="icon-xs" /> : <FileGlyph className="icon-xs" />}
          {attachmentCount}
        </span>
      ) : null}
    </span>
  )
  return (
    <li className="conversation-peek-line min-w-0 rounded-sm">
      {hasTooltip ? (
        // `layer="menu"`: this tooltip is opened from inside a menu-tier
        // surface, and at the default tier it painted UNDER the card — which is
        // where it lands the moment the card is near a viewport edge and the
        // tooltip flips back onto it.
        <Tooltip
          content={tooltip}
          placement="right"
          multiline
          layer="menu"
          wrapperClassName="flex min-w-0"
        >
          {row}
        </Tooltip>
      ) : (
        row
      )}
    </li>
  )
}

/**
 * The thread. `since` is oldest-first and the list scrolls, so it has to be
 * scrolled to its END on arrival: left alone it opened at `scrollTop = 0`,
 * showing the four OLDEST messages while the one marked "now" sat off-screen
 * below — under a fade drawn across the top edge, which then claimed there was
 * more above when the hidden half was all below. Newest last and in view is the
 * ruling (mockup frame 4); the fade means "older messages are up there", and
 * this is what makes that true.
 *
 * `useLayoutEffect`, so the jump happens before the first paint rather than as
 * a visible scroll.
 */
function Thread({ since, now }: { since: ConversationPeekMessage[]; now: number }) {
  const listRef = useRef<HTMLOListElement>(null)
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    list.scrollTop = list.scrollHeight
  }, [since])
  return (
    <ol
      ref={listRef}
      className={`conversation-peek-thread m-0 mt-1 flex max-h-[108px] list-none flex-col gap-1.5 overflow-y-auto p-0 ${
        since.length > THREAD_ROWS_BEFORE_FADE ? 'conversation-peek-thread--faded' : ''
      }`}
    >
      {since.map((message, index) => (
        <ThreadRow
          key={message.id}
          message={message}
          now={now}
          newest={index === since.length - 1}
        />
      ))}
    </ol>
  )
}

/**
 * Discs shown before the rest are counted. The strip must never wrap: a second
 * line of discs is the card resizing, which is the one thing this surface may
 * not do while a pointer is travelling across it. The earlier agent-stack
 * mockup wrapped at seven and got tall.
 */
const MAX_ROSTER_DISCS = 6

/**
 * The roster — the card's SELECTOR, and why it is discs rather than tabs. This
 * surface opens under a pointer that was on its way somewhere else, so its
 * selector has to answer to a hover; a tab is a thing you click. The discs also
 * cost one line instead of a row of chrome above the thread that is the point,
 * and they are the same marks already sitting on the row you hovered.
 *
 * SEMANTICS. Not a tablist, whatever the mockup's sketch markup said: the body
 * is not a panel a tab owns, and `aria-selected` on something that also moves
 * on hover would lie. Not the kit's `SegmentedControl` either — that is a
 * bordered strip of word labels, and this is a row of discs — but its CONTRACT
 * is the exact fit and is taken wholesale from
 * `design-system/components/segmented-control`: `role="radiogroup"` with real
 * `<button role="radio">` children, one tab stop for the group, roving
 * `tabindex`, arrows wrapping, and SELECTION FOLLOWS FOCUS. That last clause is
 * the spec's own, and it is allowed here for the spec's own reason: the values
 * are cheap and reversible — arrowing reads a conversation, it does not start
 * one.
 *
 * Which makes the two input paths agree rather than diverge:
 * - Pointer hover PREVIEWS. The body moves; nothing is committed; leaving the
 *   strip returns it to the pinned agent. That is what lets the pointer travel
 *   down to a file chip without the card changing underneath it.
 * - A press PINS.
 * - An arrow key moves focus and PINS, because a keyboard has no "leave without
 *   clicking" — so focus moving the body and selection following focus are the
 *   same act, and `aria-checked` never describes something the eye cannot see.
 */
function AgentRoster({
  roster,
  shownSessionId,
  pinnedSessionId,
  onPreview,
  onEndPreview,
  onPin,
}: {
  roster: ConversationPeekAgent[]
  /** Whose conversation the body is showing right now — hover included. */
  shownSessionId: string | null
  /** The committed choice, which is what `aria-checked` reports. */
  pinnedSessionId: string | null
  onPreview: ((sessionId: string) => void) | undefined
  onEndPreview: (() => void) | undefined
  onPin: ((sessionId: string) => void) | undefined
}) {
  const shown = roster.slice(0, MAX_ROSTER_DISCS)
  const remainder = roster.length - shown.length
  const pinnedIndex = Math.max(
    0,
    shown.findIndex((agent) => agent.sessionId === pinnedSessionId),
  )

  const onKeyDown = (event: React.KeyboardEvent, index: number): void => {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown'
    const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
    if (!forward && !back) return
    event.preventDefault()
    const next = (index + (forward ? 1 : -1) + shown.length) % shown.length
    const target = shown[next]
    if (!target) return
    onPin?.(target.sessionId)
    // Focus follows the selection, per the radiogroup contract. The roving
    // tabindex has already moved with `pinnedIndex`, so this is what carries
    // the caret with it.
    const strip = event.currentTarget.parentElement
    const button = strip?.querySelectorAll<HTMLElement>('[role="radio"]')[next]
    button?.focus()
  }

  return (
    <div
      className="flex items-center gap-1.5"
      role="radiogroup"
      aria-label="Terminals in this chat"
      // One `mouseleave` for the whole strip, not one per disc: moving between
      // two discs must not flick the body back to the pinned agent on the way.
      onMouseLeave={onEndPreview}
    >
      {shown.map((agent, index) => {
        const showing = agent.sessionId === shownSessionId
        return (
          <button
            key={agent.sessionId}
            type="button"
            role="radio"
            aria-checked={agent.sessionId === pinnedSessionId}
            // The name, never the initials: "DS" tells a screen reader nothing,
            // and the state has to travel in words because colour may not carry
            // it alone.
            aria-label={agent.status ? `${agent.name} — ${agent.status.label}` : agent.name}
            tabIndex={index === pinnedIndex ? 0 : -1}
            onMouseEnter={() => onPreview?.(agent.sessionId)}
            onFocus={() => onPreview?.(agent.sessionId)}
            onClick={() => onPin?.(agent.sessionId)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={`relative grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full border text-micro font-medium ${FOCUS_RING_CLASS} ${
              // Selection is NEUTRAL, per design-system/components/segmented-control:
              // "an accent-filled segment would spend the one solid accent on a
              // state display". The mockup draws the live disc in accent-soft;
              // the system's own ruling on what selection looks like wins, and
              // the conformance lint enforces it.
              showing
                ? 'border-[color:var(--border-strong)] bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
                : 'border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
            }`}
          >
            <span aria-hidden="true">{agent.initials}</span>
            {agent.status ? (
              // Docked bottom-right with a ring in the surface behind it, so it
              // reads as sitting ON the disc — the agent-stack idiom, and the
              // same trick Badge's corner mode uses.
              <span className="absolute -bottom-px -right-px rounded-full ring-2 ring-[color:var(--bg-surface-raised)]">
                <StatusDot tone={agent.status.tone} pulse={agent.status.pulse} />
              </span>
            ) : null}
          </button>
        )
      })}
      {remainder > 0 ? (
        <span
          role="img"
          aria-label={`${remainder} more ${remainder === 1 ? 'terminal' : 'terminals'}`}
          className="shrink-0 font-mono text-micro text-[color:var(--text-subtle)]"
        >
          +{remainder}
        </span>
      ) : null}
    </div>
  )
}

/**
 * Who the body belongs to, and the two facts that used to be badge chips. One
 * line, and it MUST stay one line: `flex-nowrap` with the model truncating,
 * because a wrapped model name is the card growing a row while the pointer is
 * on a disc — the same resize the body's reserve exists to prevent.
 */
function AgentIdentityLine({
  agent,
  taskId,
  copied,
  onCopySession,
}: {
  agent: ConversationPeekAgent
  taskId: string | null
  copied: boolean
  onCopySession: () => void
}) {
  return (
    <div className="mt-1.5 flex min-w-0 flex-nowrap items-center gap-1.5 text-micro text-[color:var(--text-muted)]">
      <span className="shrink-0 font-medium text-[color:var(--text-strong)]">{agent.name}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[color:var(--text-subtle)]">
        {agent.model ?? 'CLI default'}
      </span>
      {taskId ? (
        <span className="shrink-0 font-mono tabular-nums text-[color:var(--text-subtle)]">{taskId}</span>
      ) : null}
      <span className="shrink-0 font-mono tabular-nums text-[color:var(--text-subtle)]">
        {elideSessionId(agent.sessionId)}
      </span>
      <IconButton
        size="sm"
        aria-label={copied ? 'Session id copied' : `Copy session id for ${agent.name}`}
        onClick={onCopySession}
        className="shrink-0"
      >
        <CopyGlyph done={copied} />
      </IconButton>
    </div>
  )
}

function SectionLabel({ children, trailing }: { children: React.ReactNode; trailing?: React.ReactNode }) {
  return (
    <p className="m-0 mb-1 flex items-baseline justify-between gap-2 text-micro text-[color:var(--text-subtle)]">
      <span>{children}</span>
      {trailing ? <span className="shrink-0 font-mono tabular-nums">{trailing}</span> : null}
    </p>
  )
}

/**
 * The card. `peek` is null while the answer is still in flight — the identity
 * is on screen from the first frame either way, because it is the half we
 * already know and a card that appeared empty and then filled would read as
 * broken rather than as loading.
 */
export function ConversationPeekCard({
  identity,
  peek,
  loading,
  now,
  copied,
  onCopySession,
  onOpenAttachment,
  selectedSessionId,
  pinnedSessionId,
  onPreviewAgent,
  onEndPreview,
  onPinAgent,
}: {
  identity: ConversationPeekIdentity
  peek: ConversationPeek | null
  loading: boolean
  now: number
  copied: boolean
  onCopySession: () => void
  /** Absent when the preload has no opener — the chips then render inert rather than lying. */
  onOpenAttachment?: (attachmentId: string) => void
  /**
   * Which terminal the body is showing. The shell owns this because it also
   * owns the hover/pin state and the read that follows it; the card only says
   * what it was handed.
   */
  selectedSessionId?: string | null
  /** The PINNED terminal, which is what `aria-checked` follows. */
  pinnedSessionId?: string | null
  /** Pointer or focus landed on a disc: move the body, commit nothing. */
  onPreviewAgent?: (sessionId: string) => void
  /** The pointer left the roster: fall back to the pinned selection. */
  onEndPreview?: () => void
  /** A press, or an arrow key: commit. */
  onPinAgent?: (sessionId: string) => void
}) {
  const labels = labelsFor(peek?.source ?? 'none')
  const since = peek?.since ?? []
  const roster = identity.roster
  const multi = roster.length > 1
  const selected = roster.find((agent) => agent.sessionId === selectedSessionId) ?? roster[0] ?? null
  return (
    <>
      <div className="flex items-center gap-2 border-b border-[color:var(--border-subtle)] px-3 py-2.5">
        {selected?.cli ? (
          <CliIcon cli={selected.cli} className="icon-sm shrink-0 text-[color:var(--text-strong)]" />
        ) : null}
        {/* The name in full is what the row's own truncation tooltip used to
            show; this header takes that job, which is how the row keeps to one
            hover surface at a time. `TruncatedText` is the same primitive the
            row was using, so a name even this measure cannot hold still has one
            way to be read — and only when it is actually clipped. */}
        <TruncatedText
          as="span"
          text={identity.name}
          className="min-w-0 flex-1 text-heading font-semibold text-[color:var(--text-strong)]"
        />
        {/* A chat with a roster counts its terminals here instead of naming one
            state: each terminal's own state is on its own disc, and the header
            is about the chat. */}
        {multi ? (
          <span className="flex shrink-0 items-center gap-1.5 text-meta text-[color:var(--text-muted)]">
            {identity.status ? (
              <StatusDot tone={identity.status.tone} pulse={identity.status.pulse} />
            ) : null}
            {roster.length} agents
          </span>
        ) : identity.status ? (
          <span className="flex shrink-0 items-center gap-1.5 text-meta text-[color:var(--text-muted)]">
            <StatusDot tone={identity.status.tone} pulse={identity.status.pulse} />
            {identity.status.label}
          </span>
        ) : null}
      </div>

      {multi ? (
        <div className="px-3 pb-1 pt-2.5">
          <AgentRoster
            roster={roster}
            shownSessionId={selected?.sessionId ?? null}
            pinnedSessionId={pinnedSessionId ?? null}
            onPreview={onPreviewAgent}
            onEndPreview={onEndPreview}
            onPin={onPinAgent}
          />
          {selected ? (
            <AgentIdentityLine
              agent={selected}
              taskId={identity.taskId}
              copied={copied}
              onCopySession={onCopySession}
            />
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-1 pt-2.5">
          <Badge className="max-w-full">
            <span className="truncate font-mono">{selected?.model ?? 'CLI default'}</span>
          </Badge>
          {identity.taskId ? (
            <Badge>
              <span className="font-mono tabular-nums">{identity.taskId}</span>
            </Badge>
          ) : null}
          {selected ? (
            // The copy control sits BESIDE the chip, not inside it: a badge is
            // display-only by spec (design-system/components/badge — "never
            // interactive"), and the one thing on this card you press to take a
            // value away with you should be a real button with a real focus ring.
            <span className="inline-flex min-w-0 max-w-full items-center gap-0.5">
              <Badge ariaLabel={`Session ${selected.sessionId}`}>
                <span className="font-mono tabular-nums">{elideSessionId(selected.sessionId)}</span>
              </Badge>
              <IconButton
                size="sm"
                aria-label={copied ? 'Session id copied' : 'Copy session id'}
                onClick={onCopySession}
                className="shrink-0"
              >
                <CopyGlyph done={copied} />
              </IconButton>
            </span>
          ) : null}
        </div>
      )}

      {/* THE BODY IS THE SELECTED TERMINAL'S, whole. It reserves a fixed height
          whenever there is a roster, so sweeping the discs never resizes the
          card — the 2026-09-02 agent-stack ruling, and not a cosmetic one: a
          card that grows under the pointer moves the disc out from under it,
          which un-hovers what you were pointing at and can flip between two
          states forever. A short conversation ends in space instead.

          Named for whoever it belongs to, so a reader arriving here is never
          left guessing which of the three they landed in. */}
      <div
        className={`px-3 pb-2.5 pt-2 ${multi ? 'min-h-[196px]' : ''}`}
        role={multi ? 'group' : undefined}
        aria-label={multi && selected ? `Conversation with ${selected.name}` : undefined}
      >
        {loading && !peek ? (
          <div className="flex flex-col gap-1.5" aria-label="Reading the conversation" role="status">
            <Skeleton className="h-2.5 w-full rounded-sm bg-[color:var(--bg-hover)]" />
            <Skeleton className="h-2.5 w-4/5 rounded-sm bg-[color:var(--bg-hover)]" />
            <Skeleton className="h-2.5 w-2/3 rounded-sm bg-[color:var(--bg-hover)]" />
          </div>
        ) : peek && peek.first ? (
          <>
            <SectionLabel trailing={agoOf(peek.first.at, now)}>{labels.first}</SectionLabel>
            <FirstMessageThumbnails attachments={peek.first.attachments} onOpen={onOpenAttachment} />
            {/* Four lines, then it clips. The first message runs to any length
                and a card that grew with it would cover the work it describes;
                the message itself is a click away in the chat. */}
            <p className="conversation-peek-line m-0 line-clamp-4 whitespace-pre-wrap break-words text-meta leading-relaxed text-[color:var(--text-strong)]">
              {peek.first.text}
            </p>
            <FirstMessageFiles attachments={peek.first.attachments} onOpen={onOpenAttachment} />
            {since.length > 0 ? (
              <>
                <div className="mt-2.5">
                  <SectionLabel>{labels.since}</SectionLabel>
                </div>
                <Thread since={since} now={now} />
              </>
            ) : null}
          </>
        ) : peek && peek.source === 'unknown' ? (
          // We hold no record of this chat at all — the app was killed rather
          // than quit, or it was parked past the sidecar's TTL. Deliberately
          // NOT the `none` line below: that one is about the runtime, and
          // saying it here would tell someone their Claude Code chat cannot
          // report messages. This says what is actually true — the messages are
          // gone from OUR records, not from the chat.
          <p className="m-0 text-meta leading-relaxed text-[color:var(--text-subtle)]">
            No record of this chat’s messages any more. Open it and the next one will be here.
          </p>
        ) : peek && peek.source === 'none' ? (
          // Identity only (mockup frame 8): OpenCode, Muse and a plain shell
          // report neither a prompt nor a transcript.
          //
          // This arm is LAST of the three, and the order is the whole point. It
          // used to be first, which meant a brand-new Claude Code chat — every
          // chat, for the seconds before its first prompt — was told its runtime
          // could not report messages, which is false and unfixable-looking. The
          // question the card answers in order is: are there messages? no —
          // then, is this runtime able to have any? Only a "no" to the second
          // is a statement about the runtime.
          <p className="m-0 text-meta leading-relaxed text-[color:var(--text-subtle)]">
            This runtime doesn’t report its messages. The model and session id above are everything it can say.
          </p>
        ) : peek ? (
          // A runtime that CAN report and simply has not yet. `source` is
          // `transcript` or `live` here, so this is an empty chat, not a
          // limited one.
          <p className="m-0 text-meta leading-relaxed text-[color:var(--text-subtle)]">
            {peek.source === 'live'
              ? 'Nothing sent since this app launched. This runtime hands us no transcript, so anything said before that is not ours to show.'
              : 'No messages yet. This chat opens on the composer — the first thing you send becomes its title.'}
          </p>
        ) : (
          // No answer and not loading: the preload has no reader (an older
          // main, a window that never got the API). Identity still stands.
          <p className="m-0 text-meta leading-relaxed text-[color:var(--text-subtle)]">
            The conversation isn’t readable from here.
          </p>
        )}
      </div>
    </>
  )
}
