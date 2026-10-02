// Replay: a finished conversation played back the way it was had, for reading
// it to a room. The transcript's own fold draws it — the replay only decides
// how much of the log the fold is shown, and when it is shown the next piece —
// so a replayed turn looks exactly like the turn did live: the working line,
// the reply streaming in, each tool running and then settling.
//
// Everything here is pure: the script a log is cut into, the player's moves
// over it, and the clock a replayed turn is re-timed to. The view that drives
// them is `conversationReplayView.tsx`.

import type {
  ConversationEvent,
  ConversationKey,
  ConversationPageResult,
} from '../../../../../shared/conversation-runtime'
import { readString } from './conversationProjection'
import { compactTokenRuns } from './sessionEventLog'

/**
 * A log cut into the steps a replay reveals one at a time. `delays[i]` is how
 * long the player waits, at 1×, before it reveals `events[i]`. `prompts` holds
 * the positions the player stops at: just past each user message, so a stop
 * shows the message and none of its reply.
 */
export type ReplayScript = {
  events: ConversationEvent[]
  delays: number[]
  prompts: number[]
}

/** Reading pace, in words a second at 1×: a reply streams a little faster than
 *  a room reads it aloud, and thinking, which rests folded, streams faster. */
const REPLY_WORDS_PER_SECOND = 12
const REASONING_WORDS_PER_SECOND = 48
/** Words a reply chunk carries. Few enough that the reply reads as streaming
 *  rather than arriving in slabs; enough that a long one is not thousands of
 *  renders. */
const WORDS_PER_CHUNK = 3
const REASONING_WORDS_PER_CHUNK = 8

/** The beat before each kind of event, at 1×. What is not listed costs nothing:
 *  bookkeeping (usage, session state) rides along with the step before it. */
const BEAT_MS: Partial<Record<ConversationEvent['type'], number>> = {
  // The pause between one reply ending and the next message appearing, when
  // the player is not stopping at messages.
  user_message: 900,
  turn_started: 450,
  tool_started: 350,
  tool_output: 550,
  approval_requested: 500,
  approval_resolved: 700,
  subagent_status: 250,
  subagent_message: 250,
  context_compacted: 400,
  command_output: 400,
  turn_completed: 200,
  turn_failed: 200,
}

/** Speeds the player offers, as multipliers of reading pace. */
export const REPLAY_SPEEDS = [1, 2, 4] as const
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number]

/**
 * Split a run of streamed text into chunks of a few words each, every chunk
 * carrying the whitespace in front of its first word — concatenated, the chunks
 * are the text exactly.
 */
export function splitIntoChunks(text: string, wordsPerChunk: number): string[] {
  const words = text.match(/\s*\S+/gu)
  if (!words) return text ? [text] : []
  const chunks: string[] = []
  for (let index = 0; index < words.length; index += wordsPerChunk)
    chunks.push(words.slice(index, index + wordsPerChunk).join(''))
  // Whitespace after the last word belongs to the last chunk.
  const tail = text.slice(chunks.join('').length)
  if (tail) chunks[chunks.length - 1] += tail
  return chunks
}

function wordCount(text: string): number {
  return text.match(/\S+/gu)?.length ?? 0
}

/** The text field a delta's fold reads (`text`, then `delta`), and its value. */
function deltaField(event: ConversationEvent): { field: 'text' | 'delta'; text: string } | null {
  const payload = event.payload
  if (typeof payload?.text === 'string' && payload.text) return { field: 'text', text: payload.text }
  if (typeof payload?.delta === 'string' && payload.delta) return { field: 'delta', text: payload.delta }
  return null
}

/**
 * Cut a conversation's whole log into a replay script. Runs of streamed text
 * are merged first, as the log on disk keeps them, then cut into chunks of a
 * few words — each its own event, numbered as the run was — so the reply
 * streams in at reading pace whatever granularity it was recorded at.
 */
export function buildReplayScript(log: readonly ConversationEvent[]): ReplayScript {
  const events: ConversationEvent[] = []
  const delays: number[] = []
  const prompts: number[] = []
  for (const event of compactTokenRuns([...log])) {
    const delta = event.type === 'content_delta' || event.type === 'reasoning_delta' ? deltaField(event) : null
    if (delta) {
      const reasoning = event.type === 'reasoning_delta'
      const pace = reasoning ? REASONING_WORDS_PER_SECOND : REPLY_WORDS_PER_SECOND
      splitIntoChunks(delta.text, reasoning ? REASONING_WORDS_PER_CHUNK : WORDS_PER_CHUNK).forEach((chunk, n) => {
        events.push(
          n === 0
            ? { ...event, payload: { ...event.payload, [delta.field]: chunk } }
            : { ...event, id: `${event.id}~${n}`, payload: { turnId: event.payload?.turnId, [delta.field]: chunk } },
        )
        delays.push(Math.round((Math.max(1, wordCount(chunk)) / pace) * 1000))
      })
      continue
    }
    events.push(event)
    delays.push(BEAT_MS[event.type] ?? 0)
    if (event.type === 'user_message') prompts.push(events.length)
  }
  return { events, delays, prompts }
}

/** Where a replay stands. `cursor` is how many of the script's events show. */
export type ReplayState = {
  cursor: number
  playing: boolean
  /** Keep going past each message rather than stopping to show it. */
  continuous: boolean
  speed: ReplaySpeed
}

/** A replay opens on the first message, its reply not yet begun. */
export function initialReplayState(script: ReplayScript): ReplayState {
  return { cursor: script.prompts[0] ?? script.events.length, playing: false, continuous: false, speed: 1 }
}

