import type { SessionPrompt } from '../../shared/electron-api'
import type {
  ConversationPeek,
  ConversationPeekAttachment,
  ConversationPeekImage,
  ConversationPeekMessage,
} from '../../shared/conversation-peek'
import {
  emptyConversationPeek,
  MAX_PEEK_ATTACHMENTS,
  MAX_PEEK_FIRST_CHARS,
  MAX_PEEK_MESSAGE_CHARS,
  MAX_PEEK_MESSAGES,
} from '../../shared/conversation-peek'
import { capPeekText, collapsePeekText } from './text'
import type { PeekImagePayload, TranscriptPeek } from './transcript'

/**
 * Answer "what has actually been said in this chat" for a session the person is
 * hovering, and open what they attached to it.
 *
 * Two sources, in that order, and the answer says which one it used because the
 * card degrades visibly rather than silently:
 *
 *  - the CLI's own transcript, when its turn-end hook has handed us a path to
 *    one. This is the whole history: the first message, everything since, the
 *    images and the files.
 *  - the prompts THIS APP has seen since launch, for a runtime that reports
 *    `UserPromptSubmit` but hands us no transcript (Codex, Grok, Kimi Code).
 *    Text only — a prompt frame carries no attachments — and only as far back as
 *    the app's own launch, which is precisely why it is labelled `live` and not
 *    passed off as the history.
 *
 * WE PERSIST NOTHING. The live list lives on the session object and dies with
 * it; the transcript belongs to the CLI and is only ever read. That is a
 * deliberate product ruling, not an oversight: a prompt is the most sensitive
 * thing a person types into this app, and the app that never wrote it down
 * cannot leak it.
 *
 * Electron-free by construction — every effect (reading a file, making a
 * thumbnail, opening something) arrives as a dependency, so the assembly rules
 * are testable without a runtime.
 */

/**
 * Prompts retained per session for the live fallback: the message that started
 * the chat, plus enough recent ones to fill the thread the card can draw.
 * Anything between the two is dropped as it arrives rather than at render time,
 * so a session that has run for a week costs a fixed handful of strings.
 */
export const MAX_LIVE_PEEK_PROMPTS = MAX_PEEK_MESSAGES + 1

/**
 * `prompts` with `text` appended, trimmed to {@link MAX_LIVE_PEEK_PROMPTS}.
 *
 * The FIRST entry is never dropped. It is the one the card quotes in full, and
 * a card whose "First message" was actually the fiftieth would be worse than
 * one with no first message at all — so the trim eats the second-oldest and
 * leaves the head alone.
 */
export function appendLivePeekPrompt(prompts: SessionPrompt[] | undefined, text: string, at: number): SessionPrompt[] {
  const next = [...(prompts ?? []), { text, at }]
  if (next.length <= MAX_LIVE_PEEK_PROMPTS) return next
  const [first] = next
  return [first, ...next.slice(next.length - (MAX_LIVE_PEEK_PROMPTS - 1))]
}

/** What the terminal runtime knows about a session, and all this module asks of it. */
export type ConversationPeekSessionState = {
  /**
   * The CLI's transcript, as its turn-end hook last reported it. Absent until
   * the first turn ends, and for every runtime that reports no transcript.
   * A hook-reported path ALWAYS wins over a derived one: the CLI named it.
   *
   * Read only when {@link claudeHarness} — this module parses one transcript
   * shape, and the hook contract carries a path, not a format. Codex reports
   * one too, for a rollout file nothing here can read.
   */
  transcriptPath?: string
  /** The CLI's own session id, which is also its transcript's file name. */
  cliSessionId?: string
  /**
   * The directory the CLI was LAUNCHED in — the worktree path where the agent
   * runs in one, otherwise its spawn cwd. Deliberately not the observed cwd:
   * the folder a transcript lives in is fixed at launch and does not follow a
   * `cd` (see conversation-peek/locate.ts).
   */
  launchCwd?: string
  /**
   * True when this runtime writes Claude-shaped transcripts under
   * `~/.claude/projects` — the plugin manifest's `harnessId === 'claude'`, which
   * is Claude Code, Z.ai and Kimi (Claude), all running the same binary. Codex,
   * Grok, Kimi Code, OpenCode and Muse are false and must never have a
   * Claude-shaped path invented for them.
   */
  claudeHarness?: boolean
  /**
   * True when this runtime reports the person's messages at all — it keeps a
   * transcript, or its manifest declares the hook event that carries a prompt.
   * This is what separates "nothing said yet" from "cannot say": a Claude Code
   * chat hovered before its first prompt has nothing to show and must NOT be
   * reported as `none`, or the card tells the reader that Claude Code does not
   * report its messages. False for OpenCode, Muse and a plain shell, which is
   * the only thing `none` is for.
   */
  reportsMessages?: boolean
  /** Prompts seen since launch, oldest first. Empty for a hookless runtime. */
  prompts: SessionPrompt[]
}

