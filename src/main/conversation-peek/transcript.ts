import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import type { ConversationPeekAttachment, ConversationPeekMessage } from '../../shared/conversation-peek'
import {
  MAX_PEEK_ATTACHMENTS,
  MAX_PEEK_FIRST_CHARS,
  MAX_PEEK_MESSAGE_CHARS,
  MAX_PEEK_MESSAGES,
} from '../../shared/conversation-peek'
import { pathExists } from '../filesystem-workspace'
import { forEachJsonlRow } from '../jsonl'
import {
  capPeekText,
  collapsePeekText,
  isTranscriptCommandInvocation,
  MAX_COLLAPSE_INPUT_CHARS,
  resolvePeekPath,
} from './text'

/**
 * Read the messages A PERSON sent out of a CLI's own JSONL transcript.
 *
 * The transcript is the only route to anything older than this app's launch —
 * the first message, the images pasted into it, the files dropped on it — and
 * it is an UNTRUSTED file written by another process. Containment matches
 * `automations/transcript-summary.ts` field for field (absolute, `.jsonl`,
 * `isFile()`, size cap, never throws) because it is the same threat: a path
 * chosen by a hook reporter.
 *
 * The hard part is not reading it, it is knowing which rows are a person.
 * Claude Code writes tool RESULTS as `role: 'user'` rows — they outnumber real
 * messages roughly 30:1 in a working session — and so does its own machinery:
 * background-task notifications, compaction summaries, `[Request interrupted by
 * user]`, the `[Image: source: …]` companion line, `<command-name>/compact`.
 * The filter below was written against real transcripts under
 * `~/.claude/projects/` rather than from the docs, and every clause names the
 * shape it was found to reject.
 *
 * Result is CACHED per path on size+mtime: hovering the same row twice must
 * cost one stat, not one full stream.
 *
 * MEMORY IS BOUNDED WHILE STREAMING, not afterwards. This runs in the main
 * process off a mouse hover, and a real transcript is tens to hundreds of
 * megabytes: accumulating every person-message and then discarding all but
 * fifty-one of them took the main process to hundreds of megabytes of transient
 * garbage to produce three thumbnails. So the reader keeps only what it will
 * answer with as rows arrive — the head message, a rolling window of the last
 * {@link MAX_PEEK_MESSAGES}, and image payloads for at most
 * {@link MAX_PEEK_ATTACHMENTS} images across the whole of it, each of them
 * capped.
 */

/**
 * Size cap applied before reading, matching the automations reader's ruling: a
 * long local session measured 83MB, so a tight cap would blank the peek for
 * exactly the chats with the most to show. This is an abuse guard — past it the
 * file is treated as not-a-transcript.
 */
const MAX_PEEK_TRANSCRIPT_BYTES = 256 * 1024 * 1024

/**
 * Transcripts whose parsed peek is kept. Small because each entry can retain a
 * few megabytes of image bytes (see `images` below), and because hovering is a
 * one-row-at-a-time gesture — a person sweeps the sidebar, they do not hold
 * forty cards open.
 */
const TRANSCRIPT_CACHE_ENTRIES = 8

/**
 * Total base64 image bytes retained per transcript so a thumbnail can be made
 * and the full image opened.
 *
 * Images are now retained ACROSS the conversation rather than for the first
 * message alone (2026-09-09): the card draws one strip of the chat's images, so
 * a screenshot pasted on the fortieth message is as openable as one pasted on
 * the first. The COUNT is what usually bounds this — at most
 * {@link MAX_PEEK_ATTACHMENTS} payloads are ever held, since that is all the
 * strip can list — and this byte ceiling is the second bound, for the case
 * where those eight are each enormous. Both are enforced by eviction rather
 * than refusal, so the payloads held are always the newest ones (see
 * {@link RetainedImages}).
 */
const MAX_RETAINED_IMAGE_BYTES = 16 * 1024 * 1024

/**
 * Largest single base64 image payload retained. A pasted retina screenshot
 * measured 300–650KB; this is generous room above that, and it exists because
 * `data` is an unbounded string in a file another process writes — without it
 * one row can cost more than every other bound put together. An image past it
 * still counts as an attachment (the card's count stays honest); it just has no
 * payload, so no thumbnail and nothing to open.
 */
