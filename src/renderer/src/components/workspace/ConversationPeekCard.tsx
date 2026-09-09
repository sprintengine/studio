import React, { useLayoutEffect, useRef, useState } from 'react'

import CliIcon from '../CliIcon'
import {
  AgentWorkingDots,
  Badge,
  ContextRing,
  IconButton,
  LinkButton,
  MediaButton,
  Skeleton,
  Tooltip,
  TruncatedText,
} from '../ui'
import { FOCUS_RING_CLASS } from '../ui/tokens'
import { formatRelativeMs } from '../../utils/relativeTime'
import type { AgentCli } from '../../types/workspace'
import type { SessionContextUsage, SessionFileChange } from '../../../../shared/electron-api'
import type {
  ConversationPeek,
  ConversationPeekAttachment,
  ConversationPeekImage,
  ConversationPeekMessage,
} from '../../../../shared/conversation-peek'

// The conversation peek — one hover surface for "what is this chat", opened
// from a sidebar row and from an agent tab. Design:
// `backlog/mockups/2026-09-09-conversation-peek-one-thread.html`, which revises
// the 2026-09-07 sheet.
//
// This file is the PRESENTATIONAL half: identity in, markup out, no portal, no
// hover mechanics, no IPC — so it server-renders under the repo's static-markup
// test harness and so the two anchors (row, tab) can hold it in whichever shell
// they already own. `ConversationPeekPopover` and `AgentTabIdentityPopover` are
// the two shells; neither draws any of this itself.
//
// ONE AGENT PER CARD (owner, 2026-09-09). The roster of discs is gone: the
// sidebar already lists a chat's agents as its own sub-lines, so the person
// points at the one they mean and the card is that agent's — its files, its
// images, its thread, its corner. A selector inside a hover surface was solving
// a problem the surface it opens from had already solved.
//
// What is deliberately NOT here, because the design cut it: a footer, a "click
// to open · Esc dismisses" hint, a message count, the quoted first message
// under its own heading, and the "Since then" heading under that. The thread is
// one list with the first message as row one; two headings over one
// conversation were chrome explaining chrome.

/**
 * The chat's live state, in the corner's voice.
 *
 * `kind` and not a `Tone`, because the corner is not a status dot and never
 * was: it is the SIDEBAR's own mark — the working dots — and one word beside
 * them. Three kinds are all the corner can draw differently: dots and muted
 * ink, no dots and subtle ink, no dots and muted ink.
 */
export type ConversationPeekStatus = {
  /**
   * - `working` — the dots, and the word.
   * - `idle` — no dots, and the quieter ink: nothing is happening, and a chat
   *   at rest should not be as loud as one that is running.
   * - `attention` — no dots, muted ink. Waiting, Failed, Paused: states worth
   *   the same weight as Working without claiming motion that is not there.
   */
  kind: 'working' | 'idle' | 'attention'
  /** The one word (or short phrase) the corner says: "Working", "Idle · 12m", "Failed". */
  label: string
}

/**
 * The agent this card is about. One, always — see the file header.
 *
 * The three session figures below ride the identity rather than being read here
 * because the card is presentational and the shells already hold a session
 * snapshot (the sidebar) or an agent record (the tab). A component that fetched
 * its own would be a second source for facts the anchor is already drawing.
 */
export type ConversationPeekAgent = {
  /** What `readConversationPeek` is asked about. Already the unit of the contract. */
  sessionId: string
  /** Runtime id; null when unknown. */
  cli: AgentCli | null
  /** Launch model id; null → the CLI's own default. */
  model: string | null
  /**
   * What this session has edited, newest-edited first, from its own hooks.
   * Empty for a hookless runtime and for an agent that has written nothing —
   * and then the card draws no file list at all rather than an empty one.
   */
  fileChanges: SessionFileChange[]
  /** Subagents out right now. Replaces the corner's word while it is above zero. */
  activeSubagents: number
  /** Context-window usage, or null when nothing has reported any. Null draws no ring. */
  contextUsage: SessionContextUsage | null
}

export type ConversationPeekIdentity = {
  /** The chat's name — the tab's or the row's title. */
  name: string
  /** Sprint task the agent is claimed on, when applicable. */
  taskId: string | null
  /** The corner's state; null to omit it entirely. */
  status: ConversationPeekStatus | null
  /** The one agent whose conversation this card shows. */
  agent: ConversationPeekAgent
}

