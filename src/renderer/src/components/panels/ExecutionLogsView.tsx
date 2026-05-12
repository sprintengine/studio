import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SwitchboardExecutionStream } from '../../../../shared/switchboard'
import { SWITCHBOARD_EXECUTION_LOG_DEFAULT_TAIL } from '../../../../shared/switchboard'
import { ActionStatusChip, useActionFeedback } from '../ui/ActionFeedback'

export type ExecutionLogsViewAccent = 'violet' | 'copper'

type AccentTokens = {
  dot: string
  activeBg: string
  activeText: string
  activeBorder: string
  focusRing: string
}

const ACCENT_TOKENS: Record<ExecutionLogsViewAccent, AccentTokens> = {
  violet: {
    dot: '#7c5cf2',
    activeBg: '#1a1530',
    activeText: '#efe5ff',
    activeBorder: '#3b2f63',
    focusRing: 'focus-visible:ring-[#7c5cf2]/60',
  },
  copper: {
    dot: '#d97757',
    activeBg: '#241513',
    activeText: '#ffe2d4',
    activeBorder: '#3a2820',
    focusRing: 'focus-visible:ring-[#d97757]/70',
  },
}

type FetchState =
  | { kind: 'idle' }
  | { kind: 'loading'; lines: string[] | null }
  | { kind: 'loaded'; lines: string[]; tailedAt: number; stream: SwitchboardExecutionStream }
  | { kind: 'error'; message: string; lines: string[] | null }

function lastLines(state: FetchState): string[] | null {
  if (state.kind === 'loaded') return state.lines
  if (state.kind === 'loading' || state.kind === 'error') return state.lines
  return null
}

