import React, { useMemo } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type {
  AgentCli,
  AgentRuntimeKind,
  AgentState,
  CliRuntimeSettings,
  PluginCatalogEntry,
  PluginCatalogStatus,
  WorkspaceMode,
} from '../../types/workspace'
import { normalizeAgentRuntime } from '../../store/slices/agentsSlice'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { MULTICODE_DISABLE_SPRINTENGINE_TERMINALS, MULTICODE_SAFE_MODE } from '../../utils/runtimeFlags'
import {
  isAgentCliMissing,
  selectAgentCliCatalog,
} from '../workspace/newWorkspace/cliRuntimeOptions'
import { PrimaryButton } from '../ui'

const TerminalView = React.lazy(() => import('./TerminalView'))
const AgentChatView = React.lazy(() => import('./AgentChatView'))

interface Props {
  workspaceId: string
  agentId: string
  sessionId?: string
  shouldKillTerminalOnUnmount?: (sessionId: string) => boolean
}

export function isStoredAgentCliUnavailable(
  cli: AgentCli | null | undefined,
  pluginCatalogStatus: PluginCatalogStatus,
  pluginCatalogEntries: PluginCatalogEntry[],
  cliRuntimes: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>> | undefined,
): boolean {
  if (pluginCatalogStatus !== 'ready') return false
  const catalog = selectAgentCliCatalog(pluginCatalogStatus, pluginCatalogEntries, cliRuntimes)
  return isAgentCliMissing(cli, catalog)
}

// Decide which runtime drives the `agent` panel. Sprint Engine and Multiloop
// agents are always terminal/MCP-owned regardless of any stored selection; only
// standard workspace agents that opted into a valid conversation runtime route
// to the conversation UI. Mirrors `normalizeAgentRuntime` for the standard case
// so a partial/corrupt selection falls back to terminal.
export function resolveAgentRuntimeKind(
  agent: Pick<AgentState, 'runtimeKind' | 'conversation' | 'kind'> | null | undefined,
  context: { isSprintEngineAgent: boolean; workspaceMode: WorkspaceMode | undefined },
): AgentRuntimeKind {
  if (!agent) return 'terminal'
  if (context.isSprintEngineAgent) return 'terminal'
  if (context.workspaceMode === 'sprintengine' || context.workspaceMode === 'multiloop') return 'terminal'
  if (agent.kind === 'sprintengine' || agent.kind === 'multiloop') return 'terminal'
  return normalizeAgentRuntime(agent).runtimeKind
}

export default function AgentPanel({
  workspaceId,
  agentId,
  sessionId,
  shouldKillTerminalOnUnmount,
}: Props) {
  const agent = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.agents[agentId]
  )
  const workspace = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId) ?? null
  )
  const sprintEngineRuntimeAgent = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.sprintEngineState?.sprintEngineAgents[agentId] ?? null
  )
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const pluginCatalogStatus = useWorkspaceStore((s) => s.pluginCatalogStatus)
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  const label = agent?.name ?? agentId
  const isSprintEngineAgent = workspace?.mode === 'sprintengine' && Boolean(sprintEngineRuntimeAgent)
  const sprintEngineTerminalBlocked = MULTICODE_DISABLE_SPRINTENGINE_TERMINALS && isSprintEngineAgent
  const runtimeKind = resolveAgentRuntimeKind(agent, {
    isSprintEngineAgent,
    workspaceMode: workspace?.mode,
  })
  const isConversationRuntime = runtimeKind === 'conversation'
  const cli = agent?.cli
  const agentCliUnavailable = useMemo(
    // Missing-CLI blocking is a terminal-runtime concern only; provider-backed
    // conversation agents do not launch a CLI and must not inherit it.
    () =>
      !isConversationRuntime
      && isStoredAgentCliUnavailable(cli, pluginCatalogStatus, pluginCatalogEntries, cliRuntimes),
    [isConversationRuntime, cli, pluginCatalogStatus, pluginCatalogEntries, cliRuntimes],
  )
  const hasStarted =
    !agentCliUnavailable
    && (Boolean(sessionId) || (!sprintEngineTerminalBlocked && (!isSprintEngineAgent || Boolean(agent?.cliStartRequested))))
  const needsInput = sprintEngineRuntimeAgent?.status === 'needs_input'
  const cliShellTone = needsInput
    ? 'border border-[color:var(--tone-warn)] bg-[color:var(--bg-surface-raised)] ring-1 ring-[color:var(--tone-warn-soft)]'
    : ''

  const startAgent = (restart = false) => {
    if (agentCliUnavailable) {
      publishDiagnosticSync({
        level: 'error',
        source: 'terminal',
        title: `${label} was not started`,
        message: `Agent CLI "${cli}" is unavailable. Reinstall or re-enable the plugin before launching this agent.`,
        workspaceId,
        workspaceName: workspace?.name,
        agentId,
      })
      return
    }
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

  if (isConversationRuntime) {
    return (
      <React.Suspense fallback={null}>
        <AgentChatView workspaceId={workspaceId} agentId={agentId} />
      </React.Suspense>
    )
  }

  return (
    <div className={`flex h-full flex-col bg-[color:var(--bg-surface)] font-mono text-[12px] text-[color:var(--text-default)] ${cliShellTone}`}>
      <div className={`relative flex-1 overflow-hidden bg-[color:var(--bg-app)] ${needsInput ? 'shadow-[inset_0_1px_0_var(--tone-warn-soft)]' : ''}`}>
        {hasStarted ? (
          <React.Suspense fallback={null}>
            <TerminalView
              workspaceId={workspaceId}
              agentId={agentId}
              sessionId={sessionId}
              shouldKillOnUnmount={shouldKillTerminalOnUnmount}
            />
          </React.Suspense>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-5 text-center">
            {sprintEngineTerminalBlocked ? (
              <div className="max-w-sm text-[12px] leading-5 text-[color:var(--text-muted)]">
                {MULTICODE_SAFE_MODE
                  ? 'Safe mode is active. Sprint Engine agent terminals are not auto-mounted.'
                  : 'Sprint Engine agent terminals are disabled for this diagnostic run.'}
              </div>
            ) : null}
            {agentCliUnavailable ? (
              <div className="max-w-sm text-[12px] leading-5 text-[color:var(--text-muted)]">
                Agent CLI "{cli}" is unavailable. Reinstall or re-enable the plugin before launching this agent.
              </div>
            ) : null}
            <PrimaryButton
              size="md"
              onClick={() => startAgent(false)}
              disabled={sprintEngineTerminalBlocked || agentCliUnavailable}
            >
              {startLabel}
            </PrimaryButton>
          </div>
        )}
      </div>
    </div>
  )
}
