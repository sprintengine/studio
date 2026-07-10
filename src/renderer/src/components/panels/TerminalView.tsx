import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useWorkspaceFolderStatus } from '../../hooks/useWorkspaceFolderStatus'
import type { AgentExecution, AgentExecutionMode, AgentKind } from '../../types/workspace'
import type { AgentSessionSystem, TerminalSpawnMetadata, TerminalSpawnResult } from '../../../../shared/electron-api'
import { useSession } from '../../hooks/useTerminalSessions'
import {
  buildSpecialistSoulStartupPrompt,
  getSpecialistAction,
  resolveDesignSystemAttachedPromptLine,
} from '../../specialists/specialistActions'
import { buildSprintEngineAgentRosterForState, buildSprintEngineRosterCommandArgs, getSprintEngineRoleLabel } from '../../utils/sprintengine'
import { buildSprintEngineStartupPrompt, getSprintEngineStartupCommandMode, prependAgentIdentifier } from '../../utils/agentPrompt'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { recordReplayProfile } from '../../utils/diagnostics/replayProfileStore'
import { createTerminalFitScheduler } from '../../utils/terminalFitScheduler'
import { createTerminalDiagnostics } from '../../utils/terminalDiagnostics'
import { createTerminalFileLinkProvider } from '../../utils/terminalFileLinks'
import { createXtermOutputQueue, createXtermReplayGate } from '../../utils/xtermOutputQueue'
import { registerTerminalInstance, unregisterTerminalInstance } from '../../utils/diagnostics/terminalInstanceRegistry'
import { TerminalReplaySkeleton } from '../ui/TerminalReplaySkeleton'
import { bindTerminalClipboardHandlers } from '../../utils/terminalClipboard'
import { bindTerminalTheme, getTerminalTheme } from '../../utils/terminalTheme'
import {
  hasCommitDropData,
  hasFileDropData,
  pasteDroppedCommitIntoTerminal,
  pasteDroppedFilesIntoTerminal,
} from '../../utils/terminalDrop'
import { recordBacklogAgentHandoff } from '../../utils/backlogAgentHandoff'
import { MONO_FONT_STACK, waitForMonoFontReady } from '../../utils/fonts'
import { isImageFile } from '../../utils/files'
import { resolveProjectKnowledgeConfig } from '../../utils/projectKnowledge'
import { resolveAgentCliPermissionPreset } from '../../utils/agentCliPermissions'
import { agentCliSupportsConversationResume, agentCliUsesStableSessionIdForResume } from '../../utils/agentCliResume'
import { resumeCapabilitiesForCli } from '../../store/slices/pluginsSlice'
import { deriveSprintEngineAutomationDesiredMode } from '../../utils/sprintengineAutomationLifecycle'
import { resolveWorkspaceTerminalCwd, resolveWorkspaceWorktree, resolveWorktreeSpawnFallback } from '../../utils/workspaceWorktree'
import type { McpSettings } from '../../types/workspace'
import { CursorErrorPopover } from '../ui/CursorErrorPopover'
import { workspaceSyncClient } from '../../store/workspaceSyncClient'
import { TERMINAL_RECENT_SCROLLBACK_LINES } from '../../../../shared/terminal-history'
import { openFileSurface } from '../../utils/openFileSurface'

interface Props {
  workspaceId: string
  agentId: string
  sessionId?: string
  shouldKillOnUnmount?: (sessionId: string) => boolean
}

type AgentExecutionRoot = {
  cwd: string | undefined
  mode: AgentExecutionMode
  worktreeId: string | undefined
  worktreePath: string | undefined
}

type MemoryLaunchContext = {
  promptSuffix: string | null
  rootPath: string | undefined
  relativeRoot: string | undefined
}

const EMPTY_MCP_SETTINGS: McpSettings = { syncEnabled: false, servers: {} }

function resolveAgentExecutionRoot(
  execution: AgentExecution | undefined,
  storedWorktreePath: string | undefined,
  workspaceReadyPath: string | null,
  workspaceWorktreeCwd: string | null
): AgentExecutionRoot {
  if (execution?.mode !== 'worktree') {
    // A non-worktree agent (manually-added conversation agent, agent whose
    // execution predates baked worktree metadata, or cleared execution) in a
    // worktree-backed workspace still belongs in that workspace's worktree, not
    // its parent folderPath. Redirect only the cwd; the mode stays
    // 'current_workspace' (Decision 6) and agent.execution is not mutated.
    return {
      cwd: workspaceWorktreeCwd ?? workspaceReadyPath ?? undefined,
      mode: 'current_workspace',
      worktreeId: undefined,
      worktreePath: undefined,
    }
  }

  const worktreePath = execution.cwd ?? storedWorktreePath

  return {
    cwd: worktreePath ?? workspaceReadyPath ?? undefined,
    mode: 'worktree',
    worktreeId: execution.worktreeId ?? undefined,
    worktreePath,
  }
}

async function resolveMemoryLaunchContext(
  workspaceRoot: string | null,
  relativeRoot: string | null
): Promise<MemoryLaunchContext> {
  const configuredRoot = relativeRoot?.trim()
  if (!configuredRoot) return { promptSuffix: null, rootPath: undefined, relativeRoot: undefined }

  const status = await window.api.memoryResolveRoot({
    workspaceRoot,
    relativeRoot: configuredRoot,
  }).catch((error): MemoryRootStatus => ({
    ok: false,
    status: 'inaccessible',
    relativeRoot: configuredRoot,
    message: error instanceof Error ? error.message : 'Unable to resolve workspace knowledge.',
  }))

  if (status.ok) {
    return {
      rootPath: status.rootPath,
      relativeRoot: status.relativeRoot,
      promptSuffix: [
        `Knowledge Graph is configured at ${status.relativeRoot}.`,
        'This is a repo-local Markdown knowledge graph for product, architecture, brand, and ecosystem context.',
        'Inspect it when relevant instead of assuming project context.',
        'Use the workspace-knowledge skill if it is installed in .agents/skills.',
      ].join(' '),
    }
  }

  return {
    rootPath: undefined,
    relativeRoot: configuredRoot,
    promptSuffix: `Knowledge Graph is configured at ${configuredRoot}, but the folder is currently missing or inaccessible. Do not guess another knowledge folder.`,
  }
}

function appendMemoryPrompt(prompt: string | undefined, memoryContext: MemoryLaunchContext): string | undefined {
  if (!memoryContext.promptSuffix) return prompt
  if (!prompt) return memoryContext.promptSuffix
  return `${prompt}\n\n${memoryContext.promptSuffix}`
}

