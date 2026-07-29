import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useSession } from '../../hooks/useTerminalSessions'
import type {
  AgentCli,
  AgentCliAvailabilityMap,
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
  type CliAvailabilityFilterStatus,
} from '../workspace/newWorkspace/cliRuntimeOptions'
import { PrimaryButton, SkillPickerPopover, StarGlyph, Tooltip } from '../ui'
import { revealNavRailComponent } from '../../utils/modelRegistry'
import { dispatchBacklogReveal } from '../../utils/backlogReveal'
import { bracketedPaste } from '../../utils/terminalDrop'
import { clearAgentLaunchFailed } from '../../utils/terminalColdLoad'
import {
  ensureSkillForAgent,
  hasInstalledNativeSkillTarget,
  renderSkillInvocation,
  skillInstalledForHarness,
} from '../../utils/skillInvocation'
import type { WorkspaceSkill } from '../../../../shared/electron-api'

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
  availability?: { map: AgentCliAvailabilityMap | null | undefined; status: CliAvailabilityFilterStatus },
): boolean {
  if (pluginCatalogStatus !== 'ready') return false
  // Pass availability so an agent stored with a CLI whose binary is not
  // installed (e.g. Claude Code on a Codex-only machine) is flagged unavailable
  // and blocked from launching, not silently spawned against a missing binary.
  const catalog = selectAgentCliCatalog(pluginCatalogStatus, pluginCatalogEntries, cliRuntimes, availability)
  return isAgentCliMissing(cli, catalog)
}

