import type { Workspace } from '../types/workspace'
import { MONOTONIC_WORKSPACE_CLOCKS } from '../../../shared/workspace-sync'

// A workspace folds into its folder's "Show more" disclosure once it has gone
// this long without being worked on. Kept as a single constant on purpose — the
// fold is intentionally simple (recency only), with no per-user configuration.
export const WORKSPACE_STALE_THRESHOLD_MS = 2 * 24 * 60 * 60 * 1000 // 2 days

// Even inside the recency window, a folder shows at most this many rows at
// rest; the overflow joins the fold (newest first, ahead of the stale rows).
// Pinned rows never count against the cap — they must always be visible.
export const WORKSPACE_RECENT_ROW_CAP = 10

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
// behind "Show more", preserving the incoming order within each group.
// Two rules decide the eager set:
//  1. Recency window: only rows worked within WORKSPACE_STALE_THRESHOLD_MS.
//  2. Row cap: at most WORKSPACE_RECENT_ROW_CAP rows even inside the window —
//     the overflow moves to the FRONT of the fold (it is newer than the stale
//     rows behind it), so paging the fold reads in recency order.
// `isPinned` keeps a workspace visible regardless of age or cap — the sidebar
// passes the active, starred, and busy (working/failed/needs-input) workspaces,
// which must never hide.
export function partitionWorkspacesByRecency(
  workspaces: Workspace[],
  now: number,
  isPinned: (workspace: Workspace) => boolean,
  recentRowCap: number = WORKSPACE_RECENT_ROW_CAP
): WorkspaceRecencyPartition {
  const recent: Workspace[] = []
  const overflow: Workspace[] = []
  const stale: Workspace[] = []
  for (const workspace of workspaces) {
    if (isPinned(workspace)) {
      // Pinned rows always show, even past the cap — hiding the active, a
      // starred, or a busy workspace is never acceptable tidiness.
      recent.push(workspace)
    } else if (isWorkspaceStale(workspace, now)) {
      stale.push(workspace)
    } else if (recent.length < recentRowCap) {
      recent.push(workspace)
    } else {
      overflow.push(workspace)
    }
  }
  return { recent, stale: [...overflow, ...stale] }
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

// The bands a folder's rows fall into, top to bottom. Recency alone answers
// "what did I touch last"; it never answers "what wants me". These four tiers
// put the rows that want you above the rows that don't, and leave recency to
// order each band internally.
//
//  - `attention`: an agent is blocked on you (permission prompt, a question).
//  - `done`: an agent finished while you were away and you have not looked yet
//    — the green row. Gold outranks green, exactly as the row treatment does.
//  - `running`: an agent is working right now. Below the two bands that want
//    you: a running agent is a thing to watch, not a thing to answer.
//  - `resting`: everything else, in the recency order it has always had.
export type WorkspaceAttentionTier = 'attention' | 'done' | 'running' | 'resting'

const ATTENTION_TIER_RANK: Record<WorkspaceAttentionTier, number> = {
  attention: 0,
  done: 1,
  running: 2,
  resting: 3,
}

export function attentionTierRank(tier: WorkspaceAttentionTier): number {
  return ATTENTION_TIER_RANK[tier]
}

// Orders workspaces by attention tier first, then — within a tier — by the
// same last-worked recency key the list has always used. Live status finally
// gets a say in position, but only through `tierOf`, which the sidebar
// deliberately freezes for the row you have selected: a tier that changed
// under your cursor would reflow the list you are reading, which is the bug
// this ordering must not reintroduce (`workspace-row-move-on-click`, id 88).
export function sortWorkspacesByAttention(
  workspaces: Workspace[],
  tierOf: (workspace: Workspace) => WorkspaceAttentionTier,
  now: number = Date.now()
): Workspace[] {
  return [...workspaces].sort((a, b) => {
    const byTier = ATTENTION_TIER_RANK[tierOf(a)] - ATTENTION_TIER_RANK[tierOf(b)]
    if (byTier !== 0) return byTier
    return compareWorkspacesByActivity(a, b, now)
  })
}

// When main's record arrives (a snapshot, or a field patch another window
// sent from an older reading), the later copy of each activity clock is the
// truth — the same rule main's reducer applies (MONOTONIC_WORKSPACE_CLOCKS):
// an older stamp must not roll a row's clock back and let the rest sweep read
// a chat that was active yesterday as idle.
export function keepLaterWorkspaceClocks(
  existing: Pick<Workspace, (typeof MONOTONIC_WORKSPACE_CLOCKS)[number]>,
  incoming: Workspace
): Workspace {
  let merged: Workspace | null = null
  for (const clock of MONOTONIC_WORKSPACE_CLOCKS) {
    const mine = existing[clock]
    const theirs = incoming[clock]
    if (typeof mine !== 'number') continue
    if (typeof theirs === 'number' && theirs >= mine) continue
    merged = merged ?? { ...incoming }
    merged[clock] = mine
  }
  return merged ?? incoming
}
