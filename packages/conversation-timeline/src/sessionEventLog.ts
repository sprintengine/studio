// What a chat keeps of a conversation's event log in memory, and how it keeps
// it small: every sequence number it has seen as ranges rather than one entry
// each, and each settled run of streamed tokens as one event.

import type { ConversationEvent } from './protocol.js'

/**
 * The sequence numbers a session has taken in, as sorted, disjoint, inclusive
 * ranges. Live events arrive one number after the last, so a whole session is
 * usually one range however long it runs; a page of earlier turns adds one
 * below it that meets it once the gap is filled.
 */
export class SeqRanges {
  private starts: number[] = []
  private ends: number[] = []

  /** Index of the range holding `seq`, or of the first range above it, negated minus one. */
  private locate(seq: number): number {
    let low = 0
    let high = this.starts.length - 1
    while (low <= high) {
      const middle = (low + high) >> 1
      if (seq < this.starts[middle]!) high = middle - 1
      else if (seq > this.ends[middle]!) low = middle + 1
      else return middle
    }
    return -low - 1
  }

  has(seq: number): boolean {
    return this.locate(seq) >= 0
  }

  add(seq: number): this {
    // The common case: the next number after everything seen.
    const last = this.ends.length - 1
    if (last >= 0 && seq === this.ends[last]! + 1) {
      this.ends[last] = seq
      return this
    }
    const found = this.locate(seq)
    if (found >= 0) return this
    const at = -found - 1
    const joinsBelow = at > 0 && this.ends[at - 1]! + 1 === seq
    const joinsAbove = at < this.starts.length && this.starts[at]! - 1 === seq
    if (joinsBelow && joinsAbove) {
      this.ends[at - 1] = this.ends[at]!
      this.starts.splice(at, 1)
      this.ends.splice(at, 1)
    } else if (joinsBelow) this.ends[at - 1] = seq
    else if (joinsAbove) this.starts[at] = seq
    else {
      this.starts.splice(at, 0, seq)
      this.ends.splice(at, 0, seq)
    }
    return this
  }

  clear(): void {
    this.starts = []
    this.ends = []
  }

  /** How many ranges are held; for tests and diagnostics. */
  get rangeCount(): number {
    return this.starts.length
  }
}

// The payload fields a streamed token's fold reads. A token carrying anything
// else (a notice riding on it, a field a later provider adds) is left alone.
const TOKEN_FIELDS = new Set(['turnId', 'text', 'delta'])

function tokenText(event: ConversationEvent): string | null {
  const payload = event.payload
  if (!payload) return null
  for (const key of Object.keys(payload)) if (!TOKEN_FIELDS.has(key)) return null
  if (typeof payload.turnId !== 'string' || !payload.turnId) return null
  // The fold reads `text`, then `delta`, and skips an empty string.
  const text = payload.text
  if (typeof text === 'string' && text) return text
  const delta = payload.delta
  if (typeof delta === 'string' && delta) return delta
  if ((text === undefined || typeof text === 'string') && (delta === undefined || typeof delta === 'string')) return ''
  return null
}

function joins(previous: ConversationEvent, next: ConversationEvent): boolean {
  return (
    previous.type === next.type &&
    previous.sessionId === next.sessionId &&
    previous.modelId === next.modelId &&
    previous.providerId === next.providerId &&
    previous.payload?.turnId === next.payload?.turnId
  )
}

/**
 * The log with each run of adjacent tokens of one turn — `content_delta`s, or
 * `reasoning_delta`s — merged into one event, which the transcript folds
 * exactly as it folded the run: the text is the run's text in order, the time
 * is the run's first (a reasoning window opens, and a reply closes one, at the
 * first token), and the number is the run's last, as main numbers the runs it
 * merges. The event log on disk already stores runs merged; a renderer that
 * keeps them one per token holds about half a kilobyte for every word a long
 * session streamed.
 *
 * A reasoning run's first token opens a new paragraph with its leading
 * whitespace trimmed; merging a whitespace-only first token would trim the
 * next token's too, so that one token stays on its own.
 *
 * Returns `events` itself when nothing merged. Only `events[from…]` is looked
 * at, so a caller can compact what arrived since it last did.
 */
export function compactTokenRuns(events: ConversationEvent[], from = 0): ConversationEvent[] {
  let out: ConversationEvent[] | null = null
  let index = Math.max(0, from)
  while (index < events.length) {
    const first = events[index]!
    const firstText = first.type === 'content_delta' || first.type === 'reasoning_delta' ? tokenText(first) : null
    let end = index + 1
    if (firstText !== null) {
      while (end < events.length && joins(first, events[end]!) && tokenText(events[end]!) !== null) end++
    }
    // A whitespace-only opening token of a reasoning run keeps its own event.
    const start = firstText !== null && first.type === 'reasoning_delta' && !/\S/u.test(firstText) ? index + 1 : index
    if (end - start < 2) {
      if (out) for (let cursor = index; cursor < end; cursor++) out.push(events[cursor]!)
      index = end
      continue
    }
    out ??= events.slice(0, index)
    if (start > index) out.push(first)
    let text = ''
    for (let cursor = start; cursor < end; cursor++) text += tokenText(events[cursor]!)!
    const head = events[start]!
    const tail = events[end - 1]!
    out.push({
      ...head,
      ...(tail.seq !== undefined ? { seq: tail.seq } : {}),
      payload: { turnId: head.payload!.turnId, text },
    })
    index = end
  }
  return out ?? events
}
