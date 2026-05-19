import React from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { MULTICODE_DISABLE_SPRINTENGINE_TERMINALS, MULTICODE_SAFE_MODE } from '../../utils/runtimeFlags'
import { PrimaryButton } from '../ui'
import TerminalView from './TerminalView'

interface Props {
  workspaceId: string
  agentId: string
  sessionId?: string
  shouldKillTerminalOnUnmount?: (sessionId: string) => boolean
}

export default function AgentPanel({ workspaceId, agentId, sessionId, shouldKillTerminalOnUnmount }: Props) {
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
  const cli = agent?.cli
  const cliShellTone = needsInput
    ? 'border border-[color:var(--tone-warn)] bg-[color:var(--bg-surface-raised)] ring-1 ring-[color:var(--tone-warn-soft)]'
    : ''

  const startAgent = (restart = false) => {
    if (!cli) {
      publishDiagnosticSync({
        level: 'error',
        source: 'terminal',
        title: `${label} was not started`,
        message: 'Agent terminal is missing its CLI selection.',
        workspaceId,
        workspaceName: workspace?.name,
        agentId,
      })
      return
    }
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
    <div className={`flex h-full flex-col bg-[color:var(--bg-surface)] font-mono text-[12px] text-[color:var(--text-default)] ${cliShellTone}`}>
      <div className={`relative flex-1 overflow-hidden bg-[color:var(--bg-app)] ${needsInput ? 'shadow-[inset_0_1px_0_var(--tone-warn-soft)]' : ''}`}>
        {hasStarted ? (
          <TerminalView
            workspaceId={workspaceId}
            agentId={agentId}
            sessionId={sessionId}
            shouldKillOnUnmount={shouldKillTerminalOnUnmount}
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-5 text-center">
            {sprintEngineTerminalBlocked ? (
              <div className="max-w-sm text-[12px] leading-5 text-[color:var(--text-muted)]">
                {MULTICODE_SAFE_MODE
                  ? 'Safe mode is active. Sprint Engine agent terminals are not auto-mounted.'
                  : 'Sprint Engine agent terminals are disabled for this diagnostic run.'}
              </div>
            ) : null}
            <PrimaryButton
              size="md"
              onClick={() => startAgent(false)}
              disabled={sprintEngineTerminalBlocked}
            >
              {startLabel}
            </PrimaryButton>
          </div>
        )}
      </div>
    </div>
  )
}
