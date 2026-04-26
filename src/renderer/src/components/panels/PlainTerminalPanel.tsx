import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useWorkspaceFolderStatus } from '../../hooks/useWorkspaceFolderStatus'

interface Props {
  workspaceId: string
  terminalId: string
}

export default function PlainTerminalPanel({ workspaceId, terminalId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const sessionIdRef = useRef(`terminal-${terminalId}`)
  const {
    folderPath: savedFolderPath,
    folderReadyPath,
    folderMissing,
    checkingFolder,
  } = useWorkspaceFolderStatus(workspaceId)
  const swarmContext = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.swarmContext ?? null
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (savedFolderPath && !folderReadyPath) return

    const sessionId = sessionIdRef.current
    const term = new Terminal({
      theme: {
        background: '#09090b',
        foreground: '#e4e4e7',
        cursor: '#6ee7d8',
      },
      fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
    })
    const fitAddon = new FitAddon()

    const fitTerminal = () => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      fitAddon.fit()
      if (term.cols > 0 && term.rows > 0) {
        void window.api.terminalResize(sessionId, term.cols, term.rows)
      }
    }

    const focusTerminal = () => {
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
    term.open(container)
    fitTerminal()
    focusTerminal()

    const disposeData = window.api.onTerminalData(sessionId, (data) => {
      term.write(data)
    })

    const disposeExit = window.api.onTerminalExit(sessionId, (code) => {
      term.write(`\r\n\x1b[31m[Terminal exited with code ${code}]\x1b[0m\r\n`)
    })

    const disposeError = window.api.onTerminalError(sessionId, (message) => {
      term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`)
    })

    const onDataDisposable = term.onData((data) => {
      void window.api.terminalWrite(sessionId, data)
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

    const swarmStatePath = folderReadyPath ? swarmContext?.statePath : undefined
    void window.api.terminalSpawn(
      sessionId,
      term.cols,
      term.rows,
      folderReadyPath ?? undefined,
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
    )
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
      container.removeEventListener('copy', handleCopy)
      container.removeEventListener('paste', handlePaste)
      container.removeEventListener('keydown', handleKeyDown)
      container.removeEventListener('contextmenu', handleContextMenu)
      disposeData()
      disposeExit()
      disposeError()
      onDataDisposable.dispose()
      onResizeDisposable.dispose()
      term.dispose()
    }
  }, [folderReadyPath, savedFolderPath, swarmContext?.statePath, terminalId, workspaceId])

  const folderBlocked = Boolean(savedFolderPath && !folderReadyPath)

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
                ? 'Saved workspace folder is missing. Relink it from the Files pane before starting this terminal.'
                : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
