import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ProcessMetricKind, ProcessMetricsSnapshot, TerminalReapEvent, WorkspaceMemorySample } from '../../../../shared/electron-api'
import { Select } from '../ui/Select'
import { Tabs, TabPanel, type TabItem } from '../ui/Tabs'
import { getLiveTerminalSessionsSnapshot, useTerminalSessions } from '../../hooks/useTerminalSessions'
import { formatRelativeMsAgo } from '../../utils/relativeTime'
import {
  aggregateDiagnostics,
  LARGE_REPLAY_WARNING_BYTES,
  sortTerminalDiagnosticsRows,
  type TerminalDiagnosticsRow,
  type TerminalDiagnosticsSortKey,
  type TerminalDiagnosticsWarning,
} from '../../utils/diagnostics/aggregateDiagnostics'
import {
  getReplayProfiles,
  subscribeReplayProfiles,
  type ReplayProfileEntry,
} from '../../utils/diagnostics/replayProfileStore'
import { formatBytes, formatDiagnosticsReport } from '../../utils/diagnostics/formatDiagnosticsReport'
import {
  aggregatePerfEvents,
  getPerfEventSamples,
} from '../../utils/diagnostics/perfEventStore'
import {
  getLongTaskSamples,
  startLongTaskObserver,
  summarizeLongTasks,
} from '../../utils/diagnostics/longTaskStore'
import {
  getFrameSamples,
  startFrameMonitor,
  summarizeFrameStats,
} from '../../utils/diagnostics/frameStatsStore'
import { Sparkline } from './Sparkline'
import {
  appendMetricsSample,
  computeGrowthRates,
  deriveMetricsSample,
  getMetricsBaseline,
  getMetricsHistory,
  getMetricsPeaks,
  readRendererHeap,
  setMetricsBaseline,
} from '../../utils/diagnostics/metricsHistoryStore'
import { diffIpcSnapshots, type IpcThroughput } from '../../utils/diagnostics/ipcThroughputStore'
import {
  getTerminalWriteSamples,
  summarizeTerminalThroughput,
} from '../../utils/diagnostics/terminalThroughputStore'
import {
  collectScrollbackFootprint,
} from '../../utils/diagnostics/terminalInstanceRegistry'
import {
  getTimerRegistrations,
  summarizeTimers,
} from '../../utils/diagnostics/timerRegistry'
import type { IpcStatsSnapshot } from '../../../../shared/electron-api'

// Poll process metrics once a second while the panel is mounted. Both surfaces
// (overlay + standalone window) mount this only while visible, so this interval
// — and the IPC traffic — exist only while the operator is looking.
const PROCESS_METRICS_POLL_MS = 1000

type Props = {
  // Surface-specific buttons rendered in the header (e.g. Pop-out, Close). The
  // Copy button is owned here so every surface gets it.
  headerActions?: React.ReactNode
}

const PROCESS_KIND_LABEL: Record<ProcessMetricKind, string> = {
  main: 'Main',
  renderer: 'Renderer',
  gpu: 'GPU',
  utility: 'Utility',
  agent: 'Agent',
  terminal: 'Terminal',
  helper: 'Helper',
  other: 'Other',
}

const WARNING_LABEL: Record<TerminalDiagnosticsWarning, string> = {
  'hidden-but-visible': 'Hidden workspace, runtime-visible',
  'large-replay': `Replay > ${formatBytes(LARGE_REPLAY_WARNING_BYTES)}`,
  'long-idle': 'Live > 6h and idle',
  'stale': 'Not seen > 24h',
}

const WARNING_SHORT: Record<TerminalDiagnosticsWarning, string> = {
  'hidden-but-visible': 'HIDDEN-VISIBLE',
  'large-replay': 'BIG-REPLAY',
  'long-idle': 'IDLE-6H',
  'stale': 'STALE-24H',
}

const SORT_OPTIONS: { key: TerminalDiagnosticsSortKey; label: string }[] = [
  { key: 'retained', label: 'Retained replay' },
  { key: 'warnings', label: 'Warnings' },
  { key: 'activity', label: 'Activity' },
  { key: 'lastOutput', label: 'Last output' },
  { key: 'workspace', label: 'Workspace' },
]

const REAP_REASON_LABEL: Record<TerminalReapEvent['reason'], string> = {
  'idle-suspend': 'idle suspend',
  'idle-dispose': 'idle dispose',
  'stale-dispose': 'stale dispose',
}

// Coarse human duration for the idle/unseen window that triggered a reap.
function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const totalMinutes = Math.round(ms / 60_000)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
}

type SyncContext = {
  workspaceNames: Map<string, string>
  activeWorkspaceIds: Set<string>
}

const EMPTY_SYNC: SyncContext = { workspaceNames: new Map(), activeWorkspaceIds: new Set() }

function activityLabel(activity: TerminalDiagnosticsRow['activity']): string {
  switch (activity.kind) {
    case 'working':
      return 'active'
    case 'idle':
      return 'idle'
    case 'failed':
      return `failed (${activity.exitCode})`
    case 'exited':
      return `exited (${activity.exitCode})`
  }
}

function formatSignedBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  return `${bytes > 0 ? '+' : '−'}${formatBytes(Math.abs(bytes))}`
}

function formatPerMin(value: number | null): string {
  return value === null ? '—' : `${formatSignedBytes(value)}/min`
}

function msOrDash(value: number | null): string {
  return value === null ? '—' : String(Math.round(value))
}