/**
 * Images shown in the strip before the rest are counted. The wire cap is
 * `MAX_PEEK_ATTACHMENTS` (8); six is what fits the card's measure beside a
 * "+N" without the strip wrapping into a second row.
 */
const MAX_THUMBNAILS = 6

/**
 * Thread rows before the list is masked at its top edge. The list scrolls at
 * `164px` — about six rows — so a seventh row is the first one that hides
 * something, and the fade is the only honest way to say so without a count.
 */
const THREAD_ROWS_BEFORE_FADE = 6

/**
 * Files listed as rows. Past this the list is not drawn at all: one quiet line
 * says how many there are and hands the whole thing to the diff, because a
 * hover is a glance and twenty-four rows is a review (mockup frame 4).
 */
const MAX_FILE_ROWS = 20

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
 * A path split for the file row: the name that carries the link, and the folder
 * that stays quiet behind it.
 *
 * Both separators, because a path off a hook on Windows carries backslashes and
 * a row that showed the whole of `C:\repo\src\main\thing.ts` as one "basename"
 * would be the row saying nothing. Exported for the tests, which is also the
 * only way to assert the Windows case from a suite that runs on posix.
 */
export function splitChangedPath(path: string): { name: string; folder: string } {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (cut < 0) return { name: path, folder: '' }
  return { name: path.slice(cut + 1), folder: path.slice(0, cut) }
}

/**
 * The corner: the sidebar's own working mark and one word, and nothing else
 * added for a state (mockup frame 2).
 *
 * Never a `StatusDot` — that was the shipped card's mistake and it is the whole
 * point of this revision. The row says "working" with three staggered dots; the
 * card saying it with a pulsing green disc six pixels away made two vocabularies
 * for one fact, and the reader has to learn both.
 *
 * Subagents REPLACE the word rather than adding to it: "2 running" is strictly
 * more than "Working" — it says the agent is working AND what it is doing — so
 * a card that said both would be spending a line on the weaker half.
 */
function LiveCorner({
  status,
  activeSubagents,
}: {
  status: ConversationPeekStatus
  activeSubagents: number
}) {
  const working = status.kind === 'working'
  const label = working && activeSubagents > 0
    ? `${activeSubagents} running`
    : status.label
  return (
    <span
      className={`ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap text-meta ${
        status.kind === 'idle'
          ? 'text-[color:var(--text-subtle)]'
          : 'text-[color:var(--text-muted)]'
      }`}
    >
      {working ? (
        <>
          {/* The dots carry the accessible name and the word beside them is
              decorative, so the state is announced once rather than twice.
              (`AgentWorkingDots` is `role="img"` with a label by construction —
              it is the sidebar's mark, and this is the same mark.) */}
          <AgentWorkingDots label={label} />
          <span aria-hidden="true">{label}</span>
        </>
      ) : (
        <span>{label}</span>
      )}
    </span>
  )
}

/**
 * One file this agent changed, as a link that opens its diff.
 *
 * `LinkButton` and not a row button: this is a name inside a list of names, and
 * the kit's link is the one member of the button family with no box, no control
 * height and no ground — which is what lets six of them read as a list rather
 * than as six controls. `underline="never"` because the underline collides with
 * the glyphs of a mono path (the primitive documents that exact case).
 *
 * The accessible name is the WHOLE path and the action: "Open the diff for
 * src/…/scheduler.ts". The visible row splits the path so the eye lands on the
 * basename, but "scheduler.ts" alone is not a name a person can act on when
 * three files in the list share it.
 */
