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
 * rather than by manual position. Every list of chats uses this and only this:
 * the sidebar's project groups, Starred band, flat stream and Settled shelves,
 * and — through `buildSidebarWorkspaceOrder` — the session-manager dropdown,
 * which reproduces the sidebar's order so the two surfaces never disagree
 * about where a chat sits.
 *
 * There used to be a banding step on top (`sortWorkspacesByAttention`: blocked
 * first, then finished-while-you-were-away, then running, then at rest), so an
 * agent finishing lifted its row above chats the person had spoken in more
 * recently. Owner ruling 2026-09-09, watching three projects: "they keep moving
 * up and down in my side panel... they should just stay put where they are
 * based on when I send them a message last". The tints stayed and the banding
 * went — a finishing or blocked agent recolours its row and never moves it,
 * which also retired the "held seat" that froze a selected row's band.
 */
export function sortWorkspacesByUserMessage(workspaces: Workspace[]): Workspace[] {
  // Array.prototype.sort is stable, so rows that tie keep their incoming
  // (stored) order.
  return [...workspaces].sort(compareWorkspacesByUserMessage)
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
