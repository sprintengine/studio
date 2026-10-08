import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ConversationEvent,
  ConversationEventType,
  ConversationKey,
  ConversationPage,
  ConversationSessionFrame,
} from '../../../../../shared/conversation-runtime'
import { useWindowPageVisible } from '../../../utils/windowActivity'
import { useConversationTransport, type ConversationTransport } from './conversationTransport'
import { retryLabel } from './conversationTimeline'
import { compactTokenRuns, SeqRanges } from './sessionEventLog'

const TURN_LIMIT = 10
type SessionState = {
  events: ConversationEvent[]
  hasMore: boolean
  beforeCursor: number | null
  hydrated: boolean
  loadingEarlier: boolean
  error: string | null
  replayThroughSeq: number
  completionRevision: number
  announcement: string
}
type Session = {
  key: ConversationKey
  state: SessionState
  disposed: boolean
  earlier: Promise<void> | null
  seenSeq: SeqRanges
  // `state.events` has been handed to readers in a snapshot, so the next live
  // event copies it before appending; until then events append in place.
  logShared: boolean
  // Where the next compaction starts: runs before it are already merged.
  compactedTo: number
  // Where a resubscribe resumes: the last sequence this panel holds, valid only
  // with the log generation it was read from.
  cursor: { seq: number; generation?: string } | null
  // True from a (re)subscribe until its synchronized fence.
  joining: boolean
  retries: number
  retryTimer: ReturnType<typeof setTimeout> | null
  unsubscribe: () => void
  // Subscribe again from the cursor: a retry, or a chat opened again while it
  // was still held.
  resume: () => void
  // The provider retry last said aloud: its turn and what went wrong.
  retrySaid: { turnId: unknown; reason: string } | null
}

/**
 * What to say when the provider retries a failed call: its first retry in a
 * turn, and again only when what went wrong changes. A rate limit retried ten
 * times is one thing to hear, not ten.
 */
function retryAnnouncement(session: Session, payload: Record<string, unknown> | undefined): string | null {
  const attempt = typeof payload?.attempt === 'number' ? payload.attempt : undefined
  const maxAttempts = typeof payload?.maxAttempts === 'number' ? payload.maxAttempts : undefined
  if (attempt === undefined || maxAttempts === undefined) return null
  const error = typeof payload?.error === 'string' ? payload.error : undefined
  const status = typeof payload?.status === 'number' ? payload.status : undefined
  const reason = `${error ?? ''}|${status ?? ''}`
  const said = session.retrySaid
  if (said && said.turnId === payload?.turnId && said.reason === reason && attempt > 1) return null
  session.retrySaid = { turnId: payload?.turnId, reason }
  return retryLabel({ attempt, maxAttempts, error, status })
}
const emptyState = (): SessionState => ({
  events: [],
  hasMore: false,
  beforeCursor: null,
  hydrated: false,
  loadingEarlier: false,
  error: null,
  replayThroughSeq: 0,
  completionRevision: 0,
  announcement: '',
})

// Session transport guarantees sequenced events, including migrated logs. Keep
// existing objects for duplicates so incremental projection can reuse its tail.
export function mergeConversationEvents(
  current: ConversationEvent[],
  incoming: ConversationEvent[],
  seenSeq: { has(seq: number): boolean; add(seq: number): unknown },
): ConversationEvent[] {
  const added: ConversationEvent[] = []
  for (const event of incoming) {
    if (event.seq === undefined || seenSeq.has(event.seq)) continue
    seenSeq.add(event.seq)
    added.push(event)
  }
  if (!added.length) return current
  // Live tokens append in sequence order: no history map, comparisons or sort.
  // Only older/reordered page joins need a sorted merge. Existing event objects
  // survive either path, preserving incremental projection identities.
  if (added.length === 1 && (current.length === 0 || added[0].seq! > current.at(-1)!.seq!))
    return [...current, added[0]]
  return [...current, ...added].sort((a, b) => a.seq! - b.seq!)
}

const bySeq = (a: ConversationEvent, b: ConversationEvent) => a.seq! - b.seq!

