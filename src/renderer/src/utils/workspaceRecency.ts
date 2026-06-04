import type { Workspace } from '../types/workspace'

// A workspace folds into its folder's "Show older" disclosure once it has gone
// this long without being worked on. Kept as a single constant on purpose — the
// fold is intentionally simple (recency only), with no per-user configuration.
export const WORKSPACE_STALE_THRESHOLD_MS = 5 * 24 * 60 * 60 * 1000 // 5 days

// "Last worked on" is the most recent of when the workspace was created and when
// its terminals last produced output. Both already live on the workspace record,
// so the fold needs no new persisted state.
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

// Orders workspaces by activity rather than by manual position. Rows showing a
// live status dot (working/needs-input/failed — anything not idle) float to the
// top; the idle rows below them are ordered by how recently each was worked on,
// most recent first.
//
// Live rows keep their incoming (stored) order among themselves on purpose: they
// carry only the status dot, not the "2 min ago" recency label, and a working
// agent's `lastTerminalActivityAt` climbs on every output flush — sorting the
// live tier by it would make concurrently-streaming rows reshuffle constantly.
// A workspace that just went idle has a fresh last-worked time, so it lands at
// the top of the idle tier right where the user left off.
function compareWorkspacesByActivity(
  a: Workspace,
  b: Workspace,
  isLive: (workspace: Workspace) => boolean
): number {
  const liveA = isLive(a)
  const liveB = isLive(b)
  if (liveA !== liveB) return liveA ? -1 : 1
  if (liveA && liveB) return 0
  return workspaceLastWorkedAt(b) - workspaceLastWorkedAt(a)
}

export function sortWorkspacesByActivity(
  workspaces: Workspace[],
  isLive: (workspace: Workspace) => boolean
): Workspace[] {
  // Array.prototype.sort is stable, so live rows (and any idle rows that tie on
  // last-worked time) keep their incoming (stored) order.
  return [...workspaces].sort((a, b) => compareWorkspacesByActivity(a, b, isLive))
}