const MAX_PEEK_IMAGE_BASE64_CHARS = 8 * 1024 * 1024

/**
 * Longest message text carried out of the stream. `collapsePeekText` applies the
 * same ceiling, but applying it HERE is what keeps a five-megabyte paste from
 * sitting in the rolling window until assembly.
 */
const MAX_RAW_MESSAGE_CHARS = MAX_COLLAPSE_INPUT_CHARS

/** Rows to look ahead for the `[Image: source: …]` line that names a pasted image. */
const IMAGE_LABEL_LOOKAHEAD_ROWS = 12

/** A pasted image, retained whole so the card can thumbnail it and the OS can open it. */
export type PeekImagePayload = {
  id: string
  /** `image/png`, `image/jpeg`, … as the transcript declared it. Untrusted. */
  mediaType: string
  /** Base64, exactly as the transcript carried it. */
  data: string
}

export type TranscriptPeek = {
  first: ConversationPeekMessage | null
  since: ConversationPeekMessage[]
  /** Payloads for the image attachments the caller may be asked to open, by id. */
  images: Map<string, PeekImagePayload>
}

type TranscriptRow = {
  type?: unknown
  uuid?: unknown
  timestamp?: unknown
  cwd?: unknown
  isSidechain?: unknown
  isMeta?: unknown
  isCompactSummary?: unknown
  isVisibleInTranscriptOnly?: unknown
  interruptedMessageId?: unknown
  toolUseResult?: unknown
  promptSource?: unknown
  origin?: { kind?: unknown } | null
  message?: { content?: unknown } | null
}

/** A base64 image block off a person's row, plus the name a later meta line gave it. */
type RawImage = { mediaType: string; data: string; label?: string }

/**
 * The image payloads the stream is currently holding, oldest first.
 *
 * A QUEUE and not a counter, because the rule is "the newest
 * {@link MAX_PEEK_ATTACHMENTS} images", which needs eviction. A counter that
 * simply refused everything past the eighth image gave the payloads to the
 * eight OLDEST images in the file, and then — as the rolling window released
 * those — to whatever happened to arrive next. Neither is the set the card
 * draws, so the strip listed images with no bytes behind them: live-looking
 * buttons that did nothing.
 *
 * Newest-wins is the honest rule for a hover surface, and it is the one that
 * can be implemented in a single pass over a file too big to hold: a payload
 * once dropped can never be recovered, so the only freedom the reader has is
 * which of the ones it is holding to let go of.
 *
 * Payloads are also released when the message carrying them falls out of the
 * rolling window, so the retained set is always a subset of the messages the
 * answer will contain.
 */
type RetainedImages = { bytes: number; queue: RawImage[] }

type RawMessage = {
  id: string
  /** Already clipped to {@link MAX_RAW_MESSAGE_CHARS}; the rest is counted, not held. */
  text: string
  /** Characters clipped off `text` before it entered the window. */
  overflowChars: number
  at: number
  cwd: string | null
  images: RawImage[]
}

type CacheEntry = { size: number; mtimeMs: number; peek: TranscriptPeek }

const cache = new Map<string, CacheEntry>()
// One in-flight read per path. Forty hovers down a sidebar while a big
// transcript streams must not start forty streams of the same file.
const inFlight = new Map<string, Promise<TranscriptPeek | null>>()

/**
 * The peek this transcript answers with, or null when the path is not an
 * absolute `.jsonl` file, is missing, is not a regular file, is over the size
 * cap, is unreadable, or carries no message a person sent.
 */
