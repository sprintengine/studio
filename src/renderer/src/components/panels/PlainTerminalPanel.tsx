import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useWorkspaceFolderStatus } from '../../hooks/useWorkspaceFolderStatus'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { createTerminalDiagnostics } from '../../utils/terminalDiagnostics'
import { createXtermOutputQueue } from '../../utils/xtermOutputQueue'
import { bindTerminalClipboardHandlers } from '../../utils/terminalClipboard'

interface Props {
  workspaceId: string
  terminalId: string
  cwdOverride?: string | null
  killOnUnmount?: boolean
}

export default function PlainTerminalPanel({ workspaceId, terminalId, cwdOverride = null, killOnUnmount = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const sessionIdRef = useRef(`terminal-${terminalId}`)
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
  const workspaceName = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.name
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (!cwdOverride && savedFolderPath && !folderReadyPath) return

    const sessionId = sessionIdRef.current
    const term = new Terminal({
      theme: {
        background: '#09090b',
        foreground: '#e4e4e7',
        cursor: '#5c7cff',
      },
      fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
    })
    const fitAddon = new FitAddon()
    const terminalDiagnostics = createTerminalDiagnostics({
      scope: 'PlainTerminalPanel',
      sessionId,
      workspaceId,
      terminalId,
      kind: 'terminal',
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
      return true
    })
    term.open(container)
    fitTerminal()
    focusTerminal()
    let reportedTerminalFailure = false
    const outputQueue = createXtermOutputQueue(term, {
      recordWrite: terminalDiagnostics.recordOutputWrite,
    })

    const disposeData = window.api.onTerminalData(sessionId, (data) => {
      outputQueue.enqueue(data)
    })

    const disposeExit = window.api.onTerminalExit(sessionId, (code) => {
      term.write(`\r\n\x1b[31m[Terminal exited with code ${code}]\x1b[0m\r\n`)
      if (code !== 0 && !reportedTerminalFailure) {
        reportedTerminalFailure = true
        publishDiagnosticSync({
          level: 'error',
          source: 'terminal',
          title: 'Terminal exited',
          message: `Terminal exited with code ${code}.`,
          details: `Session: ${sessionId}`,
          workspaceId,
          workspaceName,
          sessionId,
        })
      }
    })

    const disposeError = window.api.onTerminalError(sessionId, (message) => {
      term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`)
      reportedTerminalFailure = true
      publishDiagnosticSync({
        level: 'error',
        source: 'terminal',
        title: 'Terminal failed to start',
        message,
        details: `Session: ${sessionId}`,
        workspaceId,
        workspaceName,
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

    if (cwdOverride || !(savedFolderPath && !folderReadyPath)) {
      const terminalCwd = cwdOverride ?? folderReadyPath ?? undefined
      const swarmStatePath = cwdOverride ? undefined : folderReadyPath ? swarmContext?.statePath : undefined
      void window.api.terminalSpawn(
        sessionId,
        term.cols,
        term.rows,
        terminalCwd,
        false,
        swarmStatePath,
        undefined,
        undefined,
        undefined,
        true,
        {
          kind: 'terminal',
          workspaceId,
          terminalId,
        }
      ).then((spawnResult) => {
        if (spawnResult.ok) return
        if (!reportedTerminalFailure) {
          reportedTerminalFailure = true
          publishDiagnosticSync({
            level: 'error',
            source: 'terminal',
            title: 'Terminal was not started',
            message: spawnResult.message,
            details: [
              `Session: ${sessionId}`,
              `Workspace path: ${terminalCwd ?? savedFolderPath ?? 'default app path'}`,
              swarmStatePath ? `Sprint Engine state: ${swarmStatePath}` : null,
            ].filter(Boolean).join('\n'),
            workspaceId,
            workspaceName,
            sessionId,
          })
        }
      }).catch((error) => {
        if (reportedTerminalFailure) return
        reportedTerminalFailure = true
        publishDiagnosticSync({
          level: 'error',
          source: 'terminal',
          title: 'Terminal was not started',
          message: error instanceof Error ? error.message : 'Failed to start terminal.',
          details: `Session: ${sessionId}`,
          workspaceId,
          workspaceName,
          sessionId,
        })
      })
    }
    const settleTimer = window.setTimeout(() => {
      fitTerminal()
      focusTerminal()
    }, 50)

    return () => {
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
      if (killOnUnmount) {
        void window.api.terminalKill(sessionId).catch(() => {})
      }
    }
  }, [cwdOverride, folderReadyPath, killOnUnmount, savedFolderPath, swarmContext?.statePath, terminalId, workspaceId, workspaceName])

  const folderBlocked = Boolean(!cwdOverride && savedFolderPath && !folderReadyPath)

  return (
    <div className="relative h-full bg-[#09090b]">
      <div
        ref={containerRef}
        tabIndex={0}
        className="absolute inset-0 cursor-text overflow-hidden px-2 pb-2"
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
    </div>
  )
}
