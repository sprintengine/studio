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
  seenSeq: Set<number>
  // Where a resubscribe resumes: the last sequence this panel holds, valid only
  // with the log generation it was read from.
  cursor: { seq: number; generation?: string } | null
  // True from a (re)subscribe until its synchronized fence.
  joining: boolean
  retries: number
  retryTimer: ReturnType<typeof setTimeout> | null
  unsubscribe: () => void
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
  seenSeq: Set<number>,
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
  snapshot: SessionState
  listeners: Set<(urgency: FrameUrgency) => void>
  readers: number
}
const sharedSessions = new WeakMap<ConversationTransport, Map<string, SharedSession>>()
const sessionKeyOf = (key: ConversationKey) => JSON.stringify([key.workspaceRoot, key.workspaceId, key.agentId])

function publish(shared: SharedSession, urgency: FrameUrgency = 'turn'): void {
  if (shared.session.disposed) return
  shared.snapshot = { ...shared.session.state }
  for (const listener of shared.listeners) listener(urgency)
}

function openSharedSession(transport: ConversationTransport, key: ConversationKey): SharedSession {
  let byKey = sharedSessions.get(transport)
  if (!byKey) sharedSessions.set(transport, (byKey = new Map()))
  const id = sessionKeyOf(key)
  const existing = byKey.get(id)
  if (existing) {
    existing.readers += 1
    return existing
  }
  const session: Session = {
    key,
    state: emptyState(),
    disposed: false,
    earlier: null,
    seenSeq: new Set(),
    cursor: null,
    joining: true,
    retries: 0,
    retryTimer: null,
    unsubscribe: () => {},
  }
  const shared: SharedSession = { session, snapshot: session.state, listeners: new Set(), readers: 1 }
  byKey.set(id, shared)
  const subscribe = () => {
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
    let replaced = false
    const unsubscribe = transport.subscribe({ key: session.key, turnLimit: TURN_LIMIT, ...cursor }, (frame) => {
      if (session.disposed || !current) return
      switch (frame.type) {
        case 'snapshot':
          replaced = true
          session.seenSeq.clear()
          session.state = {
            ...session.state,
            ...frame.page,
            events: mergeConversationEvents([], frame.page.events, session.seenSeq),
            completionRevision: frame.page.events.findLast((event) => event.type === 'turn_completed')?.seq ?? 0,
          }
          break
        case 'event':
          if (frame.event.seq === undefined || session.seenSeq.has(frame.event.seq)) return
          session.state.events = mergeConversationEvents(session.state.events, [frame.event], session.seenSeq)
          if (session.cursor && frame.event.seq > session.cursor.seq) session.cursor.seq = frame.event.seq
          if (frame.event.type === 'turn_completed') session.state.completionRevision = frame.event.seq
          // Tokens stay silent; announce message lifecycle once, independently
          // from the virtualized transcript's aria-live=off subtree.
          if (!session.joining) {
            if (frame.event.type === 'turn_started') session.state.announcement = 'Assistant is replying.'
            else if (frame.event.type === 'turn_completed') session.state.announcement = 'Assistant reply complete.'
            else if (frame.event.type === 'turn_failed') session.state.announcement = 'Assistant reply stopped.'
            else if (frame.event.type === 'user_message') session.state.announcement = 'Message sent.'
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

function closeSharedSession(transport: ConversationTransport, shared: SharedSession): void {
  shared.readers -= 1
  if (shared.readers > 0) return
  const { session } = shared
  session.disposed = true
  if (session.retryTimer) clearTimeout(session.retryTimer)
  session.unsubscribe()
  const byKey = sharedSessions.get(transport)
  const id = sessionKeyOf(session.key)
  if (byKey?.get(id) === shared) byKey.delete(id)
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
    session.state = {
      ...session.state,
      ...page,
      events: mergeConversationEvents(session.state.events, page.events, session.seenSeq),
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
      setState(shared.snapshot)
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
    if (shared.session.state.hydrated || shared.session.state.error) setState(shared.snapshot)
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
