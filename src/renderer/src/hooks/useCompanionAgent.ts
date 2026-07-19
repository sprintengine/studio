// Renderer bridge for a workspace-bound companion agent (see
// src/main/companion-agent-service.ts). A panel calls
// useCompanionAgent(workspaceId, agentId) to observe the companion's live
// status and its recent conversation events without bespoke store wiring —
// everything rides the existing conversation IPC (conversationSessionsList +
// onConversationEvent), the same surface the Sessions popover reads.
//
// This is a plain exported hook: RendererHost has no hook-registration slot, and
// none is needed. The companion's structured-run / chat / interrupt controls
// live main-side (the SDK's CompanionAgentsService); this hook is read-only.

import { useEffect, useRef, useState } from 'react'

import type {
  ConversationEvent,
  ConversationEventType,
  ConversationSessionStatus,
} from '../../../shared/conversation-runtime'

// The companion status vocabulary: the conversation-session statuses plus
// `absent` — no live session for this (workspaceId, agentId) yet, or disposed.
export type CompanionAgentStatus = ConversationSessionStatus | 'absent'

export type UseCompanionAgentResult = {
  status: CompanionAgentStatus
  /** The most recent conversation events for this companion, oldest first. */
  events: ConversationEvent[]
}

// Only these change the session's status; streaming deltas do not, so they only
// append to the event tail (they never trigger a status re-fetch).
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
// Bound the retained tail so a long-lived companion cannot grow this unbounded;
// panels that need the full history read conversationTranscript.
const MAX_RETAINED_EVENTS = 500

export function useCompanionAgent(
  workspaceId: string | null | undefined,
  agentId: string | null | undefined
): UseCompanionAgentResult {
  const [status, setStatus] = useState<CompanionAgentStatus>('absent')
  const [events, setEvents] = useState<ConversationEvent[]>([])
  const seenEventIds = useRef<Set<string>>(new Set())

  useEffect(() => {
    setStatus('absent')
    setEvents([])
    seenEventIds.current = new Set()
    if (!workspaceId || !agentId) return
    if (typeof window.api.conversationSessionsList !== 'function') return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const refresh = (): void => {
      void window.api
        .conversationSessionsList({ workspaceId, agentId })
        .then((result) => {
          if (cancelled) return
          // `absent` = no session in the projection (never spawned / disposed).
          const live = result.ok
            ? result.sessions.find((session) => session.status !== 'stopped')
            : undefined
          setStatus(live ? live.status : 'absent')
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
            if (event.workspaceId !== workspaceId || event.agentId !== agentId) return
            if (seenEventIds.current.has(event.id)) return
            seenEventIds.current.add(event.id)
            setEvents((prev) => {
              const next = [...prev, event]
              return next.length > MAX_RETAINED_EVENTS ? next.slice(-MAX_RETAINED_EVENTS) : next
            })
            if (STATUS_EVENT_TYPES.has(event.type)) scheduleRefresh()
          })
        : null

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      unsubscribe?.()
    }
  }, [workspaceId, agentId])

  return { status, events }
}