export async function readTranscriptPeek(
  transcriptPath: string,
  options: { home?: string | null } = {},
): Promise<TranscriptPeek | null> {
  if (!isAcceptableTranscriptPath(transcriptPath)) return null

  let size: number
  let mtimeMs: number
  try {
    const stats = await stat(transcriptPath)
    // isFile() also rejects a directory or a FIFO, which would otherwise stall
    // the streaming read forever.
    if (!stats.isFile() || stats.size > MAX_PEEK_TRANSCRIPT_BYTES) return null
    size = stats.size
    mtimeMs = stats.mtimeMs
  } catch {
    return null
  }

  const cached = cache.get(transcriptPath)
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
    // Refresh recency: the Map's insertion order is the eviction order below.
    cache.delete(transcriptPath)
    cache.set(transcriptPath, cached)
    return cached.peek
  }

  const existing = inFlight.get(transcriptPath)
  if (existing) return existing

  const read = streamTranscriptPeek(transcriptPath, options.home ?? null)
    .then((peek) => {
      if (peek) {
        cache.set(transcriptPath, { size, mtimeMs, peek })
        while (cache.size > TRANSCRIPT_CACHE_ENTRIES) {
          const oldest = cache.keys().next().value
          if (oldest === undefined) break
          cache.delete(oldest)
        }
      }
      return peek
    })
    .finally(() => {
      inFlight.delete(transcriptPath)
    })
  inFlight.set(transcriptPath, read)
  return read
}

/** Drops every cached transcript. Test seam; also the shutdown path's release. */
export function clearTranscriptPeekCache(): void {
  cache.clear()
}

async function streamTranscriptPeek(transcriptPath: string, home: string | null): Promise<TranscriptPeek | null> {
  // The whole answer, held while streaming: the message that started the chat,
  // and a rolling window of the most recent ones. Nothing between the two is
  // ever retained — a chat with two hundred messages costs the same as one with
  // fifty-two.
  let head: RawMessage | null = null
  const tail: RawMessage[] = []
  let sawAnyRow = false
  const retained: RetainedImages = { bytes: 0, queue: [] }
  // Ids in the ANSWER, so a transcript that repeats a row uuid — it is another
  // process's file, and nothing stops it — cannot give two messages the same
  // attachment ids. Two colliding ids meant one payload silently overwrote the
  // other in the map below, so a thumbnail showed, and a click opened, the
  // wrong picture. Bounded by the answer itself: entries leave with their
  // message.
  const usedIds = new Set<string>()

  // A pasted image arrives as a base64 block on the person's row, and the CLI
  // writes the file it came from a few rows later as a meta line
  // (`[Image: source: /…/Screenshot 2026-09-04 at 00.49.04.png]`). That line is
  // the only place the image's real name exists, so it is worth waiting a
  // bounded number of rows for — but only a bounded number, since a session
  // that never writes one must not make every later row a candidate.
  let awaitingLabels: { message: RawMessage; rowsLeft: number } | null = null

  try {
    await forEachJsonlRow(transcriptPath, (raw) => {
      sawAnyRow = true
      const row = raw as TranscriptRow
      if (awaitingLabels) {
        const labels = imageSourceLabels(row)
        if (labels.length > 0) {
          applyImageLabels(awaitingLabels.message, labels)
          awaitingLabels = null
        } else if (awaitingLabels.rowsLeft <= 0) {
          awaitingLabels = null
        } else {
          awaitingLabels.rowsLeft -= 1
        }
      }
      const message = personMessageFromRow(row)
      if (!message) return
      if (usedIds.has(message.id)) message.id = anonymousRowId()
      usedIds.add(message.id)

      // Every message's images are candidates for the strip, and retention is
      // applied at CAPTURE so the budget bounds the peak rather than describing
      // what survived.
      retainImages(message, retained)
      if (!head) {
        head = message
      } else {
        tail.push(message)
        if (tail.length > MAX_PEEK_MESSAGES) {
          // The message just left the answer, so its bytes leave the budget with
          // it and the next image down the file can take its place.
          const dropped = tail.shift()
          if (dropped) {
            releaseImages(dropped, retained)
            usedIds.delete(dropped.id)
          }
        }
      }
      if (message.images.length > 0) {
        awaitingLabels = { message, rowsLeft: IMAGE_LABEL_LOOKAHEAD_ROWS }
      }
    })
  } catch {
    return null
  }

  // A readable transcript with no person-message in it is NOT a failure: a chat
  // opened this morning and not yet spoken to has exactly this shape, and
  // answering null would make the card say the runtime cannot report when it
  // demonstrably can. Only an unreadable file answers null (above).
  if (!sawAnyRow && !head) return null
  return assemblePeek(head, tail, home)
}

