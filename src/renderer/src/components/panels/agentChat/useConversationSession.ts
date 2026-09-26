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
}
type Session = {
  key: ConversationKey
  state: SessionState
  disposed: boolean
  earlier: Promise<void> | null
}
const emptyState = (): SessionState => ({
  events: [],
  hasMore: false,
  beforeCursor: null,
  hydrated: false,
  loadingEarlier: false,
  error: null,
})

// Session transport guarantees sequenced events, including migrated logs. Keep
// existing objects for duplicates so incremental projection can reuse its tail.
function mergeEvents(current: ConversationEvent[], incoming: ConversationEvent[]): ConversationEvent[] {
  const bySeq = new Map(current.map((event) => [event.seq, event]))
  let changed = false
  for (const event of incoming) {
    if (event.seq === undefined || bySeq.has(event.seq)) continue
    bySeq.set(event.seq, event)
    changed = true
  }
  return changed ? [...bySeq.values()].sort((a, b) => a.seq! - b.seq!) : current
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
    }
    sessionRef.current = session
    const publish = () => {
      if (!session.disposed) setState({ ...session.state })
    }
    const unsubscribe = window.api.onConversationSession({ key: session.key, turnLimit: TURN_LIMIT }, (frame) => {
      if (session.disposed) return
      switch (frame.type) {
        case 'snapshot':
          session.state = {
            ...session.state,
            ...frame.page,
            events: mergeEvents([], frame.page.events),
          }
          break
        case 'event':
          session.state.events = mergeEvents(session.state.events, [frame.event])
          break
        case 'synchronized':
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
      session.state = { ...session.state, ...page, events: mergeEvents(session.state.events, page.events) }
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
