import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { bindTerminalClipboardHandlers } from '../../../utils/terminalClipboard'
import { bindTerminalTheme, getTerminalTheme } from '../../../utils/terminalTheme'
import { createXtermOutputQueue, createXtermReplayGate, type XtermReplayState } from '../../../utils/xtermOutputQueue'
import { TerminalReplaySkeleton } from '../../ui/TerminalReplaySkeleton'
import { createTerminalFitScheduler } from '../../../utils/terminalFitScheduler'
import { MONO_FONT_STACK, waitForMonoFontReady } from '../../../utils/fonts'
import { TERMINAL_RECENT_SCROLLBACK_LINES } from '../../../../../shared/terminal-history'

type Props = {
  sessionId: string
  className?: string
}

export function GuidedBriefRawTerminal({ sessionId, className = '' }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  // Drives the terminal-shaped skeleton while retained scrollback is restored.
  const [replayVisible, setReplayVisible] = useState(true)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let disposed = false
    const focusTerminal = () => terminal.focus()

    const terminal = new Terminal({
      theme: getTerminalTheme(),
      fontFamily: MONO_FONT_STACK,
      fontSize: 13,
      cursorBlink: true,
      scrollback: TERMINAL_RECENT_SCROLLBACK_LINES,
    })
    const disposeTheme = bindTerminalTheme(terminal)
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(container)

    const fitTerminal = () => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      fitAddon.fit()
      if (terminal.cols > 0 && terminal.rows > 0) {
        void window.api.terminalResize(sessionId, terminal.cols, terminal.rows)
      }
    }

    const outputQueue = createXtermOutputQueue(terminal, { recordWrite: () => {} })
    const replayGate = createXtermReplayGate(terminal, outputQueue, {
      onReplayStateChange: (state: XtermReplayState) => {
        if (disposed) return
        setReplayVisible(state.visible)
      },
    })
    replayGate.beginReplayWait()
    const disposeData = window.api.onTerminalData(sessionId, (data) => replayGate.handleLiveData(data))
    const disposeReplay = window.api.onTerminalReplay(sessionId, (data) => replayGate.handleReplay(data))
    const disposeExit = window.api.onTerminalExit(sessionId, (code) => {
      terminal.write(`\r\n\x1b[31m[Terminal exited with code ${code}]\x1b[0m\r\n`)
    })
    const disposeError = window.api.onTerminalError(sessionId, (message) => {
      terminal.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`)
    })
    const onDataDisposable = terminal.onData((data) => window.api.terminalWriteFast(sessionId, data))
    const onResizeDisposable = terminal.onResize(({ cols, rows }) => {
      void window.api.terminalResize(sessionId, cols, rows)
    })
    const fitScheduler = createTerminalFitScheduler(fitTerminal, container)
    const resizeObserver = new ResizeObserver(() => fitScheduler.requestFit())

    resizeObserver.observe(container)
    fitTerminal()
    focusTerminal()
    void waitForMonoFontReady().then(() => {
      if (disposed) return
      fitTerminal()
      terminal.refresh(0, Math.max(0, terminal.rows - 1))
    })
    container.addEventListener('mousedown', focusTerminal)
    container.addEventListener('mouseup', focusTerminal)
    container.addEventListener('click', focusTerminal)
    container.addEventListener('focus', focusTerminal)
    const disposeClipboardHandlers = bindTerminalClipboardHandlers({
      container,
      term: terminal,
      sessionId,
      focusTerminal,
      recordKeydown: () => {},
    })
    const settleTimer = window.setTimeout(() => {
      replayGate.finishReplayWait()
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
      disposeTheme()
      disposeData()
      disposeReplay()
      disposeExit()
      disposeError()
      onDataDisposable.dispose()
      onResizeDisposable.dispose()
      replayGate.dispose()
      outputQueue.dispose()
      terminal.dispose()
    }
  }, [sessionId])

  return (
    <div className={`relative h-full min-h-0 overflow-hidden ${className}`}>
      <div ref={containerRef} tabIndex={0} className="absolute inset-0 cursor-text overflow-hidden" />
      {!replayVisible ? <TerminalReplaySkeleton /> : null}
    </div>
  )
}
