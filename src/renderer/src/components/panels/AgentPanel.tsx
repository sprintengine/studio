import React, { useCallback, useMemo } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useSession } from '../../hooks/useTerminalSessions'
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
import { PrimaryButton, StatusDot, Tooltip } from '../ui'
import { revealNavRailComponent } from '../../utils/modelRegistry'
import { dispatchBacklogReveal } from '../../utils/backlogReveal'

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
  const workspaceMode = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.mode
  )
  const workspaceName = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.name
  )
  const sprintEngineRuntimeRole = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.sprintEngineState?.sprintEngineAgents[agentId]?.role
  )
  const sprintEngineRuntimeStatus = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.sprintEngineState?.sprintEngineAgents[agentId]?.status
  )
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const pluginCatalogStatus = useWorkspaceStore((s) => s.pluginCatalogStatus)
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  const label = agent?.name ?? agentId
  const isSprintEngineAgent = workspaceMode === 'sprintengine' && Boolean(sprintEngineRuntimeRole)
  const sprintEngineTerminalBlocked = MULTICODE_DISABLE_SPRINTENGINE_TERMINALS && isSprintEngineAgent
  const runtimeKind = resolveAgentRuntimeKind(agent, {
    isSprintEngineAgent,
    workspaceMode,
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
  const needsInput = sprintEngineRuntimeStatus === 'needs_input'
  // Freeze-the-view: when this agent's terminal has been suspended (process
  // killed to reclaim memory, scrollback kept painted), surface a glyph so the
  // user knows it is not live and will resume on the next keystroke. Tracked off
  // the session snapshot's `suspended` flag; `processAlive` co-varies, so the
  // (deduped) sessions signature re-renders this on suspend/resume.
  // The real terminal session id: the `sessionId` prop is only set for attached
  // sessions; a normally-launched agent carries its id on `agent.cliSessionId`
  // (TerminalView resolves it the same way). Keying the glyph/button off the bare
  // prop is why it never showed for normal agents.
  const effectiveSessionId = sessionId ?? agent?.cliSessionId
  const terminalSession = useSession(
    useCallback(
      (s) => Boolean(effectiveSessionId) && s.sessionId === effectiveSessionId,
      [effectiveSessionId],
    ),
  )
  const isTerminalSuspended = Boolean(terminalSession?.suspended)
  // The terminal has a live agent process (green "live" dot). A suspended session
  // reports processAlive=false, so live and suspended are mutually exclusive.
  const isTerminalLive = Boolean(terminalSession?.processAlive)
  // Only a live terminal can be suspended (not an exited or already-suspended one).
  const canSuspendTerminal = hasStarted && isTerminalLive && !isTerminalSuspended
  const suspendTerminal = () => {
    if (!effectiveSessionId) return
    void window.api.terminalSuspend(effectiveSessionId).catch(() => {})
  }
  // Resume is owned by TerminalView (it holds the relaunch payload + keystroke
  // buffer), so the play button asks it to resume via a window event keyed by
  // session id — same path as typing into the suspended terminal.
  const resumeTerminal = () => {
    if (!effectiveSessionId) return
    window.dispatchEvent(
      new CustomEvent('multicode:resume-terminal', { detail: { sessionId: effectiveSessionId } }),
    )
  }
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
        workspaceName,
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
        workspaceName,
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

  const startLabel = sprintEngineRuntimeRole === 'architect' ? 'Spawn Architect' : `Spawn ${label}`

  if (isConversationRuntime) {
    return (
      <React.Suspense fallback={null}>
        <AgentChatView workspaceId={workspaceId} agentId={agentId} />
      </React.Suspense>
    )
  }

  // The Backlog item this agent was handed, if any. Powers the glyph that
  // navigates back to it: reveal the Backlog panel, then latch the item so the
  // panel selects it whether it was already open or mounts on reveal.
  const backlogItemRef = agent?.backlogItemRef
  const openLinkedBacklogItem = () => {
    if (!backlogItemRef) return
    revealNavRailComponent(workspaceId, 'backlog', 'Backlog')
    dispatchBacklogReveal({ workspaceId, relativePath: backlogItemRef.relativePath })
  }

  return (
    <div className={`flex h-full flex-col bg-[color:var(--bg-surface)] font-mono text-[12px] text-[color:var(--text-default)] ${cliShellTone}`}>
      <div className={`group relative flex-1 overflow-hidden bg-[color:var(--bg-app)] ${needsInput ? 'shadow-[inset_0_1px_0_var(--tone-warn-soft)]' : ''}`}>
        {hasStarted && (isTerminalLive || isTerminalSuspended || backlogItemRef) ? (
          // The positioning lives on this wrapper, not the buttons: Tooltip wraps
          // its child in a `position: relative` span, so an `absolute` child
          // would anchor to that zero-size span (off-screen) instead of the
          // terminal surface. Glyphs sit inline in a single top-right row.
          <div className="absolute right-2 top-2 z-30 flex items-center gap-1.5">
            {isTerminalLive ? (
              // Green "live" dot: the agent process is running. Absent once the
              // terminal is suspended (where the play button takes over).
              <Tooltip content="Agent is live" placement="bottom">
                <span className="inline-flex h-7 items-center px-1">
                  <StatusDot tone="good" size={8} label="Agent terminal live" />
                </span>
              </Tooltip>
            ) : null}
            {isTerminalSuspended ? (
              // Suspended state is a distinct, accented PLAY button (not a muted
              // pause indicator) so the suspend→resume transition is obvious and
              // the resume affordance is clear. Click resumes; typing also resumes.
              <Tooltip content="Suspended to free memory — click or type to resume" placement="bottom">
                <button
                  type="button"
                  onClick={resumeTerminal}
                  aria-label="Resume suspended agent"
                  className="interactive inline-flex h-7 w-7 items-center justify-center rounded-md border border-[color:var(--accent-primary-soft)] bg-[color:var(--bg-surface-raised)] text-[color:var(--accent-primary)] shadow-sm transition-colors hover:border-[color:var(--accent-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)]"
                >
                  {/* Play triangle reads as "resume". */}
                  <svg viewBox="0 0 16 16" fill="none" className="h-[15px] w-[15px]" aria-hidden="true">
                    <path d="M5.5 4.2 11.5 8l-6 3.8V4.2Z" fill="currentColor" />
                  </svg>
                </button>
              </Tooltip>
            ) : null}
            {canSuspendTerminal ? (
              // Hover-revealed so it doesn't clutter the live terminal; the same
              // pause glyph as the suspended state (context disambiguates: a
              // button while live, a status indicator once suspended).
              <Tooltip content="Suspend agent — free its memory, keep the output to read" placement="bottom">
                <button
                  type="button"
                  onClick={suspendTerminal}
                  aria-label="Suspend agent to free memory"
                  className="interactive inline-flex h-7 w-7 items-center justify-center rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] opacity-0 shadow-sm transition-opacity transition-colors hover:border-[color:var(--border-default)] hover:text-[color:var(--text-default)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)] group-hover:opacity-100"
                >
                  <svg viewBox="0 0 16 16" fill="none" className="h-[15px] w-[15px]" aria-hidden="true">
                    <rect x="5" y="4" width="2" height="8" rx="1" fill="currentColor" />
                    <rect x="9" y="4" width="2" height="8" rx="1" fill="currentColor" />
                  </svg>
                </button>
              </Tooltip>
            ) : null}
            {backlogItemRef ? (
              <Tooltip content={`Open Backlog item: ${backlogItemRef.title}`} placement="bottom">
                <button
                  type="button"
                  onClick={openLinkedBacklogItem}
                  aria-label={`Open Backlog item: ${backlogItemRef.title}`}
                  className="interactive inline-flex h-7 w-7 items-center justify-center rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] shadow-sm transition-colors hover:border-[color:var(--border-default)] hover:text-[color:var(--text-default)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)]"
                >
                  {/* Matches the Backlog rail glyph (PanelRail) so the iconography
                      reads as "the Backlog" at a glance. */}
                  <svg viewBox="0 0 16 16" fill="none" className="h-[15px] w-[15px]" aria-hidden="true">
                    <path d="M6 4.5h7M6 8h7M6 11.5h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                    <circle cx="3" cy="4.5" r="1" fill="currentColor" />
                    <circle cx="3" cy="8" r="1" fill="currentColor" />
                    <circle cx="3" cy="11.5" r="1" fill="currentColor" />
                  </svg>
                </button>
              </Tooltip>
            ) : null}
          </div>
        ) : null}
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