export type ConversationPeekDependencies = {
  /** The live session's peek inputs, or null when no such session exists. */
  readSessionState(
    sessionId: string,
  ): ConversationPeekSessionState | null | Promise<ConversationPeekSessionState | null>
  /** Streams and parses a transcript. Null for anything unreadable — never throws. */
  readTranscript(transcriptPath: string): Promise<TranscriptPeek | null>
  /**
   * Recovers the transcript a Claude-family session would have written, for the
   * sessions whose turn-end hook has not named one — a chat parked yesterday,
   * or any chat at all after an app restart. Null when there is nothing to
   * point at; never throws.
   */
  locateTranscript(input: { cliSessionId: string; launchCwd?: string | null }): Promise<string | null>
  /** A small PNG data URL for a retained image, or null when it will not decode. */
  renderThumbnail(image: PeekImagePayload): string | null
  /** Hands a retained image to the OS image viewer. */
  openImage(image: PeekImagePayload): Promise<void>
  /** Shows a path in the OS file manager. */
  revealFile(filePath: string): Promise<void>
}

export type ConversationPeekService = {
  readConversationPeek(sessionId: string): Promise<ConversationPeek>
  openConversationPeekAttachment(sessionId: string, attachmentId: string): Promise<void>
}

/**
 * Sessions whose openable attachments are remembered between a read and a
 * click. Only a handful of cards can be open at once, and a session that falls
 * out is re-armed by the hover that precedes any click on it.
 */
const OPENABLE_SESSIONS = 8

type Openable = { kind: 'image'; image: PeekImagePayload } | { kind: 'file'; path: string }

