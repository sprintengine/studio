import assert from 'node:assert/strict'
import type { ProcessMetricsSnapshot, TerminalSessionSnapshot } from '../../../../shared/electron-api'
import { aggregateDiagnostics } from './aggregateDiagnostics'
import { formatBytes, formatDiagnosticsReport } from './formatDiagnosticsReport'
import type { ReplayProfileEntry } from './replayProfileStore'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const NOW = 1_700_000_000_000
const MIB = 1024 * 1024

function session(overrides: Partial<TerminalSessionSnapshot> & { sessionId: string }): TerminalSessionSnapshot {
  return {
    sessionId: overrides.sessionId,
    processAlive: overrides.processAlive ?? true,
    kind: overrides.kind ?? 'agent',
    visible: overrides.visible ?? false,
    startedAt: overrides.startedAt ?? NOW,
    lastOutputAt: overrides.lastOutputAt ?? NOW,
    lastInputAt: overrides.lastInputAt ?? null,
    lastVisibleAt: overrides.lastVisibleAt ?? null,
    activity: overrides.activity ?? { kind: 'working', since: NOW },
    exitedAt: overrides.exitedAt ?? null,
    outputBufferLength: 0,
    retainedOutputBytes: overrides.retainedOutputBytes ?? 0,
    workspaceId: overrides.workspaceId,
    agentId: overrides.agentId,
    terminalId: overrides.terminalId,
    cli: overrides.cli,
    historyTier: overrides.historyTier,
    replayLimitBytes: overrides.replayLimitBytes,
  }
}

run('formatBytes renders binary units', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1024), '1.0 KiB')
  assert.equal(formatBytes(2 * MIB), '2.0 MiB')
})

run('report carries every section and key totals', () => {
  const aggregation = aggregateDiagnostics({
    sessions: [
      session({ sessionId: 'a', workspaceId: 'ws-hidden', visible: true, retainedOutputBytes: 2 * MIB, agentId: 'Nova', cli: 'codex' }),
      session({ sessionId: 'b', workspaceId: 'ws-active', visible: true, retainedOutputBytes: 10 }),
    ],
    activeWorkspaceIds: new Set(['ws-active']),
    workspaceNames: new Map([['ws-hidden', 'Hidden WS'], ['ws-active', 'Active WS']]),
    now: NOW,
  })
  const metrics: ProcessMetricsSnapshot = {
    sampledAt: NOW,
    processes: [{ pid: 1, kind: 'main', type: 'Browser', cpuPercent: 3.2, memoryBytes: 200 * MIB }],
  }
  const profiles: ReplayProfileEntry[] = [
    {
      recordedAt: NOW - 1000,
      sessionId: 'a',
      agentId: 'Nova',
      kind: 'agent',
      payloadChars: 100,
      payloadBytes: 100,
      writeCount: 3,
      maxWriteMs: 12,
      totalReplayMs: 40,
      timeToFirstContentMs: 5,
      liveBufferedCount: 1,
      endedVia: 'replay',
    },
  ]

  const report = formatDiagnosticsReport({ aggregation, metrics, profiles, now: NOW })

  assert.match(report, /# Multicode performance diagnostics/)
  assert.match(report, /## Processes/)
  assert.match(report, /## Workspaces/)
  assert.match(report, /## Terminals/)
  assert.match(report, /## Recent replay profiles/)
  // ISO timestamp + headline totals.
  assert.match(report, new RegExp(new Date(NOW).toISOString()))
  assert.match(report, /Terminals: 2 \(live 2, runtime-visible 2, hidden\+visible 1\)/)
  // Hidden-but-visible terminal is tokenized in the terminal table.
  assert.match(report, /hidden-visible/)
  assert.match(report, /big-replay/)
  // Process row present.
  assert.match(report, /Browser/)
  // Replay profile row present.
  assert.match(report, /Nova/)
})

run('report degrades cleanly with no processes and no profiles', () => {
  const aggregation = aggregateDiagnostics({ sessions: [], activeWorkspaceIds: new Set<string>(), now: NOW })
  const report = formatDiagnosticsReport({ aggregation, metrics: null, profiles: [], now: NOW })
  assert.match(report, /Process metrics unavailable\./)
  assert.match(report, /No replay profiles captured in this window\./)
})

console.log('formatDiagnosticsReport tests passed')