// Decide which runtime drives the `agent` panel. Sprint Engine agents are
// always terminal/MCP-owned regardless of any stored selection; only
// standard workspace agents that opted into a valid conversation runtime route
// to the conversation UI. Mirrors `normalizeAgentRuntime` for the standard case
// so a partial/corrupt selection falls back to terminal.
export function resolveAgentRuntimeKind(
  agent: Pick<AgentState, 'runtimeKind' | 'conversation' | 'kind'> | null | undefined,
  context: { isSprintEngineAgent: boolean; workspaceMode: WorkspaceMode | undefined },
): AgentRuntimeKind {
  if (!agent) return 'terminal'
  if (context.isSprintEngineAgent) return 'terminal'
  if (context.workspaceMode === 'sprintengine') return 'terminal'
  if (agent.kind === 'sprintengine') return 'terminal'
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
  const cliAvailability = useWorkspaceStore((s) => s.cliAvailability)
  const cliAvailabilityStatus = useWorkspaceStore((s) => s.cliAvailabilityStatus)
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
      && isStoredAgentCliUnavailable(cli, pluginCatalogStatus, pluginCatalogEntries, cliRuntimes, {
        map: cliAvailability,
        status: cliAvailabilityStatus,
      }),
    [isConversationRuntime, cli, pluginCatalogStatus, pluginCatalogEntries, cliRuntimes, cliAvailability, cliAvailabilityStatus],
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
  // Resume-in-flight: TerminalView relaunches the CLI over a few seconds and
  // suppresses its boot output, so the footer must acknowledge the click/type
  // itself ("Resuming…") or it reads as dead. TerminalView broadcasts the state
  // (it owns the resume; typing there also triggers one). Success sends no
  // counterpart event — `suspended` flips off and the footer collapses still
  // reading "Resuming…"; the pending flag resets on the next suspend.
  const [isResumePending, setIsResumePending] = useState(false)
  useEffect(() => {
    if (!effectiveSessionId) return
    const onResumeState = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; resuming?: boolean }>).detail
      if (detail?.sessionId !== effectiveSessionId) return
      setIsResumePending(Boolean(detail?.resuming))
    }
    window.addEventListener('multicode:terminal-resume-state', onResumeState)
    return () => window.removeEventListener('multicode:terminal-resume-state', onResumeState)
  }, [effectiveSessionId])
  // Layout effect: a fresh suspend re-expands the footer, and the stale pending
  // flag from the previous resume must clear before that first paint or the
  // strip briefly reads "Resuming…" on a terminal that just paused.
  useLayoutEffect(() => {
    if (isTerminalSuspended) setIsResumePending(false)
  }, [isTerminalSuspended])
  // The terminal has a live agent process (green "live" dot). A suspended session
  // reports processAlive=false, so live and suspended are mutually exclusive.
  const isTerminalLive = Boolean(terminalSession?.processAlive)
  // Only a live terminal can be suspended (not an exited or already-suspended one).
  const canSuspendTerminal = hasStarted && isTerminalLive && !isTerminalSuspended
  // User lock ("keep running"): while locked the reaper never pauses this
  // terminal, so the pause button gives way to the closed-lock control — the
  // two actions are contradictory and only one should be offered at a time.
  const isTerminalLocked = Boolean(terminalSession?.reapExempt)
  // Same precondition as suspend on purpose: lock and pause are the two faces
  // of the same live-terminal control cluster.
  const canLockTerminal = canSuspendTerminal
  const toggleTerminalLock = () => {
    if (!effectiveSessionId) return
    // Feature-guard: against an old preload (dev HMR, stale built renderer)
    // the method is missing and an unguarded call would throw synchronously
    // in the click handler — the .catch only covers the promise.
    if (typeof window.api.setTerminalReapExempt !== 'function') return
    void window.api.setTerminalReapExempt(effectiveSessionId, !isTerminalLocked).catch(() => {})
  }
  // "Use a skill": live PTY agents only. Worktree agents are excluded like the
  // backlog file-drop path — ensure-install writes the main checkout's harness
  // dirs, which a worktree CLI does not read.
  const workspaceFolderPath = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.folderPath ?? null
  )
  const openExtensionsSurface = useWorkspaceStore((s) => s.openExtensionsSurface)
  const [skillPickerOpen, setSkillPickerOpen] = useState(false)
  const isWorktreeAgent = agent?.execution.mode === 'worktree'
  const canUseSkill =
    canSuspendTerminal && !isConversationRuntime && !isWorktreeAgent && Boolean(workspaceFolderPath)
  const useSkillInTerminal = async (skill: WorkspaceSkill) => {
    const targetSessionId = effectiveSessionId
    if (!targetSessionId || !workspaceFolderPath) return
    // Refresh builtin native targets (the picker only installed catalog
    // 'available' picks); then render the same per-CLI invocation the backlog
    // file-drop uses — native template when the harness copy exists, plain
    // prompt mention otherwise — and paste it unsubmitted.
    const ensured = await ensureSkillForAgent({ workspaceRoot: workspaceFolderPath, skill })
    if (!ensured.ok) {
      publishDiagnosticSync({
        level: 'error',
        source: 'workspace',
        title: 'Skill install failed',
        message: ensured.message,
        workspaceId,
        workspaceName,
      })
      return
    }
    const integration = pluginCatalogEntries.find((entry) => entry.id === cli)?.skillIntegration
    let nativeInstalled = skillInstalledForHarness(skill, integration)
    if (!nativeInstalled && skill.source === 'builtin' && integration) {
      const status = await window.api.builtinSkillStatus({
        workspaceRoot: workspaceFolderPath,
        skillId: skill.id,
      })
      if (status.ok) {
        nativeInstalled = hasInstalledNativeSkillTarget(integration.harnessId, cli ?? '', status.targets)
      }
    }
    const invocation = renderSkillInvocation({ skill, integration, nativeInstalled })
    await window.api.terminalWrite(targetSessionId, bracketedPaste(`${invocation} `))
  }
  const suspendTerminal = () => {
    if (!effectiveSessionId) return
    void window.api.terminalSuspend(effectiveSessionId).catch(() => {})
  }
  // Resume is owned by TerminalView (it holds the relaunch payload + keystroke
  // buffer), so the paused footer asks it to resume via a window event keyed by
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
    // A deliberate Spawn/Restart is the user asking to try again, exactly like a
    // click on an inert pane (startInertAgent). Drop any "launch failed this
    // session" marker so the cold-load decision lets this fresh attempt spawn
    // instead of gating it back to inert on the stale failure.
    clearAgentLaunchFailed(workspaceId, agentId)
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
      <div className={`group relative flex flex-1 flex-col overflow-hidden bg-[color:var(--bg-app)] ${needsInput ? 'shadow-[inset_0_1px_0_var(--tone-warn-soft)]' : ''}`}>
        {hasStarted && (canSuspendTerminal || canLockTerminal || backlogItemRef || canUseSkill) ? (
          // The positioning lives on this wrapper, not the buttons: Tooltip wraps
          // its child in a `position: relative` span, so an `absolute` child
          // would anchor to that zero-size span (off-screen) instead of the
          // terminal surface. Liveness shows on the workspace tab (single source
          // of truth); here we keep the skill picker, pause, lock, and Backlog
          // link. The suspended state is surfaced by the quiet footer below,
          // not a button.
          <div className="absolute right-2 top-2 z-30 flex items-center gap-1.5">
            {canUseSkill ? (
              <SkillPickerPopover
                open={skillPickerOpen}
                onOpenChange={setSkillPickerOpen}
                workspaceRoot={workspaceFolderPath}
                pluginId={cli}
                onPick={(skill) => void useSkillInTerminal(skill)}
                onManageSkills={() => openExtensionsSurface({ view: 'installed' })}
                placement="bottom-end"
                renderTrigger={({ ref, triggerProps, togglePopover, open }) => (
                  <Tooltip content="Use a skill — inserts the invocation at the prompt" placement="bottom">
                    <button
                      ref={ref}
                      type="button"
                      onClick={togglePopover}
                      aria-label="Use a skill"
                      className={`interactive inline-flex h-7 w-7 items-center justify-center rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] transition-opacity hover:border-[color:var(--border-default)] hover:text-[color:var(--text-default)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)] group-hover:opacity-100 ${open ? 'opacity-100' : 'opacity-0'}`}
                      {...triggerProps}
                    >
                      <StarGlyph filled={false} stroked className="h-[15px] w-[15px]" />
                    </button>
                  </Tooltip>
                )}
              />
            ) : null}
            {canSuspendTerminal && !isTerminalLocked ? (
              // Hover-revealed so it doesn't clutter the live terminal; the same
              // pause glyph as the suspended state (context disambiguates: a
              // button while live, a status indicator once suspended). Hidden
              // while locked — the lock's whole promise is "never paused".
              <Tooltip content="Suspend agent — free its memory, keep the output to read" placement="bottom">
                <button
                  type="button"
                  onClick={suspendTerminal}
                  aria-label="Suspend agent to free memory"
                  className="interactive inline-flex h-7 w-7 items-center justify-center rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] opacity-0 transition-opacity hover:border-[color:var(--border-default)] hover:text-[color:var(--text-default)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)] group-hover:opacity-100"
                >
                  <svg viewBox="0 0 16 16" fill="none" className="h-[15px] w-[15px]" aria-hidden="true">
                    <rect x="5" y="4" width="2" height="8" rx="1" fill="currentColor" />
                    <rect x="9" y="4" width="2" height="8" rx="1" fill="currentColor" />
                  </svg>
                </button>
              </Tooltip>
            ) : null}
            {canLockTerminal ? (
              // Lock ("keep running"): exempts this terminal from automatic
              // pausing. Locked state stays visible as a standing status mark;
              // unlocked is hover-revealed like its neighbors.
              <Tooltip
                content={
                  isTerminalLocked
                    ? 'Locked — never paused automatically. Click to unlock.'
                    : 'Lock — keep this terminal running, never pause it automatically'
                }
                placement="bottom"
              >
                <button
                  type="button"
                  onClick={toggleTerminalLock}
                  aria-label={isTerminalLocked ? 'Unlock terminal — allow automatic pausing' : 'Lock terminal — never pause automatically'}
                  aria-pressed={isTerminalLocked}
                  className={`interactive inline-flex h-7 w-7 items-center justify-center rounded-md border transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)] group-hover:opacity-100 ${
                    isTerminalLocked
                      ? 'border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-default)] opacity-100'
                      : 'border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] opacity-0 hover:border-[color:var(--border-default)] hover:text-[color:var(--text-default)]'
                  }`}
                >
                  {isTerminalLocked ? (
                    // Closed padlock: shackle seated on the body.
                    <svg viewBox="0 0 16 16" fill="none" className="h-[15px] w-[15px]" aria-hidden="true">
                      <rect x="3.75" y="7" width="8.5" height="5.75" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                      <path d="M5.75 7V5.4a2.25 2.25 0 0 1 4.5 0V7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                    </svg>
                  ) : (
                    // Open padlock: right leg of the shackle lifted clear of the body.
                    <svg viewBox="0 0 16 16" fill="none" className="h-[15px] w-[15px]" aria-hidden="true">
                      <rect x="3.75" y="7" width="8.5" height="5.75" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                      <path d="M5.75 7V4.4a2.25 2.25 0 0 1 4.5 0v.35" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                    </svg>
                  )}
                </button>
              </Tooltip>
            ) : null}
            {backlogItemRef ? (
              <Tooltip content={`Open Backlog item: ${backlogItemRef.title}`} placement="bottom">
                <button
                  type="button"
                  onClick={openLinkedBacklogItem}
                  aria-label={`Open Backlog item: ${backlogItemRef.title}`}
                  className="interactive inline-flex h-7 w-7 items-center justify-center rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] hover:border-[color:var(--border-default)] hover:text-[color:var(--text-default)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]"
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
        {/* Terminal area. `min-h-0` lets it shrink so the paused footer below can
            reserve its strip without ever overlapping output; TerminalView is
            `absolute inset-0`, so it anchors to this relative box (not the pane),
            and its ResizeObserver refits xterm when the footer claims/releases
            space. */}
        <div className="relative min-h-0 flex-1">
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
                    ? 'Safe mode is active. Sprint agent terminals are not auto-mounted.'
                    : 'Sprint agent terminals are disabled for this diagnostic run.'}
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
        {/* Paused indicator: a quiet, reserved footer (not an overlay) so the
            frozen scrollback above stays fully readable and scrollable. It is the
            whole resume affordance — keyboard-focusable, click resumes (typing or
            a click on the pane also resume) — and it doubles as resume feedback:
            the label flips to "Resuming…" (glyph pulsing) until the live TUI
            repaints, since the relaunch takes seconds with boot output withheld.
            The wrapper stays mounted (inert at 0fr) so the strip animates its
            claim/release of terminal space instead of jumping the pane by a row;
            the ResizeObserver in TerminalView refits xterm through the ease. */}
        {hasStarted ? (
          <div
            aria-hidden={!isTerminalSuspended}
            className={`grid flex-none transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
              isTerminalSuspended ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
            }`}
          >
            <div className="overflow-hidden">
              <button
                type="button"
                onClick={resumeTerminal}
                tabIndex={isTerminalSuspended ? 0 : -1}
                aria-label={
                  isResumePending
                    ? 'Resuming agent'
                    : 'Resume paused agent — click or type to resume'
                }
                className="group flex w-full items-center gap-2 border-t border-[color:var(--border-subtle)] bg-[color:var(--bg-app)] px-3.5 py-2 text-left text-[11px] text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-default)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]"
              >
                {/* Pause glyph, low-opacity — a status mark, not a call to action.
                    The pulse while resuming is the "alive right now" signal; it
                    stops once the resume lands (suspended flips off) so the
                    collapse is the only motion during the strip's exit. */}
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  className={`h-[11px] w-[11px] opacity-60 ${
                    isResumePending && isTerminalSuspended
                      ? 'animate-pulse motion-reduce:animate-none'
                      : ''
                  }`}
                  aria-hidden="true"
                >
                  <rect x="5" y="4" width="2" height="8" rx="1" fill="currentColor" />
                  <rect x="9" y="4" width="2" height="8" rx="1" fill="currentColor" />
                </svg>
                <span>{isResumePending ? 'Resuming…' : 'Paused'}</span>
                {/* Hint stays hidden until pane hover (kept low-key), but reveals
                    at full muted contrast — a reduced opacity here fell under the
                    WCAG AA text threshold against --bg-app. Withheld while a
                    resume is in flight: the action already happened.
                    The keyboard path is this button's own `group` plus
                    `group-focus-visible`, not the pane's `focus-within`: the pane
                    holds the terminal, so focus-within there would pin the hint
                    open for the whole session instead of disclosing it. */}
                <span
                  className={`ml-auto opacity-0 transition-opacity motion-reduce:transition-none ${
                    isResumePending ? '' : 'group-hover:opacity-100 group-focus-visible:opacity-100'
                  }`}
                >
                  click or type to resume
                </span>
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
