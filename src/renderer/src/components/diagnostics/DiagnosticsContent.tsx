import React, { useEffect, useMemo, useState } from 'react'
import type { ProcessMetricKind, ProcessMetricsSnapshot } from '../../../../shared/electron-api'
import { Select } from '../ui/Select'
import { useTerminalSessions } from '../../hooks/useTerminalSessions'
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

export default function DiagnosticsContent({ headerActions }: Props) {
  const sessions = useTerminalSessions()
  const { workspaceNames, activeWorkspaceIds } = useWorkspaceSyncContext()

  const [metrics, setMetrics] = useState<ProcessMetricsSnapshot | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [sortKey, setSortKey] = useState<TerminalDiagnosticsSortKey>('retained')
  const [profiles, setProfiles] = useState<ReplayProfileEntry[]>(() => getReplayProfiles())
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    const poll = () => {
      setNow(Date.now())
      window.api
        .diagnosticsGetProcessMetrics()
        .then((snapshot) => {
          if (!cancelled) setMetrics(snapshot)
        })
        .catch(() => {})
    }
    poll()
    const id = window.setInterval(poll, PROCESS_METRICS_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  useEffect(() => subscribeReplayProfiles(() => setProfiles(getReplayProfiles())), [])

  const aggregation = useMemo(
    () => aggregateDiagnostics({ sessions, activeWorkspaceIds, workspaceNames, now }),
    [sessions, activeWorkspaceIds, workspaceNames, now]
  )

  const sortedRows = useMemo(
    () => sortTerminalDiagnosticsRows(aggregation.rows, sortKey),
    [aggregation.rows, sortKey]
  )

  const handleCopy = () => {
    // Snapshot `now` at copy time so the report's relative timestamps match what
    // the user saw when they clicked.
    const report = formatDiagnosticsReport({ aggregation, metrics, profiles, now: Date.now() })
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

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-3">
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
                  <Th numeric>Memory (RSS)</Th>
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
            CPU % is the rolling share since the previous sample. Thread/FD counts are not collected in this build.
          </p>
        </section>

        {/* Workspace rollups */}
        <section>
          <h2 className="mb-1 text-[11px] font-semibold text-[color:var(--text-muted)]">
            Workspaces ({aggregation.workspaces.length})
          </h2>
          {aggregation.workspaces.length > 0 ? (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Workspace</Th>
                  <Th numeric>Live</Th>
                  <Th numeric>Visible</Th>
                  <Th numeric>Hidden+vis</Th>
                  <Th numeric>Active</Th>
                  <Th numeric>Idle</Th>
                  <Th numeric>Failed</Th>
                  <Th numeric>Retained</Th>
                  <Th numeric>Largest</Th>
                  <Th numeric>Last output</Th>
                </tr>
              </thead>
              <tbody>
                {aggregation.workspaces.map((workspace) => (
                  <tr key={workspace.workspaceId} className="border-b border-[color:var(--border-subtle)]">
                    <Td title={workspace.workspaceId}>{workspace.workspaceName ?? workspace.workspaceId}</Td>
                    <Td numeric>{workspace.liveTerminalCount}</Td>
                    <Td numeric>{workspace.visibleTerminalCount}</Td>
                    <Td numeric>
                      {workspace.hiddenButVisibleCount > 0 ? (
                        <span className="text-[color:var(--tone-error)]">{workspace.hiddenButVisibleCount}</span>
                      ) : (
                        0
                      )}
                    </Td>
                    <Td numeric>{workspace.activeCount}</Td>
                    <Td numeric>{workspace.idleCount}</Td>
                    <Td numeric>{workspace.failedCount}</Td>
                    <Td numeric>{formatBytes(workspace.totalRetainedReplayBytes)}</Td>
                    <Td numeric>{formatBytes(workspace.largestRetainedReplayBytes)}</Td>
                    <Td numeric>{formatRelativeMsAgo(workspace.lastOutputAt, now) || '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-[color:var(--text-muted)]">No workspace terminals.</p>
          )}
        </section>

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
      </div>
    </div>
  )
}