function formatClockTime(timestamp: number): string {
  const date = new Date(timestamp)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

export function ExecutionLogsView({
  workspaceRoot,
  executionId,
  accent,
  defaultStream = 'stdout',
  tail = SWITCHBOARD_EXECUTION_LOG_DEFAULT_TAIL,
  compact = false,
}: {
  workspaceRoot: string
  executionId: string
  accent: ExecutionLogsViewAccent
  defaultStream?: SwitchboardExecutionStream
  tail?: number
  compact?: boolean
}): JSX.Element {
  const [stream, setStream] = useState<SwitchboardExecutionStream>(defaultStream)
  const [state, setState] = useState<FetchState>({ kind: 'idle' })
  const requestSeqRef = useRef(0)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const feedback = useActionFeedback()
  const feedbackRef = useRef(feedback)
  const tokens = ACCENT_TOKENS[accent]

  useEffect(() => {
    feedbackRef.current = feedback
  }, [feedback])

  const load = useCallback(
    async (nextStream: SwitchboardExecutionStream) => {
      const seq = ++requestSeqRef.current
      setState((prev) => ({ kind: 'loading', lines: lastLines(prev) }))
      const result = await window.api.getSwitchboardExecutionLogs({
        workspaceRoot,
        executionId,
        stream: nextStream,
        tail,
      })
      if (seq !== requestSeqRef.current) return
      if (result.ok) {
        setState({ kind: 'loaded', lines: result.lines, tailedAt: Date.now(), stream: result.stream })
        feedbackRef.current.dismiss('logs')
      } else {
        setState((prev) => ({ kind: 'error', message: result.message, lines: lastLines(prev) }))
        feedbackRef.current.notify('logs', 'error', result.message)
      }
    },
    [workspaceRoot, executionId, tail],
  )

  useEffect(() => {
    if (!executionId) return
    void load(stream)
  }, [executionId, stream, load])

  useEffect(() => {
    if (state.kind !== 'loaded') return
    const node = bodyRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [state])

  const lines = state.kind === 'loaded' ? state.lines : lastLines(state)
  const renderedStream = state.kind === 'loaded' ? state.stream : stream
  const isLoading = state.kind === 'loading'
  const hasEverLoaded = lines !== null
  const tailedAt = state.kind === 'loaded' ? state.tailedAt : null

  const handleRefresh = useCallback(() => {
    void load(stream)
  }, [load, stream])

  const handleCopy = useCallback(async () => {
    if (!lines || lines.length === 0) return
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      feedback.notify('logs', 'success', `Copied ${lines.length} line${lines.length === 1 ? '' : 's'}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to copy logs.'
      feedback.notify('logs', 'error', message)
    }
  }, [lines, feedback])

  const meta = useMemo(() => {
    const parts: string[] = []
    if (lines) parts.push(`${lines.length} line${lines.length === 1 ? '' : 's'}`)
    parts.push(renderedStream)
    if (tailedAt) parts.push(`tailed ${formatClockTime(tailedAt)}`)
    return parts.join(' · ')
  }, [lines, renderedStream, tailedAt])

  const bodyMaxHeight = compact ? 'max-h-[200px]' : 'max-h-[320px]'

  return (
    <div className="flex flex-col rounded border border-[#1f2025] bg-[#0a0b0e]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[#16171b] px-2.5 py-1.5">
        <span
          aria-hidden="true"
          className="inline-block h-[7px] w-[7px] shrink-0 rounded-full"
          style={{ backgroundColor: tokens.dot }}
        />
        <StreamToggle stream={stream} onChange={setStream} tokens={tokens} />
        <ActionStatusChip status={feedback.statuses['logs'] ?? null} onDismiss={() => feedback.dismiss('logs')} />
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleCopy}
            disabled={!lines || lines.length === 0}
            className={`interactive h-6 rounded border border-[#2a2b31] px-1.5 text-[10.5px] font-medium tabular-nums text-[#c8c8cf] hover:bg-[#111216] hover:text-[#ececee] focus-visible:outline-none focus-visible:ring-1 ${tokens.focusRing} disabled:opacity-40`}
            aria-label="Copy log lines"
          >
            Copy
          </button>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isLoading}
            className={`interactive inline-flex h-6 items-center gap-1 rounded border border-[#2a2b31] px-1.5 text-[10.5px] font-medium tabular-nums text-[#c8c8cf] hover:bg-[#111216] hover:text-[#ececee] focus-visible:outline-none focus-visible:ring-1 ${tokens.focusRing} disabled:opacity-50`}
            aria-label="Refresh log tail"
            aria-busy={isLoading}
          >
            <RefreshGlyph />
            <span>{isLoading ? 'Refreshing' : 'Refresh'}</span>
          </button>
        </div>
      </div>
      <div
        ref={bodyRef}
        role="log"
        aria-live="polite"
        aria-atomic="false"
        className={`overflow-auto px-2.5 py-2 font-mono text-[11.5px] leading-[1.55] ${bodyMaxHeight}`}
      >
        <LogBody
          lines={lines}
          stream={renderedStream}
          showSkeleton={!hasEverLoaded && (state.kind === 'idle' || isLoading)}
          isLoaded={state.kind === 'loaded'}
        />
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-[#16171b] px-2.5 py-1 text-[10.5px] tabular-nums text-[#6f7078]">
        <span>{meta || '—'}</span>
      </div>
    </div>
  )
}

function StreamToggle({
  stream,
  onChange,
  tokens,
}: {
  stream: SwitchboardExecutionStream
  onChange: (next: SwitchboardExecutionStream) => void
  tokens: AccentTokens
}): JSX.Element {
  return (
    <div role="tablist" aria-label="Log stream" className="flex items-center gap-1">
      <StreamButton label="stdout" active={stream === 'stdout'} onClick={() => onChange('stdout')} tokens={tokens} />
      <StreamButton label="stderr" active={stream === 'stderr'} onClick={() => onChange('stderr')} tokens={tokens} />
    </div>
  )
}

function StreamButton({
  label,
  active,
  onClick,
  tokens,
}: {
  label: string
  active: boolean
  onClick: () => void
  tokens: AccentTokens
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`interactive h-6 rounded border px-1.5 text-[10.5px] font-medium uppercase tracking-[0.06em] focus-visible:outline-none focus-visible:ring-1 ${tokens.focusRing}`}
      style={
        active
          ? {
              backgroundColor: tokens.activeBg,
              color: tokens.activeText,
              borderColor: tokens.activeBorder,
            }
          : { backgroundColor: 'transparent', color: '#8a8a92', borderColor: '#2a2b31' }
      }
    >
      {label}
    </button>
  )
}

function LogBody({
  lines,
  stream,
  showSkeleton,
  isLoaded,
}: {
  lines: string[] | null
  stream: SwitchboardExecutionStream
  showSkeleton: boolean
  isLoaded: boolean
}): JSX.Element {
  if (showSkeleton) {
    return (
      <div className="space-y-1.5" aria-label="Loading logs">
        <div className="skeleton-shimmer h-2.5 w-[78%] rounded bg-[#13141a]" />
        <div className="skeleton-shimmer h-2.5 w-[56%] rounded bg-[#13141a]" />
        <div className="skeleton-shimmer h-2.5 w-[88%] rounded bg-[#13141a]" />
        <div className="skeleton-shimmer h-2.5 w-[42%] rounded bg-[#13141a]" />
        <div className="skeleton-shimmer h-2.5 w-[70%] rounded bg-[#13141a]" />
      </div>
    )
  }
  if (lines === null) {
    return <div className="text-[#6f7078]">Logs unavailable.</div>
  }
  if (lines.length === 0) {
    return <div className="text-[#6f7078]">{isLoaded ? 'No log lines yet.' : 'Logs unavailable.'}</div>
  }
  const color = stream === 'stderr' ? '#ffb3b5' : '#d7d7dc'
  return (
    <div style={{ color }}>
      {lines.map((line, idx) => (
        <div key={`${idx}-${line.length}`} className="whitespace-pre">
          {line.length === 0 ? ' ' : line}
        </div>
      ))}
    </div>
  )
}

function RefreshGlyph(): JSX.Element {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-3.51-7.13" />
      <polyline points="21 4 21 10 15 10" />
    </svg>
  )
}