// Take in one live event. Live events arrive in sequence order and append in
// place, so a token costs no copy of the log; a copy is made once after a
// snapshot handed the log to readers, not once per token.
function appendLive(session: Session, event: ConversationEvent): void {
  const seq = event.seq!
  session.seenSeq.add(seq)
  const events = session.state.events
  const last = events.at(-1)
  if (last === undefined || seq > last.seq!) {
    if (session.logShared) {
      session.state.events = events.slice()
      session.logShared = false
    }
    session.state.events.push(event)
    return
  }
  session.state.events = [...events, event].sort(bySeq)
  session.logShared = false
  session.compactedTo = 0
}

// Merge the settled runs of streamed tokens that arrived since the last time.
function compactLive(session: Session): void {
  const events = session.state.events
  const compacted = compactTokenRuns(events, session.compactedTo)
  if (compacted !== events) {
    session.state.events = compacted
    session.logShared = false
  }
  session.compactedTo = compacted.length
}

// A page of events (a snapshot, or earlier turns): the ones not held yet, in
// sequence order, with their token runs merged.
function takePage(session: Session, incoming: ConversationEvent[]): ConversationEvent[] {
  return compactTokenRuns(mergeConversationEvents([], incoming, session.seenSeq))
}

// A failed subscription is retried; the delay doubles up to a ceiling so a
// transcript that cannot be read does not spin, and resets once one succeeds.
const RETRY_BASE_MS = 500
const RETRY_MAX_MS = 15_000
function conversationRetryDelay(retries: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** retries)
}

/**
 * How soon a frame has to reach a reader. A `token` (a streamed word, a partial
 * tool output) can wait for the next frame, or for a hidden reader to be seen
 * again. A `step` (a tool starting, a usage report) redraws a reader that is
 * seen at once and waits for one that is not. A `turn` changes what a reader
 * acts on even while nobody looks at it — the queued message sends when a turn
 * ends, a request waits in the approval dock, a failure is reported — so it
 * reaches every reader at once.
 */
export type FrameUrgency = 'token' | 'step' | 'turn'

const TURN_EVENTS: ReadonlySet<ConversationEventType> = new Set([
  'session_started',
  'session_ready',
  'session_closed',
  'session_updated',
  'user_message',
  'turn_started',
  'turn_completed',
  'turn_failed',
  'approval_requested',
  'approval_resolved',
])

export function frameUrgency(frame: ConversationSessionFrame): FrameUrgency {
  if (frame.type !== 'event') return 'turn'
  const { type, payload } = frame.event
  if (type === 'content_delta' || type === 'reasoning_delta') return 'token'
  if (type === 'tool_output' && payload?.partial === true) return 'token'
  return TURN_EVENTS.has(type) ? 'turn' : 'step'
}

// A token waits for the next animation frame, or for this long where frames do
// not run (a window the system is not drawing), whichever comes first.
const TOKEN_FLUSH_FALLBACK_MS = 48

// One live subscription per conversation and transport, shared by everything
// on screen that reads it: the chat and the Agents pane show the same events,
// hold one copy of them and page earlier turns in once. The first reader opens
// the subscription and the last one to go closes it.
type SharedSession = {
  session: Session
  // What readers render; null when the session moved on since, and built when
  // a reader next asks, so a session nobody reads right now copies nothing.
  snapshot: SessionState | null
  listeners: Set<(urgency: FrameUrgency) => void>
  readers: number
}

/**
 * A chat nobody reads any more is kept, closed, for a while: the events it
 * holds and the cursor they reach. Opening it again draws them at once and
 * asks only for what was written since, where opening it cold reads, sends
 * and parses its last turns whole (megabytes for a chat that ran many tools).
 * The newest few are kept, within a budget of what their events weigh as
 * JSON; the oldest goes first.
 */
export const RETAINED_SESSION_LIMIT = 6
export const RETAINED_SESSION_BYTES = 40 * 1024 * 1024

// What an event weighs as JSON, near enough, remembered per event: a session
// closed again weighs only what it took in since.
const eventWeights = new WeakMap<ConversationEvent, number>()
function weightOf(value: unknown, depth = 0): number {
  if (typeof value === 'string') return value.length + 2
  if (value === null || typeof value !== 'object' || depth > 8) return 8
  let weight = 2
  if (Array.isArray(value)) for (const item of value) weight += weightOf(item, depth + 1) + 1
  else for (const key in value) weight += key.length + 4 + weightOf((value as Record<string, unknown>)[key], depth + 1)
  return weight
}
function eventsWeight(events: ConversationEvent[]): number {
  let total = 0
  for (const event of events) {
    let weight = eventWeights.get(event)
    if (weight === undefined) eventWeights.set(event, (weight = weightOf(event)))
    total += weight
  }
  return total
}