export function createConversationPeekService(deps: ConversationPeekDependencies): ConversationPeekService {
  // Attachment id → what to open, per session. Rebuilt by every read, so an id
  // from a stale card cannot resolve to a file a later read did not offer.
  const openable = new Map<string, Map<string, Openable>>()

  const arm = (sessionId: string, entries: Map<string, Openable>): void => {
    openable.delete(sessionId)
    openable.set(sessionId, entries)
    while (openable.size > OPENABLE_SESSIONS) {
      const oldest = openable.keys().next().value
      if (oldest === undefined) break
      openable.delete(oldest)
    }
  }

  return {
    async readConversationPeek(sessionId: string): Promise<ConversationPeek> {
      // An unusable id is a caller bug, not a runtime that cannot report — the
      // same reason the missing-state case below is `unknown`.
      if (typeof sessionId !== 'string' || !sessionId) {
        return { sessionId: '', source: 'unknown', first: null, since: [], images: [] }
      }
      const state = await deps.readSessionState(sessionId)
      // No state for this id — killed rather than quit (no sidecar written), or
      // parked past the sidecar TTL. `unknown`, never `none`: we know nothing
      // about this chat's messages, which is not the same as knowing its
      // runtime cannot report them.
      if (!state) return { sessionId, source: 'unknown', first: null, since: [], images: [] }

      // The hook's own path first; only then the derived one — and BOTH only for
      // a runtime that actually writes Claude-shaped transcripts, because this
      // reader only understands that shape.
      //
      // The harness gate covers the hook-reported path too, which it did not
      // used to: a hook naming a file is not a promise about its format. Codex
      // forwards `transcript_path` on its Stop hook exactly as Claude does, and
      // it points at its own rollout JSONL — a readable file, hundreds of rows,
      // not one of them a Claude person-message. Reading it answered
      // "transcript, and it is empty" for a chat with a full history, and, worse,
      // returned before the live prompts below, which we HAD watched go by. A
      // Codex chat therefore claimed to have no messages while its own title was
      // its first one.
      const transcriptPath = state.claudeHarness
        ? (state.transcriptPath ??
          (state.cliSessionId
            ? await deps.locateTranscript({ cliSessionId: state.cliSessionId, launchCwd: state.launchCwd ?? null })
            : null))
        : null

      if (transcriptPath) {
        const transcript = await deps.readTranscript(transcriptPath)
        // Something IN it, not merely a readable file: an empty transcript is
        // not an answer worth preferring over prompts this app saw itself (a
        // resumed chat whose first turn has not ended, a file the CLI has yet
        // to flush). With no prompts either, the `claudeHarness` arm at the
        // bottom returns the same empty `transcript` peek this one would have.
        if (transcript && (transcript.first || transcript.since.length > 0)) {
          const entries = new Map<string, Openable>()
          const first = transcript.first
            ? withThumbnails(transcript.first, transcript.images, entries, deps.renderThumbnail)
            : null
          const since = transcript.since.map((message) =>
            withThumbnails(message, transcript.images, entries, deps.renderThumbnail),
          )
          arm(sessionId, entries)
          return {
            sessionId,
            source: 'transcript',
            first,
            since,
            images: imageStrip(first, since, entries),
          }
        }
      }

      arm(sessionId, new Map())

      // The transcript said nothing usable — a runtime that keeps none, a turn
      // that has not ended yet, a file that has gone. What this app saw itself
      // is still true, so it is still worth showing.
      const live = livePeek(sessionId, state.prompts)
      if (live) return live

      // Nothing to show. WHICH nothing matters: a runtime that can report and
      // has not yet keeps its own source and an empty body, so the card says
      // "no messages yet" rather than "this runtime doesn't report its
      // messages" about Claude Code. Only a runtime that genuinely cannot
      // report — OpenCode, Muse, a plain shell — is `none`.
      if (state.claudeHarness) return { sessionId, source: 'transcript', first: null, since: [], images: [] }
      if (state.reportsMessages) return { sessionId, source: 'live', first: null, since: [], images: [] }
      return emptyConversationPeek(sessionId)
    },

    async openConversationPeekAttachment(sessionId: string, attachmentId: string): Promise<void> {
      const entry = openable.get(sessionId)?.get(attachmentId)
      // Not an error worth surfacing: the card was re-read, or the attachment
      // belongs to a message whose payload is deliberately not retained. The
      // click simply does nothing rather than raising a dialog about an id.
      if (!entry) return
      if (entry.kind === 'image') {
        await deps.openImage(entry.image)
        return
      }
      await deps.revealFile(entry.path)
    },
  }
}

/**
 * Copy of `message` whose image attachments carry a thumbnail, registering each
 * openable attachment as it goes. Attachments whose payload was not retained
 * (every message but the first) keep their id and label and get no thumbnail —
 * the card counts them on the row rather than drawing them.
 */
function withThumbnails(
  message: ConversationPeekMessage,
  images: Map<string, PeekImagePayload>,
  entries: Map<string, Openable>,
  renderThumbnail: (image: PeekImagePayload) => string | null,
): ConversationPeekMessage {
  const attachments = message.attachments.map((attachment): ConversationPeekAttachment => {
    if (attachment.kind === 'file') {
      if (attachment.path) entries.set(attachment.id, { kind: 'file', path: attachment.path })
      return attachment
    }
    const image = images.get(attachment.id)
    if (!image) return attachment
    entries.set(attachment.id, { kind: 'image', image })
    const thumbnailDataUrl = renderThumbnail(image)
    return thumbnailDataUrl ? { ...attachment, thumbnailDataUrl } : attachment
  })
  return { ...message, attachments }
}

