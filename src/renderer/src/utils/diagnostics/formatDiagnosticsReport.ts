import type { ProcessMetricsSnapshot } from '../../../../shared/electron-api'
import { formatRelativeMsAgo } from '../relativeTime'
import type { DiagnosticsAggregation, TerminalDiagnosticsWarning } from './aggregateDiagnostics'
import type { ReplayProfileEntry } from './replayProfileStore'
import type { PerfEventRollupRow } from './perfEventStore'
import type { LongTaskSummary } from './longTaskStore'
import type { FrameStatsSummary } from './frameStatsStore'
import { diffMetricsSamples, type GrowthRates, type MetricsSample } from './metricsHistoryStore'
import type { IpcThroughput } from './ipcThroughputStore'
import type { TerminalThroughput } from './terminalThroughputStore'
import type { ScrollbackFootprint } from './terminalInstanceRegistry'
import type { TimerRegistrationRow } from './timerRegistry'

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

function msOrDash(value: number | null): string {
  return value === null ? '—' : String(Math.round(value))
}

// Signed binary-unit delta, e.g. "+1.2 MiB" / "−300 KiB" / "0 B".
function signedBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  return `${bytes > 0 ? '+' : '−'}${formatBytes(Math.abs(bytes))}`
}

function bytesPerMin(value: number | null): string {
  return value === null ? '—' : `${signedBytes(value)}/min`
}

// Plain-markdown snapshot of the current diagnostics, built to be pasted into an
// agent: a deterministic header plus markdown tables. Pure (no DOM, no clock of
// its own) so it is unit-testable and produces identical output for identical
// inputs.
export type MetricsTrendReport = {
  current: MetricsSample | null
  baseline: MetricsSample | null
  growth: GrowthRates
}

