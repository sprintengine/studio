import type { ProcessMetricsSnapshot } from '../../../../shared/electron-api'
import { formatRelativeMsAgo } from '../relativeTime'
import type { DiagnosticsAggregation, TerminalDiagnosticsWarning } from './aggregateDiagnostics'
import type { ReplayProfileEntry } from './replayProfileStore'

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

const WARNING_TOKEN: Record<TerminalDiagnosticsWarning, string> = {
  'hidden-but-visible': 'hidden-visible',
  'large-replay': 'big-replay',
  'long-idle': 'idle-6h',
  'stale': 'stale-24h',
}

function table(headers: string[], rows: string[][]): string {
  const head = `| ${headers.join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((row) => `| ${row.join(' | ')} |`).join('\n')
  return rows.length > 0 ? `${head}\n${sep}\n${body}` : `${head}\n${sep}`
}

function lastOutput(at: number | null, now: number): string {
  return formatRelativeMsAgo(at, now) || '—'
}

// Plain-markdown snapshot of the current diagnostics, built to be pasted into an
// agent: a deterministic header plus markdown tables. Pure (no DOM, no clock of
// its own) so it is unit-testable and produces identical output for identical
// inputs.
export function formatDiagnosticsReport(input: {
  aggregation: DiagnosticsAggregation
  metrics: ProcessMetricsSnapshot | null
  profiles: readonly ReplayProfileEntry[]
  now: number
}): string {
  const { aggregation, metrics, profiles, now } = input
  const totals = aggregation.totals

  const sections: string[] = []

  sections.push('# Multicode performance diagnostics')
  sections.push(
    [
      `Captured: ${new Date(now).toISOString()}`,
      `Terminals: ${totals.terminalCount} (live ${totals.liveTerminalCount}, runtime-visible ${totals.visibleTerminalCount}, hidden+visible ${totals.hiddenButVisibleCount})`,
      `Retained replay: ${formatBytes(totals.totalRetainedReplayBytes)} total, ${formatBytes(totals.largestRetainedReplayBytes)} largest`,
      `Warnings: ${totals.warningCount}`,
    ].join('\n')
  )

  sections.push('## Processes')
  if (metrics && metrics.processes.length > 0) {
    sections.push(
      table(
        ['Kind', 'PID', 'Type', 'CPU %', 'RSS'],
        metrics.processes.map((process) => [
          process.kind,
          String(process.pid),
          process.name ? `${process.type} · ${process.name}` : process.type,
          process.cpuPercent.toFixed(1),
          formatBytes(process.memoryBytes),
        ])
      )
    )
  } else {
    sections.push('Process metrics unavailable.')
  }

  sections.push('## Workspaces')
  sections.push(
    table(
      ['Workspace', 'Live', 'Visible', 'Hidden+vis', 'Active', 'Idle', 'Failed', 'Retained', 'Largest', 'Last output'],
      aggregation.workspaces.map((workspace) => [
        workspace.workspaceName ?? workspace.workspaceId,
        String(workspace.liveTerminalCount),
        String(workspace.visibleTerminalCount),
        String(workspace.hiddenButVisibleCount),
        String(workspace.activeCount),
        String(workspace.idleCount),
        String(workspace.failedCount),
        formatBytes(workspace.totalRetainedReplayBytes),
        formatBytes(workspace.largestRetainedReplayBytes),
        lastOutput(workspace.lastOutputAt, now),
      ])
    )
  )

  sections.push('## Terminals')
  sections.push(
    table(
      ['Workspace', 'Agent/Term', 'Kind', 'Alive', 'Activity', 'Visible', 'Retained', 'Limit', 'Tier', 'Last output', 'Warnings'],
      aggregation.rows.map((row) => [
        row.workspaceName ?? row.workspaceId ?? '—',
        row.agentId ?? row.terminalId ?? row.sessionId,
        row.cli ? `${row.kind}·${row.cli}` : row.kind,
        row.processAlive ? 'yes' : 'no',
        row.activity.kind,
        row.hiddenButVisible ? 'hidden' : row.visible ? 'yes' : 'no',
        formatBytes(row.retainedOutputBytes),
        row.replayLimitBytes !== null ? formatBytes(row.replayLimitBytes) : '—',
        row.historyTier ?? '—',
        lastOutput(row.lastOutputAt, now),
        row.warnings.map((warning) => WARNING_TOKEN[warning]).join(', ') || '—',
      ])
    )
  )

  sections.push('## Recent replay profiles')
  if (profiles.length > 0) {
    sections.push(
      table(
        ['When', 'Session', 'Kind', 'Payload', 'Writes', 'Total ms', 'Max write ms', 'Live buffered'],
        profiles.map((profile) => [
          lastOutput(profile.recordedAt, now) || 'now',
          profile.agentId ?? profile.terminalId ?? profile.sessionId,
          profile.kind,
          formatBytes(profile.payloadBytes),
          String(profile.writeCount),
          String(profile.totalReplayMs),
          String(profile.maxWriteMs),
          String(profile.liveBufferedCount),
        ])
      )
    )
  } else {
    sections.push('No replay profiles captured in this window.')
  }

  return `${sections.join('\n\n')}\n`
}