export type ReplayAction =
  | { type: 'toggle' }
  | { type: 'pause' }
  | { type: 'tick' }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'restart' }
  | { type: 'end' }
  | { type: 'continuous'; on: boolean }
  | { type: 'speed'; speed: ReplaySpeed }

/** How long the player waits before its next tick, at the state's speed. */
export function replayDelay(script: ReplayScript, state: ReplayState): number {
  return Math.round((script.delays[state.cursor] ?? 0) / state.speed)
}

/**
 * One tick: reveal the next event, and with it every event after it that costs
 * no time. Stops at a message unless the player is continuous, and at the end.
 */
function advance(script: ReplayScript, state: ReplayState): ReplayState {
  const stops = new Set(script.prompts)
  const length = script.events.length
  let cursor = state.cursor
  do cursor += 1
  while (cursor < length && !stops.has(cursor) && (script.delays[cursor] ?? 0) === 0)
  const halt = cursor >= length || (!state.continuous && stops.has(cursor))
  return { ...state, cursor: Math.min(cursor, length), playing: state.playing && !halt }
}

export function replayReducer(script: ReplayScript, state: ReplayState, action: ReplayAction): ReplayState {
  const length = script.events.length
  switch (action.type) {
    case 'toggle':
      // Play at the end has nothing left to play; Restart is the way back.
      if (state.playing || state.cursor >= length) return { ...state, playing: false }
      return { ...state, playing: true }
    case 'pause':
      return state.playing ? { ...state, playing: false } : state
    case 'tick':
      return state.playing && state.cursor < length ? advance(script, state) : state
    case 'next': {
      // The rest of this reply at once, stopping on the next message.
      const cursor = script.prompts.find((prompt) => prompt > state.cursor) ?? length
      return { ...state, cursor, playing: false }
    }
    case 'previous': {
      // Partway into a reply, back to the message that asked for it — the way
      // a player's Previous restarts the track before it skips one back.
      const earlier = script.prompts.filter((prompt) => prompt < state.cursor)
      return { ...state, cursor: earlier.at(-1) ?? script.prompts[0] ?? 0, playing: false }
    }
    case 'restart':
      return { ...state, cursor: script.prompts[0] ?? length, playing: false }
    case 'end':
      return { ...state, cursor: length, playing: false }
    case 'continuous':
      return { ...state, continuous: action.on }
    case 'speed':
      return { ...state, speed: action.speed }
  }
}

/** Which message the replay is on, 1-based; 0 before the first. */
export function replayPromptIndex(script: ReplayScript, cursor: number): number {
  let index = 0
  for (const prompt of script.prompts) if (prompt <= cursor) index += 1
  return index
}

/**
 * The replay's clock. A turn replayed now is moved to now: its events keep
 * their spacing but start when the turn starts replaying, so the working line
 * and a running tool count up from zero instead of from the day the turn ran,
 * and a settled turn still says how long it really took. A message keeps the
 * time it was sent — that is history, not the replay's.
 */
export class ReplayClock {
  private readonly shown: ConversationEvent[] = []
  private readonly turnShift = new Map<string, number>()
  private readonly toolShift = new Map<string, number>()

  /** The script's first `cursor` events as the transcript should see them. */
  reveal(script: ReplayScript, cursor: number, now: number): ConversationEvent[] {
    if (cursor < this.shown.length) this.shown.length = cursor
    for (let index = this.shown.length; index < cursor; index++) this.shown.push(this.stamp(script.events[index]!, now))
    return this.shown.slice()
  }

  private stamp(event: ConversationEvent, now: number): ConversationEvent {
    const turnId = readString(event.payload, 'turnId')
    if (event.type === 'turn_started' && turnId) this.turnShift.set(turnId, now - event.createdAt)
    // A subagent's step carries no turn; it keeps time with the call that spawned it.
    const parent = readString(event.payload, 'parentToolUseId')
    const shift = (turnId ? this.turnShift.get(turnId) : undefined) ?? (parent ? this.toolShift.get(parent) : undefined)
    const toolId = readString(event.payload, 'toolUseId', 'toolCallId')
    if (event.type === 'tool_started' && toolId && shift !== undefined) this.toolShift.set(toolId, shift)
    if (shift === undefined || event.type === 'user_message') return event
    return { ...event, createdAt: event.createdAt + shift }
  }
}

/**
 * The whole log, from what a chat already holds and the pages before it. A chat
 * holds its latest turns; a replay starts at the first message, so it reads
 * back page by page until there is nothing earlier.
 */
export async function loadWholeConversation(
  loadEarlier: (input: {
    key: ConversationKey
    beforeCursor: number
    turnLimit: number
  }) => Promise<ConversationPageResult>,
  key: ConversationKey,
  held: { events: readonly ConversationEvent[]; hasMore: boolean; beforeCursor: number | null },
): Promise<ConversationEvent[]> {
  const seen = new Set(held.events.map((event) => event.id))
  // Each page is older than everything before it, so it goes in front: the
  // log's own order, kept without sorting (an event recorded before the
  // desktop numbered them has no `seq` to sort by).
  const pages: ConversationEvent[][] = []
  let more = held.hasMore
  let cursor = held.beforeCursor
  while (more && cursor !== null) {
    const result = await loadEarlier({ key, beforeCursor: cursor, turnLimit: 50 })
    if (!result.ok) throw new Error(result.message)
    const older = result.page.events.filter((event) => !seen.has(event.id))
    for (const event of older) seen.add(event.id)
    pages.unshift(older)
    // A page that does not move the cursor back would loop for ever.
    more = result.page.hasMore && result.page.beforeCursor !== null && result.page.beforeCursor < cursor
    cursor = result.page.beforeCursor
  }
  return [...pages.flat(), ...held.events]
}