export function formatDiagnosticsReport(input: {
  aggregation: DiagnosticsAggregation
  metrics: ProcessMetricsSnapshot | null
  profiles: readonly ReplayProfileEntry[]
  // New, optional sections; omitted keeps the legacy report shape unchanged.
  perfEvents?: readonly PerfEventRollupRow[]
  longTasks?: LongTaskSummary | null
  frameStats?: FrameStatsSummary | null
  metricsTrend?: MetricsTrendReport | null
  ipc?: IpcThroughput | null
  terminalThroughput?: TerminalThroughput | null
  scrollback?: ScrollbackFootprint | null
  timers?: readonly TimerRegistrationRow[]
  now: number
}): string {
  const { aggregation, metrics, profiles, perfEvents, longTasks, frameStats, metricsTrend, ipc, terminalThroughput, scrollback, timers, now } = input
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
        ['Kind', 'PID', 'Type', 'CPU %', 'RSS', 'Threads', 'JS heap (used/total)'],
        metrics.processes.map((process) => [
          process.kind,
          String(process.pid),
          process.name ? `${process.type} · ${process.name}` : process.type,
          process.cpuPercent.toFixed(1),
          formatBytes(process.memoryBytes),
          process.threads !== undefined ? String(process.threads) : '—',
          process.heapUsedBytes !== undefined && process.heapTotalBytes !== undefined
            ? `${formatBytes(process.heapUsedBytes)} / ${formatBytes(process.heapTotalBytes)}`
            : '—',
        ])
      )
    )
  } else {
    sections.push('Process metrics unavailable.')
  }

  if (metricsTrend && metricsTrend.current) {
    const { current, baseline, growth } = metricsTrend
    sections.push('## Memory trend')
    const lines = [
      `Total RSS: ${formatBytes(current.totalRssBytes)} · renderer ${formatBytes(current.rendererRssBytes)} · main ${formatBytes(current.mainRssBytes)} · gpu ${formatBytes(current.gpuRssBytes)} · children ${formatBytes(current.childRssBytes)}`,
      current.rendererHeapUsedBytes !== null
        ? `Renderer JS heap: ${formatBytes(current.rendererHeapUsedBytes)} used${current.rendererHeapTotalBytes !== null ? ` / ${formatBytes(current.rendererHeapTotalBytes)}` : ''}`
        : 'Renderer JS heap: unavailable',
      `Growth (last ${Math.round(growth.windowMs / 1000)}s, ${growth.sampleCount} samples): RSS ${bytesPerMin(growth.rssBytesPerMin)}, heap ${bytesPerMin(growth.heapBytesPerMin)}`,
    ]
    if (baseline) {
      const diff = diffMetricsSamples(baseline, current)
      lines.push(
        `Baseline set ${lastOutput(baseline.sampledAt, now)} → Δ total ${signedBytes(diff.totalRssBytes)}, Δ renderer ${signedBytes(diff.rendererRssBytes)}, Δ heap ${diff.rendererHeapUsedBytes === null ? '—' : signedBytes(diff.rendererHeapUsedBytes)}, Δ renderer CPU ${diff.rendererCpuPercent > 0 ? '+' : ''}${diff.rendererCpuPercent}% over ${Math.round(diff.elapsedMs / 1000)}s`
      )
    }
    sections.push(lines.join('\n'))
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

  if (longTasks) {
    sections.push('## Long tasks (main-thread stalls)')
    sections.push(
      [
        `Window: last ${Math.round(longTasks.windowMs / 1000)}s`,
        `Count >50ms: ${longTasks.count}`,
        `Total blocking: ${longTasks.totalBlockingMs} ms`,
        `Max: ${msOrDash(longTasks.maxMs)} ms · p95: ${msOrDash(longTasks.p95Ms)} ms`,
        `Last: ${lastOutput(longTasks.lastAt, now)}`,
      ].join('\n')
    )
  }

  if (frameStats) {
    sections.push('## Rendering cadence (frames)')
    sections.push(
      [
        `Window: last ${Math.round(frameStats.windowMs / 1000)}s · ${frameStats.frameCount} frames`,
        `FPS: ${frameStats.fps ?? '—'}`,
        `Long frames (>50ms): ${frameStats.longFrameCount} (${frameStats.longFramePercent}%)`,
        `p95: ${msOrDash(frameStats.p95Ms)} ms · worst: ${msOrDash(frameStats.maxMs)} ms`,
        'Note: main-thread frame cadence; pure GPU draw stalls can read low here.',
      ].join('\n')
    )
  }

  if (perfEvents && perfEvents.length > 0) {
    sections.push('## Perf events (rolling)')
    sections.push(
      table(
        ['Scope', 'Event', 'Count', 'p50 ms', 'p95 ms', 'Max ms', 'Last ms'],
        perfEvents.map((row) => [
          row.scope,
          row.event,
          String(row.count),
          msOrDash(row.p50Ms),
          msOrDash(row.p95Ms),
          msOrDash(row.maxMs),
          msOrDash(row.lastMs),
        ])
      )
    )
  }

  if (timers && timers.length > 0) {
    sections.push('## Active timers / supervisors')
    sections.push(
      table(
        ['Label', 'Cadence ms', 'Ticks', 'Avg ms', 'Max ms', 'Last tick'],
        timers.map((row) => [
          row.label,
          String(row.cadenceMs),
          String(row.tickCount),
          msOrDash(row.avgMs),
          msOrDash(row.maxMs),
          lastOutput(row.lastTickAt, now),
        ])
      )
    )
  }

  if (scrollback) {
    sections.push('## Terminal scrollback footprint')
    sections.push(
      [
        `Instances: ${scrollback.instanceCount}`,
        `Total scrollback lines: ${scrollback.totalLines.toLocaleString()}`,
        `Estimated memory: ~${formatBytes(scrollback.estimatedBytes)} (rough: lines × cols × cell)`,
      ].join('\n')
    )
  }

  if (terminalThroughput) {
    sections.push('## Terminal write throughput')
    sections.push(
      [
        `Window: last ${Math.round(terminalThroughput.windowMs / 1000)}s`,
        `Total: ${formatBytes(terminalThroughput.totalBytesPerSec)}/s`,
        `Hidden (rendering off-screen): ${formatBytes(terminalThroughput.hiddenBytesPerSec)}/s`,
        `Visible: ${formatBytes(terminalThroughput.visibleBytesPerSec)}/s`,
      ].join('\n')
    )
  }

  if (ipc && ipc.channels.length > 0) {
    sections.push('## IPC throughput (per channel)')
    sections.push(
      table(
        ['Channel', 'Calls/s', 'Out/s', 'Events/s', 'In/s', 'Total calls'],
        ipc.channels
          .slice(0, 15)
          .map((channel) => [
            channel.name,
            String(channel.callsPerSec),
            formatBytes(channel.outBytesPerSec),
            String(channel.inEventsPerSec),
            formatBytes(channel.inBytesPerSec),
            String(channel.totalCalls),
          ])
      )
    )
  }

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
