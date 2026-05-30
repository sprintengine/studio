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
