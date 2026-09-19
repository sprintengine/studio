// Live conversation-session summaries for the session manager: conversation
// (chat) agents have no PTY snapshot, so their status comes from the main
// ConversationRuntime. The list is fetched once and refreshed when a
// status-relevant conversation event arrives (streaming deltas are ignored —
// they are per-token and never change session status).

import { useEffect, useState } from 'react'

import type { ConversationEventType, ConversationSessionSummary } from '../../../shared/conversation-runtime'

const STATUS_EVENT_TYPES: ReadonlySet<ConversationEventType> = new Set<ConversationEventType>([
  'session_started',
  'session_ready',
  'session_closed',
  'turn_started',
  'approval_requested',
  'approval_resolved',
  'turn_completed',
  'turn_failed',
])

const REFRESH_DEBOUNCE_MS = 200

export function useConversationSessions(): ConversationSessionSummary[] {
  const [sessions, setSessions] = useState<ConversationSessionSummary[]>([])

  useEffect(() => {
    if (typeof window.api.conversationSessionsList !== 'function') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const refresh = (): void => {
      void window.api
        .conversationSessionsList()
        .then((result) => {
          if (!cancelled && result.ok) setSessions(result.sessions)
        })
        .catch(() => undefined)
    }
    const scheduleRefresh = (): void => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        refresh()
      }, REFRESH_DEBOUNCE_MS)
    }

    refresh()
    const unsubscribe =
      typeof window.api.onConversationEvent === 'function'
        ? window.api.onConversationEvent((event) => {
            if (STATUS_EVENT_TYPES.has(event.type)) scheduleRefresh()
          })
        : null

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      unsubscribe?.()
    }
  }, [])

  return sessions
}
