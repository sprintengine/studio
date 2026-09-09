import React, { useEffect, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useWorkspaceFolderStatus } from '../../hooks/useWorkspaceFolderStatus'
import { resolveWorkspaceTerminalCwd, resolveWorkspaceWorktree } from '../../utils/workspaceWorktree'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { recordReplayProfile } from '../../utils/diagnostics/replayProfileStore'
import { createStudioTerminal, terminalSurfaceLinkRoots, type TerminalSurface } from '../../utils/createStudioTerminal'
import { createTerminalDiagnostics } from '../../utils/terminalDiagnostics'
import { createTerminalFileLinkProvider } from '../../utils/terminalFileLinks'
import { createTerminalOscLinkHandler, parseTerminalOscCwd } from '../../utils/terminalOscLinks'
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
import { TerminalLinkMenu } from '../terminal/TerminalLinkMenu'
import type { TerminalLinkTarget } from '../../utils/terminalLinkActions'

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
  // A failed file drop or a dead link, anchored to the pointer that raised it so
  // the error surfaces next to the cursor instead of a corner toast.
  const [cursorError, setCursorError] = useState<{ message: string; x: number; y: number } | null>(null)
  // A clicked link awaiting a destination (MC-1899), exactly as an agent pane
  // does it: the click opens a chooser rather than firing one hard-wired action.
  const [linkMenu, setLinkMenu] = useState<{
    target: TerminalLinkTarget
    x: number
    y: number
    line?: number
    column?: number
  } | null>(null)
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
    // A shell pane carries its workspace root and no launch-time execution root:
    // unlike an agent, nothing here resolves a cwd of its own up front. The live
    // one arrives over the wire instead — see the OSC 7 handler below.
    const terminalSurface: TerminalSurface = {
      kind: 'shell',
      workspaceRoot: folderReadyPath ?? savedFolderPath ?? null,
    }
    // Read here rather than off `studioTerminal` because the OSC 8 handler is a
    // CONSTRUCTION option (xterm's OscLinkProvider reads `options.linkHandler`),
    // so this surface's permission to resolve a local path must be known before
    // the terminal exists. Same function the factory calls.
    const surfaceLinkRoots = terminalSurfaceLinkRoots(terminalSurface)
    // Where this shell actually IS, in two layers, newest first.
    //
    // `launchExecutionRoot` is the directory the pty was spawned in, which is
    // only known after the async worktree probe below — so it is written there
    // rather than captured here, and the link provider reads both through a
    // thunk.
    //
    // `oscExecutionRoot` is what the shell itself reports over OSC 7, and it is
    // the only one that stays true: the launch directory stops being the cwd the
    // first time the user types `cd`, and every relative path printed afterwards
    // then resolves into a tree the shell left. That failure is invisible —
    // the same relative path usually exists in the old tree too — so the link
    // opens the wrong copy instead of failing.
    let launchExecutionRoot: string | null = null
    let oscExecutionRoot: string | null = null
    const inspectPath = async (path: string): Promise<{ exists: boolean; isDirectory: boolean }> => {
      try {
        const stat = await window.api.statPath(path)
        return { exists: true, isDirectory: stat.isDirectory }
      } catch {
        return { exists: false, isDirectory: false }
      }
    }
    const openFileLinkMenu = (
      { resolvedPath, isDirectory, line, column }: {
        resolvedPath: string
        isDirectory: boolean
        line?: number
        column?: number
      },
      anchor: { x: number; y: number },
    ): void => {
      setLinkMenu({
        target: {
          kind: 'file',
          resolvedPath,
          isDirectory,
          workspaceRoot: surfaceLinkRoots?.workspaceRoot ?? null,
        },
        x: anchor.x,
        y: anchor.y,
        line,
        column,
      })
    }
    const studioTerminal = createStudioTerminal({
      surface: terminalSurface,
      linkHandler: createTerminalOscLinkHandler({
        allowLocalPaths: surfaceLinkRoots !== null,
        inspectPath,
        onActivateFile: openFileLinkMenu,
        onActivateUrl: (url, anchor) => {
          setLinkMenu({ target: { kind: 'url', url }, x: anchor.x, y: anchor.y })
        },
        onOpenError: (message, anchor) => setCursorError({ message, x: anchor.x, y: anchor.y }),
      }),
      onWebLink: (event, uri) => {
        setLinkMenu({ target: { kind: 'url', url: uri }, x: event.clientX, y: event.clientY })
      },
      // OSC 7 — the shell reporting its working directory. xterm registers
      // handlers for 0,1,2,4,8,10-12,104,110-112 and NOT 7, so without this the
      // sequence the startup script now emits (`terminal-launch.ts`) would be
      // parsed and thrown away.
      oscHandlers: {
        7: (data) => {
          // Same gate as an OSC 8 payload, and for the same reason: this is a
          // sequence any program with a pane can print. A payload naming
          // another host, or any local path at all on a surface with no link
          // roots, leaves the previous value standing.
          const cwd = parseTerminalOscCwd(data, { allowLocalPaths: surfaceLinkRoots !== null })
          if (cwd) oscExecutionRoot = cwd
          // Handled either way: nothing else in the app wants OSC 7, and
          // reporting it unhandled would only put it back on xterm's floor.
          return true
        },
      },
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

    // Non-null for every shell surface; the guard is what keeps a surface that
    // must not resolve local paths (fleet) from ever registering this provider.
    const fileLinkDisposable = surfaceLinkRoots ? term.registerLinkProvider(createTerminalFileLinkProvider({
      terminal: term,
      workspaceRoot: surfaceLinkRoots.workspaceRoot,
      // A thunk, so a `cd` (or the async spawn-cwd resolution below) reaches the
      // links already on screen without re-registering the provider.
      executionRoot: () => oscExecutionRoot ?? launchExecutionRoot,
      inspectPath,
      onActivate: openFileLinkMenu,
      onOpenError: (message, anchor) => setCursorError({ message, x: anchor.x, y: anchor.y }),
      // A matched path that never became a link leaves no trace on screen, so
      // count it — a workspace with no configured folder drops every relative
      // path in the pane and looks identical to a pane containing none.
      onDrop: terminalDiagnostics.recordFileLinkDrop,
    })) : null

    // Loaded AFTER the file-link provider on purpose: xterm resolves link
    // providers in registration order and the earlier one's links suppress the
    // later one's on the same row, so a path that is also a valid URL fragment
    // must reach the file provider first.
    studioTerminal.loadWebLinks()

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
        // The directory the pty is about to start in — the resolution base for
        // relative paths until the shell reports one of its own. It matters most
        // for a pane with a `cwdOverride` or a worktree redirect, where it is
        // NOT the workspace root the surface carries.
        launchExecutionRoot = terminalCwd ?? null
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
      fileLinkDisposable?.dispose()
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
      setCursorError({ message, x: dropAnchor.x, y: dropAnchor.y })

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
        {cursorError ? (
          <CursorErrorPopover
            key={`${cursorError.x},${cursorError.y},${cursorError.message}`}
            message={cursorError.message}
            anchor={{ x: cursorError.x, y: cursorError.y }}
            onDismiss={() => setCursorError(null)}
          />
        ) : null}
        {linkMenu ? (
          <TerminalLinkMenu
            workspaceId={workspaceId}
            target={linkMenu.target}
            x={linkMenu.x}
            y={linkMenu.y}
            line={linkMenu.line}
            column={linkMenu.column}
            onClose={() => setLinkMenu(null)}
            // A failed destination reports through the same pointer-anchored
            // error surface the link click already used, at the click point.
            onError={(message) => setCursorError({ message, x: linkMenu.x, y: linkMenu.y })}
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
