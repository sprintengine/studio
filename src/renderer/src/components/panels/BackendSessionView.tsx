import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { createXtermOutputQueue } from '../../utils/xtermOutputQueue'

interface Props {
  workspaceRoot: string
  executionId: string
  role?: string
  title?: string
}

const CONNECT_TIMEOUT_MS = 8_000

const STATUS_TONE: Record<'connecting' | 'attached' | 'exited' | 'error', { dot: string; label: string; pulse: boolean }> = {
  connecting: { dot: '#f2c45f', label: 'text-[#f2c45f]', pulse: true },
  attached: { dot: '#f2c45f', label: 'text-[#f2c45f]', pulse: true },
  exited: { dot: '#71717a', label: 'text-[#71717a]', pulse: false },
  error: { dot: '#ff787c', label: 'text-[#ff787c]', pulse: false },
}

function base64ToBytes(b64: string): Uint8Array {
  try {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return new Uint8Array(0)
  }
}

function encodeStringToBase64(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

export default function BackendSessionView({ workspaceRoot, executionId, role, title }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const instanceKeyRef = useRef<string>(`backend-${executionId}-${crypto.randomUUID()}`)
  const [status, setStatus] = useState<'connecting' | 'attached' | 'exited' | 'error'>('connecting')
  const [statusDetail, setStatusDetail] = useState<string>('')

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const instanceKey = instanceKeyRef.current

    const term = new Terminal({
      theme: { background: '#09090b', foreground: '#e4e4e7', cursor: '#818cf8' },
      fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
    })
    termRef.current = term
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)

    const fitTerminal = (): void => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      fitAddon.fit()
    }
    fitTerminal()
    term.focus()

    const outputQueue = createXtermOutputQueue(term, { recordWrite: () => undefined })
    const utf8Decoder = new TextDecoder('utf-8', { fatal: false })

    let disposed = false

    const disposeReplay = window.api.onBackendSessionReplay(instanceKey, (payload) => {
      const text = utf8Decoder.decode(base64ToBytes(payload.data), { stream: true })
      if (text) outputQueue.enqueue(text)
    })

    const disposeData = window.api.onBackendSessionData(instanceKey, (payload) => {
      const text = utf8Decoder.decode(base64ToBytes(payload.data), { stream: true })
      if (text) outputQueue.enqueue(text)
    })

    const disposeExit = window.api.onBackendSessionExit(instanceKey, (payload) => {
      const code = payload.exitCode
      term.write(`\r\n\x1b[2m[session exited${code !== null ? ` with code ${code}` : ''}]\x1b[0m\r\n`)
      setStatus('exited')
      setStatusDetail(code !== null ? `exit ${code}` : 'ended')
    })

    const disposeError = window.api.onBackendSessionError(instanceKey, (payload) => {
      term.write(`\r\n\x1b[31m${payload.message}\x1b[0m\r\n`)
      setStatus('error')
      setStatusDetail(payload.message)
    })

    const onDataDisposable = term.onData((data) => {
      void window.api.writeBackendSession({
        workspaceRoot,
        executionId,
        data: encodeStringToBase64(data),
      })
    })

    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      void window.api.resizeBackendSession({ workspaceRoot, executionId, cols, rows })
    })

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(fitTerminal)
    })
    resizeObserver.observe(container)

    const connectTimeout = setTimeout(() => {
      if (disposed) return
      setStatus((current) => {
        if (current !== 'connecting') return current
        const message = 'Timed out waiting for backend session.'
        setStatusDetail(message)
        term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`)
        return 'error'
      })
    }, CONNECT_TIMEOUT_MS)

    void window.api
      .attachBackendSession({ workspaceRoot, executionId, instanceKey })
      .then((result) => {
        if (disposed) return
        clearTimeout(connectTimeout)
        if (!result.ok) {
          setStatus('error')
          setStatusDetail(result.message)
          term.write(`\r\n\x1b[31m${result.message}\x1b[0m\r\n`)
          return
        }
        setStatus('attached')
        void window.api.resizeBackendSession({
          workspaceRoot,
          executionId,
          cols: term.cols,
          rows: term.rows,
        })
      })
      .catch((error: unknown) => {
        if (disposed) return
        clearTimeout(connectTimeout)
        const message = error instanceof Error ? error.message : 'Failed to attach.'
        setStatus('error')
        setStatusDetail(message)
        term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`)
      })

    return () => {
      disposed = true
      clearTimeout(connectTimeout)
      disposeReplay()
      disposeData()
      disposeExit()
      disposeError()
      onDataDisposable.dispose()
      onResizeDisposable.dispose()
      resizeObserver.disconnect()
      void window.api.detachBackendSession(instanceKey)
      termRef.current = null
      term.dispose()
    }
  }, [workspaceRoot, executionId])

  const sendSignal = (signal: 'INT' | 'TERM' | 'KILL'): void => {
    void window.api.signalBackendSession({ workspaceRoot, executionId, signal })
  }

  const copyScrollback = (): void => {
    const term = termRef.current
    if (!term) return
    const selection = term.getSelection()
    let text = selection
    if (!text) {
      term.selectAll()
      text = term.getSelection()
      term.clearSelection()
    }
    if (!text) return
    void navigator.clipboard?.writeText(text).catch(() => undefined)
  }

  const tone = STATUS_TONE[status]
  const statusLabel =
    status === 'attached'
      ? 'LIVE'
      : status === 'connecting'
        ? 'CONNECTING…'
        : statusDetail
          ? statusDetail.toUpperCase()
          : status.toUpperCase()

  return (
    <div className="flex h-full flex-col bg-[#08090b]">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#1f2025] px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-2 w-2 shrink-0 items-center justify-center" aria-hidden="true">
            <span
              className={`block h-1.5 w-1.5 rounded-full ${tone.pulse ? 'status-dot-pulse' : ''}`}
              style={{ background: tone.dot }}
            />
          </span>
          <span className="truncate text-[12px] font-semibold text-[#ececee]">{title ?? executionId}</span>
          {role && (
            <span className="shrink-0 rounded border border-[#16171c] bg-[#0d0e11] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[#9a9aa2]">
              {role}
            </span>
          )}
          <span
            className={`shrink-0 text-[10px] font-semibold uppercase tracking-[0.08em] tabular-nums ${tone.label}`}
            title={statusDetail || statusLabel}
          >
            {statusLabel}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={copyScrollback}
            className="interactive rounded border border-[#2a2b31] px-2 py-0.5 text-[10.5px] font-medium text-[#d7d7dc] hover:bg-[#111216] hover:text-[#ececee] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#5c7cff]/60"
            title="Copy scrollback to clipboard"
          >
            Copy
          </button>
          <button
            type="button"
            onClick={() => sendSignal('INT')}
            className="interactive rounded border border-[#2a2b31] px-2 py-0.5 text-[10.5px] font-medium text-[#d7d7dc] hover:bg-[#111216] hover:text-[#ececee] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#5c7cff]/60 disabled:opacity-40"
            disabled={status !== 'attached'}
            title="Send Ctrl-C (SIGINT)"
          >
            Ctrl-C
          </button>
          <button
            type="button"
            onClick={() => sendSignal('TERM')}
            className="interactive rounded border border-[#3a3426] bg-[#1d1714] px-2 py-0.5 text-[10.5px] font-semibold text-[#f2c45f] hover:bg-[#241c17] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#f2c45f]/60 disabled:opacity-40"
            disabled={status !== 'attached'}
            title="Send SIGTERM"
          >
            Stop
          </button>
          <button
            type="button"
            onClick={() => sendSignal('KILL')}
            className="interactive rounded border border-[#3a2222] bg-[#1c1414] px-2 py-0.5 text-[10.5px] font-semibold text-[#ffb3b5] hover:bg-[#241818] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#ff787c]/60 disabled:opacity-40"
            disabled={status !== 'attached'}
            title="Send SIGKILL"
          >
            Kill
          </button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0" />
        {status === 'connecting' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="flex items-center gap-2 rounded border border-[#1f2025] bg-[#0d0e11]/85 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#9a9aa2]">
              <span className="block h-1.5 w-1.5 rounded-full status-dot-pulse" style={{ background: '#f2c45f' }} />
              connecting…
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