/**
 * Keep this message's image bytes, evicting the oldest payloads held to make
 * room. An image whose payload is dropped keeps its place in the attachment
 * list — the count on its thread row stays true — it simply has nothing to
 * thumbnail or open, and the strip does not list it.
 *
 * A non-empty `data` is exactly "this payload is in the queue", which is what
 * makes {@link releaseImages} the reverse of this: an image the per-image
 * ceiling already emptied (see `readImageBlock`) was never queued.
 */
function retainImages(message: RawMessage, retained: RetainedImages): void {
  for (const image of message.images) {
    if (!image.data) continue
    // One image bigger than the whole budget can never be held, and trying
    // would empty the queue to make room for something that still does not fit.
    if (image.data.length > MAX_RETAINED_IMAGE_BYTES) {
      image.data = ''
      continue
    }
    while (
      retained.queue.length >= MAX_PEEK_ATTACHMENTS ||
      retained.bytes + image.data.length > MAX_RETAINED_IMAGE_BYTES
    ) {
      const oldest = retained.queue.shift()
      // Cannot happen after the ceiling check above — an empty queue always has
      // room — but the loop must not be able to spin if it ever could.
      if (!oldest) break
      retained.bytes -= oldest.data.length
      oldest.data = ''
    }
    retained.queue.push(image)
    retained.bytes += image.data.length
  }
}

/** Give a dropped message's payloads back to the budget. */
function releaseImages(message: RawMessage, retained: RetainedImages): void {
  for (const image of message.images) {
    if (!image.data) continue
    const at = retained.queue.indexOf(image)
    if (at >= 0) retained.queue.splice(at, 1)
    retained.bytes -= image.data.length
    image.data = ''
  }
}

async function assemblePeek(head: RawMessage | null, tail: RawMessage[], home: string | null): Promise<TranscriptPeek> {
  const images = new Map<string, PeekImagePayload>()
  const first = head ? await toPeekMessage(head, { maxChars: MAX_PEEK_FIRST_CHARS, home, retainImages: images }) : null
  const since = await Promise.all(
    tail.map((message) => toPeekMessage(message, { maxChars: MAX_PEEK_MESSAGE_CHARS, home, retainImages: images })),
  )
  return { first, since, images }
}

async function toPeekMessage(
  message: RawMessage,
  options: { maxChars: number; home: string | null; retainImages: Map<string, PeekImagePayload> | null },
): Promise<ConversationPeekMessage> {
  const collapsed = collapsePeekText(message.text)
  const capped = capPeekText(collapsed.text, options.maxChars)
  const attachments: ConversationPeekAttachment[] = []

  // Files are never squeezed out by images. A first message with eight
  // screenshots and two dropped files used to lose both files, and the file is
  // the half of the pair the person can act on — a chip is a filename and a
  // click, while the ninth thumbnail is one more picture of a screen. So the
  // files claim up to half the row before the images are laid out, and the
  // images report the remainder as a count instead.
  const fileReservation = Math.min(collapsed.paths.length, Math.floor(MAX_PEEK_ATTACHMENTS / 2))
  const imageSlots = MAX_PEEK_ATTACHMENTS - fileReservation

  message.images.forEach((image, index) => {
    if (attachments.length >= imageSlots) return
    const id = `${message.id}:image:${index}`
    attachments.push({ kind: 'image', id, label: image.label ?? `Image ${index + 1}` })
    // No payload means the image was past the streaming budget. It still
    // counts; it just has nothing to thumbnail or open.
    if (!options.retainImages || !image.data) return
    options.retainImages.set(id, { id, mediaType: image.mediaType, data: image.data })
  })

  for (const [index, token] of collapsed.paths.entries()) {
    if (attachments.length >= MAX_PEEK_ATTACHMENTS) break
    attachments.push({
      kind: 'file',
      id: `${message.id}:file:${index}`,
      label: token.label,
      path: await resolveExistingPeekPath(token.raw, message.cwd, options.home),
    })
  }

  return {
    id: message.id,
    text: capped.text,
    at: message.at,
    attachments,
    truncatedChars: capped.truncatedChars + collapsed.overflowChars + message.overflowChars,
  }
}

