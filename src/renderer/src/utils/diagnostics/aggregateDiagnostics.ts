import type { SessionActivity, TerminalSessionSnapshot } from '../../../../shared/electron-api'

// Warning thresholds. Kept as exported constants so the panel can label them
// ("> 1 MiB", "> 6h") from the same source the aggregation tests guard.
export const LARGE_REPLAY_WARNING_BYTES = 1024 * 1024 // 1 MiB
export const LONG_IDLE_WARNING_MS = 6 * 60 * 60 * 1000 // 6h
export const STALE_LAST_SEEN_WARNING_MS = 24 * 60 * 60 * 1000 // 24h

export type TerminalDiagnosticsWarning =
  // Runtime `visible === true` but the terminal's workspace is not the active
  // workspace of any window: a retained/hidden workspace is keeping a mounted
  // xterm live. This is the cost the panel exists to surface.
  | 'hidden-but-visible'
  | 'large-replay'
  | 'long-idle'
  | 'stale'

export type TerminalDiagnosticsRow = {
  sessionId: string
  workspaceId: string | null
  workspaceName: string | null
  agentId: string | null
  terminalId: string | null
  kind: TerminalSessionSnapshot['kind']
  cli: TerminalSessionSnapshot['cli']
  processAlive: boolean
  activity: SessionActivity
  // Runtime visibility flag from the main process (xterm mounted somewhere).
  visible: boolean
  // True when `visible` but the workspace is not on-screen in any window.
  hiddenButVisible: boolean
  retainedOutputBytes: number
  replayLimitBytes: number | null
  historyTier: TerminalSessionSnapshot['historyTier']
  startedAt: number
  lastOutputAt: number | null
  lastInputAt: number | null
  lastVisibleAt: number | null
  lastSeenAt: number
  warnings: TerminalDiagnosticsWarning[]
}

type WorkspaceDiagnosticsRollup = {
  workspaceId: string
  workspaceName: string | null
  terminalCount: number
  liveTerminalCount: number
  visibleTerminalCount: number
  hiddenButVisibleCount: number
  totalRetainedReplayBytes: number
  largestRetainedReplayBytes: number
  activeCount: number
  idleCount: number
  failedCount: number
  exitedCount: number
  lastOutputAt: number | null
  warningCount: number
}

export type DiagnosticsAggregation = {
  rows: TerminalDiagnosticsRow[]
  workspaces: WorkspaceDiagnosticsRollup[]
  totals: {
    terminalCount: number
    liveTerminalCount: number
    visibleTerminalCount: number
    hiddenButVisibleCount: number
    totalRetainedReplayBytes: number
    largestRetainedReplayBytes: number
    warningCount: number
  }
}

export type DiagnosticsAggregationInput = {
  sessions: TerminalSessionSnapshot[]
  // Active workspace id of every open window. A workspace not in this set is
  // retained-but-hidden (mounted off-screen) — the case the hidden-but-visible
  // warning targets.
  activeWorkspaceIds: ReadonlySet<string>
  // Display names by workspace id; missing ids fall back to null (shown as the
  // raw id in the panel).
  workspaceNames?: ReadonlyMap<string, string>
  now?: number
}

// Mirror of main's getTerminalLastSeenAt: the most recent moment of real
// activity — started, typed, or output. Deliberately excludes lastVisibleAt (in
// lockstep with main) so merely viewing a workspace never resets the stale clock.
function terminalLastSeenAt(session: TerminalSessionSnapshot): number {
  return Math.max(
    session.startedAt,
    session.lastInputAt ?? 0,
    session.lastOutputAt ?? 0
  )
}

function computeWarnings(
  session: TerminalSessionSnapshot,
  hiddenButVisible: boolean,
  lastSeenAt: number,
  now: number
): TerminalDiagnosticsWarning[] {
  const warnings: TerminalDiagnosticsWarning[] = []
  if (hiddenButVisible) warnings.push('hidden-but-visible')
  if (session.retainedOutputBytes > LARGE_REPLAY_WARNING_BYTES) warnings.push('large-replay')
  if (
    session.processAlive &&
    session.activity.kind === 'idle' &&
    now - session.startedAt > LONG_IDLE_WARNING_MS
  ) {
    warnings.push('long-idle')
  }
  if (now - lastSeenAt > STALE_LAST_SEEN_WARNING_MS) warnings.push('stale')
  return warnings
}

export function buildTerminalDiagnosticsRow(
  session: TerminalSessionSnapshot,
  input: { activeWorkspaceIds: ReadonlySet<string>; workspaceNames?: ReadonlyMap<string, string>; now: number }
): TerminalDiagnosticsRow {
  const workspaceId = session.workspaceId ?? null
  // A terminal with no workspace id cannot be attributed to a hidden workspace,
  // so it never trips the hidden-but-visible warning.
  const onScreen = workspaceId !== null && input.activeWorkspaceIds.has(workspaceId)
  const hiddenButVisible = session.processAlive && session.visible && workspaceId !== null && !onScreen
  const lastSeenAt = terminalLastSeenAt(session)
  return {
    sessionId: session.sessionId,
    workspaceId,
    workspaceName: workspaceId ? input.workspaceNames?.get(workspaceId) ?? null : null,
    agentId: session.agentId ?? null,
    terminalId: session.terminalId ?? null,
    kind: session.kind,
    cli: session.cli,
    processAlive: session.processAlive,
    activity: session.activity,
    visible: session.visible,
    hiddenButVisible,
    retainedOutputBytes: session.retainedOutputBytes,
    replayLimitBytes: session.replayLimitBytes ?? null,
    historyTier: session.historyTier,
    startedAt: session.startedAt,
    lastOutputAt: session.lastOutputAt,
    lastInputAt: session.lastInputAt,
    lastVisibleAt: session.lastVisibleAt,
    lastSeenAt,
    warnings: computeWarnings(session, hiddenButVisible, lastSeenAt, input.now),
  }
}