function ChangedFileRow({
  change,
  onOpenDiff,
}: {
  change: SessionFileChange
  onOpenDiff: ((path: string | null) => void) | undefined
}) {
  const { name, folder } = splitChangedPath(change.path)
  return (
    <LinkButton
      layout="row"
      underline="never"
      // `size="inherit"` and the size on the row: the primitive's own
      // `text-meta` and a `text-micro` here are both font-size utilities, and
      // which one wins is stylesheet order rather than class order.
      size="inherit"
      className="gap-1 text-micro"
      aria-label={`Open the diff for ${change.path}`}
      onClick={(event) => {
        event.stopPropagation()
        onOpenDiff?.(change.path)
      }}
      disabled={!onOpenDiff}
    >
      <FileGlyph className="icon-xs shrink-0 self-center text-[color:var(--text-subtle)]" />
      <span className="max-w-[60%] shrink-0 truncate font-mono text-micro tracking-wide">{name}</span>
      {/* Truncated from the LEFT: the front of an absolute path is the part
          every row shares, and the end is the part that tells them apart.
          `dir="rtl"` with a left text-align is the one way to move an ellipsis
          to the head of a line that the browser will do for us.
          The LRMs are not decoration. In an RTL paragraph the neutral
          characters at the edges of an LTR run — the leading `/` of an
          absolute path, a trailing `.` — resolve to the paragraph direction
          and jump to the other end, so `/repo/src/main` renders as
          `repo/src/main/`. A left-to-right mark either side pins them to the
          run they belong to; the ellipsis still follows the element's own
          direction, which is the whole reason for the `rtl`. */}
      <span
        dir="rtl"
        className="min-w-0 flex-1 truncate text-left font-mono text-micro text-[color:var(--text-subtle)]"
      >
        {`‎${folder}‎`}
      </span>
      <span className="shrink-0 font-mono text-micro tabular-nums">
        <span className="text-[color:var(--tone-good)]">+{change.additions}</span>
        <span className="ml-1 text-[color:var(--tone-error)]">−{change.deletions}</span>
      </span>
    </LinkButton>
  )
}

/**
 * The files this agent changed, newest first — the ledger its own hooks kept,
 * not git's reading of the checkout, which several agents and the person all
 * share (see `SessionFileChange`).
 *
 * Nothing is drawn when nothing has been edited: a heading over an empty list
 * is the card describing its own absence.
 */
function ChangedFiles({
  changes,
  onOpenDiff,
}: {
  changes: SessionFileChange[]
  onOpenDiff: ((path: string | null) => void) | undefined
}) {
  if (changes.length === 0) return null
  if (changes.length > MAX_FILE_ROWS) {
    // Past the ceiling the list is not drawn at all. Twenty-four rows inside a
    // hover surface is a review, and the diff is the place a review happens —
    // so this is one quiet line that says how many and opens all of them.
    //
    // The count is the LEDGER's, which is itself capped
    // (MAX_SESSION_FILE_CHANGES), so a session that has touched more files than
    // that reports the cap. The line still points at the diff, which counts for
    // itself; what it must never do is claim a number smaller than the ledger's
    // and pass it off as the whole.
    return (
      <div className="px-3 pt-2">
        <LinkButton
          ink="quiet"
          size="inherit"
          className="text-micro"
          onClick={(event) => {
            event.stopPropagation()
            onOpenDiff?.(null)
          }}
          disabled={!onOpenDiff}
        >
          {changes.length} files changed · open the diff
        </LinkButton>
      </div>
    )
  }
  return (
    <div className="px-3 pt-2" role="group" aria-label="Files changed in this session">
      {/* Scrolls past about five rows rather than growing the card. The card
          must not resize while a pointer is travelling across it. */}
      <div className="flex max-h-[92px] flex-col gap-0.5 overflow-y-auto">
        {changes.map((change) => (
          <ChangedFileRow key={change.path} change={change} onOpenDiff={onOpenDiff} />
        ))}
      </div>
    </div>
  )
}

/**
 * A thumbnail button. It opens the image the way a path in the terminal already
 * does — which is why images live on the card and never in the thread tooltip:
 * a tooltip may hold nothing clickable, and a control needs a focus ring.
 */
function AttachmentThumbnail({
  attachment,
  onOpen,
}: {
  attachment: Extract<ConversationPeekAttachment, { kind: 'image' }>
  onOpen: ((attachmentId: string) => void) | undefined
}) {
  return (
    // The kit's one button whose SURFACE is content. It draws the hairline, the
    // radius, the `overflow-hidden` that gives the image the control's corners,
    // the press scale and the focus ring, and no ground or ink at all — which is
    // right, because the picture is the button's face.
    <MediaButton
      // 46×34 is the thumbnail's own aspect box, not spacing: a pasted
      // screenshot is landscape, and this is the smallest box that still reads
      // as one. No token names a media size, so the frame stays with the caller
      // — which is exactly the contract the primitive documents.
      className="h-[34px] w-[46px] shrink-0"
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
        // decode still in flight does not read as a broken image. The centring
        // lives on a span because the primitive is `block`: its child is
        // normally one image that fills it.
        <span className="flex h-full w-full items-center justify-center text-[color:var(--text-subtle)]">
          <ImageGlyph />
        </span>
      )}
    </MediaButton>
  )
}

