import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConversationEvent, ConversationKey, ConversationPage } from '../../../../../shared/conversation-runtime'

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

export function useConversationSession(workspaceRoot: string | null, workspaceId: string, agentId: string) {
  const [state, setState] = useState<SessionState>(emptyState)
  const sessionRef = useRef<Session | null>(null)
  useEffect(() => {
    setState(emptyState())
    if (!workspaceRoot) return
    const session: Session = {
      key: { workspaceRoot, workspaceId, agentId },
      state: emptyState(),
      disposed: false,
      earlier: null,
      seenSeq: new Set(),
    }
    sessionRef.current = session
    const publish = () => {
      if (!session.disposed) setState({ ...session.state })
    }
    const unsubscribe = window.api.onConversationSession({ key: session.key, turnLimit: TURN_LIMIT }, (frame) => {
      if (session.disposed) return
      switch (frame.type) {
        case 'snapshot':
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
          if (frame.event.type === 'turn_completed') session.state.completionRevision = frame.event.seq
          // Tokens stay silent; announce message lifecycle once, independently
          // from the virtualized transcript's aria-live=off subtree.
          if (session.state.hydrated) {
            if (frame.event.type === 'turn_started') session.state.announcement = 'Assistant is replying.'
            else if (frame.event.type === 'turn_completed') session.state.announcement = 'Assistant reply complete.'
            else if (frame.event.type === 'turn_failed') session.state.announcement = 'Assistant reply stopped.'
            else if (frame.event.type === 'user_message') session.state.announcement = 'Message sent.'
          }
          break
        case 'synchronized':
          if (!session.state.hydrated) session.state.replayThroughSeq = frame.seq
          session.state.hydrated = true
          session.state.error = null
          break
        case 'error':
          session.state.error = frame.message
          break
      }
      // Render catch-up atomically at the synchronization fence. Otherwise an
      // early partial render can establish the virtual list's initial anchor.
      if (session.state.hydrated || frame.type === 'error') publish()
    })
    return () => {
      session.disposed = true
      if (sessionRef.current === session) sessionRef.current = null
      unsubscribe()
    }
  }, [workspaceRoot, workspaceId, agentId])

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
        const result = await window.api.conversationLoadEarlier({
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
  }, [])

  return { ...state, loadEarlier }
}