export function aggregateDiagnostics(input: DiagnosticsAggregationInput): DiagnosticsAggregation {
  const now = input.now ?? Date.now()
  const rows = input.sessions.map((session) =>
    buildTerminalDiagnosticsRow(session, {
      activeWorkspaceIds: input.activeWorkspaceIds,
      workspaceNames: input.workspaceNames,
      now,
    })
  )

  const rollupById = new Map<string, WorkspaceDiagnosticsRollup>()
  for (const row of rows) {
    if (row.workspaceId === null) continue
    let rollup = rollupById.get(row.workspaceId)
    if (!rollup) {
      rollup = {
        workspaceId: row.workspaceId,
        workspaceName: row.workspaceName,
        terminalCount: 0,
        liveTerminalCount: 0,
        visibleTerminalCount: 0,
        hiddenButVisibleCount: 0,
        totalRetainedReplayBytes: 0,
        largestRetainedReplayBytes: 0,
        activeCount: 0,
        idleCount: 0,
        failedCount: 0,
        exitedCount: 0,
        lastOutputAt: null,
        warningCount: 0,
      }
      rollupById.set(row.workspaceId, rollup)
    }
    rollup.terminalCount += 1
    if (row.processAlive) rollup.liveTerminalCount += 1
    if (row.visible) rollup.visibleTerminalCount += 1
    if (row.hiddenButVisible) rollup.hiddenButVisibleCount += 1
    rollup.totalRetainedReplayBytes += row.retainedOutputBytes
    rollup.largestRetainedReplayBytes = Math.max(
      rollup.largestRetainedReplayBytes,
      row.retainedOutputBytes
    )
    if (row.activity.kind === 'working') rollup.activeCount += 1
    else if (row.activity.kind === 'idle') rollup.idleCount += 1
    else if (row.activity.kind === 'failed') rollup.failedCount += 1
    else if (row.activity.kind === 'exited') rollup.exitedCount += 1
    if (typeof row.lastOutputAt === 'number') {
      rollup.lastOutputAt =
        rollup.lastOutputAt === null ? row.lastOutputAt : Math.max(rollup.lastOutputAt, row.lastOutputAt)
    }
    rollup.warningCount += row.warnings.length
  }

  // Sort workspaces by retained replay footprint (the headline cost), heaviest
  // first; ties broken by name/id for a stable scan.
  const workspaces = [...rollupById.values()].sort(
    (a, b) =>
      b.totalRetainedReplayBytes - a.totalRetainedReplayBytes ||
      (a.workspaceName ?? a.workspaceId).localeCompare(b.workspaceName ?? b.workspaceId)
  )

  const totals = rows.reduce(
    (acc, row) => {
      acc.terminalCount += 1
      if (row.processAlive) acc.liveTerminalCount += 1
      if (row.visible) acc.visibleTerminalCount += 1
      if (row.hiddenButVisible) acc.hiddenButVisibleCount += 1
      acc.totalRetainedReplayBytes += row.retainedOutputBytes
      acc.largestRetainedReplayBytes = Math.max(acc.largestRetainedReplayBytes, row.retainedOutputBytes)
      acc.warningCount += row.warnings.length
      return acc
    },
    {
      terminalCount: 0,
      liveTerminalCount: 0,
      visibleTerminalCount: 0,
      hiddenButVisibleCount: 0,
      totalRetainedReplayBytes: 0,
      largestRetainedReplayBytes: 0,
      warningCount: 0,
    }
  )

  return { rows, workspaces, totals }
}

export type TerminalDiagnosticsSortKey = 'retained' | 'activity' | 'workspace' | 'lastOutput' | 'warnings'

// Stable, scannable orderings for the terminal table. Default is heaviest
// retained replay first — the brief's primary triage axis.
export function sortTerminalDiagnosticsRows(
  rows: readonly TerminalDiagnosticsRow[],
  key: TerminalDiagnosticsSortKey
): TerminalDiagnosticsRow[] {
  const sorted = [...rows]
  switch (key) {
    case 'retained':
      sorted.sort((a, b) => b.retainedOutputBytes - a.retainedOutputBytes)
      break
    case 'lastOutput':
      sorted.sort((a, b) => (b.lastOutputAt ?? 0) - (a.lastOutputAt ?? 0))
      break
    case 'warnings':
      sorted.sort((a, b) => b.warnings.length - a.warnings.length || b.retainedOutputBytes - a.retainedOutputBytes)
      break
    case 'activity': {
      const rank: Record<SessionActivity['kind'], number> = { working: 0, idle: 1, failed: 2, exited: 3 }
      sorted.sort((a, b) => rank[a.activity.kind] - rank[b.activity.kind] || b.retainedOutputBytes - a.retainedOutputBytes)
      break
    }
    case 'workspace':
      sorted.sort((a, b) =>
        (a.workspaceName ?? a.workspaceId ?? '').localeCompare(b.workspaceName ?? b.workspaceId ?? '')
      )
      break
  }
  return sorted
}
