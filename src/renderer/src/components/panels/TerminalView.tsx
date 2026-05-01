import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useWorkspaceFolderStatus } from '../../hooks/useWorkspaceFolderStatus'
import type { AgentExecution, AgentExecutionMode } from '../../types/workspace'
import { getSpecialistAction, loadSpecialistPrompt } from '../../specialists/specialistActions'
import { buildSwarmAgentRosterForState, swarmRoleLabels } from '../../utils/swarm'
import { buildSwarmStartupPrompt, getSwarmStartupCommandMode, prependAgentIdentifier } from '../../utils/agentPrompt'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { createTerminalDiagnostics } from '../../utils/terminalDiagnostics'

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
  const cliPermissionPreset = useWorkspaceStore((s) => {
    const workspace = s.workspaces.find((w) => w.id === workspaceId)
    const currentAgent = workspace?.agents[agentId]
    if (
      workspace?.mode !== 'swarm'
      || !workspace.swarmAutoState.enabled
      || currentAgent?.kind !== 'swarm'
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

    if (workspace?.mode !== 'swarm' || !workspace.swarmState) return null

    const rosterAgent = buildSwarmAgentRosterForState(workspace.swarmState).find(
      (candidate) => candidate.id === agentId
    )

    if (!rosterAgent) return null

    const basePrompt = buildSwarmStartupPrompt(
      rosterAgent.role,
      agentId,
      workspace.swarmState.goal,
      {
        commandMode: getSwarmStartupCommandMode(rosterAgent.role, agentId, workspace.swarmState),
        useWorktreesForSwarms: workspace.swarmAutoState.useWorktreesForSwarms,
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

    const copySelection = async () => {
      const selection = term.getSelection()
      if (!selection) return
      await navigator.clipboard.writeText(selection)
    }

    const pasteText = async (text: string) => {
      if (!text) return
      await window.api.terminalWrite(sessionId, text.replace(/\r?\n/g, '\r'))
      focusTerminal()
    }

    const handleCopy = (event: ClipboardEvent) => {
      const selection = term.getSelection()
      if (!selection) return
      event.preventDefault()
      event.clipboardData?.setData('text/plain', selection)
      void navigator.clipboard.writeText(selection).catch(() => {})
    }

    const handlePaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData('text/plain') ?? ''
      if (!text) return
      event.preventDefault()
      void pasteText(text)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      terminalDiagnostics.recordContainerKeydown(event)
      const mod = event.ctrlKey || event.metaKey
      if (!mod) return

      const key = event.key.toLowerCase()
      if (key === 'c' && event.shiftKey) {
        event.preventDefault()
        void copySelection().catch(() => {})
      }

      if (key === 'v' && event.shiftKey) {
        event.preventDefault()
        void navigator.clipboard.readText().then(pasteText).catch(() => {})
      }
    }

    const handleContextMenu = async (event: MouseEvent) => {
      event.preventDefault()
      const hasSelection = term.hasSelection()
      const command = await window.api.showContextMenu([
        { id: 'copy', label: 'Copy', enabled: hasSelection },
        { id: 'paste', label: 'Paste' },
        { type: 'separator' },
        { id: 'select-all', label: 'Select All' },
      ])

      if (command === 'copy') {
        void copySelection().catch(() => {})
      } else if (command === 'paste') {
        void navigator.clipboard.readText().then(pasteText).catch(() => {})
      } else if (command === 'select-all') {
        term.selectAll()
      }

      focusTerminal()
    }

    term.loadAddon(fitAddon)
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown') {
        terminalDiagnostics.recordKeydown(event)
      }
      if (event.type === 'keydown' && event.key === 'Enter' && event.shiftKey) {
        event.preventDefault()
        void window.api.terminalWrite(sessionId, '\u001b[13;2u')
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

    const disposeData = window.api.onTerminalData(sessionId, (data) => {
      const startedAt = performance.now()
      term.write(data, () => {
        terminalDiagnostics.recordOutputWrite(data, performance.now() - startedAt)
      })
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
      const startedAt = performance.now()
      void window.api.terminalWrite(sessionId, data).then(
        () => terminalDiagnostics.recordInputWrite(data, startedAt, true),
        () => terminalDiagnostics.recordInputWrite(data, startedAt, false)
      )
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
    container.addEventListener('copy', handleCopy)
    container.addEventListener('paste', handlePaste)
    container.addEventListener('keydown', handleKeyDown)
    container.addEventListener('contextmenu', handleContextMenu)

    const ensureSpecialistStartupPrompt = async (promptAlreadySentForActiveSession: boolean) => {
      if (startupPromptRef.current || promptAlreadySentForActiveSession) return
      if (agent.kind !== 'specialist' || !agent.specialistId) return

      const specialist = getSpecialistAction(agent.specialistId)
      const prompt = await loadSpecialistPrompt(specialist.id)
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
      const promptAlreadySentForActiveSession = Boolean(resumeExistingPty && agent.cliOnboardingPromptSent)
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
        swarmStatePath ? `Swarm state: ${swarmStatePath}` : null,
      ].filter(Boolean).join('\n')
      const launchInitialPrompt = resumeExistingPty ? undefined : startupPromptRef.current ?? undefined

      const spawnResult = await window.api.terminalSpawn(
        sessionId,
        term.cols,
        term.rows,
        executionRoot.cwd,
        resumeExistingPty,
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
      container.removeEventListener('copy', handleCopy)
      container.removeEventListener('paste', handlePaste)
      container.removeEventListener('keydown', handleKeyDown)
      container.removeEventListener('contextmenu', handleContextMenu)
      disposeData()
      disposeExit()
      disposeError()
      onDataDisposable.dispose()
      onResizeDisposable.dispose()
      terminalDiagnostics.dispose()
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