/**
 * The absolute path a chip should open, or null when there is nothing real to
 * point at.
 *
 * The existence check is the point, not an optimisation. A path token is a
 * GUESS about what the person attached: `foundations/tokens.css`, written while
 * talking about a design system, resolves against the session's cwd to
 * `<repo>/foundations/tokens.css`, which does not exist. Emitting that produced
 * a chip that looked live, showed a confident absolute path, and did nothing
 * when pressed — worse than no chip, because it claims the app knows something
 * it does not. A `null` path is a state the card already renders as an inert
 * label, so an unresolvable token degrades honestly.
 *
 * One `access` per attachment, at most {@link MAX_PEEK_ATTACHMENTS} per message,
 * and the result is cached with the parsed transcript.
 *
 * The residual guess this cannot remove: a relative token that happens to name
 * something real at the session's cwd but meant something else (`components/`
 * in a repo that also has a top-level `components/`). Existence is the best
 * signal available for a reference that was written relative to a directory
 * nobody recorded.
 */
async function resolveExistingPeekPath(token: string, cwd: string | null, home: string | null): Promise<string | null> {
  const candidate = resolvePeekPath(token, cwd, home)
  if (!candidate) return null
  return (await pathExists(candidate)) ? candidate : null
}

/**
 * The person's message this row carries, or null when the row is anything else.
 *
 * Every rejection below was observed in a real transcript:
 *  - `type !== 'user'` — assistant turns, `attachment` context injections, the
 *    `file-history-snapshot` and `ai-title` bookkeeping rows.
 *  - `isSidechain` — a Task subagent's conversation, whose prompts this app
 *    wrote, not the person.
 *  - `toolUseResult` / an all-`tool_result` content array — the dominant shape
 *    of a `user` row in a working session, and the reason a naive `role: user`
 *    filter shows a tool output as "what they said".
 *  - `isMeta` — the CLI talking to itself in the user's voice
 *    (`[Image: source: …]`, "Continue from where you left off.").
 *  - `isCompactSummary` / `isVisibleInTranscriptOnly` — the summary a compaction
 *    injects as the next user turn.
 *  - `interruptedMessageId` — `[Request interrupted by user]`, an event, not a
 *    message.
 *  - `origin.kind` other than `human` — newer Claude Code labels the author
 *    outright, and `task-notification` rows are `promptSource: 'system'`
 *    prompts that read exactly like a person's until you look.
 *
 * A `promptSource` of `sdk` IS kept. Those are the prompts a headless run was
 * driven with, and in such a session they are the only messages there are — a
 * card that showed nothing would be less honest than one that shows what drove
 * the conversation.
 */
function personMessageFromRow(row: TranscriptRow): RawMessage | null {
  if (row.type !== 'user') return null
  if (row.isSidechain === true) return null
  if (row.isMeta === true) return null
  if (row.isCompactSummary === true || row.isVisibleInTranscriptOnly === true) return null
  if (row.interruptedMessageId !== undefined && row.interruptedMessageId !== null) return null
  if (row.toolUseResult !== undefined && row.toolUseResult !== null) return null
  if (row.promptSource === 'system') return null

  const originKind = readOriginKind(row)
  if (originKind !== null && originKind !== 'human') return null

  const content = row.message?.content
  const parsed = readUserContent(content)
  if (!parsed) return null
  if (parsed.text && isTranscriptCommandInvocation(parsed.text)) return null
  if (!parsed.text.trim() && parsed.images.length === 0) return null

  // Clipped HERE rather than at collapse time: a five-megabyte paste must not
  // sit in the rolling window waiting for assembly.
  const text = parsed.text.length > MAX_RAW_MESSAGE_CHARS ? parsed.text.slice(0, MAX_RAW_MESSAGE_CHARS) : parsed.text

  return {
    // The row's own uuid, so an attachment id survives a re-read of a grown
    // transcript and a hover started before it keeps pointing at the same image.
    // A row with no uuid is given one off its own position in the window rather
    // than off a running count, which the reader no longer keeps.
    id: typeof row.uuid === 'string' && row.uuid ? row.uuid : anonymousRowId(),
    text,
    overflowChars: parsed.text.length - text.length,
    at: readTimestamp(row.timestamp),
    cwd: typeof row.cwd === 'string' && isAbsolute(row.cwd) ? row.cwd : null,
    images: parsed.images,
  }
}

