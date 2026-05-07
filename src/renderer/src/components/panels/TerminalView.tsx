import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useWorkspaceFolderStatus } from '../../hooks/useWorkspaceFolderStatus'
import type { AgentExecution, AgentExecutionMode } from '../../types/workspace'
import { buildSpecialistSoulStartupPrompt, getSpecialistAction } from '../../specialists/specialistActions'
import { buildSwarmAgentRosterForState, buildSwarmRosterCommandArgs, swarmRoleLabels } from '../../utils/sprintengine'
import { buildSwarmStartupPrompt, getSwarmStartupCommandMode, prependAgentIdentifier } from '../../utils/agentPrompt'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { createTerminalDiagnostics } from '../../utils/terminalDiagnostics'
import { createXtermOutputQueue } from '../../utils/xtermOutputQueue'
import { bindTerminalClipboardHandlers } from '../../utils/terminalClipboard'

interface Props {
  workspaceId: string
  agentId: string
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
    message: error instanceof Error ? error.message : 'Unable to resolve workspace memory.',
  }))

  if (status.ok) {
    return {
      rootPath: status.rootPath,
      relativeRoot: status.relativeRoot,
      promptSuffix: [
        `Workspace memory is configured at ${status.relativeRoot}.`,
        'This is a local Markdown knowledge graph for product, architecture, brand, and ecosystem context.',
        'Inspect it when relevant instead of assuming project context.',
      ].join(' '),
    }
  }

  return {
    rootPath: undefined,
    relativeRoot: configuredRoot,
    promptSuffix: `Workspace memory is configured at ${configuredRoot}, but the folder is currently missing or inaccessible. Do not guess another memory folder.`,
  }
}

function appendMemoryPrompt(prompt: string | undefined, memoryContext: MemoryLaunchContext): string | undefined {
  if (!memoryContext.promptSuffix) return prompt
  if (!prompt) return memoryContext.promptSuffix
  return `${prompt}\n\n${memoryContext.promptSuffix}`
}

