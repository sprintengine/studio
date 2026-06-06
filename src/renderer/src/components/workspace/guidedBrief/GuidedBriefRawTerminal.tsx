import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { bindTerminalClipboardHandlers } from '../../../utils/terminalClipboard'
import { bindTerminalTheme, getTerminalTheme } from '../../../utils/terminalTheme'
import { createXtermOutputQueue } from '../../../utils/xtermOutputQueue'
import { deferFitDuringSidebarAnimation } from '../../../utils/sidebarTransition'
import { TERMINAL_RECENT_SCROLLBACK_LINES } from '../../../../../shared/terminal-history'

type Props = {
  sessionId: string
  className?: string
}

export function GuidedBriefRawTerminal({ sessionId, className = '' }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const focusTerminal = () => terminal.focus()

    const terminal = new Terminal({
      theme: getTerminalTheme(),
      fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
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
    const disposeData = window.api.onTerminalData(sessionId, (data) => outputQueue.enqueue(data))
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
    const fitScheduler = deferFitDuringSidebarAnimation(fitTerminal)
    const resizeObserver = new ResizeObserver(() => fitScheduler.requestFit())

    resizeObserver.observe(container)
    fitTerminal()
    focusTerminal()
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
      fitTerminal()
      focusTerminal()
    }, 50)

    return () => {
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
      disposeExit()
      disposeError()
      onDataDisposable.dispose()
      onResizeDisposable.dispose()
      outputQueue.dispose()
      terminal.dispose()
    }
  }, [sessionId])

  return <div ref={containerRef} tabIndex={0} className={`h-full min-h-0 cursor-text overflow-hidden ${className}`} />
}
