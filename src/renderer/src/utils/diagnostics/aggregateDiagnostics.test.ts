import assert from 'node:assert/strict'
import type { SessionActivity, TerminalSessionSnapshot } from '../../../../shared/electron-api'
import {
  aggregateDiagnostics,
  buildTerminalDiagnosticsRow,
  LARGE_REPLAY_WARNING_BYTES,
  LONG_IDLE_WARNING_MS,
  sortTerminalDiagnosticsRows,
  STALE_LAST_SEEN_WARNING_MS,
} from './aggregateDiagnostics'

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
  const activity: SessionActivity = overrides.activity ?? { kind: 'working', since: NOW }
  return {
    sessionId: overrides.sessionId,
    processAlive: overrides.processAlive ?? true,
    kind: overrides.kind ?? 'agent',
    pathStyle: overrides.pathStyle,
    workspaceId: overrides.workspaceId,
    agentId: overrides.agentId,
    terminalId: overrides.terminalId,
    cli: overrides.cli,
    cwd: overrides.cwd,
    sprintEngineStatePath: overrides.sprintEngineStatePath,
    executionMode: overrides.executionMode,
    worktreeId: overrides.worktreeId,
    worktreePath: overrides.worktreePath,
    agentSession: overrides.agentSession,
    visible: overrides.visible ?? false,
    suspended: overrides.suspended ?? false,
    reapExempt: overrides.reapExempt ?? false,
    startedAt: overrides.startedAt ?? NOW,
    lastOutputAt: overrides.lastOutputAt ?? NOW,
    lastInputAt: overrides.lastInputAt ?? null,
    lastVisibleAt: overrides.lastVisibleAt ?? null,
    activity,
    fileChanges: overrides.fileChanges ?? [],
    activeSubagents: overrides.activeSubagents ?? 0,
    contextUsage: overrides.contextUsage ?? null,
    exitedAt: overrides.exitedAt ?? null,
    outputBufferLength: overrides.outputBufferLength ?? 0,
    retainedOutputBytes: overrides.retainedOutputBytes ?? 0,
    historyTier: overrides.historyTier,
    replayLimitBytes: overrides.replayLimitBytes,
  }
}

run('hidden-but-visible fires only for visible terminals in non-active workspaces', () => {
  const active = session({
    sessionId: 'a',
    workspaceId: 'ws-active',
    visible: true,
  })
  const hidden = session({
    sessionId: 'b',
    workspaceId: 'ws-hidden',
    visible: true,
  })
  const hiddenNotVisible = session({
    sessionId: 'c',
    workspaceId: 'ws-hidden',
    visible: false,
  })

  const result = aggregateDiagnostics({
    sessions: [active, hidden, hiddenNotVisible],
    activeWorkspaceIds: new Set(['ws-active']),
    now: NOW,
  })

  const byId = new Map(result.rows.map((row) => [row.sessionId, row]))
  assert.equal(byId.get('a')!.hiddenButVisible, false, 'active workspace terminal is not hidden')
  assert.equal(byId.get('b')!.hiddenButVisible, true, 'visible terminal in hidden workspace flags')
  assert.equal(byId.get('c')!.hiddenButVisible, false, 'non-visible terminal never flags')
  assert.ok(byId.get('b')!.warnings.includes('hidden-but-visible'))
  assert.equal(result.totals.hiddenButVisibleCount, 1)
})

run('dead terminals never flag hidden-but-visible even if visible flag lingers', () => {
  const row = buildTerminalDiagnosticsRow(
    session({ sessionId: 'd', workspaceId: 'ws-hidden', visible: true, processAlive: false, activity: { kind: 'exited', at: NOW, exitCode: 0 } }),
    { activeWorkspaceIds: new Set<string>(), now: NOW }
  )
  assert.equal(row.hiddenButVisible, false)
})

run('terminals with no workspace id never flag hidden-but-visible', () => {
  const row = buildTerminalDiagnosticsRow(
    session({ sessionId: 'e', workspaceId: undefined, visible: true }),
    { activeWorkspaceIds: new Set<string>(), now: NOW }
  )
  assert.equal(row.hiddenButVisible, false)
  assert.equal(row.workspaceId, null)
})

run('large-replay fires strictly above 1 MiB', () => {
  const atLimit = buildTerminalDiagnosticsRow(
    session({ sessionId: 'f', retainedOutputBytes: LARGE_REPLAY_WARNING_BYTES }),
    { activeWorkspaceIds: new Set<string>(), now: NOW }
  )
  const overLimit = buildTerminalDiagnosticsRow(
    session({ sessionId: 'g', retainedOutputBytes: LARGE_REPLAY_WARNING_BYTES + 1 }),
    { activeWorkspaceIds: new Set<string>(), now: NOW }
  )
  assert.equal(atLimit.warnings.includes('large-replay'), false, 'exactly 1 MiB does not warn')
  assert.equal(overLimit.warnings.includes('large-replay'), true)
})