type TransportSessions = {
  open: Map<string, SharedSession>
  // Oldest first, with what each weighs.
  retained: Map<string, { shared: SharedSession; bytes: number }>
}
const sharedSessions = new WeakMap<ConversationTransport, TransportSessions>()
const sessionKeyOf = (key: ConversationKey) => JSON.stringify([key.workspaceRoot, key.workspaceId, key.agentId])

function publish(shared: SharedSession, urgency: FrameUrgency = 'turn'): void {
  if (shared.session.disposed) return
  shared.snapshot = null
  for (const listener of shared.listeners) listener(urgency)
}

function readSnapshot(shared: SharedSession): SessionState {
  if (!shared.snapshot) {
    shared.snapshot = { ...shared.session.state }
    shared.session.logShared = true
  }
  return shared.snapshot
}

function sessionsOf(transport: ConversationTransport): TransportSessions {
  let sessions = sharedSessions.get(transport)
  if (!sessions) sharedSessions.set(transport, (sessions = { open: new Map(), retained: new Map() }))
  return sessions
}

function openSharedSession(transport: ConversationTransport, key: ConversationKey): SharedSession {
  const sessions = sessionsOf(transport)
  const byKey = sessions.open
  const id = sessionKeyOf(key)
  const existing = byKey.get(id)
  if (existing) {
    existing.readers += 1
    return existing
  }
  const retained = sessions.retained.get(id)?.shared
  if (retained) {
    sessions.retained.delete(id)
    byKey.set(id, retained)
    retained.readers = 1
    const { session } = retained
    // Opened again: what it holds is history now, as it would be read cold,
    // and whatever was written meanwhile arrives as a catch-up behind the
    // fence of this join.
    session.state = { ...session.state, replayThroughSeq: session.cursor?.seq ?? 0, announcement: '' }
    retained.snapshot = null
    session.resume()
    return retained
  }
  const session: Session = {
    key,
    state: emptyState(),
    disposed: false,
    earlier: null,
    seenSeq: new SeqRanges(),
    logShared: false,
    compactedTo: 0,
    cursor: null,
    joining: true,
    retries: 0,
    retryTimer: null,
    unsubscribe: () => {},
    resume: () => subscribe(true),
    retrySaid: null,
  }
  const shared: SharedSession = { session, snapshot: null, listeners: new Set(), readers: 1 }
  byKey.set(id, shared)
  // `reopened`: a held session read again, whose catch-up is history to its
  // new reader as much as what it already holds.
  const subscribe = (reopened = false) => {
    session.joining = true
    // Resume from the cursor when the log can vouch for it: the runtime then
    // sends only the events after it. Without a generation it sends a reset
    // snapshot, which replaces what this panel holds.
    const cursor = session.cursor?.generation
      ? { afterSeq: session.cursor.seq, generation: session.cursor.generation }
      : {}
    let current = true
    // A snapshot replaces the transcript, so what it holds is replayed history
    // however many joins came before: the fence of this join becomes the
    // replay boundary, not the one from the first join (which may even be from
    // another log generation).
    let replaced = reopened
    const unsubscribe = transport.subscribe({ key: session.key, turnLimit: TURN_LIMIT, ...cursor }, (frame) => {
      if (session.disposed || !current) return
      switch (frame.type) {
        case 'snapshot':
          replaced = true
          session.seenSeq.clear()
          session.state = {
            ...session.state,
            ...frame.page,
            events: takePage(session, frame.page.events),
            completionRevision: frame.page.events.findLast((event) => event.type === 'turn_completed')?.seq ?? 0,
          }
          session.logShared = false
          session.compactedTo = session.state.events.length
          break
        case 'event':
          if (frame.event.seq === undefined || session.seenSeq.has(frame.event.seq)) return
          appendLive(session, frame.event)
          if (session.cursor && frame.event.seq > session.cursor.seq) session.cursor.seq = frame.event.seq
          if (frame.event.type === 'turn_completed') session.state.completionRevision = frame.event.seq
          // A turn's tokens are settled once it ends: its runs become one event
          // each, which is how the log on disk keeps them.
          if (frame.event.type === 'turn_completed' || frame.event.type === 'turn_failed') compactLive(session)
          // Tokens stay silent; announce message lifecycle once, independently
          // from the virtualized transcript's aria-live=off subtree.
          if (!session.joining) {
            if (frame.event.type === 'turn_started') session.state.announcement = 'Assistant is replying.'
            else if (frame.event.type === 'turn_completed') session.state.announcement = 'Assistant reply complete.'
            else if (frame.event.type === 'turn_failed') session.state.announcement = 'Assistant reply stopped.'
            else if (frame.event.type === 'user_message') session.state.announcement = 'Message sent.'
            else if (frame.event.type === 'turn_retrying') {
              const said = retryAnnouncement(session, frame.event.payload)
              if (said) session.state.announcement = said
            }
          }
          break
        case 'synchronized':
          if (!session.state.hydrated || replaced) session.state.replayThroughSeq = frame.seq
          session.state.hydrated = true
          session.state.error = null
          session.cursor = { seq: frame.seq, generation: frame.generation }
          session.joining = false
          session.retries = 0
          break
        case 'error':
          session.state.error = frame.message
          // The runtime ends a subscription after an error, so a panel
          // opened mid-stream would otherwise stay frozen. Subscribe again,
          // resuming from what this panel already holds.
          current = false
          unsubscribe()
          session.retryTimer = setTimeout(() => {
            session.retryTimer = null
            if (!session.disposed) subscribe()
          }, conversationRetryDelay(session.retries++))
          break
      }
      // Render a catch-up atomically at its synchronization fence, so a
      // partial render cannot establish the virtual list's initial anchor.
      if (!session.joining || frame.type === 'error') publish(shared, frameUrgency(frame))
    })
    session.unsubscribe = () => {
      current = false
      unsubscribe()
    }
  }
  subscribe()
  return shared
}

