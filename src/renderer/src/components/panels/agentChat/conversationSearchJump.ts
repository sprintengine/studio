import { useEffect, useRef, useState } from 'react'
import type { ConversationTimelineRow } from './conversationTimeline'
import { clearConversationJump, usePendingConversationJump } from '../../../utils/conversationHistoryNavigation'

export function conversationJumpIndex(rows: readonly ConversationTimelineRow[], seq: number): number {
  const exact = rows.findIndex((row) => row.kind === 'user' && row.entry.seq === seq)
  if (exact >= 0) return exact
  // An orphaned assistant event can still name its checkpoint's user turn.
  return rows.findIndex((row) => row.kind === 'assistant' && row.entry.checkpointTurnSeq === seq)
}

/** Search jumps page backwards through the same bounded transcript API as scrollback. */
export function useConversationSearchJump(input: {
  workspaceId: string
  agentId: string
  rows: readonly ConversationTimelineRow[]
  hydrated: boolean
  hasMore: boolean
  loadingEarlier: boolean
  loadEarlier: () => Promise<void>
  scrollToRow: (index: number, id: string) => void
  pauseFollowing: () => void
  reportError: (message: string) => void
}) {
  const pending = usePendingConversationJump(input.workspaceId, input.agentId)
  const [flashRowId, setFlashRowId] = useState<string | null>(null)
  const [fetching, setFetching] = useState(false)
  const latest = useRef(input)
  latest.current = input
  useEffect(() => {
    if (pending === null) return
    latest.current.pauseFollowing()
    if (!input.hydrated || input.loadingEarlier || fetching) return
    const index = conversationJumpIndex(input.rows, pending)
    if (index >= 0) {
      const row = input.rows[index]
      const frame = requestAnimationFrame(() => {
        latest.current.scrollToRow(index, row.id)
        if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) setFlashRowId(row.id)
        clearConversationJump(input.workspaceId, input.agentId)
      })
      return () => cancelAnimationFrame(frame)
    }
    if (input.hasMore) {
      setFetching(true)
      void input
        .loadEarlier()
        .catch(() => {
          latest.current.reportError('Could not load the matching turn. Try the search again.')
          clearConversationJump(input.workspaceId, input.agentId)
        })
        .finally(() => {
          setFetching(false)
        })
    } else {
      input.reportError('The matching turn is no longer available in this conversation.')
      clearConversationJump(input.workspaceId, input.agentId)
    }
    return undefined
  }, [
    pending,
    fetching,
    input.workspaceId,
    input.agentId,
    input.rows,
    input.hydrated,
    input.hasMore,
    input.loadingEarlier,
    input.loadEarlier,
    input.reportError,
  ])
  return { flashRowId, clearFlash: () => setFlashRowId(null) }
}
