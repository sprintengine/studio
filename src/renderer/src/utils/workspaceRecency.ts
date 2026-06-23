import type { Workspace } from '../types/workspace'

// A workspace folds into its folder's "Show older" disclosure once it has gone
// this long without being worked on. Kept as a single constant on purpose — the
// fold is intentionally simple (recency only), with no per-user configuration.
export const WORKSPACE_STALE_THRESHOLD_MS = 5 * 24 * 60 * 60 * 1000 // 5 days

// "Last worked on" is the most recent of when the workspace was created and when
// the user last typed into one of its terminals (lastTerminalActivityAt, fed from
// lastInputAt — not terminal output, so reopening a workspace never refreshes it).
// Both already live on the workspace record, so the fold needs no new persisted state.
export function workspaceLastWorkedAt(workspace: Workspace): number {
  return Math.max(workspace.createdAt, workspace.lastTerminalActivityAt ?? 0)
}

export function isWorkspaceStale(workspace: Workspace, now: number): boolean {
  return now - workspaceLastWorkedAt(workspace) >= WORKSPACE_STALE_THRESHOLD_MS
}

export type WorkspaceRecencyPartition = {
  recent: Workspace[]
  stale: Workspace[]
}

// Splits a folder's workspaces into the rows shown eagerly and the rows tucked
// behind "Show older", preserving the incoming (manual) order within each group.
// `isPinned` keeps a workspace visible regardless of age — the sidebar passes
// the active, starred, and busy (working/failed/needs-input) workspaces, which
// must never hide.
export function partitionWorkspacesByRecency(
  workspaces: Workspace[],
  now: number,
  isPinned: (workspace: Workspace) => boolean
): WorkspaceRecencyPartition {
  const recent: Workspace[] = []
  const stale: Workspace[] = []
  for (const workspace of workspaces) {
    if (isPinned(workspace) || !isWorkspaceStale(workspace, now)) {
      recent.push(workspace)
    } else {
      stale.push(workspace)
    }
  }
  return { recent, stale }
}

// Workspaces touched within this window all count as "just now" for ordering, so
// opening or briefly touching a recent workspace never reshuffles the rows
// around it. Only once a row falls outside the window does its actual last-worked
// time decide where it sits relative to other older rows.
export const RECENT_ACTIVITY_TIE_WINDOW_MS = 30 * 60 * 1000 // 30 minutes

// The ordering key. A live row (green dot — working/needs-input/failed) counts as
// "just now" no matter what its timestamps say, the same as a row worked on
// inside the tie window; both collapse onto `now` so they compare equal. Idle
// rows past the window keep their real last-worked time and therefore sort below
// the recent block, oldest last.
function activitySortKey(
  workspace: Workspace,
  isLive: (workspace: Workspace) => boolean,
  now: number
): number {
  if (isLive(workspace)) return now
  const workedAt = workspaceLastWorkedAt(workspace)
  return now - workedAt < RECENT_ACTIVITY_TIE_WINDOW_MS ? now : workedAt
}

// Orders workspaces by activity rather than by manual position. Live rows (green
// dot) and idle rows worked on within the last 30 minutes share one "just now"
// tier and keep their stored order — a green dot, an open, or a transient status
// blip never bumps a row ahead of its neighbours. Idle rows older than the window
// sort below that tier by how recently each was worked on, most recent first.
function compareWorkspacesByActivity(
  a: Workspace,
  b: Workspace,
  isLive: (workspace: Workspace) => boolean,
  now: number
): number {
  return activitySortKey(b, isLive, now) - activitySortKey(a, isLive, now)
}

export function sortWorkspacesByActivity(
  workspaces: Workspace[],
  isLive: (workspace: Workspace) => boolean,
  now: number = Date.now()
): Workspace[] {
  // Array.prototype.sort is stable, so live rows (and any idle rows that tie on
  // last-worked time, including everything inside the 30-minute window) keep
  // their incoming (stored) order.
  return [...workspaces].sort((a, b) => compareWorkspacesByActivity(a, b, isLive, now))
}
