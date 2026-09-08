import type { Workspace } from '../types/workspace'
import { MONOTONIC_WORKSPACE_CLOCKS, workspaceFieldMayApply } from '../../../shared/workspace-sync'

// "Last worked on" is the most recent of when the workspace was created and when
// the user last typed into one of its terminals (lastTerminalActivityAt, fed from
// lastInputAt — not terminal output, so reopening a workspace never refreshes it).
// The rest rule (`workspaceSettle.ts`) builds on this, adding the agent's turn end.
//
// NOT the ordering key any more — see `workspaceLastUserMessageAt`, which this
// is now only the fallback for. A keystroke is any keystroke: an arrow key, a
// `y` at a permission prompt, a `git status` in a plain shell. Ordering on it
// moved rows under the cursor of someone who had not said anything.
export function workspaceLastWorkedAt(workspace: Workspace): number {
  return Math.max(workspace.createdAt, workspace.lastTerminalActivityAt ?? 0)
}

/**
 * When the chat was last active, by anyone: the latest of the person's last
 * real work (creation or a keystroke, `workspaceLastWorkedAt`), the person's
 * last message, and the agent's last turn end. This is the rest rule's clock
 * (`workspaceSettle.ts`) — "has this chat gone quiet", where an agent that
 * spoke an hour ago plainly means it has not. Deliberately not an ordering
 * key: what keeps a chat out of the Settled shelf is a different question from
 * where it sits in the list.
 *
 * The message clock has to be in here even though a message into a terminal
 * always moves the keystroke clock with it: a conversation-runtime chat has no
 * pty and no turn-end hook, so its message clock is the ONLY thing that ever
 * moves. Without it, a chat the person writes in every day is three days idle
 * by this reading from the moment it is created, and the sweep shelves it out
 * from under them.
 */
export function workspaceLastActiveAt(workspace: Workspace): number {
  return Math.max(
    workspaceLastWorkedAt(workspace),
    workspace.lastUserMessageAt ?? 0,
    workspace.lastTurnEndedAt ?? 0,
  )
}

/**
 * THE ordering key for every list of chats: when the person last sent a
 * message into this one (`lastUserMessageAt`, the `UserPromptSubmit` hook).
 *
 * Ordering used to read work and — in the flat stream — the agent's turn end,
 * with a 30-minute window collapsing recent rows onto `now` to damp the churn
 * that caused. It was still churn: a row moved when an agent finished
 * somewhere else, when a keystroke landed in a shell, and spontaneously as
 * `now` advanced a row out of the tie window — all while the person was
 * reaching for a row with the mouse (workspace-row-move-on-click, id 88).
 *
 * A submitted message is the one event a person performs deliberately and
 * expects to reorder their chats by. So this key moves for that and nothing
 * else, which makes the whole order a pure function of stored stamps: it can
 * only change when someone says something, never on a clock tick, an agent, or
 * a click. Hence no tie window here — there is no longer anything to damp.
 *
 * The fallback is `workspaceLastWorkedAt` for the rows that can never have a
 * message: a plain shell, a hookless CLI, a chat not yet spoken in. For those
 * the old key is the best that is knowable, and using it keeps them in the
 * order they have always had rather than sinking them all to creation time.
 */
export function workspaceLastUserMessageAt(workspace: Workspace): number {
  return workspace.lastUserMessageAt ?? workspaceLastWorkedAt(workspace)
}

// Most recently spoken in first. Ties — including every row still on its
// fallback with the same stamp — are left to the caller's stable sort.
function compareWorkspacesByUserMessage(a: Workspace, b: Workspace): number {
  return workspaceLastUserMessageAt(b) - workspaceLastUserMessageAt(a)
}

/**
 * Orders workspaces by when the person last messaged each, most recent first,
 * rather than by manual position.
 */
export function sortWorkspacesByUserMessage(workspaces: Workspace[]): Workspace[] {
  // Array.prototype.sort is stable, so rows that tie keep their incoming
  // (stored) order.
  return [...workspaces].sort(compareWorkspacesByUserMessage)
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

// Orders workspaces by attention tier first, then — within a tier — by when
// the person last messaged each. Live status gets a say in position, but only
// through `tierOf`, which the sidebar deliberately freezes for the row you
// have selected: a tier that changed under your cursor would reflow the list
// you are reading, which is the bug this ordering must not reintroduce
// (`workspace-row-move-on-click`, id 88).
export function sortWorkspacesByAttention(
  workspaces: Workspace[],
  tierOf: (workspace: Workspace) => WorkspaceAttentionTier
): Workspace[] {
  return [...workspaces].sort((a, b) => {
    const byTier = ATTENTION_TIER_RANK[tierOf(a)] - ATTENTION_TIER_RANK[tierOf(b)]
    if (byTier !== 0) return byTier
    return compareWorkspacesByUserMessage(a, b)
  })
}

// When main's record arrives (a snapshot, or a field patch another window
// sent from an older reading), the later copy of each activity clock is the
// truth — the same rule main's reducer applies (MONOTONIC_WORKSPACE_CLOCKS):
// an older stamp must not roll a row's clock back and let the rest sweep read
// a chat that was active yesterday as idle, or deal the list a different order
// than the one the person left.
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