// Attached-design-system launch line, same shape as the knowledge suffix
// above: resolved once per launch against the agent's execution root and
// appended only when the predicate (design-system/ exists) holds. Deliberately
// KG-independent — it must fire in repos with no knowledge graph configured.
function appendDesignSystemPrompt(prompt: string | undefined, line: string | null): string | undefined {
  if (!line) return prompt
  if (!prompt) return line
  return `${prompt}\n\n${line}`
}

function agentSessionSystem(kind: AgentKind | undefined): AgentSessionSystem {
  if (kind === 'sprintengine') return 'sprintengine'
  if (kind === 'watchtower') return 'watchtower'
  return 'manual'
}

export default function TerminalView({ workspaceId, agentId, sessionId: attachedSessionId, shouldKillOnUnmount }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const focusTerminalRef = useRef<() => void>(() => {
    containerRef.current?.focus()
  })
  const [isFileDragOver, setIsFileDragOver] = useState(false)
  // A failed file-link click or file drop, anchored to the pointer that raised
  // it so the error surfaces next to the cursor instead of a corner toast.
  const [clickError, setClickError] = useState<{ message: string; x: number; y: number } | null>(
    null,
  )
  const agent = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.agents[agentId]
  )
  const workspaceName = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.name
  )
  // Freeze-the-view resume: when this terminal's session is suspended (agent
  // process killed, scrollback painted), the first keystroke relaunches it under
  // the same id with --resume and flushes the keys typed during the boot. These
  // refs let the one-time `onData` handler read the live suspended state and the
  // captured resume thunk WITHOUT re-running the launch effect (which would
  // dispose the painted term).
  const effectiveSessionId = attachedSessionId ?? agent?.cliSessionId
  const suspendedSession = useSession(
    useCallback((s) => Boolean(effectiveSessionId) && s.sessionId === effectiveSessionId, [effectiveSessionId])
  )
  const suspendedRef = useRef(false)
  const resumeThunkRef = useRef<(() => Promise<TerminalSpawnResult>) | null>(null)
  const pendingResumeInputRef = useRef<string[]>([])
  const resumingRef = useRef(false)
  // Set by the launch effect (which owns the xterm instance) so this
  // store-driven sync can freeze/unfreeze the cursor: a blinking cursor is a
  // liveness signal, and a suspended snapshot is not live.
  const applyCursorFrozenRef = useRef<((frozen: boolean) => void) | null>(null)
  useEffect(() => {
    suspendedRef.current = Boolean(suspendedSession?.suspended)
    applyCursorFrozenRef.current?.(suspendedRef.current)
  }, [suspendedSession?.suspended])
  const {
    folderPath: savedFolderPath,
    folderReadyPath,
    folderMissing,
    checkingFolder,
    message: folderStatusMessage,
  } = useWorkspaceFolderStatus(workspaceId)
  const sprintEngineContext = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.sprintEngineContext ?? null
  )
  const sprintEngineRuntimeRole = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.sprintEngineState?.sprintEngineAgents[agentId]?.role ?? null
  )
  const sprintEngineRuntimeCurrentTaskId = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.sprintEngineState?.sprintEngineAgents[agentId]?.currentTaskId ?? null
  )
  const sprintEngineRosterRole = useWorkspaceStore((s) => {
    const sprintEngineState = s.workspaces.find((w) => w.id === workspaceId)?.sprintEngineState
    if (!sprintEngineState) return null
    return buildSprintEngineAgentRosterForState(sprintEngineState).find((candidate) => candidate.id === agentId)?.role ?? null
  })
  const workspaceFolderPath = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.folderPath
  )
  const workspaceMemoryRelativeRoot = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.memory.relativeRoot
  )
  const projectKnowledgeRoots = useWorkspaceStore((s) => s.appSettings.projectKnowledgeRoots)
  const memoryConfig = useMemo(
    () => resolveProjectKnowledgeConfig(
      workspaceFolderPath,
      projectKnowledgeRoots,
      workspaceMemoryRelativeRoot
    ),
    [workspaceFolderPath, projectKnowledgeRoots, workspaceMemoryRelativeRoot]
  )
  const cliPermissionPreset = useWorkspaceStore((s) => {
    const workspace = s.workspaces.find((w) => w.id === workspaceId)
    return resolveAgentCliPermissionPreset(workspace, agentId)
  })
  const storedExecutionWorktreePath = useWorkspaceStore((s) => {
    const workspace = s.workspaces.find((w) => w.id === workspaceId)
    const worktreeId = workspace?.agents[agentId]?.execution.worktreeId
    return worktreeId ? workspace?.worktreeState.entries[worktreeId]?.path : undefined
  })
  // Derived string, not the workspace object: sprintEngineState re-projects
  // ~every 4s and churns object identity, but the worktree gitRoot string is
  // stable, so the launch effect below re-runs at most once (null -> path).
  const workspaceWorktreeGitRoot = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    return ws ? resolveWorkspaceWorktree(ws)?.gitRoot ?? null : null
  })
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const mcpSettings = useWorkspaceStore((s) => s.appSettings.mcp ?? EMPTY_MCP_SETTINGS)
  const cli = agent?.cli
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  const openFile = useWorkspaceStore((s) => s.openFile)
  const startupPrompt = useWorkspaceStore((s) => {
    const workspace = s.workspaces.find((w) => w.id === workspaceId)
    const currentAgent = workspace?.agents[agentId]
    if (currentAgent?.cliStartupPrompt) return currentAgent.cliStartupPrompt

    if (workspace?.mode !== 'sprintengine' || !workspace.sprintEngineState) return null

    const rosterAgent = buildSprintEngineAgentRosterForState(workspace.sprintEngineState).find(
      (candidate) => candidate.id === agentId
    )

    if (!rosterAgent) return null

    const basePrompt = buildSprintEngineStartupPrompt(
      rosterAgent.role,
      agentId,
      workspace.sprintEngineState.goal,
      {
        executionCwd: resolveAgentExecutionRoot(currentAgent?.execution, storedExecutionWorktreePath, folderReadyPath, null).cwd,
        workspaceRoot: folderReadyPath ?? undefined,
        sprintEngineStatePath: workspace.sprintEngineContext?.statePath,
        rosterArgs: buildSprintEngineRosterCommandArgs(workspace.sprintEngineState),
        configuredRoles: workspace.sprintEngineState.configuredRoles,
        // Architect-roster inputs: rosterSource/allowedRuntimes ride the
        // projection; scores come from the global catalog and the guidance from
        // renderer-owned auto state (never engine-persisted).
        rosterSource: workspace.sprintEngineState.rosterSource,
        allowedRuntimes: workspace.sprintEngineState.allowedRuntimes,
        modelCatalog: s.appSettings.sprintEngineModelCatalog,
        architectGuidance: workspace.sprintEngineAutoState?.architectGuidance,
        commandMode: getSprintEngineStartupCommandMode(rosterAgent.role, agentId, workspace.sprintEngineState),
        autonomousPlanningOverride:
          rosterAgent.role === 'architect'
          && deriveSprintEngineAutomationDesiredMode(workspace.sprintEngineAutoState) === 'run_agents_and_approve_artifacts',
      }
    )
    const customName = currentAgent?.name && currentAgent.name !== rosterAgent.label
      ? currentAgent.name
      : ''
    return customName ? prependAgentIdentifier(basePrompt, customName, getSprintEngineRoleLabel(rosterAgent.role)) : basePrompt
  })
  const startupPromptRef = useRef<string | null>(startupPrompt)

  useEffect(() => {
    startupPromptRef.current = startupPrompt
  }, [startupPrompt])

  const launchContextRef = useRef({
    agent,
    cli,
    cliPermissionPreset,
    cliRuntimes,
    mcpSettings,
    memoryConfig,
    openFile,
    savedFolderPath,
    sprintEngineContext,
    sprintEngineRosterRole,
    sprintEngineRuntimeCurrentTaskId,
    sprintEngineRuntimeRole,
    storedExecutionWorktreePath,
    updateAgent,
    workspaceName,
  })

  useEffect(() => {
    launchContextRef.current = {
      agent,
      cli,
      cliPermissionPreset,
      cliRuntimes,
      mcpSettings,
      memoryConfig,
      openFile,
      savedFolderPath,
      sprintEngineContext,
      sprintEngineRosterRole,
      sprintEngineRuntimeCurrentTaskId,
      sprintEngineRuntimeRole,
      storedExecutionWorktreePath,
      updateAgent,
      workspaceName,
    }
  }, [
    agent,
    cli,
    cliPermissionPreset,
    cliRuntimes,
    mcpSettings,
    memoryConfig,
    openFile,
    savedFolderPath,
    sprintEngineContext,
    sprintEngineRosterRole,
    sprintEngineRuntimeCurrentTaskId,
    sprintEngineRuntimeRole,
    storedExecutionWorktreePath,
    updateAgent,
    workspaceName,
  ])

  useEffect(() => {
    const currentContext = () => launchContextRef.current
    const initialContext = currentContext()
    const container = containerRef.current
    if (!container) return
    if (initialContext.savedFolderPath && !folderReadyPath) return
    if (!initialContext.agent) return
    if (!initialContext.cli) {
      publishDiagnosticSync({
        level: 'error',
        source: 'terminal',
        title: `${initialContext.agent?.name ?? agentId} was not started`,
        message: 'Agent terminal is missing its CLI selection.',
        details: [
          `Workspace: ${initialContext.workspaceName}`,
          `Workspace ID: ${workspaceId}`,
          `Agent ID: ${agentId}`,
        ].join('\n'),
        workspaceId,
        workspaceName: initialContext.workspaceName,
        agentId,
      })
      return
    }

    if (!initialContext.agent?.cliSessionId && !attachedSessionId) {
      // [switch-regression] If this fires on a workspace switch, the agent's
      // cliSessionId was cleared while the PTY was still alive — relaunching with
      // a fresh id makes the main runtime dispose the old (live) session.
      logPerfEvent('TerminalView', 'terminal-spawn-fresh-after-switch-risk', {
        workspaceId,
        agentId,
        cli: initialContext.cli,
        reason: 'missing-cli-session-id',
      })
      initialContext.updateAgent(workspaceId, agentId, {
        cliSessionId: crypto.randomUUID(),
        cliHasLaunched: false,
      })
      return
    }

    const sessionId = attachedSessionId ?? initialContext.agent?.cliSessionId
    if (!sessionId) return
    const isSprintEngineAgent = initialContext.agent?.kind === 'sprintengine'
    // Sprint agents are normally spawned fresh (auto-run re-dispatches roles),
    // but an explicit board re-open of a completed run's recorded session sets
    // `cliResumeRequested` so we resume that conversation instead.
    const sprintResumeRequested = isSprintEngineAgent && (initialContext.agent?.cliResumeRequested ?? false)
    const shouldResume = attachedSessionId
      ? true
      : isSprintEngineAgent
        ? sprintResumeRequested
        : initialContext.agent?.cliHasLaunched ?? false
    const shouldResumeCodexConversation =
      initialContext.cli === 'codex'
      && Boolean(initialContext.agent?.cliResumeAvailable)
      && (!isSprintEngineAgent || sprintResumeRequested)
    const term = new Terminal({
      theme: getTerminalTheme(),
      fontFamily: MONO_FONT_STACK,
      fontSize: 13,
      cursorBlink: true,
      scrollback: TERMINAL_RECENT_SCROLLBACK_LINES,
    })
    const unbindTerminalTheme = bindTerminalTheme(term)
    const fitAddon = new FitAddon()
    const terminalDiagnostics = createTerminalDiagnostics({
      scope: 'TerminalView',
      sessionId,
      workspaceId,
      agentId,
      kind: 'agent',
    })

    const fitTerminal = () => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      fitAddon.fit()
      if (term.cols > 0 && term.rows > 0) {
        void window.api.terminalResize(sessionId, term.cols, term.rows)
      }
    }

    const focusTerminal = () => {
      terminalDiagnostics.recordFocus()
      term.focus()
    }
    focusTerminalRef.current = focusTerminal

    // Suspended = frozen: stop the cursor blinking so the snapshot doesn't
    // impersonate a live terminal. Applied immediately (the session may already
    // be suspended when this term mounts) and re-applied by the suspend sync
    // effect whenever the store flag changes.
    const setCursorFrozen = (frozen: boolean) => {
      term.options.cursorBlink = !frozen
    }
    applyCursorFrozenRef.current = setCursorFrozen
    setCursorFrozen(suspendedRef.current)

    term.loadAddon(fitAddon)
    // Register for scrollback-footprint diagnostics; unregistered on dispose.
    registerTerminalInstance(sessionId, term)
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown') {
        terminalDiagnostics.recordKeydown(event)
      }
      if (event.type === 'keydown' && event.key === 'Enter' && event.shiftKey) {
        event.preventDefault()
        window.api.terminalWriteFast(sessionId, '\u001b[13;2u')
        terminalDiagnostics.recordInputDispatch('\u001b[13;2u')
        return false
      }
      return true
    })
    term.open(container)
    fitTerminal()
    focusTerminal()

    const linkExecutionRoot = resolveAgentExecutionRoot(
      currentContext().agent?.execution,
      currentContext().storedExecutionWorktreePath,
      folderReadyPath,
      null
    )
    const fileLinkDisposable = term.registerLinkProvider(createTerminalFileLinkProvider({
      terminal: term,
      workspaceRoot: folderReadyPath ?? currentContext().savedFolderPath,
      executionRoot: linkExecutionRoot.cwd,
      pathExists: (path) => window.api.pathExists(path),
      openFile: async ({ resolvedPath, name, line, column }) => {
        const content = isImageFile(resolvedPath) ? '' : await window.api.readfile(resolvedPath)
        openFileSurface({ workspaceId, path: resolvedPath, name, content })
        const dispatchFocus = () => {
          window.dispatchEvent(new CustomEvent('multicode:focus-editor', {
            detail: {
              workspaceId,
              filePath: resolvedPath,
              line,
              column,
            },
          }))
        }
        window.setTimeout(dispatchFocus, 0)
        window.setTimeout(dispatchFocus, 80)
      },
      onOpenError: (message, anchor) => setClickError({ message, x: anchor.x, y: anchor.y }),
    }))

    const webLinksAddon = new WebLinksAddon((event, uri) => {
      const anchor = { x: event.clientX, y: event.clientY }
      void (async () => {
        const result = await window.api.openExternal(uri)
        if (!result.ok) setClickError({ message: result.message, x: anchor.x, y: anchor.y })
      })()
    })
    term.loadAddon(webLinksAddon)

    let disposed = false
    void waitForMonoFontReady().then(() => {
      if (disposed) return
      fitTerminal()
      term.refresh(0, Math.max(0, term.rows - 1))
    })
    let reportedTerminalFailure = false
    let terminalLaunchDetails = [
      `Session: ${sessionId}`,
      `CLI: ${initialContext.cli}${initialContext.agent?.cliModel ? ` · ${initialContext.agent.cliModel}` : ''}`,
      `Workspace path: ${folderReadyPath ?? initialContext.savedFolderPath ?? 'default app path'}`,
    ].join('\n')
    const outputQueue = createXtermOutputQueue(term, {
      recordWrite: terminalDiagnostics.recordOutputWrite,
    })
    const replayGate = createXtermReplayGate(term, outputQueue, {
      recordWrite: terminalDiagnostics.recordOutputWrite,
      onReplayProfile: (profile) => {
        logPerfEvent('TerminalView', 'terminal-replay-profile', {
          sessionId,
          workspaceId,
          agentId,
          kind: 'agent',
          ...profile,
        })
        recordReplayProfile({
          ...profile,
          recordedAt: Date.now(),
          sessionId,
          workspaceId,
          agentId,
          kind: 'agent',
        })
      },
    })

    const disposeData = window.api.onTerminalData(sessionId, (data) => {
      replayGate.handleLiveData(data)
    })
    const disposeReplay = window.api.onTerminalReplay(sessionId, (data) => {
      replayGate.handleReplay(data)
    })

    const disposeExit = window.api.onTerminalExit(sessionId, (code) => {
      const latestContext = currentContext()
      // If the process died mid-resume, reveal any withheld boot output first so
      // a genuine startup error surfaces ahead of the exit banner.
      replayGate.flushResumeSuppression()
      term.write(`\r\n\x1b[31m[Terminal exited with code ${code}]\x1b[0m\r\n`)
      const currentSessionId = useWorkspaceStore
        .getState()
        .workspaces.find((w) => w.id === workspaceId)
        ?.agents[agentId]
        ?.cliSessionId
      if (code !== 0 && !reportedTerminalFailure) {
        reportedTerminalFailure = true
        publishDiagnosticSync({
          level: 'error',
          source: 'terminal',
          title: `${latestContext.agent?.name ?? agentId} exited`,
          message: `Terminal exited with code ${code}.`,
          details: terminalLaunchDetails,
          workspaceId,
          workspaceName: latestContext.workspaceName,
          agentId,
          sessionId,
        })
      }
      if (currentSessionId !== sessionId) return
      latestContext.updateAgent(workspaceId, agentId, {
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
        cliLastExitCode: code,
        cliLastExitedAt: Date.now(),
      })
      void workspaceSyncClient.dispatchUpdateTerminalLaunchState(workspaceId, agentId, {
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
      })
    })

    const disposeError = window.api.onTerminalError(sessionId, (message) => {
      const latestContext = currentContext()
      term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`)
      reportedTerminalFailure = true
      publishDiagnosticSync({
        level: 'error',
        source: 'terminal',
        title: `${latestContext.agent?.name ?? agentId} failed to start`,
        message,
        details: terminalLaunchDetails,
        workspaceId,
        workspaceName: latestContext.workspaceName,
        agentId,
        sessionId,
      })
    })

    // Freeze-the-view: relaunch a suspended agent on the first keystroke, under
    // the same session id with --resume, then flush the keys typed during the
    // boot. Reuses the launch payload captured in `resumeThunkRef`; the existing
    // replay/data handlers on this same term pick up the resumed pty's output, so
    // the painted view is never torn down.
    const resumeFromSuspend = async () => {
      if (resumingRef.current) return
      const resume = resumeThunkRef.current
      if (!resume) return
      resumingRef.current = true
      // Tell the paused footer (AgentPanel) a resume is in flight: the relaunch
      // takes seconds and boot output is suppressed below, so without this the
      // click/keystroke reads as dead. Success needs no counterpart event — the
      // session snapshot flips `suspended` off and the footer leaves. Failure
      // rolls the footer back to "Paused".
      window.dispatchEvent(
        new CustomEvent('multicode:terminal-resume-state', {
          detail: { sessionId, resuming: true },
        }),
      )
      // Withhold the relaunched CLI's transitional boot output (focus-report
      // echo, trust/permissions warning, shell fragments) until it repaints its
      // alt-screen TUI, so the resume cuts cleanly from snapshot to live view.
      replayGate.armResumeSuppression()
      const result = await resume().catch((): TerminalSpawnResult => ({
        ok: false,
        sessionId,
        message: 'Failed to resume terminal.',
        exitCode: 1,
      }))
      if (result.ok) {
        suspendedRef.current = false
        // Unfreeze eagerly — the store's suspended flag clears a broadcast
        // later, and the cursor should read live the moment the TUI repaints.
        setCursorFrozen(false)
        const buffered = pendingResumeInputRef.current.join('')
        pendingResumeInputRef.current = []
        if (buffered) window.api.terminalWriteFast(sessionId, buffered)
      } else {
        window.dispatchEvent(
          new CustomEvent('multicode:terminal-resume-state', {
            detail: { sessionId, resuming: false },
          }),
        )
      }
      resumingRef.current = false
    }

    const onDataDisposable = term.onData((data) => {
      // Focus-report escapes (DECSET 1004: `ESC[I`/`ESC[O`) are not user intent.
      // During the suspend/resume window the PTY can echo them back as a visible
      // `^[[I`; worse, a focus event while suspended would otherwise be buffered
      // as "input" and kick a resume. Drop them in that window — a live PTY still
      // receives them so the CLI's focus tracking keeps working.
      if (
        (data === '\x1b[I' || data === '\x1b[O') &&
        (suspendedRef.current || resumingRef.current)
      ) {
        return
      }
      terminalDiagnostics.recordInput(data)
      // Suspended: buffer the keystroke and kick a resume instead of writing to a
      // dead pty (main drops writes to a suspended session anyway).
      if (suspendedRef.current) {
        pendingResumeInputRef.current.push(data)
        void resumeFromSuspend()
        return
      }
      window.api.terminalWriteFast(sessionId, data)
      terminalDiagnostics.recordInputDispatch(data)
    })

    // Resume on a deliberate click of the frozen pane — voice-dictation users
    // (and anyone reading the painted view) never type, so waiting for a keystroke
    // would strand them. Bound to `click` (not `mousedown`/`focus`): a click is an
    // intentional tap, whereas `focus` can fire when the pane mounts/auto-focuses,
    // which must NOT auto-resume a just-revealed workspace. No-op unless suspended;
    // `resumeFromSuspend` is idempotent via `resumingRef`.
    const onPaneClick = () => {
      if (suspendedRef.current) void resumeFromSuspend()
    }
    container.addEventListener('click', onPaneClick)

    // The paused-state footer (AgentPanel) lives in a different component and has
    // no access to the relaunch payload, so it asks this terminal to resume via a
    // window event keyed by session id — same path as typing.
    const onResumeRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail
      if (detail?.sessionId !== sessionId) return
      // The footer lives outside `container`, so its click doesn't hit the
      // focusTerminal listeners the way a pane click or keystroke does. Focus the
      // terminal here (synchronously, within the click gesture) so the user can
      // type immediately after resuming instead of having to click in again.
      focusTerminal()
      void resumeFromSuspend()
    }
    window.addEventListener('multicode:resume-terminal', onResumeRequest)

    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      void window.api.terminalResize(sessionId, cols, rows)
    })

    const fitScheduler = createTerminalFitScheduler(fitTerminal, container)
    const resizeObserver = new ResizeObserver(() => {
      fitScheduler.requestFit()
    })
    resizeObserver.observe(container)
    container.addEventListener('mousedown', focusTerminal)
    container.addEventListener('mouseup', focusTerminal)
    container.addEventListener('click', focusTerminal)
    container.addEventListener('focus', focusTerminal)
    const disposeClipboardHandlers = bindTerminalClipboardHandlers({
      container,
      term,
      sessionId,
      focusTerminal,
      recordKeydown: terminalDiagnostics.recordContainerKeydown,
    })

    const ensureSpecialistStartupPrompt = async (promptAlreadySentForActiveSession: boolean) => {
      const latestContext = currentContext()
      if (startupPromptRef.current || promptAlreadySentForActiveSession) return
      if (!latestContext.agent) return
      if (
        (latestContext.agent.kind !== 'specialist' && latestContext.agent.kind !== 'watchtower')
        || !latestContext.agent.specialistId
      ) return

      const specialist = getSpecialistAction(latestContext.agent.specialistId)
      const prompt = buildSpecialistSoulStartupPrompt(specialist)
      if (disposed) return

      const identifiedPrompt = prependAgentIdentifier(prompt, latestContext.agent.name, specialist.shortLabel)
      startupPromptRef.current = identifiedPrompt
      latestContext.updateAgent(workspaceId, agentId, { cliStartupPrompt: identifiedPrompt })
    }

    const launchTerminal = async () => {
      const latestContext = currentContext()
      const latestAgent = latestContext.agent
      const latestCli = latestContext.cli
      if (!latestAgent || !latestCli) return
      const terminalStatus = await window.api.terminalStatus(sessionId).catch(() => ({ processAlive: false, suspended: false }))
      if (disposed) return
      const postStatusContext = currentContext()
      const postStatusAgent = postStatusContext.agent
      const postStatusCli = postStatusContext.cli
      if (!postStatusAgent || !postStatusCli) return
      if (postStatusContext.savedFolderPath && !folderReadyPath) return

      const resumeExistingPty = shouldResume && terminalStatus.processAlive
      // Prefer the resume capability stamped + persisted on the agent (survives a
      // cold restart), like the codex branch reads agent.cliResumeAvailable above.
      // The catalog is only a fallback for a pre-upgrade agent whose flag predates
      // this feature — reading it directly would be a startup race (the plugin
      // catalog loads async, so an early launchTerminal could see it empty and
      // silently spawn a claude-code/zai agent fresh, losing the conversation).
      const postStatusResumeCaps = resumeCapabilitiesForCli(postStatusCli, useWorkspaceStore.getState().pluginCatalogEntries)
      const usesStableSessionId = postStatusAgent.cliUsesStableSessionId
        ?? agentCliUsesStableSessionIdForResume(postStatusResumeCaps)
      const shouldResumeClaudeConversation = usesStableSessionId && shouldResume
      const shouldResumeCli = resumeExistingPty || shouldResumeClaudeConversation || shouldResumeCodexConversation
      // Reopening a suspended agent must NOT silently respawn it: the reaper
      // suspended it to reclaim memory, the painted scrollback is still on the
      // record, and the user opened the workspace just to read it. Replay the
      // history below and leave it suspended — the quiet paused footer (AgentPanel,
      // keyed off the same `suspended` flag), a click on the pane, and
      // type-to-resume are the controls. A live pty (background run) reports suspended=false and
      // reattaches normally.
      const pauseInsteadOfLaunch = !attachedSessionId && terminalStatus.suspended
      logPerfEvent('TerminalView', shouldResumeCli ? 'terminal-reattach-existing-session' : 'terminal-spawn-fresh', {
        sessionId,
        workspaceId,
        agentId,
        kind: 'agent',
        processAlive: terminalStatus.processAlive,
        resumeRequested: shouldResume,
        attachedSessionId,
        cliHasLaunched: postStatusAgent?.cliHasLaunched,
        willSpawnFresh: !shouldResumeCli,
      })
      if (!shouldResumeCli && shouldResume) {
        logPerfEvent('TerminalView', 'terminal-spawn-fresh-after-switch-risk', {
          sessionId,
          workspaceId,
          agentId,
          kind: 'agent',
          processAlive: terminalStatus.processAlive,
          resumeRequested: shouldResume,
          attachedSessionId,
          cliHasLaunched: postStatusAgent?.cliHasLaunched,
          willSpawnFresh: true,
        })
      }
      const promptAlreadySentForActiveSession = Boolean(shouldResumeCli && postStatusAgent.cliOnboardingPromptSent)
      await ensureSpecialistStartupPrompt(promptAlreadySentForActiveSession)
      if (disposed) return

      const launchContext = currentContext()
      const launchAgent = launchContext.agent
      const launchCli = launchContext.cli
      if (!launchAgent || !launchCli) return
      const sprintEngineStatePath = folderReadyPath ? launchContext.sprintEngineContext?.statePath : undefined
      // Redirect a non-worktree agent's spawn into the workspace's worktree.
      // Resolve the worktree cwd once here (one `pathExists`); a persisted
      // mode:'worktree' agent skips this — resolveAgentExecutionRoot ignores the
      // value on its worktree branch and resolveWorktreeSpawnFallback below
      // already guards that agent's own cwd, so resolving here would double-call
      // pathExists.
      const workspaceWorktreeCwd = launchAgent.execution?.mode === 'worktree'
        ? { cwd: null, missing: false }
        : await resolveWorkspaceTerminalCwd(
            workspaceWorktreeGitRoot,
            folderReadyPath,
            window.api.pathExists,
          )
      if (disposed) return
      let executionRoot = resolveAgentExecutionRoot(
        launchAgent.execution,
        launchContext.storedExecutionWorktreePath,
        folderReadyPath,
        workspaceWorktreeCwd.cwd
      )
      if (workspaceWorktreeCwd.missing) {
        // The worktree-backed workspace's worktree is gone (merge cleanup, the
        // Worktree manager, or `git worktree prune`). executionRoot already fell
        // back to folderReadyPath; note it so the user is not silently in the
        // parent instead of the worktree they expected. Same red bracketed banner
        // as Slice 2 (PlainTerminalPanel), showing the folder actually opened in.
        logPerfEvent('TerminalView', 'worktree-cwd-missing-fallback', {
          workspaceId,
          agentId,
          kind: 'agent',
          missingCwd: workspaceWorktreeGitRoot,
          fallbackCwd: executionRoot.cwd ?? null,
        })
        term.write(
          `\r\n\x1b[31m[worktree missing — opened in main checkout: ${executionRoot.cwd ?? folderReadyPath ?? 'the workspace folder'}]\x1b[0m\r\n`,
        )
      }
      // The run worktree can be removed out from under a persisted agent (sprint
      // merge cleanup, the Worktree manager, or `git worktree prune`). Spawning
      // into the vanished directory exits the terminal with code 1 on reopen.
      // Detect the missing worktree and fall back to the workspace folder for
      // THIS spawn. Deliberately a stateless, per-launch redirect: we do NOT
      // rewrite the persisted `agent.execution` here — that field is in this
      // effect's dependency array, so mutating it would re-run the launch effect
      // mid-spawn. The guard re-checks (one `pathExists`) on every launch and
      // self-corrects if the worktree reappears; completion teardown removes the
      // agent entirely, so a stale execution is short-lived either way.
      const worktreeFallback = await resolveWorktreeSpawnFallback(
        executionRoot.mode,
        executionRoot.cwd,
        folderReadyPath,
        window.api.pathExists,
      )
      if (disposed) return
      if (worktreeFallback.fellBack) {
        logPerfEvent('TerminalView', 'worktree-cwd-missing-fallback', {
          workspaceId,
          agentId,
          missingCwd: executionRoot.cwd,
          fallbackCwd: worktreeFallback.cwd ?? null,
        })
        executionRoot = {
          cwd: worktreeFallback.cwd,
          mode: 'current_workspace',
          worktreeId: undefined,
          worktreePath: undefined,
        }
      }
      terminalLaunchDetails = [
        `Session: ${sessionId}`,
        `CLI: ${launchCli}${launchAgent.cliModel ? ` · ${launchAgent.cliModel}` : ''}`,
        launchContext.cliPermissionPreset ? `CLI permissions: ${launchContext.cliPermissionPreset}` : null,
        `Workspace path: ${folderReadyPath ?? launchContext.savedFolderPath ?? 'default app path'}`,
        executionRoot.worktreePath ? `Worktree path: ${executionRoot.worktreePath}` : null,
        sprintEngineStatePath ? `Sprint state: ${sprintEngineStatePath}` : null,
      ].filter(Boolean).join('\n')
      const memoryContext = await resolveMemoryLaunchContext(
        launchContext.memoryConfig?.projectRoot ?? folderReadyPath ?? null,
        launchContext.memoryConfig?.relativeRoot ?? null
      )
      if (disposed) return
      const designSystemPromptLine = await resolveDesignSystemAttachedPromptLine(
        executionRoot.cwd ?? folderReadyPath ?? null,
        window.api.pathExists,
      )
      if (disposed) return
      const launchInitialPrompt = shouldResumeCli
        ? undefined
        : appendDesignSystemPrompt(
            appendMemoryPrompt(startupPromptRef.current ?? undefined, memoryContext),
            designSystemPromptLine,
          )
      const finalContext = currentContext()
      const finalAgent = finalContext.agent
      const finalCli = finalContext.cli
      if (!finalAgent || !finalCli) return
      const finalResumeCaps = resumeCapabilitiesForCli(finalCli, useWorkspaceStore.getState().pluginCatalogEntries)
      const sessionSystem = agentSessionSystem(finalAgent.kind)
      const sessionRole = sessionSystem === 'sprintengine'
        ? finalContext.sprintEngineRuntimeRole ?? finalContext.sprintEngineRosterRole
        : finalAgent.kind ?? 'manual'
      const sessionWorkId = sessionSystem === 'sprintengine'
        ? finalContext.sprintEngineRuntimeCurrentTaskId ?? agentId
        : agentId
      const agentSession = attachedSessionId
        ? undefined
        : sessionSystem === 'sprintengine' && !sessionRole
          ? undefined
        : {
            executionId: sessionId,
            system: sessionSystem,
            workspaceId,
            workspaceRoot: folderReadyPath ?? finalContext.savedFolderPath ?? '',
            workId: sessionWorkId,
            role: sessionRole,
            displayName: finalAgent.name ?? agentId,
          }

      // Capture how to relaunch THIS agent under the same session id with
      // --resume (freeze-the-view resume-on-keystroke). Mirrors the spawn payload
      // below but forces resume and sends no fresh prompt; reads the live term
      // size at call time.
      resumeThunkRef.current = () => window.api.terminalResume(
        sessionId,
        term.cols,
        term.rows,
        executionRoot.cwd,
        true,
        sprintEngineStatePath,
        finalCli,
        undefined,
        finalContext.cliRuntimes,
        false,
        ({
          kind: 'agent',
          workspaceId,
          agentId,
          agentName: finalAgent.name,
          // The agent's own CLI/harness session id, used as the resume token so
          // non-Claude CLIs (e.g. Codex) reattach the right conversation. Read
          // live at call time — the resume thunk outlives this closure, and the
          // harness id is learned from the hook AFTER launch, so the captured
          // `finalAgent` may not have it yet. For Claude this coincides with the
          // terminal id, so main's fallback keeps `--resume <id>` identical.
          cliSessionId: currentContext().agent?.harnessSessionId ?? finalAgent.harnessSessionId,
          executionMode: executionRoot.mode,
          worktreeId: executionRoot.worktreeId,
          worktreePath: executionRoot.worktreePath,
          cliPermissionPreset: finalContext.cliPermissionPreset,
          debugMode: finalAgent.debugMode,
          cliModel: finalAgent.cliModel,
          memoryRootPath: memoryContext.rootPath,
          memoryRelativeRoot: memoryContext.relativeRoot,
          // A connector chat (Railway, etc.) forwards its own Railway-only MCP
          // settings and skill id so the spawn syncs that server into the
          // worktree .mcp.json and installs the skill — never the global
          // appSettings.mcp. Ordinary agents fall through to the workspace's MCP.
          mcpSettings: finalAgent.connectorMcpSettings ?? finalContext.mcpSettings,
          connectorLaunch: finalAgent.connectorMcpSettings != null,
          connectorSkillId: finalAgent.connectorSkillId,
          spawnSkillId: finalAgent.spawnSkillId,
          visible: true,
          ...(agentSession ? { agentSession } : {}),
        } as TerminalSpawnMetadata & {
          executionMode: AgentExecutionMode
          worktreeId?: string
          worktreePath?: string
        })
      )

      if (pauseInsteadOfLaunch) {
        // Arm the freeze-the-view resume path (resumeThunkRef is set above) so
        // the paused footer / pane click / type-to-resume relaunches it, and
        // route the next keystroke through it. Reveal the session so main replays
        // the retained scrollback into this fresh xterm — the painted history is
        // readable while the agent process stays suspended.
        suspendedRef.current = true
        setCursorFrozen(true)
        await window.api.terminalSetVisible(sessionId, true).catch(() => {})
        logPerfEvent('TerminalView', 'terminal-paused-on-open', {
          sessionId,
          workspaceId,
          agentId,
          kind: 'agent',
          resumeRequested: shouldResume,
          attachedSessionId,
        })
        return
      }

      replayGate.beginReplayWait()
      const spawnResult = await window.api.terminalSpawn(
        sessionId,
        term.cols,
        term.rows,
        executionRoot.cwd,
        shouldResumeCli,
        sprintEngineStatePath,
        finalCli,
        launchInitialPrompt,
        finalContext.cliRuntimes,
        false,
        ({
          kind: 'agent',
          workspaceId,
          agentId,
          agentName: finalAgent.name,
          // The agent's own CLI/harness session id, used as the resume token so
          // non-Claude CLIs (e.g. Codex) reattach the right conversation. Read
          // live at call time — the resume thunk outlives this closure, and the
          // harness id is learned from the hook AFTER launch, so the captured
          // `finalAgent` may not have it yet. For Claude this coincides with the
          // terminal id, so main's fallback keeps `--resume <id>` identical.
          cliSessionId: currentContext().agent?.harnessSessionId ?? finalAgent.harnessSessionId,
          executionMode: executionRoot.mode,
          worktreeId: executionRoot.worktreeId,
          worktreePath: executionRoot.worktreePath,
          cliPermissionPreset: finalContext.cliPermissionPreset,
          debugMode: finalAgent.debugMode,
          cliModel: finalAgent.cliModel,
          memoryRootPath: memoryContext.rootPath,
          memoryRelativeRoot: memoryContext.relativeRoot,
          // A connector chat (Railway, etc.) forwards its own Railway-only MCP
          // settings and skill id so the spawn syncs that server into the
          // worktree .mcp.json and installs the skill — never the global
          // appSettings.mcp. Ordinary agents fall through to the workspace's MCP.
          mcpSettings: finalAgent.connectorMcpSettings ?? finalContext.mcpSettings,
          connectorLaunch: finalAgent.connectorMcpSettings != null,
          connectorSkillId: finalAgent.connectorSkillId,
          spawnSkillId: finalAgent.spawnSkillId,
          visible: true,
          ...(agentSession ? { agentSession } : {}),
        } as TerminalSpawnMetadata & {
          executionMode: AgentExecutionMode
          worktreeId?: string
          worktreePath?: string
        })
      ).catch((error): TerminalSpawnResult => ({
        ok: false,
        sessionId,
        message: error instanceof Error ? error.message : 'Failed to start terminal.',
        exitCode: 1,
      }))
      replayGate.finishReplayWait()
      if (disposed) return
      if (!spawnResult.ok) {
        const failureContext = currentContext()
        const currentSessionId = useWorkspaceStore
          .getState()
          .workspaces.find((w) => w.id === workspaceId)
          ?.agents[agentId]
          ?.cliSessionId
        if (attachedSessionId) return
        if (currentSessionId !== sessionId) return
        failureContext.updateAgent(workspaceId, agentId, {
          cliSessionId: undefined,
          cliStartRequested: false,
          cliHasLaunched: false,
          cliOnboardingPromptSent: false,
        })
        void workspaceSyncClient.dispatchUpdateTerminalLaunchState(workspaceId, agentId, {
          cliSessionId: null,
          cliStartRequested: false,
          cliHasLaunched: false,
          cliOnboardingPromptSent: false,
        })
        if (!reportedTerminalFailure) {
          reportedTerminalFailure = true
          publishDiagnosticSync({
            level: 'error',
            source: 'terminal',
            title: `${failureContext.agent?.name ?? agentId} was not started`,
            message: spawnResult.message,
            details: terminalLaunchDetails,
            workspaceId,
            workspaceName: failureContext.workspaceName,
            agentId,
            sessionId,
          })
        }
        return
      }

      if (!resumeExistingPty) {
        if (!attachedSessionId) {
          const successContext = currentContext()
          successContext.updateAgent(workspaceId, agentId, {
            cliHasLaunched: true,
            // What this session actually launched with (the spawn metadata's
            // cli/model above) — the roster's divergence label compares it to
            // the record's reconciled runtime after mid-run role edits.
            cliLaunchedRuntime: { cli: finalAgent.cli, model: finalAgent.cliModel ?? null },
            ...(agentCliSupportsConversationResume(finalResumeCaps)
              ? {
                  cliResumeAvailable: true,
                  cliUsesStableSessionId: agentCliUsesStableSessionIdForResume(finalResumeCaps),
                }
              : {}),
            ...(launchInitialPrompt
              ? {
                  cliOnboardingPromptSent: true,
                  cliStartupPrompt: undefined,
                }
              : {}),
            // One-shot: consumed by the paste below, cleared here so a
            // relaunch never re-pastes it.
            ...(finalAgent.cliPendingInput ? { cliPendingInput: undefined } : {}),
          })
          // Skill-at-spawn prefill: park the invocation at the CLI prompt,
          // bracketed and unsubmitted (the PTY buffers it until the CLI's
          // input line is ready). Never auto-sent — the user finishes it.
          if (finalAgent.cliPendingInput) {
            const pendingInput = finalAgent.cliPendingInput
            void window.api
              .terminalWrite(sessionId, `\x1b[200~${pendingInput}\x1b[201~`)
              .catch(() => {})
          }
        }
      }
      // assign_session stamps cliResumeAvailable authoritatively from the main
      // registry (reliably loaded, unlike the async renderer catalog), so we no
      // longer echo a catalog-derived cliResumeAvailable here — doing so raced
      // the stamp and could overwrite a resume-capable agent with false during
      // startup. Only the prompt flag remains as a launch-state follow-up.
      void workspaceSyncClient.dispatchAssignTerminalSession(workspaceId, agentId, sessionId, finalCli)
      const launchState: Parameters<typeof workspaceSyncClient.dispatchUpdateTerminalLaunchState>[2] = {}
      if (launchInitialPrompt) launchState.cliOnboardingPromptSent = true
      if (Object.keys(launchState).length > 0) {
        void workspaceSyncClient.dispatchUpdateTerminalLaunchState(workspaceId, agentId, launchState)
      }
    }

    void launchTerminal()
    const settleTimer = window.setTimeout(() => {
      fitTerminal()
      focusTerminal()
    }, 50)

    return () => {
      disposed = true
      if (shouldKillOnUnmount?.(sessionId)) {
        void window.api.terminalKill(sessionId).catch(() => {})
      } else {
        logPerfEvent('TerminalView', 'terminal-detached-from-renderer', {
          sessionId,
          workspaceId,
          agentId,
          kind: 'agent',
        })
        void window.api.terminalSetVisible(sessionId, false).catch(() => {})
      }
      window.clearTimeout(settleTimer)
      resizeObserver.disconnect()
      fitScheduler.dispose()
      container.removeEventListener('mousedown', focusTerminal)
      container.removeEventListener('mouseup', focusTerminal)
      container.removeEventListener('click', focusTerminal)
      container.removeEventListener('focus', focusTerminal)
      container.removeEventListener('click', onPaneClick)
      disposeClipboardHandlers()
      disposeData()
      disposeReplay()
      disposeExit()
      disposeError()
      window.removeEventListener('multicode:resume-terminal', onResumeRequest)
      onDataDisposable.dispose()
      onResizeDisposable.dispose()
      fileLinkDisposable.dispose()
      webLinksAddon.dispose()
      terminalDiagnostics.dispose()
      replayGate.dispose()
      outputQueue.dispose()
      unbindTerminalTheme()
      unregisterTerminalInstance(sessionId)
      term.dispose()
      applyCursorFrozenRef.current = null
      focusTerminalRef.current = () => {
        containerRef.current?.focus()
      }
    }
  }, [
    workspaceId,
    agentId,
    agent?.cliSessionId,
    attachedSessionId,
    agent?.cliRestartNonce,
    agent?.kind,
    agent?.execution.mode,
    agent?.execution.worktreeId,
    agent?.execution.cwd,
    folderReadyPath,
    workspaceWorktreeGitRoot,
    shouldKillOnUnmount,
  ])

  const folderBlocked = Boolean(savedFolderPath && !folderReadyPath)
  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFileDropData(event.dataTransfer) && !hasCommitDropData(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setIsFileDragOver(true)
  }

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
    setIsFileDragOver(false)
  }

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    const isCommitDrop = hasCommitDropData(event.dataTransfer)
    if (!hasFileDropData(event.dataTransfer) && !isCommitDrop) return
    event.preventDefault()
    setIsFileDragOver(false)
    focusTerminalRef.current()

    const dropAnchor = { x: event.clientX, y: event.clientY }
    const showDropError = (message: string) =>
      setClickError({ message, x: dropAnchor.x, y: dropAnchor.y })

    const sessionId = attachedSessionId ?? agent?.cliSessionId
    if (!sessionId) {
      showDropError(
        isCommitDrop
          ? 'Start this agent terminal before dropping a commit into it.'
          : 'Start this agent terminal before dropping files into it.'
      )
      return
    }

    if (isCommitDrop) {
      const commitResult = await pasteDroppedCommitIntoTerminal({
        dataTransfer: event.dataTransfer,
        sessionId,
      }).catch((error): { ok: false; message: string } => ({
        ok: false,
        message: error instanceof Error ? error.message : 'Could not drop the commit into the terminal.',
      }))
      if (!commitResult.ok) showDropError(commitResult.message)
      return
    }

    const result = await pasteDroppedFilesIntoTerminal({
      dataTransfer: event.dataTransfer,
      sessionId,
      workspaceId,
    }).catch((error): { ok: false; message: string } => ({
      ok: false,
      message: error instanceof Error ? error.message : 'Could not drop the file into the terminal.',
    }))

    if (!result.ok) {
      showDropError(result.message)
      return
    }

    // A backlog/ item handed to this agent: record the link on both sides so the
    // item shows its working agent and this terminal shows its Backlog glyph.
    // Best-effort and non-blocking — the paste already landed.
    if (result.backlog) {
      void recordBacklogAgentHandoff({
        workspaceId,
        workspaceRoot: result.backlog.workspaceRoot,
        agentId: result.backlog.agentId,
        relativePath: result.backlog.relativePath,
      })
    }
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={(event) => void handleDrop(event)}
      className="terminal-focus-ring absolute inset-0 overflow-hidden bg-[color:var(--terminal-bg)] p-2 pb-4 cursor-text"
    >
      {/* No replay skeleton on terminals: an xterm renders its own content
          progressively (and a revealed cold terminal resyncs in place), so a
          skeleton there just reads as a flash. Keep it only for the genuine
          pre-launch folder-verification wait. */}
      {folderBlocked && checkingFolder ? <TerminalReplaySkeleton /> : null}
      {isFileDragOver ? (
        <div className="pointer-events-none absolute inset-2 z-10 rounded-md border border-[color:var(--accent-primary)] bg-[color:var(--accent-primary-soft)]" />
      ) : null}
      {clickError ? (
        <CursorErrorPopover
          key={`${clickError.x},${clickError.y},${clickError.message}`}
          message={clickError.message}
          anchor={{ x: clickError.x, y: clickError.y }}
          onDismiss={() => setClickError(null)}
        />
      ) : null}
      {folderBlocked && folderMissing ? (
        <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-[color:var(--text-muted)]">
          {folderStatusMessage ?? 'Saved workspace folder is missing. Relink it from the Files pane before starting this terminal.'}
        </div>
      ) : null}
    </div>
  )
}