// Monotonic within the process, for the transcript row that carries no uuid —
// and for the one whose uuid another row in the answer already used. An
// attachment id only has to be unique inside one peek, and this shape cannot
// collide with a real uuid.
let anonymousRowSeq = 0
function anonymousRowId(): string {
  anonymousRowSeq += 1
  return `row-${anonymousRowSeq}`
}

type ParsedContent = { text: string; images: RawImage[] }

function readUserContent(content: unknown): ParsedContent | null {
  if (typeof content === 'string') return { text: content, images: [] }
  if (!Array.isArray(content)) return null

  const texts: string[] = []
  const images: RawImage[] = []
  let sawToolResult = false
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const { type } = block as { type?: unknown }
    if (type === 'tool_result') {
      sawToolResult = true
      continue
    }
    if (type === 'text') {
      const { text } = block as { text?: unknown }
      if (typeof text === 'string' && text) texts.push(text)
      continue
    }
    if (type === 'image') {
      const image = readImageBlock(block as { source?: unknown })
      if (image) images.push(image)
    }
  }
  // A row whose blocks were ONLY tool results is a tool result, whatever its
  // role says. A row that mixes them (a person answering with a result inline)
  // keeps its text.
  if (sawToolResult && texts.length === 0 && images.length === 0) return null
  return { text: texts.join('\n'), images }
}

function readImageBlock(block: { source?: unknown }): RawImage | null {
  const source = block.source
  if (!source || typeof source !== 'object') return null
  const {
    type,
    media_type: mediaType,
    data,
  } = source as {
    type?: unknown
    media_type?: unknown
    data?: unknown
  }
  // Only base64 sources are carried: a URL source is a fetch this app has no
  // business making on a hover.
  if (type !== 'base64') return null
  if (typeof data !== 'string' || !data) return null
  return {
    // Over the per-image ceiling the payload is dropped but the image is kept:
    // `data` is an unbounded string in a file another process writes, and the
    // card's count must stay honest even when there is nothing to thumbnail.
    data: data.length > MAX_PEEK_IMAGE_BASE64_CHARS ? '' : data,
    mediaType:
      typeof mediaType === 'string' && /^image\/[a-z0-9.+-]{1,32}$/i.test(mediaType)
        ? mediaType.toLowerCase()
        : 'image/png',
  }
}

/**
 * The file names in a `[Image: source: /…/shot.png]` meta line, in order. Empty
 * for every other row, which is what makes it usable as the look-ahead test.
 */
function imageSourceLabels(row: TranscriptRow): string[] {
  if (row.type !== 'user' || row.isMeta !== true) return []
  const content = row.message?.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((block) =>
              block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
                ? String((block as { text?: unknown }).text ?? '')
                : '',
            )
            .join('\n')
        : ''
  if (!text.includes('[Image: source:')) return []
  const labels: string[] = []
  for (const match of text.matchAll(/\[Image: source:\s*([^\]\n]{1,1024})\]/g)) {
    const source = match[1]?.trim()
    if (!source) continue
    const name = source.split('/').pop()?.trim()
    if (name) labels.push(name)
  }
  return labels
}

function applyImageLabels(message: RawMessage, labels: string[]): void {
  message.images.forEach((image, index) => {
    const label = labels[index]
    if (label) image.label = label
  })
}

function readOriginKind(row: TranscriptRow): string | null {
  const origin = row.origin
  if (!origin || typeof origin !== 'object') return null
  const kind = (origin as { kind?: unknown }).kind
  return typeof kind === 'string' && kind ? kind : null
}

function readTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  // A row with no usable timestamp still belongs in the thread — the message
  // was said, we just cannot say when. 0 is the agreed "unknown" sentinel and
  // the renderer suppresses the relative time for it; it is NOT an epoch the
  // card may subtract from, which would read as "56y ago".
  return 0
}

function isAcceptableTranscriptPath(transcriptPath: unknown): transcriptPath is string {
  return (
    typeof transcriptPath === 'string' &&
    transcriptPath.endsWith('.jsonl') &&
    !transcriptPath.includes('\0') &&
    isAbsolute(transcriptPath)
  )
}