function disposeSession(session: Session): void {
  session.disposed = true
  if (session.retryTimer) clearTimeout(session.retryTimer)
  session.retryTimer = null
  session.unsubscribe()
}

// Only a session that holds a whole, current transcript and a cursor its log
// can vouch for is worth keeping: anything else is read cold next time anyway.
function retainable(session: Session): boolean {
  return (
    session.state.hydrated &&
    !session.state.error &&
    !session.joining &&
    session.retryTimer === null &&
    session.cursor?.generation !== undefined
  )
}

function closeSharedSession(transport: ConversationTransport, shared: SharedSession): void {
  shared.readers -= 1
  if (shared.readers > 0) return
  const { session } = shared
  const sessions = sessionsOf(transport)
  const id = sessionKeyOf(session.key)
  if (sessions.open.get(id) === shared) sessions.open.delete(id)
  if (!retainable(session)) return disposeSession(session)
  // Closed like any other: nothing streams to a chat nobody reads.
  session.unsubscribe()
  session.unsubscribe = () => {}
  shared.snapshot = null
  sessions.retained.set(id, { shared, bytes: eventsWeight(session.state.events) })
  let held = 0
  for (const kept of sessions.retained.values()) held += kept.bytes
  for (const [oldest, kept] of sessions.retained) {
    if (sessions.retained.size <= RETAINED_SESSION_LIMIT && held <= RETAINED_SESSION_BYTES) break
    sessions.retained.delete(oldest)
    held -= kept.bytes
    disposeSession(kept.shared.session)
  }
}

// How long a read started ahead of an open waits for its answer before it
// gives up its hold on the session.
const PREFETCH_HOLD_MS = 15_000

/**
 * Read a chat ahead of its being opened (its row in the sidebar is pointed
 * at): the session is opened as a reader would open it, held until it has
 * synchronized, and then let go, so it is kept like any chat just closed and
 * the open that follows draws it at once. A chat already open, or already
 * held and current, costs a catch-up of what is new at most.
 */
export function prefetchConversationSession(transport: ConversationTransport, key: ConversationKey): void {
  const shared = openSharedSession(transport, key)
  let held = true
  const release = () => {
    if (!held) return
    held = false
    clearTimeout(timer)
    shared.listeners.delete(listener)
    closeSharedSession(transport, shared)
  }
  const listener = () => {
    if (!shared.session.joining || shared.session.state.error) release()
  }
  const timer = setTimeout(release, PREFETCH_HOLD_MS)
  shared.listeners.add(listener)
  listener()
}

