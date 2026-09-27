import { useEffect, useState } from 'react'
import { Tooltip } from '../../ui'

/** The index includes unloaded history; summing virtual rows would under-report. */
export function ConversationCost({
  workspaceRoot,
  workspaceId,
  agentId,
  enabled,
  hydrated,
  completionRevision,
}: {
  workspaceRoot: string | null
  workspaceId: string
  agentId: string
  enabled: boolean
  hydrated: boolean
  completionRevision: number
}) {
  const [cost, setCost] = useState<number | undefined>()
  useEffect(() => {
    setCost(undefined)
  }, [workspaceRoot, workspaceId, agentId, enabled])
  useEffect(() => {
    if (!enabled || !hydrated || !workspaceRoot || typeof window.api.conversationThreads !== 'function') return
    let disposed = false
    const refresh = async () => {
      try {
        const result = await window.api.conversationThreads({ workspaceRoot, workspaceId })
        if (!disposed && result.ok) setCost(result.threads.find((thread) => thread.agentId === agentId)?.totalCostUsd)
      } catch {
        // Keep the last confirmed amount rather than falsely reporting zero
        // when history cannot be read.
      }
    }
    void refresh()
    return () => {
      disposed = true
    }
  }, [workspaceRoot, workspaceId, agentId, enabled, hydrated, completionRevision])
  if (!enabled || cost === undefined || !Number.isFinite(cost)) return null
  return (
    <Tooltip content="Total reported conversation cost, including earlier turns" placement="top">
      <span
        className="whitespace-nowrap font-mono text-micro text-[color:var(--text-muted)]"
        aria-label={`Conversation cost: $${cost.toFixed(4)}`}
      >
        ${cost.toFixed(4)}
      </span>
    </Tooltip>
  )
}