function Th({ children, numeric }: { children: React.ReactNode; numeric?: boolean }) {
  return (
    <th
      className={`sticky top-0 z-10 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-2 py-1.5 font-medium text-[color:var(--text-muted)] ${
        numeric ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  )
}

function Td({ children, numeric, title }: { children: React.ReactNode; numeric?: boolean; title?: string }) {
  return (
    <td
      title={title}
      className={`whitespace-nowrap px-2 py-1 text-[color:var(--text-default)] ${numeric ? 'text-right tabular-nums' : 'text-left'}`}
    >
      {children}
    </td>
  )
}

function SummaryStat({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div className="flex min-w-[96px] flex-col gap-0.5">
      <span className="text-[10px] text-[color:var(--text-muted)]">{label}</span>
      <span
        className={`text-sm font-semibold tabular-nums ${
          tone === 'warn' ? 'text-[color:var(--tone-error)]' : 'text-[color:var(--text-strong)]'
        }`}
      >
        {value}
      </span>
    </div>
  )
}

// Workspace names + per-window active ids come from the workspace-sync snapshot
// (IPC-broadcast to every window) rather than the renderer zustand store, so a
// standalone diagnostics window — which never mounts WorkspaceManager — sees the
// same truth as the in-app overlay, including which workspaces are on-screen.
function useWorkspaceSyncContext(): SyncContext {
  const [context, setContext] = useState<SyncContext>(EMPTY_SYNC)

  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      window.api
        .workspaceSyncGetSnapshot()
        .then((snapshot) => {
          if (cancelled) return
          const workspaceNames = new Map<string, string>()
          for (const workspace of snapshot.state.workspaces) workspaceNames.set(workspace.id, workspace.name)
          const activeWorkspaceIds = new Set<string>()
          for (const win of snapshot.state.workspaceWindows) {
            if (win.activeWorkspaceId) activeWorkspaceIds.add(win.activeWorkspaceId)
          }
          setContext({ workspaceNames, activeWorkspaceIds })
        })
        .catch(() => {})
    }
    refresh()
    // Workspace sync events are infrequent (window/workspace lifecycle, active
    // switches); refetch the compact snapshot on each rather than diffing.
    const unsubscribe = window.api.onWorkspaceSyncEvent(() => refresh())
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return context
}

type DiagnosticTabId = 'dashboard' | 'memory' | 'rendering' | 'terminals' | 'workspaces' | 'subsystems'

const DIAGNOSTIC_TABS: TabItem<DiagnosticTabId>[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'memory', label: 'Memory' },
  { id: 'rendering', label: 'Rendering' },
  { id: 'terminals', label: 'Terminals' },
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'subsystems', label: 'Subsystems' },
]

const DIAGNOSTIC_TAB_STORAGE_KEY = 'multicode.diagnostics.activeTab'

function isDiagnosticTabId(value: string | null): value is DiagnosticTabId {
  return value !== null && DIAGNOSTIC_TABS.some((tab) => tab.id === value)
}

// One headline stat block for the Dashboard grid. `tone` flips to the error
// color so an at-risk metric reads as red without the operator parsing numbers.
function DashboardCard({
  label,
  value,
  detail,
  tone,
}: {
  label: string
  value: string
  detail?: React.ReactNode
  tone?: 'warn'
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-3 py-2">
      <span className="text-[10px] text-[color:var(--text-muted)]">{label}</span>
      <span
        className={`text-[15px] font-semibold tabular-nums ${
          tone === 'warn' ? 'text-[color:var(--tone-error)]' : 'text-[color:var(--text-strong)]'
        }`}
      >
        {value}
      </span>
      {detail ? <span className="text-[10px] tabular-nums text-[color:var(--text-muted)]">{detail}</span> : null}
    </div>
  )
}

export default function DiagnosticsContent({ headerActions }: Props) {
  // Keep lifecycle changes immediate through the semantic subscription, but do
  // not re-render Diagnostics for every high-churn live broadcast. The existing
  // one-second sample clock below reads the latest live snapshot, including the
  // retainedOutputBytes / visible / lastOutputAt fields omitted by the semantic
  // signature. Diagnostics remains current without becoming part of the hot path
  // it is trying to observe.
  useTerminalSessions()
  const sessions = getLiveTerminalSessionsSnapshot()
  const { workspaceNames, activeWorkspaceIds } = useWorkspaceSyncContext()

  const [metrics, setMetrics] = useState<ProcessMetricsSnapshot | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [sortKey, setSortKey] = useState<TerminalDiagnosticsSortKey>('retained')
  const [profiles, setProfiles] = useState<ReplayProfileEntry[]>(() => getReplayProfiles())
  const [copied, setCopied] = useState(false)
  // Bumped whenever the baseline is set/cleared so the trend memo recomputes.
  const [baselineNonce, setBaselineNonce] = useState(0)
  const [ipcThroughput, setIpcThroughput] = useState<IpcThroughput | null>(null)
  const prevIpcRef = useRef<IpcStatsSnapshot | null>(null)
  const tabsIdPrefix = useId()
  const [activeTab, setActiveTab] = useState<DiagnosticTabId>(() => {
    try {
      const stored = window.localStorage.getItem(DIAGNOSTIC_TAB_STORAGE_KEY)
      if (isDiagnosticTabId(stored)) return stored
    } catch {
      // localStorage can throw in restricted contexts; fall back to the default.
    }
    return 'dashboard'
  })
  const handleTabChange = (id: DiagnosticTabId) => {
    setActiveTab(id)
    try {
      window.localStorage.setItem(DIAGNOSTIC_TAB_STORAGE_KEY, id)
    } catch {
      // Persisting the last-active tab is best-effort.
    }
  }

  useEffect(() => {
    let cancelled = false
    const poll = () => {
      const ipcSnapshot = window.api.diagnosticsGetIpcStats?.()
      window.api
        .diagnosticsGetProcessMetrics()
        .then((snapshot) => {
          if (cancelled) return
          const sampledAt = Date.now()
          setMetrics(snapshot)
          setNow(sampledAt)
          // Feed the rolling history (with this renderer's JS heap) so the trend,
          // growth-rate, and baseline-diff all read from one append-only series.
          appendMetricsSample(deriveMetricsSample(snapshot, readRendererHeap()))
          if (ipcSnapshot) {
            setIpcThroughput(diffIpcSnapshots(prevIpcRef.current, ipcSnapshot))
            prevIpcRef.current = ipcSnapshot
          }
        })
        .catch(() => {
          if (!cancelled) setNow(Date.now())
        })
    }
    poll()
    const id = window.setInterval(poll, PROCESS_METRICS_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  // Rendering instrumentation is intentionally opt-in. Keeping a Performance
  // Observer and a continuous rAF callback alive on every Diagnostics tab makes
  // the panel perturb the workload it is measuring, especially on high-refresh
  // displays. Selecting Rendering starts both; leaving it disposes both.
  useEffect(() => {
    if (activeTab !== 'rendering') return
    return startLongTaskObserver()
  }, [activeTab])

  useEffect(() => {
    if (activeTab !== 'rendering') return
    return startFrameMonitor()
  }, [activeTab])

  useEffect(() => subscribeReplayProfiles(() => setProfiles(getReplayProfiles())), [])

  const perfRollup = useMemo(() => aggregatePerfEvents(getPerfEventSamples(), { now }), [now])
  const longTaskSummary = useMemo(() => summarizeLongTasks(getLongTaskSamples(), { now }), [now])
  const frameStats = useMemo(() => summarizeFrameStats(getFrameSamples(), { now }), [now])
  const timerRows = useMemo(() => summarizeTimers(getTimerRegistrations()), [now])
  const scrollback = useMemo(() => collectScrollbackFootprint(), [now])
  // Series for the memory-trend sparklines, drawn from the same rolling history
  // the growth slope uses. Refreshed on the 1s tick.
  const memorySparklines = useMemo(() => {
    const history = getMetricsHistory()
    return {
      rendererRss: history.map((sample) => sample.rendererRssBytes),
      gpuRss: history.map((sample) => sample.gpuRssBytes),
      heap: history.map((sample) => sample.rendererHeapUsedBytes ?? 0),
    }
  }, [now])
  // Recent raw frame durations (ms) for the frames sparkline — spikes = stutter.
  const frameDurations = useMemo(() => getFrameSamples().map((sample) => sample.durationMs), [now])
  const metricsTrend = useMemo(() => {
    const history = getMetricsHistory()
    return {
      current: history.length > 0 ? history[history.length - 1] : null,
      baseline: getMetricsBaseline(),
      growth: computeGrowthRates(history, { now }),
      peaks: getMetricsPeaks(),
    }
    // baselineNonce participates so a baseline set/clear refreshes the diff.
  }, [now, baselineNonce])

  const handleToggleBaseline = () => {
    setMetricsBaseline(getMetricsBaseline() ? null : metricsTrend.current)
    setBaselineNonce((value) => value + 1)
  }

  const aggregation = useMemo(
    () => aggregateDiagnostics({ sessions, activeWorkspaceIds, workspaceNames, now }),
    [sessions, activeWorkspaceIds, workspaceNames, now]
  )

  // Real per-workspace process RSS, attributed in main from the pty subtrees.
  // Joined into the Workspaces tab by id; absent until the first sample lands.
  const workspaceMemoryById = useMemo(() => {
    const map = new Map<string, WorkspaceMemorySample>()
    for (const sample of metrics?.workspaceMemory ?? []) map.set(sample.workspaceId, sample)
    return map
  }, [metrics])

  // Workspaces ordered by real resident memory (heaviest first) — the triage
  // axis for "what's costing me RAM". Falls back to the aggregation's own order
  // (retained replay) before the first memory sample arrives.
  const workspacesByMemory = useMemo(() => {
    return [...aggregation.workspaces].sort(
      (a, b) =>
        (workspaceMemoryById.get(b.workspaceId)?.totalMemoryBytes ?? 0) -
        (workspaceMemoryById.get(a.workspaceId)?.totalMemoryBytes ?? 0)
    )
  }, [aggregation.workspaces, workspaceMemoryById])

  const sortedRows = useMemo(
    () => sortTerminalDiagnosticsRows(aggregation.rows, sortKey),
    [aggregation.rows, sortKey]
  )

  // Terminals that are runtime-visible while their workspace is off-screen — the
  // set whose write throughput is "wasted" rendering work.
  const terminalThroughput = useMemo(() => {
    const hiddenSessionIds = new Set(
      aggregation.rows.filter((row) => row.hiddenButVisible).map((row) => row.sessionId)
    )
    return summarizeTerminalThroughput(getTerminalWriteSamples(), { hiddenSessionIds, now })
  }, [aggregation.rows, now])

  const handleCopy = () => {
    // Snapshot `now` at copy time so the report's relative timestamps match what
    // the user saw when they clicked.
    const report = formatDiagnosticsReport({
      aggregation,
      metrics,
      profiles,
      perfEvents: perfRollup,
      longTasks: longTaskSummary,
      frameStats,
      metricsTrend,
      ipc: ipcThroughput,
      terminalThroughput,
      scrollback,
      timers: timerRows,
      now: Date.now(),
    })
    void window.api
      .clipboardWriteText(report)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      })
      .catch((error) => {
        console.error('[Diagnostics] Failed to copy report to clipboard:', error)
      })
  }

  const totals = aggregation.totals

  return (
    <div className="flex h-full flex-col overflow-hidden font-mono text-[12px]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[color:var(--border-default)] px-4 py-2.5">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-[color:var(--text-strong)]">Performance Diagnostics</span>
          <span className="text-[10px] text-[color:var(--text-muted)]">dev · polling {PROCESS_METRICS_POLL_MS}ms</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleToggleBaseline}
            className="rounded px-2 py-1 text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--border-strong)]"
            aria-label={metricsTrend.baseline ? 'Clear memory baseline' : 'Mark current metrics as baseline'}
          >
            {metricsTrend.baseline ? 'Clear baseline' : 'Mark baseline'}
          </button>
          <button
            onClick={handleCopy}
            className="rounded px-2 py-1 text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--border-strong)]"
            aria-label="Copy diagnostics report to clipboard"
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
          {headerActions}
        </div>
      </div>

      {/* Global summary */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-4 py-2">
        <SummaryStat label="Terminals" value={String(totals.terminalCount)} />
        <SummaryStat label="Live" value={String(totals.liveTerminalCount)} />
        <SummaryStat label="Runtime-visible" value={String(totals.visibleTerminalCount)} />
        <SummaryStat
          label="Hidden+visible"
          value={String(totals.hiddenButVisibleCount)}
          tone={totals.hiddenButVisibleCount > 0 ? 'warn' : undefined}
        />
        <SummaryStat label="Retained replay" value={formatBytes(totals.totalRetainedReplayBytes)} />
        <SummaryStat label="Largest replay" value={formatBytes(totals.largestRetainedReplayBytes)} />
        <SummaryStat
          label="Warnings"
          value={String(totals.warningCount)}
          tone={totals.warningCount > 0 ? 'warn' : undefined}
        />
      </div>

      <Tabs
        ariaLabel="Diagnostics sections"
        items={DIAGNOSTIC_TABS}
        value={activeTab}
        onChange={handleTabChange}
        idPrefix={tabsIdPrefix}
        className="shrink-0 px-4"
      />

      <div className="flex flex-1 flex-col overflow-y-auto px-4 py-3">
        {/* Dashboard — headline health at a glance */}
        <TabPanel
          idPrefix={tabsIdPrefix}
          tabId="dashboard"
          active={activeTab === 'dashboard'}
          className="flex flex-col gap-3"
        >
          {metricsTrend.current ? (
            (() => {
              const c = metricsTrend.current
              const sys = c.systemMemory
              const peaks = metricsTrend.peaks
              const growth = metricsTrend.growth
              const cpu = Math.round((c.rendererCpuPercent + c.mainCpuPercent) * 10) / 10
              return (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  <DashboardCard
                    label="Estimated memory utilization"
                    value={sys ? `${Math.round(sys.utilizationRatio * 100)}%` : '—'}
                    detail={sys ? `${formatBytes(sys.usedBytes)} estimated non-reclaimable` : 'sampling…'}
                  />
                  <DashboardCard
                    label="Reported process memory"
                    value={formatBytes(c.totalRssBytes)}
                    detail={`renderer ${formatBytes(c.rendererRssBytes)} · main ${formatBytes(c.mainRssBytes)} · children ${formatBytes(c.childRssBytes)}`}
                  />
                  <DashboardCard
                    label="Growth (RSS)"
                    value={formatPerMin(growth.rssBytesPerMin)}
                    tone={(growth.rssBytesPerMin ?? 0) > 0 ? 'warn' : undefined}
                    detail={`over ${Math.round(growth.windowMs / 1000)}s · ${growth.sampleCount} samples`}
                  />
                  <DashboardCard
                    label="Peak this session"
                    value={peaks && peaks.totalRssBytes > 0 ? formatBytes(peaks.totalRssBytes) : '—'}
                    detail={
                      peaks && peaks.systemUtilizationRatio !== null
                        ? `estimated utilization ${Math.round(peaks.systemUtilizationRatio * 100)}%`
                        : peaks && peaks.totalRssAt
                          ? formatRelativeMsAgo(peaks.totalRssAt, now) || 'just now'
                          : undefined
                    }
                  />
                  <DashboardCard
                    label="CPU"
                    value={`${cpu}%`}
                    detail={`renderer ${c.rendererCpuPercent}% · main ${c.mainCpuPercent}%`}
                  />
                  <DashboardCard
                    label="Rendering"
                    value={frameStats.fps !== null ? `${frameStats.fps} fps last` : 'paused'}
                    detail="open Rendering tab to sample"
                  />
                  <DashboardCard
                    label="Main-thread stalls"
                    value={longTaskSummary.count > 0 ? `${longTaskSummary.count} last` : 'paused'}
                    detail="open Rendering tab to observe"
                  />
                  <DashboardCard
                    label="Terminals"
                    value={`${totals.liveTerminalCount} live`}
                    tone={totals.hiddenButVisibleCount > 0 ? 'warn' : undefined}
                    detail={`${totals.visibleTerminalCount} visible · ${totals.hiddenButVisibleCount} hidden+visible`}
                  />
                  <DashboardCard
                    label="Warnings"
                    value={String(totals.warningCount)}
                    tone={totals.warningCount > 0 ? 'warn' : undefined}
                    detail={totals.warningCount > 0 ? 'see Terminals tab' : 'none'}
                  />
                </div>
              )
            })()
          ) : (
            <p className="text-[color:var(--text-muted)]">Collecting samples…</p>
          )}
        </TabPanel>

        {/* Memory */}
        <TabPanel
          idPrefix={tabsIdPrefix}
          tabId="memory"
          active={activeTab === 'memory'}
          className="flex flex-col gap-4"
        >
        {/* Process metrics */}
        <section>
          <h2 className="mb-1 text-[11px] font-semibold text-[color:var(--text-muted)]">Processes</h2>
          {metrics && metrics.processes.length > 0 ? (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Kind</Th>
                  <Th numeric>PID</Th>
                  <Th>Type / name</Th>
                  <Th numeric>CPU %</Th>
                  <Th numeric>Reported memory</Th>
                  <Th numeric>Threads</Th>
                  <Th numeric>FDs</Th>
                </tr>
              </thead>
              <tbody>
                {metrics.processes.map((process) => (
                  <tr key={process.pid} className="border-b border-[color:var(--border-subtle)]">
                    <Td>{PROCESS_KIND_LABEL[process.kind]}</Td>
                    <Td numeric>{process.pid}</Td>
                    <Td title={process.name}>{process.name ? `${process.type} · ${process.name}` : process.type}</Td>
                    <Td numeric>{process.cpuPercent.toFixed(1)}</Td>
                    <Td numeric>{formatBytes(process.memoryBytes)}</Td>
                    <Td numeric>{process.threads ?? '—'}</Td>
                    <Td numeric>{process.fileDescriptors ?? '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-[color:var(--text-muted)]">Process metrics unavailable.</p>
          )}
          <p className="mt-1 text-[10px] text-[color:var(--text-subtle)]">
            Electron rows use Electron working set; child rows use OS RSS. Their sum is reported process memory,
            not macOS physical footprint or pressure attribution. Activity Monitor Memory can differ, especially
            for GPU-owned IOSurfaces. CPU % is the rolling share since the previous sample. Thread counts are
            sampled from the OS off the poll path (refreshed every few seconds); FD counts are not collected.
          </p>
        </section>

        {/* Memory trend + baseline diff */}
        <section>
          <h2 className="mb-1 text-[11px] font-semibold text-[color:var(--text-muted)]">Memory trend</h2>
          {metricsTrend.current ? (
            <div className="flex flex-col gap-1 text-[11px] text-[color:var(--text-default)]">
              <div className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
                <span>Reported process memory <strong>{formatBytes(metricsTrend.current.totalRssBytes)}</strong></span>
                <span>renderer {formatBytes(metricsTrend.current.rendererRssBytes)}</span>
                <span>main {formatBytes(metricsTrend.current.mainRssBytes)}</span>
                <span>gpu {formatBytes(metricsTrend.current.gpuRssBytes)}</span>
                <span>children {formatBytes(metricsTrend.current.childRssBytes)}</span>
                {metricsTrend.current.rendererHeapUsedBytes !== null && (
                  <span>renderer JS heap {formatBytes(metricsTrend.current.rendererHeapUsedBytes)}</span>
                )}
              </div>
              {metricsTrend.current.systemMemory && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
                  <span>
                    Estimated system utilization{' '}
                    <strong>
                      {Math.round(metricsTrend.current.systemMemory.utilizationRatio * 100)}%
                    </strong>{' '}
                    (
                      {formatBytes(metricsTrend.current.systemMemory.usedBytes)} /{' '}
                      {formatBytes(metricsTrend.current.systemMemory.totalBytes)}
                    {' '}estimated non-reclaimable)
                  </span>
                  <span>estimated available {formatBytes(metricsTrend.current.systemMemory.availableBytes)}</span>
                  {metricsTrend.current.systemMemory.compressedBytes > 0 && (
                    <span>compressed {formatBytes(metricsTrend.current.systemMemory.compressedBytes)}</span>
                  )}
                  {metricsTrend.current.systemMemory.swapUsedBytes > 0 && (
                    <span>swap {formatBytes(metricsTrend.current.systemMemory.swapUsedBytes)}</span>
                  )}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-[color:var(--text-subtle)]">
                <span className="flex items-center gap-1 text-[color:var(--text-muted)]">
                  renderer
                  <Sparkline values={memorySparklines.rendererRss} title="Renderer RSS over recent samples" />
                </span>
                <span className="flex items-center gap-1 text-[color:var(--text-muted)]">
                  gpu
                  <Sparkline values={memorySparklines.gpuRss} title="GPU RSS over recent samples" />
                </span>
                {metricsTrend.current.rendererHeapUsedBytes !== null && (
                  <span className="flex items-center gap-1 text-[color:var(--text-muted)]">
                    heap
                    <Sparkline values={memorySparklines.heap} title="Renderer JS heap over recent samples" />
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums text-[color:var(--text-muted)]">
                <span>
                  Growth ({Math.round(metricsTrend.growth.windowMs / 1000)}s): RSS{' '}
                  <span className={(metricsTrend.growth.rssBytesPerMin ?? 0) > 0 ? 'text-[color:var(--tone-error)]' : ''}>
                    {formatPerMin(metricsTrend.growth.rssBytesPerMin)}
                  </span>
                </span>
                <span>heap {formatPerMin(metricsTrend.growth.heapBytesPerMin)}</span>
                <span className="text-[color:var(--text-subtle)]">{metricsTrend.growth.sampleCount} samples</span>
              </div>
              {metricsTrend.peaks && metricsTrend.peaks.totalRssBytes > 0 && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums text-[color:var(--text-muted)]">
                  <span>Peak this session: reported memory {formatBytes(metricsTrend.peaks.totalRssBytes)}</span>
                  <span>children {formatBytes(metricsTrend.peaks.childRssBytes)}</span>
                  {metricsTrend.peaks.systemUtilizationRatio !== null && (
                    <span>
                      estimated utilization {Math.round(metricsTrend.peaks.systemUtilizationRatio * 100)}%
                    </span>
                  )}
                </div>
              )}
              {metricsTrend.baseline && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums text-[color:var(--text-strong)]">
                  {(() => {
                    const b = metricsTrend.baseline
                    const c = metricsTrend.current
                    const dTotal = c.totalRssBytes - b.totalRssBytes
                    const dRenderer = c.rendererRssBytes - b.rendererRssBytes
                    const dHeap =
                      c.rendererHeapUsedBytes !== null && b.rendererHeapUsedBytes !== null
                        ? c.rendererHeapUsedBytes - b.rendererHeapUsedBytes
                        : null
                    return (
                      <>
                        <span>vs baseline ({formatRelativeMsAgo(b.sampledAt, now) || 'just now'}):</span>
                        <span>Δ total {formatSignedBytes(dTotal)}</span>
                        <span>Δ renderer {formatSignedBytes(dRenderer)}</span>
                        <span>Δ heap {dHeap === null ? '—' : formatSignedBytes(dHeap)}</span>
                      </>
                    )
                  })()}
                </div>
              )}
            </div>
          ) : (
            <p className="text-[color:var(--text-muted)]">Collecting samples…</p>
          )}
        </section>

        </TabPanel>

        {/* Rendering */}
        <TabPanel
          idPrefix={tabsIdPrefix}
          tabId="rendering"
          active={activeTab === 'rendering'}
          className="flex flex-col gap-4"
        >
        {/* Long tasks */}
        <section>
          <h2 className="mb-1 text-[11px] font-semibold text-[color:var(--text-muted)]">
            Long tasks (main-thread stalls &gt; 50ms, last {Math.round(longTaskSummary.windowMs / 1000)}s)
          </h2>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-[11px] tabular-nums text-[color:var(--text-default)]">
            <span className={longTaskSummary.count > 0 ? 'text-[color:var(--tone-error)]' : ''}>
              Count <strong>{longTaskSummary.count}</strong>
            </span>
            <span>Blocking {longTaskSummary.totalBlockingMs} ms</span>
            <span>Max {msOrDash(longTaskSummary.maxMs)} ms</span>
            <span>p95 {msOrDash(longTaskSummary.p95Ms)} ms</span>
            <span className="text-[color:var(--text-subtle)]">
              {longTaskSummary.lastAt ? `last ${formatRelativeMsAgo(longTaskSummary.lastAt, now)}` : 'none'}
            </span>
          </div>
        </section>

        {/* Frame cadence (rAF) — per-frame jank the longtask observer misses */}
        <section>
          <h2 className="mb-1 text-[11px] font-semibold text-[color:var(--text-muted)]">
            Rendering cadence (frames, last {Math.round(frameStats.windowMs / 1000)}s)
          </h2>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[11px] tabular-nums text-[color:var(--text-default)]">
            <span className={frameStats.fps !== null && frameStats.fps < 50 ? 'text-[color:var(--tone-error)]' : ''}>
              FPS <strong>{frameStats.fps ?? '—'}</strong>
            </span>
            <span className={frameStats.longFrameCount > 0 ? 'text-[color:var(--tone-error)]' : ''}>
              Long frames {frameStats.longFrameCount} ({frameStats.longFramePercent}%)
            </span>
            <span>p95 {msOrDash(frameStats.p95Ms)} ms</span>
            <span>worst {msOrDash(frameStats.maxMs)} ms</span>
            <span className="text-[color:var(--text-subtle)]">{frameStats.frameCount} frames</span>
            <span className="text-[color:var(--text-muted)]">
              <Sparkline values={frameDurations} title="Frame durations (ms) — spikes are stutters" />
            </span>
          </div>
          <p className="mt-0.5 text-[10px] text-[color:var(--text-subtle)]">
            Catches per-frame jank (style/layout/compositing) that no single &gt;50ms task shows. Main-thread
            cadence — pure GPU draw stalls can read low here; confirm those in DevTools.
          </p>
        </section>

        {/* Perf events rollup */}
        <section>
          <h2 className="mb-1 text-[11px] font-semibold text-[color:var(--text-muted)]">
            Perf events ({perfRollup.length})
          </h2>
          {perfRollup.length > 0 ? (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Scope</Th>
                  <Th>Event</Th>
                  <Th numeric>Count</Th>
                  <Th numeric>p50 ms</Th>
                  <Th numeric>p95 ms</Th>
                  <Th numeric>Max ms</Th>
                  <Th numeric>Last ms</Th>
                </tr>
              </thead>
              <tbody>
                {perfRollup.map((row) => (
                  <tr key={`${row.scope}-${row.event}`} className="border-b border-[color:var(--border-subtle)]">
                    <Td>{row.scope}</Td>
                    <Td>{row.event}</Td>
                    <Td numeric>{row.count}</Td>
                    <Td numeric>{msOrDash(row.p50Ms)}</Td>
                    <Td numeric>{msOrDash(row.p95Ms)}</Td>
                    <Td numeric>{msOrDash(row.maxMs)}</Td>
                    <Td numeric>{msOrDash(row.lastMs)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-[color:var(--text-muted)]">
              No perf events captured yet. They accrue as SprintEngine refresh/auto-run and other instrumented paths run.
            </p>
          )}
        </section>

        </TabPanel>

        {/* Terminals */}
        <TabPanel
          idPrefix={tabsIdPrefix}
          tabId="terminals"
          active={activeTab === 'terminals'}
          className="flex flex-col gap-4"
        >

        {/* Terminal table */}
        <section>
          <div className="mb-1 flex items-center justify-between">
            <h2 className="text-[11px] font-semibold text-[color:var(--text-muted)]">
              Terminals ({aggregation.rows.length})
            </h2>
            <div className="flex items-center gap-1.5 text-[10px] text-[color:var(--text-muted)]">
              <span>Sort</span>
              <Select<TerminalDiagnosticsSortKey>
                ariaLabel="Sort terminals by"
                items={SORT_OPTIONS.map((option) => ({ value: option.key, label: option.label }))}
                value={sortKey}
                onChange={setSortKey}
              />
            </div>
          </div>
          {sortedRows.length > 0 ? (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Workspace</Th>
                  <Th>Agent / term</Th>
                  <Th>Kind</Th>
                  <Th>Alive</Th>
                  <Th>Activity</Th>
                  <Th>Vis</Th>
                  <Th numeric>Retained</Th>
                  <Th numeric>Limit</Th>
                  <Th>Tier</Th>
                  <Th numeric>Last output</Th>
                  <Th>Warnings</Th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row) => (
                  <tr
                    key={row.sessionId}
                    className={`border-b border-[color:var(--border-subtle)] ${
                      row.warnings.length > 0 ? 'bg-[color:var(--tone-error-soft)]' : ''
                    }`}
                  >
                    <Td title={row.workspaceId ?? undefined}>{row.workspaceName ?? row.workspaceId ?? '—'}</Td>
                    <Td title={row.sessionId}>{row.agentId ?? row.terminalId ?? row.sessionId}</Td>
                    <Td>{row.cli ? `${row.kind}·${row.cli}` : row.kind}</Td>
                    <Td>{row.processAlive ? 'yes' : 'no'}</Td>
                    <Td>{activityLabel(row.activity)}</Td>
                    <Td>
                      {row.hiddenButVisible ? (
                        <span className="text-[color:var(--tone-error)]" title="Runtime-visible but workspace is hidden">
                          hidden
                        </span>
                      ) : row.visible ? (
                        'yes'
                      ) : (
                        'no'
                      )}
                    </Td>
                    <Td numeric>{formatBytes(row.retainedOutputBytes)}</Td>
                    <Td numeric>{row.replayLimitBytes !== null ? formatBytes(row.replayLimitBytes) : '—'}</Td>
                    <Td>{row.historyTier ?? '—'}</Td>
                    <Td numeric>{formatRelativeMsAgo(row.lastOutputAt, now) || '—'}</Td>
                    <Td>
                      {row.warnings.length > 0 ? (
                        <span className="flex flex-wrap gap-1">
                          {row.warnings.map((warning) => (
                            <span
                              key={warning}
                              title={WARNING_LABEL[warning]}
                              className="rounded bg-[color:var(--tone-error-soft)] px-1 text-[10px] text-[color:var(--tone-error)]"
                            >
                              {WARNING_SHORT[warning]}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="text-[color:var(--text-subtle)]">—</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-[color:var(--text-muted)]">No terminal sessions.</p>
          )}
        </section>

        {/* Reaped terminals — audit trail of what the main-process reaper
            suspended/disposed this session, and from which workspace. */}
        <section>
          <h2 className="mb-1 text-[11px] font-semibold text-[color:var(--text-muted)]">
            Reaped terminals ({metrics?.reapEvents?.length ?? 0})
          </h2>
          <p className="mb-2 text-[10px] text-[color:var(--text-subtle)]">
            Idle agents the reaper suspended (outside the hot set, past the idle threshold) or the 24h
            stale backstop disposed. Most recent first; bounded ring buffer, cleared on app restart. A
            reaped agent keeps its resume flags and relaunches with --resume on reopen.
          </p>
          {metrics?.reapEvents && metrics.reapEvents.length > 0 ? (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th numeric>Reaped</Th>
                  <Th>Workspace</Th>
                  <Th>Agent / term</Th>
                  <Th>Kind</Th>
                  <Th>Reason</Th>
                  <Th numeric>Idle / unseen</Th>
                </tr>
              </thead>
              <tbody>
                {metrics.reapEvents.map((event: TerminalReapEvent) => (
                  <tr
                    key={`${event.sessionId}-${event.reapedAt}`}
                    className="border-b border-[color:var(--border-subtle)]"
                  >
                    <Td numeric>{formatRelativeMsAgo(event.reapedAt, now) || 'just now'}</Td>
                    <Td title={event.workspaceId ?? undefined}>
                      {(event.workspaceId ? workspaceNames.get(event.workspaceId) : null) ??
                        event.workspaceId ??
                        '—'}
                    </Td>
                    <Td title={event.sessionId}>{event.agentId ?? event.terminalId ?? event.sessionId}</Td>
                    <Td>{event.cli ? `${event.kind}·${event.cli}` : event.kind}</Td>
                    <Td>{REAP_REASON_LABEL[event.reason]}</Td>
                    <Td numeric>
                      {event.idleMs !== undefined
                        ? formatDurationMs(event.idleMs)
                        : event.unseenMs !== undefined
                          ? formatDurationMs(event.unseenMs)
                          : '—'}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-[color:var(--text-muted)]">Nothing reaped yet this session.</p>
          )}
        </section>

        </TabPanel>

        {/* Workspaces — per-workspace resident memory + terminal rollup */}
        <TabPanel
          idPrefix={tabsIdPrefix}
          tabId="workspaces"
          active={activeTab === 'workspaces'}
          className="flex flex-col gap-4"
        >
        <section>
          <h2 className="mb-1 text-[11px] font-semibold text-[color:var(--text-muted)]">
            Workspaces ({workspacesByMemory.length})
          </h2>
          <p className="mb-2 text-[10px] text-[color:var(--text-subtle)]">
            Memory is the real RSS of each workspace's agent/terminal subtrees (the CLI plus its MCP/dev-server
            children), summed in the main process. Shared app overhead (main, renderer, GPU) is not attributed here,
            so these sum to less than the app total. &quot;Live for&quot; is since the oldest live terminal started.
          </p>
          {workspacesByMemory.length > 0 ? (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Workspace</Th>
                  <Th numeric>Memory</Th>
                  <Th numeric>Live</Th>
                  <Th numeric>Active</Th>
                  <Th numeric>Idle</Th>
                  <Th numeric>Hidden+vis</Th>
                  <Th numeric>Retained</Th>
                  <Th numeric>Live for</Th>
                  <Th numeric>Last output</Th>
                </tr>
              </thead>
              <tbody>
                {workspacesByMemory.map((workspace) => {
                  const mem = workspaceMemoryById.get(workspace.workspaceId)
                  return (
                    <tr key={workspace.workspaceId} className="border-b border-[color:var(--border-subtle)]">
                      <Td title={workspace.workspaceId}>
                        {mem?.resident ? <span aria-hidden="true">● </span> : null}
                        {workspace.workspaceName ?? workspace.workspaceId}
                      </Td>
                      <Td numeric>{mem ? formatBytes(mem.totalMemoryBytes) : '—'}</Td>
                      <Td numeric>{workspace.liveTerminalCount}</Td>
                      <Td numeric>{workspace.activeCount}</Td>
                      <Td numeric>{workspace.idleCount}</Td>
                      <Td numeric>
                        {workspace.hiddenButVisibleCount > 0 ? (
                          <span className="text-[color:var(--tone-error)]">{workspace.hiddenButVisibleCount}</span>
                        ) : (
                          0
                        )}
                      </Td>
                      <Td numeric>{formatBytes(workspace.totalRetainedReplayBytes)}</Td>
                      <Td numeric>{mem?.becameLiveAt ? formatRelativeMsAgo(mem.becameLiveAt, now) || '—' : '—'}</Td>
                      <Td numeric>{formatRelativeMsAgo(workspace.lastOutputAt, now) || '—'}</Td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : (
            <p className="text-[color:var(--text-muted)]">No workspace terminals.</p>
          )}
        </section>

        </TabPanel>

        {/* Subsystems */}
        <TabPanel
          idPrefix={tabsIdPrefix}
          tabId="subsystems"
          active={activeTab === 'subsystems'}
          className="flex flex-col gap-4"
        >
        {/* Active timers / supervisors */}
        <section>
          <h2 className="mb-1 text-[11px] font-semibold text-[color:var(--text-muted)]">
            Active timers / supervisors ({timerRows.length})
          </h2>
          {timerRows.length > 0 ? (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Label</Th>
                  <Th numeric>Cadence ms</Th>
                  <Th numeric>Ticks</Th>
                  <Th numeric>Avg ms</Th>
                  <Th numeric>Max ms</Th>
                  <Th numeric>Last tick</Th>
                </tr>
              </thead>
              <tbody>
                {timerRows.map((row) => (
                  <tr key={row.label} className="border-b border-[color:var(--border-subtle)]">
                    <Td>{row.label}</Td>
                    <Td numeric>{row.cadenceMs}</Td>
                    <Td numeric>{row.tickCount}</Td>
                    <Td numeric>{msOrDash(row.avgMs)}</Td>
                    <Td numeric>{msOrDash(row.maxMs)}</Td>
                    <Td numeric>{formatRelativeMsAgo(row.lastTickAt, now) || '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-[color:var(--text-muted)]">No registered recurring timers.</p>
          )}
        </section>

        {/* Terminal scrollback + write throughput */}
        <section>
          <h2 className="mb-1 text-[11px] font-semibold text-[color:var(--text-muted)]">Terminal subsystem</h2>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-[11px] tabular-nums text-[color:var(--text-default)]">
            <span>
              Scrollback: <strong>{scrollback.instanceCount}</strong> instances ·{' '}
              {scrollback.totalLines.toLocaleString()} lines · ~{formatBytes(scrollback.estimatedBytes)} est.
            </span>
            <span>Write total {formatBytes(terminalThroughput.totalBytesPerSec)}/s</span>
            <span className={terminalThroughput.hiddenBytesPerSec > 0 ? 'text-[color:var(--tone-error)]' : ''}>
              hidden {formatBytes(terminalThroughput.hiddenBytesPerSec)}/s
            </span>
            <span>visible {formatBytes(terminalThroughput.visibleBytesPerSec)}/s</span>
          </div>
        </section>

        {/* IPC throughput */}
        <section>
          <h2 className="mb-1 text-[11px] font-semibold text-[color:var(--text-muted)]">
            IPC throughput {ipcThroughput ? `(${ipcThroughput.channels.length} channels)` : ''}
          </h2>
          {ipcThroughput && ipcThroughput.channels.length > 0 ? (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Channel</Th>
                  <Th numeric>Calls/s</Th>
                  <Th numeric>Out/s</Th>
                  <Th numeric>Events/s</Th>
                  <Th numeric>In/s</Th>
                  <Th numeric>Total calls</Th>
                </tr>
              </thead>
              <tbody>
                {ipcThroughput.channels.slice(0, 12).map((channel) => (
                  <tr key={channel.name} className="border-b border-[color:var(--border-subtle)]">
                    <Td title={channel.name}>{channel.name}</Td>
                    <Td numeric>{channel.callsPerSec}</Td>
                    <Td numeric>{formatBytes(channel.outBytesPerSec)}</Td>
                    <Td numeric>{channel.inEventsPerSec}</Td>
                    <Td numeric>{formatBytes(channel.inBytesPerSec)}</Td>
                    <Td numeric>{channel.totalCalls}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-[color:var(--text-muted)]">
              IPC accounting is active only when diagnostics is enabled (dev or MULTICODE_DIAGNOSTICS=1).
            </p>
          )}
        </section>

        {/* Replay profiles */}
        <section>
          <h2 className="mb-1 text-[11px] font-semibold text-[color:var(--text-muted)]">
            Recent replay profiles ({profiles.length})
          </h2>
          {profiles.length > 0 ? (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Session</Th>
                  <Th>Kind</Th>
                  <Th numeric>Payload</Th>
                  <Th numeric>Writes</Th>
                  <Th numeric>Total ms</Th>
                  <Th numeric>Max write ms</Th>
                  <Th numeric>Live buffered</Th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((profile, index) => (
                  <tr
                    key={`${profile.sessionId}-${profile.recordedAt}-${index}`}
                    className="border-b border-[color:var(--border-subtle)]"
                  >
                    <Td numeric>{formatRelativeMsAgo(profile.recordedAt, now) || 'now'}</Td>
                    <Td title={profile.sessionId}>{profile.agentId ?? profile.terminalId ?? profile.sessionId}</Td>
                    <Td>{profile.kind}</Td>
                    <Td numeric>{formatBytes(profile.payloadBytes)}</Td>
                    <Td numeric>{profile.writeCount}</Td>
                    <Td numeric>{profile.totalReplayMs}</Td>
                    <Td numeric>{profile.maxWriteMs}</Td>
                    <Td numeric>{profile.liveBufferedCount}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-[color:var(--text-muted)]">
              No replay profiles captured in this window. Profiles are recorded in the window that owns the terminals
              (reattach a terminal there to record one).
            </p>
          )}
        </section>
        </TabPanel>
      </div>
    </div>
  )
}