function loadEarlierTurns(transport: ConversationTransport, shared: SharedSession): Promise<void> {
  const { session } = shared
  if (session.disposed) return Promise.resolve()
  if (session.earlier) return session.earlier
  const { beforeCursor, hasMore, hydrated } = session.state
  if (!hydrated || !hasMore || beforeCursor === null) return Promise.resolve()
  session.state = { ...session.state, loadingEarlier: true, error: null }
  publish(shared)
  const applyPage = (page: ConversationPage) => {
    if (session.disposed) return
    const older = takePage(session, page.events)
    session.state = {
      ...session.state,
      ...page,
      events: older.length ? [...session.state.events, ...older].sort(bySeq) : session.state.events,
    }
    if (older.length) {
      session.logShared = false
      session.compactedTo = 0
    }
  }
  session.earlier = Promise.resolve()
    .then(async () => {
      const result = await transport.loadEarlier({ key: session.key, beforeCursor, turnLimit: TURN_LIMIT })
      if (!result.ok) throw new Error(result.message)
      applyPage(result.page)
    })
    .catch((error: unknown) => {
      if (!session.disposed) session.state.error = error instanceof Error ? error.message : String(error)
      throw error
    })
    .finally(() => {
      session.earlier = null
      if (!session.disposed) {
        session.state = { ...session.state, loadingEarlier: false }
        publish(shared)
      }
    })
  return session.earlier
}

/**
 * One reader of a conversation's session. `active` is whether the reader can
 * be seen (the window's visibility is added here); a reader nobody can see
 * takes in only what it acts on — a turn starting or ending, a request, a sent
 * message — and catches up on the rest in one render when it is seen again. A
 * reader that is seen renders streamed tokens once per frame, however many
 * arrived in it.
 */
export function useConversationSession(
  workspaceRoot: string | null,
  workspaceId: string,
  agentId: string,
  options: { active?: boolean } = {},
) {
  const [state, setState] = useState<SessionState>(emptyState)
  const sharedRef = useRef<SharedSession | null>(null)
  const active = useWindowPageVisible() && (options.active ?? true)
  const activeRef = useRef(active)
  activeRef.current = active
  // Renders what the reader was held back from, if anything was.
  const catchUpRef = useRef<() => void>(() => undefined)
  // Local IPC or a paired machine's conversation: the frames are the same.
  const conversationTransport = useConversationTransport()
  useEffect(() => {
    setState(emptyState())
    if (!workspaceRoot) return
    const shared = openSharedSession(conversationTransport, { workspaceRoot, workspaceId, agentId })
    sharedRef.current = shared
    let frame = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    let behind = false
    const cancel = () => {
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      if (timer !== null) clearTimeout(timer)
      timer = null
    }
    const flush = () => {
      cancel()
      behind = false
      setState(readSnapshot(shared))
    }
    const listener = (urgency: FrameUrgency) => {
      if (urgency === 'turn') return flush()
      behind = true
      if (!activeRef.current) return cancel()
      if (urgency === 'step') return flush()
      if (frame || timer !== null) return
      if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(flush)
      timer = setTimeout(flush, TOKEN_FLUSH_FALLBACK_MS)
    }
    catchUpRef.current = () => {
      if (behind) flush()
    }
    shared.listeners.add(listener)
    // A reader joining a conversation already open elsewhere starts from what
    // is already held rather than an empty transcript.
    if (shared.session.state.hydrated || shared.session.state.error) setState(readSnapshot(shared))
    return () => {
      cancel()
      catchUpRef.current = () => undefined
      shared.listeners.delete(listener)
      if (sharedRef.current === shared) sharedRef.current = null
      closeSharedSession(conversationTransport, shared)
    }
  }, [workspaceRoot, workspaceId, agentId, conversationTransport])
  useEffect(() => {
    if (active) catchUpRef.current()
  }, [active])

  const loadEarlier = useCallback((): Promise<void> => {
    const shared = sharedRef.current
    return shared ? loadEarlierTurns(conversationTransport, shared) : Promise.resolve()
  }, [conversationTransport])

  return { ...state, loadEarlier }
}
