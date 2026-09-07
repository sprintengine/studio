import type { Workspace } from '../types/workspace'
import { MONOTONIC_WORKSPACE_CLOCKS, workspaceFieldMayApply } from '../../../shared/workspace-sync'

// "Last worked on" is the most recent of when the workspace was created and when
// the user last typed into one of its terminals (lastTerminalActivityAt, fed from
// lastInputAt — not terminal output, so reopening a workspace never refreshes it).
// The rest rule (`workspaceSettle.ts`) builds on this, adding the agent's turn end.
export function workspaceLastWorkedAt(workspace: Workspace): number {
  return Math.max(workspace.createdAt, workspace.lastTerminalActivityAt ?? 0)
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
// Liveness still drives the status dot and holds busy rows out of the Settled
// shelf (`workspaceSettle.ts`); it just never reorders them.
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
    if (workspaceFieldMayApply(existing as unknown as Record<string, unknown>, clock, incoming[clock])) continue
    merged = merged ?? { ...incoming }
    merged[clock] = existing[clock]
  }
  return merged ?? incoming
}
