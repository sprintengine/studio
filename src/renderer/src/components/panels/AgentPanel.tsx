import React from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { AgentStatus } from '../../types/workspace'
import TerminalView from './TerminalView'

interface Props {
  workspaceId: string
  agentId: string
}

const statusDot: Record<AgentStatus, string> = {
  idle: 'bg-zinc-600',
  running: 'bg-amber-400 animate-pulse',
  streaming: 'bg-emerald-400 animate-pulse',
  error: 'bg-red-500',
  complete: 'bg-zinc-500',
}

const statusLabel: Record<AgentStatus, string> = {
  idle: 'ready',
  running: 'running',
  streaming: 'streaming',
  error: 'error',
  complete: 'idle',
}

export default function AgentPanel({ workspaceId, agentId }: Props) {
  const status = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.agents[agentId]?.status ?? 'idle'
  )

  return (
    <div className="flex h-full flex-col bg-[#15171b] font-mono text-[12px] text-zinc-200">
      <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-[#23262d] bg-[#17191d] px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot[status]}`} />
          <span className="truncate text-[12px] text-zinc-200">{agentId}</span>
          <span className="shrink-0 text-[10px] uppercase tracking-[0.08em] text-zinc-500">
            {statusLabel[status]}
          </span>
        </div>
        <span className="shrink-0 text-[10px] uppercase tracking-[0.08em] text-zinc-500">cli</span>
      </div>

      <div className="relative flex-1 overflow-hidden bg-[#0b0c0e]">
        <TerminalView workspaceId={workspaceId} agentId={agentId} />
      </div>
    </div>
  )
}