/**
 * Every image sent in the conversation, in one strip (mockup frame 3) — not
 * only the first message's, which is what the shipped card drew and which meant
 * the screenshot someone pasted five minutes ago was unreachable while one from
 * yesterday sat at the top.
 *
 * Six, then a count. The strip must never wrap: a second row of thumbnails is
 * the card resizing under a pointer that is on its way to one of them.
 */
function ImageStrip({
  images,
  onOpen,
}: {
  images: ConversationPeekImage[]
  onOpen: ((attachmentId: string) => void) | undefined
}) {
  if (images.length === 0) return null
  const shown = images.slice(0, MAX_THUMBNAILS)
  const remainder = images.length - shown.length
  return (
    <div
      className="flex items-center gap-1.5 px-3 pt-2"
      role="group"
      aria-label="Images in this conversation"
    >
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
 * The thread: ONE list, oldest first, with the message that started the chat as
 * row one (owner, 2026-09-09). The card used to quote that message in full
 * under a "First message" heading and then start a second list under a "Since
 * then" heading, which spent a third of the surface on two labels and made the
 * conversation read as two things.
 *
 * The list scrolls, so it has to be scrolled to its END on arrival: left alone
 * it opened at `scrollTop = 0`, showing the oldest messages while the one
 * marked "now" sat off-screen below — under a fade drawn across the top edge,
 * which then claimed there was more above when the hidden half was all below.
 * Newest last and in view is the ruling; the fade means "older messages are up
 * there", and this is what makes that true.
 *
 * `useLayoutEffect`, so the jump happens before the first paint rather than as
 * a visible scroll.
 */
function Thread({ messages, now }: { messages: ConversationPeekMessage[]; now: number }) {
  const listRef = useRef<HTMLOListElement>(null)
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    list.scrollTop = list.scrollHeight
  }, [messages])
  return (
    <ol
      ref={listRef}
      className={`conversation-peek-thread m-0 flex max-h-[164px] list-none flex-col gap-1.5 overflow-y-auto px-3 pb-2.5 pt-2 ${
        messages.length > THREAD_ROWS_BEFORE_FADE ? 'conversation-peek-thread--faded' : ''
      }`}
    >
      {messages.map((message, index) => (
        <ThreadRow
          key={message.id}
          message={message}
          now={now}
          newest={index === messages.length - 1}
        />
      ))}
    </ol>
  )
}

