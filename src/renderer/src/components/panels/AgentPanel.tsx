import React from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { AgentCli, AgentStatus } from '../../types/workspace'
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
  const workspace = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId) ?? null
  )
  const swarmRuntimeAgent = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.swarmState?.swarmAgents[agentId] ?? null
  )
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  const status = agent?.status ?? 'idle'
  const label = agent?.name ?? agentId
  const isSwarmAgent = workspace?.mode === 'swarm' && Boolean(swarmRuntimeAgent)
  const hasStarted = !isSwarmAgent || Boolean(agent?.cliStartRequested)
  const needsInput = swarmRuntimeAgent?.status === 'needs_input'
  const currentTaskId = swarmRuntimeAgent?.currentTaskId ?? null
  const cli: AgentCli = agent?.cli ?? 'codex'
  const cliShellTone = needsInput
    ? 'border border-[#ffbf2f]/70 bg-[#111216] shadow-[0_0_0_1px_rgba(255,191,47,0.18),0_0_34px_rgba(255,191,47,0.2)]'
    : ''
  const cliHeaderTone = needsInput
    ? 'border-b border-[#ffbf2f]/45 bg-[#111216] shadow-[inset_0_2px_0_rgba(255,191,47,0.75)]'
    : 'border-b border-[#23262d] bg-[#17191d]'

  const startAgent = (restart = false) => {
    const existingSessionId = restart ? agent?.cliSessionId : undefined
    updateAgent(workspaceId, agentId, {
      cliStartRequested: true,
      cliSessionId: existingSessionId ?? crypto.randomUUID(),
      cliHasLaunched: false,
      cliOnboardingPromptSent: false,
      cliRestartNonce: (agent?.cliRestartNonce ?? 0) + 1,
      cli,
    })
  }

  const startLabel = swarmRuntimeAgent?.role === 'architect' ? 'Spawn Architect' : `Spawn ${label}`

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
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#ffbf2f] shadow-[0_0_12px_rgba(255,191,47,0.95)]" />
              <span className="shrink-0 rounded-full border border-[#ffbf2f]/55 bg-[#ffbf2f]/12 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#ffe0a3] shadow-[0_0_16px_rgba(255,191,47,0.12)]">
                Needs Input
              </span>
              {currentTaskId ? (
                <span className="shrink-0 text-[10px] uppercase tracking-[0.08em] text-[#ffe0a3]/80">
                  {currentTaskId}
                </span>
              ) : null}
            </>
          ) : null}
        </div>
        <span className={`shrink-0 text-[10px] uppercase tracking-[0.08em] ${needsInput ? 'text-[#ffe0a3]' : 'text-zinc-500'}`}>
          {cli}
        </span>
      </div>

      <div className={`relative flex-1 overflow-hidden bg-[#0b0c0e] ${needsInput ? 'shadow-[inset_0_1px_0_rgba(255,191,47,0.1)]' : ''}`}>
        {hasStarted ? (
          <TerminalView workspaceId={workspaceId} agentId={agentId} />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center p-5">
            <button
              onClick={() => startAgent(false)}
              className="rounded-md border border-[#6ee7d8]/50 bg-[#6ee7d8] px-4 py-2 text-sm font-semibold text-[#061210] transition-colors hover:bg-[#9af4ea]"
            >
              {startLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
