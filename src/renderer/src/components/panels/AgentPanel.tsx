import React from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { AgentCli } from '../../types/workspace'
import { MULTICODE_DISABLE_SPRINTENGINE_TERMINALS, MULTICODE_SAFE_MODE } from '../../utils/runtimeFlags'
import TerminalView from './TerminalView'

interface Props {
  workspaceId: string
  agentId: string
  sessionId?: string
}

export default function AgentPanel({ workspaceId, agentId, sessionId }: Props) {
  const agent = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.agents[agentId]
  )
  const workspace = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId) ?? null
  )
  const sprintEngineRuntimeAgent = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.sprintEngineState?.sprintEngineAgents[agentId] ?? null
  )
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  const label = agent?.name ?? agentId
  const isSprintEngineAgent = workspace?.mode === 'sprintengine' && Boolean(sprintEngineRuntimeAgent)
  const sprintEngineTerminalBlocked = MULTICODE_DISABLE_SPRINTENGINE_TERMINALS && isSprintEngineAgent
  const hasStarted = Boolean(sessionId) || (!sprintEngineTerminalBlocked && (!isSprintEngineAgent || Boolean(agent?.cliStartRequested)))
  const needsInput = sprintEngineRuntimeAgent?.status === 'needs_input'
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

  const startLabel = sprintEngineRuntimeAgent?.role === 'architect' ? 'Spawn Architect' : `Spawn ${label}`

  return (
    <div className={`flex h-full flex-col bg-[#0d0e11] font-mono text-[12px] text-[#d7d7dc] ${cliShellTone}`}>
      <div className={`relative flex-1 overflow-hidden bg-[#08090b] ${needsInput ? 'shadow-[inset_0_1px_0_rgba(255,191,47,0.1)]' : ''}`}>
        {hasStarted ? (
          <TerminalView workspaceId={workspaceId} agentId={agentId} sessionId={sessionId} />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-5 text-center">
            {sprintEngineTerminalBlocked ? (
              <div className="max-w-sm text-[12px] leading-5 text-[#8a8a92]">
                {MULTICODE_SAFE_MODE
                  ? 'Safe mode is active. Sprint Engine agent terminals are not auto-mounted.'
                  : 'Sprint Engine agent terminals are disabled for this diagnostic run.'}
              </div>
            ) : null}
            <button
              onClick={() => startAgent(false)}
              disabled={sprintEngineTerminalBlocked}
              className="rounded-md border border-[#5c7cff]/50 bg-[#5c7cff] px-4 py-2 text-sm font-semibold text-[#08090b] transition-colors hover:bg-[#6e8eff] disabled:cursor-default disabled:border-[#3a3d49] disabled:bg-[#17181d] disabled:text-[#5a5a63]"
            >
              {startLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
