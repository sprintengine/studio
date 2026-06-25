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

// The ordering key, and deliberately a pure function of *work*: a row worked on
// inside the tie window collapses onto `now`, while rows worked earlier keep their
// real last-worked time and sort below, oldest last. Live status has no say here.
// Opening an idle workspace flips it "live" (its agents come back to life), but
// that transient blip is not work and must not move the row; only genuine work
// — creation or terminal input, via workspaceLastWorkedAt — sets position.
// Liveness still drives the status dot and pins busy rows visible
// (partitionWorkspacesByRecency); it just never reorders them.
function activitySortKey(workspace: Workspace, now: number): number {
  const workedAt = workspaceLastWorkedAt(workspace)
  return now - workedAt < RECENT_ACTIVITY_TIE_WINDOW_MS ? now : workedAt
}

// Orders workspaces by how recently each was worked on rather than by manual
// position. Rows worked within the last 30 minutes share one "just now" tier and
// keep their stored order — an open, a green dot, or a transient status blip never
// bumps a row ahead of its neighbours. Rows older than the window sort below that
// tier, most recent first.
function compareWorkspacesByActivity(a: Workspace, b: Workspace, now: number): number {
  return activitySortKey(b, now) - activitySortKey(a, now)
}

export function sortWorkspacesByActivity(
  workspaces: Workspace[],
  now: number = Date.now()
): Workspace[] {
  // Array.prototype.sort is stable, so rows that tie on last-worked time
  // (including everything inside the 30-minute window) keep their incoming
  // (stored) order.
  return [...workspaces].sort((a, b) => compareWorkspacesByActivity(a, b, now))
}
