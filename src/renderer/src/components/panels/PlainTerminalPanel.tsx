import React, { useEffect, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useWorkspaceFolderStatus } from '../../hooks/useWorkspaceFolderStatus'
import { resolveWorkspaceTerminalCwd, resolveWorkspaceWorktree } from '../../utils/workspaceWorktree'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { recordReplayProfile } from '../../utils/diagnostics/replayProfileStore'
import { createStudioTerminal } from '../../utils/createStudioTerminal'
import { createTerminalDiagnostics } from '../../utils/terminalDiagnostics'
import { createXtermOutputQueue, createXtermReplayGate } from '../../utils/xtermOutputQueue'
import { registerTerminalInstance, unregisterTerminalInstance } from '../../utils/diagnostics/terminalInstanceRegistry'
import { TerminalReplaySkeleton } from '../ui/TerminalReplaySkeleton'
import { bindTerminalClipboardHandlers } from '../../utils/terminalClipboard'
import { createTerminalFitScheduler } from '../../utils/terminalFitScheduler'
import { onTerminalFocusRequest } from '../../utils/terminalFocusRequest'
import {
  hasCommitDropData,
  hasFileDropData,
  hasSkillDropData,
  pasteDroppedCommitIntoTerminal,
  pasteDroppedFilesIntoTerminal,
} from '../../utils/terminalDrop'
import { waitForMonoFontReady } from '../../utils/fonts'
import { CursorErrorPopover } from '../ui/CursorErrorPopover'
import { FOCUS_RING_TERMINAL_CLASS } from '../ui/tokens'

interface Props {
  workspaceId: string
  terminalId: string
  cwdOverride?: string | null
  killOnUnmount?: boolean
  shouldKillOnUnmount?: (sessionId: string) => boolean
}

