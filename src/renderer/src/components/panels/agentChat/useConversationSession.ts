import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConversationEvent, ConversationKey, ConversationPage } from '../../../../../shared/conversation-runtime'
import { useConversationTransport } from './conversationTransport'

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

export function useConversationSession(workspaceRoot: string | null, workspaceId: string, agentId: string) {
  const [state, setState] = useState<SessionState>(emptyState)
  const sessionRef = useRef<Session | null>(null)
  // Local IPC or a paired machine's conversation: the frames are the same.
  const conversationTransport = useConversationTransport()
  useEffect(() => {
    setState(emptyState())
    if (!workspaceRoot) return
    const session: Session = {
      key: { workspaceRoot, workspaceId, agentId },
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
    sessionRef.current = session
    const publish = () => {
      if (!session.disposed) setState({ ...session.state })
    }
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
      const unsubscribe = conversationTransport.subscribe(
        { key: session.key, turnLimit: TURN_LIMIT, ...cursor },
        (frame) => {
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
          if (!session.joining || frame.type === 'error') publish()
        },
      )
      session.unsubscribe = () => {
        current = false
        unsubscribe()
      }
    }
    subscribe()
    return () => {
      session.disposed = true
      if (sessionRef.current === session) sessionRef.current = null
      if (session.retryTimer) clearTimeout(session.retryTimer)
      session.unsubscribe()
    }
  }, [workspaceRoot, workspaceId, agentId, conversationTransport])

  const loadEarlier = useCallback((): Promise<void> => {
    const session = sessionRef.current
    if (!session || session.disposed) return Promise.resolve()
    if (session.earlier) return session.earlier
    const { beforeCursor, hasMore, hydrated } = session.state
    if (!hydrated || !hasMore || beforeCursor === null) return Promise.resolve()
    session.state = { ...session.state, loadingEarlier: true, error: null }
    setState(session.state)
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
        const result = await conversationTransport.loadEarlier({
          key: session.key,
          beforeCursor,
          turnLimit: TURN_LIMIT,
        })
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
          setState(session.state)
        }
      })
    return session.earlier
  }, [conversationTransport])

  return { ...state, loadEarlier }
}
