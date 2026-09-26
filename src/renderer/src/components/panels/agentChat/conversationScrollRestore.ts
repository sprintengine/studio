import { useEffect, useRef, useState } from 'react'
import type { ConversationScrollMemory } from './conversationViewState'

/** A remembered anchor may be older than the initial ten-turn snapshot. */
export function useConversationScrollRestore(input: {
  memory?: ConversationScrollMemory
  hydrated: boolean
  searching: boolean
  hasMore: boolean
  loadingEarlier: boolean
  rows: readonly { id: string }[]
  loadEarlier: () => Promise<void>
  restore: (index: number, offset: number) => void
}) {
  const done = useRef(false)
  const [fetching, setFetching] = useState(false)
  const latest = useRef(input)
  latest.current = input
  useEffect(() => {
    const current = latest.current
    if (done.current || !current.hydrated) return
    if (current.searching || !current.memory?.rowId || current.memory.atEnd) {
      done.current = true
      return
    }
    if (current.loadingEarlier || fetching) return
    const index = current.rows.findIndex((row) => row.id === current.memory!.rowId)
    if (index >= 0) {
      const frame = requestAnimationFrame(() => {
        done.current = true
        latest.current.restore(index, current.memory!.offset)
      })
      return () => cancelAnimationFrame(frame)
    }
    if (!current.hasMore) {
      done.current = true
      return
    }
    setFetching(true)
    void current
      .loadEarlier()
      .catch(() => {
        done.current = true
      })
      .finally(() => setFetching(false))
    return undefined
  }, [input.hydrated, input.searching, input.loadingEarlier, input.hasMore, input.rows, fetching])
}
