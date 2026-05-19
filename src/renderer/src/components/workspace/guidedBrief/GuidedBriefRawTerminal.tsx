import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { bindTerminalClipboardHandlers } from '../../../utils/terminalClipboard'
import { createXtermOutputQueue } from '../../../utils/xtermOutputQueue'

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
      // design-tokens-allow: xterm-256 host palette — same exemption as TerminalView/PlainTerminalPanel
      theme: {
        background: '#09090b', // design-tokens-allow: xterm host palette
        foreground: '#e4e4e7', // design-tokens-allow: xterm host palette
        cursor: '#818cf8', // design-tokens-allow: xterm host palette
      },
      fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
    })
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
    const resizeObserver = new ResizeObserver(() => requestAnimationFrame(fitTerminal))

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
      outputQueue.dispose()
      terminal.dispose()
    }
  }, [sessionId])

  return <div ref={containerRef} tabIndex={0} className={`h-full min-h-0 cursor-text overflow-hidden ${className}`} />
}