/**
 * The conversation's images as one strip, oldest first.
 *
 * A flat re-listing of attachments that already sit on their messages — the
 * same objects, so the strip and the rows carry the same ids and open the same
 * things, and the openable table needs no second set of entries. Built here
 * rather than in the transcript reader because it is the THUMBNAILED,
 * ARMED attachments the card wants, and both are this layer's job.
 *
 * ONLY IMAGES THERE IS SOMETHING TO OPEN. An image whose payload the reader
 * could not keep — one over the per-image ceiling, one evicted by newer images,
 * one in a message whose slots went to files — still counts on its own thread
 * row, because the message did carry it. It must not reach the strip: a
 * thumbnail with no bytes behind it is a live-looking button that silently does
 * nothing when pressed, which is worse than not drawing it. The row's count
 * stays the honest record that it existed.
 *
 * The cap is the same {@link MAX_PEEK_ATTACHMENTS} the reader retains to, so
 * the two agree by construction; the card's "+N" therefore counts the images on
 * this strip, never the chat's unknowable total.
 */
function imageStrip(
  first: ConversationPeekMessage | null,
  since: ConversationPeekMessage[],
  openable: Map<string, Openable>,
): ConversationPeekImage[] {
  const images: ConversationPeekImage[] = []
  for (const message of first ? [first, ...since] : since) {
    for (const attachment of message.attachments) {
      if (attachment.kind !== 'image') continue
      if (!openable.has(attachment.id)) continue
      if (images.length >= MAX_PEEK_ATTACHMENTS) return images
      images.push(attachment)
    }
  }
  return images
}

/**
 * The peek built from prompts this app watched go by, or null when it watched
 * none. Text only: a `UserPromptSubmit` frame carries the words and nothing
 * else, so a live card never shows an attachment — and never pretends to.
 */
function livePeek(sessionId: string, prompts: SessionPrompt[]): ConversationPeek | null {
  const messages = prompts
    .map((prompt, index) => livePeekMessage(prompt, index, index === 0))
    .filter((message): message is ConversationPeekMessage => message !== null)
  if (messages.length === 0) return null
  const [first, ...rest] = messages
  // No strip: a `UserPromptSubmit` frame carries the words and nothing else.
  return { sessionId, source: 'live', first, since: rest.slice(-MAX_PEEK_MESSAGES), images: [] }
}

function livePeekMessage(prompt: SessionPrompt, index: number, isFirst: boolean): ConversationPeekMessage | null {
  if (!prompt || typeof prompt.text !== 'string') return null
  const collapsed = collapsePeekText(prompt.text)
  if (!collapsed.text.trim()) return null
  const capped = capPeekText(collapsed.text, isFirst ? MAX_PEEK_FIRST_CHARS : MAX_PEEK_MESSAGE_CHARS)
  return {
    // Positional. Once the list is at its cap the middle is trimmed and these
    // shift, which is tolerable only because nothing resolves a live id: a
    // prompt frame carries no attachment, so the id is a React key and nothing
    // more. The transcript route, where ids DO open things, uses row uuids.
    id: `live:${index}`,
    text: capped.text,
    // 0 is the agreed "time unknown" sentinel, not an epoch to subtract from.
    at: typeof prompt.at === 'number' && Number.isFinite(prompt.at) ? prompt.at : 0,
    // A dropped path in a live prompt is a path we cannot show a chip for: the
    // frame carries no cwd, so a relative one has nothing to resolve against
    // and an absolute one would still be a guess about what was attached
    // versus what was merely mentioned. The transcript route answers that
    // properly; this one stays text.
    attachments: [],
    truncatedChars: capped.truncatedChars + collapsed.overflowChars,
  }
}
