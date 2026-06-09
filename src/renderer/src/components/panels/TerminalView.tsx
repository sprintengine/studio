import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useWorkspaceFolderStatus } from '../../hooks/useWorkspaceFolderStatus'
import type { AgentExecution, AgentExecutionMode, AgentKind } from '../../types/workspace'
import type { AgentSessionSystem } from '../../../../shared/electron-api'
import { buildSpecialistSoulStartupPrompt, getSpecialistAction } from '../../specialists/specialistActions'
import { buildSprintEngineAgentRosterForState, buildSprintEngineRosterCommandArgs, getSprintEngineRoleLabel } from '../../utils/sprintengine'
import { buildSprintEngineStartupPrompt, getSprintEngineStartupCommandMode, prependAgentIdentifier } from '../../utils/agentPrompt'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { deferFitDuringSidebarAnimation } from '../../utils/sidebarTransition'
import { createTerminalDiagnostics } from '../../utils/terminalDiagnostics'
import { createTerminalFileLinkProvider } from '../../utils/terminalFileLinks'
import { createXtermOutputQueue, createXtermReplayGate } from '../../utils/xtermOutputQueue'
import { bindTerminalClipboardHandlers } from '../../utils/terminalClipboard'
import { bindTerminalTheme, getTerminalTheme } from '../../utils/terminalTheme'
import {
  hasCommitDropData,
  hasFileDropData,
  pasteDroppedCommitIntoTerminal,
  pasteDroppedFilesIntoTerminal,
} from '../../utils/terminalDrop'
import { MONO_FONT_STACK, waitForMonoFontReady } from '../../utils/fonts'
import { isImageFile } from '../../utils/files'
import { resolveProjectKnowledgeConfig } from '../../utils/projectKnowledge'
import { resolveAgentCliPermissionPreset } from '../../utils/agentCliPermissions'
import { agentCliSupportsConversationResume, agentCliUsesStableSessionIdForResume } from '../../utils/agentCliResume'
import { deriveSprintEngineAutomationDesiredMode } from '../../utils/sprintengineAutomationLifecycle'
import type { McpSettings } from '../../types/workspace'
import { CursorErrorPopover } from '../ui/CursorErrorPopover'
import { workspaceSyncClient } from '../../store/workspaceSyncClient'
import { TERMINAL_RECENT_SCROLLBACK_LINES } from '../../../../shared/terminal-history'
import { focusOrAddFileTab } from '../../utils/modelRegistry'

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
  workspaceReadyPath: string | null
): AgentExecutionRoot {
  if (execution?.mode !== 'worktree') {
    return {
      cwd: workspaceReadyPath ?? undefined,
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
  const sprintEngineRuntimeAgent = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.sprintEngineState?.sprintEngineAgents[agentId] ?? null
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
        executionCwd: resolveAgentExecutionRoot(currentAgent?.execution, storedExecutionWorktreePath, folderReadyPath).cwd,
        workspaceRoot: folderReadyPath ?? undefined,
        sprintEngineStatePath: workspace.sprintEngineContext?.statePath,
        rosterArgs: buildSprintEngineRosterCommandArgs(workspace.sprintEngineState),
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

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (savedFolderPath && !folderReadyPath) return
    if (!agent) return
    if (!cli) {
      publishDiagnosticSync({
        level: 'error',
        source: 'terminal',
        title: `${agent?.name ?? agentId} was not started`,
        message: 'Agent terminal is missing its CLI selection.',
        details: [
          `Workspace: ${workspaceName}`,
          `Workspace ID: ${workspaceId}`,
          `Agent ID: ${agentId}`,
        ].join('\n'),
        workspaceId,
        workspaceName,
        agentId,
      })
      return
    }

    if (!agent?.cliSessionId && !attachedSessionId) {
      // [switch-regression] If this fires on a workspace switch, the agent's
      // cliSessionId was cleared while the PTY was still alive — relaunching with
      // a fresh id makes the main runtime dispose the old (live) session.
      logPerfEvent('TerminalView', 'terminal-spawn-fresh-after-switch-risk', {
        workspaceId,
        agentId,
        cli,
        reason: 'missing-cli-session-id',
      })
      console.warn('[switch-regression] regenerating cliSessionId', {
        workspaceId,
        agentId,
        agentName: agent?.name,
        cli,
      })
      updateAgent(workspaceId, agentId, {
        cliSessionId: crypto.randomUUID(),
        cliHasLaunched: false,
      })
      return
    }

    const sessionId = attachedSessionId ?? agent?.cliSessionId
    if (!sessionId) return
    const isSprintEngineAgent = agent?.kind === 'sprintengine'
    const shouldResume = attachedSessionId ? true : isSprintEngineAgent ? false : agent?.cliHasLaunched ?? false
    const shouldResumeCodexConversation = !isSprintEngineAgent && cli === 'codex' && Boolean(agent?.cliResumeAvailable)
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

    term.loadAddon(fitAddon)
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
      agent?.execution,
      storedExecutionWorktreePath,
      folderReadyPath
    )
    const fileLinkDisposable = term.registerLinkProvider(createTerminalFileLinkProvider({
      terminal: term,
      workspaceRoot: folderReadyPath ?? savedFolderPath,
      executionRoot: linkExecutionRoot.cwd,
      pathExists: (path) => window.api.pathExists(path),
      openFile: async ({ resolvedPath, name, line, column }) => {
        const content = isImageFile(resolvedPath) ? '' : await window.api.readfile(resolvedPath)
        openFile(workspaceId, resolvedPath, name, content)
        focusOrAddFileTab(workspaceId, resolvedPath, name)
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
      `CLI: ${cli}${agent?.cliModel ? ` · ${agent.cliModel}` : ''}`,
      `Workspace path: ${folderReadyPath ?? savedFolderPath ?? 'default app path'}`,
    ].join('\n')
    const outputQueue = createXtermOutputQueue(term, {
      recordWrite: terminalDiagnostics.recordOutputWrite,
    })
    const replayGate = createXtermReplayGate(term, outputQueue, {
      container,
      recordWrite: terminalDiagnostics.recordOutputWrite,
    })

    const disposeData = window.api.onTerminalData(sessionId, (data) => {
      replayGate.handleLiveData(data)
    })
    const disposeReplay = window.api.onTerminalReplay(sessionId, (data) => {
      replayGate.handleReplay(data)
    })

    const disposeExit = window.api.onTerminalExit(sessionId, (code) => {
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
          title: `${agent?.name ?? agentId} exited`,
          message: `Terminal exited with code ${code}.`,
          details: terminalLaunchDetails,
          workspaceId,
          workspaceName,
          agentId,
          sessionId,
        })
      }
      if (currentSessionId !== sessionId) return
      updateAgent(workspaceId, agentId, {
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
      term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`)
      reportedTerminalFailure = true
      publishDiagnosticSync({
        level: 'error',
        source: 'terminal',
        title: `${agent?.name ?? agentId} failed to start`,
        message,
        details: terminalLaunchDetails,
        workspaceId,
        workspaceName,
        agentId,
        sessionId,
      })
    })

    const onDataDisposable = term.onData((data) => {
      terminalDiagnostics.recordInput(data)
      window.api.terminalWriteFast(sessionId, data)
      terminalDiagnostics.recordInputDispatch(data)
    })

    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      void window.api.terminalResize(sessionId, cols, rows)
    })

    const fitScheduler = deferFitDuringSidebarAnimation(fitTerminal)
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
      if (startupPromptRef.current || promptAlreadySentForActiveSession) return
      if (!agent) return
      if ((agent.kind !== 'specialist' && agent.kind !== 'watchtower') || !agent.specialistId) return

      const specialist = getSpecialistAction(agent.specialistId)
      const prompt = buildSpecialistSoulStartupPrompt(specialist)
      if (disposed) return

      const identifiedPrompt = prependAgentIdentifier(prompt, agent.name, specialist.shortLabel)
      startupPromptRef.current = identifiedPrompt
      updateAgent(workspaceId, agentId, { cliStartupPrompt: identifiedPrompt })
    }

    const launchTerminal = async () => {
      const terminalStatus = await window.api.terminalStatus(sessionId).catch(() => ({ processAlive: false }))
      if (disposed) return
      if (savedFolderPath && !folderReadyPath) return

      const resumeExistingPty = shouldResume && terminalStatus.processAlive
      const shouldResumeClaudeConversation = agentCliUsesStableSessionIdForResume(cli) && shouldResume
      const shouldResumeCli = resumeExistingPty || shouldResumeClaudeConversation || shouldResumeCodexConversation
      logPerfEvent('TerminalView', shouldResumeCli ? 'terminal-reattach-existing-session' : 'terminal-spawn-fresh', {
        sessionId,
        workspaceId,
        agentId,
        kind: 'agent',
        processAlive: terminalStatus.processAlive,
        resumeRequested: shouldResume,
        attachedSessionId,
        cliHasLaunched: agent?.cliHasLaunched,
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
          cliHasLaunched: agent?.cliHasLaunched,
          willSpawnFresh: true,
        })
      }
      // [switch-regression] One line per launch. A fresh spawn on a workspace
      // switch shows shouldResumeCli=false: inspect cliHasLaunched / processAlive
      // to see which precondition was lost.
      console.warn('[switch-regression] launchTerminal', {
        workspaceId,
        agentId,
        agentName: agent?.name,
        cli,
        sessionId,
        attachedSessionId,
        cliHasLaunched: agent?.cliHasLaunched,
        cliResumeAvailable: agent?.cliResumeAvailable,
        shouldResume,
        processAlive: terminalStatus.processAlive,
        resumeExistingPty,
        shouldResumeCli,
        willSpawnFresh: !shouldResumeCli,
      })
      const promptAlreadySentForActiveSession = Boolean(shouldResumeCli && agent?.cliOnboardingPromptSent)
      await ensureSpecialistStartupPrompt(promptAlreadySentForActiveSession)
      if (disposed) return

      const sprintEngineStatePath = folderReadyPath ? sprintEngineContext?.statePath : undefined
      const executionRoot = resolveAgentExecutionRoot(
        agent?.execution,
        storedExecutionWorktreePath,
        folderReadyPath
      )
      terminalLaunchDetails = [
        `Session: ${sessionId}`,
        `CLI: ${cli}${agent?.cliModel ? ` · ${agent.cliModel}` : ''}`,
        cliPermissionPreset ? `CLI permissions: ${cliPermissionPreset}` : null,
        `Workspace path: ${folderReadyPath ?? savedFolderPath ?? 'default app path'}`,
        executionRoot.worktreePath ? `Worktree path: ${executionRoot.worktreePath}` : null,
        sprintEngineStatePath ? `Sprint Engine state: ${sprintEngineStatePath}` : null,
      ].filter(Boolean).join('\n')
      const memoryContext = await resolveMemoryLaunchContext(
        memoryConfig?.projectRoot ?? folderReadyPath ?? null,
        memoryConfig?.relativeRoot ?? null
      )
      if (disposed) return
      const launchInitialPrompt = shouldResumeCli
        ? undefined
        : appendMemoryPrompt(startupPromptRef.current ?? undefined, memoryContext)
      const sessionSystem = agentSessionSystem(agent?.kind)
      const sessionRole = sessionSystem === 'sprintengine'
        ? sprintEngineRuntimeAgent?.role ?? sprintEngineRosterRole
        : agent?.kind ?? 'manual'
      const sessionWorkId = sessionSystem === 'sprintengine'
        ? sprintEngineRuntimeAgent?.currentTaskId ?? agentId
        : agentId
      const agentSession = attachedSessionId
        ? undefined
        : sessionSystem === 'sprintengine' && !sessionRole
          ? undefined
        : {
            executionId: sessionId,
            system: sessionSystem,
            workspaceId,
            workspaceRoot: folderReadyPath ?? savedFolderPath ?? '',
            workId: sessionWorkId,
            role: sessionRole,
            displayName: agent?.name ?? agentId,
          }

      replayGate.beginReplayWait()
      const spawnResult = await window.api.terminalSpawn(
        sessionId,
        term.cols,
        term.rows,
        executionRoot.cwd,
        shouldResumeCli,
        sprintEngineStatePath,
        cli,
        launchInitialPrompt,
        cliRuntimes,
        false,
        ({
          kind: 'agent',
          workspaceId,
          agentId,
          executionMode: executionRoot.mode,
          worktreeId: executionRoot.worktreeId,
          worktreePath: executionRoot.worktreePath,
          cliPermissionPreset,
          cliModel: agent?.cliModel,
          memoryRootPath: memoryContext.rootPath,
          memoryRelativeRoot: memoryContext.relativeRoot,
          mcpSettings,
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
        const currentSessionId = useWorkspaceStore
          .getState()
          .workspaces.find((w) => w.id === workspaceId)
          ?.agents[agentId]
          ?.cliSessionId
        if (attachedSessionId) return
        if (currentSessionId !== sessionId) return
        updateAgent(workspaceId, agentId, {
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
            title: `${agent?.name ?? agentId} was not started`,
            message: spawnResult.message,
            details: terminalLaunchDetails,
            workspaceId,
            workspaceName,
            agentId,
            sessionId,
          })
        }
        return
      }

      if (!resumeExistingPty) {
        if (!attachedSessionId) {
          updateAgent(workspaceId, agentId, {
            cliHasLaunched: true,
            ...(agentCliSupportsConversationResume(cli) ? { cliResumeAvailable: true } : {}),
            ...(launchInitialPrompt
              ? {
                  cliOnboardingPromptSent: true,
                  cliStartupPrompt: undefined,
                }
              : {}),
          })
        }
      }
      void workspaceSyncClient.dispatchAssignTerminalSession(workspaceId, agentId, sessionId, cli)
      const launchState: Parameters<typeof workspaceSyncClient.dispatchUpdateTerminalLaunchState>[2] = {}
      if (!agentCliSupportsConversationResume(cli)) launchState.cliResumeAvailable = false
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
      disposeClipboardHandlers()
      disposeData()
      disposeReplay()
      disposeExit()
      disposeError()
      onDataDisposable.dispose()
      onResizeDisposable.dispose()
      fileLinkDisposable.dispose()
      webLinksAddon.dispose()
      terminalDiagnostics.dispose()
      replayGate.dispose()
      outputQueue.dispose()
      unbindTerminalTheme()
      term.dispose()
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
    agent?.name,
    agent?.specialistId,
    agent?.execution.mode,
    agent?.execution.worktreeId,
    agent?.execution.cwd,
    cli,
    cliPermissionPreset,
    cliRuntimes,
    folderReadyPath,
    workspaceName,
    savedFolderPath,
    sprintEngineContext?.statePath,
    sprintEngineRuntimeAgent?.currentTaskId,
    sprintEngineRuntimeAgent?.role,
    sprintEngineRosterRole,
    memoryConfig?.projectRoot,
    memoryConfig?.relativeRoot,
    mcpSettings,
    storedExecutionWorktreePath,
    updateAgent,
    openFile,
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

    if (!result.ok) showDropError(result.message)
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={(event) => void handleDrop(event)}
      className="terminal-focus-ring absolute inset-0 overflow-hidden p-2 pb-4 cursor-text"
    >
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
      {folderBlocked ? (
        <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-[color:var(--text-muted)]">
          {checkingFolder
            ? 'Checking workspace folder before starting this terminal...'
            : folderMissing
              ? folderStatusMessage ?? 'Saved workspace folder is missing. Relink it from the Files pane before starting this terminal.'
              : null}
        </div>
      ) : null}
    </div>
  )
}