export default function TerminalView({ workspaceId, agentId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
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
  const swarmContext = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.swarmContext ?? null
  )
  const memoryRelativeRoot = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.memory.relativeRoot ?? null
  )
  const cliPermissionPreset = useWorkspaceStore((s) => {
    const workspace = s.workspaces.find((w) => w.id === workspaceId)
    const currentAgent = workspace?.agents[agentId]
    if (currentAgent?.kind !== 'sprintengine' && currentAgent?.cliPermissionPreset) {
      return currentAgent.cliPermissionPreset
    }

    if (
      workspace?.mode !== 'sprintengine'
      || !workspace.swarmAutoState.enabled
      || currentAgent?.kind !== 'sprintengine'
    ) {
      return undefined
    }

    return workspace.swarmAutoState.cliPermissionPreset
  })
  const storedExecutionWorktreePath = useWorkspaceStore((s) => {
    const workspace = s.workspaces.find((w) => w.id === workspaceId)
    const worktreeId = workspace?.agents[agentId]?.execution.worktreeId
    return worktreeId ? workspace?.worktreeState.entries[worktreeId]?.path : undefined
  })
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const cli = agent?.cli ?? 'codex'
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  const startupPrompt = useWorkspaceStore((s) => {
    const workspace = s.workspaces.find((w) => w.id === workspaceId)
    const currentAgent = workspace?.agents[agentId]
    if (currentAgent?.cliStartupPrompt) return currentAgent.cliStartupPrompt

    if (workspace?.mode !== 'sprintengine' || !workspace.swarmState) return null

    const rosterAgent = buildSwarmAgentRosterForState(workspace.swarmState).find(
      (candidate) => candidate.id === agentId
    )

    if (!rosterAgent) return null

    const basePrompt = buildSwarmStartupPrompt(
      rosterAgent.role,
      agentId,
      workspace.swarmState.goal,
      {
        executionCwd: resolveAgentExecutionRoot(currentAgent?.execution, storedExecutionWorktreePath, folderReadyPath).cwd,
        workspaceRoot: folderReadyPath ?? undefined,
        rosterArgs: buildSwarmRosterCommandArgs(workspace.swarmState),
        commandMode: getSwarmStartupCommandMode(rosterAgent.role, agentId, workspace.swarmState),
      }
    )
    const customName = currentAgent?.name && currentAgent.name !== rosterAgent.label
      ? currentAgent.name
      : ''
    return customName ? prependAgentIdentifier(basePrompt, customName, swarmRoleLabels[rosterAgent.role]) : basePrompt
  })
  const startupPromptRef = useRef<string | null>(startupPrompt)

  useEffect(() => {
    startupPromptRef.current = startupPrompt
  }, [startupPrompt])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (savedFolderPath && !folderReadyPath) return

    if (!agent?.cliSessionId) {
      updateAgent(workspaceId, agentId, {
        cliSessionId: crypto.randomUUID(),
        cliHasLaunched: false,
      })
      return
    }

    const sessionId = agent.cliSessionId
    const shouldResume = agent.cliHasLaunched ?? false
    const shouldResumeCodexConversation = cli === 'codex' && Boolean(agent.cliResumeAvailable)
    const term = new Terminal({
      theme: {
        background: '#09090b',
        foreground: '#e4e4e7',
        cursor: '#818cf8',
      },
      fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
    })
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
      if (agent.kind !== 'specialist' || !agent.specialistId) return

      const specialist = getSpecialistAction(agent.specialistId)
      const prompt = buildSpecialistSoulStartupPrompt(specialist)
      if (disposed) return

      const identifiedPrompt = prependAgentIdentifier(prompt, agent.name, specialist.shortLabel)
      startupPromptRef.current = identifiedPrompt
      updateAgent(workspaceId, agentId, { cliStartupPrompt: identifiedPrompt })
    }

    const launchTerminal = async () => {
      const terminalStatus = await window.api.terminalStatus(sessionId).catch(() => ({ running: false }))
      if (disposed) return
      if (savedFolderPath && !folderReadyPath) return

      const resumeExistingPty = shouldResume && terminalStatus.running
      const shouldResumeCli = resumeExistingPty || shouldResumeCodexConversation
      const promptAlreadySentForActiveSession = Boolean(shouldResumeCli && agent.cliOnboardingPromptSent)
      await ensureSpecialistStartupPrompt(promptAlreadySentForActiveSession)
      if (disposed) return

      const swarmStatePath = folderReadyPath ? swarmContext?.statePath : undefined
      const executionRoot = resolveAgentExecutionRoot(
        agent.execution,
        storedExecutionWorktreePath,
        folderReadyPath
      )
      terminalLaunchDetails = [
        `Session: ${sessionId}`,
        `CLI: ${cli}`,
        cliPermissionPreset ? `CLI permissions: ${cliPermissionPreset}` : null,
        `Workspace path: ${folderReadyPath ?? savedFolderPath ?? 'default app path'}`,
        executionRoot.worktreePath ? `Worktree path: ${executionRoot.worktreePath}` : null,
        swarmStatePath ? `Sprint Engine state: ${swarmStatePath}` : null,
      ].filter(Boolean).join('\n')
      const memoryContext = await resolveMemoryLaunchContext(folderReadyPath ?? null, memoryRelativeRoot)
      if (disposed) return
      const launchInitialPrompt = shouldResumeCli
        ? undefined
        : appendMemoryPrompt(startupPromptRef.current ?? undefined, memoryContext)

      const spawnResult = await window.api.terminalSpawn(
        sessionId,
        term.cols,
        term.rows,
        executionRoot.cwd,
        shouldResumeCli,
        swarmStatePath,
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
        updateAgent(workspaceId, agentId, {
          cliHasLaunched: true,
          ...(cli === 'codex' ? { cliResumeAvailable: true } : {}),
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
      term.dispose()
    }
  }, [
    workspaceId,
    agentId,
    agent?.cliSessionId,
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
    swarmContext?.statePath,
    memoryRelativeRoot,
    storedExecutionWorktreePath,
    updateAgent,
  ])

  const folderBlocked = Boolean(savedFolderPath && !folderReadyPath)

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      className="absolute inset-0 overflow-hidden px-2 pb-2 cursor-text"
    >
      {folderBlocked ? (
        <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-[#5a5a63]">
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
