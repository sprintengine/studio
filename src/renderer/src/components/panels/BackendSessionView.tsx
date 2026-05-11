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

  return (
    <div className="flex h-full flex-col bg-[#09090b]">
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-3 py-1.5 text-xs text-zinc-400">
        <div className="flex items-center gap-2 overflow-hidden">
          <span className="truncate font-medium text-zinc-200">{title ?? executionId}</span>
          {role && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-300">{role}</span>}
          <span
            className={
              status === 'attached'
                ? 'text-emerald-400'
                : status === 'exited'
                  ? 'text-zinc-500'
                  : status === 'error'
                    ? 'text-rose-400'
                    : 'text-amber-400'
            }
          >
            {status === 'attached' ? 'live' : status === 'connecting' ? 'connecting…' : statusDetail || status}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={copyScrollback}
            className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-200 hover:bg-zinc-800"
            title="Copy scrollback to clipboard"
          >
            Copy
          </button>
          <button
            type="button"
            onClick={() => sendSignal('INT')}
            className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
            disabled={status !== 'attached'}
            title="Send Ctrl-C (SIGINT)"
          >
            Ctrl-C
          </button>
          <button
            type="button"
            onClick={() => sendSignal('TERM')}
            className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
            disabled={status !== 'attached'}
            title="Send SIGTERM"
          >
            Stop
          </button>
          <button
            type="button"
            onClick={() => sendSignal('KILL')}
            className="rounded border border-rose-900/40 px-2 py-0.5 text-[11px] text-rose-300 hover:bg-rose-900/30 disabled:opacity-40"
            disabled={status !== 'attached'}
            title="Send SIGKILL"
          >
            Kill
          </button>
        </div>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1" />
    </div>
  )
}
