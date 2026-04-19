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
  const agent = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.agents[agentId]
  )
  const swarmRuntimeAgent = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.swarmState?.swarmAgents[agentId] ?? null
  )
  const status = agent?.status ?? 'idle'
  const label = agent?.name ?? agentId
  const needsInput = swarmRuntimeAgent?.status === 'needs_input'
  const currentTaskId = swarmRuntimeAgent?.currentTaskId ?? null
  const cliShellTone = needsInput
    ? 'border border-amber-300/60 bg-[#18150f] shadow-[0_0_0_1px_rgba(251,191,36,0.2),0_0_34px_rgba(245,158,11,0.22)]'
    : ''
  const cliHeaderTone = needsInput
    ? 'border-b border-amber-300/30 bg-[linear-gradient(90deg,rgba(245,158,11,0.18),rgba(23,25,29,0.96)_42%)]'
    : 'border-b border-[#23262d] bg-[#17191d]'

  return (
    <div className={`flex h-full flex-col bg-[#15171b] font-mono text-[12px] text-zinc-200 ${cliShellTone}`}>
      <div className={`flex h-9 shrink-0 items-center justify-between gap-3 px-3 ${cliHeaderTone}`}>
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot[status]}`} />
          <span className="truncate text-[12px] text-zinc-200">{label}</span>
          <span className="shrink-0 text-[10px] uppercase tracking-[0.08em] text-zinc-500">
            {statusLabel[status]}
          </span>
          {needsInput ? (
            <>
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-300 shadow-[0_0_10px_rgba(252,211,77,0.95)]" />
              <span className="shrink-0 rounded-full border border-amber-300/30 bg-amber-200/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-200">
                Needs Input
              </span>
              {currentTaskId ? (
                <span className="shrink-0 text-[10px] uppercase tracking-[0.08em] text-amber-100/70">
                  {currentTaskId}
                </span>
              ) : null}
            </>
          ) : null}
        </div>
        <span className={`shrink-0 text-[10px] uppercase tracking-[0.08em] ${needsInput ? 'text-amber-200' : 'text-zinc-500'}`}>
          cli
        </span>
      </div>

      <div className={`relative flex-1 overflow-hidden bg-[#0b0c0e] ${needsInput ? 'shadow-[inset_0_1px_0_rgba(251,191,36,0.08)]' : ''}`}>
        <TerminalView workspaceId={workspaceId} agentId={agentId} />
      </div>
    </div>
  )
}
