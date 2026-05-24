import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useWorkspaceFolderStatus } from '../../hooks/useWorkspaceFolderStatus'
import type { AgentExecution, AgentExecutionMode, AgentKind } from '../../types/workspace'
import type { AgentSessionSystem } from '../../../../shared/electron-api'
import { buildSpecialistSoulStartupPrompt, getSpecialistAction } from '../../specialists/specialistActions'
import { buildSprintEngineAgentRosterForState, buildSprintEngineRosterCommandArgs, getSprintEngineRoleLabel } from '../../utils/sprintengine'
import { buildSprintEngineStartupPrompt, getSprintEngineStartupCommandMode, prependAgentIdentifier } from '../../utils/agentPrompt'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { createTerminalDiagnostics } from '../../utils/terminalDiagnostics'
import { createXtermOutputQueue } from '../../utils/xtermOutputQueue'
import { bindTerminalClipboardHandlers } from '../../utils/terminalClipboard'
import { bindTerminalTheme, getTerminalTheme } from '../../utils/terminalTheme'
import { hasFileDropData, pasteDroppedFilesIntoTerminal } from '../../utils/terminalDrop'
import { resolveProjectKnowledgeConfig } from '../../utils/projectKnowledge'
import { resolveAgentCliPermissionPreset } from '../../utils/agentCliPermissions'
import { agentCliSupportsConversationResume } from '../../utils/agentCliResume'
import type { McpSettings } from '../../types/workspace'
import { Toast } from '../ui/Toast'

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
  const [dropError, setDropError] = useState<string | null>(null)
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
        autonomousPlanningOverride: rosterAgent.role === 'architect' && Boolean(workspace.sprintEngineAutoState?.autoApproveArtifacts),
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
      fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
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

    let disposed = false
    let reportedTerminalFailure = false
    let terminalLaunchDetails = [
      `Session: ${sessionId}`,
      `CLI: ${cli}`,
      `Workspace path: ${folderReadyPath ?? savedFolderPath ?? 'default app path'}`,
    ].join('\n')
    const outputQueue = createXtermOutputQueue(term, {
      recordWrite: terminalDiagnostics.recordOutputWrite,
    })

    const disposeData = window.api.onTerminalData(sessionId, (data) => {
      outputQueue.enqueue(data)
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

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(fitTerminal)
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
      const shouldResumeClaudeConversation = cli === 'claude' && shouldResume
      const shouldResumeCli = resumeExistingPty || shouldResumeClaudeConversation || shouldResumeCodexConversation
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
        `CLI: ${cli}`,
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
        ? sprintEngineRuntimeAgent?.role ?? 'sprintengine'
        : agent?.kind ?? 'manual'
      const sessionWorkId = sessionSystem === 'sprintengine'
        ? sprintEngineRuntimeAgent?.currentTaskId ?? agentId
        : agentId
      const agentSession = attachedSessionId
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
        if (attachedSessionId) return
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
        void window.api.terminalSetVisible(sessionId, false).catch(() => {})
      }
      window.clearTimeout(settleTimer)
      resizeObserver.disconnect()
      container.removeEventListener('mousedown', focusTerminal)
      container.removeEventListener('mouseup', focusTerminal)
      container.removeEventListener('click', focusTerminal)
      container.removeEventListener('focus', focusTerminal)
      disposeClipboardHandlers()
      disposeData()
      disposeExit()
      disposeError()
      onDataDisposable.dispose()
      onResizeDisposable.dispose()
      terminalDiagnostics.dispose()
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
    memoryConfig?.projectRoot,
    memoryConfig?.relativeRoot,
    mcpSettings,
    storedExecutionWorktreePath,
    updateAgent,
    shouldKillOnUnmount,
  ])

  const folderBlocked = Boolean(savedFolderPath && !folderReadyPath)
  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFileDropData(event.dataTransfer)) return
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
    if (!hasFileDropData(event.dataTransfer)) return
    event.preventDefault()
    setIsFileDragOver(false)
    focusTerminalRef.current()

    const sessionId = attachedSessionId ?? agent?.cliSessionId
    if (!sessionId) {
      setDropError('Start this agent terminal before dropping files into it.')
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

    if (!result.ok) setDropError(result.message)
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={(event) => void handleDrop(event)}
      className="absolute inset-0 overflow-hidden px-2 pb-2 cursor-text"
    >
      {isFileDragOver ? (
        <div className="pointer-events-none absolute inset-2 z-10 rounded-md border border-[color:var(--accent-primary)] bg-[color:var(--accent-primary-soft)]" />
      ) : null}
      {dropError ? (
        <div className="absolute right-3 top-3 z-20 max-w-[360px]">
          <Toast
            tone="error"
            title="File drop failed"
            description={dropError}
            onDismiss={() => setDropError(null)}
          />
        </div>
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
