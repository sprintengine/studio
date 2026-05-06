import React from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { AgentCli } from '../../types/workspace'
import { MULTICODE_DISABLE_SPRINTENGINE_TERMINALS, MULTICODE_SAFE_MODE } from '../../utils/runtimeFlags'
import TerminalView from './TerminalView'

interface Props {
  workspaceId: string
  agentId: string
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
  const label = agent?.name ?? agentId
  const isSwarmAgent = workspace?.mode === 'sprintengine' && Boolean(swarmRuntimeAgent)
  const swarmTerminalBlocked = MULTICODE_DISABLE_SPRINTENGINE_TERMINALS && isSwarmAgent
  const hasStarted = !swarmTerminalBlocked && (!isSwarmAgent || Boolean(agent?.cliStartRequested))
  const needsInput = swarmRuntimeAgent?.status === 'needs_input'
  const cli: AgentCli = agent?.cli ?? 'codex'
  const cliShellTone = needsInput
    ? 'border border-[#ffbf2f] bg-[#111216] shadow-[0_0_0_1px_rgba(255,191,47,0.18)]'
    : ''

  const startAgent = (restart = false) => {
    const existingSessionId = restart ? agent?.cliSessionId : undefined
    updateAgent(workspaceId, agentId, {
      cliStartRequested: true,
      cliSessionId: existingSessionId ?? crypto.randomUUID(),
      cliHasLaunched: false,
      cliOnboardingPromptSent: false,
      cliResumeAvailable: restart ? agent?.cliResumeAvailable ?? false : false,
      cliRestartNonce: (agent?.cliRestartNonce ?? 0) + 1,
      cli,
    })
  }

  const startLabel = swarmRuntimeAgent?.role === 'architect' ? 'Spawn Architect' : `Spawn ${label}`

  return (
    <div className={`flex h-full flex-col bg-[#0d0e11] font-mono text-[12px] text-[#d7d7dc] ${cliShellTone}`}>
      <div className={`relative flex-1 overflow-hidden bg-[#08090b] ${needsInput ? 'shadow-[inset_0_1px_0_rgba(255,191,47,0.1)]' : ''}`}>
        {hasStarted ? (
          <TerminalView workspaceId={workspaceId} agentId={agentId} />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-5 text-center">
            {swarmTerminalBlocked ? (
              <div className="max-w-sm text-[12px] leading-5 text-[#8a8a92]">
                {MULTICODE_SAFE_MODE
                  ? 'Safe mode is active. Sprint Engine agent terminals are not auto-mounted.'
                  : 'Sprint Engine agent terminals are disabled for this diagnostic run.'}
              </div>
            ) : null}
            <button
              onClick={() => startAgent(false)}
              disabled={swarmTerminalBlocked}
              className="rounded-md border border-[#6ee7d8]/50 bg-[#6ee7d8] px-4 py-2 text-sm font-semibold text-[#061210] transition-colors hover:bg-[#9af4ea] disabled:cursor-default disabled:border-[#2a4548] disabled:bg-[#172326] disabled:text-[#5f797d]"
            >
              {startLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