/** The body's non-thread arms — a sentence, in the body's own inset. */
function BodyNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="m-0 px-3 pb-2.5 pt-2 text-meta leading-relaxed text-[color:var(--text-subtle)]">
      {children}
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
  onOpenDiff,
}: {
  identity: ConversationPeekIdentity
  peek: ConversationPeek | null
  loading: boolean
  now: number
  copied: boolean
  onCopySession: () => void
  /** Absent when the preload has no opener — the thumbnails then render inert rather than lying. */
  onOpenAttachment?: (attachmentId: string) => void
  /**
   * Open the diff for one path, or — with `null` — the whole diff. The shell
   * wires this to the workspace's pane, because a path only means something
   * against a workspace and this component knows of none.
   */
  onOpenDiff?: (path: string | null) => void
}) {
  const agent = identity.agent
  // One list, first message included. `first` is still its own field on the
  // wire (main pairs it with a longer character cap), so this is where the two
  // halves become the one thread the design asks for.
  const messages = peek ? (peek.first ? [peek.first, ...peek.since] : peek.since) : []
  return (
    <>
      <div className="flex items-center gap-2 border-b border-[color:var(--border-subtle)] px-3 py-2.5">
        {agent.cli ? (
          <CliIcon cli={agent.cli} className="icon-sm shrink-0 text-[color:var(--text-strong)]" />
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
        {/* Beside the title, before the corner. Absent — not zero — when
            nothing has reported a reading: a ring at 0% and a ring for a
            runtime that reports none are the same picture. */}
        {agent.contextUsage ? (
          <ContextRing usedPercentage={agent.contextUsage.usedPercentage} layer="menu" />
        ) : null}
        {identity.status ? (
          <LiveCorner status={identity.status} activeSubagents={agent.activeSubagents} />
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-3 pb-1 pt-2.5">
        <Badge className="max-w-full">
          <span className="truncate font-mono">{agent.model ?? 'CLI default'}</span>
        </Badge>
        {identity.taskId ? (
          <Badge>
            <span className="font-mono tabular-nums">{identity.taskId}</span>
          </Badge>
        ) : null}
        {agent.sessionId ? (
          // The copy control sits BESIDE the chip, not inside it: a badge is
          // display-only by spec (design-system/components/badge — "never
          // interactive"), and the one thing on this card you press to take a
          // value away with you should be a real button with a real focus ring.
          <span className="inline-flex min-w-0 max-w-full items-center gap-0.5">
            <Badge ariaLabel={`Session ${agent.sessionId}`}>
              <span className="font-mono tabular-nums">{elideSessionId(agent.sessionId)}</span>
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

      <ChangedFiles changes={agent.fileChanges} onOpenDiff={onOpenDiff} />
      <ImageStrip images={peek?.images ?? []} onOpen={onOpenAttachment} />

      {loading && !peek ? (
        <div className="flex flex-col gap-1.5 px-3 pb-2.5 pt-2" aria-label="Reading the conversation" role="status">
          <Skeleton className="h-2.5 w-full rounded-sm bg-[color:var(--bg-hover)]" />
          <Skeleton className="h-2.5 w-4/5 rounded-sm bg-[color:var(--bg-hover)]" />
          <Skeleton className="h-2.5 w-2/3 rounded-sm bg-[color:var(--bg-hover)]" />
        </div>
      ) : messages.length > 0 ? (
        <>
          <Thread messages={messages} now={now} />
          {/* A `live` peek is prompts seen since this app launched, not the
              chat's history, and a reader who is not told that reads a
              truncated conversation as the whole one. One quiet line under the
              thread — never a heading, which is what the two labels this
              revision removed were. */}
          {peek?.source === 'live' ? (
            <p className="m-0 px-3 pb-2.5 text-micro text-[color:var(--text-subtle)]">
              Since this app launched — this runtime hands us no transcript.
            </p>
          ) : null}
        </>
      ) : peek && peek.source === 'unknown' ? (
        // We hold no record of this chat at all — the app was killed rather
        // than quit, or it was parked past the sidecar's TTL. Deliberately
        // NOT the `none` line below: that one is about the runtime, and
        // saying it here would tell someone their Claude Code chat cannot
        // report messages. This says what is actually true — the messages are
        // gone from OUR records, not from the chat.
        <BodyNote>
          No record of this chat’s messages any more. Open it and the next one will be here.
        </BodyNote>
      ) : peek && peek.source === 'none' ? (
        // Identity only: OpenCode, Muse and a plain shell report neither a
        // prompt nor a transcript.
        //
        // This arm is LAST of the three, and the order is the whole point. It
        // used to be first, which meant a brand-new Claude Code chat — every
        // chat, for the seconds before its first prompt — was told its runtime
        // could not report messages, which is false and unfixable-looking. The
        // question the card answers in order is: are there messages? no —
        // then, is this runtime able to have any? Only a "no" to the second
        // is a statement about the runtime.
        <BodyNote>
          This runtime doesn’t report its messages. The model and session id above are everything it can say.
        </BodyNote>
      ) : peek ? (
        // A runtime that CAN report and simply has not yet. `source` is
        // `transcript` or `live` here, so this is an empty chat, not a
        // limited one.
        <BodyNote>
          {peek.source === 'live'
            ? 'Nothing sent since this app launched. This runtime hands us no transcript, so anything said before that is not ours to show.'
            : 'No messages yet. This chat opens on the composer — the first thing you send becomes its title.'}
        </BodyNote>
      ) : (
        // No answer and not loading: the preload has no reader (an older
        // main, a window that never got the API). Identity still stands.
        <BodyNote>The conversation isn’t readable from here.</BodyNote>
      )}
    </>
  )
}