export default function PlainTerminalPanel({
  workspaceId,
  terminalId,
  cwdOverride = null,
  killOnUnmount = false,
  shouldKillOnUnmount,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const sessionIdRef = useRef(`terminal-${terminalId}`)
  const [isFileDragOver, setIsFileDragOver] = useState(false)
  // A failed file drop, anchored to the pointer that raised it so the error
  // surfaces next to the cursor instead of a corner toast.
  const [dropError, setDropError] = useState<{ message: string; x: number; y: number } | null>(null)
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
  // Derived string, not the workspace object: sprintEngineState re-projects
  // ~every 4s and churns object identity, but the gitRoot string is stable, so
  // the spawn effect below re-runs at most once (null -> path).
  const workspaceWorktreeGitRoot = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    return ws ? resolveWorkspaceWorktree(ws)?.gitRoot ?? null : null
  })
  const workspaceName = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.name
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (!cwdOverride && savedFolderPath && !folderReadyPath) return

    const sessionId = sessionIdRef.current
    // A shell pane carries its workspace root but no execution root: unlike an
    // agent, nothing here resolves a cwd of its own. It registers no file-link
    // provider today — see [[terminal-relative-links-dropped]] — so the roots
    // are carried, not yet read.
    const studioTerminal = createStudioTerminal({
      surface: { kind: 'shell', workspaceRoot: folderReadyPath ?? savedFolderPath ?? null },
    })
    const term = studioTerminal.terminal
    registerTerminalInstance(sessionId, term)
    const fitAddon = studioTerminal.fitAddon
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

    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown') {
        terminalDiagnostics.recordKeydown(event)
      }
      return true
    })
    term.open(container)
    fitTerminal()
    focusTerminal()
    let disposed = false
    void waitForMonoFontReady().then(() => {
      if (disposed) return
      fitTerminal()
      term.refresh(0, Math.max(0, term.rows - 1))
    })
    let reportedTerminalFailure = false
    const outputQueue = createXtermOutputQueue(term, {
      recordWrite: terminalDiagnostics.recordOutputWrite,
    })
    const replayGate = createXtermReplayGate(term, outputQueue, {
      recordWrite: terminalDiagnostics.recordOutputWrite,
      onReplayProfile: (profile) => {
        logPerfEvent('PlainTerminalPanel', 'terminal-replay-profile', {
          sessionId,
          workspaceId,
          terminalId,
          kind: 'terminal',
          ...profile,
        })
        recordReplayProfile({
          ...profile,
          recordedAt: Date.now(),
          sessionId,
          workspaceId,
          terminalId,
          kind: 'terminal',
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
    // Opening a workspace hands the keyboard to its visible terminal
    // (WorkspaceManager); the mount-time focusTerminal above can't do that job
    // because it also fires in panes stacked behind the visible tab.
    const disposeFocusRequest = onTerminalFocusRequest({ workspaceId, terminalId }, focusTerminal)

    if (cwdOverride || !(savedFolderPath && !folderReadyPath)) {
      void (async () => {
        // Redirect the spawn into the run worktree when this workspace is
        // worktree-backed; short-circuits (no fs probe) for normal, worktree-
        // opened, and connector-chat workspaces. Awaited before spawn so the pty
        // starts in the right directory.
        const resolved = await resolveWorkspaceTerminalCwd(
          workspaceWorktreeGitRoot,
          folderReadyPath,
          window.api.pathExists,
        )
        if (disposed) return
        const terminalCwd = cwdOverride ?? resolved.cwd ?? folderReadyPath ?? undefined
        const sprintEngineStatePath = cwdOverride ? undefined : folderReadyPath ? sprintEngineContext?.statePath : undefined
        if (resolved.missing) {
          term.write(
            `\r\n\x1b[31m[worktree missing — opened in main checkout: ${terminalCwd ?? savedFolderPath ?? 'the workspace folder'}]\x1b[0m\r\n`
          )
        }
        void window.api.terminalStatus(sessionId).then((status) => {
          logPerfEvent('PlainTerminalPanel', status.processAlive ? 'terminal-reattach-existing-session' : 'terminal-spawn-fresh', {
            sessionId,
            workspaceId,
            terminalId,
            kind: 'terminal',
            processAlive: status.processAlive,
            resumeRequested: false,
            willSpawnFresh: !status.processAlive,
          })
        }).catch(() => {})
        replayGate.beginReplayWait()
        void window.api.terminalSpawn(
          sessionId,
          term.cols,
          term.rows,
          terminalCwd,
          false,
          sprintEngineStatePath,
          undefined,
          undefined,
          undefined,
          true,
          {
            kind: 'terminal',
            workspaceId,
            terminalId,
            visible: true,
          }
        ).then((spawnResult) => {
          replayGate.finishReplayWait()
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
                sprintEngineStatePath ? `Sprint state: ${sprintEngineStatePath}` : null,
              ].filter(Boolean).join('\n'),
              workspaceId,
              workspaceName,
              sessionId,
            })
          }
        }).catch((error) => {
          replayGate.finishReplayWait()
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
      })()
    }
    const settleTimer = window.setTimeout(() => {
      fitTerminal()
      focusTerminal()
    }, 50)

    return () => {
      disposed = true
      window.clearTimeout(settleTimer)
      resizeObserver.disconnect()
      fitScheduler.dispose()
      container.removeEventListener('mousedown', focusTerminal)
      container.removeEventListener('mouseup', focusTerminal)
      container.removeEventListener('click', focusTerminal)
      container.removeEventListener('focus', focusTerminal)
      disposeClipboardHandlers()
      disposeFocusRequest()
      disposeData()
      disposeReplay()
      disposeExit()
      disposeError()
      onDataDisposable.dispose()
      onResizeDisposable.dispose()
      terminalDiagnostics.dispose()
      replayGate.dispose()
      outputQueue.dispose()
      unregisterTerminalInstance(sessionId)
      // Last: it unbinds the theme and disposes the terminal itself, so nothing
      // above may still be reading `term`.
      studioTerminal.dispose()
      if (killOnUnmount || shouldKillOnUnmount?.(sessionId)) {
        void window.api.terminalKill(sessionId).catch(() => {})
      } else {
        logPerfEvent('PlainTerminalPanel', 'terminal-detached-from-renderer', {
          sessionId,
          workspaceId,
          terminalId,
          kind: 'terminal',
        })
        void window.api.terminalSetVisible(sessionId, false).catch(() => {})
      }
    }
  }, [cwdOverride, folderReadyPath, killOnUnmount, savedFolderPath, shouldKillOnUnmount, sprintEngineContext?.statePath, terminalId, workspaceId, workspaceName, workspaceWorktreeGitRoot])

  const folderBlocked = Boolean(!cwdOverride && savedFolderPath && !folderReadyPath)
  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    // A skill dragged here is caught and refused rather than ignored: this is a
    // shell, and an ignored drop would let the raw id land in it as plain text.
    // `none` refuses it for the whole hover, which says so earlier than a
    // message after the release, and no drop-target highlight is drawn.
    if (hasSkillDropData(event.dataTransfer)) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'none'
      return
    }
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
    const isSkillDrop = hasSkillDropData(event.dataTransfer)
    if (!hasFileDropData(event.dataTransfer) && !isCommitDrop && !isSkillDrop) return
    event.preventDefault()
    setIsFileDragOver(false)

    const dropAnchor = { x: event.clientX, y: event.clientY }
    const showDropError = (message: string) =>
      setDropError({ message, x: dropAnchor.x, y: dropAnchor.y })

    // Normally unreachable — the refusal above ends the drag — but it is what
    // stops a skill that did reach here falling through to the file path and
    // reporting "no file was dropped", which explains nothing.
    if (isSkillDrop) {
      showDropError('This is a plain terminal. Drop a skill onto an agent instead.')
      return
    }

    if (isCommitDrop) {
      const commitResult = await pasteDroppedCommitIntoTerminal({
        dataTransfer: event.dataTransfer,
        sessionId: sessionIdRef.current,
      }).catch((error): { ok: false; message: string } => ({
        ok: false,
        message: error instanceof Error ? error.message : 'Could not drop the commit into the terminal.',
      }))
      if (!commitResult.ok) showDropError(commitResult.message)
      return
    }

    const result = await pasteDroppedFilesIntoTerminal({
      dataTransfer: event.dataTransfer,
      sessionId: sessionIdRef.current,
      workspaceId,
    }).catch((error): { ok: false; message: string } => ({
      ok: false,
      message: error instanceof Error ? error.message : 'Could not drop the file into the terminal.',
    }))

    if (!result.ok) showDropError(result.message)
  }

  return (
    <div className="relative h-full bg-[color:var(--bg-app)]">
      <div
        ref={containerRef}
        tabIndex={0}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(event) => void handleDrop(event)}
        className={`${FOCUS_RING_TERMINAL_CLASS} absolute inset-0 cursor-text overflow-hidden p-2 pb-4`}
      >
        {/* No replay skeleton on terminals (see TerminalView): xterm renders
            its own content; keep the skeleton only for the folder check. */}
        {folderBlocked && checkingFolder ? <TerminalReplaySkeleton /> : null}
        {isFileDragOver ? (
          <div className="pointer-events-none absolute inset-2 z-10 rounded-md border border-[color:var(--accent-primary)] bg-[color:var(--accent-primary-soft)]" />
        ) : null}
        {dropError ? (
          <CursorErrorPopover
            key={`${dropError.x},${dropError.y},${dropError.message}`}
            message={dropError.message}
            anchor={{ x: dropError.x, y: dropError.y }}
            onDismiss={() => setDropError(null)}
          />
        ) : null}
        {folderBlocked && folderMissing ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-meta text-[color:var(--text-muted)]">
            {folderStatusMessage ?? 'Saved workspace folder is missing. Relink it from the Files pane before starting this terminal.'}
          </div>
        ) : null}
      </div>
    </div>
  )
}