run('long-idle fires only for live, idle, >6h terminals', () => {
  const idleOld = buildTerminalDiagnosticsRow(
    session({
      sessionId: 'h',
      startedAt: NOW - LONG_IDLE_WARNING_MS - 1,
      activity: { kind: 'idle', since: NOW - 1000 },
      lastOutputAt: NOW - 1000,
    }),
    { activeWorkspaceIds: new Set<string>(), now: NOW }
  )
  const idleYoung = buildTerminalDiagnosticsRow(
    session({
      sessionId: 'i',
      startedAt: NOW - 1000,
      activity: { kind: 'idle', since: NOW - 500 },
    }),
    { activeWorkspaceIds: new Set<string>(), now: NOW }
  )
  const workingOld = buildTerminalDiagnosticsRow(
    session({
      sessionId: 'j',
      startedAt: NOW - LONG_IDLE_WARNING_MS - 1,
      activity: { kind: 'working', since: NOW - 1000 },
    }),
    { activeWorkspaceIds: new Set<string>(), now: NOW }
  )
  assert.equal(idleOld.warnings.includes('long-idle'), true)
  assert.equal(idleYoung.warnings.includes('long-idle'), false, 'young idle does not warn')
  assert.equal(workingOld.warnings.includes('long-idle'), false, 'working terminal does not warn')
})

run('stale fires from the most recent of any touch timestamp', () => {
  // Output is old, but a recent input keeps it fresh.
  const freshByInput = buildTerminalDiagnosticsRow(
    session({
      sessionId: 'k',
      startedAt: NOW - STALE_LAST_SEEN_WARNING_MS - 5000,
      lastOutputAt: NOW - STALE_LAST_SEEN_WARNING_MS - 5000,
      lastInputAt: NOW - 1000,
    }),
    { activeWorkspaceIds: new Set<string>(), now: NOW }
  )
  const stale = buildTerminalDiagnosticsRow(
    session({
      sessionId: 'l',
      startedAt: NOW - STALE_LAST_SEEN_WARNING_MS - 5000,
      lastOutputAt: NOW - STALE_LAST_SEEN_WARNING_MS - 5000,
      lastInputAt: null,
      lastVisibleAt: null,
    }),
    { activeWorkspaceIds: new Set<string>(), now: NOW }
  )
  assert.equal(freshByInput.warnings.includes('stale'), false)
  assert.equal(stale.warnings.includes('stale'), true)
})

run('workspace rollups sum footprint and classify activity', () => {
  const result = aggregateDiagnostics({
    sessions: [
      session({ sessionId: 'a', workspaceId: 'ws1', retainedOutputBytes: 2 * MIB, activity: { kind: 'working', since: NOW }, visible: true, lastOutputAt: NOW - 5000 }),
      session({ sessionId: 'b', workspaceId: 'ws1', retainedOutputBytes: 100, activity: { kind: 'idle', since: NOW }, lastOutputAt: NOW - 1000 }),
      session({ sessionId: 'c', workspaceId: 'ws1', retainedOutputBytes: 50, activity: { kind: 'failed', at: NOW, exitCode: 1 }, processAlive: false, lastOutputAt: NOW - 10000 }),
      session({ sessionId: 'd', workspaceId: 'ws2', retainedOutputBytes: 10, activity: { kind: 'working', since: NOW } }),
    ],
    activeWorkspaceIds: new Set(['ws1']),
    workspaceNames: new Map([['ws1', 'Alpha'], ['ws2', 'Bravo']]),
    now: NOW,
  })

  // Sorted heaviest-retained first: ws1 (2 MiB+) before ws2.
  assert.deepEqual(result.workspaces.map((w) => w.workspaceId), ['ws1', 'ws2'])
  const ws1 = result.workspaces[0]
  assert.equal(ws1.workspaceName, 'Alpha')
  assert.equal(ws1.terminalCount, 3)
  assert.equal(ws1.liveTerminalCount, 2)
  assert.equal(ws1.visibleTerminalCount, 1)
  assert.equal(ws1.activeCount, 1)
  assert.equal(ws1.idleCount, 1)
  assert.equal(ws1.failedCount, 1)
  assert.equal(ws1.totalRetainedReplayBytes, 2 * MIB + 150)
  assert.equal(ws1.largestRetainedReplayBytes, 2 * MIB)
  assert.equal(ws1.lastOutputAt, NOW - 1000, 'rollup keeps the most recent output time')

  assert.equal(result.totals.terminalCount, 4)
  assert.equal(result.totals.totalRetainedReplayBytes, 2 * MIB + 160)
  assert.equal(result.totals.largestRetainedReplayBytes, 2 * MIB)
})

run('sort by retained orders rows heaviest first', () => {
  const rows = aggregateDiagnostics({
    sessions: [
      session({ sessionId: 'small', retainedOutputBytes: 10 }),
      session({ sessionId: 'big', retainedOutputBytes: 5 * MIB }),
      session({ sessionId: 'mid', retainedOutputBytes: 1000 }),
    ],
    activeWorkspaceIds: new Set<string>(),
    now: NOW,
  }).rows
  const sorted = sortTerminalDiagnosticsRows(rows, 'retained')
  assert.deepEqual(sorted.map((r) => r.sessionId), ['big', 'mid', 'small'])
  // Pure: input is not mutated.
  assert.deepEqual(rows.map((r) => r.sessionId), ['small', 'big', 'mid'])
})

run('sort by warnings floats the most-flagged rows up', () => {
  const rows = aggregateDiagnostics({
    sessions: [
      session({ sessionId: 'clean', workspaceId: 'ws-active', visible: true, retainedOutputBytes: 10 }),
      session({
        sessionId: 'flagged',
        workspaceId: 'ws-hidden',
        visible: true,
        retainedOutputBytes: 2 * MIB,
      }),
    ],
    activeWorkspaceIds: new Set(['ws-active']),
    now: NOW,
  }).rows
  const sorted = sortTerminalDiagnosticsRows(rows, 'warnings')
  assert.equal(sorted[0].sessionId, 'flagged')
})

console.log('aggregateDiagnostics tests passed')
